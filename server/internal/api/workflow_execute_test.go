package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func postWorkflowRun(t *testing.T, handler http.Handler, id string) *responseSnapshot {
	t.Helper()
	var template any
	if err := json.Unmarshal([]byte(validPersonalWorkflowTemplate), &template); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"id": id, "projectId": "board-1", "templateSnapshot": template,
		"values": map[string]any{"subject": "一只纸雕老虎"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/workflow", body)
	return &responseSnapshot{code: got.Code, body: append([]byte(nil), got.Body.Bytes()...)}
}

func waitForJobStatus(t *testing.T, backend *memoryStore, id, status string) store.GenerationJob {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, id)
		if err == nil && job.Status == status {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, id)
	t.Fatalf("job %s did not reach %s: %#v %v", id, status, job, err)
	return store.GenerationJob{}
}

func TestServerWorkflowPersistsEachStepAndImageHistory(t *testing.T) {
	executor := newScriptedImageExecutor()
	_, backend, handler := imageExecutionHandler(t, executor)
	created := postWorkflowRun(t, handler, "workflow_server_story")
	if created.code != http.StatusAccepted {
		t.Fatalf("create workflow: %d %s", created.code, created.body)
	}
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	first := awaitExecutorStart(t, executor)
	if first.Prompt != "be concise\n\n一只纸雕老虎 主图" {
		t.Fatalf("first prompt = %q", first.Prompt)
	}
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	second := awaitExecutorStart(t, executor)
	if second.Prompt != "be concise\n\n一只纸雕老虎 场景" || len(second.References) != 1 {
		t.Fatalf("second request = %#v", second)
	}
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	parent := waitForJobStatus(t, backend, "workflow_server_story", "succeeded")
	var result workflowRunResult
	if err := json.Unmarshal(parent.Result, &result); err != nil || len(result.OutputStorageKeys) != 1 ||
		result.Steps["base"].Status != "succeeded" || result.Steps["scene"].Status != "succeeded" {
		t.Fatalf("workflow result = %s, %v", parent.Result, err)
	}
	page, err := backend.ListGenerationJobs(t.Context(), store.DefaultTenantID, store.GenerationJobQuery{Kind: "image", Page: 1, PageSize: 10})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("child image history = %#v, %v", page, err)
	}
}

func TestPublicWorkflowJobHidesBillingUserID(t *testing.T) {
	parameters, err := json.Marshal(workflowRunParameters{
		Executor: "workflow", BillingUserID: "user-private", RequestHash: "0123456789abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}
	public := publicGenerationJob(store.GenerationJob{Kind: "workflow", Parameters: parameters})
	if strings.Contains(string(public.Parameters), "user-private") || strings.Contains(string(public.Parameters), "billingUserId") {
		t.Fatalf("public workflow parameters leaked billing identity: %s", public.Parameters)
	}
}

func TestServerWorkflowCancellationCascadesToRunningChild(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	created := postWorkflowRun(t, handler, "workflow_cancel_story")
	if created.code != http.StatusAccepted {
		t.Fatalf("create workflow: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	cancelled := request(t, handler, http.MethodPost, "/api/generation-jobs/workflow_cancel_story/cancel", nil)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("cancel workflow: %d %s", cancelled.Code, cancelled.Body.String())
	}
	select {
	case <-executor.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("workflow cancellation did not cancel the image child")
	}
	server.generationWG.Wait()
	parent := waitForJobStatus(t, backend, "workflow_cancel_story", "cancelled")
	var result workflowRunResult
	if json.Unmarshal(parent.Result, &result) != nil {
		t.Fatalf("cancelled workflow result = %s", parent.Result)
	}
	for id, state := range result.Steps {
		if state.Status == "pending" || state.Status == "queued" || state.Status == "running" {
			t.Fatalf("step %s remained active after cancellation: %#v", id, state)
		}
	}
	childID := serverWorkflowChildJobID(parent.ID, "base")
	child, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, childID)
	if err != nil || child.Status != "cancelled" {
		t.Fatalf("child was not synchronously cancelled: %#v, %v", child, err)
	}
	if deleted := request(t, handler, http.MethodDelete, "/api/generation-jobs/"+parent.ID, nil); deleted.Code != http.StatusNoContent {
		t.Fatalf("delete cancelled workflow: %d %s", deleted.Code, deleted.Body.String())
	}
}

func TestGenericGenerationEndpointRejectsForgedWorkflowDocuments(t *testing.T) {
	handler := persistentHandler(t)
	body := []byte(`{
      "id":"forged_workflow","kind":"workflow","status":"failed","prompt":"forged",
      "parameters":{"executor":"workflow"},"result":{},
      "createdAt":"2026-07-24T00:00:00Z","updatedAt":"2026-07-24T00:00:00Z"
    }`)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs", body); got.Code != http.StatusBadRequest {
		t.Fatalf("forged workflow status = %d %s", got.Code, got.Body.String())
	}
}

func TestWorkflowChildIdentityMatchesBrowserContract(t *testing.T) {
	if got := serverWorkflowChildJobID("workflow_server_story", "base"); got != "wf_workflow_server_story_base_5ae5a2896402cacd" {
		t.Fatalf("child id = %s", got)
	}
	if got := serverWorkflowChildJobID("workflow_server_story", "scene"); got != "wf_workflow_server_story_scene_41a06e742e5c5e30" {
		t.Fatalf("child id = %s", got)
	}
	if got := serverWorkflowChildSlotJobID("workflow_server_story", "base", 0); got != "wf_workflow_server_story_base_5ae5a2896402cacd" {
		t.Fatalf("first slot id changed: %s", got)
	}
	second := serverWorkflowChildSlotJobID("workflow_server_story", "base", 1)
	if second == serverWorkflowChildJobID("workflow_server_story", "base") || !strings.HasPrefix(second, "wf_") {
		t.Fatalf("second slot id = %s", second)
	}
}

func TestServerWorkflowFansOutStepCountAsSingleImageJobs(t *testing.T) {
	executor := newScriptedImageExecutor()
	_, backend, handler := imageExecutionHandler(t, executor)
	var template map[string]any
	if err := json.Unmarshal([]byte(validPersonalWorkflowTemplate), &template); err != nil {
		t.Fatal(err)
	}
	steps, _ := template["steps"].([]any)
	base, _ := steps[0].(map[string]any)
	parameters, _ := base["parameters"].(map[string]any)
	parameters["count"] = 2
	body, err := json.Marshal(map[string]any{
		"id": "workflow_count_two", "projectId": "board-1", "templateSnapshot": template,
		"values": map[string]any{"subject": "一只纸雕老虎"},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := request(t, handler, http.MethodPost, "/api/generation-jobs/workflow", body)
	if created.Code != http.StatusAccepted {
		t.Fatalf("create workflow: %d %s", created.Code, created.Body.String())
	}
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	counts := make([]int, 0, 2)
	for range 2 {
		request := awaitExecutorStart(t, executor)
		counts = append(counts, request.Count)
		executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	}
	if counts[0] != 1 || counts[1] != 1 {
		t.Fatalf("slot counts = %#v, want 1 1", counts)
	}
	third := awaitExecutorStart(t, executor)
	if third.Count != 1 || len(third.References) != 1 {
		t.Fatalf("scene request = %#v", third)
	}
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	parent := waitForJobStatus(t, backend, "workflow_count_two", "succeeded")
	var result workflowRunResult
	if err := json.Unmarshal(parent.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Steps["base"].Status != "succeeded" || len(result.Steps["base"].StorageKeys) != 2 ||
		len(result.Steps["base"].ChildJobIDs) != 2 {
		t.Fatalf("base step = %#v", result.Steps["base"])
	}
	page, err := backend.ListGenerationJobs(t.Context(), store.DefaultTenantID, store.GenerationJobQuery{Kind: "image", Page: 1, PageSize: 10})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("child image history = %#v, %v", page, err)
	}
}

func TestResolveWorkflowStepChildIDsKeepsLegacyCountNJob(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	childID := serverWorkflowChildJobID("workflow_legacy", "base")
	parameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, Size: "1024x1024", Count: 2,
		WorkflowRunID: "workflow_legacy", WorkflowStepID: "base",
	})
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, store.GenerationJob{
		ID: childID, Kind: "image", Status: "queued", Prompt: "legacy", Parameters: parameters,
		Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	ids, err := server.resolveWorkflowStepChildIDs(t.Context(), store.DefaultTenantID, "workflow_legacy",
		workflowStep{ID: "base", Parameters: workflowStepParameters{Count: 2}},
		workflowStepRunState{Status: "queued", ChildJobID: childID})
	if err != nil || len(ids) != 1 || ids[0] != childID {
		t.Fatalf("legacy ids = %#v, %v", ids, err)
	}
	missing, err := server.resolveWorkflowStepChildIDs(t.Context(), store.DefaultTenantID, "workflow_legacy",
		workflowStep{ID: "gone", Parameters: workflowStepParameters{Count: 2}},
		workflowStepRunState{Status: "queued", ChildJobID: "wf_missing_child"})
	if err != nil || len(missing) != 2 {
		t.Fatalf("missing child should expand to n=1 slots: %#v, %v", missing, err)
	}

	n1, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, Size: "1024x1024", Count: 1,
		WorkflowRunID: "workflow_legacy", WorkflowStepID: "scene",
	})
	slot0 := serverWorkflowChildSlotJobID("workflow_legacy", "scene", 0)
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, store.GenerationJob{
		ID: slot0, Kind: "image", Status: "queued", Prompt: "slot", Parameters: n1,
		Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	expanded, err := server.resolveWorkflowStepChildIDs(t.Context(), store.DefaultTenantID, "workflow_legacy",
		workflowStep{ID: "scene", Parameters: workflowStepParameters{Count: 2}},
		workflowStepRunState{Status: "queued", ChildJobID: slot0})
	if err != nil || len(expanded) != 2 || expanded[0] != slot0 {
		t.Fatalf("expanded ids = %#v, %v", expanded, err)
	}

	legacySlot0 := serverWorkflowChildSlotJobID("workflow_legacy", "pending", 0)
	legacyParams, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, Size: "1024x1024", Count: 2,
		WorkflowRunID: "workflow_legacy", WorkflowStepID: "pending",
	})
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, store.GenerationJob{
		ID: legacySlot0, Kind: "image", Status: "queued", Prompt: "pending-legacy", Parameters: legacyParams,
		Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	kept, err := server.resolveWorkflowStepChildIDs(t.Context(), store.DefaultTenantID, "workflow_legacy",
		workflowStep{ID: "pending", Parameters: workflowStepParameters{Count: 2}},
		workflowStepRunState{Status: "pending"})
	if err != nil || len(kept) != 1 || kept[0] != legacySlot0 {
		t.Fatalf("pending leftover Count=N should stay one job: %#v, %v", kept, err)
	}
}

func TestServerWorkflowFailsWhenChildStatusIsInvalid(t *testing.T) {
	executor := newScriptedImageExecutor()
	_, backend, handler := imageExecutionHandler(t, executor)
	created := postWorkflowRun(t, handler, "workflow_invalid_child")
	if created.code != http.StatusAccepted {
		t.Fatalf("create workflow: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	childID := serverWorkflowChildJobID("workflow_invalid_child", "base")
	backend.mu.Lock()
	key := tenantKey(store.DefaultTenantID, childID)
	job := backend.jobs[key]
	job.Status = "paused"
	backend.jobs[key] = job
	backend.mu.Unlock()
	parent := waitForJobStatus(t, backend, "workflow_invalid_child", "failed")
	var result workflowRunResult
	if err := json.Unmarshal(parent.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Steps["base"].Status != "failed" {
		t.Fatalf("base step = %#v", result.Steps["base"])
	}
}

func TestFinalizeServerWorkflowResultMarksMixedSuccessAndCancelAsCancelled(t *testing.T) {
	template := workflowTemplate{
		Steps: []workflowStep{
			{ID: "base"},
			{ID: "detail", References: []workflowStepReference{{Source: "step", StepID: "base"}}},
			{ID: "alternate", References: []workflowStepReference{{Source: "step", StepID: "base"}}},
			{ID: "final", References: []workflowStepReference{
				{Source: "step", StepID: "detail"},
				{Source: "step", StepID: "alternate"},
			}},
		},
	}
	result := workflowRunResult{
		Steps: map[string]workflowStepRunState{
			"base":      {Status: "succeeded", StorageKeys: []string{"image:base"}},
			"detail":    {Status: "cancelled", Error: "已取消"},
			"alternate": {Status: "succeeded", StorageKeys: []string{"image:alt"}},
			"final":     {Status: "pending"},
		},
	}
	status, final := finalizeServerWorkflowResult(template, result)
	if status != "cancelled" {
		t.Fatalf("status = %s, want cancelled", status)
	}
	if final.Steps["final"].Status != "skipped" {
		t.Fatalf("final step = %#v", final.Steps["final"])
	}
	if len(final.OutputStorageKeys) != 0 {
		t.Fatalf("cancelled run leaked outputs: %#v", final.OutputStorageKeys)
	}
	if got := final.Steps["alternate"].StorageKeys; len(got) != 1 || got[0] != "image:alt" {
		t.Fatalf("alternate keys = %#v", got)
	}

	allSucceeded := workflowRunResult{Steps: map[string]workflowStepRunState{
		"base":      {Status: "succeeded", StorageKeys: []string{"image:base"}},
		"detail":    {Status: "succeeded", StorageKeys: []string{"image:detail"}},
		"alternate": {Status: "succeeded", StorageKeys: []string{"image:alt"}},
		"final":     {Status: "succeeded", StorageKeys: []string{"image:final"}},
	}}
	if status, _ := finalizeServerWorkflowResult(template, allSucceeded); status != "succeeded" {
		t.Fatalf("all succeeded status = %s", status)
	}
}

func TestWorkflowResultAcceptsLeafOutputsAboveLegacy64Cap(t *testing.T) {
	keys := make([]string, 65)
	for index := range keys {
		keys[index] = fmt.Sprintf("image:out-%02d", index)
	}
	var template workflowTemplate
	if err := json.Unmarshal([]byte(validPersonalWorkflowTemplate), &template); err != nil {
		t.Fatal(err)
	}
	parameters, err := json.Marshal(workflowRunParameters{
		Executor: workflowExecutorMarker, RequestHash: "0123456789abcdef",
		TemplateID: template.ID, TemplateRevision: template.Revision, TemplateSnapshot: template,
		Values: map[string]json.RawMessage{"subject": json.RawMessage(`"tiger"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(workflowRunResult{
		Steps: map[string]workflowStepRunState{
			"base":  {Status: "succeeded", ChildJobID: "wf_child_base", StorageKeys: keys[:1]},
			"scene": {Status: "succeeded", ChildJobID: "wf_child_scene", StorageKeys: keys},
		},
		OutputStorageKeys: keys,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = validatePersistedWorkflowJob(store.GenerationJob{
		Kind: "workflow", Parameters: parameters, Result: result,
	})
	if err != nil {
		t.Fatalf("65 output keys rejected: %v", err)
	}
}

func TestGenerationClaimsAreIsolatedAndCheckpointsRequireLeaseOwner(t *testing.T) {
	backend := newMemoryStore()
	now := time.Now().UTC()
	seed := func(id, kind, executor string) {
		parameters, _ := json.Marshal(map[string]any{"executor": executor})
		if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, store.GenerationJob{
			ID: id, Kind: kind, Status: "queued", Prompt: id, Parameters: parameters,
			Result: json.RawMessage(`{}`), CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
		}); err != nil {
			t.Fatal(err)
		}
	}
	seed("claim_image", "image", "server")
	seed("claim_video", "video", "server")
	seed("claim_audio", "audio", "server")
	seed("claim_workflow", "workflow", "workflow")
	image, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "image", Executor: "server"},
		"image-owner", now, now.Add(time.Minute))
	if err != nil || image.Job.ID != "claim_image" {
		t.Fatalf("image claim = %#v, %v", image, err)
	}
	video, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "video", Executor: "server"},
		"video-owner", now, now.Add(time.Minute))
	if err != nil || video.Job.ID != "claim_video" {
		t.Fatalf("video claim = %#v, %v", video, err)
	}
	audio, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "audio", Executor: "server"},
		"audio-owner", now, now.Add(time.Minute))
	if err != nil || audio.Job.ID != "claim_audio" {
		t.Fatalf("audio claim = %#v, %v", audio, err)
	}
	workflow, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "workflow", Executor: "workflow"},
		"workflow-owner", now, now.Add(time.Minute))
	if err != nil || workflow.Job.ID != "claim_workflow" {
		t.Fatalf("workflow claim = %#v, %v", workflow, err)
	}
	if _, err := backend.CheckpointServerGenerationJob(t.Context(), store.DefaultTenantID, workflow.Job.ID,
		"stale-owner", json.RawMessage(`{"steps":{}}`), now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale checkpoint error = %v", err)
	}
}

func TestWorkflowShutdownPreservesChildAndExpiredLeasesRecover(t *testing.T) {
	firstExecutor := newScriptedImageExecutor()
	firstServer, backend, handler := imageExecutionHandler(t, firstExecutor)
	created := postWorkflowRun(t, handler, "workflow_restart_story")
	if created.code != http.StatusAccepted {
		t.Fatalf("create workflow: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, firstExecutor)
	firstServer.Close()

	parent, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, "workflow_restart_story")
	if err != nil || parent.Status != "running" {
		t.Fatalf("parent after shutdown = %#v, %v", parent, err)
	}
	baseChildID := serverWorkflowChildJobID(parent.ID, "base")
	child, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, baseChildID)
	if err != nil || child.Status != "running" {
		t.Fatalf("child after shutdown = %#v, %v", child, err)
	}

	backend.mu.Lock()
	for _, id := range []string{parent.ID, baseChildID} {
		key := tenantKey(store.DefaultTenantID, id)
		job := backend.jobs[key]
		job.LeaseExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
		backend.jobs[key] = job
	}
	backend.mu.Unlock()

	secondExecutor := newScriptedImageExecutor()
	secondServer := NewServerWithStore(t.TempDir(), backend)
	secondServer.SetProcessToken("test-token")
	secondServer.imageExecutor = secondExecutor
	if err := secondServer.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondServer.Close)
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	_ = awaitExecutorStart(t, secondExecutor)
	secondExecutor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	_ = awaitExecutorStart(t, secondExecutor)
	secondExecutor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	_ = waitForJobStatus(t, backend, parent.ID, "succeeded")
}
