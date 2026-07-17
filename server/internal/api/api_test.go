package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
)

func fakeCodexBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-codex.sh")
	script := "#!/bin/sh\nwhile IFS= read -r line; do\n" +
		"  id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9][0-9]*\\).*/\\1/p')\n" +
		"  method=$(printf '%s' \"$line\" | sed -n 's/.*\"method\":\"\\([^\"]*\\)\".*/\\1/p')\n" +
		"  case \"$method\" in\n" +
		"    initialize) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}\\n' \"$id\" ;;\n" +
		"    thread/start) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"thread\":{\"id\":\"thread-test\"}}}\\n' \"$id\" ;;\n" +
		"    turn/start) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"turn\":{\"id\":\"turn-test\"}}}\\n' \"$id\" ;;\n" +
		"    turn/interrupt) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}\\n' \"$id\" ;;\n" +
		"  esac\n" +
		"done\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexSessionLifecycle(t *testing.T) {
	t.Setenv("OPENBOARD_CODEX_BIN", fakeCodexBinary(t))
	handler := testHandler(t)
	created := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{}`))
	if created.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &session); err != nil || session.ID == "" {
		t.Fatalf("session=%s", created.Body.String())
	}
	reused := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{}`))
	var reusedSession struct {
		ID     string `json:"id"`
		Reused bool   `json:"reused"`
	}
	if json.Unmarshal(reused.Body.Bytes(), &reusedSession) != nil || reusedSession.ID != session.ID || !reusedSession.Reused {
		t.Fatalf("session was not reused: %s", reused.Body.String())
	}
	message := request(t, handler, http.MethodPost, "/api/codex/message", []byte(`{"sessionId":"`+session.ID+`","text":"hello"}`))
	if message.Code != http.StatusOK {
		t.Fatalf("message status=%d body=%s", message.Code, message.Body.String())
	}
	interrupted := request(t, handler, http.MethodPost, "/api/codex/interrupt", []byte(`{"sessionId":"`+session.ID+`"}`))
	if interrupted.Code != http.StatusOK {
		t.Fatalf("interrupt status=%d body=%s", interrupted.Code, interrupted.Body.String())
	}
	fresh := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{"fresh":true}`))
	var freshSession struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(fresh.Body.Bytes(), &freshSession) != nil || freshSession.ID == "" || freshSession.ID == session.ID {
		t.Fatalf("fresh session was not created: %s", fresh.Body.String())
	}
	closed := request(t, handler, http.MethodDelete, "/api/codex/session/"+freshSession.ID, nil)
	if closed.Code != http.StatusNoContent {
		t.Fatalf("close status=%d", closed.Code)
	}
}

func TestCodexImageAttachmentsAreOwnerOnlyAndCleanedOnClose(t *testing.T) {
	t.Setenv("OPENBOARD_CODEX_BIN", fakeCodexBinary(t))
	dataDir := t.TempDir()
	server := NewServer(dataDir)
	router := chi.NewRouter()
	MountServer(router, server)
	created := request(t, router, http.MethodPost, "/api/codex/session", []byte(`{}`))
	var session struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(created.Body.Bytes(), &session) != nil || session.ID == "" {
		t.Fatalf("session=%s", created.Body.String())
	}

	pixel, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC")
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("sessionId", session.ID); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("files", "pixel.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(pixel); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/codex/attachments", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	uploaded := httptest.NewRecorder()
	router.ServeHTTP(uploaded, req)
	if uploaded.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	var response struct {
		Attachments []codexAttachment `json:"attachments"`
	}
	if json.Unmarshal(uploaded.Body.Bytes(), &response) != nil || len(response.Attachments) != 1 {
		t.Fatalf("attachments=%s", uploaded.Body.String())
	}
	stored, err := filepath.Glob(filepath.Join(dataDir, "codex-attachments", session.ID, "*"))
	if err != nil || len(stored) != 1 {
		t.Fatalf("stored attachments=%v err=%v", stored, err)
	}
	info, err := os.Stat(stored[0])
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("attachment mode=%v", info.Mode().Perm())
	}

	messageBody, _ := json.Marshal(map[string]any{
		"sessionId":     session.ID,
		"text":          "inspect",
		"attachmentIds": []string{response.Attachments[0].ID},
	})
	message := request(t, router, http.MethodPost, "/api/codex/message", messageBody)
	if message.Code != http.StatusOK {
		t.Fatalf("message status=%d body=%s", message.Code, message.Body.String())
	}
	closed := request(t, router, http.MethodDelete, "/api/codex/session/"+session.ID, nil)
	if closed.Code != http.StatusNoContent {
		t.Fatalf("close status=%d", closed.Code)
	}
	stored, _ = filepath.Glob(filepath.Join(dataDir, "codex-attachments", session.ID, "*"))
	if len(stored) != 0 {
		t.Fatalf("attachments were not cleaned: %v", stored)
	}
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	Mount(r, t.TempDir())
	return r
}

func request(t *testing.T, handler http.Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func TestProjectLifecycle(t *testing.T) {
	handler := testHandler(t)
	project := []byte(`{"id":"board-1","title":"First","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)

	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", project); got.Code != http.StatusNoContent {
		t.Fatalf("PUT status = %d, body = %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/projects/board-1", nil); got.Code != http.StatusOK || !json.Valid(got.Body.Bytes()) {
		t.Fatalf("GET status = %d, body = %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/projects", nil); got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"id": "board-1"`)) {
		t.Fatalf("LIST status = %d, body = %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/projects/board-1", nil); got.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d", got.Code)
	}
	if got := request(t, handler, http.MethodGet, "/api/projects/board-1", nil); got.Code != http.StatusNotFound {
		t.Fatalf("GET deleted status = %d", got.Code)
	}
}

func TestPutProjectRejectsInvalidInput(t *testing.T) {
	handler := testHandler(t)

	tests := []struct {
		name string
		path string
		body []byte
	}{
		{name: "invalid id", path: "/api/projects/bad%20id", body: []byte(`{"id":"bad id"}`)},
		{name: "invalid json", path: "/api/projects/board-1", body: []byte(`{"id":`)},
		{name: "mismatched id", path: "/api/projects/board-1", body: []byte(`{"id":"board-2"}`)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := request(t, handler, http.MethodPut, tt.path, tt.body)
			if got.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", got.Code, got.Body.String())
			}
		})
	}
}

func TestAgentExecutesBoardTools(t *testing.T) {
	handler := testHandler(t)
	project := []byte(`{
		"id":"board-1","title":"First","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z",
		"nodes":[{"id":"node-1","type":"text","title":"One","position":{"x":0,"y":0},"width":200,"height":100,"metadata":{}}],
		"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}
	}`)
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", project); got.Code != http.StatusNoContent {
		t.Fatalf("seed status = %d, body = %s", got.Code, got.Body.String())
	}

	list := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.list_nodes","arguments":{"projectId":"board-1"}
	}`))
	if list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte(`"node-1"`)) {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}

	add := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.add_node",
		"arguments":{"projectId":"board-1","node":{"id":"node-2","type":"image","title":"Two","position":{"x":300,"y":50},"width":320,"height":240,"metadata":{}}}
	}`))
	if add.Code != http.StatusOK || !bytes.Contains(add.Body.Bytes(), []byte(`"node-2"`)) {
		t.Fatalf("add status = %d, body = %s", add.Code, add.Body.String())
	}

	connect := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.connect",
		"arguments":{"projectId":"board-1","id":"edge-1","from":"node-1","to":"node-2"}
	}`))
	if connect.Code != http.StatusOK || !bytes.Contains(connect.Body.Bytes(), []byte(`"edge-1"`)) {
		t.Fatalf("connect status = %d, body = %s", connect.Code, connect.Body.String())
	}

	remove := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.delete_nodes","arguments":{"projectId":"board-1","ids":["node-1"]}
	}`))
	if remove.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", remove.Code, remove.Body.String())
	}

	stored := request(t, handler, http.MethodGet, "/api/projects/board-1", nil)
	if bytes.Contains(stored.Body.Bytes(), []byte(`"node-1"`)) || bytes.Contains(stored.Body.Bytes(), []byte(`"edge-1"`)) {
		t.Fatalf("delete did not cascade: %s", stored.Body.String())
	}
}

func TestAgentRejectsUnknownAndInvalidTools(t *testing.T) {
	handler := testHandler(t)

	unknown := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"shell.exec","arguments":{}
	}`))
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown status = %d, body = %s", unknown.Code, unknown.Body.String())
	}

	invalid := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.add_node","arguments":{"projectId":"../escape","node":{}}
	}`))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, body = %s", invalid.Code, invalid.Body.String())
	}
}

func TestAgentDeleteMaintainsGroupReferences(t *testing.T) {
	handler := testHandler(t)
	project := []byte(`{
		"id":"board-1","title":"Grouped","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z",
		"nodes":[
			{"id":"group-1","type":"group","title":"Group","position":{"x":0,"y":0},"width":400,"height":240,"metadata":{"childIds":["node-1","node-2"]}},
			{"id":"node-1","type":"text","title":"One","position":{"x":20,"y":20},"width":120,"height":80,"metadata":{}},
			{"id":"node-2","type":"text","title":"Two","position":{"x":180,"y":20},"width":120,"height":80,"metadata":{}}
		],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}
	}`)
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", project); got.Code != http.StatusNoContent {
		t.Fatalf("seed status = %d, body = %s", got.Code, got.Body.String())
	}
	deleted := request(t, handler, http.MethodPost, "/api/agent/execute", []byte(`{
		"tool":"board.delete_nodes","arguments":{"projectId":"board-1","ids":["node-1"]}
	}`))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	stored := request(t, handler, http.MethodGet, "/api/projects/board-1", nil)
	if bytes.Contains(stored.Body.Bytes(), []byte(`"node-1"`)) || !bytes.Contains(stored.Body.Bytes(), []byte(`"node-2"`)) {
		t.Fatalf("group references were not maintained: %s", stored.Body.String())
	}
}
