package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type scriptedVideoStart struct {
	Request    videoGenerationRequest
	Checkpoint *videoProviderCheckpoint
}

type scriptedVideoExecutor struct {
	started          chan scriptedVideoStart
	release          chan scriptedMediaResult
	checkpointOnCall *videoProviderCheckpoint
	cancelled        chan struct{}
	calls            atomic.Int32
}

type scriptedAudioExecutor struct {
	started   chan audioGenerationRequest
	release   chan scriptedMediaResult
	cancelled chan struct{}
	calls     atomic.Int32
}

type scriptedMediaResult struct {
	media generatedMedia
	err   error
}

func newScriptedVideoExecutor(checkpoint *videoProviderCheckpoint) *scriptedVideoExecutor {
	return &scriptedVideoExecutor{
		started: make(chan scriptedVideoStart, 4), release: make(chan scriptedMediaResult, 4),
		checkpointOnCall: checkpoint, cancelled: make(chan struct{}, 4),
	}
}

func (e *scriptedVideoExecutor) Generate(ctx context.Context, request videoGenerationRequest, existing *videoProviderCheckpoint, checkpoint func(videoProviderCheckpoint) error) (generatedMedia, error) {
	e.calls.Add(1)
	if e.checkpointOnCall != nil && existing == nil {
		if err := checkpoint(*e.checkpointOnCall); err != nil {
			return generatedMedia{}, err
		}
	}
	e.started <- scriptedVideoStart{Request: request, Checkpoint: existing}
	select {
	case result := <-e.release:
		return result.media, result.err
	case <-ctx.Done():
		e.cancelled <- struct{}{}
		return generatedMedia{}, ctx.Err()
	}
}

func newScriptedAudioExecutor() *scriptedAudioExecutor {
	return &scriptedAudioExecutor{
		started: make(chan audioGenerationRequest, 4), release: make(chan scriptedMediaResult, 4),
		cancelled: make(chan struct{}, 4),
	}
}

func (e *scriptedAudioExecutor) Generate(ctx context.Context, request audioGenerationRequest) (generatedMedia, error) {
	e.calls.Add(1)
	e.started <- request
	select {
	case result := <-e.release:
		return result.media, result.err
	case <-ctx.Done():
		e.cancelled <- struct{}{}
		return generatedMedia{}, ctx.Err()
	}
}

func mediaExecutionServer(t *testing.T, backend *memoryStore, video videoExecutor, audio audioExecutor) (*Server, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	server.videoExecutor = video
	server.audioExecutor = audio
	config := []byte(`{"channels":[{"id":"media-main","name":"Media","baseUrl":"https://media.example/v1","defaultVideoModel":"seedance-2","defaultAudioModel":"gpt-4o-mini-tts","providers":{"video":{"baseUrl":"https://media.example/api/v3","apiKey":"","model":"seedance-2","protocol":"ark"},"audio":{"baseUrl":"https://media.example/v1","apiKey":"","model":"gpt-4o-mini-tts","protocol":"openai"}}}],"systemPrompt":"cinematic"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	secrets := []byte(`{"apiKeys":{"media-main":{"video":"sk-video-private","audio":"sk-audio-private"}},"webdavPass":""}`)
	if got := request(t, router, http.MethodPut, "/api/secrets/config", secrets); got.Code != http.StatusNoContent {
		t.Fatalf("store secrets: %d %s", got.Code, got.Body.String())
	}
	return server, router
}

func postVideoJob(t *testing.T, handler http.Handler, id string) *responseSnapshot {
	t.Helper()
	body := []byte(`{"id":"` + id + `","projectId":"board-1","prompt":"a moving tiger","providerId":"media-main","model":"seedance-2","parameters":{"size":"1280x720","seconds":5,"ratio":"16:9","resolution":"720p","generateAudio":true,"watermark":false,"referenceStorageKeys":[]}}`)
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/video", body)
	return &responseSnapshot{code: got.Code, body: append([]byte(nil), got.Body.Bytes()...)}
}

func postAudioJob(t *testing.T, handler http.Handler, id string) *responseSnapshot {
	t.Helper()
	body := []byte(`{"id":"` + id + `","projectId":"board-1","prompt":"hello tiger","providerId":"media-main","model":"gpt-4o-mini-tts","parameters":{"voice":"alloy","format":"mp3"}}`)
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/audio", body)
	return &responseSnapshot{code: got.Code, body: append([]byte(nil), got.Body.Bytes()...)}
}

func TestServerMediaTombstonesReturnGone(t *testing.T) {
	backend := newMemoryStore()
	server, handler := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	backend.mu.Lock()
	backend.generationJobCreateErr = store.ErrGone
	backend.mu.Unlock()

	if got := postVideoJob(t, handler, "job-video-gone"); got.code != http.StatusGone {
		t.Fatalf("video create status = %d, want 410: %s", got.code, got.body)
	}
	if got := postAudioJob(t, handler, "job-audio-gone"); got.code != http.StatusGone {
		t.Fatalf("audio create status = %d, want 410: %s", got.code, got.body)
	}
}

func minimalMP4() []byte {
	return []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0, 'i', 's', 'o', 'm', 'm', 'p', '4', '2', 0, 0, 0, 8, 'm', 'd', 'a', 't'}
}

func TestGeneratedMediaValidationRejectsHeaderOnlyMP4(t *testing.T) {
	header := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0, 'i', 's', 'o', 'm', 'm', 'p', '4', '2'}
	if _, err := validateGeneratedMedia("video", generatedMedia{Data: header, MIMEType: "video/mp4"}); err == nil {
		t.Fatal("header-only MP4 accepted")
	}
}

func TestServerVideoJobCheckpointsAndPersistsProtectedResult(t *testing.T) {
	backend := newMemoryStore()
	checkpoint := &videoProviderCheckpoint{Protocol: "ark", TaskID: "upstream-task-1"}
	video := newScriptedVideoExecutor(checkpoint)
	server, handler := mediaExecutionServer(t, backend, video, newScriptedAudioExecutor())
	t.Cleanup(server.Close)

	created := postVideoJob(t, handler, "job-video")
	if created.code != http.StatusAccepted || !bytes.Contains(created.body, []byte(`"status": "queued"`)) {
		t.Fatalf("create video: %d %s", created.code, created.body)
	}
	var started scriptedVideoStart
	select {
	case started = <-video.started:
	case <-time.After(time.Second):
		t.Fatal("video executor did not start")
	}
	if started.Checkpoint != nil || started.Request.APIKey != "sk-video-private" || started.Request.Protocol != "ark" || started.Request.Prompt != "cinematic\n\na moving tiger" {
		t.Fatalf("video request = %#v", started)
	}
	running, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-video")
	if err != nil || !bytes.Contains(running.Result, []byte(`"taskId":"upstream-task-1"`)) {
		t.Fatalf("checkpointed job = %#v, %v", running, err)
	}
	video.release <- scriptedMediaResult{media: generatedMedia{Data: minimalMP4(), MIMEType: "video/mp4"}}
	server.videoWG.Wait()
	completed, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-video")
	if err != nil || completed.Status != "succeeded" || !bytes.Contains(completed.Result, []byte(`"mimeType":"video/mp4"`)) {
		t.Fatalf("completed job = %#v, %v", completed, err)
	}
	var result struct {
		Items []struct {
			StorageKey string `json:"storageKey"`
		} `json:"items"`
	}
	if json.Unmarshal(completed.Result, &result) != nil || len(result.Items) != 1 || result.Items[0].StorageKey == "" {
		t.Fatalf("video result = %s", completed.Result)
	}
	stored, err := server.readTenantBlob(context.Background(), store.DefaultTenantID, result.Items[0].StorageKey, maxUploadBytes)
	if err != nil || !bytes.Equal(stored.Data, minimalMP4()) {
		t.Fatalf("stored video = %#v, %v", stored, err)
	}
}

func TestServerVideoWorkerResumesCheckpointWithoutRecreatingTask(t *testing.T) {
	backend := newMemoryStore()
	first := newScriptedVideoExecutor(&videoProviderCheckpoint{Protocol: "ark", TaskID: "resume-task"})
	serverA, handlerA := mediaExecutionServer(t, backend, first, newScriptedAudioExecutor())
	if created := postVideoJob(t, handlerA, "job-video-resume"); created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	select {
	case <-first.started:
	case <-time.After(time.Second):
		t.Fatal("first video executor did not start")
	}
	serverA.Close()
	backend.mu.Lock()
	job := backend.jobs[tenantKey(store.DefaultTenantID, "job-video-resume")]
	job.LeaseExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	backend.jobs[tenantKey(store.DefaultTenantID, job.ID)] = job
	backend.mu.Unlock()

	second := newScriptedVideoExecutor(nil)
	serverB, _ := mediaExecutionServer(t, backend, second, newScriptedAudioExecutor())
	t.Cleanup(serverB.Close)
	var resumed scriptedVideoStart
	select {
	case resumed = <-second.started:
	case <-time.After(2 * time.Second):
		t.Fatal("recovered video executor did not start")
	}
	if resumed.Checkpoint == nil || resumed.Checkpoint.TaskID != "resume-task" {
		t.Fatalf("resume checkpoint = %#v", resumed.Checkpoint)
	}
	second.release <- scriptedMediaResult{media: generatedMedia{Data: minimalMP4(), MIMEType: "video/mp4"}}
	serverB.videoWG.Wait()
}

func TestServerVideoJobResolvesRestrictedTemplateWithoutExposingSecret(t *testing.T) {
	backend := newMemoryStore()
	video := newScriptedVideoExecutor(nil)
	server, handler := mediaExecutionServer(t, backend, video, newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	config := []byte(`{"channels":[{"id":"media-main","defaultVideoModel":"relay-video","providers":{"video":{"baseUrl":"https://relay.example/v2","model":"relay-video","protocol":"template","template":{"method":"PUT","path":"/render-video","auth":"x-api-key","request":{"prompt":"{{prompt}}","size":"{{size}}","duration":"{{duration}}"},"responsePath":"output.url"}}}}],"systemPrompt":"template cinema"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	if created := postVideoJob(t, handler, "job-template-video"); created.code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.code, created.body)
	}
	var started scriptedVideoStart
	select {
	case started = <-video.started:
	case <-time.After(time.Second):
		t.Fatal("template video executor did not start")
	}
	if started.Request.Protocol != "template" || started.Request.Template == nil ||
		started.Request.Template.Path != "/render-video" || started.Request.Size != "1280x720" ||
		started.Request.APIKey != "sk-video-private" || started.Request.Prompt != "template cinema\n\na moving tiger" {
		t.Fatalf("template video request = %#v", started)
	}
	video.release <- scriptedMediaResult{media: generatedMedia{Data: minimalMP4(), MIMEType: "video/mp4"}}
	server.videoWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-template-video")
	if err != nil || job.Status != "succeeded" || bytes.Contains(job.Parameters, []byte("sk-video-private")) || bytes.Contains(job.Result, []byte("sk-video-private")) {
		t.Fatalf("template video job=%#v err=%v", job, err)
	}
}

func TestServerAudioJobPersistsResultAndSanitizesFailure(t *testing.T) {
	backend := newMemoryStore()
	audio := newScriptedAudioExecutor()
	server, handler := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), audio)
	t.Cleanup(server.Close)
	if created := postAudioJob(t, handler, "job-audio"); created.code != http.StatusAccepted {
		t.Fatalf("create audio: %d %s", created.code, created.body)
	}
	select {
	case started := <-audio.started:
		if started.APIKey != "sk-audio-private" || started.Voice != "alloy" || started.Format != "mp3" {
			t.Fatalf("audio request = %#v", started)
		}
	case <-time.After(time.Second):
		t.Fatal("audio executor did not start")
	}
	audio.release <- scriptedMediaResult{media: generatedMedia{Data: []byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0}, MIMEType: "audio/mpeg"}}
	server.audioWG.Wait()
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-audio")
	if err != nil || job.Status != "succeeded" || !bytes.Contains(job.Result, []byte(`"mimeType":"audio/mpeg"`)) {
		t.Fatalf("audio job = %#v, %v", job, err)
	}

	if created := postAudioJob(t, handler, "job-audio-failed"); created.code != http.StatusAccepted {
		t.Fatalf("create failed audio: %d %s", created.code, created.body)
	}
	select {
	case <-audio.started:
	case <-time.After(time.Second):
		t.Fatal("second audio executor did not start")
	}
	audio.release <- scriptedMediaResult{err: errors.New("provider leaked sk-audio-private")}
	server.audioWG.Wait()
	failed, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-audio-failed")
	if err != nil || failed.Status != "failed" || bytes.Contains([]byte(failed.Error), []byte("sk-audio-private")) {
		t.Fatalf("failed audio = %#v, %v", failed, err)
	}
}

func TestServerMediaEndpointsRejectInvalidParameters(t *testing.T) {
	backend := newMemoryStore()
	server, handler := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	for path, body := range map[string]string{
		"/api/generation-jobs/video": `{"id":"bad-video","prompt":"x","providerId":"media-main","parameters":{"seconds":99,"ratio":"javascript:bad","resolution":"8k"}}`,
		"/api/generation-jobs/audio": `{"id":"bad-audio","prompt":"x","providerId":"media-main","parameters":{"voice":"../bad","format":"exe"}}`,
	} {
		got := request(t, handler, http.MethodPost, path, []byte(body))
		if got.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s accepted: %d %s", path, got.Code, got.Body.String())
		}
	}
}

func TestVideoJobInputAllowsOnlyDocumentedPromptlessFirstFrameModes(t *testing.T) {
	base := createVideoJobRequest{
		ID: "job-first-frame", ProjectID: "board-1", ProviderID: "media-main",
		Parameters: createVideoJobParameters{
			Seconds: 5, Ratio: "16:9", Resolution: "720p",
			ReferenceStorageKeys: []string{"image:first-frame"},
		},
	}
	happyHorse := base
	happyHorse.Model = "happyhorse-1.1"
	happyHorse.Parameters.FrameMode = "first-last"
	if !validCreateVideoJob(happyHorse) {
		t.Fatal("HappyHorse first-frame-only job was rejected at the HTTP boundary")
	}
	happyHorse.Parameters.FrameMode = "references"
	if validCreateVideoJob(happyHorse) {
		t.Fatal("HappyHorse reference-to-video job accepted an empty prompt")
	}
	kling := base
	kling.Model = "kling-3.0-turbo"
	if !validCreateVideoJob(kling) {
		t.Fatal("Kling Turbo first-frame-only job was rejected at the HTTP boundary")
	}
	kling.Parameters.ReferenceStorageKeys = nil
	if validCreateVideoJob(kling) {
		t.Fatal("Kling Turbo text-to-video job accepted an empty prompt")
	}
}

func TestResolveMediaRequestKeepsDocumentedPromptlessFirstFrameJob(t *testing.T) {
	backend := newMemoryStore()
	server, handler := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	config := []byte(`{"channels":[{"id":"media-main","name":"APIMart","baseUrl":"https://api.apimart.ai/v1","providers":{"video":{"baseUrl":"https://api.apimart.ai/v1","apiKey":"","model":"happyhorse-1.1","protocol":"apimart"}}}],"systemPrompt":""}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	put := httptest.NewRequest(http.MethodPut, "/api/blobs/image%3Afirst-frame", bytes.NewReader(apimartPNG(t)))
	put.Header.Set("Content-Type", "image/png")
	putResult := httptest.NewRecorder()
	handler.ServeHTTP(putResult, put)
	if putResult.Code != http.StatusNoContent {
		t.Fatalf("store first frame: %d %s", putResult.Code, putResult.Body.String())
	}
	parameters, err := json.Marshal(persistedMediaJobParameters{
		Executor: serverExecutorMarker, Seconds: 5, Ratio: "16:9", Resolution: "720p",
		FrameMode: "first-last", ReferenceStorageKeys: []string{"image:first-frame"},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := server.resolveMediaGenerationRequest(context.Background(), store.DefaultTenantID, store.GenerationJob{
		ID: "job-resolve-first-frame", Kind: "video", Status: "queued", ProviderID: "media-main",
		Model: "happyhorse-1.1", Parameters: parameters, Result: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("resolve promptless first-frame job: %v", err)
	}
	if resolved.Video.Prompt != "" || resolved.Video.Model != "happyhorse-1.1" || len(resolved.Video.References) != 1 {
		t.Fatalf("resolved first-frame request = %#v", resolved.Video)
	}
}
