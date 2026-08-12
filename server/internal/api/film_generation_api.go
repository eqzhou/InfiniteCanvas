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
	ID         string  `json:"id"`
	ParentID   string  `json:"parentJobId,omitempty"`
	ShotID     string  `json:"shotId,omitempty"`
	DialogueID string  `json:"dialogueId,omitempty"`
	Stage      string  `json:"stage"`
	Status     string  `json:"status"`
	Title      string  `json:"title"`
	Progress   float64 `json:"progress,omitempty"`
	Error      string  `json:"error,omitempty"`
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
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
		ID: job.ID, ParentID: task.ParentGenerationJobID, ShotID: task.ShotID, DialogueID: task.DialogueID, Stage: task.Stage,
		Status: status, Title: task.Title, Progress: task.Progress, Error: stableFilmJobError(job.Status),
		CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt,
	}
}

func filmStageJobView(stage string, job store.GenerationJob) filmGenerationJobView {
	var result filmStageGenerationResult
	_ = json.Unmarshal(job.Result, &result)
	status := job.Status
	if status == "cancelled" {
		status = "canceled"
	}
	return filmGenerationJobView{
		ID: job.ID, Stage: stage, Status: status, Title: "Generate " + stage,
		Progress: result.Progress, Error: stableFilmJobError(job.Status), CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt,
	}
}

func (s *Server) listFilmGenerationJobs(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	items := make([]filmGenerationJobView, 0, len(document.Tasks)*2)
	parents := make([]filmTask, 0, len(document.Tasks))
	childrenByParent := make(map[string][]store.GenerationJob)
	stageByParent := make(map[string]string)
	childViews := make([]filmGenerationJobView, 0, len(document.Tasks))
	parentOrder := make([]string, 0)
	for _, task := range document.Tasks {
		if task.GenerationJobID == "" {
			continue
		}
		job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), task.GenerationJobID)
		if err == nil {
			parents = append(parents, task)
			childViews = append(childViews, filmJobView(task, job))
			if task.ParentGenerationJobID != "" {
				if _, exists := childrenByParent[task.ParentGenerationJobID]; !exists {
					parentOrder = append(parentOrder, task.ParentGenerationJobID)
					stageByParent[task.ParentGenerationJobID] = task.Stage
				}
				childrenByParent[task.ParentGenerationJobID] = append(childrenByParent[task.ParentGenerationJobID], job)
			}
		}
	}
	for _, parentID := range parentOrder {
		parent, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), parentID)
		if err != nil {
			continue
		}
		aggregated, err := aggregateFilmStageGenerationJob(parent, childrenByParent[parentID])
		if err != nil {
			continue
		}
		items = append(items, filmStageJobView(stageByParent[parentID], aggregated))
	}
	items = append(items, childViews...)
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

func latestFilmTaskIndex(document filmDocument, task filmTask) int {
	if task.ShotID != "" {
		return latestFilmStageTasks(document, task.Stage)[filmTaskTargetID(task)]
	}
	for index := len(document.Tasks) - 1; index >= 0; index-- {
		candidate := document.Tasks[index]
		if candidate.Stage == task.Stage && candidate.ShotID == "" && candidate.GenerationJobID != "" {
			return index
		}
	}
	return -1
}

func setFilmTaskFromJob(s *Server, r *http.Request, document *filmDocument, taskIndex int, task filmTask, job store.GenerationJob) error {
	if latestFilmTaskIndex(*document, task) != taskIndex {
		return errors.New("generation job is historical and cannot update current film media")
	}
	if task.Status == filmStatusCanceled {
		return errors.New("canceled film task cannot be synchronized")
	}
	binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: task.Stage, ShotID: task.ShotID, DialogueID: task.DialogueID, TaskID: task.ID, ParentGenerationJobID: task.ParentGenerationJobID, RequestHash: task.RequestHash}
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
		if task.DialogueID != "" {
			for index, dialogue := range document.Dialogues {
				if dialogue.ID != task.DialogueID || dialogue.ShotID != task.ShotID {
					continue
				}
				dialogue.AudioStorageKey, dialogue.AudioSHA256, dialogue.AudioObjectVersion, dialogue.AudioGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, job.ID
				dialogue.Status, dialogue.Revision = filmStatusNeedsReview, dialogue.Revision+1
				document.Dialogues[index] = dialogue
			}
		} else {
			for index, shot := range document.Shots {
				if shot.ID != task.ShotID {
					continue
				}
				setFilmShotMediaBinding(&shot, task.Stage, item, job.ID)
				shot.MediaMIMEType, shot.Status = item.MIMEType, filmStatusNeedsReview
				shot.Revision++
				document.Shots[index] = shot
			}
		}
		task.Status, task.Progress, task.Error = filmStatusNeedsReview, 1, ""
	default:
		return errors.New("generation job state is unsupported")
	}
	task.Revision++
	task.UpdatedAt = now
	document.Tasks[taskIndex] = task
	stageIndex, stage, err := findFilmStage(*document, filmRepairLifecycleStage(task.Stage))
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

func setFilmTextTaskFromJob(document *filmDocument, taskIndex int, task filmTask, job store.GenerationJob) error {
	if task.Stage == "style_extraction" {
		return setFilmStyleTaskFromJob(document, taskIndex, task, job)
	}
	if latestFilmTaskIndex(*document, task) != taskIndex {
		return errors.New("generation job is historical and cannot update the current film text task")
	}
	binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: task.Stage, TaskID: task.ID, ParentGenerationJobID: task.ParentGenerationJobID, RequestHash: task.RequestHash}
	if !matchingFilmGenerationJob(job, binding) {
		return errors.New("generation job binding is invalid")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	switch job.Status {
	case "queued":
		task.Status, task.Progress, task.Error = filmStatusRunning, 0, ""
	case "running":
		task.Status, task.Progress, task.Error = filmStatusRunning, 0.5, ""
	case "failed":
		task.Status, task.Progress, task.Error = filmStatusFailed, 0, stableFilmJobError(job.Status)
	case "cancelled", "canceled":
		task.Status, task.Progress, task.Error = filmStatusCanceled, 0, stableFilmJobError(job.Status)
	default:
		return errors.New("text generation job state is unsupported")
	}
	task.Revision++
	task.UpdatedAt = now
	document.Tasks[taskIndex] = task
	stageIndex, stage, err := findFilmStage(*document, filmRepairLifecycleStage(task.Stage))
	if err != nil {
		return err
	}
	stage.Revision++
	stage.UpdatedAt = now
	if task.Status == filmStatusRunning {
		stage.Status, stage.Error = filmStatusRunning, ""
	} else {
		stage.Status, stage.Error = filmStatusFailed, "Text generation requires retry"
	}
	document.Stages[stageIndex] = stage
	document.Revision++
	document.UpdatedAt = now
	return nil
}

func setFilmStyleTaskFromJob(document *filmDocument, taskIndex int, task filmTask, job store.GenerationJob) error {
	if latestFilmTaskIndex(*document, task) != taskIndex || task.StyleSnapshot == nil {
		return errors.New("generation job is historical and cannot update the current style extraction task")
	}
	binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: task.Stage, TaskID: task.ID, RequestHash: task.RequestHash}
	if !matchingFilmGenerationJob(job, binding) {
		return errors.New("generation job binding is invalid")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	switch job.Status {
	case "queued":
		task.Status, task.Progress, task.Error = filmStatusRunning, 0, ""
	case "running":
		task.Status, task.Progress, task.Error = filmStatusRunning, 0.5, ""
	case "failed":
		task.Status, task.Progress, task.Error = filmStatusFailed, 0, stableFilmJobError(job.Status)
	case "cancelled", "canceled":
		task.Status, task.Progress, task.Error = filmStatusCanceled, 0, stableFilmJobError(job.Status)
	default:
		return errors.New("style extraction job state is unsupported")
	}
	task.Revision++
	task.UpdatedAt = now
	document.Tasks[taskIndex] = task
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
	if latestFilmTaskIndex(document, task) != taskIndex || task.Status == filmStatusCanceled {
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
	if job.Kind == "text" {
		err = setFilmTextTaskFromJob(&next, taskIndex, task, job)
	} else {
		err = setFilmTaskFromJob(s, r, &next, taskIndex, task, job)
	}
	if err != nil {
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
	binding := &filmGenerationBinding{ProjectID: projectID, Stage: task.Stage, ShotID: task.ShotID, DialogueID: task.DialogueID, TaskID: newTaskID, RequestHash: requestHash}
	if job.Kind == "text" {
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || validatePersistedTextJob(job, parameters) != nil || parameters.Film == nil {
			return store.GenerationJob{}, filmTask{}, errors.New("text generation retry parameters are invalid")
		}
		parameters.RequestHash, parameters.Film = requestHash, binding
		job.Parameters, _ = json.Marshal(parameters)
	} else if job.Kind == "image" {
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
		ID: newTaskID, Revision: 1, Stage: task.Stage, ShotID: task.ShotID, DialogueID: task.DialogueID, Title: task.Title,
		Status: filmStatusRunning, CreatedAt: now, UpdatedAt: now, GenerationJobID: newJobID,
		IdempotencyKey: "retry:" + job.ID, RequestHash: requestHash, Snapshot: task.Snapshot, TextSnapshot: task.TextSnapshot, StyleSnapshot: task.StyleSnapshot,
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
	if latestFilmTaskIndex(document, task) != taskIndex {
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
	if retryJob.Kind == "text" {
		selectedProviderID, channelSnapshot, snapshotErr := s.snapshotGenerationChannel(r.Context(), tenantIDFrom(r), "text", retryJob.ID, retryJob.ProviderID, retryJob.Model)
		if snapshotErr != nil {
			writeFilmOperationError(w, snapshotErr)
			return
		}
		var parameters persistedTextJobParameters
		if json.Unmarshal(retryJob.Parameters, &parameters) != nil {
			writeFilmError(w, http.StatusUnprocessableEntity, "generation_retry_invalid", "text generation retry snapshot is invalid")
			return
		}
		parameters.SharedChannel = channelSnapshot
		retryJob.ProviderID = selectedProviderID
		if channelSnapshot != nil && channelSnapshot.Model != "" {
			retryJob.Model = channelSnapshot.Model
		}
		retryJob.Parameters, _ = json.Marshal(parameters)
	}
	estimatedCredits, quoteErr := s.store.GetModelCreditCost(r.Context(), tenantIDFrom(r), retryJob.Model)
	if quoteErr != nil || setFilmGenerationJobCreditQuote(&retryJob, estimatedCredits) != nil {
		writeFilmError(w, http.StatusServiceUnavailable, "billing_unavailable", "Film generation retry credit quote is unavailable")
		return
	}
	if retryTask.Snapshot != nil {
		snapshot := *retryTask.Snapshot
		snapshot.ProviderID, snapshot.Model, snapshot.EstimatedCredits = retryJob.ProviderID, retryJob.Model, estimatedCredits
		retryTask.Snapshot = &snapshot
	}
	if retryTask.TextSnapshot != nil {
		snapshot := *retryTask.TextSnapshot
		snapshot.ProviderID, snapshot.Model, snapshot.EstimatedCredits = retryJob.ProviderID, retryJob.Model, estimatedCredits
		retryTask.TextSnapshot = &snapshot
	}
	if retryTask.StyleSnapshot != nil {
		snapshot := *retryTask.StyleSnapshot
		snapshot.ProviderID, snapshot.Model, snapshot.EstimatedCredits = retryJob.ProviderID, retryJob.Model, estimatedCredits
		retryTask.StyleSnapshot = &snapshot
		var parameters persistedTextJobParameters
		if json.Unmarshal(retryJob.Parameters, &parameters) == nil {
			parameters.Style = &snapshot
			retryJob.Parameters, _ = json.Marshal(parameters)
		}
	}
	jobExists := false
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), retryJob.ID); getErr == nil {
		binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: retryTask.Stage, ShotID: retryTask.ShotID, DialogueID: retryTask.DialogueID, TaskID: retryTask.ID, RequestHash: retryTask.RequestHash}
		if !matchingFilmGenerationJob(existing, binding) {
			writeFilmError(w, http.StatusConflict, "generation_job_conflict", "generation retry job id belongs to another request")
			return
		}
		retryJob = existing
		jobExists = true
	} else if !errors.Is(getErr, store.ErrNotFound) {
		writeFilmError(w, http.StatusInternalServerError, "generation_storage_error", "generation job state is unavailable")
		return
	}
	if jobExists && retryJob.Status != "queued" {
		writeFilmError(w, http.StatusConflict, "generation_retry_invalid", "existing generation retry job is no longer queued")
		return
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
	tenantID, userID := tenantIDFrom(r), userIDFrom(r)
	meta, _ := json.Marshal(map[string]any{"jobId": retryJob.ID, "kind": retryJob.Kind, "executor": serverExecutorMarker, "filmProjectId": document.ProjectID, "shotId": task.ShotID})
	if atomicBackend, ok := s.store.(store.FilmGenerationBatchStore); ok && !jobExists {
		if _, err := atomicBackend.CreateFilmGenerationBatch(r.Context(), tenantID, userID, record.ProjectID, record.Revision, raw, []store.FilmGenerationReservation{{Job: retryJob, Units: 1, UsageMeta: meta, ExpectedCredits: &estimatedCredits}}); err != nil {
			writeFilmTextBatchError(w, err)
			return
		}
	} else {
		created := false
		if !jobExists {
			if err := s.store.CreateServerGenerationJob(r.Context(), tenantID, userID, retryJob, 1, meta); err != nil {
				writeFilmOperationError(w, filmGenerationStoreError(err))
				return
			}
			created = true
		}
		if _, err := backend.CompareAndSwapFilmProject(r.Context(), tenantID, record.ProjectID, record.Revision, raw); err != nil {
			if created {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, []string{retryJob.ID})
			}
			writeFilmError(w, http.StatusConflict, "revision_conflict", "film production changed; reload before retrying")
			return
		}
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
	if latestFilmTaskIndex(document, task) != taskIndex {
		writeFilmError(w, http.StatusConflict, "generation_job_stale", "only the active generation task can be canceled")
		return
	}
	now := time.Now().UTC()
	cancelCtx, cancel := detachedFilmContext(r.Context())
	defer cancel()
	job, err := s.cancelServerGenerationJobWithSideEffectLock(cancelCtx, tenantIDFrom(r), task.GenerationJobID, now)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	next := cloneFilmDocument(document)
	if job.Kind == "text" {
		err = setFilmTextTaskFromJob(&next, taskIndex, task, job)
	} else {
		err = setFilmTaskFromJob(s, r, &next, taskIndex, task, job)
	}
	if err != nil {
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
