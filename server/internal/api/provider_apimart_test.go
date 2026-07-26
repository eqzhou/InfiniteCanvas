package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func apimartPNG(t *testing.T) []byte {
	t.Helper()
	value, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestAPIMartVideoCreatePollDownloadAndResume(t *testing.T) {
	var creates atomic.Int32
	var polls atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/out.mp4" && r.Header.Get("Authorization") != "Bearer apimart-secret" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v1/videos/generations":
			creates.Add(1)
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "kling-v3" || body["mode"] != "pro" ||
				body["duration"] != float64(6) || body["aspect_ratio"] != "16:9" || body["negative_prompt"] != "blur" || body["audio"] != true {
				t.Fatalf("create body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"code":200,"data":[{"status":"submitted","task_id":"task_apimart_1"}]}`)
		case "/v1/tasks/task_apimart_1":
			polls.Add(1)
			_, _ = io.WriteString(w, `{"code":200,"data":{"id":"task_apimart_1","status":"completed","result":{"videos":[{"url":"`+upstream.URL+`/out.mp4?sig=read-only"}]}}}`)
		case "/out.mp4":
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
	request := videoGenerationRequest{
		BaseURL: upstream.URL, APIKey: "apimart-secret", Protocol: "apimart", Model: "kling-v3",
		Prompt: "city", NegativePrompt: "blur", Mode: "pro", Seconds: 6, Ratio: "16:9", GenerateAudio: true,
	}
	var checkpoint videoProviderCheckpoint
	media, err := executor.Generate(context.Background(), request, nil, func(value videoProviderCheckpoint) error {
		checkpoint = value
		return nil
	})
	if err != nil || checkpoint.Protocol != "apimart" || checkpoint.TaskID != "task_apimart_1" || media.MIMEType != "video/mp4" {
		t.Fatalf("media=%#v checkpoint=%#v err=%v", media, checkpoint, err)
	}
	_, err = executor.Generate(context.Background(), request, &checkpoint, func(videoProviderCheckpoint) error {
		t.Fatal("resume must not create another task")
		return nil
	})
	if err != nil || creates.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("create=%d poll=%d err=%v", creates.Load(), polls.Load(), err)
	}
}

func TestAPIMartVideoRetriesTransientPollWithoutRecreatingPaidTask(t *testing.T) {
	var creates atomic.Int32
	var polls atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/videos/generations":
			creates.Add(1)
			_, _ = io.WriteString(w, `{"code":200,"data":[{"task_id":"task_retry"}]}`)
		case "/v1/tasks/task_retry":
			if polls.Add(1) == 1 {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, `{"error":"retry"}`)
				return
			}
			_, _ = io.WriteString(w, `{"code":200,"data":{"status":"completed","result":{"videos":[{"url":"`+upstream.URL+`/retry.mp4"}]}}}`)
		case "/retry.mp4":
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
		BaseURL: upstream.URL, APIKey: "token", Protocol: "apimart", Model: "kling-v3",
		Prompt: "move", Mode: "std", Seconds: 5, Ratio: "16:9",
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err != nil || media.MIMEType != "video/mp4" || creates.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("media=%#v create=%d poll=%d err=%v", media, creates.Load(), polls.Load(), err)
	}
}

func TestAPIMartUploadsImageReferencesBeforeVideoCreate(t *testing.T) {
	var uploaded atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/uploads/images":
			uploaded.Add(1)
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
				t.Fatalf("content type = %q", r.Header.Get("Content-Type"))
			}
			file, header, err := r.FormFile("file")
			if err != nil || header.Filename != "reference.png" {
				t.Fatalf("upload file=%#v err=%v", header, err)
			}
			_ = file.Close()
			_, _ = io.WriteString(w, `{"url":"https://upload.apimart.ai/f/image/reference.png","content_type":"image/png","bytes":68}`)
		case "/v1/videos/generations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			urls, ok := body["image_urls"].([]any)
			if !ok || len(urls) != 1 || urls[0] != "https://upload.apimart.ai/f/image/reference.png" {
				t.Fatalf("image_urls = %#v", body["image_urls"])
			}
			_, _ = io.WriteString(w, `{"code":200,"data":[{"task_id":"task_ref"}]}`)
		case "/v1/tasks/task_ref":
			_, _ = io.WriteString(w, `{"code":200,"data":{"status":"failed"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	_, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: server.URL, APIKey: "secret", Protocol: "apimart", Model: "kling-v3", Prompt: "move",
		Mode: "std", Seconds: 5, Ratio: "16:9", References: []generatedMedia{{Data: png, MIMEType: "image/png"}},
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil || uploaded.Load() != 1 {
		t.Fatalf("uploaded=%d err=%v", uploaded.Load(), err)
	}
}

func TestAPIMartImageCreatePollAndDownload(t *testing.T) {
	var creates atomic.Int32
	var polls atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			creates.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "gpt-image-1-official" || body["prompt"] != "draw" || body["n"] != float64(1) || body["size"] != "1:1" {
				t.Fatalf("body=%#v", body)
			}
			_, _ = io.WriteString(w, `{"code":200,"data":[{"status":"submitted","task_id":"task_image_1"}]}`)
		case "/v1/tasks/task_image_1":
			polls.Add(1)
			_, _ = io.WriteString(w, `{"code":200,"data":{"status":"completed","result":{"images":[{"url":["`+upstream.URL+`/out.png"]}]}}}`)
		case "/out.png":
			w.Header().Set("Content-Type", "image/png")
			png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	executor := newOpenAIImageExecutor()
	executor.client = upstream.Client()
	executor.apimartPollInterval = 0
	executor.apimartMaxDuration = time.Second
	request := imageGenerationRequest{
		Protocol: "apimart", BaseURL: upstream.URL, APIKey: "secret", Model: "gpt-image-1-official",
		Prompt: "draw", Size: "1:1", Quality: "auto", Count: 1,
	}
	var checkpoint videoProviderCheckpoint
	images, err := executor.GenerateResumable(context.Background(), request, nil, func(value videoProviderCheckpoint) error {
		checkpoint = value
		return nil
	})
	if err != nil || len(images) != 1 || images[0].MIMEType != "image/png" {
		t.Fatalf("images=%#v err=%v", images, err)
	}
	if checkpoint.Protocol != "apimart" || checkpoint.TaskID != "task_image_1" {
		t.Fatalf("checkpoint = %#v", checkpoint)
	}
	if _, err := executor.GenerateResumable(context.Background(), request, &checkpoint, func(videoProviderCheckpoint) error {
		t.Fatal("resume must not save another checkpoint")
		return nil
	}); err != nil || creates.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("resume create=%d poll=%d err=%v", creates.Load(), polls.Load(), err)
	}
}

func TestAPIMartRejectsMalformedTasksAndNeverLeaksProviderBody(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"secret apimart-key-private"}`)
	}))
	defer server.Close()
	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	executor.maxDuration = time.Second
	_, err := executor.Generate(context.Background(), videoGenerationRequest{
		BaseURL: server.URL, APIKey: "apimart-key-private", Protocol: "apimart", Model: "kling-v3", Prompt: "move",
		Mode: "std", Seconds: 5, Ratio: "16:9",
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil || strings.Contains(err.Error(), "apimart-key-private") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe error = %v", err)
	}
}

func TestProviderCapabilitiesResolveExactModelsAndFailClosed(t *testing.T) {
	capability, ok := resolveProviderModelCapability(" APIMART ", "video", " Kling-V3 ")
	if !ok || capability.Family != "kling-3" || capability.MaxImageReferences != 2 {
		t.Fatalf("capability = %#v, %v", capability, ok)
	}
	if _, ok := resolveProviderModelCapability("apimart", "video", "prefix-kling-v3-suffix"); ok {
		t.Fatal("fuzzy model name unexpectedly resolved")
	}
	if _, ok := resolveProviderModelCapability("openai", "video", "kling-v3"); ok {
		t.Fatal("model unexpectedly crossed protocol boundary")
	}
}

func TestAPIMartSeedanceCapabilitiesResolveExactModels(t *testing.T) {
	for _, model := range []string{"doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"} {
		capability, ok := resolveProviderModelCapability("apimart", "video", model)
		if !ok || capability.Family != "seedance-2.0" || capability.MaxImageReferences != 9 {
			t.Fatalf("capability for %s = %#v, %v", model, capability, ok)
		}
	}
	for _, model := range []string{
		"seedance-2.0-mini", "doubao-seedance-2.0-mini-preview", "seedream-5-pro",
		"nano-banana-2-lite", "happyhorse-1.1", "agnes",
	} {
		if _, ok := resolveProviderModelCapability("apimart", "video", model); ok {
			t.Fatalf("unsupported or fuzzy model %q resolved", model)
		}
	}
}

func TestAPIMartSeedanceValidationMatrix(t *testing.T) {
	image := generatedMedia{Data: apimartPNG(t), MIMEType: "image/png"}
	base := videoGenerationRequest{
		Protocol: "apimart", Model: "doubao-seedance-2.0", Prompt: "move", Seconds: 5,
		Ratio: "16:9", Resolution: "720p", References: []generatedMedia{image},
	}
	if err := validateAPIMartVideoRequest(base); err != nil {
		t.Fatalf("valid Seedance request rejected: %v", err)
	}
	for name, mutate := range map[string]func(*videoGenerationRequest){
		"duration below documented contract": func(value *videoGenerationRequest) { value.Seconds = 4 },
		"duration above contract":            func(value *videoGenerationRequest) { value.Seconds = 16 },
		"unknown ratio":                      func(value *videoGenerationRequest) { value.Ratio = "2:1" },
		"standard prompt too long":           func(value *videoGenerationRequest) { value.Prompt = strings.Repeat("x", 4_001) },
		"negative prompt":                    func(value *videoGenerationRequest) { value.NegativePrompt = "blur" },
		"watermark":                          func(value *videoGenerationRequest) { value.Watermark = true },
		"Kling controls":                     func(value *videoGenerationRequest) { value.MultiShot = true },
		"too many images": func(value *videoGenerationRequest) {
			value.References = make([]generatedMedia, 10)
			for index := range value.References {
				value.References[index] = image
			}
		},
	} {
		request := base
		mutate(&request)
		if err := validateAPIMartVideoRequest(request); err == nil {
			t.Fatalf("Seedance accepted %s", name)
		}
	}

	adaptive := base
	adaptive.Ratio = "adaptive"
	if err := validateAPIMartVideoRequest(adaptive); err != nil {
		t.Fatalf("adaptive image request rejected: %v", err)
	}
	adaptive.References = nil
	if err := validateAPIMartVideoRequest(adaptive); err == nil {
		t.Fatal("adaptive text-only request accepted")
	}

	standard4K := base
	standard4K.Resolution = "4k"
	if err := validateAPIMartVideoRequest(standard4K); err != nil {
		t.Fatalf("standard 4k rejected: %v", err)
	}
	for _, model := range []string{"doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"} {
		request := standard4K
		request.Model = model
		if err := validateAPIMartVideoRequest(request); err == nil {
			t.Fatalf("%s accepted 4k", model)
		}
		request.Resolution = "480p"
		if err := validateAPIMartVideoRequest(request); err != nil {
			t.Fatalf("%s rejected 480p: %v", model, err)
		}
	}

	mini := base
	mini.Model = " Doubao-Seedance-2.0-Mini "
	mini.Prompt = strings.Repeat("x", 5_000)
	if err := validateAPIMartVideoRequest(mini); err != nil {
		t.Fatalf("mini's documented unbounded prompt was rejected: %v", err)
	}
}

func TestAPIMartSeedanceRejectsUntransportableOrConflictingLocalMedia(t *testing.T) {
	image := generatedMedia{Data: apimartPNG(t), MIMEType: "image/png"}
	base := videoGenerationRequest{
		Protocol: "apimart", Model: "doubao-seedance-2.0", Prompt: "move", Seconds: 5,
		Ratio: "16:9", Resolution: "720p", References: []generatedMedia{image},
	}
	video := base
	video.References = []generatedMedia{{Data: minimalMP4(), MIMEType: "video/mp4"}}
	if err := validateAPIMartVideoRequest(video); err == nil {
		t.Fatal("local reference video was accepted without a documented upload transport")
	}
	audio := base
	audio.References = []generatedMedia{{Data: []byte("RIFF"), MIMEType: "audio/wav"}}
	if err := validateAPIMartVideoRequest(audio); err == nil {
		t.Fatal("local reference audio was accepted without a documented upload transport")
	}
	firstLastMixed := base
	firstLastMixed.FrameMode = "first-last"
	firstLastMixed.References = []generatedMedia{image, {Data: minimalMP4(), MIMEType: "video/mp4"}}
	if err := validateAPIMartVideoRequest(firstLastMixed); err == nil {
		t.Fatal("first/last frames accepted a reference video")
	}
}

func TestAPIMartVideoSerializesSeedanceFieldsAndFrameRoles(t *testing.T) {
	var createdBodies []map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/uploads/images":
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = io.WriteString(w, fmt.Sprintf(`{"url":"https://upload.apimart.ai/f/image/%d.png"}`, len(createdBodies)+1))
		case "/v1/videos/generations":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			createdBodies = append(createdBodies, body)
			_, _ = io.WriteString(w, `{"code":200,"data":[{"task_id":"task_seedance"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	base := videoGenerationRequest{
		BaseURL: server.URL, APIKey: "token", Protocol: "apimart", Model: " Doubao-Seedance-2.0-Mini ",
		Prompt: "move", Seconds: 7, Ratio: "adaptive", Resolution: "720p", GenerateAudio: true,
		References: []generatedMedia{{Data: apimartPNG(t), MIMEType: "image/png"}, {Data: apimartPNG(t), MIMEType: "image/png"}},
	}
	if _, err := executor.createAPIMartVideo(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	firstLast := base
	firstLast.FrameMode = "first-last"
	if _, err := executor.createAPIMartVideo(context.Background(), firstLast); err != nil {
		t.Fatal(err)
	}
	if len(createdBodies) != 2 {
		t.Fatalf("created bodies = %d", len(createdBodies))
	}
	references := createdBodies[0]
	if references["model"] != "doubao-seedance-2.0-mini" || references["size"] != "adaptive" || references["resolution"] != "720p" || references["duration"] != float64(7) || references["generate_audio"] != true {
		t.Fatalf("Seedance body = %#v", references)
	}
	if images, ok := references["image_urls"].([]any); !ok || len(images) != 2 {
		t.Fatalf("Seedance image_urls = %#v", references["image_urls"])
	}
	for _, forbidden := range []string{"mode", "aspect_ratio", "audio", "watermark", "negative_prompt", "multi_shot"} {
		if _, exists := references[forbidden]; exists {
			t.Fatalf("Seedance body contains foreign field %q: %#v", forbidden, references)
		}
	}
	roles, ok := createdBodies[1]["image_with_roles"].([]any)
	if !ok || len(roles) != 2 || createdBodies[1]["image_urls"] != nil {
		t.Fatalf("Seedance frame roles = %#v", createdBodies[1])
	}
	first, _ := roles[0].(map[string]any)
	last, _ := roles[1].(map[string]any)
	if first["role"] != "first_frame" || last["role"] != "last_frame" {
		t.Fatalf("Seedance roles = %#v", roles)
	}
}

func TestAPIMartKlingValidationRejectsUnsupportedCombinations(t *testing.T) {
	base := videoGenerationRequest{
		Protocol: "apimart", Model: "kling-v2-6", Prompt: "move", Mode: "std", Seconds: 5, Ratio: "16:9",
	}
	if err := validateAPIMartVideoRequest(base); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	withAudio := base
	withAudio.GenerateAudio = true
	if err := validateAPIMartVideoRequest(withAudio); err == nil {
		t.Fatal("Kling 2.6 std audio was accepted")
	}
	withLastFrame := base
	withLastFrame.References = []generatedMedia{{MIMEType: "image/png"}, {MIMEType: "image/png"}}
	if err := validateAPIMartVideoRequest(withLastFrame); err == nil {
		t.Fatal("Kling 2.6 std last frame was accepted")
	}
	badRatio := base
	badRatio.Ratio = "2:1"
	if err := validateAPIMartVideoRequest(badRatio); err == nil {
		t.Fatal("unsupported Kling ratio was accepted")
	}
	badReference := base
	badReference.References = []generatedMedia{{MIMEType: "video/mp4"}}
	if err := validateAPIMartVideoRequest(badReference); err == nil {
		t.Fatal("non-image Kling reference was accepted")
	}
	longPrompt := base
	longPrompt.Prompt = strings.Repeat("x", 2_501)
	if err := validateAPIMartVideoRequest(longPrompt); err == nil {
		t.Fatal("oversized final Kling prompt was accepted")
	}
	v3 := videoGenerationRequest{
		Protocol: "apimart", Model: "kling-v3", Prompt: "", Mode: "4k", Seconds: 6, Ratio: "16:9",
		MultiShot: true, ShotType: "customize", Shots: []videoGenerationShot{
			{Index: 1, Prompt: "wide", Duration: 2}, {Index: 2, Prompt: "close", Duration: 4},
		},
	}
	if err := validateAPIMartVideoRequest(v3); err != nil {
		t.Fatalf("valid Kling 3 shots rejected: %v", err)
	}
	v3.Shots[1].Index = 3
	if err := validateAPIMartVideoRequest(v3); err == nil {
		t.Fatal("discontinuous Kling 3 shots were accepted")
	}
}

func TestAPIMartKlingThreeElementsAndShotBoundaries(t *testing.T) {
	base := videoGenerationRequest{
		Protocol: "apimart", Model: "kling-v3", Prompt: "@dog runs", Mode: "pro", Seconds: 5, Ratio: "16:9",
		Elements: []videoGenerationElement{{
			Name: "dog", Description: "golden dog",
			ImageURLs: []string{"https://cdn.example/dog-front.png", "https://cdn.example/dog-side.png"},
		}},
	}
	if err := validateAPIMartVideoRequest(base); err != nil {
		t.Fatalf("valid elements rejected: %v", err)
	}
	badURL := base
	badURL.Elements = cloneVideoGenerationElements(base.Elements)
	badURL.Elements[0].ImageURLs[0] = "http://127.0.0.1/private"
	if err := validateAPIMartVideoRequest(badURL); err == nil {
		t.Fatal("unsafe element URL accepted")
	}
	duplicate := base
	duplicate.Elements = append(cloneVideoGenerationElements(base.Elements), base.Elements[0])
	if err := validateAPIMartVideoRequest(duplicate); err == nil {
		t.Fatal("duplicate element accepted")
	}
	unknown := base
	unknown.Model = "prefix-kling-v3"
	if err := validateAPIMartVideoRequest(unknown); err == nil {
		t.Fatal("unknown model accepted")
	}
	badShotType := base
	badShotType.MultiShot, badShotType.ShotType = true, "random"
	if err := validateAPIMartVideoRequest(badShotType); err == nil {
		t.Fatal("unknown shot type accepted")
	}
}

func TestAPIMartKlingThreeDurationBoundaries(t *testing.T) {
	for _, test := range []struct {
		seconds int
		valid   bool
	}{
		{seconds: 1, valid: false},
		{seconds: 2, valid: false},
		{seconds: 3, valid: true},
		{seconds: 15, valid: true},
		{seconds: 16, valid: false},
	} {
		request := videoGenerationRequest{
			Protocol: "apimart", Model: "kling-v3", Prompt: "move", Mode: "pro",
			Seconds: test.seconds, Ratio: "16:9",
		}
		err := validateAPIMartVideoRequest(request)
		if (err == nil) != test.valid {
			t.Fatalf("duration %d valid=%v err=%v", test.seconds, test.valid, err)
		}
	}
}

func TestAPIMartProtocolParsingHelpers(t *testing.T) {
	if got := apimartTaskID(map[string]any{"task_id": "direct"}); got != "direct" {
		t.Fatalf("direct task id = %q", got)
	}
	if got := apimartTaskID(map[string]any{"data": map[string]any{"id": "nested"}}); got != "nested" {
		t.Fatalf("nested task id = %q", got)
	}
	if got := apimartTaskID(map[string]any{"data": []any{map[string]any{"taskId": "array"}}}); got != "array" {
		t.Fatalf("array task id = %q", got)
	}
	if got := apimartTaskID(map[string]any{}); got != "" {
		t.Fatalf("empty task id = %q", got)
	}
	if got := apimartVideoResultURL(map[string]any{"data": map[string]any{"result": map[string]any{
		"videos": []any{map[string]any{"url": []any{"https://cdn.example/out.mp4"}}},
	}}}); got != "https://cdn.example/out.mp4" {
		t.Fatalf("video URL = %q", got)
	}
	imageURLs := apimartImageResultURLs(map[string]any{"data": map[string]any{"result": map[string]any{
		"images": []any{map[string]any{"url": "https://cdn.example/a.png"}, map[string]any{"url": []any{"https://cdn.example/b.png"}}},
	}}})
	if len(imageURLs) != 2 || imageURLs[0] != "https://cdn.example/a.png" || imageURLs[1] != "https://cdn.example/b.png" {
		t.Fatalf("image URLs = %#v", imageURLs)
	}
	for input, want := range map[string]string{
		"1024x1024": "1:1", "1536x1024": "3:2", "2048x2048": "1:1", "custom": "custom",
	} {
		if got := apimartImageSize(input); got != want {
			t.Fatalf("image size %q = %q, want %q", input, got, want)
		}
	}
	if err := validateAPIMartPublicURL("https://cdn.example/image.png?sig=read"); err != nil {
		t.Fatalf("signed public URL rejected: %v", err)
	}
	if err := validateAPIMartPublicURL("https://user:pass@cdn.example/image.png"); err == nil {
		t.Fatal("credential-bearing URL accepted")
	}
	for _, rawURL := range []string{
		"https://127.0.0.1/image.png",
		"https://10.0.0.5/image.png",
		"https://192.168.1.10/image.png",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/image.png",
		"https://100.64.0.1/image.png",
	} {
		if err := validateAPIMartPublicURL(rawURL); err == nil {
			t.Fatalf("internal reference URL accepted: %s", rawURL)
		}
	}
}

func TestAPIMartImageCapabilityRejectsUnsupportedPaidParametersBeforeCreate(t *testing.T) {
	executor := newOpenAIImageExecutor()
	base := imageGenerationRequest{
		Protocol: "apimart", BaseURL: "https://api.apimart.ai", APIKey: "token",
		Model: "gpt-image-1-official", Prompt: "draw", Size: "1:1", Quality: "auto", Count: 1,
	}
	for name, mutate := range map[string]func(*imageGenerationRequest){
		"count":   func(value *imageGenerationRequest) { value.Count = 5 },
		"size":    func(value *imageGenerationRequest) { value.Size = "16:9" },
		"quality": func(value *imageGenerationRequest) { value.Quality = "ultra" },
		"model":   func(value *imageGenerationRequest) { value.Model = "seedream-5-pro" },
	} {
		request := base
		mutate(&request)
		if _, err := executor.GenerateResumable(context.Background(), request, nil, func(videoProviderCheckpoint) error { return nil }); err == nil {
			t.Fatalf("unsupported %s accepted", name)
		}
	}
}

func TestVideoJobAllowsEmptyPromptOnlyForCustomMultiShot(t *testing.T) {
	valid := createVideoJobRequest{
		ID: "job-empty-prompt", ProviderID: "media-main", Model: "kling-v3",
		Parameters: createVideoJobParameters{
			Seconds: 5, Ratio: "16:9", Resolution: "720p", MultiShot: true, ShotType: "customize",
			Shots: []videoGenerationShot{{Index: 1, Prompt: "wide", Duration: 5}},
		},
	}
	if !validCreateVideoJob(valid) {
		t.Fatal("custom multi-shot request with empty top-level prompt was rejected")
	}
	invalid := valid
	invalid.Parameters.MultiShot = false
	if validCreateVideoJob(invalid) {
		t.Fatal("ordinary request with empty prompt was accepted")
	}
	wrongModel := valid
	wrongModel.Model = "sora-2"
	if validCreateVideoJob(wrongModel) {
		t.Fatal("non-Kling model used custom-shot flags to bypass the prompt boundary")
	}
}

func TestVideoJobAllowsEmptySeedancePromptOnlyWithReferenceMedia(t *testing.T) {
	valid := createVideoJobRequest{
		ID: "job-seedance-reference", ProviderID: "media-main", Model: "doubao-seedance-2.0-mini",
		Parameters: createVideoJobParameters{
			Seconds: 5, Ratio: "adaptive", Resolution: "720p", ReferenceStorageKeys: []string{"media:reference:image:one"},
		},
	}
	if !validCreateVideoJob(valid) {
		t.Fatal("Seedance image-to-video request with empty optional prompt was rejected")
	}
	withoutReference := valid
	withoutReference.Parameters.ReferenceStorageKeys = nil
	if validCreateVideoJob(withoutReference) {
		t.Fatal("Seedance text-to-video request without a prompt was accepted")
	}
	unknownModel := valid
	unknownModel.Model = "seedance-2.0-mini"
	if validCreateVideoJob(unknownModel) {
		t.Fatal("unknown model used Seedance rules to bypass the prompt boundary")
	}
	ordinary := valid
	ordinary.Model, ordinary.Prompt = "sora-2", "move"
	if validCreateVideoJob(ordinary) {
		t.Fatal("non-Seedance model accepted adaptive ratio")
	}
	ordinary.Parameters.Ratio, ordinary.Parameters.Resolution = "16:9", "4k"
	if validCreateVideoJob(ordinary) {
		t.Fatal("non-Seedance model accepted Seedance-only 4k boundary")
	}
}

func TestAPIMartJSONRequestRejectsStatusCodeProviderCodeAndInvalidJSON(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v1/provider-code":
			_, _ = io.WriteString(w, `{"code":429,"data":{}}`)
		case "/v1/invalid":
			_, _ = io.WriteString(w, `{`)
		case "/v1/http-error":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, `{"secret":"must-not-leak"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for _, path := range []string{"/provider-code", "/invalid", "/http-error"} {
		if _, err := apimartJSONRequest(context.Background(), server.Client(), server.URL, "token", http.MethodPost, path, map[string]any{"ok": true}); err == nil || strings.Contains(err.Error(), "must-not-leak") {
			t.Fatalf("path %s unsafe error = %v", path, err)
		}
	}
}

func TestAPIMartRetryClassificationIsBounded(t *testing.T) {
	if got := apimartRetryAfter("999"); got != 30*time.Second {
		t.Fatalf("Retry-After cap = %s", got)
	}
	if delay, retry := retryAPIMartPoll(&apimartHTTPError{StatusCode: http.StatusTooManyRequests, RetryAfter: 3 * time.Second}, time.Second); !retry || delay != 3*time.Second {
		t.Fatalf("429 retry = %s, %v", delay, retry)
	}
	if _, retry := retryAPIMartPoll(&apimartHTTPError{StatusCode: http.StatusBadRequest}, time.Second); retry {
		t.Fatal("400 was classified as retryable")
	}
}

func TestAPIMartUploadResponseAndInputBoundaries(t *testing.T) {
	badStatus := &http.Response{StatusCode: http.StatusRequestEntityTooLarge, Body: io.NopCloser(strings.NewReader(`{"secret":"x"}`))}
	if _, err := readAPIMartUploadResponse(badStatus); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("bad status error = %v", err)
	}
	invalidJSON := &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{`))}
	if _, err := readAPIMartUploadResponse(invalidJSON); err == nil {
		t.Fatal("invalid upload JSON accepted")
	}
	unsafeURL := &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"url":"http://169.254.169.254/latest"}`))}
	if _, err := readAPIMartUploadResponse(unsafeURL); err == nil {
		t.Fatal("unsafe upload URL accepted")
	}
	if _, err := uploadAPIMartImages(context.Background(), http.DefaultClient, "https://api.apimart.ai", "token",
		[]generatedMedia{{Data: []byte("pdf"), MIMEType: "application/pdf"}}); err == nil {
		t.Fatal("unsupported upload type accepted")
	}
	if _, err := uploadAPIMartImages(context.Background(), http.DefaultClient, "https://api.apimart.ai", "token",
		[]generatedMedia{{Data: bytes.Repeat([]byte{1}, (20<<20)+1), MIMEType: "image/png"}}); err == nil {
		t.Fatal("oversized upload accepted")
	}
}

func TestAPIMartVideoSerializesKlingThreeControls(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/videos/generations" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		shots, _ := body["multi_prompt"].([]any)
		elements, _ := body["element_list"].([]any)
		if body["multi_shot"] != true || body["shot_type"] != "customize" || len(shots) != 2 || len(elements) != 1 {
			t.Fatalf("body = %#v", body)
		}
		_, _ = io.WriteString(w, `{"code":200,"data":[{"task_id":"task_controls"}]}`)
	}))
	defer server.Close()
	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	payload, err := executor.createAPIMartVideo(context.Background(), videoGenerationRequest{
		BaseURL: server.URL, APIKey: "token", Protocol: "apimart", Model: "kling-v3", Prompt: "@dog runs",
		Mode: "pro", Seconds: 5, Ratio: "16:9", MultiShot: true, ShotType: "customize",
		Shots:    []videoGenerationShot{{Index: 1, Prompt: "wide", Duration: 2}, {Index: 2, Prompt: "close", Duration: 3}},
		Elements: []videoGenerationElement{{Name: "dog", Description: "gold", ImageURLs: []string{"https://cdn.example/a.png", "https://cdn.example/b.png"}}},
	})
	if err != nil || apimartTaskID(payload) != "task_controls" {
		t.Fatalf("payload=%#v err=%v", payload, err)
	}
}

func TestServerAPIMartVideoJobPersistsAndResolvesKlingSnapshot(t *testing.T) {
	backend := newMemoryStore()
	video := newScriptedVideoExecutor(&videoProviderCheckpoint{Protocol: "apimart", TaskID: "task_snapshot"})
	server, handler := mediaExecutionServer(t, backend, video, newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	config := []byte(`{"channels":[{"id":"media-main","defaultVideoModel":"kling-v3","providers":{"video":{"baseUrl":"https://api.apimart.ai","model":"kling-v3","protocol":"apimart"}}}],"systemPrompt":"cinematic"}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"id":"job-apimart-snapshot","projectId":"board-1","prompt":"a moving tiger","providerId":"media-main","model":"kling-v3","parameters":{"seconds":6,"ratio":"16:9","resolution":"1080p","negativePrompt":"blur","mode":"pro","generateAudio":true,"multiShot":true,"shotType":"customize","shots":[{"index":1,"prompt":"wide","duration":2},{"index":2,"prompt":"close","duration":4}],"elements":[{"name":"dog","description":"gold dog","imageUrls":["https://cdn.example/a.png","https://cdn.example/b.png"]}],"referenceStorageKeys":[]}}`)
	created := request(t, handler, http.MethodPost, "/api/generation-jobs/video", body)
	if created.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	var started scriptedVideoStart
	select {
	case started = <-video.started:
	case <-time.After(time.Second):
		t.Fatal("APIMart job did not start")
	}
	if started.Request.Protocol != "apimart" || started.Request.APIKey != "sk-video-private" ||
		started.Request.NegativePrompt != "blur" || started.Request.Mode != "pro" || !started.Request.MultiShot ||
		len(started.Request.Shots) != 2 || len(started.Request.Elements) != 1 {
		t.Fatalf("resolved request = %#v", started.Request)
	}
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "job-apimart-snapshot")
	if err != nil || !bytes.Contains(job.Parameters, []byte(`"negativePrompt":"blur"`)) ||
		!bytes.Contains(job.Result, []byte(`"protocol":"apimart"`)) || bytes.Contains(job.Parameters, []byte("sk-video-private")) {
		t.Fatalf("job=%#v err=%v", job, err)
	}
	video.release <- scriptedMediaResult{media: generatedMedia{Data: minimalMP4(), MIMEType: "video/mp4"}}
	server.videoWG.Wait()
}
