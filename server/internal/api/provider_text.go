package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxProviderTextRequestBytes  = 24 << 20
	maxProviderTextResponseBytes = 4 << 20
	maxProviderTextPromptRunes   = 100_000
	maxProviderTextSystemRunes   = 20_000
	maxProviderTextImages        = 9
	maxProviderTextImageBytes    = 8 << 20
	maxProviderTextImagesBytes   = 16 << 20
)

type providerTextRequest struct {
	ChannelID           string   `json:"channelId"`
	Model               string   `json:"model"`
	Prompt              string   `json:"prompt"`
	Images              []string `json:"images"`
	SystemPromptProfile string   `json:"systemPromptProfile,omitempty"`
	ReasoningEffort     string   `json:"reasoningEffort,omitempty"`
	SystemPrompt        string   `json:"-"`
	AuditEndpoint       string   `json:"-"`
}

type providerTextResult struct {
	Text string `json:"text"`
}

var providerTextHTTPClient = newProviderHTTPClient(10 * time.Minute)

type providerTextAdmissionGate struct {
	mu             sync.Mutex
	global         chan struct{}
	tenantLimit    int
	userLimit      int
	tenantInFlight map[string]int
	userInFlight   map[string]int
}

func newProviderTextAdmissionGate(
	globalLimit int,
	tenantLimit int,
	userLimit int,
) *providerTextAdmissionGate {
	return &providerTextAdmissionGate{
		global:         make(chan struct{}, globalLimit),
		tenantLimit:    tenantLimit,
		userLimit:      userLimit,
		tenantInFlight: make(map[string]int),
		userInFlight:   make(map[string]int),
	}
}

func (gate *providerTextAdmissionGate) acquire(tenantID, userID string) (func(), bool) {
	userKey := tenantID + "\x00" + userID
	gate.mu.Lock()
	if gate.tenantInFlight[tenantID] >= gate.tenantLimit ||
		gate.userInFlight[userKey] >= gate.userLimit {
		gate.mu.Unlock()
		return nil, false
	}
	select {
	case gate.global <- struct{}{}:
		gate.tenantInFlight[tenantID]++
		gate.userInFlight[userKey]++
		gate.mu.Unlock()
	default:
		gate.mu.Unlock()
		return nil, false
	}
	return func() {
		gate.mu.Lock()
		gate.tenantInFlight[tenantID]--
		gate.userInFlight[userKey]--
		if gate.tenantInFlight[tenantID] == 0 {
			delete(gate.tenantInFlight, tenantID)
		}
		if gate.userInFlight[userKey] == 0 {
			delete(gate.userInFlight, userKey)
		}
		<-gate.global
		gate.mu.Unlock()
	}, true
}

var providerTextBodyAdmission = newProviderTextAdmissionGate(8, 4, 2)
var providerTextAdmission = newProviderTextAdmissionGate(8, 4, 2)

func validateProviderTextRequest(input providerTextRequest) error {
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	input.Model = strings.TrimSpace(input.Model)
	if input.ChannelID == "" || len(input.ChannelID) > 128 {
		return errors.New("invalid channel")
	}
	if input.Model == "" || len(input.Model) > 500 {
		return errors.New("invalid model")
	}
	if utf8.RuneCountInString(input.Prompt) > maxProviderTextPromptRunes ||
		utf8.RuneCountInString(input.SystemPrompt) > maxProviderTextSystemRunes {
		return errors.New("text generation prompt exceeds limits")
	}
	if input.SystemPromptProfile != "" && input.SystemPromptProfile != "global" &&
		input.SystemPromptProfile != "workflow" {
		return errors.New("invalid system prompt profile")
	}
	if input.ReasoningEffort != "" && input.ReasoningEffort != "low" &&
		input.ReasoningEffort != "medium" && input.ReasoningEffort != "high" {
		return errors.New("invalid reasoning effort")
	}
	if strings.TrimSpace(input.Prompt) == "" && len(input.Images) == 0 {
		return errors.New("text generation prompt is required")
	}
	if len(input.Images) > maxProviderTextImages {
		return errors.New("too many text generation images")
	}
	var imageBytes int64
	for _, image := range input.Images {
		size, err := validateProviderTextImage(image)
		if err != nil {
			return err
		}
		imageBytes += size
		if imageBytes > maxProviderTextImagesBytes {
			return errors.New("text generation images exceed limits")
		}
	}
	return nil
}

func validateProviderTextImage(value string) (int64, error) {
	if strings.HasPrefix(value, "data:image/") {
		separator := strings.Index(value, ";base64,")
		if separator < len("data:image/")+1 {
			return 0, errors.New("invalid text generation image")
		}
		encoded := value[separator+len(";base64,"):]
		decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
		size, err := io.Copy(io.Discard, io.LimitReader(decoder, maxProviderTextImageBytes+1))
		if err != nil || size > maxProviderTextImageBytes {
			return 0, errors.New("invalid text generation image")
		}
		return size, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.Fragment != "" || len(value) > 20_000 {
		return 0, errors.New("invalid text generation image")
	}
	return 0, nil
}

func providerTextEndpoint(baseURL, protocol, model, suffix string, allowLoopback bool) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", errors.New("invalid provider URL")
	}
	if !allowLoopback && (parsed.Scheme != "https" || isExplicitLoopbackHost(parsed.Hostname())) {
		return "", errors.New("provider URL must use public HTTPS")
	}
	if protocol != "gemini" {
		return generationProviderEndpoint(parsed.String(), suffix)
	}
	if strings.ContainsAny(model, "/?#") {
		return "", errors.New("invalid Gemini model")
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if basePath == "" {
		basePath = "/v1beta"
	}
	parsed.Path = path.Clean(basePath + "/models/" + model + ":generateContent")
	parsed.RawPath = path.Clean(basePath + "/models/" + url.PathEscape(model) + ":generateContent")
	return parsed.String(), nil
}

func providerTextInput(input providerTextRequest) []map[string]any {
	content := []map[string]any{{"type": "input_text", "text": input.Prompt}}
	for _, image := range input.Images {
		content = append(content, map[string]any{"type": "input_image", "image_url": image})
	}
	return []map[string]any{{"role": "user", "content": content}}
}

func providerChatMessages(input providerTextRequest) []map[string]any {
	messages := make([]map[string]any, 0, 2)
	if system := strings.TrimSpace(input.SystemPrompt); system != "" {
		messages = append(messages, map[string]any{"role": "system", "content": system})
	}
	var content any = input.Prompt
	if len(input.Images) > 0 {
		parts := []map[string]any{{"type": "text", "text": input.Prompt}}
		for _, image := range input.Images {
			parts = append(parts, map[string]any{
				"type": "image_url", "image_url": map[string]any{"url": image},
			})
		}
		content = parts
	}
	return append(messages, map[string]any{"role": "user", "content": content})
}

func providerGeminiBody(input providerTextRequest) map[string]any {
	parts := []map[string]any{{"text": input.Prompt}}
	for _, image := range input.Images {
		if strings.HasPrefix(image, "data:") {
			separator := strings.Index(image, ";base64,")
			parts = append(parts, map[string]any{"inlineData": map[string]any{
				"mimeType": strings.TrimPrefix(image[:separator], "data:"),
				"data":     image[separator+len(";base64,"):],
			}})
		} else {
			parts = append(parts, map[string]any{"fileData": map[string]any{"fileUri": image}})
		}
	}
	body := map[string]any{"contents": []map[string]any{{"role": "user", "parts": parts}}}
	if system := strings.TrimSpace(input.SystemPrompt); system != "" {
		body["systemInstruction"] = map[string]any{"parts": []map[string]any{{"text": system}}}
	}
	return body
}

func requestProviderText(
	ctx context.Context,
	client *http.Client,
	endpoint, apiKey, protocol string,
	body any,
) (int, []byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, nil, errors.New("failed to encode provider text request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, errors.New("failed to create provider text request")
	}
	request.Header.Set("Content-Type", "application/json")
	if protocol == "gemini" {
		request.Header.Set("x-goog-api-key", apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, errors.New("provider text request failed")
	}
	defer response.Body.Close()
	responseBody, err := readBounded(response.Body, maxProviderTextResponseBytes)
	if err != nil {
		return response.StatusCode, nil, errors.New("provider text response exceeds limits")
	}
	return response.StatusCode, responseBody, nil
}

func providerTextStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return errors.New("provider authentication failed")
	case http.StatusTooManyRequests:
		return errors.New("provider rate limit reached")
	default:
		return errors.New("provider returned an unsuccessful status")
	}
}

func parseOpenAIText(body []byte) (string, error) {
	var payload struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return "", errors.New("invalid provider text response")
	}
	if payload.OutputText != "" {
		return payload.OutputText, nil
	}
	chunks := make([]string, 0)
	for _, output := range payload.Output {
		for _, content := range output.Content {
			if content.Text != "" {
				chunks = append(chunks, content.Text)
			}
		}
	}
	if len(chunks) > 0 {
		return strings.Join(chunks, "\n"), nil
	}
	if len(payload.Choices) > 0 {
		return payload.Choices[0].Message.Content, nil
	}
	return "", errors.New("provider returned no text")
}

func parseGeminiText(body []byte) (string, error) {
	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if json.Unmarshal(body, &payload) != nil || len(payload.Candidates) == 0 {
		return "", errors.New("invalid provider text response")
	}
	chunks := make([]string, 0)
	for _, part := range payload.Candidates[0].Content.Parts {
		if part.Text != "" {
			chunks = append(chunks, part.Text)
		}
	}
	if len(chunks) == 0 {
		return "", errors.New("provider returned no text")
	}
	return strings.Join(chunks, "\n"), nil
}

func fetchProviderTextWithClient(
	ctx context.Context,
	connection providerModelConnection,
	input *providerTextRequest,
	client *http.Client,
	allowLoopback bool,
) (string, error) {
	if input == nil {
		return "", errors.New("text generation request is missing")
	}
	input.AuditEndpoint = ""
	connection.Protocol = strings.ToLower(strings.TrimSpace(connection.Protocol))
	if connection.Protocol == "" {
		connection.Protocol = "openai"
	}
	if connection.Protocol != "openai" && connection.Protocol != "gemini" {
		return "", errors.New("text generation is unsupported for this protocol")
	}
	if strings.TrimSpace(connection.APIKey) == "" || len(connection.APIKey) > 64<<10 {
		return "", errors.New("provider API key is not configured")
	}
	if err := validateProviderTextRequest(*input); err != nil {
		return "", err
	}
	timeout := connection.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if connection.Protocol == "gemini" {
		endpoint, err := providerTextEndpoint(connection.BaseURL, "gemini", input.Model, "", allowLoopback)
		if err != nil {
			return "", err
		}
		input.AuditEndpoint = endpoint
		status, body, err := requestProviderText(
			requestCtx, client, endpoint, connection.APIKey, "gemini", providerGeminiBody(*input),
		)
		if err != nil {
			return "", err
		}
		if status < 200 || status >= 300 {
			return "", providerTextStatusError(status)
		}
		return parseGeminiText(body)
	}

	responsesEndpoint, err := providerTextEndpoint(connection.BaseURL, "openai", input.Model, "/responses", allowLoopback)
	if err != nil {
		return "", err
	}
	input.AuditEndpoint = responsesEndpoint
	responsesBody := map[string]any{"model": input.Model, "input": providerTextInput(*input)}
	if input.ReasoningEffort != "" {
		responsesBody["reasoning"] = map[string]any{"effort": input.ReasoningEffort}
	}
	if system := strings.TrimSpace(input.SystemPrompt); system != "" {
		responsesBody["instructions"] = system
	}
	status, body, err := requestProviderText(
		requestCtx, client, responsesEndpoint, connection.APIKey, "openai", responsesBody,
	)
	if err != nil {
		return "", err
	}
	if status >= 200 && status < 300 {
		return parseOpenAIText(body)
	}
	if status != http.StatusNotFound && status != http.StatusMethodNotAllowed && status != http.StatusNotImplemented {
		return "", providerTextStatusError(status)
	}

	chatEndpoint, err := providerTextEndpoint(connection.BaseURL, "openai", input.Model, "/chat/completions", allowLoopback)
	if err != nil {
		return "", err
	}
	input.AuditEndpoint = chatEndpoint
	chatBody := map[string]any{
		"model": input.Model, "messages": providerChatMessages(*input),
	}
	if input.ReasoningEffort != "" {
		chatBody["reasoning_effort"] = input.ReasoningEffort
	}
	status, body, err = requestProviderText(
		requestCtx, client, chatEndpoint, connection.APIKey, "openai", chatBody,
	)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", providerTextStatusError(status)
	}
	return parseOpenAIText(body)
}

const defaultWorkflowAgentSystemPrompt = "你是图片创作工作流设计助手。\n" +
	"只返回一个 JSON 对象，不要 Markdown。\n" +
	"对象必须包含 title、description、category、variables、steps。\n" +
	"variables 支持 text、textarea、select、number、boolean、image；steps 为 1-16 个图片步骤。\n" +
	"提示词变量只能使用 {{变量ID}}，步骤图片依赖必须放在 references。"

func providerTextSystemPrompt(connection providerModelConnection, profile string) (string, error) {
	systemPrompt := connection.SystemPrompt
	if profile == "workflow" {
		systemPrompt = strings.TrimSpace(connection.WorkflowAgentSystemPrompt)
		if systemPrompt == "" {
			systemPrompt = defaultWorkflowAgentSystemPrompt
		}
	}
	if utf8.RuneCountInString(systemPrompt) > maxProviderTextSystemRunes {
		return "", errors.New("configured system prompt exceeds limits")
	}
	return systemPrompt, nil
}

func providerTextAuditPayload(input providerTextRequest, protocol string) map[string]any {
	payload := map[string]any{
		"source":              "server-proxy",
		"protocol":            protocol,
		"model":               input.Model,
		"promptRunes":         utf8.RuneCountInString(input.Prompt),
		"imageCount":          len(input.Images),
		"systemPromptProfile": input.SystemPromptProfile,
	}
	if endpoint := strings.TrimSpace(input.AuditEndpoint); endpoint != "" {
		payload["method"], payload["endpoint"] = "POST", endpoint
	}
	return payload
}

func (s *Server) generateProviderText(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	tenantID := tenantIDFrom(r)
	userID := "process"
	if user, ok := authUserFrom(r.Context()); ok && strings.TrimSpace(user.ID) != "" {
		userID = user.ID
	}
	releaseBody, admitted := providerTextBodyAdmission.acquire(tenantID, userID)
	if !admitted {
		http.Error(w, "too many text generation requests", http.StatusTooManyRequests)
		return
	}
	bodyAdmissionReleased := false
	defer func() {
		if !bodyAdmissionReleased {
			releaseBody()
		}
	}()
	r.Body = http.MaxBytesReader(w, r.Body, maxProviderTextRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input providerTextRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid text generation request", http.StatusBadRequest)
		return
	}
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	input.Model = strings.TrimSpace(input.Model)
	if err := validateProviderTextRequest(input); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	if !s.requireAllowedModel(w, r, input.Model) {
		return
	}
	connection, err := s.resolveProviderModelConnection(r, providerModelRequest{
		ChannelID: input.ChannelID, Kind: "text",
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	input.SystemPrompt, err = providerTextSystemPrompt(connection, input.SystemPromptProfile)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	releaseBody()
	bodyAdmissionReleased = true
	releaseProvider, admitted := providerTextAdmission.acquire(tenantID, userID)
	if !admitted {
		http.Error(w, "too many text generation requests", http.StatusTooManyRequests)
		return
	}
	defer releaseProvider()
	startedAt := time.Now()
	text, err := fetchProviderTextWithClient(r.Context(), connection, &input, providerTextHTTPClient, false)
	status := "succeeded"
	errorMessage := ""
	if err != nil {
		status = "failed"
		errorMessage = err.Error()
	}
	s.recordAICallLog(
		r.Context(),
		tenantID,
		store.GenerationJob{
			ID: randomID("text"), Kind: "text", ProviderID: input.ChannelID, Model: input.Model,
		},
		status,
		time.Since(startedAt).Milliseconds(),
		errorMessage,
		providerTextAuditPayload(input, connection.Protocol),
		map[string]any{"ok": err == nil, "textBytes": len(text)},
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, providerTextResult{Text: text})
}
