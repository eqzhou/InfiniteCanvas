package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const agentIsolationActorHeader = "X-OpenBoard-Test-Actor"

type agentIsolationFixture struct {
	handler http.Handler
	server  *Server
	actors  map[string]store.AuthUser
}

func newAgentIsolationFixture(t *testing.T, actors map[string]store.AuthUser) *agentIsolationFixture {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_AGENT_ACCOUNT_EXECUTION", "true")
	fakeAgentBinary := fakeCodexBinary(t)
	t.Setenv("OPENBOARD_CODEX_BIN", fakeAgentBinary)
	t.Setenv("OPENBOARD_CLAUDE_BIN", fakeAgentBinary)

	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if actor, ok := actors[r.Header.Get(agentIsolationActorHeader)]; ok {
				r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			}
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, server)

	fixture := &agentIsolationFixture{handler: router, server: server, actors: actors}
	t.Cleanup(func() {
		server.codex.mu.RLock()
		codexSessions := make([]*codexSession, 0, len(server.codex.sessions))
		for _, session := range server.codex.sessions {
			codexSessions = append(codexSessions, session)
		}
		server.codex.mu.RUnlock()
		for _, session := range codexSessions {
			session.close()
		}

		server.claude.mu.RLock()
		claudeSessions := make([]*claudeSession, 0, len(server.claude.sessions))
		for _, session := range server.claude.sessions {
			claudeSessions = append(claudeSessions, session)
		}
		server.claude.mu.RUnlock()
		for _, session := range claudeSessions {
			session.close()
		}
		server.Close()
	})
	return fixture
}

func (f *agentIsolationFixture) request(t *testing.T, actor, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set(agentIsolationActorHeader, actor)
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, req)
	return recorder
}

func (f *agentIsolationFixture) cancelledRequest(t *testing.T, actor, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(method, path, nil).WithContext(ctx)
	req.Header.Set(agentIsolationActorHeader, actor)
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, req)
	return recorder
}

func (f *agentIsolationFixture) uploadCodexAttachment(t *testing.T, actor, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	pixel, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC")
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("sessionId", sessionID); err != nil {
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
	req.Header.Set(agentIsolationActorHeader, actor)
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, req)
	return recorder
}

func decodeAgentSessionID(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("create session status=%d body=%s", response.Code, response.Body.String())
	}
	var snapshot struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil || snapshot.ID == "" {
		t.Fatalf("invalid session response: %s", response.Body.String())
	}
	return snapshot.ID
}

func agentIsolationActors() map[string]store.AuthUser {
	return map[string]store.AuthUser{
		"owner":                  {ID: "user-owner", TenantID: "tenant-a", Role: "member", Status: "active", PlatformAdmin: true},
		"same-tenant":            {ID: "user-peer", TenantID: "tenant-a", Role: "member", Status: "active", PlatformAdmin: true},
		"other-tenant":           {ID: "user-other", TenantID: "tenant-b", Role: "member", Status: "active", PlatformAdmin: true},
		"same-user-other-tenant": {ID: "user-owner", TenantID: "tenant-b", Role: "member", Status: "active", PlatformAdmin: true},
	}
}

func agentIsolationIntruders() []string {
	return []string{"same-tenant", "other-tenant", "same-user-other-tenant"}
}

func TestCodexProfilesAreIsolatedByTenantAndUser(t *testing.T) {
	for _, intruder := range agentIsolationIntruders() {
		t.Run(intruder, func(t *testing.T) {
			fixture := newAgentIsolationFixture(t, agentIsolationActors())
			ownerID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{"profile":"shared-profile"}`)))
			ownerReuseID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{"profile":"shared-profile"}`)))
			if ownerReuseID != ownerID {
				t.Fatalf("owner profile was not reused: first=%q second=%q", ownerID, ownerReuseID)
			}

			intruderID := decodeAgentSessionID(t, fixture.request(t, intruder, http.MethodPost, "/api/codex/session", []byte(`{"profile":"shared-profile"}`)))
			if intruderID == ownerID {
				t.Fatalf("%s reused owner Codex profile/session %q", intruder, ownerID)
			}
			if got := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodGet, "/api/codex/session?profile=shared-profile", nil)); got != ownerID {
				t.Fatalf("owner profile lookup returned %q, want %q", got, ownerID)
			}
			if got := decodeAgentSessionID(t, fixture.request(t, intruder, http.MethodGet, "/api/codex/session?profile=shared-profile", nil)); got != intruderID {
				t.Fatalf("%s profile lookup returned %q, want %q", intruder, got, intruderID)
			}
		})
	}
}

func TestClaudeProfilesAreIsolatedByTenantAndUser(t *testing.T) {
	for _, intruder := range agentIsolationIntruders() {
		t.Run(intruder, func(t *testing.T) {
			fixture := newAgentIsolationFixture(t, agentIsolationActors())
			ownerID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/claude/session", []byte(`{"profile":"shared-profile"}`)))
			ownerReuseID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/claude/session", []byte(`{"profile":"shared-profile"}`)))
			if ownerReuseID != ownerID {
				t.Fatalf("owner profile was not reused: first=%q second=%q", ownerID, ownerReuseID)
			}

			intruderID := decodeAgentSessionID(t, fixture.request(t, intruder, http.MethodPost, "/api/claude/session", []byte(`{"profile":"shared-profile"}`)))
			if intruderID == ownerID {
				t.Fatalf("%s reused owner Claude profile/session %q", intruder, ownerID)
			}
			if got := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodGet, "/api/claude/session?profile=shared-profile", nil)); got != ownerID {
				t.Fatalf("owner profile lookup returned %q, want %q", got, ownerID)
			}
			if got := decodeAgentSessionID(t, fixture.request(t, intruder, http.MethodGet, "/api/claude/session?profile=shared-profile", nil)); got != intruderID {
				t.Fatalf("%s profile lookup returned %q, want %q", intruder, got, intruderID)
			}
		})
	}
}

func TestCodexSessionOperationsRejectOtherOwners(t *testing.T) {
	for _, intruder := range agentIsolationIntruders() {
		t.Run(intruder, func(t *testing.T) {
			fixture := newAgentIsolationFixture(t, agentIsolationActors())
			sessionID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{"profile":"owner-profile"}`)))

			message := fixture.request(t, intruder, http.MethodPost, "/api/codex/message", []byte(`{"sessionId":"`+sessionID+`","text":"cross-owner"}`))
			if message.Code != http.StatusNotFound {
				t.Errorf("cross-owner message status=%d body=%s, want 404", message.Code, message.Body.String())
			}
			interrupt := fixture.request(t, intruder, http.MethodPost, "/api/codex/interrupt", []byte(`{"sessionId":"`+sessionID+`"}`))
			if interrupt.Code != http.StatusNotFound {
				t.Errorf("cross-owner interrupt status=%d body=%s, want 404", interrupt.Code, interrupt.Body.String())
			}
			events := fixture.cancelledRequest(t, intruder, http.MethodGet, "/api/codex/events?sessionId="+sessionID)
			if events.Code != http.StatusNotFound {
				t.Errorf("cross-owner events status=%d body=%s, want 404", events.Code, events.Body.String())
			}

			uploaded := fixture.uploadCodexAttachment(t, "owner", sessionID)
			if uploaded.Code != http.StatusOK {
				t.Fatalf("owner attachment upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
			}
			var upload struct {
				Attachments []codexAttachment `json:"attachments"`
			}
			if err := json.Unmarshal(uploaded.Body.Bytes(), &upload); err != nil || len(upload.Attachments) != 1 {
				t.Fatalf("invalid attachment response: %s", uploaded.Body.String())
			}
			attachmentPath := "/api/codex/attachments/" + upload.Attachments[0].ID + "?sessionId=" + sessionID
			deletedAttachment := fixture.request(t, intruder, http.MethodDelete, attachmentPath, nil)
			if deletedAttachment.Code != http.StatusNotFound {
				t.Errorf("cross-owner attachment delete status=%d body=%s, want 404", deletedAttachment.Code, deletedAttachment.Body.String())
			}
			ownerDeletedAttachment := fixture.request(t, "owner", http.MethodDelete, attachmentPath, nil)
			if ownerDeletedAttachment.Code != http.StatusNoContent {
				t.Errorf("owner could not delete attachment after rejected cross-owner delete: status=%d body=%s", ownerDeletedAttachment.Code, ownerDeletedAttachment.Body.String())
			}

			deleted := fixture.request(t, intruder, http.MethodDelete, "/api/codex/session/"+sessionID, nil)
			if deleted.Code != http.StatusNotFound {
				t.Errorf("cross-owner session delete status=%d body=%s, want 404", deleted.Code, deleted.Body.String())
			}
			ownerLookup := fixture.request(t, "owner", http.MethodGet, "/api/codex/session?profile=owner-profile", nil)
			if ownerLookup.Code != http.StatusOK {
				t.Errorf("owner session was unavailable after rejected cross-owner delete: status=%d body=%s", ownerLookup.Code, ownerLookup.Body.String())
			}
		})
	}
}

func TestClaudeSessionOperationsRejectOtherOwners(t *testing.T) {
	for _, intruder := range agentIsolationIntruders() {
		t.Run(intruder, func(t *testing.T) {
			fixture := newAgentIsolationFixture(t, agentIsolationActors())
			sessionID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/claude/session", []byte(`{"profile":"owner-profile"}`)))

			messageBody, _ := json.Marshal(map[string]string{"sessionId": sessionID, "prompt": "cross-owner"})
			message := fixture.request(t, intruder, http.MethodPost, "/api/claude/message", messageBody)
			if message.Code != http.StatusNotFound {
				t.Errorf("cross-owner message status=%d body=%s, want 404", message.Code, message.Body.String())
			}
			interrupt := fixture.request(t, intruder, http.MethodPost, "/api/claude/interrupt", []byte(`{"sessionId":"`+sessionID+`"}`))
			if interrupt.Code != http.StatusNotFound {
				t.Errorf("cross-owner interrupt status=%d body=%s, want 404", interrupt.Code, interrupt.Body.String())
			}
			events := fixture.cancelledRequest(t, intruder, http.MethodGet, "/api/claude/events?sessionId="+sessionID)
			if events.Code != http.StatusNotFound {
				t.Errorf("cross-owner events status=%d body=%s, want 404", events.Code, events.Body.String())
			}
			deleted := fixture.request(t, intruder, http.MethodDelete, "/api/claude/session/"+sessionID, nil)
			if deleted.Code != http.StatusNotFound {
				t.Errorf("cross-owner session delete status=%d body=%s, want 404", deleted.Code, deleted.Body.String())
			}
			ownerLookup := fixture.request(t, "owner", http.MethodGet, "/api/claude/session?profile=owner-profile", nil)
			if ownerLookup.Code != http.StatusOK {
				t.Errorf("owner session was unavailable after rejected cross-owner delete: status=%d body=%s", ownerLookup.Code, ownerLookup.Body.String())
			}
		})
	}
}

func TestCodexAttachmentUploadRejectsOtherOwners(t *testing.T) {
	for _, intruder := range agentIsolationIntruders() {
		t.Run(intruder, func(t *testing.T) {
			fixture := newAgentIsolationFixture(t, agentIsolationActors())
			sessionID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{}`)))
			uploaded := fixture.uploadCodexAttachment(t, intruder, sessionID)
			if uploaded.Code != http.StatusNotFound {
				t.Fatalf("cross-owner attachment upload status=%d body=%s, want 404", uploaded.Code, uploaded.Body.String())
			}
			stored, err := filepath.Glob(filepath.Join(fixture.server.dataDir, "codex-attachments", sessionID, "*"))
			if err != nil {
				t.Fatal(err)
			}
			if len(stored) != 0 {
				t.Fatalf("rejected cross-owner upload stored attachment files: %v", stored)
			}
		})
	}
}

func TestActiveAgentSessionsRecheckPlatformExecutionGrant(t *testing.T) {
	actors := agentIsolationActors()
	fixture := newAgentIsolationFixture(t, actors)
	codexID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{"profile":"revoked-codex"}`)))
	claudeID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/claude/session", []byte(`{"profile":"revoked-claude"}`)))

	revoked := actors["owner"]
	revoked.PlatformAdmin = false
	actors["owner"] = revoked

	codexMessage := fixture.request(t, "owner", http.MethodPost, "/api/codex/message", []byte(`{"sessionId":"`+codexID+`","text":"must not run"}`))
	if codexMessage.Code != http.StatusForbidden {
		t.Fatalf("revoked Codex message = %d %s", codexMessage.Code, codexMessage.Body.String())
	}
	approval := fixture.request(t, "owner", http.MethodPost, "/api/codex/approval", []byte(`{"sessionId":"`+codexID+`","id":1,"approve":true}`))
	if approval.Code != http.StatusForbidden {
		t.Fatalf("revoked Codex approval = %d %s", approval.Code, approval.Body.String())
	}
	upload := fixture.uploadCodexAttachment(t, "owner", codexID)
	if upload.Code != http.StatusForbidden {
		t.Fatalf("revoked Codex attachment upload = %d %s", upload.Code, upload.Body.String())
	}
	claudeBody, _ := json.Marshal(map[string]string{"sessionId": claudeID, "prompt": "must not run"})
	claudeMessage := fixture.request(t, "owner", http.MethodPost, "/api/claude/message", claudeBody)
	if claudeMessage.Code != http.StatusForbidden {
		t.Fatalf("revoked Claude message = %d %s", claudeMessage.Code, claudeMessage.Body.String())
	}
}
