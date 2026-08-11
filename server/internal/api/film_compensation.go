package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const filmCompensationTimeout = 5 * time.Second

func detachedFilmContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), filmCompensationTimeout)
}

func filmDocumentReferencesJob(document filmDocument, jobID string) bool {
	for _, task := range document.Tasks {
		if task.GenerationJobID == jobID {
			return true
		}
	}
	return false
}

func (s *Server) latestFilmDocument(ctx context.Context, tenantID, projectID string) (filmDocument, error) {
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return filmDocument{}, errors.New("durable film storage is unavailable")
	}
	record, err := backend.GetFilmProject(ctx, tenantID, projectID)
	if err != nil {
		return filmDocument{}, err
	}
	var document filmDocument
	if json.Unmarshal(record.Document, &document) != nil {
		return filmDocument{}, errors.New("stored film production is invalid")
	}
	return document, nil
}

func (s *Server) compensateUnreferencedFilmJobs(parent context.Context, tenantID, projectID string, jobIDs []string) {
	if len(jobIDs) == 0 {
		return
	}
	ctx, cancel := detachedFilmContext(parent)
	defer cancel()
	document, err := s.latestFilmDocument(ctx, tenantID, projectID)
	if err != nil {
		log.Printf("film generation compensation could not verify current document: %v", err)
		return
	}
	for _, jobID := range jobIDs {
		if filmDocumentReferencesJob(document, jobID) {
			continue
		}
		if _, err := s.store.CancelServerGenerationJob(ctx, tenantID, jobID, time.Now().UTC()); err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Printf("film generation compensation cancellation failed: %v", err)
		}
	}
}

func (s *Server) cancelPostCASFilmTasks(parent context.Context, tenantID, projectID string, previous, next []filmTask) {
	wanted := make(map[string]struct{})
	previousByID := make(map[string]filmTask, len(previous))
	for _, task := range previous {
		previousByID[task.ID] = task
	}
	for _, task := range next {
		before, exists := previousByID[task.ID]
		if exists && task.Status == filmStatusCanceled && before.Status != filmStatusCanceled && task.GenerationJobID != "" {
			wanted[task.GenerationJobID] = struct{}{}
		}
	}
	if len(wanted) == 0 {
		return
	}
	ctx, cancel := detachedFilmContext(parent)
	defer cancel()
	document, err := s.latestFilmDocument(ctx, tenantID, projectID)
	if err != nil {
		log.Printf("film post-CAS cancellation could not verify current document: %v", err)
		return
	}
	for _, task := range document.Tasks {
		if _, ok := wanted[task.GenerationJobID]; !ok || task.Status != filmStatusCanceled {
			continue
		}
		if _, err := s.store.CancelServerGenerationJob(ctx, tenantID, task.GenerationJobID, time.Now().UTC()); err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Printf("film post-CAS cancellation failed: %v", err)
		}
	}
}

func (s *Server) cleanupUnreferencedFilmBlob(parent context.Context, tenantID, userID, projectID, storageKey string) {
	ctx, cancel := detachedFilmContext(parent)
	defer cancel()
	document, err := s.latestFilmDocument(ctx, tenantID, projectID)
	if err != nil {
		log.Printf("film export compensation could not verify current document: %v", err)
		return
	}
	for _, shot := range document.Shots {
		if shot.ImageStorageKey == storageKey || shot.FirstFrameStorageKey == storageKey || shot.LastFrameStorageKey == storageKey || shot.VideoStorageKey == storageKey || shot.AudioStorageKey == storageKey {
			return
		}
	}
	for _, scene := range document.Scenes {
		if scene.DirectorSource != nil && scene.DirectorSource.StorageKey == storageKey {
			return
		}
	}
	for _, asset := range document.Assets {
		if asset.MediaStorageKey == storageKey {
			return
		}
	}
	for _, dialogue := range document.Dialogues {
		if dialogue.AudioStorageKey == storageKey {
			return
		}
	}
	for _, deliverable := range document.Deliverables {
		if deliverable.StorageKey == storageKey {
			return
		}
	}
	for _, track := range document.Timeline.Tracks {
		for _, clip := range track.Clips {
			if clip.Source == storageKey {
				return
			}
		}
	}
	if err := s.deleteTenantBlob(ctx, tenantID, userID, storageKey); err != nil && !errors.Is(err, store.ErrNotFound) {
		log.Printf("film export compensation cleanup failed: %v", err)
	}
}
