package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const workflowExecutorMarker = "workflow"

var errWorkflowRunningCheckpoint = errors.New("workflow running checkpoint failed")
var errWorkflowChildStatus = errors.New("workflow child status is invalid")

func (s *Server) startWorkflowWorkers(count int) {
	if s.store == nil || count < 1 {
		return
	}
	s.workflowWorkersOnce.Do(func() {
		for range count {
			s.workflowWorkerWG.Add(1)
			go s.workflowWorkerLoop()
		}
		s.notifyWorkflowWorkers()
	})
}

func (s *Server) notifyWorkflowWorkers() {
	select {
	case s.workflowWake <- struct{}{}:
	default:
	}
}

func (s *Server) workflowWorkerLoop() {
	defer s.workflowWorkerWG.Done()
	for {
		now := time.Now().UTC()
		owner := randomGenerationOwner()
		claimed, err := s.store.ClaimServerGenerationJob(s.generationRoot,
			store.GenerationClaim{Kind: "workflow", Executor: workflowExecutorMarker, RequireUserID: authMode() != "off"},
			owner, now, now.Add(generationLeaseDuration))
		if err == nil {
			s.workflowWG.Add(1)
			s.executeClaimedWorkflowJob(claimed)
			s.workflowWG.Done()
			continue
		}
		select {
		case <-s.generationRoot.Done():
			return
		case <-s.workflowWake:
		case <-time.After(time.Second):
		}
	}
}

func decodeWorkflowRunJob(job store.GenerationJob) (workflowRunParameters, workflowRunResult, error) {
	parameters, result, err := validatePersistedWorkflowJob(job)
	if err != nil || parameters.Executor != workflowExecutorMarker {
		return workflowRunParameters{}, workflowRunResult{}, errors.New("invalid server workflow job")
	}
	return parameters, result, nil
}

func validatePersistedWorkflowJob(job store.GenerationJob) (workflowRunParameters, workflowRunResult, error) {
	if job.Kind != "workflow" {
		return workflowRunParameters{}, workflowRunResult{}, errors.New("not a workflow job")
	}
	var parameters workflowRunParameters
	parameterDecoder := json.NewDecoder(bytes.NewReader(job.Parameters))
	parameterDecoder.DisallowUnknownFields()
	if parameterDecoder.Decode(&parameters) != nil || ensureJSONEOF(parameterDecoder) != nil ||
		(parameters.Executor != workflowExecutorMarker && parameters.Executor != "browser") ||
		parameters.TemplateID != parameters.TemplateSnapshot.ID ||
		parameters.TemplateRevision != parameters.TemplateSnapshot.Revision || len(parameters.RequestHash) < 16 ||
		len(parameters.RequestHash) > 64 || !allLowerHex(parameters.RequestHash) ||
		len(parameters.BillingUserID) > 128 || strings.TrimSpace(parameters.BillingUserID) != parameters.BillingUserID ||
		validateWorkflowTemplate(parameters.TemplateSnapshot) != nil {
		return workflowRunParameters{}, workflowRunResult{}, errors.New("invalid workflow parameters")
	}
	values, err := normalizeWorkflowValues(parameters.TemplateSnapshot, parameters.Values)
	if err != nil {
		return workflowRunParameters{}, workflowRunResult{}, err
	}
	parameters.Values = values
	var result workflowRunResult
	resultDecoder := json.NewDecoder(bytes.NewReader(job.Result))
	resultDecoder.DisallowUnknownFields()
	if resultDecoder.Decode(&result) != nil || ensureJSONEOF(resultDecoder) != nil || result.Steps == nil ||
		len(result.Steps) != len(parameters.TemplateSnapshot.Steps) || len(result.OutputStorageKeys) > maxImageGenerationCount*16 {
		return workflowRunParameters{}, workflowRunResult{}, errors.New("invalid workflow result")
	}
	for _, step := range parameters.TemplateSnapshot.Steps {
		state, ok := result.Steps[step.ID]
		if !ok || !validWorkflowStepState(state) {
			return workflowRunParameters{}, workflowRunResult{}, errors.New("invalid workflow step state")
		}
	}
	for _, key := range result.OutputStorageKeys {
		if _, ok := blobFilename(key); !ok {
			return workflowRunParameters{}, workflowRunResult{}, errors.New("invalid workflow output storage key")
		}
	}
	return parameters, result, nil
}

func allLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func workflowStateChildJobIDs(state workflowStepRunState) []string {
	if len(state.ChildJobIDs) > 0 {
		return append([]string(nil), state.ChildJobIDs...)
	}
	if state.ChildJobID != "" {
		return []string{state.ChildJobID}
	}
	return nil
}

func validWorkflowChildJobIDs(state workflowStepRunState) bool {
	ids := workflowStateChildJobIDs(state)
	if len(ids) < 1 || len(ids) > maxImageGenerationCount {
		return false
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !workflowIDPattern.MatchString(id) {
			return false
		}
		if _, exists := seen[id]; exists {
			return false
		}
		seen[id] = struct{}{}
	}
	return state.ChildJobID == "" || state.ChildJobID == ids[0]
}

func validWorkflowStepState(state workflowStepRunState) bool {
	switch state.Status {
	case "pending", "skipped":
		return state.ChildJobID == "" && len(state.ChildJobIDs) == 0 && len(state.StorageKeys) == 0 && len(state.Error) <= 10_000
	case "queued", "running":
		return validWorkflowChildJobIDs(state) && len(state.StorageKeys) == 0 && len(state.Error) <= 10_000
	case "succeeded":
		if len(state.StorageKeys) < 1 || len(state.StorageKeys) > maxImageGenerationCount || len(state.Error) > 10_000 {
			return false
		}
		for _, key := range state.StorageKeys {
			if _, ok := blobFilename(key); !ok {
				return false
			}
		}
		return true
	case "failed", "cancelled":
		return len(state.Error) <= 10_000
	default:
		return false
	}
}

func (s *Server) executeClaimedWorkflowJob(claimed store.TenantGenerationJob) {
	tenantID, job := claimed.TenantID, claimed.Job
	parameters, result, err := decodeWorkflowRunJob(job)
	if err != nil {
		s.completeWorkflowJob(tenantID, job, "failed", result, "工作流文档无效")
		return
	}
	ctx, cancel := context.WithCancel(s.generationRoot)
	key := tenantID + "\x00" + job.ID
	s.generationMu.Lock()
	s.generationCancels[key] = cancel
	s.generationMu.Unlock()
	watchDone := make(chan struct{})
	go s.watchGenerationCancellation(ctx, cancel, watchDone, tenantID, job.ID, job.LeaseOwner)
	activeChildIDs := []string{}
	defer func() {
		close(watchDone)
		if ctx.Err() != nil {
			for _, childID := range activeChildIDs {
				s.cancelWorkflowChildIfParentCancelled(tenantID, job.ID, childID)
			}
		}
		s.generationMu.Lock()
		delete(s.generationCancels, key)
		s.generationMu.Unlock()
		cancel()
	}()

	order, _ := workflowTopologicalOrder(parameters.TemplateSnapshot)
	steps := make(map[string]workflowStep, len(parameters.TemplateSnapshot.Steps))
	for _, step := range parameters.TemplateSnapshot.Steps {
		steps[step.ID] = step
	}
	for _, stepID := range order {
		state := result.Steps[stepID]
		if state.Status == "succeeded" {
			continue
		}
		if state.Status == "failed" || state.Status == "cancelled" || state.Status == "skipped" {
			status, finalResult := finalizeServerWorkflowResult(parameters.TemplateSnapshot, result)
			s.completeWorkflowJob(tenantID, job, status, finalResult, "工作流步骤生成失败")
			return
		}
		step := steps[stepID]
		childIDs, err := s.resolveWorkflowStepChildIDs(ctx, tenantID, job.ID, step, state)
		if err != nil {
			knownIDs := workflowKnownStepChildIDs(job.ID, step, state)
			if ctx.Err() != nil {
				s.cancelWorkflowChildrenIfParentCancelled(tenantID, job.ID, knownIDs)
				return
			}
			if !isPermanentWorkflowChildError(err) {
				return
			}
			s.failClaimedWorkflowStep(tenantID, job, parameters, result, stepID, knownIDs, "工作流子任务解析失败")
			return
		}
		if !sameStringSlice(childIDs, workflowStateChildJobIDs(state)) {
			state = queuedWorkflowStepState(childIDs)
			result.Steps[stepID] = state
			if !s.checkpointWorkflowJob(tenantID, job, result) {
				return
			}
		}
		activeChildIDs = childIDs
		for index, childID := range childIDs {
			if _, err := s.ensureWorkflowChildJob(ctx, tenantID, job, parameters, result, step, childID, index, len(childIDs)); err != nil {
				if ctx.Err() != nil {
					s.cancelWorkflowChildrenIfParentCancelled(tenantID, job.ID, childIDs)
					return
				}
				s.failClaimedWorkflowStep(tenantID, job, parameters, result, stepID, childIDs, "图片子任务创建失败")
				return
			}
		}
		s.notifyGenerationWorkers()
		markedRunning := state.Status == "running"
		children, err := s.waitForWorkflowChildren(ctx, tenantID, job, step.ID, childIDs, func() bool {
			if markedRunning {
				return true
			}
			result.Steps[stepID] = runningWorkflowStepState(childIDs)
			if !s.checkpointWorkflowJob(tenantID, job, result) {
				return false
			}
			markedRunning = true
			return true
		})
		if err != nil {
			if ctx.Err() != nil {
				s.cancelWorkflowChildrenIfParentCancelled(tenantID, job.ID, childIDs)
				return
			}
			if errors.Is(err, errWorkflowRunningCheckpoint) || !isPermanentWorkflowChildError(err) {
				return
			}
			s.failClaimedWorkflowStep(tenantID, job, parameters, result, stepID, childIDs, "图片子任务等待失败")
			return
		}
		result.Steps[stepID] = completeWorkflowStepFromChildren(childIDs, children, step.Parameters.Count)
		activeChildIDs = nil
		if !s.checkpointWorkflowJob(tenantID, job, result) {
			return
		}
		if result.Steps[stepID].Status != "succeeded" {
			status, finalResult := finalizeServerWorkflowResult(parameters.TemplateSnapshot, result)
			s.completeWorkflowJob(tenantID, job, status, finalResult, "工作流步骤生成失败")
			return
		}
	}
	status, finalResult := finalizeServerWorkflowResult(parameters.TemplateSnapshot, result)
	s.completeWorkflowJob(tenantID, job, status, finalResult, "")
}

func workflowKnownStepChildIDs(runID string, step workflowStep, state workflowStepRunState) []string {
	ids := workflowStateChildJobIDs(state)
	if len(ids) > 0 {
		return ids
	}
	if step.Parameters.Count > 1 {
		return []string{serverWorkflowChildSlotJobID(runID, step.ID, 0)}
	}
	return nil
}

func isPermanentWorkflowChildError(err error) bool {
	return errors.Is(err, store.ErrUnauthorized) || errors.Is(err, store.ErrNotFound) ||
		errors.Is(err, errWorkflowChildStatus)
}

func (s *Server) cancelWorkflowChildrenIfParentCancelled(tenantID, parentID string, childIDs []string) {
	for _, childID := range childIDs {
		s.cancelWorkflowChildIfParentCancelled(tenantID, parentID, childID)
	}
}

func (s *Server) failClaimedWorkflowStep(tenantID string, job store.GenerationJob, parameters workflowRunParameters, result workflowRunResult, stepID string, childIDs []string, message string) {
	s.cancelWorkflowChildren(tenantID, job.ID, stepID, childIDs)
	result.Steps[stepID] = failedWorkflowStepState(childIDs, message)
	status, finalResult := finalizeServerWorkflowResult(parameters.TemplateSnapshot, result)
	s.completeWorkflowJob(tenantID, job, status, finalResult, "工作流步骤生成失败")
}

func (s *Server) cancelWorkflowChildIfParentCancelled(tenantID, parentID, childID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	parent, err := s.store.GetGenerationJob(ctx, tenantID, parentID)
	if err != nil || parent.Status != "cancelled" {
		return
	}
	child, err := s.store.GetGenerationJob(ctx, tenantID, childID)
	if err != nil || authMode() != "off" && (parent.UserID == "" || child.UserID != parent.UserID) {
		return
	}
	_, _ = s.cancelServerGenerationJobWithSideEffectLock(ctx, tenantID, childID, time.Now().UTC())
	// Wake the local child worker immediately; cross-instance cancel still relies
	// on lease/status watch, but same-process cancel should not wait a tick.
	s.cancelLocalGeneration(tenantID, childID)
}

func (s *Server) checkpointWorkflowJob(tenantID string, job store.GenerationJob, result workflowRunResult) bool {
	value, err := json.Marshal(result)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = s.store.CheckpointServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, value, time.Now().UTC())
	return err == nil
}

func (s *Server) completeWorkflowJob(tenantID string, job store.GenerationJob, status string, result workflowRunResult, message string) {
	if status != "succeeded" && status != "failed" && status != "cancelled" {
		status = "failed"
		message = "工作流执行失败"
	}
	value, _ := json.Marshal(result)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.store.CompleteServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner,
		status, value, message, time.Now().UTC())
	if err != nil && !errors.Is(err, store.ErrConflict) {
		log.Printf("complete workflow job %s/%s: %v", tenantID, job.ID, err)
	}
}

func queuedWorkflowStepState(childIDs []string) workflowStepRunState {
	state := workflowStepRunState{Status: "queued", ChildJobIDs: append([]string(nil), childIDs...)}
	if len(childIDs) > 0 {
		state.ChildJobID = childIDs[0]
	}
	return state
}

func runningWorkflowStepState(childIDs []string) workflowStepRunState {
	state := queuedWorkflowStepState(childIDs)
	state.Status = "running"
	return state
}

func failedWorkflowStepState(childIDs []string, message string) workflowStepRunState {
	state := queuedWorkflowStepState(childIDs)
	state.Status = "failed"
	state.Error = message
	return state
}

func completeWorkflowStepFromChildren(childIDs []string, children []store.GenerationJob, expectedCount int) workflowStepRunState {
	state := queuedWorkflowStepState(childIDs)
	keys := make([]string, 0, len(children))
	cancelled := false
	failed := false
	for _, child := range children {
		switch child.Status {
		case "succeeded":
			itemKeys, err := imageResultStorageKeys(child.Result)
			if err != nil {
				failed = true
				continue
			}
			keys = append(keys, itemKeys...)
		case "cancelled":
			cancelled = true
		default:
			failed = true
		}
	}
	if failed {
		state.Status = "failed"
		state.Error = "图片生成失败"
		return state
	}
	if cancelled {
		state.Status = "cancelled"
		state.Error = "已取消"
		return state
	}
	if expectedCount < 1 {
		expectedCount = 1
	}
	if len(keys) != expectedCount {
		state.Status = "failed"
		state.Error = "图片生成失败"
		return state
	}
	state.Status = "succeeded"
	state.StorageKeys = keys
	return state
}

func (s *Server) waitForWorkflowChildren(ctx context.Context, tenantID string, parent store.GenerationJob,
	stepID string, childIDs []string, markRunning func() bool) ([]store.GenerationJob, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		children := make([]store.GenerationJob, 0, len(childIDs))
		pending := false
		terminalFailure := false
		for _, childID := range childIDs {
			child, err := s.store.GetGenerationJob(ctx, tenantID, childID)
			if err != nil {
				return nil, err
			}
			if authMode() != "off" && (parent.UserID == "" || child.UserID != parent.UserID) {
				return nil, store.ErrUnauthorized
			}
			switch child.Status {
			case "queued", "running":
				pending = true
				if child.Status == "running" && !markRunning() {
					return nil, errWorkflowRunningCheckpoint
				}
			case "failed", "cancelled", "deleted":
				terminalFailure = true
			case "succeeded":
			default:
				return nil, errWorkflowChildStatus
			}
			children = append(children, child)
		}
		if terminalFailure && pending {
			s.cancelWorkflowChildren(tenantID, parent.ID, stepID, childIDs)
		}
		if !pending {
			return children, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func workflowChildPersistedCount(job store.GenerationJob) int {
	var parameters persistedImageJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Count < 1 {
		return 0
	}
	return parameters.Count
}

func (s *Server) resolveWorkflowStepChildIDs(ctx context.Context, tenantID, runID string, step workflowStep, state workflowStepRunState) ([]string, error) {
	ids := workflowStateChildJobIDs(state)
	if len(ids) == 0 {
		if step.Parameters.Count <= 1 {
			return workflowStepChildSlotIDs(runID, step.ID, step.Parameters.Count), nil
		}
		slot0 := serverWorkflowChildSlotJobID(runID, step.ID, 0)
		existing, err := s.store.GetGenerationJob(ctx, tenantID, slot0)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return workflowStepChildSlotIDs(runID, step.ID, step.Parameters.Count), nil
			}
			return nil, err
		}
		if workflowChildPersistedCount(existing) > 1 {
			return []string{slot0}, nil
		}
		return workflowStepChildSlotIDs(runID, step.ID, step.Parameters.Count), nil
	}
	if len(ids) != 1 || step.Parameters.Count <= 1 {
		return ids, nil
	}
	existing, err := s.store.GetGenerationJob(ctx, tenantID, ids[0])
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return workflowStepChildSlotIDs(runID, step.ID, step.Parameters.Count), nil
		}
		return nil, err
	}
	if workflowChildPersistedCount(existing) == 1 {
		return workflowStepChildSlotIDs(runID, step.ID, step.Parameters.Count), nil
	}
	return ids, nil
}

func (s *Server) cancelWorkflowChildren(tenantID, parentID, stepID string, childIDs []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, childID := range childIDs {
		existing, err := s.store.GetGenerationJob(ctx, tenantID, childID)
		if err != nil || !isResumableWorkflowChild(existing, parentID, stepID) {
			continue
		}
		_, _ = s.cancelServerGenerationJobWithSideEffectLock(ctx, tenantID, childID, time.Now().UTC())
		s.cancelLocalGeneration(tenantID, childID)
	}
}

func (s *Server) ensureWorkflowChildJob(ctx context.Context, tenantID string, parent store.GenerationJob,
	parameters workflowRunParameters, result workflowRunResult, step workflowStep, childID string, slot, total int) (store.GenerationJob, error) {
	prompt, err := compileServerWorkflowPrompt(step, parameters.Values)
	if err != nil {
		return store.GenerationJob{}, err
	}
	references, err := workflowStepReferenceKeys(step, parameters.Values, result)
	if err != nil {
		return store.GenerationJob{}, err
	}
	providerID, model, err := s.workflowStepProvider(ctx, tenantID, parent.UserID, step)
	if err != nil {
		return store.GenerationJob{}, err
	}
	if total < 1 {
		total = 1
	}
	imageCount := 1
	requestedCount := total
	batchID := ""
	batchIndex := 0
	if total == 1 && step.Parameters.Count > 1 {
		imageCount = step.Parameters.Count
		requestedCount = 0
	} else if total > 1 {
		batchID = workflowChildBatchID(parent.ID, step.ID)
		batchIndex = slot + 1
	}
	request := createImageJobRequest{
		ID: childID, ProjectID: parent.ProjectID, Prompt: prompt, ProviderID: providerID, Model: model,
		Parameters: createImageJobParameters{
			Size: step.Parameters.Size, Quality: step.Parameters.Quality, Count: imageCount,
			RequestedCount: requestedCount, BatchID: batchID, BatchIndex: batchIndex,
			TransparentBackground: step.Parameters.TransparentBackground, ReferenceStorageKeys: references,
		},
	}
	requestHash, _ := hashImageJobRequest(request)
	if existing, err := s.store.GetGenerationJob(ctx, tenantID, childID); err == nil {
		if authMode() != "off" && (parent.UserID == "" || existing.UserID != parent.UserID) ||
			!isResumableWorkflowChild(existing, parent.ID, step.ID) ||
			workflowChildPersistedCount(existing) != imageCount {
			return store.GenerationJob{}, store.ErrConflict
		}
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.GenerationJob{}, err
	}
	childParameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash, Size: step.Parameters.Size,
		Quality: step.Parameters.Quality, Count: imageCount, RequestedCount: requestedCount, BatchID: batchID, BatchIndex: batchIndex,
		TransparentBackground: step.Parameters.TransparentBackground, ReferenceStorageKeys: references,
		WorkflowRunID: parent.ID, WorkflowStepID: step.ID,
	})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	billingUserID := strings.TrimSpace(parent.UserID)
	if authMode() != "off" && (billingUserID == "" || (parameters.BillingUserID != "" && parameters.BillingUserID != billingUserID)) {
		return store.GenerationJob{}, store.ErrUnauthorized
	}
	child := store.GenerationJob{
		ID: childID, UserID: billingUserID, ProjectID: parent.ProjectID, Kind: "image", Status: "queued", Prompt: prompt,
		ProviderID: providerID, Model: model, Parameters: childParameters, Result: json.RawMessage(`{}`),
		CreatedAt: now, UpdatedAt: now,
	}
	meta, _ := json.Marshal(map[string]any{"jobId": child.ID, "kind": child.Kind, "workflowRunId": parent.ID, "workflowStepId": step.ID})
	if err := s.store.CreateServerGenerationJob(ctx, tenantID, billingUserID, child, imageCount, meta); errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(ctx, tenantID, childID)
		if getErr == nil && (authMode() == "off" || existing.UserID == billingUserID) && isResumableWorkflowChild(existing, parent.ID, step.ID) &&
			workflowChildPersistedCount(existing) == imageCount {
			return existing, nil
		}
		return store.GenerationJob{}, store.ErrConflict
	} else if err != nil {
		return store.GenerationJob{}, err
	}
	return child, nil
}

func isResumableWorkflowChild(job store.GenerationJob, parentID, stepID string) bool {
	var parameters persistedImageJobParameters
	return job.Kind == "image" && json.Unmarshal(job.Parameters, &parameters) == nil &&
		parameters.Executor == serverExecutorMarker &&
		parameters.WorkflowRunID == parentID && parameters.WorkflowStepID == stepID
}

func isMatchingWorkflowChild(job store.GenerationJob, requestHash, parentID, stepID string) bool {
	var parameters persistedImageJobParameters
	return isResumableWorkflowChild(job, parentID, stepID) &&
		json.Unmarshal(job.Parameters, &parameters) == nil && parameters.RequestHash == requestHash
}

func workflowChildJobIDs(value json.RawMessage) []string {
	var result workflowRunResult
	if json.Unmarshal(value, &result) != nil {
		return nil
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, len(result.Steps))
	for _, state := range result.Steps {
		for _, childID := range workflowStateChildJobIDs(state) {
			if _, exists := seen[childID]; exists {
				continue
			}
			seen[childID] = struct{}{}
			ids = append(ids, childID)
		}
	}
	return ids
}

func (s *Server) workflowStepProvider(ctx context.Context, tenantID, userID string, step workflowStep) (string, string, error) {
	config, exists, err := s.loadGenerationConfig(ctx, tenantID, userID)
	if err != nil {
		return "", "", err
	}
	if !exists || len(config.Channels) == 0 {
		return "", "", errors.New("invalid image config")
	}
	providerID := step.ProviderID
	if providerID == "" {
		providerID = config.ActiveChannelID
	}
	if providerID == "" {
		providerID = config.Channels[0].ID
	}
	for _, channel := range config.Channels {
		if channel.ID != providerID {
			continue
		}
		model := step.Model
		if model == "" {
			if provider, ok := channel.Providers["image"]; ok {
				model = provider.Model
			}
			if model == "" {
				model = channel.DefaultImageModel
			}
		}
		if model == "" {
			return "", "", errors.New("workflow image model missing")
		}
		return providerID, model, nil
	}
	return "", "", errors.New("workflow image channel missing")
}

func imageResultStorageKeys(value json.RawMessage) ([]string, error) {
	var result struct {
		Items []generationResultItem `json:"items"`
	}
	if json.Unmarshal(value, &result) != nil || len(result.Items) < 1 || len(result.Items) > maxImageGenerationCount {
		return nil, errors.New("invalid image child result")
	}
	keys := make([]string, 0, len(result.Items))
	for _, item := range result.Items {
		if _, ok := blobFilename(item.StorageKey); !ok {
			return nil, errors.New("invalid image child storage key")
		}
		keys = append(keys, item.StorageKey)
	}
	return keys, nil
}

func workflowChildBatchID(runID, stepID string) string {
	id := serverWorkflowChildJobID(runID, "batch-"+stepID)
	if strings.HasPrefix(id, "wf_") {
		return "wb_" + strings.TrimPrefix(id, "wf_")
	}
	return id
}

func workflowStepChildSlotIDs(runID, stepID string, count int) []string {
	if count < 1 {
		count = 1
	}
	if count > maxImageGenerationCount {
		count = maxImageGenerationCount
	}
	ids := make([]string, count)
	for index := 0; index < count; index++ {
		ids[index] = serverWorkflowChildSlotJobID(runID, stepID, index)
	}
	return ids
}

func serverWorkflowChildSlotJobID(runID, stepID string, index int) string {
	if index > 0 {
		return serverWorkflowChildJobID(runID, fmt.Sprintf("%s:%d", stepID, index))
	}
	return serverWorkflowChildJobID(runID, stepID)
}

func serverWorkflowChildJobID(runID, stepID string) string {
	safe := func(value string) string {
		var builder strings.Builder
		for _, character := range value {
			if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
				(character >= '0' && character <= '9') || character == '_' || character == '-' {
				builder.WriteRune(character)
			} else {
				builder.WriteByte('_')
			}
			if builder.Len() == 40 {
				break
			}
		}
		return builder.String()
	}
	hash := func(seed uint32) string {
		value := seed
		for _, character := range []byte(runID + "\x00" + stepID) {
			value ^= uint32(character)
			value *= 0x01000193
		}
		return fmt.Sprintf("%08x", value)
	}
	id := fmt.Sprintf("wf_%s_%s_%s%s", safe(runID), safe(stepID), hash(0x811c9dc5), hash(0x9e3779b9))
	if len(id) > 128 {
		return id[:128]
	}
	return id
}
