package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const maxGenerationJobBytes = 1 << 20
const maxGenerationRestoreBytes = 32 << 20
const maxGenerationRestoreItems = 10_000

var generationKinds = map[string]bool{"text": true, "image": true, "video": true, "audio": true, "workflow": true, "export": true, "film-stage": true}
var generationStatuses = map[string]bool{
	"queued": true, "running": true, "succeeded": true, "failed": true, "cancelled": true, "deleted": true,
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
	includeDeleted := r.URL.Query().Get("includeDeleted") == "1" || r.URL.Query().Get("includeDeleted") == "true"
	userID, authorized := generationJobScopeUserID(r)
	if !authorized {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "all" {
		status = ""
	} else if status != "" && !generationStatuses[status] {
		http.Error(w, "invalid generation status", http.StatusBadRequest)
		return
	}
	result, err := s.store.ListGenerationJobs(r.Context(), tenantIDFrom(r), store.GenerationJobQuery{
		UserID: userID, ProjectID: projectID, Kind: kind, Status: status, Page: page, PageSize: pageSize, IncludeDeleted: includeDeleted,
	})
	if err != nil {
		http.Error(w, "failed to list generation jobs", http.StatusInternalServerError)
		return
	}
	for index, job := range result.Items {
		result.Items[index] = s.filmStageGenerationView(r.Context(), tenantIDFrom(r), job)
	}
	writeJSON(w, publicGenerationJobPage(result))
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
	if job.Status == "deleted" {
		http.Error(w, "generation jobs must be deleted through the delete endpoint", http.StatusBadRequest)
		return
	}
	if isServerGenerationJob(job) {
		http.Error(w, "server generation jobs must use the execution endpoint", http.StatusBadRequest)
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
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job.UserID = strings.TrimSpace(userIDFrom(r))
	if authMode() != "off" && !requestHasBootstrapProcessAccess(r) && job.UserID == "" {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	job.CreatedAt, job.UpdatedAt = now, now
	if err := s.store.CreateGenerationJob(r.Context(), tenantID, job); errors.Is(err, store.ErrConflict) {
		http.Error(w, "generation job already exists", http.StatusConflict)
		return
	} else if errors.Is(err, store.ErrGone) {
		http.Error(w, "generation job was deleted", http.StatusGone)
		return
	} else if err != nil {
		http.Error(w, "failed to store generation job", http.StatusInternalServerError)
		return
	}
	meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind})
	_ = s.store.RecordUsage(r.Context(), tenantID, userIDFrom(r), "generation", 1, meta)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, publicGenerationJob(job))
}

func (s *Server) replaceGenerationJobs(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant generation history unavailable") {
		return
	}
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
		if !validGenerationJob(job) || job.Status == "deleted" {
			http.Error(w, "invalid generation history item", http.StatusBadRequest)
			return
		}
		if isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
			http.Error(w, "active server generation jobs cannot be restored", http.StatusBadRequest)
			return
		}
		if _, exists := ids[job.ID]; exists {
			http.Error(w, "duplicate generation history id", http.StatusBadRequest)
			return
		}
		ids[job.ID] = struct{}{}
	}
	actorID := strings.TrimSpace(userIDFrom(r))
	if authMode() != "off" && !requestHasBootstrapProcessAccess(r) && actorID == "" {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	for index := range jobs {
		jobs[index].UserID = actorID
	}
	if err := validateRestoredGenerationJobRelations(jobs); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.store.ReplaceGenerationJobs(r.Context(), tenantIDFrom(r), jobs); errors.Is(err, store.ErrConflict) {
		http.Error(w, "active server generation jobs must finish or be cancelled before restore", http.StatusConflict)
		return
	} else if errors.Is(err, store.ErrGone) {
		http.Error(w, "generation history contains a deleted job", http.StatusGone)
		return
	} else if err != nil {
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
	if !requestCanAccessGenerationJob(r, job) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	job = s.filmStageGenerationView(r.Context(), tenantIDFrom(r), job)
	writeJSON(w, publicGenerationJob(job))
}

func (s *Server) updateGenerationJob(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	job, err := decodeGenerationJob(w, r)
	if err != nil || job.ID != id || job.Status == "deleted" {
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
	if !requestCanAccessGenerationJob(r, current) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if current.Status == "deleted" {
		http.Error(w, "generation job was deleted", http.StatusGone)
		return
	}
	if isServerGenerationJob(current) {
		http.Error(w, "server generation jobs are read-only", http.StatusConflict)
		return
	}
	if isServerGenerationJob(job) {
		http.Error(w, "browser generation jobs cannot become server-owned", http.StatusConflict)
		return
	}
	job.CreatedAt = current.CreatedAt
	job.UserID = current.UserID
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.store.PutGenerationJob(r.Context(), tenantIDFrom(r), job); errors.Is(err, store.ErrGone) {
		http.Error(w, "generation job was deleted", http.StatusGone)
		return
	} else if err != nil {
		http.Error(w, "failed to update generation job", http.StatusInternalServerError)
		return
	}
	writeJSON(w, publicGenerationJob(job))
}

func (s *Server) deleteGenerationJob(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant generation history unavailable") {
		return
	}
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
	if isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
		http.Error(w, "active generation jobs must be cancelled before deletion", http.StatusConflict)
		return
	}
	if job.Kind == "workflow" {
		for _, childID := range workflowChildJobIDs(job.Result) {
			child, childErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), childID)
			if childErr == nil && (child.Status == "queued" || child.Status == "running") {
				http.Error(w, "workflow child jobs must finish or be cancelled before deletion", http.StatusConflict)
				return
			}
		}
	}
	if err := validateFilmStageDeletion(r.Context(), s.store, tenantIDFrom(r), map[string]struct{}{id: {}}); errors.Is(err, errFilmStageChildReferenced) {
		http.Error(w, "Film stage child and parent must be deleted together", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to validate Film generation history", http.StatusInternalServerError)
		return
	}
	if err := s.store.DeleteGenerationJob(r.Context(), tenantIDFrom(r), id); errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if errors.Is(err, store.ErrConflict) {
		http.Error(w, "Film stage child and parent must be deleted together", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to delete generation job", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) bulkDeleteGenerationJobs(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant generation history unavailable") {
		return
	}
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := decoder.Decode(&input); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid bulk delete payload", http.StatusBadRequest)
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > 100 {
		http.Error(w, "ids must contain 1-100 generation job ids", http.StatusBadRequest)
		return
	}
	unique := make([]string, 0, len(input.IDs))
	seen := make(map[string]struct{}, len(input.IDs))
	for _, id := range input.IDs {
		if !validProjectID(id) {
			http.Error(w, "invalid generation job id", http.StatusBadRequest)
			return
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	if len(unique) == 0 {
		http.Error(w, "ids must contain 1-100 generation job ids", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	// Match single-delete safety: refuse active server/workflow jobs so credits stay refundable via cancel.
	for _, id := range unique {
		job, err := s.store.GetGenerationJob(r.Context(), tenantID, id)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			http.Error(w, "failed to read generation job", http.StatusInternalServerError)
			return
		}
		if isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
			http.Error(w, "active generation jobs must be cancelled before deletion", http.StatusConflict)
			return
		}
		if job.Kind == "workflow" {
			for _, childID := range workflowChildJobIDs(job.Result) {
				child, childErr := s.store.GetGenerationJob(r.Context(), tenantID, childID)
				if childErr == nil && (child.Status == "queued" || child.Status == "running") {
					http.Error(w, "workflow child jobs must finish or be cancelled before deletion", http.StatusConflict)
					return
				}
			}
		}
	}
	deleting := make(map[string]struct{}, len(unique))
	for _, id := range unique {
		deleting[id] = struct{}{}
	}
	if err := validateFilmStageDeletion(r.Context(), s.store, tenantID, deleting); errors.Is(err, errFilmStageChildReferenced) {
		http.Error(w, "Film stage children and parents must be deleted together", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to validate Film generation history", http.StatusInternalServerError)
		return
	}
	deleted, err := s.store.DeleteGenerationJobs(r.Context(), tenantID, unique)
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "Film stage children and parents must be deleted together", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to bulk delete generation jobs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"deleted": deleted})
}

func (s *Server) deleteGenerationJobsForProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant generation history unavailable") {
		return
	}
	if s.store == nil {
		http.Error(w, "generation history requires PostgreSQL", http.StatusServiceUnavailable)
		return
	}
	projectID := chi.URLParam(r, "projectId")
	if !validProjectID(projectID) {
		http.Error(w, "invalid project id", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	// Cancel active server/workflow jobs first so reserved credits are refunded.
	page := 1
	for {
		result, err := s.store.ListGenerationJobs(r.Context(), tenantID, store.GenerationJobQuery{
			ProjectID: projectID, Page: page, PageSize: 100, IncludeDeleted: true,
		})
		if err != nil {
			http.Error(w, "failed to list project generation jobs", http.StatusInternalServerError)
			return
		}
		for _, job := range result.Items {
			if isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
				if _, err := s.cancelServerGenerationJobWithSideEffectLock(r.Context(), tenantID, job.ID, time.Now().UTC()); err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrConflict) {
					http.Error(w, "failed to cancel active generation job", http.StatusInternalServerError)
					return
				}
				if job.Kind == "workflow" {
					for _, childID := range workflowChildJobIDs(job.Result) {
						_, _ = s.cancelServerGenerationJobWithSideEffectLock(r.Context(), tenantID, childID, time.Now().UTC())
					}
				}
			}
		}
		if page*result.PageSize >= result.Total || len(result.Items) == 0 {
			break
		}
		page++
		if page > 10_000 {
			break
		}
	}
	deleted, err := s.store.DeleteGenerationJobsForProject(r.Context(), tenantID, projectID)
	if err != nil {
		http.Error(w, "failed to delete project generation jobs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"deleted": deleted})
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
	valid := validProjectID(job.ID) && (job.ProjectID == "" || validProjectID(job.ProjectID)) &&
		generationKinds[job.Kind] && generationStatuses[job.Status] &&
		len(job.Prompt) <= 100_000 && len(job.ProviderID) <= 500 && len(job.Model) <= 500 && len(job.Error) <= 10_000 &&
		jsonObject(job.Parameters) && jsonObject(job.Result)
	if !valid {
		return false
	}
	if job.Kind == "workflow" {
		_, _, err := validatePersistedWorkflowJob(job)
		return err == nil
	}
	if job.Kind == "export" {
		return validPersistedFilmExportJob(job)
	}
	if job.Kind == "film-stage" {
		return validPersistedFilmStageJob(job)
	}
	return true
}

func validPersistedFilmStageJob(job store.GenerationJob) bool {
	var parameters filmStageGenerationParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil {
		return false
	}
	validStage := parameters.Stage == "storyboard" || parameters.Stage == "first_frame" || parameters.Stage == "last_frame" || parameters.Stage == "audio" || parameters.Stage == "video"
	if parameters.Executor != "film-stage" || parameters.ProjectID != job.ProjectID || !validProjectID(parameters.ProjectID) || !validStage || !validFilmRequestHash(parameters.RequestHash) || len(parameters.ChildJobIDs) < 1 || len(parameters.ChildJobIDs) > 1_000 {
		return false
	}
	seen := make(map[string]struct{}, len(parameters.ChildJobIDs))
	for _, childID := range parameters.ChildJobIDs {
		if !validProjectID(childID) {
			return false
		}
		if _, duplicate := seen[childID]; duplicate {
			return false
		}
		seen[childID] = struct{}{}
	}
	if len(parameters.ChildCredits) == 0 {
		return parameters.EstimatedCredits == 0
	}
	if len(parameters.ChildCredits) != len(parameters.ChildJobIDs) {
		return false
	}
	total := 0
	for _, credits := range parameters.ChildCredits {
		if credits < 1 || credits > 1_000_000_000 || total > 1_000_000_000-credits {
			return false
		}
		total += credits
	}
	return parameters.EstimatedCredits == total
}

func validateRestoredGenerationJobRelations(jobs []store.GenerationJob) error {
	byID := make(map[string]store.GenerationJob, len(jobs))
	for _, job := range jobs {
		byID[job.ID] = job
	}
	for _, parent := range jobs {
		if parent.Kind != "film-stage" {
			continue
		}
		var parameters filmStageGenerationParameters
		if json.Unmarshal(parent.Parameters, &parameters) != nil {
			return errors.New("invalid Film stage generation history")
		}
		for childIndex, childID := range parameters.ChildJobIDs {
			child, exists := byID[childID]
			if !exists {
				if len(parameters.ChildCredits) == len(parameters.ChildJobIDs) {
					return errors.New("Film stage generation history is missing a frozen-credit child")
				}
				continue
			}
			expectedCredits := 0
			if len(parameters.ChildCredits) == len(parameters.ChildJobIDs) {
				expectedCredits = parameters.ChildCredits[childIndex]
			}
			if !filmStageChildMatches(parent.ID, parameters, child, expectedCredits) {
				return errors.New("Film stage generation history has an invalid child binding")
			}
		}
	}
	return nil
}

var errFilmStageChildReferenced = errors.New("Film stage child is still referenced by its parent")

func validateFilmStageDeletion(ctx context.Context, backend store.Store, tenantID string, deleting map[string]struct{}) error {
	for page := 1; page <= 10_000; page++ {
		result, err := backend.ListGenerationJobs(ctx, tenantID, store.GenerationJobQuery{Kind: "film-stage", Page: page, PageSize: 100})
		if err != nil {
			return err
		}
		for _, parent := range result.Items {
			if _, deleted := deleting[parent.ID]; deleted {
				continue
			}
			var parameters filmStageGenerationParameters
			if json.Unmarshal(parent.Parameters, &parameters) != nil {
				continue
			}
			for _, childID := range parameters.ChildJobIDs {
				if _, deleted := deleting[childID]; deleted {
					return errFilmStageChildReferenced
				}
			}
		}
		if page*result.PageSize >= result.Total || len(result.Items) == 0 {
			return nil
		}
	}
	return errors.New("Film stage generation history pagination limit reached")
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
