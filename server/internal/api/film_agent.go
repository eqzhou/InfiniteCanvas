package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	ProjectID         string                `json:"projectId"`
	Stage             string                `json:"stage"`
	Revision          int                   `json:"revision"`
	EpisodeID         string                `json:"episodeId,omitempty"`
	ScriptMode        string                `json:"scriptMode,omitempty"`
	ShotIDs           []string              `json:"shotIds,omitempty"`
	ProviderID        string                `json:"providerId,omitempty"`
	Model             string                `json:"model,omitempty"`
	Config            *filmGenerationConfig `json:"config,omitempty"`
	IdempotencyKey    string                `json:"idempotencyKey,omitempty"`
	ConfirmationToken string                `json:"confirmationToken"`
}

type filmAgentRepairArguments struct {
	ProjectID         string                `json:"projectId"`
	RepairID          string                `json:"repairId"`
	Revision          int                   `json:"revision"`
	Approved          bool                  `json:"approved"`
	ProviderID        string                `json:"providerId,omitempty"`
	Model             string                `json:"model,omitempty"`
	Config            *filmGenerationConfig `json:"config,omitempty"`
	IdempotencyKey    string                `json:"idempotencyKey,omitempty"`
	ExpectedCredits   *int                  `json:"expectedCredits,omitempty"`
	ConfirmationToken string                `json:"confirmationToken"`
}
type filmAgentExportArguments struct {
	ProjectID         string `json:"projectId"`
	Kind              string `json:"kind"`
	Revision          int    `json:"revision"`
	IdempotencyKey    string `json:"idempotencyKey"`
	ConfirmationToken string `json:"confirmationToken"`
}

func filmAgentRequestContext(ctx context.Context, tenantID, projectID, stage string) context.Context {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("projectId", projectID)
	if stage != "" {
		routeContext.URLParams.Add("stageId", stage)
	}
	requestContext := context.WithValue(ctx, chi.RouteCtxKey, routeContext)
	if user, ok := authUserFrom(requestContext); ok {
		user.TenantID = tenantID
		return context.WithValue(requestContext, authUserKey, user)
	}
	if tenantID != store.DefaultTenantID {
		return context.WithValue(requestContext, authUserKey, store.AuthUser{TenantID: tenantID})
	}
	return requestContext
}

func decodeFilmAgentResponse(recorder *httptest.ResponseRecorder, fallback string) (filmDocument, error) {
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
			message = fallback
		}
		return filmDocument{}, &toolError{status: response.StatusCode, message: message}
	}
	return payload.Data, nil
}

func (s *Server) runFilmTextStageForAgent(ctx context.Context, tenantID string, args filmAgentStageArguments) (filmDocument, error) {
	args.ProviderID = strings.TrimSpace(args.ProviderID)
	args.Model = strings.TrimSpace(args.Model)
	args.IdempotencyKey = strings.TrimSpace(args.IdempotencyKey)
	args.EpisodeID = strings.TrimSpace(args.EpisodeID)
	if args.ProviderID == "" {
		return filmDocument{}, badToolRequest("AI film text stages require providerId")
	}
	if args.Model == "" {
		return filmDocument{}, badToolRequest("AI film text stages require model")
	}
	if !validFilmIdempotencyKey(args.IdempotencyKey) {
		return filmDocument{}, badToolRequest("AI film text stages require a valid idempotencyKey")
	}
	if args.Stage == "script" && !validProjectID(args.EpisodeID) {
		return filmDocument{}, badToolRequest("AI film script stage requires episodeId")
	}
	input := filmTextRunRequest{
		Revision: args.Revision, Mode: "ai", ProviderID: args.ProviderID, Model: args.Model,
		IdempotencyKey: args.IdempotencyKey, EpisodeID: args.EpisodeID, ScriptMode: args.ScriptMode,
	}
	body, err := json.Marshal(input)
	if err != nil {
		return filmDocument{}, badToolRequest("AI film text stage parameters are invalid")
	}
	requestContext := filmAgentRequestContext(ctx, tenantID, args.ProjectID, args.Stage)
	request := httptest.NewRequest(http.MethodPost, "/api/film/projects/"+args.ProjectID+"/stages/"+args.Stage+"/run", bytes.NewReader(body)).WithContext(requestContext)
	recorder := httptest.NewRecorder()
	s.runFilmTextStage(recorder, request)
	return decodeFilmAgentResponse(recorder, "AI film text stage failed")
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
	requestContext := filmAgentRequestContext(ctx, tenantID, args.ProjectID, args.Stage)
	request := httptest.NewRequest(http.MethodPost, "/api/film/projects/"+args.ProjectID+"/stages/"+args.Stage+"/run", bytes.NewReader(body)).WithContext(requestContext)
	recorder := httptest.NewRecorder()
	s.runFilmGenerationStage(recorder, request)
	return decodeFilmAgentResponse(recorder, "film generation stage failed")
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
		if args.Stage == "decompose" || args.Stage == "script" {
			return s.runFilmTextStageForAgent(ctx, tenantID, args)
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
	if tool == "film.approve_stage" {
		var args filmAgentStageArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		backend, record, document, err := s.loadFilmForAgent(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		next, err := updateFilmStage(document, args.Stage, "approve", args.Revision, time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return nil, badToolRequest(err.Error())
		}
		return saveFilmForAgent(ctx, backend, tenantID, record, next)
	}
	if tool == "film.apply_repair" {
		var args filmAgentRepairArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if !args.Approved || args.Revision < 1 || !validProjectID(args.RepairID) {
			return nil, badToolRequest("repair requires explicit approval and exact revision")
		}
		backend, record, document, err := s.loadFilmForAgent(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		selectedRepair, found := findFilmRepairProposal(document, args.RepairID)
		if !found {
			return nil, badToolRequest("repair not found")
		}
		if selectedRepair.EstimatedGenerations > 0 {
			input := filmRepairApplyRequest{
				Revision: args.Revision, Approved: true, ProviderID: strings.TrimSpace(args.ProviderID), Model: strings.TrimSpace(args.Model),
				Config: args.Config, IdempotencyKey: strings.TrimSpace(args.IdempotencyKey), ExpectedCredits: args.ExpectedCredits,
			}
			body, marshalErr := json.Marshal(input)
			if marshalErr != nil {
				return nil, badToolRequest("generative repair parameters are invalid")
			}
			requestContext := filmAgentRequestContext(ctx, tenantID, args.ProjectID, "")
			routeContext := chi.RouteContext(requestContext)
			routeContext.URLParams.Add("repairId", args.RepairID)
			request := httptest.NewRequest(http.MethodPost, "/api/film/projects/"+args.ProjectID+"/repairs/"+args.RepairID+"/apply", bytes.NewReader(body)).WithContext(requestContext)
			recorder := httptest.NewRecorder()
			s.applyFilmRepairProposal(recorder, request)
			return decodeFilmAgentResponse(recorder, "film generative repair failed")
		}
		for reportIndex := range document.QualityReports {
			for repairIndex := range document.QualityReports[reportIndex].Repairs {
				repair := &document.QualityReports[reportIndex].Repairs[repairIndex]
				if repair.ID == args.RepairID {
					if repair.ExpectedRevision != args.Revision {
						return nil, badToolRequest("repair revision conflict")
					}
					repair.Approved = true
				}
			}
		}
		next, err := applyFilmRepair(document, args.RepairID)
		if err != nil {
			return nil, badToolRequest(err.Error())
		}
		return saveFilmForAgent(ctx, backend, tenantID, record, next)
	}
	if tool == "film.export" {
		var args filmAgentExportArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		body, _ := json.Marshal(filmExportRequest{Kind: args.Kind, Revision: args.Revision, IdempotencyKey: args.IdempotencyKey})
		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("projectId", args.ProjectID)
		requestContext := context.WithValue(ctx, chi.RouteCtxKey, routeContext)
		if user, ok := authUserFrom(requestContext); ok {
			user.TenantID = tenantID
			requestContext = context.WithValue(requestContext, authUserKey, user)
		} else if tenantID != store.DefaultTenantID {
			requestContext = context.WithValue(requestContext, authUserKey, store.AuthUser{TenantID: tenantID})
		}
		request := httptest.NewRequest(http.MethodPost, "/api/film/projects/"+args.ProjectID+"/exports", bytes.NewReader(body)).WithContext(requestContext)
		recorder := httptest.NewRecorder()
		s.createFilmExport(recorder, request)
		var payload struct {
			Data  filmDocument `json:"data"`
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(recorder.Body.Bytes(), &payload) != nil {
			return nil, errors.New("film export response is invalid")
		}
		if recorder.Code >= 400 {
			return nil, &toolError{status: recorder.Code, message: payload.Error.Message}
		}
		return payload.Data, nil
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
	if tool == "film.next_steps" {
		_, _, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		steps := []string{}
		for _, stage := range document.Stages {
			if stage.Status != filmStatusApproved {
				steps = append(steps, "Complete and approve stage "+stage.ID)
				break
			}
		}
		report, _ := s.validateFilmDocumentWithMedia(ctx, tenantID, cloneFilmDocument(document))
		if len(report.Issues) > 0 {
			steps = append(steps, "Review "+fmt.Sprint(len(report.Issues))+" quality issues before delivery")
		}
		if len(document.Deliverables) == 0 {
			steps = append(steps, "Create versioned deliverables after compose approval")
		}
		return map[string]any{"steps": steps, "qualityIssueCount": len(report.Issues)}, nil
	}
	if tool == "film.check" {
		_, record, document, err := s.loadFilmForAgent(ctx, tenantID, project.ProjectID)
		if err != nil {
			return nil, err
		}
		report, err := s.validateFilmDocumentWithMedia(ctx, tenantID, cloneFilmDocument(document))
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
		report, err := s.validateFilmDocumentWithMedia(ctx, tenantID, document)
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
