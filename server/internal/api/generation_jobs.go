package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const maxGenerationJobBytes = 1 << 20

var generationKinds = map[string]bool{"image": true, "video": true}
var generationStatuses = map[string]bool{
	"queued": true, "running": true, "succeeded": true, "failed": true, "cancelled": true,
}

func (s *Server) listGenerationJobs(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	page, err := positiveQueryInt(r, "page", 1, 1, 1_000_000)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	pageSize, err := positiveQueryInt(r, "pageSize", 20, 1, 100)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	projectID := r.URL.Query().Get("projectId")
	if projectID != "" && !validProjectID(projectID) {
		http.Error(w, "invalid projectId", http.StatusBadRequest)
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "" && !generationKinds[kind] {
		http.Error(w, "invalid generation kind", http.StatusBadRequest)
		return
	}
	result, err := s.store.ListGenerationJobs(r.Context(), store.GenerationJobQuery{
		ProjectID: projectID, Kind: kind, Page: page, PageSize: pageSize,
	})
	if err != nil {
		http.Error(w, "failed to list generation jobs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

func (s *Server) createGenerationJob(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	job, err := decodeGenerationJob(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.store.GetGenerationJob(r.Context(), job.ID); err == nil {
		http.Error(w, "generation job already exists", http.StatusConflict)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		http.Error(w, "failed to inspect generation job", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job.CreatedAt, job.UpdatedAt = now, now
	if err := s.store.PutGenerationJob(r.Context(), job); err != nil {
		http.Error(w, "failed to store generation job", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, job)
}

func (s *Server) getGenerationJob(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid generation job id", http.StatusBadRequest)
		return
	}
	job, err := s.store.GetGenerationJob(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read generation job", http.StatusInternalServerError)
		return
	}
	writeJSON(w, job)
}

func (s *Server) updateGenerationJob(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	job, err := decodeGenerationJob(w, r)
	if err != nil || job.ID != id {
		http.Error(w, "invalid generation job", http.StatusBadRequest)
		return
	}
	current, err := s.store.GetGenerationJob(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read generation job", http.StatusInternalServerError)
		return
	}
	job.CreatedAt = current.CreatedAt
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.store.PutGenerationJob(r.Context(), job); err != nil {
		http.Error(w, "failed to update generation job", http.StatusInternalServerError)
		return
	}
	writeJSON(w, job)
}

func (s *Server) deleteGenerationJob(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid generation job id", http.StatusBadRequest)
		return
	}
	if err := s.store.DeleteGenerationJob(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "failed to delete generation job", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeGenerationJob(w http.ResponseWriter, r *http.Request) (store.GenerationJob, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationJobBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return store.GenerationJob{}, errors.New("invalid or oversized generation job")
	}
	var job store.GenerationJob
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&job); err != nil {
		return store.GenerationJob{}, errors.New("invalid generation job json")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return store.GenerationJob{}, errors.New("invalid generation job json")
	}
	if !validProjectID(job.ID) || (job.ProjectID != "" && !validProjectID(job.ProjectID)) ||
		!generationKinds[job.Kind] || !generationStatuses[job.Status] ||
		len(job.Prompt) > 100_000 || len(job.ProviderID) > 500 || len(job.Model) > 500 || len(job.Error) > 10_000 ||
		!jsonObject(job.Parameters) || !jsonObject(job.Result) {
		return store.GenerationJob{}, errors.New("invalid generation job fields")
	}
	return job, nil
}

func jsonObject(value json.RawMessage) bool {
	if len(value) == 0 {
		return false
	}
	var object map[string]any
	return json.Unmarshal(value, &object) == nil && object != nil
}

func positiveQueryInt(r *http.Request, key string, fallback, min, max int) (int, error) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < min || value > max {
		return 0, errors.New("invalid " + key)
	}
	return value, nil
}
