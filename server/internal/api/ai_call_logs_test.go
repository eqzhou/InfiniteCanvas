package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestAICallLogListGetAndDelete(t *testing.T) {
	storeMem := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), storeMem)
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
