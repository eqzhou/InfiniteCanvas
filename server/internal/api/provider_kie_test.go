package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKIEUploadBaseURLTrustBoundary(t *testing.T) {
	tests := []struct {
		name      string
		baseURL   string
		override  string
		want      string
		wantError bool
	}{
		{name: "official exact host", baseURL: "https://api.kie.ai", want: kieDefaultUploadBaseURL},
		{name: "official default port", baseURL: "https://api.kie.ai:443", want: kieDefaultUploadBaseURL},
		{name: "official unexpected port", baseURL: "https://api.kie.ai:8443", wantError: true},
		{name: "official host with API path", baseURL: "https://api.kie.ai/api/v1", want: kieDefaultUploadBaseURL},
		{name: "custom provider", baseURL: "https://kie-proxy.example/v2", want: "https://kie-proxy.example/v2"},
		{name: "malicious official suffix", baseURL: "https://api.kie.ai.evil.example", want: "https://api.kie.ai.evil.example"},
		{name: "test override", baseURL: "https://api.kie.ai", override: "https://127.0.0.1:8443", want: "https://127.0.0.1:8443"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := kieReferenceUploadBaseURL(test.baseURL, test.override)
			if test.wantError {
				if err == nil {
					t.Fatalf("upload base = %q; expected an error", got)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("upload base = %q, %v; want %q", got, err, test.want)
			}
		})
	}
	if newOpenAIImageExecutor().kieUploadBaseURL != "" || newHTTPVideoExecutor().kieUploadBaseURL != "" {
		t.Fatal("production executors must not pin custom providers to the official upload host")
	}
}

func TestKIERetryClassificationIsBounded(t *testing.T) {
	for _, status := range []int{http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway} {
		if delay, retry := retryKIEPoll(&kieHTTPError{StatusCode: status}, time.Second); !retry || delay != time.Second {
			t.Fatalf("status %d retry = %s, %v", status, delay, retry)
		}
	}
	if _, retry := retryKIEPoll(&kieHTTPError{StatusCode: http.StatusBadRequest}, time.Second); retry {
		t.Fatal("400 was classified as retryable")
	}
	if delay, retry := retryKIEPoll(&kieHTTPError{StatusCode: http.StatusTooManyRequests, RetryAfter: 30 * time.Second}, time.Second); !retry || delay != 30*time.Second {
		t.Fatalf("Retry-After retry = %s, %v", delay, retry)
	}
	if delay, retry := retryKIEPoll(&url.Error{Op: "Get", URL: "https://api.kie.ai", Err: errors.New("temporary")}, time.Second); !retry || delay != time.Second {
		t.Fatalf("transport retry = %s, %v", delay, retry)
	}
	if got := kieRetryAfter("999", time.Now()); got != 30*time.Second {
		t.Fatalf("Retry-After cap = %s", got)
	}
	now := time.Date(2026, time.July, 26, 12, 0, 0, 0, time.UTC)
	if got := kieRetryAfter(now.Add(4*time.Second).Format(http.TimeFormat), now); got != 4*time.Second {
		t.Fatalf("HTTP-date Retry-After = %s", got)
	}
}

func TestKIEVideoPollRetriesTransientErrorsWithBoundedAttemptsAndContext(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/jobs/createTask":
			_, _ = io.WriteString(w, `{"code":200,"data":{"taskId":"task_retry"}}`)
		case "/api/v1/jobs/recordInfo":
			polls.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	executor := newHTTPVideoExecutor()
	executor.client = noRedirectClient(server.Client())
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	_, err := executor.Generate(context.Background(), videoGenerationRequest{
		Protocol: "kie", BaseURL: server.URL, APIKey: "token", Model: "model", Prompt: "move",
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil || polls.Load() != kieMaxConsecutivePollRetries+1 {
		t.Fatalf("polls=%d err=%v", polls.Load(), err)
	}

	polls.Store(0)
	retryAfterServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/jobs/createTask":
			_, _ = io.WriteString(w, `{"code":200,"data":{"taskId":"task_retry_after"}}`)
		case "/api/v1/jobs/recordInfo":
			polls.Add(1)
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			http.NotFound(w, r)
		}
	}))
	defer retryAfterServer.Close()
	executor.client = noRedirectClient(retryAfterServer.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = executor.Generate(ctx, videoGenerationRequest{
		Protocol: "kie", BaseURL: retryAfterServer.URL, APIKey: "token", Model: "model", Prompt: "move",
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if !errors.Is(err, context.DeadlineExceeded) || polls.Load() != 1 {
		t.Fatalf("Retry-After context polls=%d err=%v", polls.Load(), err)
	}
}

func TestKIEImageCreateUploadPollDownloadAndResume(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	var creates, uploads, polls atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/result.png" && r.Header.Get("Authorization") != "Bearer kie-secret" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/api/file-stream-upload":
			uploads.Add(1)
			file, header, err := r.FormFile("file")
			if err != nil || header.Filename != "reference-1.png" || r.FormValue("uploadPath") != "images/user-uploads" {
				t.Fatalf("upload file=%#v path=%q err=%v", header, r.FormValue("uploadPath"), err)
			}
			value, _ := io.ReadAll(file)
			_ = file.Close()
			if string(value) != string(png) {
				t.Fatal("uploaded reference changed")
			}
			_, _ = io.WriteString(w, `{"success":true,"code":200,"data":{"downloadUrl":"`+upstream.URL+`/temporary/reference.png","mimeType":"image/png"}}`)
		case "/api/v1/jobs/createTask":
			creates.Add(1)
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Fatal("invalid create JSON")
			}
			input, _ := body["input"].(map[string]any)
			refs, _ := input["image_urls"].([]any)
			if body["model"] != "seedream-v4-text-to-image" || input["prompt"] != "draw" || input["aspect_ratio"] != "1:1" || input["resolution"] != "2K" || len(refs) != 1 {
				t.Fatalf("create body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"code":200,"msg":"success","data":{"taskId":"task_kie_image_1"}}`)
		case "/api/v1/jobs/recordInfo":
			polls.Add(1)
			if r.URL.Query().Get("taskId") != "task_kie_image_1" {
				t.Fatalf("taskId = %q", r.URL.Query().Get("taskId"))
			}
			result, _ := json.Marshal(map[string]any{"resultUrls": []string{upstream.URL + "/result.png"}})
			payload, _ := json.Marshal(map[string]any{"code": 200, "data": map[string]any{"taskId": "task_kie_image_1", "state": "success", "resultJson": string(result)}})
			_, _ = w.Write(payload)
		case "/result.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	executor := newOpenAIImageExecutor()
	executor.client = noRedirectClient(upstream.Client())
	executor.kiePollInterval = 0
	executor.kieMaxDuration = time.Second
	request := imageGenerationRequest{Protocol: "kie", BaseURL: upstream.URL, APIKey: "kie-secret", Model: "seedream-v4-text-to-image", Prompt: "draw", Size: "1024x1024", Resolution: "2K", Count: 1, References: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	var checkpoint videoProviderCheckpoint
	images, err := executor.GenerateResumable(context.Background(), request, nil, func(value videoProviderCheckpoint) error {
		checkpoint = value
		return nil
	})
	if err != nil || len(images) != 1 || checkpoint != (videoProviderCheckpoint{Protocol: "kie", TaskID: "task_kie_image_1"}) {
		t.Fatalf("images=%d checkpoint=%#v err=%v", len(images), checkpoint, err)
	}
	if _, err = executor.GenerateResumable(context.Background(), request, &checkpoint, func(videoProviderCheckpoint) error {
		t.Fatal("resume must not save another checkpoint")
		return nil
	}); err != nil || creates.Load() != 1 || uploads.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("creates=%d uploads=%d polls=%d err=%v", creates.Load(), uploads.Load(), polls.Load(), err)
	}
}

func TestKIEFansOutCountAsSingleImageTasks(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	var creates atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/jobs/createTask":
			creates.Add(1)
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Fatal("invalid create JSON")
			}
			input, _ := body["input"].(map[string]any)
			if _, ok := input["num_images"]; ok {
				t.Fatalf("fan-out still sent num_images: %#v", body)
			}
			_, _ = io.WriteString(w, fmt.Sprintf(`{"code":200,"data":{"taskId":"task_kie_image_%d"}}`, creates.Load()))
		case "/api/v1/jobs/recordInfo":
			taskID := r.URL.Query().Get("taskId")
			result, _ := json.Marshal(map[string]any{"resultUrls": []string{upstream.URL + "/result.png"}})
			payload, _ := json.Marshal(map[string]any{"code": 200, "data": map[string]any{"taskId": taskID, "state": "success", "resultJson": string(result)}})
			_, _ = w.Write(payload)
		case "/result.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	executor := newOpenAIImageExecutor()
	executor.client = noRedirectClient(upstream.Client())
	executor.kiePollInterval = 0
	executor.kieMaxDuration = 5 * time.Second
	images, err := executor.Generate(context.Background(), imageGenerationRequest{
		Protocol: "kie", BaseURL: upstream.URL, APIKey: "token",
		Model: "seedream-v4-text-to-image", Prompt: "draw", Size: "1024x1024", Count: 2,
	})
	if err != nil || len(images) != 2 {
		t.Fatalf("images=%#v err=%v", images, err)
	}
	if creates.Load() != 2 {
		t.Fatalf("creates=%d, want 2", creates.Load())
	}
}

func TestKIEVideoCreatePollResultJSONAndResume(t *testing.T) {
	var creates atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/jobs/createTask":
			creates.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			input, _ := body["input"].(map[string]any)
			if body["model"] != "grok-imagine-video-1-5-preview" || input["prompt"] != "move" || input["duration"] != float64(8) || input["resolution"] != "480p" || input["aspect_ratio"] != "16:9" {
				t.Fatalf("create body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"code":200,"data":{"taskId":"task_kie_video_1"}}`)
		case "/api/v1/jobs/recordInfo":
			result, _ := json.Marshal(map[string]any{"resultUrls": []string{upstream.URL + "/out.mp4"}})
			payload, _ := json.Marshal(map[string]any{"code": 505, "msg": "success", "data": map[string]any{"state": "success", "progress": 100, "resultJson": string(result)}})
			_, _ = w.Write(payload)
		case "/out.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	executor := newHTTPVideoExecutor()
	executor.client = noRedirectClient(upstream.Client())
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	request := videoGenerationRequest{Protocol: "kie", BaseURL: upstream.URL, APIKey: "secret", Model: "grok-imagine-video-1-5-preview", Prompt: "move", Seconds: 8, Ratio: "16:9", Resolution: "480p"}
	var checkpoint videoProviderCheckpoint
	media, err := executor.Generate(context.Background(), request, nil, func(value videoProviderCheckpoint) error { checkpoint = value; return nil })
	if err != nil || media.MIMEType != "video/mp4" || checkpoint.Protocol != "kie" {
		t.Fatalf("media=%#v checkpoint=%#v err=%v", media, checkpoint, err)
	}
	if _, err = executor.Generate(context.Background(), request, &checkpoint, func(videoProviderCheckpoint) error { return errors.New("unexpected save") }); err != nil || creates.Load() != 1 {
		t.Fatalf("creates=%d err=%v", creates.Load(), err)
	}
}

func TestKIERejectsUnsafeReferencesRedirectsAndSensitiveErrors(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	client := noRedirectClient(http.DefaultClient)
	if _, err := uploadKIEReferences(context.Background(), client, "https://kieai.redpandaai.co", "secret", []generatedMedia{{Data: png, MIMEType: "text/plain"}}); err == nil {
		t.Fatal("MIME mismatch accepted")
	}
	if _, err := uploadKIEReferences(context.Background(), client, "https://kieai.redpandaai.co", "secret", []generatedMedia{{Data: make([]byte, kieMaxImageReferenceBytes+1), MIMEType: "image/png"}}); err == nil {
		t.Fatal("oversized image accepted")
	}
	if _, err := kieAPIEndpoint("http://169.254.169.254", "/api/v1/jobs/createTask"); err == nil {
		t.Fatal("unsafe KIE base URL accepted")
	}

	secret := "sk-kie-super-secret"
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/jobs/createTask" {
			w.Header().Set("Location", "https://example.com/stolen?token="+secret)
			w.WriteHeader(http.StatusTemporaryRedirect)
			_, _ = io.WriteString(w, `{"msg":"`+secret+`"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	executor := newOpenAIImageExecutor()
	executor.client = noRedirectClient(upstream.Client())
	executor.kiePollInterval = 0
	executor.kieMaxDuration = time.Second
	_, err := executor.GenerateResumable(context.Background(), imageGenerationRequest{Protocol: "kie", BaseURL: upstream.URL, APIKey: secret, Model: "model", Prompt: "x", Size: "1:1", Count: 1}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("error = %v", err)
	}
}

func TestKIENormalizesStatesAndResultJSON(t *testing.T) {
	for _, state := range []string{"waiting", "queuing", "generating"} {
		status, urls, err := normalizeKIETask(map[string]any{"data": map[string]any{"state": state, "resultJson": ""}})
		if err != nil || status != kieTaskPending || len(urls) != 0 {
			t.Fatalf("state=%q status=%v urls=%v err=%v", state, status, urls, err)
		}
	}
	status, _, err := normalizeKIETask(map[string]any{"data": map[string]any{"state": "fail", "failMsg": "secret upstream detail"}})
	if status != kieTaskFailed || err == nil || strings.Contains(err.Error(), "secret upstream detail") {
		t.Fatalf("status=%v err=%v", status, err)
	}
	if _, _, err := normalizeKIETask(map[string]any{"data": map[string]any{"state": "success", "resultJson": `{"resultUrls":["http://169.254.169.254/private"]}`}}); err == nil {
		t.Fatal("unsafe result URL accepted")
	}
}

func TestKIECreateResponseRequiresSuccessCodeAndValidCheckpoint(t *testing.T) {
	if taskID := kieCreatedTaskID(map[string]any{"code": json.Number("401"), "data": map[string]any{"taskId": "task_should_not_run"}}); taskID != "" {
		t.Fatalf("rejected create task id = %q", taskID)
	}
	if taskID := kieCreatedTaskID(map[string]any{"code": json.Number("200"), "data": map[string]any{"taskId": "task_ok"}}); taskID != "task_ok" {
		t.Fatalf("accepted create task id = %q", taskID)
	}
	if !validVideoCheckpoint(videoProviderCheckpoint{Protocol: "kie", TaskID: "task_resume"}) {
		t.Fatal("valid KIE checkpoint rejected")
	}
}

func noRedirectClient(client *http.Client) *http.Client {
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &clone
}
