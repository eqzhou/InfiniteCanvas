package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type scriptedImageResult struct {
	images []generatedImage
	err    error
}

func TestPersonalChannelTimeout(t *testing.T) {
	for _, test := range []struct {
		name    string
		seconds int
		want    time.Duration
		wantErr bool
	}{
		{name: "legacy default", seconds: 0, want: 60 * time.Second},
		{name: "custom", seconds: 90, want: 90 * time.Second},
		{name: "too large", seconds: 601, wantErr: true},
		{name: "negative", seconds: -1, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := personalChannelTimeout(test.seconds)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("timeout = %s, want %s", got, test.want)
			}
		})
	}
}

type scriptedImageExecutor struct {
	started   chan imageGenerationRequest
	release   chan scriptedImageResult
	cancelled chan struct{}
	calls     atomic.Int32
}

func newScriptedImageExecutor() *scriptedImageExecutor {
	return &scriptedImageExecutor{
		started:   make(chan imageGenerationRequest, 8),
		release:   make(chan scriptedImageResult, 8),
		cancelled: make(chan struct{}, 8),
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
	config := []byte(`{"channels":[{"id":"image-main","name":"Images","timeoutSeconds":90,"baseUrl":"https://images.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://images.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}],"systemPrompt":"be concise"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	secrets := []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)
	if got := putConfigSecrets(t, router, secrets); got.Code != http.StatusNoContent {
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
	tests := []struct {
		name     string
		category string
		valid    bool
	}{
		{name: "unicode characters count by UTF16 not bytes", category: strings.Repeat("中", 60), valid: true},
		{name: "trimmed category remains valid", category: "  海报  ", valid: true},
		{name: "exact ASCII boundary", category: strings.Repeat("x", 100), valid: true},
		{name: "exact surrogate boundary", category: strings.Repeat("😀", 50), valid: true},
		{name: "surrogate over boundary", category: strings.Repeat("😀", 51), valid: false},
		{name: "ASCII over boundary", category: strings.Repeat("x", 101), valid: false},
		{name: "control character", category: "poster\ncopy", valid: false},
		{name: "control character after trim", category: "\n", valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input.Parameters.Category = test.category
			if got := validCreateImageJob(input); got != test.valid {
				t.Fatalf("category %q valid = %v, want %v", test.category, got, test.valid)
			}
		})
	}
}

func TestServerImageJobAcceptsFanOutCountAndBatchMetadata(t *testing.T) {
	input := createImageJobRequest{
		ID: "job-batch-slot", ProjectID: "board-1", Prompt: "draw", ProviderID: "image-main", Model: "image",
		Parameters: createImageJobParameters{
			Size: "1024x1024", Count: 1, RequestedCount: 20, BatchID: "batch_test", BatchIndex: 4,
		},
	}
	if !validCreateImageJob(input) {
		t.Fatal("expected split n=1 slot with requestedCount=20 to be valid")
	}
	input.Parameters.Count = 20
	if !validCreateImageJob(input) {
		t.Fatal("expected a 20-image canvas job to be valid after n=1 fan-out")
	}
	input.Parameters.Count = 101
	if validCreateImageJob(input) {
		t.Fatal("expected count 101 to stay rejected as an operational ceiling")
	}
}

func TestReferenceImageAllowsOriginalCameraResolutionWithoutRelaxingGeneratedOutputs(t *testing.T) {
	pngBytes, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	binary.BigEndian.PutUint32(pngBytes[16:20], 5712)
	binary.BigEndian.PutUint32(pngBytes[20:24], 4284)
	binary.BigEndian.PutUint32(pngBytes[29:33], crc32.ChecksumIEEE(pngBytes[12:29]))
	value := generatedImage{Data: pngBytes, MIMEType: "image/png"}
	if _, _, _, err := validateReferenceImage(value); err != nil {
		t.Fatalf("camera-resolution reference rejected: %v", err)
	}
	if _, _, _, err := validateGeneratedImage(value); err == nil {
		t.Fatal("generated output unexpectedly accepted above its pixel limit")
	}
}

func TestServerImageJobPersistsDirectorSourceLineage(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	shot := json.RawMessage(`{"version":1,"directorNodeId":"director-main","camera":{"id":"camera-main","name":"Main camera","position":{"x":1,"y":2,"z":3},"target":{"x":0,"y":1,"z":0},"focalLength":50,"aperture":2.8,"aspect":"16:9"},"background":"#111111","environment":{"rotationY":0,"intensity":1,"sourceId":null},"objects":[],"omittedObjectCount":0}`)
	captureDocument, _ := json.Marshal(directorCaptureDocument{Version: 1, Items: []directorCaptureRecord{{
		ID: "capture-main", ProjectID: "board-1", DirectorNodeID: "director-main", CameraID: "camera-main", CameraName: "Main camera",
		CreatedAt: "2026-08-02T00:00:00Z", Width: 1, Height: 1, Bytes: 1, MIMEType: "image/png",
		StorageKey: "director-capture:capture-main", Shot: shot,
	}}})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, directorCaptureStateKey, captureDocument); err != nil {
		t.Fatal(err)
	}
	referencePNG, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil || server.storeTenantBlob(context.Background(), store.DefaultTenantID, "", "image:director-shot-source", "image/png", referencePNG) != nil {
		t.Fatal("seed durable director reference")
	}
	projectDocument, _ := json.Marshal(map[string]any{"nodes": []any{
		map[string]any{"id": "director-main", "type": "director", "metadata": map[string]any{}},
		map[string]any{"id": "capture-node", "type": "image", "metadata": map[string]any{
			"storageKey": "image:director-shot-source", "directorShot": map[string]any{
				"role": "capture", "directorNodeId": "director-main", "captureId": "capture-main", "snapshot": json.RawMessage(shot),
			},
		}},
		map[string]any{"id": "config-main", "type": "config", "metadata": map[string]any{"directorShot": map[string]any{
			"role": "config", "directorNodeId": "director-main", "captureId": "capture-main", "snapshot": json.RawMessage(shot),
		}, "referenceStorageKeys": []string{"image:director-shot-source"}}},
	}, "edges": []any{
		map[string]any{"from": "director-main", "to": "capture-node"},
		map[string]any{"from": "capture-node", "to": "config-main"},
	}})
	if err := backend.PutProject(context.Background(), store.DefaultTenantID, "board-1", projectDocument); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"id": "job-director-shot", "projectId": "board-1", "prompt": "formal shot",
		"providerId": "image-main", "model": "gpt-image-1",
		"parameters": map[string]any{
			"size": "1024x1024", "quality": "high", "count": 1, "referenceStorageKeys": []string{"image:director-shot-source"},
			"source": map[string]any{
				"kind": "director", "directorNodeId": "director-main", "captureId": "capture-main",
				"cameraId": "camera-main", "configNodeId": "config-main",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := request(t, handler, http.MethodPost, "/api/generation-jobs/image", body)
	if created.Code != http.StatusAccepted {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-director-shot")
	if err != nil {
		t.Fatal(err)
	}
	var parameters persistedImageJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Source == nil ||
		parameters.Source.CaptureID != "capture-main" || parameters.Source.ConfigNodeID != "config-main" {
		t.Fatalf("director source was not persisted: %s", job.Parameters)
	}
	audit := imageRequestAuditPayload(imageGenerationRequest{Source: parameters.Source})
	if _, ok := audit["source"]; !ok {
		t.Fatal("director source missing from AI audit payload")
	}
	resolved := awaitExecutorStart(t, executor)
	if resolved.Source == nil || resolved.Source.CaptureID != "capture-main" || resolved.Source.ConfigNodeID != "config-main" {
		t.Fatalf("director source did not reach executor: %+v", resolved.Source)
	}
	emptyCaptures, _ := json.Marshal(directorCaptureDocument{Version: 1, Items: []directorCaptureRecord{}})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, directorCaptureStateKey, emptyCaptures); err != nil {
		t.Fatal(err)
	}
	projectWithoutCapture, _ := json.Marshal(map[string]any{"nodes": []any{
		map[string]any{"id": "director-main", "type": "director", "metadata": map[string]any{}},
		map[string]any{"id": "config-main", "type": "config", "metadata": map[string]any{
			"referenceStorageKeys": []string{"image:director-shot-source"}, "directorShot": map[string]any{
				"role": "config", "directorNodeId": "director-main", "captureId": "capture-main", "snapshot": json.RawMessage(shot),
			},
		}},
	}, "edges": []any{}})
	if err := backend.PutProject(context.Background(), store.DefaultTenantID, "board-1", projectWithoutCapture); err != nil {
		t.Fatal(err)
	}
	var retry map[string]any
	if json.Unmarshal(body, &retry) != nil {
		t.Fatal("decode retry fixture")
	}
	retry["id"] = "job-director-shot-retry"
	retryBody, _ := json.Marshal(retry)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/image", retryBody); got.Code != http.StatusAccepted {
		t.Fatalf("durable director retry after tray deletion status=%d body=%s", got.Code, got.Body.String())
	}

	parameters.Source.CameraID = "../unsafe"
	input := createImageJobRequest{ID: "job-invalid-source", ProjectID: "board-1", Prompt: "draw", ProviderID: "image-main", Model: "image", Parameters: createImageJobParameters{Size: "1024x1024", Count: 1, Source: parameters.Source}}
	if validCreateImageJob(input) {
		t.Fatal("unsafe director source should be rejected")
	}

	var mismatched map[string]any
	if json.Unmarshal(body, &mismatched) != nil {
		t.Fatal("decode request fixture")
	}
	mismatched["id"] = "job-mismatched-source"
	parametersMap := mismatched["parameters"].(map[string]any)
	sourceMap := parametersMap["source"].(map[string]any)
	sourceMap["captureId"] = "capture-other"
	mismatchedBody, _ := json.Marshal(mismatched)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/image", mismatchedBody); got.Code != http.StatusBadRequest {
		t.Fatalf("mismatched director source status=%d body=%s", got.Code, got.Body.String())
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
	if upstream.APIKey != "sk-private" || upstream.BaseURL != "https://images.example/v1" ||
		upstream.Prompt != "be concise\n\na red square" || upstream.ProviderTimeout != 90*time.Second {
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

func TestServerImageJobSurfacesSafeProviderHTTPStatus(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	created := postImageJob(t, handler, "job-provider-unavailable-image", "fail upstream")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	executor.release <- scriptedImageResult{err: &imageProviderHTTPError{StatusCode: http.StatusBadGateway}}
	server.generationWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-provider-unavailable-image")
	if err != nil || job.Status != "failed" || job.Error != "模型服务暂时不可用（HTTP 502），请稍后重试" {
		t.Fatalf("failed job = %#v, %v", job, err)
	}
}

func TestServerImageJobRecordsTransportDetailInAICallLog(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, backend, handler := imageExecutionHandler(t, executor)
	created := postImageJob(t, handler, "job-transport-detail", "fail with EOF")
	if created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	_ = awaitExecutorStart(t, executor)
	executor.release <- scriptedImageResult{err: &url.Error{
		Op: "Post", URL: "https://images.example/v1/images/edits", Err: errors.New("unexpected EOF"),
	}}
	server.generationWG.Wait()

	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-transport-detail")
	if err != nil || job.Error != "模型服务在生成过程中中断了连接，请稍后重试或检查上游网关" {
		t.Fatalf("failed job = %#v, %v", job, err)
	}
	logs, err := backend.ListAICallLogs(context.Background(), store.DefaultTenantID, store.AICallLogQuery{Page: 1, PageSize: 10})
	if err != nil || len(logs.Items) != 1 || !strings.Contains(logs.Items[0].Error, "unexpected EOF") {
		t.Fatalf("ai logs = %#v, %v", logs, err)
	}
}

func TestImageGenerationFailureMessage(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "bad request", err: &imageProviderHTTPError{StatusCode: http.StatusBadRequest}, want: "模型服务拒绝了图片请求（HTTP 400），请检查模型、尺寸和参数"},
		{name: "unauthorized", err: &imageProviderHTTPError{StatusCode: http.StatusUnauthorized}, want: "模型服务鉴权失败（HTTP 401），请检查 API Key"},
		{name: "too large", err: &imageProviderHTTPError{StatusCode: http.StatusRequestEntityTooLarge}, want: "图片请求或参考素材过大（HTTP 413），请减小素材后重试"},
		{name: "rate limited", err: &imageProviderHTTPError{StatusCode: http.StatusTooManyRequests}, want: "模型服务请求过于频繁（HTTP 429），请稍后重试"},
		{name: "gateway timeout", err: &imageProviderHTTPError{StatusCode: http.StatusGatewayTimeout}, want: "图片生成请求超时（HTTP 504），请稍后重试或增大渠道超时时间"},
		{name: "context deadline", err: context.DeadlineExceeded, want: "图片生成请求超时，请稍后重试或增大渠道超时时间"},
		{name: "wrapped context deadline", err: &url.Error{Op: "Post", URL: "https://provider.example/v1/images/edits", Err: context.DeadlineExceeded}, want: "图片生成请求超时，请稍后重试或增大渠道超时时间"},
		{name: "network timeout", err: &url.Error{Op: "Post", URL: "https://provider.example/v1/images/edits", Err: &net.DNSError{Err: "timeout", Name: "provider.example", IsTimeout: true}}, want: "连接模型服务超时，请检查网络或增大渠道超时时间"},
		{name: "http2 response header timeout", err: &url.Error{Op: "Post", URL: "https://provider.example/v1/images/edits", Err: errors.New("http2: timeout awaiting response headers")}, want: "连接模型服务超时，请检查网络或增大渠道超时时间"},
		{name: "upstream connection interrupted", err: &url.Error{Op: "Post", URL: "https://provider.example/v1/images/edits", Err: errors.New("unexpected EOF")}, want: "模型服务在生成过程中中断了连接，请稍后重试或检查上游网关"},
		{name: "network failure", err: &url.Error{Op: "Post", URL: "https://provider.example/v1/images/edits", Err: errors.New("connection reset")}, want: "连接模型服务失败，请检查服务 URL 和网络"},
		{name: "unknown status", err: &imageProviderHTTPError{StatusCode: http.StatusTeapot}, want: "图片生成失败（模型服务 HTTP 418）"},
		{name: "unknown error stays private", err: errors.New("provider failed with sk-private"), want: "图片生成失败，请检查模型服务配置后重试"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := imageGenerationFailureMessage(tt.err); got != tt.want {
				t.Fatalf("imageGenerationFailureMessage() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestProviderRequestIDIsAStableUUID(t *testing.T) {
	first := providerRequestID("job_ffNeMYAT5f")
	second := providerRequestID("job_ffNeMYAT5f")
	if first != second {
		t.Fatalf("request IDs are not stable: %q != %q", first, second)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(first) {
		t.Fatalf("request ID = %q, want RFC 4122 UUID", first)
	}
	if first == providerRequestID("job_ZZETNyLZkk") {
		t.Fatal("different jobs must not share a provider request ID")
	}
}

func TestImageGenerationFailureLogDetailIncludesSanitizedTransportReason(t *testing.T) {
	err := &url.Error{
		Op:  "Post",
		URL: "https://provider.example/v1/images/edits?api_key=sk-private",
		Err: errors.New(`Post "https://provider.example/v1/images/edits?api_key=sk-private": http2: timeout awaiting response headers`),
	}
	detail := imageGenerationFailureLogDetail(err)
	if !strings.Contains(detail, "network timeout") || !strings.Contains(detail, "timeout awaiting response headers") {
		t.Fatalf("transport detail = %q", detail)
	}
	if strings.Contains(detail, "provider.example") || strings.Contains(detail, "sk-private") {
		t.Fatalf("transport detail leaked provider URL: %q", detail)
	}
}

func TestImageGenerationFailureLogDetailIdentifiesNetworkCauseWithoutURL(t *testing.T) {
	err := &url.Error{
		Op:  "Post",
		URL: "https://provider.example/v1/images/edits?api_key=sk-private",
		Err: &net.OpError{
			Op:  "dial",
			Net: "tcp",
			Err: &net.DNSError{
				Err:       "timeout",
				Name:      "provider.example",
				IsTimeout: true,
			},
		},
	}
	detail := imageGenerationFailureLogDetail(err)
	if !strings.Contains(detail, "network timeout") || !strings.Contains(detail, "*net.DNSError") {
		t.Fatalf("network detail = %q", detail)
	}
	if strings.Contains(detail, "provider.example") || strings.Contains(detail, "sk-private") {
		t.Fatalf("network detail leaked provider URL: %q", detail)
	}
}

// The sanitized detail is appended to the audit log's error text column.
// Postgres rejects invalid UTF-8 there, so a cut that splits a multibyte rune
// fails the whole INSERT and loses the audit row for the failure.
func TestSanitizedNetworkErrorTruncatesOnRuneBoundary(t *testing.T) {
	err := &url.Error{
		Op:  "Post",
		URL: "https://provider.example/v1/images/edits",
		// A proxy or resolver can echo non-ASCII text; "网" is 3 bytes, so a
		// 256-byte cut cannot land on a rune boundary.
		Err: errors.New(strings.Repeat("网", 200)),
	}
	detail := sanitizedNetworkError(err.Err)
	if !utf8.ValidString(detail) {
		t.Fatalf("sanitized detail is not valid UTF-8: %q", detail)
	}
	if !strings.HasSuffix(detail, "…") {
		t.Fatalf("sanitized detail lost its truncation marker: %q", detail)
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
	if got := putConfigSecrets(t, seedRouter, []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)); got.Code != http.StatusNoContent {
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
	if got := putConfigSecrets(t, routerA, []byte(`{"apiKeys":{"image-main":{"image":"sk-private"}},"webdavPass":""}`)); got.Code != http.StatusNoContent {
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
