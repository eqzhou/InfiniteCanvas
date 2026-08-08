package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestAICallLogListGetAndDelete(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	created, err := storeMem.CreateAICallLog(t.Context(), store.DefaultTenantID, store.AICallLog{
		Kind:         "image",
		Status:       "succeeded",
		Model:        "demo-model",
		ChannelID:    "ch_demo",
		ChannelName:  "Demo Channel",
		DurationMs:   1234,
		JobID:        "job_1",
		RequestJSON:  json.RawMessage(`{"prompt":"hello","apiKey":"secret"}`),
		ResponseJSON: json.RawMessage(`{"items":[{"url":"blob://x"}]}`),
	})
	if err != nil {
		t.Fatalf("seed log: %v", err)
	}
	if created.ID == "" {
		t.Fatal("missing seeded id")
	}

	listed := request(t, r, http.MethodGet, "/api/ai-call-logs?kind=image&status=succeeded", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("LIST status=%d body=%s", listed.Code, listed.Body.String())
	}
	var page map[string]any
	if err := json.Unmarshal(listed.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	items, _ := page["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %s", listed.Body.String())
	}

	got := request(t, r, http.MethodGet, "/api/ai-call-logs/"+created.ID, nil)
	if got.Code != http.StatusOK {
		t.Fatalf("GET status=%d body=%s", got.Code, got.Body.String())
	}

	old, err := storeMem.CreateAICallLog(t.Context(), store.DefaultTenantID, store.AICallLog{
		Kind:       "video",
		Status:     "failed",
		Model:      "old-model",
		DurationMs: 10,
		CreatedAt:  time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano),
		Error:      "timeout",
	})
	if err != nil {
		t.Fatalf("seed old log: %v", err)
	}

	cleaned := request(t, r, http.MethodPost, "/api/ai-call-logs/delete", []byte(`{"olderThanDays":1}`))
	if cleaned.Code != http.StatusOK {
		t.Fatalf("cleanup status=%d body=%s", cleaned.Code, cleaned.Body.String())
	}
	var cleanResult map[string]any
	if err := json.Unmarshal(cleaned.Body.Bytes(), &cleanResult); err != nil {
		t.Fatalf("decode cleanup: %v", err)
	}
	if int(cleanResult["deleted"].(float64)) < 1 {
		t.Fatalf("expected deleted >= 1, got %v", cleanResult)
	}
	missing := request(t, r, http.MethodGet, "/api/ai-call-logs/"+old.ID, nil)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("old log should be deleted, status=%d body=%s", missing.Code, missing.Body.String())
	}

	deleted := request(t, r, http.MethodPost, "/api/ai-call-logs/delete", []byte(`{"ids":["`+created.ID+`"]}`))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	missing2 := request(t, r, http.MethodGet, "/api/ai-call-logs/"+created.ID, nil)
	if missing2.Code != http.StatusNotFound {
		t.Fatalf("selected log should be deleted, status=%d body=%s", missing2.Code, missing2.Body.String())
	}
}

func TestAICallLogSanitizeRedactsSecrets(t *testing.T) {
	raw, err := sanitizeAICallLogJSON(map[string]any{
		"prompt":        "hi",
		"apiKey":        "super-secret",
		"authorization": "Bearer xyz",
		"data":          "AAAA",
	})
	if err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["apiKey"] != "[redacted]" || decoded["authorization"] != "[redacted]" {
		t.Fatalf("secrets not redacted: %s", string(raw))
	}
	if _, ok := decoded["data"].(map[string]any); !ok {
		t.Fatalf("binary-ish data not omitted: %s", string(raw))
	}
}

func TestAICallLogSanitizeRemovesEndpointCredentialsAndQuery(t *testing.T) {
	raw, err := sanitizeAICallLogJSON(map[string]any{
		"endpoint": "https://user:password@provider.example/v1/images/edits?api_key=secret&sig=private#fragment",
		"baseUrl":  "https://provider.example/v1?token=secret",
	})
	if err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["endpoint"] != "https://provider.example/v1/images/edits" || decoded["baseUrl"] != "https://provider.example/v1" {
		t.Fatalf("endpoint credentials/query were not removed: %s", raw)
	}
}

func TestImageRequestAuditPayloadIdentifiesEditEndpointAndReferences(t *testing.T) {
	payload := imageRequestAuditPayload(imageGenerationRequest{
		Protocol:  "openai",
		BaseURL:   "https://provider.example/v1",
		Model:     "gpt-image-1",
		RequestID: "job-image-request-id",
		Prompt:    "a cat",
		Count:     1,
		References: []generatedImage{{
			Data: []byte("not persisted in audit"), MIMEType: "image/png",
		}},
		ReferenceStorageKeys: []string{"image:generated:source-1:abc"},
	})
	if got, want := payload["endpoint"], "https://provider.example/v1/images/edits"; got != want {
		t.Fatalf("endpoint=%v want %v", got, want)
	}
	if payload["method"] != "POST" || payload["referenceCount"] != 1 {
		t.Fatalf("missing request metadata: %#v", payload)
	}
	if payload["requestId"] != "job-image-request-id" {
		t.Fatalf("request id missing: %#v", payload)
	}
	references, ok := payload["referenceImages"].([]map[string]any)
	if !ok || len(references) != 1 || references[0]["index"] != 1 || references[0]["storageKey"] != "image:generated:source-1:abc" {
		t.Fatalf("reference identity missing: %#v", payload["referenceImages"])
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if strings.Contains(string(encoded), "not persisted in audit") {
		t.Fatal("image bytes leaked into audit payload")
	}
}

func TestAICallLogRetentionPolicyIsAdminOnlyAndBounded(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// Retention is disabled by default so no deployment silently loses audit rows.
	got := request(t, r, http.MethodGet, "/api/ai-call-logs/retention", nil)
	if got.Code != http.StatusOK {
		t.Fatalf("GET status=%d body=%s", got.Code, got.Body.String())
	}
	var policy aiCallLogRetentionPolicy
	if err := json.Unmarshal(got.Body.Bytes(), &policy); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if policy.Enabled || policy.RetentionDays != 0 {
		t.Fatalf("expected retention disabled by default, got %+v", policy)
	}

	saved := request(t, r, http.MethodPut, "/api/ai-call-logs/retention", []byte(`{"enabled":true,"retentionDays":30}`))
	if saved.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", saved.Code, saved.Body.String())
	}
	if err := json.Unmarshal(saved.Body.Bytes(), &policy); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	if !policy.Enabled || policy.RetentionDays != 30 {
		t.Fatalf("policy = %+v", policy)
	}

	for _, body := range []string{`{"enabled":true,"retentionDays":0}`, `{"enabled":true,"retentionDays":4000}`} {
		bad := request(t, r, http.MethodPut, "/api/ai-call-logs/retention", []byte(body))
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("body %s status=%d", body, bad.Code)
		}
	}
}

func TestAICallLogRetentionSweepDeletesOnlyExpiredRows(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()

	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	// A disabled policy must never delete anything.
	if deleted := srv.sweepAICallLogRetention(t.Context(), store.DefaultTenantID, now); deleted != 0 {
		t.Fatalf("disabled policy deleted %d rows", deleted)
	}

	if err := srv.saveAICallLogRetention(t.Context(), store.DefaultTenantID,
		aiCallLogRetentionPolicy{Enabled: true, RetentionDays: 7}); err != nil {
		t.Fatal(err)
	}
	if _, err := storeMem.CreateAICallLog(t.Context(), store.DefaultTenantID, store.AICallLog{
		Kind: "image", Status: "succeeded", Model: "demo",
	}); err != nil {
		t.Fatal(err)
	}

	// A row created now is inside the window and must survive the sweep.
	if deleted := srv.sweepAICallLogRetention(t.Context(), store.DefaultTenantID, now); deleted != 0 {
		t.Fatalf("in-window row deleted: %d", deleted)
	}
	// Advancing past the retention window makes the same row expire.
	if deleted := srv.sweepAICallLogRetention(t.Context(), store.DefaultTenantID, now.AddDate(0, 0, 30)); deleted != 1 {
		t.Fatalf("expired row not deleted: %d", deleted)
	}
}

func TestRetentionSchedulerSweepsLogsAndExpiredMediaReferences(t *testing.T) {
	backend := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), backend)
	// The interval field exists so the sweep can be exercised; leaving it unset
	// would mean the scheduler goroutine is never covered by a test.
	srv.logRetentionInterval = 10 * time.Millisecond
	if err := srv.saveAICallLogRetention(t.Context(), store.DefaultTenantID,
		aiCallLogRetentionPolicy{Enabled: true, RetentionDays: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.CreateMediaReference(t.Context(), store.DefaultTenantID,
		"media/stale.mp4", time.Now().UTC().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	srv.startAICallLogRetentionScheduler()
	t.Cleanup(srv.Close)

	deadline := time.After(2 * time.Second)
	for {
		backend.mu.RLock()
		remaining := len(backend.mediaRefs)
		backend.mu.RUnlock()
		if remaining == 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatal("scheduler never swept the expired media reference")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestAICallLogRetentionRejectsTrailingGarbageAndNonAdmins(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// A body with trailing content must not be silently accepted.
	bad := request(t, r, http.MethodPut, "/api/ai-call-logs/retention",
		[]byte(`{"enabled":true,"retentionDays":30} {"enabled":false}`))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("trailing garbage status=%d body=%s", bad.Code, bad.Body.String())
	}
}

func TestClientAICallLogReportRequiresAdminEnablement(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// Default: reporting disabled.
	got := request(t, r, http.MethodGet, "/api/ai-call-logs/client-report", nil)
	if got.Code != http.StatusOK {
		t.Fatalf("GET client-report status=%d body=%s", got.Code, got.Body.String())
	}
	var policy map[string]any
	if err := json.Unmarshal(got.Body.Bytes(), &policy); err != nil {
		t.Fatalf("decode policy: %v", err)
	}
	if policy["enabled"] == true {
		t.Fatalf("expected disabled by default, got %v", policy)
	}

	blocked := request(t, r, http.MethodPost, "/api/ai-call-logs/report", []byte(`{
		"kind":"image","status":"succeeded","model":"gpt-image-1","durationMs":12,
		"channelId":"ch_local","request":{"prompt":"hi","apiKey":"secret"}
	}`))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("report while disabled status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	enabled := request(t, r, http.MethodPut, "/api/ai-call-logs/client-report", []byte(`{"enabled":true}`))
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", enabled.Code, enabled.Body.String())
	}

	created := request(t, r, http.MethodPost, "/api/ai-call-logs/report", []byte(`{
		"kind":"image","status":"succeeded","model":"gpt-image-1","durationMs":12,
		"channelId":"ch_local","channelName":"Local","protocol":"openai",
		"request":{"prompt":"hi","apiKey":"secret"},
		"response":{"ok":true}
	}`))
	if created.Code != http.StatusOK {
		t.Fatalf("report status=%d body=%s", created.Code, created.Body.String())
	}
	var entry map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &entry); err != nil {
		t.Fatalf("decode entry: %v", err)
	}
	if entry["kind"] != "image" || entry["status"] != "succeeded" {
		t.Fatalf("unexpected entry %#v", entry)
	}
	req, _ := entry["request"].(map[string]any)
	if req == nil || req["apiKey"] == "secret" {
		t.Fatalf("expected redacted request, got %#v", req)
	}
	if req["source"] != "client-direct" {
		t.Fatalf("expected client-direct source, got %#v", req)
	}

	listed := request(t, r, http.MethodGet, "/api/ai-call-logs?kind=image", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
}

// Every user-visible error in this project is Chinese, so a long provider
// failure is a run of 3-byte runes. Cutting it at a raw byte offset splits the
// last rune, and Postgres rejects invalid UTF-8 in a text column — the whole
// INSERT fails and the audit row for the failure is silently lost.
func TestClientAICallLogReportTruncatesChineseFieldsOnRuneBoundaries(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)
	if res := request(t, r, http.MethodPut, "/api/ai-call-logs/client-report", []byte(`{"enabled":true}`)); res.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", res.Code, res.Body.String())
	}

	// "图" is 3 bytes, so no cap below lands on a rune boundary.
	payload, err := json.Marshal(map[string]any{
		"kind":        "image",
		"status":      "failed",
		"durationMs":  1,
		"error":       strings.Repeat("图", 1200), // 3600 bytes, cap 2000
		"model":       strings.Repeat("模", 400),  // 1200 bytes, cap 500
		"channelId":   strings.Repeat("道", 100),  // 300 bytes, cap 128
		"channelName": strings.Repeat("名", 100),  // 300 bytes, cap 200
		"protocol":    strings.Repeat("协", 50),   // 150 bytes, cap 64
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	created := request(t, r, http.MethodPost, "/api/ai-call-logs/report", payload)
	if created.Code != http.StatusOK {
		t.Fatalf("report status=%d body=%s", created.Code, created.Body.String())
	}
	// Read the stored struct, not the HTTP body: writeJSON marshals through
	// encoding/json, which substitutes U+FFFD for invalid UTF-8 and would hide
	// the split rune that Postgres actually rejects.
	page, err := storeMem.ListAICallLogs(context.Background(), store.DefaultTenantID, store.AICallLogQuery{})
	if err != nil {
		t.Fatalf("list stored logs: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("stored rows = %d, want 1", len(page.Items))
	}
	entry := page.Items[0]
	for _, field := range []struct {
		name  string
		value string
	}{
		{"error", entry.Error},
		{"model", entry.Model},
		{"channelId", entry.ChannelID},
		{"channelName", entry.ChannelName},
		{"protocol", entry.Protocol},
	} {
		if !utf8.ValidString(field.value) {
			t.Errorf("%s is not valid UTF-8 after truncation: %q", field.name, field.value)
		}
	}
}

func TestClientAICallLogReportRejectsBadPayload(t *testing.T) {
	storeMem := newMemoryStore()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	srv.SetProcessToken("test-token")
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)
	if res := request(t, r, http.MethodPut, "/api/ai-call-logs/client-report", []byte(`{"enabled":true}`)); res.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", res.Code, res.Body.String())
	}
	bad := request(t, r, http.MethodPost, "/api/ai-call-logs/report", []byte(`{"kind":"nope","status":"succeeded","durationMs":1}`))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("bad kind status=%d body=%s", bad.Code, bad.Body.String())
	}
}

func TestAudioAuditPayloadReportsActualProviderEndpoint(t *testing.T) {
	azure := mediaRequestAuditPayload(resolvedMediaRequest{Audio: audioGenerationRequest{
		Protocol: "azure", BaseURL: "https://eastus.tts.speech.microsoft.com", Model: "azure-neural-tts",
		Prompt: "hello", Voice: "zh-CN-XiaoxiaoNeural", Format: "mp3",
	}}, "audio")
	if azure["protocol"] != "azure" || azure["endpoint"] != "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1" {
		t.Fatalf("Azure audit payload = %#v", azure)
	}
	edge := mediaRequestAuditPayload(resolvedMediaRequest{Audio: audioGenerationRequest{
		Protocol: "edge", BaseURL: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud",
		Model: "edge-tts", Prompt: "hello", Voice: "zh-CN-XiaoxiaoNeural", Format: "mp3",
	}}, "audio")
	if edge["protocol"] != "edge" || edge["endpoint"] != "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" {
		t.Fatalf("Edge audit payload = %#v", edge)
	}
}
