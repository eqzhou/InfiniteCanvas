package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

type filmCleanupItem struct {
	StorageKey    string `json:"storageKey"`
	Kind          string `json:"kind"`
	MIMEType      string `json:"mimeType,omitempty"`
	Bytes         int64  `json:"bytes,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
	ObjectVersion string `json:"objectVersion,omitempty"`
	Deleted       bool   `json:"deleted,omitempty"`
	Referenced    bool   `json:"referenced,omitempty"`
}

type filmCleanupManifest struct {
	ProjectID string            `json:"projectId"`
	Items     []filmCleanupItem `json:"items"`
}

func filmCleanupStateKey(projectID string) string {
	return "filmCleanup:" + projectID
}

func filmCleanupInventory(document filmDocument, projectID string) filmCleanupManifest {
	items := map[string]filmCleanupItem{}
	add := func(item filmCleanupItem) {
		if !strings.HasPrefix(item.StorageKey, "film:media:"+projectID+":") && !strings.HasPrefix(item.StorageKey, "film:deliverable:"+projectID+":") {
			return
		}
		items[item.StorageKey] = item
	}
	for _, shot := range document.Shots {
		for _, stage := range []string{"storyboard", "audio", "video"} {
			key, digest, version, mimeType, _ := filmShotMediaIdentity(shot, stage)
			add(filmCleanupItem{StorageKey: key, Kind: "shot-" + stage, MIMEType: mimeType, SHA256: digest, ObjectVersion: version})
		}
	}
	for _, asset := range document.Assets {
		add(filmCleanupItem{StorageKey: asset.MediaStorageKey, Kind: "asset", MIMEType: asset.MediaMIMEType, SHA256: asset.MediaSHA256, ObjectVersion: asset.MediaObjectVersion})
	}
	for _, deliverable := range document.Deliverables {
		add(filmCleanupItem{StorageKey: deliverable.StorageKey, Kind: "deliverable", MIMEType: deliverable.MIMEType, Bytes: deliverable.Bytes, SHA256: deliverable.SHA256, ObjectVersion: deliverable.ObjectVersion})
	}
	for _, track := range document.Timeline.Tracks {
		for _, clip := range track.Clips {
			add(filmCleanupItem{StorageKey: clip.Source, Kind: "timeline-" + track.Kind})
		}
	}
	manifest := filmCleanupManifest{ProjectID: projectID, Items: make([]filmCleanupItem, 0, len(items))}
	for _, item := range items {
		manifest.Items = append(manifest.Items, item)
	}
	return manifest
}

func jsonReferencesStorageKey(raw []byte, storageKey string) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true // malformed stored data must fail closed
	}
	var contains func(any) bool
	contains = func(current any) bool {
		switch typed := current.(type) {
		case string:
			return typed == storageKey
		case []any:
			for _, item := range typed {
				if contains(item) {
					return true
				}
			}
		case map[string]any:
			for _, item := range typed {
				if contains(item) {
					return true
				}
			}
		}
		return false
	}
	return contains(value)
}

func (s *Server) filmStorageKeyReferenced(ctx context.Context, tenantID, _ string, storageKey string) (bool, error) {
	projects, err := s.store.ListProjects(ctx, tenantID)
	if err != nil {
		return false, err
	}
	filmBackend, _ := s.store.(store.FilmStore)
	for _, project := range projects {
		document, err := s.store.GetProject(ctx, tenantID, project.ID)
		if err != nil {
			return false, err
		}
		if jsonReferencesStorageKey(document, storageKey) {
			return true, nil
		}
		if filmBackend != nil {
			record, err := filmBackend.GetFilmProject(ctx, tenantID, project.ID)
			if err == nil && jsonReferencesStorageKey(record.Document, storageKey) {
				return true, nil
			}
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				return false, err
			}
		}
	}
	states, err := s.store.GetStates(ctx, tenantID, workspaceTransactionStateKeys)
	if err != nil {
		return false, err
	}
	for _, value := range states {
		if jsonReferencesStorageKey(value, storageKey) {
			return true, nil
		}
	}
	for page := 1; ; page++ {
		jobs, err := s.store.ListGenerationJobs(ctx, tenantID, store.GenerationJobQuery{Page: page, PageSize: 100, IncludeDeleted: true})
		if err != nil {
			return false, err
		}
		for _, job := range jobs.Items {
			raw, _ := json.Marshal(job)
			if jsonReferencesStorageKey(raw, storageKey) {
				return true, nil
			}
		}
		if page*jobs.PageSize >= jobs.Total || len(jobs.Items) == 0 {
			break
		}
	}
	return false, nil
}

func cleanupManifestFromGeneration(generation store.FilmCleanupGeneration) (filmCleanupManifest, error) {
	items := map[string]filmCleanupItem{}
	for _, raw := range generation.Documents {
		var document filmDocument
		if json.Unmarshal(raw, &document) != nil || document.ProjectID != generation.ProjectID {
			return filmCleanupManifest{}, errors.New("invalid cleanup generation Film document")
		}
		for _, item := range filmCleanupInventory(document, generation.ProjectID).Items {
			items[item.StorageKey] = item
		}
	}
	for _, media := range generation.Media {
		if media.ProjectID != generation.ProjectID ||
			(!strings.HasPrefix(media.StorageKey, "film:media:"+generation.ProjectID+":") && !strings.HasPrefix(media.StorageKey, "film:deliverable:"+generation.ProjectID+":")) {
			return filmCleanupManifest{}, errors.New("invalid cleanup generation media")
		}
		if _, exists := items[media.StorageKey]; !exists {
			items[media.StorageKey] = filmCleanupItem{StorageKey: media.StorageKey, Kind: "rollback-created"}
		}
	}
	manifest := filmCleanupManifest{ProjectID: generation.ProjectID, Items: make([]filmCleanupItem, 0, len(items))}
	for _, item := range items {
		manifest.Items = append(manifest.Items, item)
	}
	return manifest, nil
}

func (s *Server) processFilmCleanupGenerations(ctx context.Context, tenantID, userID, projectID string) (bool, error) {
	backend, ok := s.store.(store.FilmCleanupStore)
	if !ok {
		return false, errors.New("durable Film cleanup is unavailable")
	}
	generations, err := backend.ListFilmCleanupGenerations(ctx, tenantID, projectID)
	if err != nil {
		return false, err
	}
	pending := false
	for _, generation := range generations {
		manifest, err := cleanupManifestFromGeneration(generation)
		if err != nil {
			return false, err
		}
		generationPending := false
		for _, item := range manifest.Items {
			referenced, err := s.filmStorageKeyReferenced(ctx, tenantID, projectID, item.StorageKey)
			if err != nil {
				return false, err
			}
			if referenced {
				generationPending = true
				continue
			}
			if err := s.deleteTenantBlob(ctx, tenantID, userID, item.StorageKey); err != nil && !errors.Is(err, store.ErrNotFound) {
				return false, err
			}
		}
		if generationPending {
			pending = true
			continue
		}
		if err := backend.CompleteFilmCleanupGeneration(ctx, tenantID, projectID, generation.GenerationID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return false, err
		}
	}
	return pending, nil
}

func (s *Server) loadFilmCleanupManifest(ctx context.Context, tenantID, projectID string) (filmCleanupManifest, bool, error) {
	raw, err := s.store.GetState(ctx, tenantID, filmCleanupStateKey(projectID))
	if errors.Is(err, store.ErrNotFound) {
		return filmCleanupManifest{}, false, nil
	}
	var manifest filmCleanupManifest
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.ProjectID != projectID {
		return filmCleanupManifest{}, false, errors.New("invalid Film cleanup manifest")
	}
	return manifest, true, nil
}

func (s *Server) recordFilmCleanupManifest(ctx context.Context, tenantID, projectID string) (filmCleanupManifest, error) {
	if manifest, exists, err := s.loadFilmCleanupManifest(ctx, tenantID, projectID); err != nil || exists {
		return manifest, err
	}
	filmBackend, ok := s.store.(store.FilmStore)
	if !ok {
		return filmCleanupManifest{ProjectID: projectID, Items: []filmCleanupItem{}}, nil
	}
	record, err := filmBackend.GetFilmProject(ctx, tenantID, projectID)
	if errors.Is(err, store.ErrNotFound) {
		return filmCleanupManifest{ProjectID: projectID, Items: []filmCleanupItem{}}, nil
	}
	if err != nil {
		return filmCleanupManifest{}, err
	}
	var document filmDocument
	if json.Unmarshal(record.Document, &document) != nil || document.ProjectID != projectID {
		return filmCleanupManifest{}, errors.New("invalid Film aggregate")
	}
	manifest := filmCleanupInventory(document, projectID)
	raw, _ := json.Marshal(manifest)
	if err := s.store.PutState(ctx, tenantID, filmCleanupStateKey(projectID), raw); err != nil {
		return filmCleanupManifest{}, err
	}
	return manifest, nil
}

func (s *Server) processFilmCleanupManifest(ctx context.Context, tenantID, userID string, manifest filmCleanupManifest) error {
	for index := range manifest.Items {
		item := &manifest.Items[index]
		if item.Deleted {
			continue
		}
		referenced, err := s.filmStorageKeyReferenced(ctx, tenantID, manifest.ProjectID, item.StorageKey)
		if err != nil {
			return err
		}
		item.Referenced = referenced
		if referenced {
			continue
		}
		if err := s.deleteTenantBlob(ctx, tenantID, userID, item.StorageKey); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		item.Deleted = true
	}
	raw, _ := json.Marshal(manifest)
	return s.store.PutState(ctx, tenantID, filmCleanupStateKey(manifest.ProjectID), raw)
}
