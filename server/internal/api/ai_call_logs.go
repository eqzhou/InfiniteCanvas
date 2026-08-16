package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func (s *Server) requireAICallLogAdmin(w http.ResponseWriter, r *http.Request) bool {
	return s.requireTenantOwner(w, r, "tenant AI call logs unavailable")
}

func (s *Server) listAICallLogs(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	q := store.AICallLogQuery{
		Q:       strings.TrimSpace(r.URL.Query().Get("q")),
		Kind:    strings.TrimSpace(r.URL.Query().Get("kind")),
		Status:  strings.TrimSpace(r.URL.Query().Get("status")),
		Channel: strings.TrimSpace(r.URL.Query().Get("channel")),
	}
	if page, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil {
		q.Page = page
	}
	if pageSize, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil {
		q.PageSize = pageSize
	}
	result, err := s.store.ListAICallLogs(r.Context(), tenantIDFrom(r), q)
	if err != nil {
		http.Error(w, "failed to list ai call logs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

func (s *Server) getAICallLog(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	entry, err := s.store.GetAICallLog(r.Context(), tenantIDFrom(r), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load ai call log", http.StatusInternalServerError)
		return
	}
	writeJSON(w, entry)
}

type deleteAICallLogsRequest struct {
	IDs           []string `json:"ids"`
	OlderThanDays *int     `json:"olderThanDays"`
	Before        string   `json:"before"`
}

func (s *Server) deleteAICallLogs(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	var body deleteAICallLogsRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	var deleted int64
	var err error
	if len(body.IDs) > 0 {
		clean := make([]string, 0, len(body.IDs))
		for _, id := range body.IDs {
			id = strings.TrimSpace(id)
			if id != "" {
				clean = append(clean, id)
			}
		}
		if len(clean) == 0 {
			http.Error(w, "ids required", http.StatusBadRequest)
			return
		}
		if len(clean) > 500 {
			http.Error(w, "too many ids", http.StatusBadRequest)
			return
		}
		deleted, err = s.store.DeleteAICallLogs(r.Context(), tenantID, clean)
	} else {
		var before time.Time
		if strings.TrimSpace(body.Before) != "" {
			parsed, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(body.Before))
			if parseErr != nil {
				parsed, parseErr = time.Parse(time.RFC3339, strings.TrimSpace(body.Before))
			}
			if parseErr != nil {
				http.Error(w, "invalid before timestamp", http.StatusBadRequest)
				return
			}
			before = parsed.UTC()
		} else if body.OlderThanDays != nil {
			days := *body.OlderThanDays
			if days < 1 || days > 3650 {
				http.Error(w, "olderThanDays must be between 1 and 3650", http.StatusBadRequest)
				return
			}
			before = time.Now().UTC().AddDate(0, 0, -days)
		} else {
			http.Error(w, "ids, olderThanDays, or before required", http.StatusBadRequest)
			return
		}
		deleted, err = s.store.DeleteAICallLogsBefore(r.Context(), tenantID, before)
	}
	if err != nil {
		http.Error(w, "failed to delete ai call logs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"deleted": deleted})
}

// recordAICallLog best-effort persists a sanitized audit entry for a finished AI proxy job.
func (s *Server) recordAICallLog(
	ctx context.Context,
	tenantID string,
	job store.GenerationJob,
	status string,
	durationMs int64,
	errorMessage string,
	request any,
	response any,
) {
	if s == nil || s.store == nil {
		return
	}
	reqJSON, err := sanitizeAICallLogJSON(request)
	if err != nil {
		reqJSON = json.RawMessage(`{}`)
	}
	resJSON, err := sanitizeAICallLogJSON(response)
	if err != nil {
		resJSON = json.RawMessage(`{}`)
	}
	entry := store.AICallLog{
		JobID:        job.ID,
		Kind:         strings.TrimSpace(job.Kind),
		ChannelID:    strings.TrimSpace(job.ProviderID),
		ChannelName:  strings.TrimSpace(job.ProviderID),
		Model:        strings.TrimSpace(job.Model),
		Status:       strings.TrimSpace(status),
		DurationMs:   durationMs,
		Error:        strings.TrimSpace(errorMessage),
		RequestJSON:  reqJSON,
		ResponseJSON: resJSON,
	}
	if entry.Kind == "" {
		entry.Kind = "unknown"
	}
	if entry.Status == "" {
		entry.Status = "unknown"
	}
	if entry.DurationMs < 0 {
		entry.DurationMs = 0
	}
	// Prefer protocol from sanitized request when present.
	var reqMeta map[string]any
	if json.Unmarshal(reqJSON, &reqMeta) == nil {
		if protocol, ok := reqMeta["protocol"].(string); ok {
			entry.Protocol = strings.TrimSpace(protocol)
		}
		if model, ok := reqMeta["model"].(string); ok && strings.TrimSpace(model) != "" {
			entry.Model = strings.TrimSpace(model)
		}
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.store.CreateAICallLog(writeCtx, tenantID, entry); err != nil {
		log.Printf("ai call log write failed for job %s/%s: %v", tenantID, job.ID, err)
	}
}

func sanitizeAICallLogJSON(value any) (json.RawMessage, error) {
	if value == nil {
		return json.RawMessage(`{}`), nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage(`{}`), nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	sanitized := redactAICallLogValue(decoded)
	out, err := json.Marshal(sanitized)
	if err != nil {
		return nil, err
	}
	// Keep admin payloads bounded.
	const maxBytes = 64 * 1024
	if len(out) > maxBytes {
		return json.Marshal(map[string]any{
			"_truncated": true,
			"_bytes":     len(out),
			"_preview":   string(out[:1024]),
		})
	}
	return json.RawMessage(out), nil
}

func normalizeAICallLogKey(key string) string {
	lower := strings.ToLower(strings.TrimSpace(key))
	var b strings.Builder
	b.Grow(len(lower))
	for _, r := range lower {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func isSensitiveAICallLogKey(key string) bool {
	lower := strings.ToLower(key)
	normalized := normalizeAICallLogKey(key)
	if strings.Contains(lower, "apikey") ||
		strings.Contains(lower, "api_key") ||
		strings.Contains(lower, "authorization") ||
		strings.Contains(lower, "password") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "token") ||
		strings.Contains(lower, "credential") ||
		strings.Contains(lower, "privatekey") ||
		strings.Contains(lower, "private_key") {
		return true
	}
	switch normalized {
	case "xapikey", "accesskey", "accesskeyid", "secretaccesskey", "sessiontoken", "clientsecret", "refreshtoken":
		return true
	default:
		return false
	}
}

func redactAICallLogValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			lower := strings.ToLower(key)
			if isSensitiveAICallLogKey(key) {
				out[key] = "[redacted]"
				continue
			}
			if lower == "endpoint" || lower == "baseurl" {
				if endpoint, ok := item.(string); ok {
					out[key] = sanitizeAICallLogURL(endpoint)
					continue
				}
			}
			if lower == "data" || lower == "b64_json" || lower == "bytes" {
				switch v := item.(type) {
				case string:
					out[key] = map[string]any{"_omitted": true, "bytes": len(v)}
					continue
				case []any:
					out[key] = map[string]any{"_omitted": true, "count": len(v)}
					continue
				}
			}
			out[key] = redactAICallLogValue(item)
		}
		return out
	case []any:
		if len(typed) > 32 {
			trimmed := make([]any, 0, 33)
			for _, item := range typed[:32] {
				trimmed = append(trimmed, redactAICallLogValue(item))
			}
			trimmed = append(trimmed, map[string]any{"_truncated": true, "remaining": len(typed) - 32})
			return trimmed
		}
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, redactAICallLogValue(item))
		}
		return out
	case string:
		if len(typed) > 8*1024 {
			return typed[:8*1024] + "…[truncated]"
		}
		return typed
	default:
		return typed
	}
}

// sanitizeAICallLogURL keeps the route useful to administrators while
// removing query strings, credentials, and fragments that may carry secrets.
func sanitizeAICallLogURL(raw string) string {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil {
		return "[redacted]"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func auditReferenceImages(keys []string, references []generatedImage) []map[string]any {
	count := len(keys)
	if len(references) > count {
		count = len(references)
	}
	if count == 0 {
		return nil
	}
	items := make([]map[string]any, 0, count)
	for index := 0; index < count; index++ {
		item := map[string]any{"index": index + 1}
		if index < len(keys) && strings.TrimSpace(keys[index]) != "" {
			key := strings.TrimSpace(keys[index])
			if len(key) > 512 {
				key = key[:512] + "…"
			}
			item["storageKey"] = key
		}
		if index < len(references) {
			if mimeType := strings.TrimSpace(references[index].MIMEType); mimeType != "" {
				item["mimeType"] = mimeType
			}
			if len(references[index].Data) > 0 {
				item["bytes"] = len(references[index].Data)
			}
		}
		items = append(items, item)
	}
	return items
}

func auditImageEndpoint(request imageGenerationRequest) string {
	var endpoint string
	switch strings.ToLower(strings.TrimSpace(request.Protocol)) {
	case "", "openai":
		endpoint, _ = imageProviderEndpoint(request.BaseURL, len(request.References) > 0)
	case "gemini":
		endpoint, _ = geminiImageProviderEndpoint(request.BaseURL, request.Model)
	case "template":
		endpoint, _ = imageTemplateEndpoint(request.BaseURL, request.Template)
	case "apimart":
		endpoint, _ = generationProviderEndpoint(request.BaseURL, "/images/generations")
	case "kie":
		endpoint, _ = kieAPIEndpoint(request.BaseURL, "/jobs/createTask")
	}
	return endpoint
}

func imageRequestAuditPayload(request imageGenerationRequest) map[string]any {
	payload := map[string]any{
		"protocol":              request.Protocol,
		"baseUrl":               request.BaseURL,
		"model":                 request.Model,
		"prompt":                request.Prompt,
		"size":                  request.Size,
		"quality":               request.Quality,
		"count":                 request.Count,
		"transparentBackground": request.TransparentBackground,
		"referenceCount":        len(request.References),
	}
	if requestID := strings.TrimSpace(request.RequestID); requestID != "" {
		payload["requestId"] = requestID
	}
	if endpoint := auditImageEndpoint(request); endpoint != "" {
		method := "POST"
		if strings.EqualFold(strings.TrimSpace(request.Protocol), "template") && request.Template != nil && request.Template.Method != "" {
			method = request.Template.Method
		}
		payload["method"] = method
		payload["endpoint"] = endpoint
	}
	if references := auditReferenceImages(request.ReferenceStorageKeys, request.References); len(references) > 0 {
		payload["referenceImages"] = references
	}
	if request.Source != nil {
		payload["source"] = request.Source
	}
	return payload
}

func mediaRequestAuditPayload(request resolvedMediaRequest, kind string) map[string]any {
	if kind == "audio" {
		payload := map[string]any{
			"protocol": request.Audio.Protocol,
			"baseUrl":  request.Audio.BaseURL,
			"model":    request.Audio.Model,
			"prompt":   request.Audio.Prompt,
			"voice":    request.Audio.Voice,
			"format":   request.Audio.Format,
		}
		var endpoint string
		var err error
		method := "POST"
		switch strings.ToLower(strings.TrimSpace(request.Audio.Protocol)) {
		case "azure":
			endpoint, err = azureSpeechEndpoint(request.Audio.BaseURL)
		case "edge":
			endpoint, err = edgeSpeechEndpoint(request.Audio.BaseURL)
			method = "WEBSOCKET"
		default:
			endpoint, err = generationProviderEndpoint(request.Audio.BaseURL, "/audio/speech")
		}
		if err == nil {
			payload["method"], payload["endpoint"] = method, endpoint
		}
		return payload
	}
	payload := map[string]any{
		"protocol":       request.Video.Protocol,
		"baseUrl":        request.Video.BaseURL,
		"model":          request.Video.Model,
		"prompt":         request.Video.Prompt,
		"size":           request.Video.Size,
		"seconds":        request.Video.Seconds,
		"ratio":          request.Video.Ratio,
		"resolution":     request.Video.Resolution,
		"generateAudio":  request.Video.GenerateAudio,
		"watermark":      request.Video.Watermark,
		"frameMode":      request.Video.FrameMode,
		"referenceCount": len(request.Video.References),
	}
	var endpoint string
	switch strings.ToLower(strings.TrimSpace(request.Video.Protocol)) {
	case "ark":
		endpoint, _ = generationProviderEndpoint(request.Video.BaseURL, "/contents/generations/tasks")
	case "apimart":
		endpoint, _ = generationProviderEndpoint(request.Video.BaseURL, "/videos/generations")
	case "kie":
		endpoint, _ = kieAPIEndpoint(request.Video.BaseURL, "/jobs/createTask")
	case "template":
		endpoint, _ = imageTemplateEndpoint(request.Video.BaseURL, request.Video.Template)
	default:
		capability, registered := resolveProviderModelCapability(request.Video.Protocol, "video", request.Video.Model)
		suffix := "/videos"
		if registered && capability.Family == "grok-imagine-video" {
			suffix = "/videos/generations"
		}
		endpoint, _ = generationProviderEndpoint(request.Video.BaseURL, suffix)
	}
	if endpoint != "" {
		method := "POST"
		if strings.EqualFold(strings.TrimSpace(request.Video.Protocol), "template") && request.Video.Template != nil && request.Video.Template.Method != "" {
			method = request.Video.Template.Method
		}
		payload["method"], payload["endpoint"] = method, endpoint
	}
	if len(request.Video.ReferenceStorageKeys) > 0 {
		references := make([]map[string]any, 0, len(request.Video.ReferenceStorageKeys))
		for index, key := range request.Video.ReferenceStorageKeys {
			key = strings.TrimSpace(key)
			if len(key) > 512 {
				key = key[:512] + "…"
			}
			references = append(references, map[string]any{"index": index + 1, "storageKey": key})
		}
		payload["referenceMedia"] = references
	}
	return payload
}

type clientAICallLogReport struct {
	Kind        string          `json:"kind"`
	Status      string          `json:"status"`
	ChannelID   string          `json:"channelId,omitempty"`
	ChannelName string          `json:"channelName,omitempty"`
	Model       string          `json:"model,omitempty"`
	Protocol    string          `json:"protocol,omitempty"`
	DurationMs  int64           `json:"durationMs"`
	Error       string          `json:"error,omitempty"`
	Request     json.RawMessage `json:"request,omitempty"`
	Response    json.RawMessage `json:"response,omitempty"`
}

// reportClientAICallLog accepts a sanitized browser direct-connect audit row.
// Uploads are rejected unless an administrator enabled client reporting.
func (s *Server) reportClientAICallLog(w http.ResponseWriter, r *http.Request) {
	if s == nil || s.store == nil {
		http.Error(w, "ai call logs unavailable", http.StatusServiceUnavailable)
		return
	}
	// Process token when auth is off; any active session when auth is on.
	// Zero-user optional installs still require the process token so anonymous
	// browsers cannot spam audit rows before the first account exists.
	if authMode() == "off" {
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return
		}
	} else if user, ok := authUserFrom(r.Context()); ok {
		if strings.EqualFold(strings.TrimSpace(user.Status), "ban") {
			http.Error(w, "account disabled", http.StatusForbidden)
			return
		}
	} else if authMode() == "required" {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	} else {
		count, err := s.store.CountUsers(r.Context())
		if err != nil {
			http.Error(w, "failed to verify report access", http.StatusServiceUnavailable)
			return
		}
		if count != 0 || !s.authorizeProcessToken(r) {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
	}

	policy, err := s.loadAICallLogClientReport(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load client report policy", http.StatusInternalServerError)
		return
	}
	if !policy.Enabled {
		http.Error(w, "client ai call log reporting is disabled", http.StatusForbidden)
		return
	}

	var body clientAICallLogReport
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || ensureJSONEOF(dec) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	status := strings.ToLower(strings.TrimSpace(body.Status))
	switch kind {
	case "text", "image", "video", "audio":
	default:
		http.Error(w, "kind must be text, image, video, or audio", http.StatusBadRequest)
		return
	}
	switch status {
	case "succeeded", "failed", "cancelled":
	default:
		http.Error(w, "status must be succeeded, failed, or cancelled", http.StatusBadRequest)
		return
	}
	if body.DurationMs < 0 {
		body.DurationMs = 0
	}
	if body.DurationMs > 24*60*60*1000 {
		body.DurationMs = 24 * 60 * 60 * 1000
	}

	reqJSON, err := sanitizeAICallLogJSON(json.RawMessage(body.Request))
	if err != nil || len(body.Request) == 0 {
		reqJSON = json.RawMessage(`{}`)
	}
	resJSON, err := sanitizeAICallLogJSON(json.RawMessage(body.Response))
	if err != nil || len(body.Response) == 0 {
		resJSON = json.RawMessage(`{}`)
	}

	// Force source marker into request so admins can tell proxy vs browser logs.
	var reqMap map[string]any
	if json.Unmarshal(reqJSON, &reqMap) != nil || reqMap == nil {
		reqMap = map[string]any{}
	}
	reqMap["source"] = "client-direct"
	if protocol := strings.TrimSpace(body.Protocol); protocol != "" && reqMap["protocol"] == nil {
		reqMap["protocol"] = protocol
	}
	if model := strings.TrimSpace(body.Model); model != "" && reqMap["model"] == nil {
		reqMap["model"] = model
	}
	if rebuilt, err := json.Marshal(reqMap); err == nil {
		if sanitized, err := sanitizeAICallLogJSON(json.RawMessage(rebuilt)); err == nil {
			reqJSON = sanitized
		}
	}

	entry := store.AICallLog{
		UserID:       userIDFrom(r),
		Kind:         kind,
		ChannelID:    strings.TrimSpace(body.ChannelID),
		ChannelName:  strings.TrimSpace(body.ChannelName),
		Model:        strings.TrimSpace(body.Model),
		Protocol:     strings.TrimSpace(body.Protocol),
		Status:       status,
		DurationMs:   body.DurationMs,
		Error:        strings.TrimSpace(body.Error),
		RequestJSON:  reqJSON,
		ResponseJSON: resJSON,
	}
	if entry.ChannelName == "" {
		entry.ChannelName = entry.ChannelID
	}
	// These all land in Postgres text columns, which reject invalid UTF-8. A raw
	// byte slice splits the trailing rune of Chinese text and fails the INSERT,
	// losing the audit row entirely.
	entry.Error = truncateUTF8Bytes(entry.Error, 2000)
	entry.Model = truncateUTF8Bytes(entry.Model, 500)
	entry.ChannelID = truncateUTF8Bytes(entry.ChannelID, 128)
	entry.ChannelName = truncateUTF8Bytes(entry.ChannelName, 200)
	entry.Protocol = truncateUTF8Bytes(entry.Protocol, 64)

	created, err := s.store.CreateAICallLog(r.Context(), tenantIDFrom(r), entry)
	if err != nil {
		http.Error(w, "failed to record ai call log", http.StatusInternalServerError)
		return
	}
	writeJSON(w, created)
}
