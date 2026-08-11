package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const filmRestoreTokenTTL = time.Hour

type filmRestoreRollbackRequest struct {
	Revision     int    `json:"revision"`
	RestoreToken string `json:"restoreToken"`
}

func newFilmRestoreToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := hex.EncodeToString(raw)
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:]), nil
}

func filmRestoreTokenDigest(token string) (string, error) {
	if len(token) != 64 {
		return "", errors.New("restore token is invalid")
	}
	if _, err := hex.DecodeString(token); err != nil {
		return "", errors.New("restore token is invalid")
	}
	digest := sha256.Sum256([]byte(strings.ToLower(token)))
	return hex.EncodeToString(digest[:]), nil
}

func validateFilmRestoreDocument(document filmDocument, projectID string) error {
	validation := cloneFilmDocument(document)
	normalizeSource := func(source *filmDirectorSource, target *string) {
		if source == nil || strings.HasPrefix(source.StorageKey, "film:media:") {
			return
		}
		key := "film:media:" + projectID + ":restore-validation:" + stableFilmID("director", source.StorageKey, source.SHA256)
		source.StorageKey = key
		if target != nil {
			*target = key
		}
	}
	for index := range validation.Scenes {
		normalizeSource(validation.Scenes[index].DirectorSource, nil)
	}
	for index := range validation.Shots {
		shot := &validation.Shots[index]
		normalizeSource(shot.StoryboardDirectorSource, &shot.ImageStorageKey)
		normalizeSource(shot.FirstFrameDirectorSource, &shot.FirstFrameStorageKey)
		normalizeSource(shot.LastFrameDirectorSource, &shot.LastFrameStorageKey)
	}
	for index := range validation.Tasks {
		if snapshot := validation.Tasks[index].Snapshot; snapshot != nil {
			normalizeSource(snapshot.StoryboardDirectorSource, nil)
			normalizeSource(snapshot.FirstFrameDirectorSource, nil)
			normalizeSource(snapshot.LastFrameDirectorSource, nil)
		}
	}
	for index := range validation.Versions {
		version := &validation.Versions[index]
		switch version.EntityType {
		case "scene":
			var scene filmScene
			if json.Unmarshal(version.Snapshot, &scene) == nil {
				normalizeSource(scene.DirectorSource, nil)
				version.Snapshot, _ = json.Marshal(scene)
			}
		case "shot":
			var shot filmShot
			if json.Unmarshal(version.Snapshot, &shot) == nil {
				normalizeSource(shot.StoryboardDirectorSource, &shot.ImageStorageKey)
				normalizeSource(shot.FirstFrameDirectorSource, &shot.FirstFrameStorageKey)
				normalizeSource(shot.LastFrameDirectorSource, &shot.LastFrameStorageKey)
				version.Snapshot, _ = json.Marshal(shot)
			}
		}
	}
	return validateFilmAggregate(validation, projectID)
}

func (s *Server) restoreFilmProduction(w http.ResponseWriter, r *http.Request) {
	var input filmRestoreRequest
	if err := decodeFilmRequest(w, r, maxProjectBytes+4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Revision < 0 {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_validation_error", "Film restore revision is invalid")
		return
	}
	backend, ok := s.filmStore(w)
	if !ok {
		return
	}
	restoreBackend, ok := backend.(store.FilmRestoreStore)
	if !ok {
		writeFilmError(w, http.StatusServiceUnavailable, "film_restore_unavailable", "Durable film restore rollback is unavailable")
		return
	}
	if err := s.requireFilmBoardProject(r); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	projectID := chi.URLParam(r, "projectId")
	input.Document = migrateFilmDocumentTopology(input.Document)
	if err := validateFilmRestoreDocument(input.Document, projectID); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	if err := validateFilmRestoreMediaMetadata(input.Document, input.Media); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	allowedProtected := map[string]struct{}{}
	if input.Revision > 0 {
		current, currentErr := s.latestFilmDocument(r.Context(), tenantIDFrom(r), projectID)
		if currentErr != nil {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Current film media references could not be verified")
			return
		}
		allowedProtected = protectedFilmDocumentKeys(current)
	}
	next, createdKeys, migratedStorageKeys, err := s.rehydrateRestoredFilmMedia(r.Context(), tenantIDFrom(r), userIDFrom(r), input.Document, input.Media, allowedProtected)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	cleanup := func() {
		s.cleanupRestoredFilmBlobs(r.Context(), tenantIDFrom(r), userIDFrom(r), projectID, createdKeys)
	}
	if err := validateFilmAggregate(next, projectID); err != nil {
		cleanup()
		writeFilmOperationError(w, err)
		return
	}
	raw, err := json.Marshal(next)
	if err != nil || len(raw) > maxProjectBytes {
		cleanup()
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	restoreToken, tokenDigest, tokenErr := newFilmRestoreToken()
	if tokenErr != nil {
		cleanup()
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film restore rollback token could not be created")
		return
	}
	createdMedia := make([]store.WorkspaceMedia, 0, len(createdKeys))
	for _, key := range createdKeys {
		createdMedia = append(createdMedia, store.WorkspaceMedia{ProjectID: projectID, StorageKey: key})
	}
	record, err := restoreBackend.RestoreFilmProject(r.Context(), tenantIDFrom(r), projectID, input.Revision, raw, tokenDigest, time.Now().Add(filmRestoreTokenTTL), createdMedia)
	if errors.Is(err, store.ErrConflict) {
		cleanup()
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		cleanup()
		writeFilmError(w, http.StatusNotFound, "film_not_found", "Film production has not been created")
		return
	}
	if err != nil {
		cleanup()
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be restored")
		return
	}
	s.writeFilmDocumentWithRestoreMetadata(w, r, http.StatusOK, record, next, migratedStorageKeys, restoreToken)
}

func (s *Server) rollbackFilmProductionRestore(w http.ResponseWriter, r *http.Request) {
	var input filmRestoreRollbackRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil || input.Revision < 1 {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "Film restore rollback request is invalid")
		return
	}
	digest, err := filmRestoreTokenDigest(input.RestoreToken)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	backend, ok := s.filmStore(w)
	if !ok {
		return
	}
	restoreBackend, ok := backend.(store.FilmRestoreStore)
	if !ok {
		writeFilmError(w, http.StatusServiceUnavailable, "film_restore_unavailable", "Durable film restore rollback is unavailable")
		return
	}
	if err := s.requireFilmBoardProject(r); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	record, restored, err := restoreBackend.RollbackFilmProject(r.Context(), tenantIDFrom(r), chi.URLParam(r, "projectId"), input.Revision, digest, time.Now())
	if errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "restore_token_not_found", "Film restore rollback token was not found")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; rollback was not applied")
		return
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film restore rollback could not be applied")
		return
	}
	if !restored {
		_, _ = s.processFilmCleanupGenerations(r.Context(), tenantIDFrom(r), userIDFrom(r), chi.URLParam(r, "projectId"))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var document filmDocument
	if json.Unmarshal(record.Document, &document) != nil || validateFilmAggregate(document, record.ProjectID) != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Restored film production is invalid")
		return
	}
	if pending, cleanupErr := s.processFilmCleanupGenerations(r.Context(), tenantIDFrom(r), userIDFrom(r), record.ProjectID); cleanupErr != nil || pending {
		w.Header().Set("X-OpenBoard-Cleanup-Pending", "true")
	}
	s.writeFilmDocument(w, r, http.StatusOK, record, document)
}

func (s *Server) retryFilmMediaCleanup(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")
	if !validProjectID(projectID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "Film project id is invalid")
		return
	}
	pending, err := s.processFilmCleanupGenerations(r.Context(), tenantIDFrom(r), userIDFrom(r), projectID)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_cleanup_error", "Film media cleanup could not be completed")
		return
	}
	writeJSON(w, map[string]any{"data": map[string]any{"pending": pending}})
}
