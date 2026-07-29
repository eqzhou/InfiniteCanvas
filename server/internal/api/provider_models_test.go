package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func providerFixtureKey(name string) string {
	return "test-" + name + "-key"
}

func TestProviderModelsProxyNormalizesOpenAICompatibleCatalogs(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer test-provider-key" {
			t.Fatalf("unexpected provider request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{
			"data":[{"id":" model-z "},{"id":"model-a"}],
			"models":[{"name":"models/model-b"},{"id":"model-a"},{"name":""}]
		}`))
	}))
	defer upstream.Close()

	models, err := fetchProviderModelsWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL, APIKey: providerFixtureKey("provider"), Protocol: "openai",
	}, upstream.Client(), true)
	if err != nil || len(models) != 3 ||
		models[0] != "model-a" || models[1] != "model-b" || models[2] != "model-z" {
		t.Fatalf("unexpected models=%v err=%v", models, err)
	}
}

func TestProviderModelsProxyUsesGeminiAuthentication(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" || r.Header.Get("x-goog-api-key") != "test-gemini-key" {
			t.Fatalf("unexpected provider request: %s key=%q", r.URL.Path, r.Header.Get("x-goog-api-key"))
		}
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-2.5-flash"}]}`))
	}))
	defer upstream.Close()

	models, err := fetchProviderModelsWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL + "/v1beta", APIKey: providerFixtureKey("gemini"), Protocol: "gemini",
	}, upstream.Client(), true)
	if err != nil || len(models) != 1 || models[0] != "gemini-2.5-flash" {
		t.Fatalf("models=%v err=%v", models, err)
	}
}

func TestProviderModelsProxySupportsArkCompatibleCatalogs(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/models" || r.Header.Get("Authorization") != "Bearer test-ark-key" {
			t.Fatalf("unexpected provider request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"seedance-2"}]}`))
	}))
	defer upstream.Close()

	models, err := fetchProviderModelsWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL + "/api/v3", APIKey: providerFixtureKey("ark"), Protocol: "ark",
	}, upstream.Client(), true)
	if err != nil || len(models) != 1 || models[0] != "seedance-2" {
		t.Fatalf("models=%v err=%v", models, err)
	}
}

func TestProviderModelsProxyReturnsAUsefulUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "invalid key", http.StatusUnauthorized)
	}))
	defer upstream.Close()

	_, err := fetchProviderModelsWithClient(context.Background(), providerModelConnection{
		BaseURL: upstream.URL, APIKey: providerFixtureKey("bad"), Protocol: "openai",
	}, upstream.Client(), true)
	if err == nil || err.Error() != "provider authentication failed" {
		t.Fatalf("err=%v", err)
	}
}

func TestProviderModelsEndpointRejectsServerLoopback(t *testing.T) {
	_, _, handler := sharedChannelHandler(t)
	config := []byte(`{"channels":[{"id":"local","baseUrl":"http://127.0.0.1:9999","providers":{"text":{"baseUrl":"http://127.0.0.1:9999","model":"x","protocol":"openai"}}}]}`)
	if got := request(t, handler, http.MethodPut, "/api/state/config", config); got.Code != http.StatusNoContent {
		t.Fatalf("config status=%d body=%s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"local":{"text":"test-key"}}}`)); got.Code != http.StatusNoContent {
		t.Fatalf("secret status=%d body=%s", got.Code, got.Body.String())
	}
	response := request(t, handler, http.MethodPost, "/api/provider-models", []byte(`{"channelId":"local","kind":"text"}`))
	if response.Code != http.StatusUnprocessableEntity || !bytes.Contains(response.Body.Bytes(), []byte("public HTTPS")) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProviderModelsEndpointRejectsTrailingJSON(t *testing.T) {
	_, _, handler := sharedChannelHandler(t)
	response := request(t, handler, http.MethodPost, "/api/provider-models", []byte(
		`{"channelId":"personal","kind":"text"}{}`,
	))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
