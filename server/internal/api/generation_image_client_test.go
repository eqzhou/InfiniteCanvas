package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestImageProviderTransportUsesRequestContextDeadline(t *testing.T) {
	executor := newOpenAIImageExecutor()
	transport, ok := executor.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T", executor.client.Transport)
	}
	if transport.ForceAttemptHTTP2 {
		t.Fatal("provider transport must use HTTP/1.1 by default for long-running image gateways")
	}
	if transport.Proxy == nil {
		t.Fatal("provider transport must honor the process HTTP(S)_PROXY configuration")
	}
	if transport.ResponseHeaderTimeout != 0 {
		t.Fatalf("response header timeout = %s, want request context deadline", transport.ResponseHeaderTimeout)
	}
	if transport.TLSHandshakeTimeout != 0 {
		t.Fatalf("TLS handshake timeout = %s, want request context deadline", transport.TLSHandshakeTimeout)
	}
	if executor.client.Timeout != 10*time.Minute {
		t.Fatalf("client timeout = %s, want defensive 10 minute cap", executor.client.Timeout)
	}
	if dialer := newGenerationProviderDialer(); dialer.Timeout != 0 {
		t.Fatalf("dial timeout = %s, want request context deadline", dialer.Timeout)
	}
}

func TestProviderTransportUsesOnlyExplicitOpenBoardProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:7890")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
	t.Setenv("NO_PROXY", "")
	t.Setenv("OPENBOARD_PROVIDER_PROXY_URL", "")

	request, err := http.NewRequest(http.MethodGet, "https://provider.example/v1/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	transport := newProviderHTTPClient(time.Minute).Transport.(*http.Transport)
	proxyURL, err := transport.Proxy(request)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL != nil {
		t.Fatalf("inherited process proxy was used: %s", proxyURL)
	}

	t.Setenv("OPENBOARD_PROVIDER_PROXY_URL", "http://127.0.0.1:7899")
	proxyURL, err = transport.Proxy(request)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL == nil || proxyURL.String() != "http://127.0.0.1:7899" {
		t.Fatalf("explicit provider proxy = %v", proxyURL)
	}
}

func TestImageProviderTransportCancelsAStalledTLSHandshakeWithRequestContext(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	requestCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodGet,
		"https://"+listener.Addr().String()+"/v1/models",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	startedAt := time.Now()
	_, requestErr := newProviderHTTPClient(10 * time.Minute).Do(request)
	if !errors.Is(requestErr, context.DeadlineExceeded) {
		t.Fatalf("request error = %v, want context deadline exceeded", requestErr)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("stalled TLS handshake ignored request deadline: %s", elapsed)
	}

	select {
	case connection := <-accepted:
		_ = connection.Close()
	default:
	}
}

func onePixelPNGBase64() string {
	var output bytes.Buffer
	value := image.NewRGBA(image.Rect(0, 0, 1, 1))
	value.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&output, value); err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(output.Bytes())
}

func TestOpenAIImageExecutorGenerationsRequestAndBase64Result(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("unexpected request: %s %#v", r.URL.Path, r.Header)
		}
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("accept = %q", r.Header.Get("Accept"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "gpt-image-1" || body["prompt"] != "draw a square" || body["n"] != float64(1) || body["background"] != "transparent" {
			t.Errorf("request body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+onePixelPNGBase64()+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-test", Model: "gpt-image-1",
		Prompt: "draw a square", Size: "1024x1024", Quality: "high", Count: 1,
		TransparentBackground: true,
	})
	if err != nil || len(images) != 1 || images[0].MIMEType != "image/png" {
		t.Fatalf("images = %#v, %v", images, err)
	}
}

func TestOpenAIImageExecutorGenerationsReturnsRequestedCountInOneRequest(t *testing.T) {
	calls := 0
	pixel := onePixelPNGBase64()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/images/generations" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "gpt-image-1" || body["n"] != float64(4) || body["prompt"] != "four variants" {
			t.Errorf("request body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-test", Model: "gpt-image-1",
		Prompt: "four variants", Size: "1024x1024", Quality: "auto", Count: 4,
	})
	if err != nil || len(images) != 4 {
		t.Fatalf("images = %#v, %v", images, err)
	}
	if calls != 1 {
		t.Fatalf("openai calls = %d, want 1", calls)
	}
}

func TestOpenAIImageExecutorRejectsFewerResultsThanRequested(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+onePixelPNGBase64()+`"}]}`)
	}))
	defer upstream.Close()

	_, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", Model: "gpt-image-1",
		Prompt: "need four", Size: "1024x1024", Quality: "auto", Count: 4,
	})
	if err == nil || !strings.Contains(err.Error(), "invalid result") {
		t.Fatalf("error = %v, want invalid result count", err)
	}
}

func TestOpenAIImageExecutorTrimsExtraResultsToRequestedCount(t *testing.T) {
	pixel := onePixelPNGBase64()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"},{"b64_json":"`+pixel+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", Model: "gpt-image-1",
		Prompt: "trim extras", Size: "1024x1024", Quality: "auto", Count: 4,
	})
	if err != nil || len(images) != 4 {
		t.Fatalf("images = %#v, %v", images, err)
	}
}

func TestOpenAIImageExecutorNormalizesGrokAutoQuality(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["quality"] != "medium" {
			t.Fatalf("Grok quality = %#v, want medium", body["quality"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+onePixelPNGBase64()+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		Protocol: "openai", BaseURL: upstream.URL + "/v1", Model: "grok-imagine-image-2.0",
		Prompt: "draw a square", Size: "1024x1024", Quality: "auto", Count: 1,
	})
	if err != nil || len(images) != 1 {
		t.Fatalf("images = %#v, %v", images, err)
	}
}

func TestOpenAIImageExecutorReturnsTypedHTTPError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream secret detail", http.StatusBadGateway)
	}))
	defer upstream.Close()

	_, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", Model: "gpt-image-1",
		Prompt: "draw a square", Size: "1024x1024", Quality: "auto", Count: 1,
	})
	var providerErr *imageProviderHTTPError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("error = %#v, want typed HTTP 502", err)
	}
	if strings.Contains(err.Error(), "upstream secret detail") {
		t.Fatalf("provider response leaked into error: %q", err)
	}
}

func TestOpenAIImageExecutorEditsUseMultipartReferences(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/edits" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("accept = %q", r.Header.Get("Accept"))
		}
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			t.Fatalf("content type = %q, %v", r.Header.Get("Content-Type"), err)
		}
		reader := multipart.NewReader(r.Body, params["boundary"])
		fields := map[string]string{}
		imageArrayParts := 0
		legacyImageParts := 0
		for {
			part, nextErr := reader.NextPart()
			if nextErr == io.EOF {
				break
			}
			if nextErr != nil {
				t.Fatal(nextErr)
			}
			value, _ := io.ReadAll(part)
			switch part.FormName() {
			case "image[]":
				imageArrayParts++
				if part.Header.Get("Content-Type") != "image/png" {
					t.Errorf("image content type = %q", part.Header.Get("Content-Type"))
				}
				if !strings.HasSuffix(part.FileName(), ".png") || string(value) != string(png) {
					t.Errorf("image part = %q %d", part.FileName(), len(value))
				}
			case "image":
				legacyImageParts++
			default:
				fields[part.FormName()] = string(value)
			}
		}
		if fields["prompt"] != "edit it" || fields["model"] != "gpt-image-1.5" ||
			fields["background"] != "transparent" || imageArrayParts != 2 || legacyImageParts != 0 {
			t.Errorf("fields = %#v, image[] parts = %d, legacy image parts = %d", fields, imageArrayParts, legacyImageParts)
		}
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+onePixelPNGBase64()+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-test", Model: "gpt-image-1.5",
		Prompt: "edit it", Size: "1024x1024", Quality: "auto", Count: 1,
		TransparentBackground: true,
		References: []generatedImage{
			{Data: png, MIMEType: "image/png"},
			{Data: png},
		},
	})
	if err != nil || len(images) != 1 {
		t.Fatalf("images = %#v, %v", images, err)
	}
}

func TestOpenAIImageExecutorAddsClientRequestID(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Client-Request-Id"); got != "job-image-request-id" {
			t.Fatalf("client request id = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"`+onePixelPNGBase64()+`"}]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", APIKey: "sk-test", Model: "gpt-image-2",
		RequestID: "job-image-request-id", Prompt: "edit it", Size: "1024x1024", Quality: "auto", Count: 1,
		References: []generatedImage{{Data: png, MIMEType: "image/png"}},
	})
	if err != nil || len(images) != 1 {
		t.Fatalf("images = %#v, %v", images, err)
	}
}

func TestOpenAIImageExecutorRejectsTransparentGPTImage2BeforeRequest(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer upstream.Close()

	_, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		BaseURL: upstream.URL + "/v1", Model: "gpt-image-2",
		Prompt: "draw a logo", Size: "1024x1024", Quality: "auto", Count: 1,
		TransparentBackground: true,
	})
	if err == nil || !strings.Contains(err.Error(), "does not support transparent") {
		t.Fatalf("error = %v, want transparent background validation", err)
	}
	if requests != 0 {
		t.Fatalf("provider requests = %d, want 0", requests)
	}
}

func TestImageProviderEndpointPreservesSupportedVersionRoots(t *testing.T) {
	for _, testCase := range []struct {
		base string
		want string
	}{
		{base: "https://provider.example/v1", want: "https://provider.example/v1/images/generations"},
		{base: "https://provider.example/api/v3", want: "https://provider.example/api/v3/images/generations"},
		{base: "https://provider.example/api/plan/v3", want: "https://provider.example/api/plan/v3/images/generations"},
		{base: "https://provider.example/custom", want: "https://provider.example/custom/v1/images/generations"},
	} {
		got, err := imageProviderEndpoint(testCase.base, false)
		if err != nil || got != testCase.want {
			t.Fatalf("endpoint(%q) = %q, %v; want %q", testCase.base, got, err, testCase.want)
		}
	}
}

func TestImageExecutorGeneratesGeminiImagesWithInlineReferences(t *testing.T) {
	pngBytes, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/v1beta/models/gemini-2.5-flash-image:generateContent" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		if r.Header.Get("x-goog-api-key") != "gemini-secret" || r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected auth headers: %#v", r.Header)
		}
		var body struct {
			Contents []struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData *struct {
						MIMEType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"contents"`
			GenerationConfig struct {
				ResponseModalities []string `json:"responseModalities"`
			} `json:"generationConfig"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Contents) != 1 || len(body.Contents[0].Parts) != 2 {
			t.Fatalf("invalid Gemini body: %+v", body)
		}
		if body.Contents[0].Parts[0].Text != "draw a lighthouse" || body.Contents[0].Parts[1].InlineData == nil ||
			body.Contents[0].Parts[1].InlineData.MIMEType != "image/png" ||
			body.Contents[0].Parts[1].InlineData.Data != base64.StdEncoding.EncodeToString(pngBytes) {
			t.Fatalf("unexpected Gemini parts: %+v", body.Contents[0].Parts)
		}
		if strings.Join(body.GenerationConfig.ResponseModalities, ",") != "TEXT,IMAGE" {
			t.Fatalf("modalities=%v", body.GenerationConfig.ResponseModalities)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"done"},{"inlineData":{"mimeType":"image/png","data":"`+onePixelPNGBase64()+`"}}]}}]}`)
	}))
	defer upstream.Close()

	executor := newOpenAIImageExecutor()
	images, err := executor.Generate(context.Background(), imageGenerationRequest{
		Protocol: "gemini", BaseURL: upstream.URL + "/v1beta", APIKey: "gemini-secret",
		Model: "gemini-2.5-flash-image", Prompt: "draw a lighthouse", Count: 2,
		References: []generatedImage{{Data: pngBytes, MIMEType: "image/png"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || len(images) != 2 || !bytes.Equal(images[0].Data, pngBytes) || !bytes.Equal(images[1].Data, pngBytes) {
		t.Fatalf("requests=%d images=%d", requests, len(images))
	}
}

func TestImageExecutorRejectsGeminiResponseWithoutImage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"no image"}]}}]}`)
	}))
	defer upstream.Close()
	executor := newOpenAIImageExecutor()
	if _, err := executor.Generate(context.Background(), imageGenerationRequest{
		Protocol: "gemini", BaseURL: upstream.URL + "/v1beta", APIKey: "secret",
		Model: "gemini-image", Prompt: "draw", Count: 1,
	}); err == nil {
		t.Fatal("expected missing Gemini image to fail")
	}
}

func TestImageExecutorRejectsInvalidResultCountBeforeProviderRequest(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer upstream.Close()
	executor := newOpenAIImageExecutor()
	for _, count := range []int{0, 9} {
		if _, err := executor.Generate(context.Background(), imageGenerationRequest{
			Protocol: "gemini", BaseURL: upstream.URL + "/v1beta",
			Model: "gemini-image", Prompt: "draw", Count: count,
		}); err == nil {
			t.Fatalf("expected count %d to fail", count)
		}
	}
	if requests != 0 {
		t.Fatalf("provider requests = %d, want 0", requests)
	}
}

func TestImageExecutorRunsRestrictedTemplateWithInlineResult(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPut || r.URL.Path != "/v1/render" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "template-secret" || r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected auth headers: %#v", r.Header)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["prompt"] != "draw a bridge" || body["model"] != "relay-image" || body["count"] != float64(1) || body["transparent"] != false {
			t.Fatalf("body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"output":{"images":["data:image/png;base64,`+onePixelPNGBase64()+`"]}}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		Protocol: "template", BaseURL: upstream.URL + "/v1", APIKey: "template-secret",
		Model: "relay-image", Prompt: "draw a bridge", Count: 1,
		Template: &imageProviderTemplate{
			Method: http.MethodPut, Path: "/render", Auth: "x-api-key",
			Request:      json.RawMessage(`{"prompt":"{{prompt}}","model":"{{model}}","count":"{{count}}","transparent":"{{transparentBackground}}"}`),
			ResponsePath: "output.images",
		},
	})
	if err != nil || requests != 1 || len(images) != 1 || images[0].MIMEType != "image/png" {
		t.Fatalf("requests=%d images=%#v err=%v", requests, images, err)
	}
}

func TestImageExecutorRejectsUnsafeTemplateBeforeProviderRequest(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	defer upstream.Close()
	executor := newOpenAIImageExecutor()
	for _, template := range []*imageProviderTemplate{
		{Method: http.MethodGet, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/../render", Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"prompt":"{{prompt.value}}"}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"unsafe":{"__proto__":true}}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"number":1e999}`), ResponsePath: "images"},
	} {
		if _, err := executor.Generate(context.Background(), imageGenerationRequest{
			Protocol: "template", BaseURL: upstream.URL, Model: "relay", Prompt: "draw", Count: 1, Template: template,
		}); err == nil {
			t.Fatalf("expected template %+v to fail", template)
		}
	}
	if requests != 0 {
		t.Fatalf("provider requests = %d, want 0", requests)
	}
}

func TestImageExecutorTemplateDownloadsSignedResultURL(t *testing.T) {
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if r.URL.Path != "/result.png" || r.URL.Query().Get("signature") != "read-only" {
				t.Fatalf("result URL = %s", r.URL.String())
			}
			pngBytes, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"images":["`+upstream.URL+`/result.png?signature=read-only"]}`)
	}))
	defer upstream.Close()

	images, err := newOpenAIImageExecutor().Generate(context.Background(), imageGenerationRequest{
		Protocol: "template", BaseURL: upstream.URL, Model: "relay", Prompt: "draw", Count: 1,
		Template: &imageProviderTemplate{
			Method: http.MethodPost, Path: "/render", Auth: "bearer",
			Request: json.RawMessage(`{"prompt":"{{prompt}}"}`), ResponsePath: "images",
		},
	})
	if err != nil || len(images) != 1 || images[0].MIMEType != "image/png" {
		t.Fatalf("images=%#v err=%v", images, err)
	}
}
