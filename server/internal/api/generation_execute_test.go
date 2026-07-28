package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type scriptedImageResult struct {
	images []generatedImage
	err    error
}

type scriptedImageExecutor struct {
	started   chan imageGenerationRequest
	release   chan scriptedImageResult
	cancelled chan struct{}
	calls     atomic.Int32
}

func newScriptedImageExecutor() *scriptedImageExecutor {
	return &scriptedImageExecutor{
		started:   make(chan imageGenerationRequest, 4),
		release:   make(chan scriptedImageResult, 4),
		cancelled: make(chan struct{}, 4),
	}
}

func (e *scriptedImageExecutor) Generate(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	e.calls.Add(1)
	e.started <- request
	select {
	case result := <-e.release:
		return result.images, result.err
	case <-ctx.Done():
		e.cancelled <- struct{}{}
		return nil, ctx.Err()
	}
}

func imageExecutionHandler(t *testing.T, executor imageExecutor) (*Server, *memoryStore, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	server.imageExecutor = executor
	config := []byte(`{"channels":[{"id":"image-main","name":"Images","baseUrl":"https://images.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://images.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}],"systemPrompt":"be concise"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	secrets := []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)
	if got := request(t, router, http.MethodPut, "/api/secrets/config", secrets); got.Code != http.StatusNoContent {
		t.Fatalf("store secrets: %d %s", got.Code, got.Body.String())
	}
	return server, backend, router
}

func postImageJob(t *testing.T, handler http.Handler, id, prompt string) *responseSnapshot {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id": id, "projectId": "board-1", "prompt": prompt,
		"providerId": "image-main", "model": "gpt-image-1",
		"parameters": map[string]any{"size": "1024x1024", "quality": "high", "count": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/image", body)
	return &responseSnapshot{code: got.Code, body: append([]byte(nil), got.Body.Bytes()...)}
}

func TestServerImageAndWorkflowTombstonesReturnGone(t *testing.T) {
	executor := newScriptedImageExecutor()
	_, backend, handler := imageExecutionHandler(t, executor)
	backend.mu.Lock()
	backend.generationJobCreateErr = store.ErrGone
	backend.mu.Unlock()

	if got := postImageJob(t, handler, "job-image-gone", "stale image"); got.code != http.StatusGone {
		t.Fatalf("image create status = %d, want 410: %s", got.code, got.body)
	}
	if got := postWorkflowRun(t, handler, "job-workflow-gone"); got.code != http.StatusGone {
		t.Fatalf("workflow create status = %d, want 410: %s", got.code, got.body)
	}
}

func TestServerImageJobCategoryIsBounded(t *testing.T) {
	input := createImageJobRequest{
		ID: "job-category", ProjectID: "board-1", Prompt: "draw", ProviderID: "image-main", Model: "image",
		Parameters: createImageJobParameters{Size: "1024x1024", Count: 1, Category: "海报"},
	}
	if !validCreateImageJob(input) {
		t.Fatal("expected bounded category to be valid")
	}
	input.Parameters.Category = strings.Repeat("x", 101)
	if validCreateImageJob(input) {
		t.Fatal("expected oversized category to be rejected")
	}
}

type responseSnapshot struct {
	code int
	body []byte
}

func awaitExecutorStart(t *testing.T, executor *scriptedImageExecutor) imageGenerationRequest {
	t.Helper()
	select {
	case request := <-executor.started:
		return request
	case <-time.After(time.Second):
		t.Fatal("image executor did not start")
		return imageGenerationRequest{}
	}
}

func TestServerImageJobIsIdempotentAndPersistsResult(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)

	created := postImageJob(t, handler, "job-server-image", "a red square")
	if created.code != http.StatusAccepted || !bytes.Contains(created.body, []byte(`"status": "queued"`)) {
		t.Fatalf("create image job: %d %s", created.code, created.body)
	}
	upstream := awaitExecutorStart(t, executor)
	if upstream.APIKey != "sk-private" || upstream.BaseURL != "https://images.example/v1" || upstream.Prompt != "be concise\n\na red square" {
		t.Fatalf("resolved upstream request = %#v", upstream)
	}

	duplicate := postImageJob(t, handler, "job-server-image", "a red square")
	if duplicate.code != http.StatusOK {
		t.Fatalf("idempotent create: %d %s", duplicate.code, duplicate.body)
	}
	conflict := postImageJob(t, handler, "job-server-image", "a blue square")
	if conflict.code != http.StatusConflict {
		t.Fatalf("conflicting idempotency payload: %d %s", conflict.code, conflict.body)
	}
	if calls := executor.calls.Load(); calls != 1 {
		t.Fatalf("executor calls before release = %d", calls)
	}

	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	server.generationWG.Wait()

	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-server-image")
	if err != nil || job.Status != "succeeded" || job.Error != "" {
		t.Fatalf("completed job = %#v, %v", job, err)
	}
	var result struct {
		Items []struct {
			StorageKey string `json:"storageKey"`
			MIMEType   string `json:"mimeType"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			Bytes      int    `json:"bytes"`
		} `json:"items"`
	}
	if err := json.Unmarshal(job.Result, &result); err != nil || len(result.Items) != 1 {
		t.Fatalf("result = %s, %v", job.Result, err)
	}
	item := result.Items[0]
	if item.StorageKey == "" || item.MIMEType != "image/png" || item.Width != 1 || item.Height != 1 || item.Bytes != len(png) {
		t.Fatalf("result item = %#v", item)
	}
	encodedStorageKey := strings.ReplaceAll(item.StorageKey, ":", "%3A")
	stored := request(t, handler, http.MethodGet, "/api/blobs/"+encodedStorageKey, nil)
	if stored.Code != http.StatusOK || !bytes.Equal(stored.Body.Bytes(), png) || stored.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("stored result: %d %#v", stored.Code, stored.Header())
	}
}

func TestServerImageJobResolvesGeminiProtocolWithoutExposingSecret(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	config := []byte(`{"channels":[{"id":"image-main","defaultImageModel":"gemini-image","providers":{"image":{"baseUrl":"https://generativelanguage.googleapis.com/v1beta","model":"gemini-image","protocol":"gemini"}}}],"systemPrompt":"system image rule"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	created := postImageJob(t, handler, "job-gemini-image", "draw with Gemini")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	resolved := awaitExecutorStart(t, executor)
	if resolved.Protocol != "gemini" || resolved.BaseURL != "https://generativelanguage.googleapis.com/v1beta" ||
		resolved.APIKey != "sk-private" || resolved.Prompt != "system image rule\n\ndraw with Gemini" {
		t.Fatalf("resolved Gemini request: %#v", resolved)
	}
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	server.generationWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-gemini-image")
	if err != nil || job.Status != "succeeded" || bytes.Contains(job.Parameters, []byte("sk-private")) || bytes.Contains(job.Result, []byte("sk-private")) {
		t.Fatalf("Gemini job=%#v err=%v", job, err)
	}
}

func TestServerImageJobResolvesRestrictedTemplateWithoutExposingSecret(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	config := []byte(`{"channels":[{"id":"image-main","defaultImageModel":"relay-image","providers":{"image":{"baseUrl":"https://relay.example/v2","model":"relay-image","protocol":"template","template":{"method":"POST","path":"/render","auth":"bearer","request":{"text":"{{prompt}}","n":"{{count}}"},"responsePath":"result.images"}}}}],"systemPrompt":"template system rule"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	created := postImageJob(t, handler, "job-template-image", "draw with template")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	resolved := awaitExecutorStart(t, executor)
	if resolved.Protocol != "template" || resolved.Template == nil || resolved.Template.Path != "/render" ||
		resolved.Template.ResponsePath != "result.images" || resolved.APIKey != "sk-private" ||
		resolved.Prompt != "template system rule\n\ndraw with template" {
		t.Fatalf("resolved template request: %#v", resolved)
	}
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	server.generationWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-template-image")
	if err != nil || job.Status != "succeeded" || bytes.Contains(job.Parameters, []byte("sk-private")) || bytes.Contains(job.Result, []byte("sk-private")) {
		t.Fatalf("template job=%#v err=%v", job, err)
	}
}

func TestServerImageJobCancellationWinsAgainstLateCompletion(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	created := postImageJob(t, handler, "job-cancel-image", "cancel me")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)

	for range 2 {
		cancelled := request(t, handler, http.MethodPost, "/api/generation-jobs/job-cancel-image/cancel", nil)
		if cancelled.Code != http.StatusOK || !bytes.Contains(cancelled.Body.Bytes(), []byte(`"status": "cancelled"`)) {
			t.Fatalf("cancel: %d %s", cancelled.Code, cancelled.Body.String())
		}
	}
	select {
	case <-executor.cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream context was not cancelled")
	}
	server.generationWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-cancel-image")
	if err != nil || job.Status != "cancelled" {
		t.Fatalf("cancelled job = %#v, %v", job, err)
	}
}

func TestServerImageJobSanitizesFailure(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	created := postImageJob(t, handler, "job-failed-image", "fail me")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	executor.release <- scriptedImageResult{err: errors.New("provider failed with sk-private")}
	server.generationWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-failed-image")
	if err != nil || job.Status != "failed" || job.Error != "图片生成失败，请检查模型服务配置后重试" || bytes.Contains(job.Result, []byte("sk-private")) {
		t.Fatalf("failed job = %#v, %v", job, err)
	}
}

func TestServerImageJobRequiresAuthenticationUnlessExplicitlyDisabled(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	created := postImageJob(t, router, "anonymous-job", "must authenticate")
	if created.code != http.StatusUnauthorized {
		t.Fatalf("anonymous generation status = %d, body = %s", created.code, created.body)
	}
}

func TestServerImageJobRechecksBearerWhenAuthenticationIsOff(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	body := []byte(`{"id":"no-bearer","prompt":"blocked","providerId":"image-main","parameters":{"size":"1024x1024","count":1}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/generation-jobs/image", bytes.NewReader(body))
	got := httptest.NewRecorder()
	router.ServeHTTP(got, req)
	if got.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer status = %d, body = %s", got.Code, got.Body.String())
	}
}

func TestServerImageWorkerDoesNotStartWithoutOffModeToken(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "")
	executor := newScriptedImageExecutor()
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.imageExecutor = executor
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	time.Sleep(25 * time.Millisecond)
	if executor.calls.Load() != 0 {
		t.Fatalf("executor calls without process token = %d", executor.calls.Load())
	}
}

func TestActiveServerImageJobBlocksBulkHistoryRestore(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, _, handler := imageExecutionHandler(t, executor)
	created := postImageJob(t, handler, "job-active-restore", "keep running")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	restored := request(t, handler, http.MethodPut, "/api/generation-jobs", []byte(`[]`))
	if restored.Code != http.StatusConflict {
		t.Fatalf("restore during active server job = %d %s", restored.Code, restored.Body.String())
	}
	if cancelled := request(t, handler, http.MethodPost, "/api/generation-jobs/job-active-restore/cancel", nil); cancelled.Code != http.StatusOK {
		t.Fatalf("cancel: %d %s", cancelled.Code, cancelled.Body.String())
	}
	server.generationWG.Wait()
}

func TestServerImageWorkersRecoverQueuedAndExpiredRunningJobs(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	config := []byte(`{"channels":[{"id":"image-main","name":"Images","baseUrl":"https://images.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://images.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}]}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	seed := NewServerWithStore(t.TempDir(), backend)
	seed.SetProcessToken("test-token")
	if err := seed.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	seedRouter := chi.NewRouter()
	MountServer(seedRouter, seed)
	if got := request(t, seedRouter, http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)); got.Code != http.StatusNoContent {
		t.Fatalf("store secrets: %d %s", got.Code, got.Body.String())
	}
	seed.Close()

	parameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, RequestHash: "recovery", Size: "1024x1024", Quality: "auto", Count: 1,
	})
	now := time.Now().UTC()
	for _, job := range []store.GenerationJob{
		{ID: "recover-queued", Kind: "image", Status: "queued", Prompt: "queued", ProviderID: "image-main", Model: "gpt-image-1", Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano), UpdatedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)},
		{ID: "recover-expired", Kind: "image", Status: "running", Prompt: "expired", ProviderID: "image-main", Model: "gpt-image-1", Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: now.Add(-time.Minute).Format(time.RFC3339Nano), UpdatedAt: now.Add(-time.Minute).Format(time.RFC3339Nano), LeaseOwner: "dead-worker", LeaseExpiresAt: now.Add(-time.Second).Format(time.RFC3339Nano)},
	} {
		if err := backend.CreateGenerationJob(context.Background(), store.DefaultTenantID, job); err != nil {
			t.Fatal(err)
		}
	}

	executor := newScriptedImageExecutor()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	server.imageExecutor = executor
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	_ = awaitExecutorStart(t, executor)
	_ = awaitExecutorStart(t, executor)
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	server.generationWG.Wait()
	for _, id := range []string{"recover-queued", "recover-expired"} {
		job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, id)
		if err != nil || job.Status != "succeeded" {
			t.Fatalf("recovered %s = %#v, %v", id, job, err)
		}
	}
	if calls := executor.calls.Load(); calls != 2 {
		t.Fatalf("recovered executor calls = %d", calls)
	}
}

func TestGeneratedImageValidationRejectsHeaderOnlyWebPAndAVIF(t *testing.T) {
	webp := make([]byte, 30)
	copy(webp[:4], "RIFF")
	copy(webp[8:12], "WEBP")
	copy(webp[12:16], "VP8X")
	webp[24], webp[27] = 1, 2 // stored dimensions are minus one: 2x3
	if _, _, _, err := validateGeneratedImage(generatedImage{Data: webp, MIMEType: "image/webp"}); err == nil {
		t.Fatal("header-only WebP must be rejected")
	}

	avif := make([]byte, 44)
	copy(avif[4:8], "ftyp")
	copy(avif[8:12], "avif")
	copy(avif[16:20], "avif")
	copy(avif[28:32], "ispe")
	if _, _, _, err := validateGeneratedImage(generatedImage{Data: avif, MIMEType: "image/avif"}); err == nil {
		t.Fatal("forged AVIF container must be rejected")
	}
}

func TestGenerationAttemptsOwnDistinctResultBlobs(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	images := []generatedImage{{Data: png, MIMEType: "image/png"}}
	_, firstKeys, err := server.persistGeneratedImages(context.Background(), store.DefaultTenantID, "", "same-job", "attempt-a", images)
	if err != nil {
		t.Fatal(err)
	}
	_, secondKeys, err := server.persistGeneratedImages(context.Background(), store.DefaultTenantID, "", "same-job", "attempt-b", images)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstKeys) != 1 || len(secondKeys) != 1 || firstKeys[0] == secondKeys[0] {
		t.Fatalf("attempt keys = %#v and %#v", firstKeys, secondKeys)
	}
	if err := server.deleteTenantBlob(context.Background(), store.DefaultTenantID, "", firstKeys[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := server.readTenantImageBlob(store.DefaultTenantID, secondKeys[0]); err != nil {
		t.Fatalf("new attempt blob removed by stale cleanup: %v", err)
	}
}

func TestTwoServersClaimOnceAndPropagateCancellation(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	config := []byte(`{"channels":[{"id":"image-main","name":"Images","baseUrl":"https://images.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://images.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}]}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	executor := newScriptedImageExecutor()
	newInstance := func() (*Server, http.Handler) {
		server := NewServerWithStore(t.TempDir(), backend)
		server.SetProcessToken("test-token")
		server.imageExecutor = executor
		if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
			t.Fatal(err)
		}
		router := chi.NewRouter()
		MountServer(router, server)
		return server, router
	}
	serverA, routerA := newInstance()
	t.Cleanup(serverA.Close)
	if got := request(t, routerA, http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)); got.Code != http.StatusNoContent {
		t.Fatalf("store secrets: %d %s", got.Code, got.Body.String())
	}
	serverB, routerB := newInstance()
	t.Cleanup(serverB.Close)

	created := postImageJob(t, routerA, "multi-instance-job", "claim once")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	if cancelled := request(t, routerB, http.MethodPost, "/api/generation-jobs/multi-instance-job/cancel", nil); cancelled.Code != http.StatusOK {
		t.Fatalf("cross-instance cancel: %d %s", cancelled.Code, cancelled.Body.String())
	}
	select {
	case <-executor.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("owning server did not observe cross-instance cancellation")
	}
	serverA.generationWG.Wait()
	serverB.generationWG.Wait()
	if calls := executor.calls.Load(); calls != 1 {
		t.Fatalf("executor calls across two servers = %d", calls)
	}
}
