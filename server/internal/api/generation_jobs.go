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
const maxGenerationRestoreBytes = 32 << 20
const maxGenerationRestoreItems = 10_000

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
	result, err := s.store.ListGenerationJobs(r.Context(), tenantIDFrom(r), store.GenerationJobQuery{
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
	tenantID := tenantIDFrom(r)
	if err := s.store.CheckGenerationQuota(r.Context(), tenantID); errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "generation quota exceeded", http.StatusTooManyRequests)
		return
	} else if err != nil {
		http.Error(w, "failed to check generation quota", http.StatusInternalServerError)
		return
	}
	if _, err := s.store.GetGenerationJob(r.Context(), tenantID, job.ID); err == nil {
		http.Error(w, "generation job already exists", http.StatusConflict)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		http.Error(w, "failed to inspect generation job", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job.CreatedAt, job.UpdatedAt = now, now
	if err := s.store.PutGenerationJob(r.Context(), tenantID, job); err != nil {
		http.Error(w, "failed to store generation job", http.StatusInternalServerError)
		return
	}
	meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind})
	_ = s.store.RecordUsage(r.Context(), tenantID, userIDFrom(r), "generation", 1, meta)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, job)
}

func (s *Server) replaceGenerationJobs(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationRestoreBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var jobs []store.GenerationJob
	if err := decoder.Decode(&jobs); err != nil || ensureJSONEOF(decoder) != nil || jobs == nil || len(jobs) > maxGenerationRestoreItems {
		http.Error(w, "invalid or oversized generation history", http.StatusBadRequest)
		return
	}
	ids := make(map[string]struct{}, len(jobs))
	for _, job := range jobs {
		if !validGenerationJob(job) {
			http.Error(w, "invalid generation history item", http.StatusBadRequest)
			return
		}
		if _, exists := ids[job.ID]; exists {
			http.Error(w, "duplicate generation history id", http.StatusBadRequest)
			return
		}
		ids[job.ID] = struct{}{}
	}
	if err := s.store.ReplaceGenerationJobs(r.Context(), tenantIDFrom(r), jobs); err != nil {
		http.Error(w, "failed to replace generation history", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), id)
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
	current, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), id)
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
	if err := s.store.PutGenerationJob(r.Context(), tenantIDFrom(r), job); err != nil {
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
	if err := s.store.DeleteGenerationJob(r.Context(), tenantIDFrom(r), id); errors.Is(err, store.ErrNotFound) {
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
	if !validGenerationJobFields(job) {
		return store.GenerationJob{}, errors.New("invalid generation job fields")
	}
	return job, nil
}

func validGenerationJob(job store.GenerationJob) bool {
	if !validGenerationJobFields(job) {
		return false
	}
	_, createdErr := time.Parse(time.RFC3339Nano, job.CreatedAt)
	_, updatedErr := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	return createdErr == nil && updatedErr == nil
}

func validGenerationJobFields(job store.GenerationJob) bool {
	return validProjectID(job.ID) && (job.ProjectID == "" || validProjectID(job.ProjectID)) &&
		generationKinds[job.Kind] && generationStatuses[job.Status] &&
		len(job.Prompt) <= 100_000 && len(job.ProviderID) <= 500 && len(job.Model) <= 500 && len(job.Error) <= 10_000 &&
		jsonObject(job.Parameters) && jsonObject(job.Result)
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
