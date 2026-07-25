package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
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
