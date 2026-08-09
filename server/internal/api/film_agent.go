package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmAgentResourceArguments struct {
	ProjectID string `json:"projectId"`
	Resource  string `json:"resource"`
}

type filmAgentStageArguments struct {
	ProjectID      string                `json:"projectId"`
	Stage          string                `json:"stage"`
	Revision       int                   `json:"revision"`
	ShotIDs        []string              `json:"shotIds,omitempty"`
	ProviderID     string                `json:"providerId,omitempty"`
	Model          string                `json:"model,omitempty"`
	Config         *filmGenerationConfig `json:"config,omitempty"`
	IdempotencyKey string                `json:"idempotencyKey,omitempty"`
}

func (s *Server) runFilmGenerationStageForAgent(ctx context.Context, tenantID string, args filmAgentStageArguments) (filmDocument, error) {
	if strings.TrimSpace(args.ProviderID) == "" || strings.TrimSpace(args.Model) == "" || args.Config == nil || !validFilmIdempotencyKey(args.IdempotencyKey) {
		return filmDocument{}, badToolRequest("generation stages require providerId, model, config, and a valid idempotencyKey")
	}
	input := filmGenerationRunRequest{
		Revision: args.Revision, ShotIDs: append([]string(nil), args.ShotIDs...), ProviderID: args.ProviderID,
		Model: args.Model, Config: *args.Config, IdempotencyKey: args.IdempotencyKey,
	}
	body, err := json.Marshal(input)
	if err != nil {
		return filmDocument{}, badToolRequest("generation stage parameters are invalid")
	}
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("projectId", args.ProjectID)
	routeContext.URLParams.Add("stageId", args.Stage)
	requestContext := context.WithValue(ctx, chi.RouteCtxKey, routeContext)
	if user, ok := authUserFrom(requestContext); ok {
		user.TenantID = tenantID
		requestContext = context.WithValue(requestContext, authUserKey, user)
	} else if tenantID != store.DefaultTenantID {
		requestContext = context.WithValue(requestContext, authUserKey, store.AuthUser{TenantID: tenantID})
	}
	request := httptest.NewRequest(http.MethodPost, "/api/film/projects/"+args.ProjectID+"/stages/"+args.Stage+"/run", bytes.NewReader(body)).WithContext(requestContext)
	recorder := httptest.NewRecorder()
	s.runFilmGenerationStage(recorder, request)
	response := recorder.Result()
	defer response.Body.Close()
	var payload struct {
		Data  filmDocument `json:"data"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return filmDocument{}, errors.New("film generation response is invalid")
	}
	if response.StatusCode >= http.StatusBadRequest {
		message := payload.Error.Message
		if message == "" {
			message = "film generation stage failed"
		}
		return filmDocument{}, &toolError{status: response.StatusCode, message: message}
	}
	return payload.Data, nil
}

func (s *Server) loadFilmForAgent(ctx context.Context, tenantID, projectID string) (store.FilmStore, store.FilmRecord, filmDocument, error) {
	if !filmModeEnabled() {
		return nil, store.FilmRecord{}, filmDocument{}, &toolError{status: http.StatusServiceUnavailable, message: "Film Production Mode is disabled"}
	}
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return nil, store.FilmRecord{}, filmDocument{}, &toolError{status: http.StatusServiceUnavailable, message: "durable film storage is unavailable"}
	}
	project, err := s.loadProjectDocument(ctx, tenantID, projectID)
	if err != nil {
		return nil, store.FilmRecord{}, filmDocument{}, err
	}
	if project["projectKind"] != "film" {
		return nil, store.FilmRecord{}, filmDocument{}, &toolError{status: http.StatusConflict, message: "project is not a film project"}
	}
	record, err := backend.GetFilmProject(ctx, tenantID, projectID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, store.FilmRecord{}, filmDocument{}, &toolError{status: http.StatusNotFound, message: "film production has not been created"}
	}
	if err != nil {
		return nil, store.FilmRecord{}, filmDocument{}, err
	}
	document, err := decodeFilmDocument(record.Document)
	if err != nil {
		return nil, store.FilmRecord{}, filmDocument{}, errors.New("stored film production is invalid")
	}
	return backend, record, document, nil
}

func saveFilmForAgent(ctx context.Context, backend store.FilmStore, tenantID string, record store.FilmRecord, document filmDocument) (filmDocument, error) {
	document.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := validateFilmAggregateLimits(document); err != nil {
		return filmDocument{}, err
	}
	raw, err := json.Marshal(document)
	if err != nil || len(raw) > maxProjectBytes {
		if err == nil {
			return filmDocument{}, errors.New("film production exceeds its storage limit")
		}
		return filmDocument{}, err
	}
	_, err = backend.CompareAndSwapFilmProject(ctx, tenantID, record.ProjectID, record.Revision, raw)
	if errors.Is(err, store.ErrConflict) {
		return filmDocument{}, &toolError{status: http.StatusConflict, message: "film production changed; reload before retrying"}
	}
	return document, err
}

func (s *Server) runFilmAgentTool(ctx context.Context, tenantID, tool string, raw json.RawMessage) (any, error) {
	if tool == "film.list" {
		var args filmAgentResourceArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		_, _, document, err := s.loadFilmForAgent(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		switch args.Resource {
		case "episodes":
			return document.Episodes, nil
		case "scenes":
			return document.Scenes, nil
		case "shots":
			return document.Shots, nil
		case "assets":
			return document.Assets, nil
		case "stages":
			return document.Stages, nil
		case "tasks":
			return document.Tasks, nil
		case "deliverables":
			return document.Deliverables, nil
		default:
			return nil, badToolRequest("film resource is unsupported")
		}
	}
	if tool == "film.run_stage" {
		var args filmAgentStageArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if filmStageGenerationKind(args.Stage) != "" {
			return s.runFilmGenerationStageForAgent(ctx, tenantID, args)
		}
		backend, record, document, err := s.loadFilmForAgent(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		next, err := updateFilmStage(document, args.Stage, "run", args.Revision, time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return nil, badToolRequest(err.Error())
		}
		return saveFilmForAgent(ctx, backend, tenantID, record, next)
	}
	var project projectArguments
	if err := decodeToolArguments(raw, &project); err != nil {
		return nil, err
	}
	if tool == "film.status" {
		_, record, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		_, renderAvailable, renderDiagnostic := s.filmFFmpegCapability(ctx)
		return map[string]any{
			"document":       document,
			"recordRevision": record.Revision,
			"mp4Export":      renderAvailable,
			"mp4Diagnostic":  renderDiagnostic,
		}, nil
	}
	if tool == "film.check" {
		_, record, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		report, err := checkFilmDocument(document)
		if err != nil {
			return nil, &toolError{status: http.StatusUnprocessableEntity, message: err.Error()}
		}
		return map[string]any{"report": report, "recordRevision": record.Revision}, nil
	}
	if tool == "film.proposals" {
		_, record, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"reports": document.QualityReports, "recordRevision": record.Revision}, nil
	}
	if tool == "film.validate" {
		backend, record, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		report, err := validateFilmDocument(document)
		if err != nil {
			return nil, &toolError{status: http.StatusUnprocessableEntity, message: err.Error()}
		}
		document.QualityReports = append(document.QualityReports, report)
		if len(document.QualityReports) > 20 {
			document.QualityReports = document.QualityReports[len(document.QualityReports)-20:]
		}
		document.Revision++
		return saveFilmForAgent(ctx, backend, tenantID, record, document)
	}
	return nil, badToolRequest("unknown film tool")
}
