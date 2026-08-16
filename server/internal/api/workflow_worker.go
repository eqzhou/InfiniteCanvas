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
		len(result.Steps) != len(parameters.TemplateSnapshot.Steps) || len(result.OutputStorageKeys) > 64 {
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

func validWorkflowStepState(state workflowStepRunState) bool {
	switch state.Status {
	case "pending", "skipped":
		return state.ChildJobID == "" && len(state.StorageKeys) == 0 && len(state.Error) <= 10_000
	case "queued", "running":
		return workflowIDPattern.MatchString(state.ChildJobID) && len(state.StorageKeys) == 0 && len(state.Error) <= 10_000
	case "succeeded":
		if len(state.StorageKeys) < 1 || len(state.StorageKeys) > 8 || len(state.Error) > 10_000 {
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
	activeChildID := ""
	defer func() {
		close(watchDone)
		if activeChildID != "" && ctx.Err() != nil {
			s.cancelWorkflowChildIfParentCancelled(tenantID, job.ID, activeChildID)
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
		childID := state.ChildJobID
		if childID == "" {
			childID = serverWorkflowChildJobID(job.ID, step.ID)
			state = workflowStepRunState{Status: "queued", ChildJobID: childID}
			result.Steps[stepID] = state
			if !s.checkpointWorkflowJob(tenantID, job, result) {
				return
			}
		}
		activeChildID = childID
		child, err := s.ensureWorkflowChildJob(ctx, tenantID, job, parameters, result, step, childID)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			result.Steps[stepID] = workflowStepRunState{Status: "failed", ChildJobID: childID, Error: "图片子任务创建失败"}
			status, finalResult := finalizeServerWorkflowResult(parameters.TemplateSnapshot, result)
			s.completeWorkflowJob(tenantID, job, status, finalResult, "工作流步骤生成失败")
			return
		}
		s.notifyGenerationWorkers()
		markedRunning := state.Status == "running"
		for {
			if ctx.Err() != nil {
				s.cancelWorkflowChildIfParentCancelled(tenantID, job.ID, childID)
				return
			}
			child, err = s.store.GetGenerationJob(ctx, tenantID, childID)
			if err != nil {
				return
			}
			if authMode() != "off" && (job.UserID == "" || child.UserID != job.UserID) {
				return
			}
			switch child.Status {
			case "queued", "running":
				if child.Status == "running" && !markedRunning {
					result.Steps[stepID] = workflowStepRunState{Status: "running", ChildJobID: childID}
					if !s.checkpointWorkflowJob(tenantID, job, result) {
						return
					}
					markedRunning = true
				}
				select {
				case <-ctx.Done():
				case <-time.After(100 * time.Millisecond):
				}
				continue
			case "succeeded":
				keys, err := imageResultStorageKeys(child.Result)
				if err != nil {
					result.Steps[stepID] = workflowStepRunState{Status: "failed", ChildJobID: childID, Error: "图片子任务结果无效"}
				} else {
					result.Steps[stepID] = workflowStepRunState{Status: "succeeded", ChildJobID: childID, StorageKeys: keys}
				}
			case "cancelled":
				result.Steps[stepID] = workflowStepRunState{Status: "cancelled", ChildJobID: childID, Error: "已取消"}
			case "failed":
				result.Steps[stepID] = workflowStepRunState{Status: "failed", ChildJobID: childID, Error: "图片生成失败"}
			default:
				return
			}
			break
		}
		activeChildID = ""
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

func (s *Server) ensureWorkflowChildJob(ctx context.Context, tenantID string, parent store.GenerationJob,
	parameters workflowRunParameters, result workflowRunResult, step workflowStep, childID string) (store.GenerationJob, error) {
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
	request := createImageJobRequest{
		ID: childID, ProjectID: parent.ProjectID, Prompt: prompt, ProviderID: providerID, Model: model,
		Parameters: createImageJobParameters{
			Size: step.Parameters.Size, Quality: step.Parameters.Quality, Count: step.Parameters.Count,
			TransparentBackground: step.Parameters.TransparentBackground, ReferenceStorageKeys: references,
		},
	}
	requestHash, _ := hashImageJobRequest(request)
	if existing, err := s.store.GetGenerationJob(ctx, tenantID, childID); err == nil {
		if authMode() != "off" && (parent.UserID == "" || existing.UserID != parent.UserID) ||
			!isMatchingWorkflowChild(existing, requestHash, parent.ID, step.ID) {
			return store.GenerationJob{}, store.ErrConflict
		}
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.GenerationJob{}, err
	}
	childParameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash, Size: step.Parameters.Size,
		Quality: step.Parameters.Quality, Count: step.Parameters.Count,
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
	if err := s.store.CreateServerGenerationJob(ctx, tenantID, billingUserID, child, step.Parameters.Count, meta); errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(ctx, tenantID, childID)
		if getErr == nil && (authMode() == "off" || existing.UserID == billingUserID) && isMatchingWorkflowChild(existing, requestHash, parent.ID, step.ID) {
			return existing, nil
		}
		return store.GenerationJob{}, store.ErrConflict
	} else if err != nil {
		return store.GenerationJob{}, err
	}
	return child, nil
}

func isMatchingWorkflowChild(job store.GenerationJob, requestHash, parentID, stepID string) bool {
	var parameters persistedImageJobParameters
	return job.Kind == "image" && json.Unmarshal(job.Parameters, &parameters) == nil &&
		parameters.Executor == serverExecutorMarker && parameters.RequestHash == requestHash &&
		parameters.WorkflowRunID == parentID && parameters.WorkflowStepID == stepID
}

func workflowChildJobIDs(value json.RawMessage) []string {
	var result workflowRunResult
	if json.Unmarshal(value, &result) != nil {
		return nil
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, len(result.Steps))
	for _, state := range result.Steps {
		if state.ChildJobID == "" {
			continue
		}
		if _, exists := seen[state.ChildJobID]; exists {
			continue
		}
		seen[state.ChildJobID] = struct{}{}
		ids = append(ids, state.ChildJobID)
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
	if json.Unmarshal(value, &result) != nil || len(result.Items) < 1 || len(result.Items) > 8 {
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
