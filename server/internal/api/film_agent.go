package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type filmAgentResourceArguments struct {
	ProjectID string `json:"projectId"`
	Resource  string `json:"resource"`
}

type filmAgentStageArguments struct {
	ProjectID string `json:"projectId"`
	Stage     string `json:"stage"`
	Revision  int    `json:"revision"`
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
		return map[string]any{"document": document, "recordRevision": record.Revision, "mp4Export": false}, nil
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
