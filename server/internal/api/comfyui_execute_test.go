package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func comfyImageManifest(t *testing.T, endpoint string) localWorkflowManifest {
	t.Helper()
	raw := strings.Replace(validLocalWorkflowManifest, `"endpoint":"http://127.0.0.1:8188"`, `"endpoint":"`+endpoint+`"`, 1)
	raw = strings.Replace(raw, `"businessMode":"first_frame_to_video"`, `"businessMode":"text_to_image"`, 1)
	raw = strings.Replace(raw, `{"id":"load","type":"LoadImage","inputs":{"image":"${references}"}},`, "", 1)
	raw = strings.Replace(raw, `"type":"SaveVideo"`, `"type":"SaveImage"`, 1)
	manifest, err := decodeLocalWorkflowManifest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

type comfyFixture struct {
	server      *httptest.Server
	mu          sync.Mutex
	submits     int
	historyGets int
	queueDelete int
	interrupts  int
	promptBody  map[string]any
	history     string
	output      []byte
	viewType    string
}

func newComfyFixture(t *testing.T) *comfyFixture {
	t.Helper()
	value := &comfyFixture{output: mustDecodeBase64(t, onePixelPNGBase64()), viewType: "image/png"}
	value.history = `{"prompt-1":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"result.png","subfolder":"final","type":"output"}]}}}}`
	value.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value.mu.Lock()
		defer value.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/prompt":
			value.submits++
			if err := json.NewDecoder(r.Body).Decode(&value.promptBody); err != nil {
				t.Errorf("decode prompt: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"prompt_id":"prompt-1"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/history/prompt-1":
			value.historyGets++
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, value.history)
		case r.Method == http.MethodGet && r.URL.Path == "/view":
			if r.URL.Query().Get("filename") != "result.png" || r.URL.Query().Get("subfolder") != "final" || r.URL.Query().Get("type") != "output" {
				t.Errorf("unsafe or incomplete view query: %s", r.URL.RawQuery)
			}
			w.Header().Set("Content-Type", value.viewType)
			_, _ = w.Write(value.output)
		case r.Method == http.MethodPost && r.URL.Path == "/queue":
			value.queueDelete++
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/interrupt":
			value.interrupts++
			w.WriteHeader(http.StatusOK)
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(value.server.Close)
	return value
}

func mustDecodeBase64(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func comfyUIJobFixture(t *testing.T, id string, manifest localWorkflowManifest, checkpoint *comfyUIExternalCheckpoint) store.GenerationJob {
	t.Helper()
	parameters, err := json.Marshal(comfyUIJobParameters{
		Executor: comfyUIExecutorMarker, RequestHash: strings.Repeat("a", 64), Manifest: manifest,
		Values: comfyUIWorkflowValues{Prompt: "hello", Seed: 7, Width: 512, Height: 512},
	})
	if err != nil {
		t.Fatal(err)
	}
	result := comfyUIJobResult{}
	if checkpoint != nil {
		result.ExternalPromptID = checkpoint.PromptID
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return store.GenerationJob{ID: id, Kind: "image", Status: "queued", Prompt: "hello", Parameters: parameters, Result: resultJSON, CreatedAt: now, UpdatedAt: now}
}

func TestComfyUIExecutorSubmitsPollsAndDownloadsValidatedOutput(t *testing.T) {
	fixture := newComfyFixture(t)
	manifest := comfyImageManifest(t, fixture.server.URL)
	executor, err := newComfyUIExecutor(manifest.Endpoint, manifest.AllowPrivate)
	if err != nil {
		t.Fatal(err)
	}
	executor.pollInterval = time.Millisecond
	var checkpoints []comfyUIExternalCheckpoint
	output, err := executor.Run(t.Context(), comfyUIExecutionRequest{
		Manifest: manifest,
		Values:   comfyUIWorkflowValues{Prompt: "a safe prompt", Seed: 42, Width: 512, Height: 512},
	}, nil, func(value comfyUIExternalCheckpoint) error {
		checkpoints = append(checkpoints, value)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 1 || checkpoints[0].PromptID != "prompt-1" {
		t.Fatalf("checkpoints = %#v", checkpoints)
	}
	if output.Kind != "image" || output.MIMEType != "image/png" || !bytes.Equal(output.Data, fixture.output) {
		t.Fatalf("output = %#v", output)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.submits != 1 || fixture.historyGets < 1 {
		t.Fatalf("submits=%d history=%d", fixture.submits, fixture.historyGets)
	}
	prompt := fixture.promptBody["prompt"].(map[string]any)
	if prompt["sampler"].(map[string]any)["class_type"] != "KSampler" {
		t.Fatalf("compiled prompt = %#v", prompt)
	}
}

func TestComfyUIExecutorResumesCheckpointWithoutDuplicateSubmission(t *testing.T) {
	fixture := newComfyFixture(t)
	manifest := comfyImageManifest(t, fixture.server.URL)
	executor, err := newComfyUIExecutor(manifest.Endpoint, false)
	if err != nil {
		t.Fatal(err)
	}
	executor.pollInterval = time.Millisecond
	output, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, &comfyUIExternalCheckpoint{PromptID: "prompt-1"}, func(comfyUIExternalCheckpoint) error {
		t.Fatal("resume must not create another checkpoint")
		return nil
	})
	if err != nil || output.Kind != "image" {
		t.Fatalf("resume = %#v, %v", output, err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.submits != 0 || fixture.historyGets == 0 {
		t.Fatalf("submits=%d history=%d", fixture.submits, fixture.historyGets)
	}
}

func TestComfyUICancelIsPromptScopedBeforeInterrupt(t *testing.T) {
	fixture := newComfyFixture(t)
	executor, err := newComfyUIExecutor(fixture.server.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	executor.exclusive = true
	if err := executor.Cancel(t.Context(), comfyUIExternalCheckpoint{PromptID: "prompt-1"}); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.queueDelete != 1 || fixture.interrupts != 1 {
		t.Fatalf("queue delete=%d interrupts=%d", fixture.queueDelete, fixture.interrupts)
	}
}

func TestComfyUICancelDoesNotInterruptSharedExecutor(t *testing.T) {
	fixture := newComfyFixture(t)
	executor, err := newComfyUIExecutor(fixture.server.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := executor.Cancel(t.Context(), comfyUIExternalCheckpoint{PromptID: "prompt-1"}); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.queueDelete != 1 || fixture.interrupts != 0 {
		t.Fatalf("shared cancellation queue delete=%d interrupts=%d", fixture.queueDelete, fixture.interrupts)
	}
}

func TestComfyUIExecutorEnforcesAggregateOutputLimit(t *testing.T) {
	fixture := newComfyFixture(t)
	fixture.history = `{"prompt-1":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"result.png","subfolder":"final","type":"output"},{"filename":"result.png","subfolder":"final","type":"output"}]}}}}`
	fixture.output = bytes.Repeat([]byte{0}, maxGeneratedTotalBytes/2+1)
	manifest := comfyImageManifest(t, fixture.server.URL)
	executor, err := newComfyUIExecutor(fixture.server.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	executor.pollInterval = time.Millisecond
	if _, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, &comfyUIExternalCheckpoint{PromptID: "prompt-1"}, func(comfyUIExternalCheckpoint) error { return nil }); err == nil || !strings.Contains(err.Error(), "total") {
		t.Fatalf("aggregate output was accepted: %v", err)
	}
}

func TestComfyUIExecutorRejectsRedirectsOversizeAndUnsafeHistoryPaths(t *testing.T) {
	redirectTargetCalled := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirectTargetCalled = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	executor, err := newComfyUIExecutor(redirect.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	manifest := comfyImageManifest(t, redirect.URL)
	if _, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, nil, func(comfyUIExternalCheckpoint) error { return nil }); err == nil {
		t.Fatal("redirected submission was accepted")
	}
	if redirectTargetCalled {
		t.Fatal("redirect target was contacted")
	}

	fixture := newComfyFixture(t)
	fixture.history = `{"prompt-1":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"../secret","subfolder":"final","type":"output"}]}}}}`
	executor, _ = newComfyUIExecutor(fixture.server.URL, false)
	executor.pollInterval = time.Millisecond
	manifest = comfyImageManifest(t, fixture.server.URL)
	if _, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, &comfyUIExternalCheckpoint{PromptID: "prompt-1"}, func(comfyUIExternalCheckpoint) error { return nil }); err == nil {
		t.Fatal("unsafe history output path was accepted")
	}

	fixture.history = `{"prompt-1":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"result.png","subfolder":"final","type":"output"}]}}}}`
	fixture.output = bytes.Repeat([]byte{0}, maxGeneratedImageBytes+1)
	if _, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, &comfyUIExternalCheckpoint{PromptID: "prompt-1"}, func(comfyUIExternalCheckpoint) error { return nil }); err == nil {
		t.Fatal("oversized ComfyUI output was accepted")
	}
}

func TestComfyUIEndpointAndPromptValidationPreserveSSRFBoundary(t *testing.T) {
	for _, endpoint := range []string{
		"https://comfy.example.com", "http://169.254.169.254", "http://10.0.0.8:8188", "http://user:pass@127.0.0.1:8188", "http://127.0.0.1:8188?next=x",
	} {
		if _, err := newComfyUIExecutor(endpoint, false); err == nil {
			t.Fatalf("unsafe endpoint %q was accepted", endpoint)
		}
	}
	manifest := comfyImageManifest(t, "http://127.0.0.1:8188")
	if _, err := compileComfyUIPrompt(manifest, comfyUIWorkflowValues{Prompt: strings.Repeat("x", maxComfyUIPromptBytes+1)}); err == nil {
		t.Fatal("oversized prompt was accepted")
	}
}

func TestComfyUIWorkerCheckpointsPersistsAndImportsOutputIdempotently(t *testing.T) {
	fixture := newComfyFixture(t)
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	defer server.Close()
	server.comfyUIPollInterval = time.Millisecond
	manifest := comfyImageManifest(t, fixture.server.URL)
	job := comfyUIJobFixture(t, "comfy-job", manifest, nil)
	if err := backend.CreateServerGenerationJob(t.Context(), store.DefaultTenantID, "", job, 1, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	claimed, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "image", Executor: comfyUIExecutorMarker}, "test-owner", time.Now(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	server.executeClaimedComfyUIJob(claimed)
	completed, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "succeeded" {
		t.Fatalf("job status=%s error=%s result=%s", completed.Status, completed.Error, completed.Result)
	}
	var result comfyUIJobResult
	if err := json.Unmarshal(completed.Result, &result); err != nil || result.ExternalPromptID != "prompt-1" || len(result.Items) != 1 {
		t.Fatalf("result=%s err=%v", completed.Result, err)
	}
	stored, err := server.readTenantBlob(t.Context(), store.DefaultTenantID, result.Items[0].StorageKey, maxGeneratedImageBytes)
	if err != nil || !bytes.Equal(stored.Data, fixture.output) {
		t.Fatalf("stored output mismatch: %v", err)
	}
}

func TestComfyUIWorkerRecoversPersistedPromptAfterRestartWithoutResubmit(t *testing.T) {
	fixture := newComfyFixture(t)
	backend := newMemoryStore()
	manifest := comfyImageManifest(t, fixture.server.URL)
	checkpoint := &comfyUIExternalCheckpoint{PromptID: "prompt-1"}
	job := comfyUIJobFixture(t, "recover-job", manifest, checkpoint)
	job.Status = "running"
	job.LeaseOwner = "dead-process"
	job.LeaseExpiresAt = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	server := NewServerWithStore(t.TempDir(), backend)
	server.comfyUIPollInterval = time.Millisecond
	server.startComfyUIWorkers(1)
	defer server.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, job.ID)
		if current.Status == "succeeded" {
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			if fixture.submits != 0 || fixture.historyGets == 0 {
				t.Fatalf("submits=%d history=%d", fixture.submits, fixture.historyGets)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("restarted worker did not recover expired ComfyUI job")
}

func TestCreateComfyUIJobAPIIsIdempotentAndRejectsManifestKindMismatch(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	fixture := newComfyFixture(t)
	backend := newMemoryStore()
	manifest := comfyImageManifest(t, fixture.server.URL)
	configured, err := json.Marshal(map[string]any{"executors": []map[string]any{{
		"id": manifest.ID, "billingModel": "comfyui-image-standard", "exclusive": false, "manifest": manifest,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_COMFYUI_EXECUTORS", string(configured))
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	defer server.Close()
	router := chi.NewRouter()
	MountServer(router, server)
	body, _ := json.Marshal(map[string]any{"id": "api-comfy", "projectId": "project-one", "manifestId": manifest.ID, "values": map[string]any{"prompt": "hello", "seed": 7, "width": 512, "height": 512}})
	for attempt := 0; attempt < 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/api/generation-jobs/comfyui", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer test-token")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if attempt == 0 && response.Code != http.StatusAccepted || attempt == 1 && response.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", attempt, response.Code, response.Body.String())
		}
	}
	mutated := bytes.Replace(body, []byte(`"prompt":"hello"`), []byte(`"prompt":"different"`), 1)
	request := httptest.NewRequest(http.MethodPost, "/api/generation-jobs/comfyui", bytes.NewReader(mutated))
	request.Header.Set("Authorization", "Bearer test-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("mismatched retry status=%d body=%s", response.Code, response.Body.String())
	}

	badBody, _ := json.Marshal(map[string]any{"id": "bad-kind", "manifestId": "missing-executor", "values": map[string]any{"prompt": "hello"}})
	request = httptest.NewRequest(http.MethodPost, "/api/generation-jobs/comfyui", bytes.NewReader(badBody))
	request.Header.Set("Authorization", "Bearer test-token")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("kind mismatch status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestCreateComfyUIJobUsesOnlyServerApprovedExecutorAndBillingModel(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	fixture := newComfyFixture(t)
	manifest := comfyImageManifest(t, fixture.server.URL)
	configured, err := json.Marshal(map[string]any{"executors": []map[string]any{{
		"id": manifest.ID, "billingModel": "comfyui-image-standard", "exclusive": false, "manifest": manifest,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_COMFYUI_EXECUTORS", string(configured))
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	defer server.Close()
	router := chi.NewRouter()
	MountServer(router, server)

	requestJob := func(body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/generation-jobs/comfyui", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer test-token")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	untrusted, _ := json.Marshal(map[string]any{
		"id": "untrusted-endpoint", "manifest": manifest,
		"values": map[string]any{"prompt": "hello", "width": 512, "height": 512},
	})
	if response := requestJob(untrusted); response.Code != http.StatusBadRequest {
		t.Fatalf("client-supplied manifest status=%d body=%s", response.Code, response.Body.String())
	}

	approved, _ := json.Marshal(map[string]any{
		"id": "approved-executor", "manifestId": manifest.ID,
		"values": map[string]any{"prompt": "hello", "width": 512, "height": 512},
	})
	if response := requestJob(approved); response.Code != http.StatusAccepted {
		t.Fatalf("approved executor status=%d body=%s", response.Code, response.Body.String())
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, "approved-executor")
	if err != nil {
		t.Fatal(err)
	}
	if job.ProviderID != manifest.ID || job.Model != "comfyui-image-standard" {
		t.Fatalf("billing identity provider=%q model=%q", job.ProviderID, job.Model)
	}

	unknown, _ := json.Marshal(map[string]any{
		"id": "unknown-executor", "manifestId": "not-approved",
		"values": map[string]any{"prompt": "hello"},
	})
	if response := requestJob(unknown); response.Code != http.StatusNotFound {
		t.Fatalf("unknown executor status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestComfyUIWorkerLogDoesNotExposeApprovedPrivateEndpoint(t *testing.T) {
	fixture := newComfyFixture(t)
	manifest := comfyImageManifest(t, fixture.server.URL)
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	defer server.Close()
	job := comfyUIJobFixture(t, "redacted-log", manifest, nil)
	if err := backend.CreateServerGenerationJob(t.Context(), store.DefaultTenantID, "", job, 1, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	claimed, err := backend.ClaimServerGenerationJob(t.Context(), store.GenerationClaim{Kind: "image", Executor: comfyUIExecutorMarker}, "test-owner", time.Now(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	fixture.server.Close()
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	server.executeClaimedComfyUIJob(claimed)
	if strings.Contains(logs.String(), fixture.server.URL) || strings.Contains(logs.String(), "127.0.0.1") {
		t.Fatalf("private endpoint leaked in log: %s", logs.String())
	}
}

func TestComfyUIRunHonorsTimeoutAndCheckpointFailure(t *testing.T) {
	fixture := newComfyFixture(t)
	fixture.history = `{}`
	manifest := comfyImageManifest(t, fixture.server.URL)
	manifest.Limits.MaxSeconds = 1
	executor, _ := newComfyUIExecutor(fixture.server.URL, false)
	executor.pollInterval = 10 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	if _, err := executor.Run(ctx, comfyUIExecutionRequest{Manifest: manifest}, &comfyUIExternalCheckpoint{PromptID: "prompt-1"}, func(comfyUIExternalCheckpoint) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout err=%v", err)
	}
	if _, err := executor.Run(t.Context(), comfyUIExecutionRequest{Manifest: manifest}, nil, func(comfyUIExternalCheckpoint) error { return errors.New("checkpoint unavailable") }); err == nil || !strings.Contains(err.Error(), "checkpoint") {
		t.Fatalf("checkpoint err=%v", err)
	}
}
