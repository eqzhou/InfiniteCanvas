package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestCodexHistoryPersistsMessagesAndProcessEvents(t *testing.T) {
	dataDir := t.TempDir()
	store := newCodexHistoryStore(dataDir)
	scope := agentScope{}
	record := codexHistoryRecord{
		ID: "history-one", Profile: "default", ThreadID: "thread-one",
		CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z",
		Status: "completed",
	}
	if err := store.put(scope, record); err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(scope, "default", record.ID, codexEvent{
		Type: "notification", Method: "openboard/user_message",
		Data: map[string]any{"id": "message-one", "text": "检查画布"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(scope, "default", record.ID, codexEvent{
		Type: "notification", Method: "item/completed",
		Params: json.RawMessage(`{"item":{"id":"file-one","type":"fileChange","path":"web/src/App.tsx","status":"completed"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(scope, "default", record.ID, codexEvent{
		Type: "notification", Method: "agent_message_delta",
		Params: json.RawMessage(`{"delta":"已检查"}`),
	}); err != nil {
		t.Fatal(err)
	}

	loaded, err := store.get(scope, "default", record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Messages) != 2 || loaded.Messages[0].Text != "检查画布" || loaded.Messages[1].Text != "已检查" {
		t.Fatalf("messages = %#v", loaded.Messages)
	}
	if len(loaded.Events) != 3 || loaded.Events[1].Method != "item/completed" {
		t.Fatalf("events = %#v", loaded.Events)
	}
	if loaded.Title != "检查画布" || loaded.Preview != "已检查" || loaded.MessageCount != 2 {
		t.Fatalf("summary fields = %#v", loaded)
	}

	reloaded := newCodexHistoryStore(dataDir)
	items, err := reloaded.list(scope, "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != record.ID {
		t.Fatalf("persisted list = %#v", items)
	}
}

func TestCodexHistoryDeduplicatesRepeatedUserMessages(t *testing.T) {
	store := newCodexHistoryStore(t.TempDir())
	scope := agentScope{}
	record := codexHistoryRecord{
		ID: "history-dedupe", Profile: "default", ThreadID: "thread-dedupe", Title: "新对话",
		CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z", Status: "idle",
	}
	if err := store.put(scope, record); err != nil {
		t.Fatal(err)
	}
	event := codexEvent{
		Type: "notification", Method: "openboard/user_message",
		Data: map[string]any{"id": "message-dedupe", "text": "只保留一次"},
	}
	if err := store.appendEvent(scope, "default", record.ID, event); err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(scope, "default", record.ID, event); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.get(scope, "default", record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Messages) != 1 || loaded.Messages[0].Text != "只保留一次" {
		t.Fatalf("messages = %#v", loaded.Messages)
	}
}

func TestCodexHistoryTruncationPreservesUTF8(t *testing.T) {
	got := truncateHistoryTitle(strings.Repeat("检查", 50))
	if !utf8.ValidString(got) {
		t.Fatalf("truncated title is invalid UTF-8: %q", got)
	}
	if len([]rune(got)) != 80 || !strings.HasSuffix(got, "...") {
		t.Fatalf("truncated title = %q, runes = %d", got, len([]rune(got)))
	}
}

func TestCodexHistoryBoundsOversizedEventsAndFiles(t *testing.T) {
	dataDir := t.TempDir()
	store := newCodexHistoryStore(dataDir)
	scope := agentScope{}
	record := codexHistoryRecord{
		ID: "history-bounds", Profile: "default", ThreadID: "thread-bounds", Title: "边界测试",
		CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z", Status: "idle",
	}
	if err := store.put(scope, record); err != nil {
		t.Fatal(err)
	}
	giantParams := json.RawMessage(`{"delta":"` + strings.Repeat("x", maxCodexHistoryEvent) + `"}`)
	if err := store.appendEvent(scope, "default", record.ID, codexEvent{
		Type: "notification", Method: "agent_message_delta", Params: giantParams,
	}); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.get(scope, "default", record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Events) != 1 || len(loaded.Events[0].Params) != 0 {
		t.Fatalf("oversized event was not bounded: %#v", loaded.Events[0])
	}

	if err := os.MkdirAll(store.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path(scope), []byte(strings.Repeat("x", maxCodexHistoryFile+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.list(scope, "default"); err == nil {
		t.Fatal("oversized history file was accepted")
	}
}

func TestCodexSessionPublishesIntoItsDurableHistory(t *testing.T) {
	dataDir := t.TempDir()
	store := newCodexHistoryStore(dataDir)
	scope := agentScope{tenantID: "tenant-a", userID: "user-a"}
	if err := store.put(scope, codexHistoryRecord{
		ID: "history-live", Profile: "default", ThreadID: "thread-live", Title: "新对话",
		CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z", Status: "idle",
	}); err != nil {
		t.Fatal(err)
	}
	session := &codexSession{
		id: "codex-live", scope: scope, profile: "default", historyStore: store, historyID: "history-live",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	session.publish(codexEvent{Type: "notification", Method: "openboard/user_message", Data: map[string]any{
		"id": "message-live", "text": "继续检查",
	}})
	session.publish(codexEvent{Type: "notification", Method: "agent_message_delta", Params: json.RawMessage(`{"delta":"已恢复"}`)})

	reloaded := newCodexHistoryStore(dataDir)
	record, err := reloaded.get(scope, "default", "history-live")
	if err != nil {
		t.Fatal(err)
	}
	if record.Title != "继续检查" || record.Preview != "已恢复" || len(record.Messages) != 2 {
		t.Fatalf("published history = %#v", record)
	}
}

func TestCodexSessionCloseMarksInterruptedHistoryFailed(t *testing.T) {
	dataDir := t.TempDir()
	store := newCodexHistoryStore(dataDir)
	scope := agentScope{tenantID: "tenant-close", userID: "user-close"}
	if err := store.put(scope, codexHistoryRecord{
		ID: "history-close", Profile: "default", ThreadID: "thread-close", Title: "中断会话",
		CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z", Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	session := &codexSession{
		scope: scope, profile: "default", historyStore: store, historyID: "history-close", turnID: "turn-close",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	session.close()

	reloaded := newCodexHistoryStore(dataDir)
	record, err := reloaded.get(scope, "default", "history-close")
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != "failed" {
		t.Fatalf("closed history status = %q, want failed", record.Status)
	}
}

func TestCodexHistoryListAndBulkDeleteAreScopedAndBounded(t *testing.T) {
	dataDir := t.TempDir()
	server := NewServer(dataDir)
	t.Cleanup(server.Close)
	scope := agentScope{}
	for _, id := range []string{"history-a", "history-b", "history-c"} {
		if err := server.codexHistory.put(scope, codexHistoryRecord{
			ID: id, Profile: "default", Title: id, CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.codexHistory.put(agentScope{tenantID: "tenant-b", userID: "user-b"}, codexHistoryRecord{
		ID: "history-other", Profile: "default", Title: "other", CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	apiRouter := chi.NewRouter()
	MountServer(apiRouter, server)
	router := httptest.NewServer(apiRouter)
	t.Cleanup(router.Close)
	listResponse, err := router.Client().Get(router.URL + "/api/codex/history?profile=default")
	if err != nil {
		t.Fatal(err)
	}
	defer listResponse.Body.Close()
	if listResponse.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", listResponse.StatusCode)
	}
	var listed []codexHistorySummary
	if err := json.NewDecoder(listResponse.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 3 {
		t.Fatalf("listed = %#v", listed)
	}

	body := bytes.NewBufferString(`{"ids":["history-a","history-a","history-b"]}`)
	deleteResponse, err := router.Client().Post(router.URL+"/api/codex/history/bulk-delete", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	defer deleteResponse.Body.Close()
	if deleteResponse.StatusCode != http.StatusOK {
		t.Fatalf("bulk delete status = %d, body=%s", deleteResponse.StatusCode, responseBody(deleteResponse))
	}
	var deleted struct {
		Deleted int `json:"deleted"`
	}
	if err := json.NewDecoder(deleteResponse.Body).Decode(&deleted); err != nil {
		t.Fatal(err)
	}
	if deleted.Deleted != 2 {
		t.Fatalf("deleted = %#v", deleted)
	}

	remaining, err := server.codexHistory.list(scope, "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].ID != "history-c" {
		t.Fatalf("remaining = %#v", remaining)
	}
	other, err := server.codexHistory.list(agentScope{tenantID: "tenant-b", userID: "user-b"}, "default")
	if err != nil || len(other) != 1 || other[0].ID != "history-other" {
		t.Fatalf("other scope history = %#v, err=%v", other, err)
	}
}

func TestRevealCodexFileUsesNativeFileManagerAndRejectsEscape(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "web", "src", "App.tsx")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("package"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	called := ""
	server.fileManagerLauncher = func(name string, args ...string) error {
		called = name + " " + joinArgs(args)
		return nil
	}
	session := &codexSession{
		id: "codex-one", scope: agentScope{}, profile: "default", cwd: root,
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	server.codex.sessions[session.id] = session

	request := httptest.NewRequest(http.MethodPost, "/api/codex/reveal", bytes.NewBufferString(`{"sessionId":"codex-one","path":"web/src/App.tsx"}`))
	response := httptest.NewRecorder()
	server.revealCodexFile(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("reveal status = %d, body=%s", response.Code, response.Body.String())
	}
	if called == "" {
		t.Fatal("native file manager was not called")
	}
	if filepath.Base(called) == "" {
		t.Fatalf("file manager command = %q", called)
	}

	escape := httptest.NewRecorder()
	server.revealCodexFile(escape, httptest.NewRequest(http.MethodPost, "/api/codex/reveal", bytes.NewBufferString(`{"sessionId":"codex-one","path":"../../etc/passwd"}`)))
	if escape.Code != http.StatusBadRequest {
		t.Fatalf("escape status = %d, body=%s", escape.Code, escape.Body.String())
	}
}

func TestCodexHistoryRestoreDoesNotInterruptDifferentRunningSession(t *testing.T) {
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	scope := agentScope{}
	for _, id := range []string{"history-current", "history-target"} {
		if err := server.codexHistory.put(scope, codexHistoryRecord{
			ID: id, Profile: "default", ThreadID: "thread-" + id, Title: id,
			CreatedAt: "2026-07-31T00:00:00Z", UpdatedAt: "2026-07-31T00:00:00Z", Status: "completed",
		}); err != nil {
			t.Fatal(err)
		}
	}
	running := &codexSession{
		id: "codex-current", scope: scope, profile: "default", historyID: "history-current", turnID: "turn-live",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	server.codex.sessions[running.id] = running
	server.codex.profiles[agentProfileKey{scope: scope, profile: running.profile}] = running.id

	router := chi.NewRouter()
	router.Post("/api/codex/history/{id}/restore", server.restoreCodexHistory)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/codex/history/history-target/restore", strings.NewReader(`{}`)))
	if response.Code != http.StatusConflict {
		t.Fatalf("restore status = %d, body = %s", response.Code, response.Body.String())
	}
	if server.codex.profiles[agentProfileKey{scope: scope, profile: running.profile}] != running.id {
		t.Fatal("restore replaced the active running session")
	}
	running.close()
}

func TestCodexHistoryRestoreRequiresAccountAgentExecution(t *testing.T) {
	t.Setenv("OPENBOARD_AGENT_ACCOUNT_EXECUTION", "false")
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	router.Post("/api/codex/history/{id}/restore", server.restoreCodexHistory)
	request := httptest.NewRequest(http.MethodPost, "/api/codex/history/history-target/restore", strings.NewReader(`{}`))
	request = request.WithContext(context.WithValue(request.Context(), authUserKey, store.AuthUser{
		ID: "user-account", TenantID: "tenant-account",
	}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("restore status = %d, body = %s", response.Code, response.Body.String())
	}
}

func joinArgs(args []string) string {
	result := ""
	for _, arg := range args {
		if result != "" {
			result += " "
		}
		result += arg
	}
	return result
}

func responseBody(response *http.Response) string {
	buffer := bytes.NewBuffer(nil)
	_, _ = buffer.ReadFrom(response.Body)
	return buffer.String()
}
