package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPVideoExecutorArkCreateCheckpointPollAndDownload(t *testing.T) {
	var creates atomic.Int32
	var polls atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/contents/generations/tasks":
			creates.Add(1)
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer sk-video" {
				t.Errorf("create request = %s %#v", r.Method, r.Header)
			}
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "seedance" || body["duration"] != float64(5) {
				t.Errorf("create body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"id":"task-ark","status":"queued"}`)
		case "/api/v3/contents/generations/tasks/task-ark":
			polls.Add(1)
			_, _ = io.WriteString(w, `{"id":"task-ark","status":"succeeded","result":{"video_url":"`+upstream.URL+`/result.mp4?signature=read-only"}}`)
		case "/result.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	executor := newHTTPVideoExecutor()
	executor.client = upstream.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	var checkpoint videoProviderCheckpoint
	media, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: upstream.URL + "/api/v3", APIKey: "sk-video", Protocol: "ark", Model: "seedance",
		Prompt: "move", Seconds: 5, Ratio: "16:9", Resolution: "720p",
	}, nil, func(value videoProviderCheckpoint) error {
		checkpoint = value
		return nil
	})
	if err != nil || checkpoint.TaskID != "task-ark" || media.MIMEType != "video/mp4" || string(media.Data) != string(minimalMP4()) {
		t.Fatalf("media = %#v, checkpoint = %#v, err = %v", media, checkpoint, err)
	}
	if creates.Load() != 1 || polls.Load() != 1 {
		t.Fatalf("create/poll calls = %d/%d", creates.Load(), polls.Load())
	}

	_, err = executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: upstream.URL + "/api/v3", APIKey: "sk-video", Protocol: "ark", Model: "seedance", Prompt: "move",
	}, &checkpoint, func(videoProviderCheckpoint) error {
		t.Fatal("resumed task must not checkpoint a new provider task")
		return nil
	})
	if err != nil || creates.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("resume err=%v create/poll=%d/%d", err, creates.Load(), polls.Load())
	}
}

func TestHTTPVideoExecutorOpenAICompletedTaskDownloadsContent(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/videos":
			_, _ = io.WriteString(w, `{"id":"video-1","status":"completed"}`)
		case "/v1/videos/video-1/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	executor := newHTTPVideoExecutor()
	executor.client = upstream.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	media, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk", Protocol: "openai", Model: "sora", Prompt: "move",
	}, nil, func(value videoProviderCheckpoint) error {
		if value.TaskID != "video-1" {
			t.Fatalf("checkpoint = %#v", value)
		}
		return nil
	})
	if err != nil || media.MIMEType != "video/mp4" {
		t.Fatalf("media = %#v, %v", media, err)
	}
}

func TestHTTPVideoExecutorRunsRestrictedTemplateWithoutCheckpoint(t *testing.T) {
	var upstream *httptest.Server
	requests := atomic.Int32{}
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/render-video":
			requests.Add(1)
			if r.Method != http.MethodPut || r.Header.Get("x-api-key") != "template-video-secret" || r.Header.Get("Authorization") != "" {
				t.Fatalf("request = %s %#v", r.Method, r.Header)
			}
			var body struct {
				Prompt     string   `json:"prompt"`
				Duration   int      `json:"duration"`
				Ratio      string   `json:"ratio"`
				Resolution string   `json:"resolution"`
				Images     []string `json:"images"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.Prompt != "move safely" || body.Duration != 5 ||
				body.Ratio != "16:9" || body.Resolution != "720p" || len(body.Images) != 1 ||
				!strings.HasPrefix(body.Images[0], "data:image/png;base64,") {
				t.Fatalf("template body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"output":{"url":"`+upstream.URL+`/result.mp4?signature=read-only"}}`)
		case "/result.mp4":
			if r.URL.Query().Get("signature") != "read-only" {
				t.Fatalf("download URL = %s", r.URL.String())
			}
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	pngBytes, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor := newHTTPVideoExecutor()
	executor.client = upstream.Client()
	executor.maxDuration = time.Second
	media, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: upstream.URL + "/v2", APIKey: "template-video-secret", Protocol: "template",
		Model: "relay-video", Prompt: "move safely", Seconds: 5, Ratio: "16:9", Resolution: "720p",
		References: []generatedMedia{{Data: pngBytes, MIMEType: "image/png"}},
		Template: &imageProviderTemplate{
			Method: http.MethodPut, Path: "/render-video", Auth: "x-api-key",
			Request:      json.RawMessage(`{"prompt":"{{prompt}}","duration":"{{duration}}","ratio":"{{ratio}}","resolution":"{{resolution}}","images":"{{referenceImages}}"}`),
			ResponsePath: "output.url",
		},
	}, nil, func(videoProviderCheckpoint) error {
		t.Fatal("synchronous Template video must not create a provider checkpoint")
		return nil
	})
	if err != nil || requests.Load() != 1 || media.MIMEType != "video/mp4" || !bytes.Equal(media.Data, minimalMP4()) {
		t.Fatalf("requests=%d media=%#v err=%v", requests.Load(), media, err)
	}
}

func TestHTTPVideoExecutorTemplateHonorsRedirectAndCancellationBoundaries(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/template-video" {
			http.Redirect(w, r, "/redirected", http.StatusTemporaryRedirect)
			return
		}
		t.Fatal("template video executor followed a redirect")
	}))
	defer redirect.Close()
	executor := newHTTPVideoExecutor()
	executor.maxDuration = time.Second
	request := videoGenerationRequest{
		BaseURL: redirect.URL + "/v1", APIKey: "secret", Protocol: "template", Model: "relay", Prompt: "move",
		Template: &imageProviderTemplate{
			Method: http.MethodPost, Path: "/template-video", Auth: "bearer",
			Request: json.RawMessage(`{"prompt":"{{prompt}}"}`), ResponsePath: "output.url",
		},
	}
	if _, err := executor.Generate(context.Background(), request, nil, func(videoProviderCheckpoint) error { return nil }); err == nil {
		t.Fatal("expected provider redirect to fail")
	}

	started := make(chan struct{})
	release := make(chan struct{})
	blocked := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release
	}))
	defer blocked.Close()
	request.BaseURL = blocked.URL + "/v1"
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := executor.Generate(ctx, request, nil, func(videoProviderCheckpoint) error { return nil })
		result <- err
	}()
	<-started
	cancel()
	select {
	case err := <-result:
		close(release)
		if err == nil {
			t.Fatal("expected cancellation to abort Template request")
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("Template request did not stop after cancellation")
	}
}

func TestHTTPVideoExecutorTemplateRejectsCheckpointAndUnsupportedReference(t *testing.T) {
	executor := newHTTPVideoExecutor()
	executor.maxDuration = time.Second
	request := videoGenerationRequest{
		BaseURL: "https://relay.example/v1", Protocol: "template", Model: "relay", Prompt: "move",
		Template: &imageProviderTemplate{
			Method: http.MethodPost, Path: "/template-video", Auth: "bearer",
			Request: json.RawMessage(`{"files":"{{referenceVideos}}"}`), ResponsePath: "url",
		},
	}
	if _, err := executor.Generate(context.Background(), request,
		&videoProviderCheckpoint{Protocol: "openai", TaskID: "old-task"},
		func(videoProviderCheckpoint) error { return nil }); err == nil {
		t.Fatal("expected synchronous Template video to reject a provider checkpoint")
	}
	request.References = []generatedMedia{{Data: []byte("pdf"), MIMEType: "application/pdf"}}
	if _, err := executor.generateTemplate(context.Background(), request); err == nil {
		t.Fatal("expected unsupported Template video reference to fail before network access")
	}
}

func TestHTTPAudioExecutorSpeechRequestAndBoundedResult(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/speech" || r.Header.Get("Authorization") != "Bearer sk-audio" {
			t.Errorf("request = %s %#v", r.URL.Path, r.Header)
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["input"] != "hello" || body["voice"] != "alloy" || body["response_format"] != "mp3" {
			t.Errorf("body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0})
	}))
	defer upstream.Close()
	executor := newHTTPAudioExecutor()
	executor.client = upstream.Client()
	media, err := executor.Generate(context.Background(), audioGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-audio", Model: "tts", Prompt: "hello", Voice: "alloy", Format: "mp3",
	})
	if err != nil || media.MIMEType != "audio/mpeg" || len(media.Data) != 10 {
		t.Fatalf("media = %#v, %v", media, err)
	}
}

func TestMediaExecutorsRejectUnsafeURLsAndProviderRedirects(t *testing.T) {
	video := newHTTPVideoExecutor()
	video.pollInterval = 0
	video.maxDuration = 50 * time.Millisecond
	if _, err := video.Generate(context.Background(), videoGenerationRequest{
		BaseURL: "http://169.254.169.254", APIKey: "sk", Protocol: "openai", Model: "x", Prompt: "x",
	}, nil, func(videoProviderCheckpoint) error { return nil }); err == nil {
		t.Fatal("unsafe video provider URL accepted")
	}
	audio := newHTTPAudioExecutor()
	if _, err := audio.Generate(context.Background(), audioGenerationRequest{
		BaseURL: "https://user:pass@example.com", APIKey: "sk", Model: "x", Prompt: "x", Voice: "alloy", Format: "mp3",
	}); err == nil {
		t.Fatal("credential-bearing audio provider URL accepted")
	}
}

func TestHTTPVideoExecutorArkFirstLastFrameRoles(t *testing.T) {
	var creates atomic.Int32
	var body map[string]any
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/contents/generations/tasks":
			creates.Add(1)
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Fatalf("decode body failed")
			}
			_, _ = io.WriteString(w, `{"id":"frame-task","status":"succeeded","result":{"video_url":"`+upstream.URL+`/result.mp4"}}`)
		case "/result.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	executor := newHTTPVideoExecutor()
	executor.client = upstream.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	media, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: upstream.URL + "/api/v3", APIKey: "sk-video", Protocol: "ark", Model: "seedance",
		Prompt: "frames", Seconds: 5, Ratio: "16:9", Resolution: "720p", FrameMode: "first-last",
		References: []generatedMedia{
			{Data: append([]byte(nil), png...), MIMEType: "image/png"},
			{Data: append([]byte(nil), png...), MIMEType: "image/png"},
			{Data: append([]byte(nil), png...), MIMEType: "image/png"},
		},
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err != nil || media.MIMEType != "video/mp4" || creates.Load() != 1 {
		t.Fatalf("media=%#v creates=%d err=%v", media, creates.Load(), err)
	}
	content, _ := body["content"].([]any)
	if len(content) != 4 {
		t.Fatalf("content = %#v", body["content"])
	}
	roles := make([]string, 0, 3)
	for _, item := range content[1:] {
		entry, _ := item.(map[string]any)
		role, _ := entry["role"].(string)
		roles = append(roles, role)
	}
	if roles[0] != "first_frame" || roles[1] != "last_frame" || roles[2] != "reference_image" {
		t.Fatalf("roles = %#v", roles)
	}
}
