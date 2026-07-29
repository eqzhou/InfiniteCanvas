package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxProviderModelRequestBytes  = 80 << 10
	maxProviderModelResponseBytes = 2 << 20
	maxProviderModels             = 1000
)

type providerModelRequest struct {
	ChannelID string `json:"channelId"`
	Kind      string `json:"kind"`
}

type providerModelList struct {
	Models []string `json:"models"`
}

type providerModelConnection struct {
	BaseURL                   string
	APIKey                    string
	Protocol                  string
	SystemPrompt              string
	WorkflowAgentSystemPrompt string
	Timeout                   time.Duration
}

var providerModelHTTPClient = newProviderHTTPClient(10 * time.Minute)
var providerModelRequestSlots = make(chan struct{}, 8)

func newProviderHTTPClient(timeout time.Duration) *http.Client {
	return newProviderHTTPClientWithResponseHeaderTimeout(timeout, 0)
}

func newProviderHTTPClientWithResponseHeaderTimeout(
	timeout time.Duration,
	responseHeaderTimeout time.Duration,
) *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           safeGenerationDialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func providerModelsEndpoint(baseURL, protocol string, allowLoopback bool) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", errors.New("invalid provider URL")
	}
	if !allowLoopback && (parsed.Scheme != "https" || isExplicitLoopbackHost(parsed.Hostname())) {
		return "", errors.New("provider URL must use public HTTPS")
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if protocol == "gemini" {
		if basePath == "" {
			basePath = "/v1beta"
		}
		parsed.Path = path.Clean(basePath + "/models")
		return parsed.String(), nil
	}
	return generationProviderEndpoint(parsed.String(), "/models")
}

func parseProviderModels(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(body, &payload) != nil || len(payload.Data)+len(payload.Models) > maxProviderModels {
		return nil, errors.New("invalid provider model response")
	}
	seen := map[string]struct{}{}
	models := make([]string, 0, len(payload.Data)+len(payload.Models))
	add := func(value string) {
		value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "models/"))
		if value == "" || len(value) > 500 {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		models = append(models, value)
	}
	for _, item := range payload.Data {
		add(item.ID)
	}
	for _, raw := range payload.Models {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			add(value)
			continue
		}
		var item struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &item) == nil {
			if item.ID != "" {
				add(item.ID)
			} else {
				add(item.Name)
			}
		}
	}
	sort.Strings(models)
	return models, nil
}

func fetchProviderModelsWithClient(
	ctx context.Context,
	input providerModelConnection,
	client *http.Client,
	allowLoopback bool,
) ([]string, error) {
	input.Protocol = strings.ToLower(strings.TrimSpace(input.Protocol))
	if input.Protocol == "" {
		input.Protocol = "openai"
	}
	if input.Protocol != "openai" && input.Protocol != "gemini" &&
		input.Protocol != "apimart" && input.Protocol != "ark" {
		return nil, errors.New("model discovery is unsupported for this protocol")
	}
	if strings.TrimSpace(input.APIKey) == "" || len(input.APIKey) > 64<<10 {
		return nil, errors.New("provider API key is not configured")
	}
	endpoint, err := providerModelsEndpoint(input.BaseURL, input.Protocol, allowLoopback)
	if err != nil {
		return nil, err
	}
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errors.New("failed to create provider model request")
	}
	if input.Protocol == "gemini" {
		request.Header.Set("x-goog-api-key", input.APIKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+input.APIKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("provider model request failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return nil, errors.New("provider authentication failed")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("provider returned an unsuccessful status")
	}
	body, err := readBounded(response.Body, maxProviderModelResponseBytes)
	if err != nil {
		return nil, errors.New("provider model response exceeds limits")
	}
	return parseProviderModels(body)
}

func fetchProviderModels(ctx context.Context, input providerModelConnection) ([]string, error) {
	return fetchProviderModelsWithClient(ctx, input, providerModelHTTPClient, false)
}

func (s *Server) resolveProviderModelConnection(r *http.Request, input providerModelRequest) (providerModelConnection, error) {
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	if input.ChannelID == "" || len(input.ChannelID) > 128 {
		return providerModelConnection{}, errors.New("invalid channel")
	}
	if input.Kind != "text" && input.Kind != "image" && input.Kind != "video" && input.Kind != "audio" {
		return providerModelConnection{}, errors.New("invalid provider kind")
	}
	tenantID := tenantIDFrom(r)
	configKey, tenantWide := requestStateStorageKey(r, "config")
	configValue, err := s.store.GetState(r.Context(), tenantID, configKey)
	if errors.Is(err, store.ErrNotFound) && !tenantWide {
		configValue, err = s.store.GetState(r.Context(), tenantID, "config")
	}
	if err != nil || len(configValue) > 1<<20 {
		return providerModelConnection{}, errors.New("provider configuration is unavailable")
	}
	var config storedImageConfig
	if json.Unmarshal(configValue, &config) != nil || len(config.Channels) > 100 {
		return providerModelConnection{}, errors.New("invalid provider configuration")
	}
	var selected *storedImageChannel
	for index := range config.Channels {
		if config.Channels[index].ID == input.ChannelID {
			selected = &config.Channels[index]
			break
		}
	}
	if selected == nil {
		return providerModelConnection{}, errors.New("channel not found")
	}
	provider, ok := selected.Providers[input.Kind]
	if !ok {
		model := selected.DefaultTextModel
		switch input.Kind {
		case "image":
			model = selected.DefaultImageModel
		case "video":
			model = selected.DefaultVideoModel
		case "audio":
			model = selected.DefaultAudioModel
		}
		provider = storedImageProvider{BaseURL: selected.BaseURL, Model: model, Protocol: "openai"}
	}
	secretKey, _ := secretStorageKey(r)
	secretValue, err := s.decryptSecretsKey(r.Context(), tenantID, secretKey)
	if err != nil {
		return providerModelConnection{}, errors.New("provider API key is unavailable")
	}
	var secrets storedConfigSecrets
	if json.Unmarshal(secretValue, &secrets) != nil {
		return providerModelConnection{}, errors.New("invalid provider credentials")
	}
	timeout, err := personalChannelTimeout(selected.TimeoutSeconds)
	if err != nil {
		return providerModelConnection{}, err
	}
	return providerModelConnection{
		BaseURL:                   provider.BaseURL,
		APIKey:                    secrets.APIKeys[input.ChannelID][input.Kind],
		Protocol:                  provider.Protocol,
		SystemPrompt:              config.SystemPrompt,
		WorkflowAgentSystemPrompt: config.WorkflowAgentSystemPrompt,
		Timeout:                   timeout,
	}, nil
}

func (s *Server) getProviderModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxProviderModelRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input providerModelRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid provider model request", http.StatusBadRequest)
		return
	}
	connection, err := s.resolveProviderModelConnection(r, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	select {
	case providerModelRequestSlots <- struct{}{}:
		defer func() { <-providerModelRequestSlots }()
	default:
		http.Error(w, "too many model discovery requests", http.StatusTooManyRequests)
		return
	}
	models, err := fetchProviderModels(r.Context(), connection)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, providerModelList{Models: models})
}
