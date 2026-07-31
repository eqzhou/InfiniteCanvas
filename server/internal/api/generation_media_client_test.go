package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const azureHeaderFixture = "fixture-value"

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

func TestHTTPAudioExecutorForwardsSpeedAndInstructions(t *testing.T) {
	var body map[string]any
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body = nil
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0})
	}))
	defer upstream.Close()
	executor := newHTTPAudioExecutor()
	executor.client = upstream.Client()

	if _, err := executor.Generate(context.Background(), audioGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-audio", Model: "tts", Prompt: "hello",
		Voice: "verse", Format: "wav", Speed: 1.5, Instructions: "read briskly",
	}); err != nil {
		t.Fatalf("speech with speed/instructions failed: %v", err)
	}
	if body["speed"] != 1.5 || body["instructions"] != "read briskly" {
		t.Fatalf("body = %#v", body)
	}

	// Unset optional fields must be omitted so provider defaults apply.
	if _, err := executor.Generate(context.Background(), audioGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-audio", Model: "tts", Prompt: "hello",
		Voice: "alloy", Format: "mp3",
	}); err != nil {
		t.Fatalf("plain speech failed: %v", err)
	}
	if _, ok := body["speed"]; ok {
		t.Fatalf("speed must be omitted when unset: %#v", body)
	}
	if _, ok := body["instructions"]; ok {
		t.Fatalf("instructions must be omitted when unset: %#v", body)
	}

	// Out-of-range speed must fail before any provider request.
	for _, speed := range []float64{0.2, 4.5} {
		if _, err := executor.Generate(context.Background(), audioGenerationRequest{
			BaseURL: upstream.URL + "/v1", APIKey: "sk-audio", Model: "tts", Prompt: "hello",
			Voice: "alloy", Format: "mp3", Speed: speed,
		}); err == nil {
			t.Fatalf("speed %v accepted", speed)
		}
	}
}

func TestHTTPAudioExecutorAzureSpeechUsesSSMLAndSubscriptionKey(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cognitiveservices/v1" || r.Method != http.MethodPost {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Ocp-Apim-Subscription-Key"); got != azureHeaderFixture {
			t.Fatalf("subscription key = %q", got)
		}
		if got := r.Header.Get("X-Microsoft-OutputFormat"); got != "riff-24khz-16bit-mono-pcm" {
			t.Fatalf("output format = %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/ssml+xml" {
			t.Fatalf("content type = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		ssml := string(body)
		if !strings.Contains(ssml, `voice name="zh-CN-XiaoxiaoNeural"`) ||
			!strings.Contains(ssml, "你好 &amp; &lt;世界&gt;") || strings.Contains(ssml, "<世界>") {
			t.Fatalf("SSML = %s", ssml)
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write([]byte("RIFF\x04\x00\x00\x00WAVE"))
	}))
	defer upstream.Close()
	executor := newHTTPAudioExecutor()
	executor.client = upstream.Client()
	media, err := executor.Generate(context.Background(), audioGenerationRequest{
		Protocol: "azure", BaseURL: upstream.URL, APIKey: azureHeaderFixture, Model: "azure-neural-tts",
		Prompt: "你好 & <世界>", Voice: "zh-CN-XiaoxiaoNeural", Format: "wav", Speed: 1.25,
	})
	if err != nil || media.MIMEType != "audio/wav" || !bytes.HasPrefix(media.Data, []byte("RIFF")) {
		t.Fatalf("media = %#v, err = %v", media, err)
	}
}

func TestEdgeSpeechProtocolHelpers(t *testing.T) {
	when := time.Date(2026, time.July, 31, 10, 2, 0, 0, time.UTC)
	first := edgeSecMSGECToken(when)
	second := edgeSecMSGECToken(when.Add(2 * time.Minute))
	third := edgeSecMSGECToken(when.Add(4 * time.Minute))
	if first == "" || first != second || first == third || first != strings.ToUpper(first) {
		t.Fatalf("unexpected rolling tokens: %q %q %q", first, second, third)
	}
	payload := []byte("ID3-audio")
	header := []byte("Path:audio\r\nContent-Type:audio/mpeg")
	headerLength := len(header) + 2
	frame := append([]byte{byte(headerLength >> 8), byte(headerLength)}, append(header, append([]byte("\r\n"), payload...)...)...)
	got, done, err := parseEdgeAudioFrame(frame)
	if err != nil || done || !bytes.Equal(got, payload) {
		t.Fatalf("audio frame = %q done=%v err=%v", got, done, err)
	}
}

func TestHTTPAudioExecutorEdgeSpeechStreamsMP3(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			t.Errorf("accept Edge websocket: %v", err)
			return
		}
		defer connection.CloseNow()
		for index := range 2 {
			messageType, message, readErr := connection.Read(r.Context())
			if readErr != nil || messageType != websocket.MessageText {
				t.Errorf("message %d: type=%v err=%v", index, messageType, readErr)
				return
			}
			if index == 0 && edgeTextPath(message) != "speech.config" {
				t.Errorf("command = %s", message)
			}
			if index == 1 && (edgeTextPath(message) != "ssml" || !bytes.Contains(message, []byte("你好 &amp; 世界"))) {
				t.Errorf("SSML = %s", message)
			}
		}
		headers := []byte("Path:audio\r\nContent-Type:audio/mpeg")
		headerLength := len(headers) + 2
		frame := append([]byte{byte(headerLength >> 8), byte(headerLength)}, append(headers, append([]byte("\r\n"), []byte("ID3-edge-audio")...)...)...)
		if err := connection.Write(r.Context(), websocket.MessageBinary, frame); err != nil {
			t.Errorf("write audio: %v", err)
			return
		}
		_ = connection.Write(r.Context(), websocket.MessageText, []byte("Path:turn.end\r\n\r\n"))
	}))
	defer upstream.Close()
	executor := newHTTPAudioExecutor()
	executor.client = upstream.Client()
	executor.edgeWebSocketURL = "ws" + strings.TrimPrefix(upstream.URL, "http")
	executor.now = func() time.Time { return time.Date(2026, time.July, 31, 10, 2, 0, 0, time.UTC) }
	media, err := executor.Generate(context.Background(), audioGenerationRequest{
		Protocol: "edge", BaseURL: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud",
		Model: "edge-tts", Prompt: "你好 & 世界", Voice: "zh-CN-XiaoxiaoNeural", Format: "mp3",
	})
	if err != nil || media.MIMEType != "audio/mpeg" || string(media.Data) != "ID3-edge-audio" {
		t.Fatalf("media=%#v err=%v", media, err)
	}
}

func TestLiveEdgeSpeech(t *testing.T) {
	if os.Getenv("OPENBOARD_LIVE_EDGE_TTS") != "1" {
		t.Skip("set OPENBOARD_LIVE_EDGE_TTS=1 to exercise Microsoft's public Edge speech service")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	media, err := newHTTPAudioExecutor().Generate(ctx, audioGenerationRequest{
		Protocol: "edge", BaseURL: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud",
		Model: "edge-tts", Prompt: "你好，这是 OpenBoard 云端语音测试。", Voice: "zh-CN-XiaoxiaoNeural", Format: "mp3",
	})
	if err != nil || media.MIMEType != "audio/mpeg" || len(media.Data) < 1_000 {
		t.Fatalf("live Edge speech bytes=%d mime=%q err=%v", len(media.Data), media.MIMEType, err)
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

func TestGenerationResultURLRejectsLoopbackUnlessProviderIsLoopback(t *testing.T) {
	// A provider-returned result URL is attacker controlled. It may only reach a
	// loopback address when the operator deliberately configured a loopback
	// provider endpoint (local development and tests).
	for _, rawURL := range []string{"http://127.0.0.1/result.mp4", "http://localhost:9000/result.mp4"} {
		if _, err := validateGenerationResultURL(rawURL, "https://api.provider.example/v1"); err == nil {
			t.Fatalf("loopback result URL accepted for a public provider: %s", rawURL)
		}
		if _, err := validateGenerationResultURL(rawURL, "http://127.0.0.1:9000/v1"); err != nil {
			t.Fatalf("loopback result URL rejected for a loopback provider: %s (%v)", rawURL, err)
		}
	}
	if _, err := validateGenerationResultURL("https://cdn.example/result.mp4?X-Amz-Signature=abc", "https://api.provider.example/v1"); err != nil {
		t.Fatalf("public presigned result URL rejected: %v", err)
	}
}

func TestGenerationDownloadErrorsNeverCarryTheRequestURL(t *testing.T) {
	// Go's *url.Error embeds the full URL, including presigned query
	// credentials, and workers log provider errors verbatim.
	video := newHTTPVideoExecutor()
	video.client = &http.Client{Transport: failingRoundTripper{}}
	_, err := video.download(context.Background(), "https://cdn.example/result.mp4?X-Amz-Signature=leaked-secret",
		"https://api.provider.example/v1", maxGeneratedVideoBytes)
	if err == nil {
		t.Fatal("expected the transport failure to surface")
	}
	if strings.Contains(err.Error(), "leaked-secret") || strings.Contains(err.Error(), "cdn.example") {
		t.Fatalf("download error leaked the result URL: %v", err)
	}

	image := newOpenAIImageExecutor()
	image.client = &http.Client{Transport: failingRoundTripper{}}
	_, imageErr := image.downloadImage(context.Background(), "https://cdn.example/result.png?X-Amz-Signature=leaked-secret",
		"https://api.provider.example/v1")
	if imageErr == nil {
		t.Fatal("expected the image transport failure to surface")
	}
	if strings.Contains(imageErr.Error(), "leaked-secret") || strings.Contains(imageErr.Error(), "cdn.example") {
		t.Fatalf("image download error leaked the result URL: %v", imageErr)
	}
}

type failingRoundTripper struct{}

func (failingRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return nil, errors.New("dial tcp: simulated failure")
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

func TestArkReferenceMediaUsesPublicLinksAndFailsClosed(t *testing.T) {
	// Ark pulls reference media from its own network, so local video/audio must
	// travel as a public URL. Without one, inlining megabytes of base64 would
	// silently produce an oversized request instead of a clear failure.
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	mp4 := minimalMP4()

	var body map[string]any
	var resultURL string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/contents/generations/tasks":
			body = nil
			_ = json.NewDecoder(r.Body).Decode(&body)
			_, _ = io.WriteString(w, `{"id":"task-ref"}`)
		case "/result.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(minimalMP4())
		default:
			_, _ = io.WriteString(w, `{"id":"task-ref","status":"succeeded","content":{"video_url":"`+resultURL+`"}}`)
		}
	}))
	defer upstream.Close()
	resultURL = upstream.URL + "/result.mp4"

	executor := newHTTPVideoExecutor()
	executor.client = upstream.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second

	base := videoGenerationRequest{
		BaseURL: upstream.URL + "/api/v3", APIKey: "sk-video", Protocol: "ark", Model: "seedance",
		Prompt: "with references", Seconds: 5, Ratio: "16:9", Resolution: "720p",
	}

	// Video references without a public URL must fail before any request.
	withLocalVideo := base
	withLocalVideo.References = []generatedMedia{{Data: mp4, MIMEType: "video/mp4"}}
	if _, err := executor.Generate(context.Background(), withLocalVideo, nil,
		func(videoProviderCheckpoint) error { return nil }); err == nil {
		t.Fatal("local video reference without a public URL was accepted")
	}

	// A supplied public URL is forwarded verbatim rather than inlined.
	withPublicVideo := base
	withPublicVideo.References = []generatedMedia{{
		Data: mp4, MIMEType: "video/mp4", PublicURL: "https://cdn.example/ref.mp4",
	}}
	if _, err := executor.Generate(context.Background(), withPublicVideo, nil,
		func(videoProviderCheckpoint) error { return nil }); err != nil {
		t.Fatalf("public video reference rejected: %v", err)
	}
	content, _ := body["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content = %#v", body["content"])
	}
	entry, _ := content[1].(map[string]any)
	nested, _ := entry["video_url"].(map[string]any)
	if url, _ := nested["url"].(string); url != "https://cdn.example/ref.mp4" {
		t.Fatalf("reference url = %#v", entry)
	}

	// Images stay inline: Ark accepts data URLs for them and they are small.
	withImage := base
	withImage.References = []generatedMedia{{Data: png, MIMEType: "image/png"}}
	if _, err := executor.Generate(context.Background(), withImage, nil,
		func(videoProviderCheckpoint) error { return nil }); err != nil {
		t.Fatalf("inline image reference rejected: %v", err)
	}
}
