package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type providerTextRoundTripFunc func(*http.Request) (*http.Response, error)

func (function providerTextRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestProviderTextClientAllowsSlowModelResponseHeaders(t *testing.T) {
	transport, ok := providerTextHTTPClient.Transport.(*http.Transport)
	if !ok || transport.ResponseHeaderTimeout < 120*time.Second {
		t.Fatalf("response header timeout=%v", transport.ResponseHeaderTimeout)
	}
}

func TestProviderTextAdmissionPreventsOneUserOrTenantFromTakingEverySlot(t *testing.T) {
	gate := newProviderTextAdmissionGate(8, 4, 2)
	releaseOne, ok := gate.acquire("tenant-a", "user-a")
	if !ok {
		t.Fatal("first user slot was rejected")
	}
	defer releaseOne()
	releaseTwo, ok := gate.acquire("tenant-a", "user-a")
	if !ok {
		t.Fatal("second user slot was rejected")
	}
	defer releaseTwo()
	if _, ok := gate.acquire("tenant-a", "user-a"); ok {
		t.Fatal("one user took more than its fair share")
	}
	releaseThree, ok := gate.acquire("tenant-a", "user-b")
	if !ok {
		t.Fatal("second user could not use the tenant")
	}
	defer releaseThree()
	releaseFour, ok := gate.acquire("tenant-a", "user-c")
	if !ok {
		t.Fatal("third user could not use the tenant")
	}
	defer releaseFour()
	if _, ok := gate.acquire("tenant-a", "user-d"); ok {
		t.Fatal("one tenant took more than its fair share")
	}
	releaseOtherTenant, ok := gate.acquire("tenant-b", "user-a")
	if !ok {
		t.Fatal("another tenant could not use its reserved capacity")
	}
	releaseOtherTenant()
}

func TestProviderTextRequestMatchesExistingImageAndCJKPromptLimits(t *testing.T) {
	images := make([]string, 9)
	for index := range images {
		images[index] = "data:image/png;base64,cGl4ZWw="
	}
	input := providerTextRequest{
		ChannelID:    "personal",
		Model:        "model",
		Prompt:       "hello",
		Images:       images,
		SystemPrompt: strings.Repeat("界", 20_000),
	}
	if err := validateProviderTextRequest(input); err != nil {
		t.Fatalf("existing valid request was rejected: %v", err)
	}
	input.SystemPrompt += "界"
	if err := validateProviderTextRequest(input); err == nil {
		t.Fatal("oversized system prompt was accepted")
	}
	input.SystemPrompt = ""
	input.Prompt = strings.Repeat("界", 100_000)
	if err := validateProviderTextRequest(input); err != nil {
		t.Fatalf("existing valid CJK prompt was rejected: %v", err)
	}
	input.Prompt += "界"
	if err := validateProviderTextRequest(input); err == nil {
		t.Fatal("oversized prompt was accepted")
	}
}

func TestProviderTextUsesResponsesAPI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer test-provider-key" {
			t.Fatalf("unexpected provider request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "gpt-test" ||
			body["instructions"] != "Be concise" {
			t.Fatalf("unexpected request body: %#v", body)
		}
		_, _ = w.Write([]byte(`{"output_text":"gateway response"}`))
	}))
	defer upstream.Close()

	text, err := fetchProviderTextWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL, APIKey: providerFixtureKey("provider"), Protocol: "openai",
	}, providerTextRequest{
		ChannelID: "personal", Model: "gpt-test", Prompt: "hello", SystemPrompt: "Be concise",
	}, upstream.Client(), true)
	if err != nil || text != "gateway response" {
		t.Fatalf("text=%q err=%v", text, err)
	}
}

func TestProviderTextFallsBackOnlyWhenResponsesIsUnsupported(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		switch r.URL.Path {
		case "/v1/responses":
			http.Error(w, "unsupported", http.StatusNotFound)
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"chat response"}}]}`))
		default:
			t.Fatalf("unexpected provider path: %s", r.URL.Path)
		}
	}))
	defer upstream.Close()

	text, err := fetchProviderTextWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL, APIKey: providerFixtureKey("provider"), Protocol: "openai",
	}, providerTextRequest{ChannelID: "personal", Model: "gpt-test", Prompt: "hello"}, upstream.Client(), true)
	if err != nil || text != "chat response" || requestCount != 2 {
		t.Fatalf("text=%q requests=%d err=%v", text, requestCount, err)
	}

	requestCount = 0
	rejected := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requestCount++
		http.Error(w, "invalid key", http.StatusUnauthorized)
	}))
	defer rejected.Close()
	_, err = fetchProviderTextWithClient(context.Background(), providerModelConnection{
		BaseURL: rejected.URL, APIKey: providerFixtureKey("bad"), Protocol: "openai",
	}, providerTextRequest{ChannelID: "personal", Model: "gpt-test", Prompt: "hello"}, rejected.Client(), true)
	if err == nil || requestCount != 1 {
		t.Fatalf("expected one failed request, requests=%d err=%v", requestCount, err)
	}
}

func TestProviderTextUsesGeminiContract(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models/gemini-test:generateContent" ||
			r.Header.Get("x-goog-api-key") != "test-gemini-key" {
			t.Fatalf("unexpected provider request: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"gemini response"}]}}]}`))
	}))
	defer upstream.Close()

	text, err := fetchProviderTextWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL + "/v1beta", APIKey: providerFixtureKey("gemini"), Protocol: "gemini",
	}, providerTextRequest{ChannelID: "personal", Model: "gemini-test", Prompt: "hello"}, upstream.Client(), true)
	if err != nil || text != "gemini response" {
		t.Fatalf("text=%q err=%v", text, err)
	}
}

func TestProviderTextEndpointResolvesTheSavedChannelAndSecret(t *testing.T) {
	_, _, handler := sharedChannelHandler(t)
	config := []byte(`{"channels":[{"id":"personal","baseUrl":"https://provider.example/v1","defaultTextModel":"gpt-test","providers":{"text":{"baseUrl":"https://provider.example/v1","model":"gpt-test","protocol":"openai"}}}],"systemPrompt":"tenant instruction"}`)
	if got := request(t, handler, http.MethodPut, "/api/state/config", config); got.Code != http.StatusNoContent {
		t.Fatalf("config status=%d body=%s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"personal":{"text":"test-provider-key"}}}`)); got.Code != http.StatusNoContent {
		t.Fatalf("secret status=%d body=%s", got.Code, got.Body.String())
	}

	originalClient := providerTextHTTPClient
	providerTextHTTPClient = &http.Client{Transport: providerTextRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://provider.example/v1/responses" ||
			r.Header.Get("Authorization") != "Bearer test-provider-key" {
			t.Fatalf("unexpected upstream request: %s", r.URL)
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["instructions"] != "tenant instruction" {
			t.Fatalf("request did not use the tenant system prompt: %#v", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"output_text":"saved response"}`)),
		}, nil
	})}
	defer func() { providerTextHTTPClient = originalClient }()

	response := request(t, handler, http.MethodPost, "/api/provider-text", []byte(
		`{"channelId":"personal","model":"gpt-test","prompt":"hello","images":[],"systemPromptProfile":"global"}`,
	))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"text": "saved response"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProviderTextEndpointUsesTheCallingMembersSystemPrompt(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	handler := withMigrationActor(router, member)
	config := []byte(`{"channels":[{"id":"personal","baseUrl":"https://provider.example/v1","defaultTextModel":"gpt-test","providers":{"text":{"baseUrl":"https://provider.example/v1","model":"gpt-test","protocol":"openai"}}}],"systemPrompt":"member instruction"}`)
	if got := request(t, handler, http.MethodPut, "/api/state/config", config); got.Code != http.StatusNoContent {
		t.Fatalf("config status=%d body=%s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"personal":{"text":"member-provider-key"}}}`)); got.Code != http.StatusNoContent {
		t.Fatalf("secret status=%d body=%s", got.Code, got.Body.String())
	}

	originalClient := providerTextHTTPClient
	providerTextHTTPClient = &http.Client{Transport: providerTextRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["instructions"] != "member instruction" {
			t.Fatalf("request did not use the member system prompt: %#v", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"output_text":"member response"}`)),
		}, nil
	})}
	t.Cleanup(func() { providerTextHTTPClient = originalClient })

	response := request(t, handler, http.MethodPost, "/api/provider-text", []byte(
		`{"channelId":"personal","model":"gpt-test","prompt":"hello"}`,
	))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "member response") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProviderTextEndpointRejectsUnsafeInputs(t *testing.T) {
	if _, err := providerTextEndpoint(
		"http://127.0.0.1:11434/v1", "openai", "model", "/responses", false,
	); err == nil {
		t.Fatal("server text gateway accepted a loopback provider")
	}
	if err := validateProviderTextRequest(providerTextRequest{
		ChannelID: "personal",
		Model:     "model",
		Prompt:    "hello",
		Images:    []string{"http://internal.example/image.png"},
	}); err == nil {
		t.Fatal("text gateway accepted an insecure image reference")
	}
}

func TestProviderTextEndpointEnforcesTheTenantModelAllowList(t *testing.T) {
	_, _, handler := sharedChannelHandler(t)
	policy := []byte(`{
		"allowRegister":true,
		"allowCustomChannel":true,
		"allowCloudChannel":true,
		"availableModels":["allowed-model"]
	}`)
	if got := request(t, handler, http.MethodPut, "/api/site-policy", policy); got.Code != http.StatusOK {
		t.Fatalf("policy status=%d body=%s", got.Code, got.Body.String())
	}
	response := request(t, handler, http.MethodPost, "/api/provider-text", []byte(
		`{"channelId":"personal","model":"blocked-model","prompt":"hello","images":[]}`,
	))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), modelNotAllowedMessage) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProviderTextAuditPayloadDoesNotPersistPromptContents(t *testing.T) {
	prompt := "do not persist this secret: sk-private-value"
	payload := providerTextAuditPayload(providerTextRequest{
		ChannelID: "personal",
		Model:     "gpt-test",
		Prompt:    prompt,
		Images:    []string{"data:image/png;base64,cGl4ZWw="},
	}, "openai")
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal audit payload: %v", err)
	}
	if strings.Contains(string(encoded), prompt) || strings.Contains(string(encoded), "sk-private-value") {
		t.Fatalf("audit payload leaked prompt content: %s", encoded)
	}
	if payload["promptRunes"] != utf8.RuneCountInString(prompt) {
		t.Fatalf("prompt rune count=%v", payload["promptRunes"])
	}
}

func TestProviderTextEndpointRejectsTrailingJSON(t *testing.T) {
	_, _, handler := sharedChannelHandler(t)
	response := request(t, handler, http.MethodPost, "/api/provider-text", []byte(
		`{"channelId":"personal","model":"gpt-test","prompt":"hello"}{}`,
	))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
