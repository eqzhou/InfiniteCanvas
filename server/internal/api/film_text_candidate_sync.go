package api

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func (s *Server) syncFilmTextJobCandidate(ctx context.Context, tenantID string, job store.GenerationJob) error {
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return errors.New("film storage is unavailable")
	}
	var parameters persistedTextJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Film == nil {
		// Generic durable text jobs do not have Film side effects.
		return nil
	}
	for range 5 {
		record, err := backend.GetFilmProject(ctx, tenantID, parameters.Film.ProjectID)
		if err != nil {
			return err
		}
		document, err := decodeFilmDocument(record.Document)
		if err != nil {
			return err
		}
		alreadyStored := false
		if parameters.Operation == "film_style_extraction" {
			for _, candidate := range document.StyleCandidates {
				alreadyStored = alreadyStored || candidate.GenerationJobID == job.ID
			}
		} else {
			for _, candidate := range document.AICandidates {
				alreadyStored = alreadyStored || candidate.GenerationJobID == job.ID
			}
		}
		if alreadyStored {
			return nil
		}
		var next filmDocument
		if parameters.Operation == "film_style_extraction" {
			next, err = integrateFilmStyleExtractionResult(document, job, parameters, time.Now().UTC().Format(time.RFC3339Nano))
		} else {
			next, err = integrateFilmTextJobResult(document, job, time.Now().UTC().Format(time.RFC3339Nano))
		}
		if err != nil {
			return err
		}
		if err := validateFilmAggregate(next, next.ProjectID); err != nil {
			return err
		}
		raw, err := json.Marshal(next)
		if err != nil || len(raw) > maxProjectBytes {
			return errors.New("film AI candidate exceeds the project storage limit")
		}
		if _, err := backend.CompareAndSwapFilmProject(ctx, tenantID, record.ProjectID, record.Revision, raw); err == nil {
			return nil
		} else if !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return store.ErrConflict
}

func (s *Server) reconcileFilmTextCandidates(ctx context.Context, tenantID string, document filmDocument) (bool, error) {
	changed := false
	for _, task := range document.Tasks {
		if task.GenerationJobID == "" {
			continue
		}
		job, err := s.store.GetGenerationJob(ctx, tenantID, task.GenerationJobID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return changed, err
		}
		if job.Kind != "text" || job.Status != "succeeded" {
			continue
		}
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Film == nil || parameters.Film.ProjectID != document.ProjectID {
			continue
		}
		if filmTextCandidateStored(document, job.ID, parameters.Operation) {
			continue
		}
		if err := s.syncFilmTextJobCandidate(ctx, tenantID, job); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}

func filmTextCandidateStored(document filmDocument, jobID, operation string) bool {
	if operation == "film_style_extraction" {
		for _, candidate := range document.StyleCandidates {
			if candidate.GenerationJobID == jobID {
				return true
			}
		}
		return false
	}
	for _, candidate := range document.AICandidates {
		if candidate.GenerationJobID == jobID {
			return true
		}
	}
	return false
}
