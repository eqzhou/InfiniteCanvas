package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmGenerationJobView struct {
	ID        string  `json:"id"`
	ParentID  string  `json:"parentJobId,omitempty"`
	ShotID    string  `json:"shotId,omitempty"`
	Stage     string  `json:"stage"`
	Status    string  `json:"status"`
	Title     string  `json:"title"`
	Progress  float64 `json:"progress,omitempty"`
	Error     string  `json:"error,omitempty"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

func stableFilmJobError(status string) string {
	switch status {
	case "failed":
		return "Generation provider failed"
	case "cancelled", "canceled":
		return "Generation was canceled"
	default:
		return ""
	}
}

func filmJobView(task filmTask, job store.GenerationJob) filmGenerationJobView {
	status := job.Status
	if status == "cancelled" {
		status = "canceled"
	}
	return filmGenerationJobView{
		ID: job.ID, ParentID: task.ID, ShotID: task.ShotID, Stage: task.Stage,
		Status: status, Title: task.Title, Progress: task.Progress, Error: stableFilmJobError(job.Status),
		CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt,
	}
}

func (s *Server) listFilmGenerationJobs(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	items := make([]filmGenerationJobView, 0, len(document.Tasks))
	parents := make([]filmTask, 0, len(document.Tasks))
	for _, task := range document.Tasks {
		if task.GenerationJobID == "" {
			continue
		}
		job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), task.GenerationJobID)
		if err == nil {
			parents = append(parents, task)
			items = append(items, filmJobView(task, job))
		}
	}
	writeJSON(w, map[string]any{"data": map[string]any{"tasks": parents, "generationJobs": items}})
}

func findFilmTaskByJob(document filmDocument, jobID string) (int, filmTask, error) {
	if !validProjectID(jobID) {
		return -1, filmTask{}, errors.New("generation job id is invalid")
	}
	for index := len(document.Tasks) - 1; index >= 0; index-- {
		if document.Tasks[index].GenerationJobID == jobID {
			return index, document.Tasks[index], nil
		}
	}
	return -1, filmTask{}, errors.New("generation job is not bound to this film")
}

func setFilmTaskFromJob(s *Server, r *http.Request, document *filmDocument, taskIndex int, task filmTask, job store.GenerationJob) error {
	if latestFilmStageTasks(*document, task.Stage)[task.ShotID] != taskIndex {
		return errors.New("generation job is historical and cannot update current film media")
	}
	if task.Status == filmStatusCanceled {
		return errors.New("canceled film task cannot be synchronized")
	}
	binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: task.Stage, ShotID: task.ShotID, TaskID: task.ID, RequestHash: task.RequestHash}
	if !matchingFilmGenerationJob(job, binding) {
		return errors.New("generation job binding is invalid")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	switch job.Status {
	case "queued", "running":
		task.Status, task.Error = filmStatusRunning, ""
		if job.Status == "running" {
			task.Progress = 0.5
		} else {
			task.Progress = 0
		}
	case "failed":
		task.Status, task.Progress, task.Error = filmStatusFailed, 0, stableFilmJobError(job.Status)
	case "cancelled", "canceled":
		task.Status, task.Progress, task.Error = filmStatusCanceled, 0, stableFilmJobError(job.Status)
	case "succeeded":
		item, err := validFilmGenerationResult(r.Context(), s, tenantIDFrom(r), task.Stage, job)
		if err != nil {
			task.Status, task.Progress, task.Error = filmStatusFailed, 0, "Generation result is unavailable or invalid"
			break
		}
		for index, shot := range document.Shots {
			if shot.ID != task.ShotID {
				continue
			}
			setFilmShotMediaBinding(&shot, task.Stage, item, job.ID)
			shot.MediaMIMEType, shot.Status = item.MIMEType, filmStatusNeedsReview
			shot.Revision++
			document.Shots[index] = shot
		}
		task.Status, task.Progress, task.Error = filmStatusNeedsReview, 1, ""
	default:
		return errors.New("generation job state is unsupported")
	}
	task.Revision++
	task.UpdatedAt = now
	document.Tasks[taskIndex] = task
	stageIndex, stage, err := findFilmStage(*document, task.Stage)
	if err != nil {
		return err
	}
	stage.Status, stage.Error = filmStatusNeedsReview, ""
	for _, candidateIndex := range latestFilmStageTasks(*document, task.Stage) {
		candidate := document.Tasks[candidateIndex]
		if candidate.Status == filmStatusRunning {
			stage.Status = filmStatusRunning
			break
		}
		if candidate.Status == filmStatusFailed || candidate.Status == filmStatusCanceled {
			stage.Status, stage.Error = filmStatusFailed, "One or more generation tasks require retry"
		}
	}
	stage.Revision++
	stage.UpdatedAt = now
	document.Stages[stageIndex] = stage
	document.Revision++
	document.UpdatedAt = now
	return nil
}

func (s *Server) syncFilmGenerationJob(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	if input.Revision != document.Revision {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film document revision conflict")
		return
	}
	taskIndex, task, err := findFilmTaskByJob(document, chi.URLParam(r, "jobId"))
	if err != nil {
		writeFilmError(w, http.StatusNotFound, "generation_job_not_found", err.Error())
		return
	}
	if latestFilmStageTasks(document, task.Stage)[task.ShotID] != taskIndex || task.Status == filmStatusCanceled {
		writeFilmError(w, http.StatusConflict, "generation_job_stale", "generation job is no longer the active task for this shot")
		return
	}
	job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), task.GenerationJobID)
	if err != nil {
		writeFilmError(w, http.StatusNotFound, "generation_job_not_found", "generation job is unavailable")
		return
	}
	if job.Kind == "text" && job.Status == "succeeded" {
		if err := s.syncFilmTextJobCandidate(r.Context(), tenantIDFrom(r), job); err != nil {
			writeFilmOperationError(w, err)
			return
		}
		updated, err := backend.GetFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID)
		if err != nil {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "film production could not be synchronized")
			return
		}
		next, err := decodeFilmDocument(updated.Document)
		if err != nil {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "film production could not be synchronized")
			return
		}
		s.writeFilmDocument(w, r, http.StatusOK, updated, next)
		return
	}
	next := cloneFilmDocument(document)
	if err := setFilmTaskFromJob(s, r, &next, taskIndex, task, job); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, _ := json.Marshal(next)
	updated, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw)
	if errors.Is(err, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film production changed; reload before retrying")
		return
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "film production could not be synchronized")
		return
	}
	s.writeFilmDocument(w, r, http.StatusOK, updated, next)
}

func retryFilmJobClone(job store.GenerationJob, task filmTask, projectID string, now string) (store.GenerationJob, filmTask, error) {
	newTaskID := stableFilmID("task-retry", job.ID)
	newJobID := stableFilmID("job-retry", job.ID)
	requestHash, err := hashGenerationInput(map[string]string{"retryOf": job.ID, "projectId": projectID})
	if err != nil {
		return store.GenerationJob{}, filmTask{}, err
	}
	binding := &filmGenerationBinding{ProjectID: projectID, Stage: task.Stage, ShotID: task.ShotID, TaskID: newTaskID, RequestHash: requestHash}
	if job.Kind == "image" {
		var parameters persistedImageJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil {
			return store.GenerationJob{}, filmTask{}, errors.New("generation retry parameters are invalid")
		}
		parameters.RequestHash, parameters.Film = requestHash, binding
		job.Parameters, _ = json.Marshal(parameters)
	} else {
		var parameters persistedMediaJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil {
			return store.GenerationJob{}, filmTask{}, errors.New("generation retry parameters are invalid")
		}
		parameters.RequestHash, parameters.Film = requestHash, binding
		job.Parameters, _ = json.Marshal(parameters)
	}
	job.ID, job.Status, job.Result, job.Error = newJobID, "queued", json.RawMessage(`{}`), ""
	job.CreatedAt, job.UpdatedAt, job.LeaseOwner, job.LeaseExpiresAt = now, now, "", ""
	retryTask := filmTask{
		ID: newTaskID, Revision: 1, Stage: task.Stage, ShotID: task.ShotID, Title: task.Title,
		Status: filmStatusRunning, CreatedAt: now, UpdatedAt: now, GenerationJobID: newJobID,
		IdempotencyKey: "retry:" + job.ID, RequestHash: requestHash, Snapshot: task.Snapshot,
	}
	return job, retryTask, nil
}

func (s *Server) retryFilmGenerationJob(w http.ResponseWriter, r *http.Request) {
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	taskIndex, task, err := findFilmTaskByJob(document, chi.URLParam(r, "jobId"))
	if err != nil {
		writeFilmError(w, http.StatusNotFound, "generation_job_not_found", err.Error())
		return
	}
	if latestFilmStageTasks(document, task.Stage)[task.ShotID] != taskIndex {
		writeFilmError(w, http.StatusConflict, "generation_job_historical", "historical generation jobs cannot be retried")
		return
	}
	job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), task.GenerationJobID)
	if err != nil || (job.Status != "failed" && job.Status != "cancelled" && job.Status != "canceled") {
		writeFilmError(w, http.StatusConflict, "generation_retry_invalid", "only a failed or canceled generation job can be retried")
		return
	}
	storedBinding, _ := filmJobBinding(job)
	if storedBinding == nil || storedBinding.ProjectID != document.ProjectID || storedBinding.TaskID != task.ID {
		writeFilmError(w, http.StatusConflict, "generation_job_binding_invalid", "generation job binding is invalid")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	retryJob, retryTask, err := retryFilmJobClone(job, task, document.ProjectID, now)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), retryJob.ID); getErr == nil {
		retryJob = existing
	} else if !errors.Is(getErr, store.ErrNotFound) {
		writeFilmError(w, http.StatusInternalServerError, "generation_storage_error", "generation job state is unavailable")
		return
	} else {
		meta, _ := json.Marshal(map[string]any{"jobId": retryJob.ID, "kind": retryJob.Kind, "executor": serverExecutorMarker, "filmProjectId": document.ProjectID, "shotId": task.ShotID})
		if err := s.store.CreateServerGenerationJob(r.Context(), tenantIDFrom(r), userIDFrom(r), retryJob, 1, meta); err != nil {
			writeFilmOperationError(w, filmGenerationStoreError(err))
			return
		}
	}
	next := cloneFilmDocument(document)
	found := false
	for _, candidate := range next.Tasks {
		if candidate.GenerationJobID == retryJob.ID {
			found = true
		}
	}
	if !found {
		next.Tasks = append(next.Tasks, retryTask)
		next.Revision++
		next.UpdatedAt = now
	}
	raw, _ := json.Marshal(next)
	if _, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw); err != nil {
		s.compensateUnreferencedFilmJobs(r.Context(), tenantIDFrom(r), document.ProjectID, []string{retryJob.ID})
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film production changed; reload before retrying")
		return
	}
	s.notifyFilmGenerationWorkers(task.Stage)
	writeJSONStatus(w, http.StatusAccepted, map[string]any{"data": filmJobView(retryTask, retryJob)})
}

func (s *Server) cancelFilmGenerationJob(w http.ResponseWriter, r *http.Request) {
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	taskIndex, task, err := findFilmTaskByJob(document, chi.URLParam(r, "jobId"))
	if err != nil {
		writeFilmError(w, http.StatusNotFound, "generation_job_not_found", err.Error())
		return
	}
	if latestFilmStageTasks(document, task.Stage)[task.ShotID] != taskIndex {
		writeFilmError(w, http.StatusConflict, "generation_job_stale", "only the active generation task can be canceled")
		return
	}
	now := time.Now().UTC()
	cancelCtx, cancel := detachedFilmContext(r.Context())
	defer cancel()
	job, err := s.store.CancelServerGenerationJob(cancelCtx, tenantIDFrom(r), task.GenerationJobID, now)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	next := cloneFilmDocument(document)
	if err := setFilmTaskFromJob(s, r, &next, taskIndex, task, job); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, _ := json.Marshal(next)
	if _, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw); err != nil {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film production changed; reload before retrying")
		return
	}
	writeJSON(w, map[string]any{"data": filmJobView(next.Tasks[taskIndex], job)})
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(w, value)
}
