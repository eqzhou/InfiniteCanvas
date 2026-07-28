package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

// TestOptionalModeGuestIsReadOnlyAndAdvertisesItself locks the contract the UI
// depends on to decide whether anyone is actually signed in.
//
// In `optional` mode with accounts already created, /api/auth/me answers 200
// with a synthesized guest instead of 401 so the app can stay open for reading.
// A client that takes that 200 at face value concludes someone is signed in,
// hides the way to sign in, and then fails every write with 401 — which is
// exactly the dead end this guards against. The guest must therefore be
// self-identifying, and the read/write asymmetry must stay explicit.
func TestOptionalModeGuestIsReadOnlyAndAdvertisesItself(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	// At least one account exists, so the bootstrap escape hatch in
	// requireTenantAdmin no longer applies and a guest is a true guest.
	backend.users = 1
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	me := request(t, router, http.MethodGet, "/api/auth/me", nil)
	if me.Code != http.StatusOK {
		t.Fatalf("guest me = %d %s", me.Code, me.Body.String())
	}
	var identity struct {
		Guest    bool   `json:"guest"`
		AuthMode string `json:"authMode"`
		User     struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"user"`
	}
	if err := json.Unmarshal(me.Body.Bytes(), &identity); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	// Every one of these three signals must stay usable on its own: a client
	// keying off any single one still recognizes the guest.
	if !identity.Guest {
		t.Fatalf("guest flag missing: %s", me.Body.String())
	}
	if identity.User.Role != "guest" {
		t.Fatalf("guest role = %q, want \"guest\"", identity.User.Role)
	}
	if identity.User.ID != "" {
		t.Fatalf("guest id = %q, want empty", identity.User.ID)
	}
	if identity.AuthMode != "optional" {
		t.Fatalf("authMode = %q", identity.AuthMode)
	}

	// A guest may read the shared catalog...
	if got := request(t, router, http.MethodGet, "/api/site-policy", nil); got.Code != http.StatusOK {
		t.Fatalf("guest site-policy read = %d %s", got.Code, got.Body.String())
	}

	// ...but cannot persist anything. If any of these ever starts succeeding
	// the guest is no longer read-only and the UI contract has changed.
	for _, item := range []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodPut, "/api/state/config", []byte(`{"theme":"dark"}`)},
		{http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{},"webdavPass":""}`)},
		{http.MethodPut, "/api/site-policy", []byte(`{"allowRegister":true,"allowCustomChannel":true,"allowCloudChannel":true}`)},
	} {
		got := request(t, router, item.method, item.path, item.body)
		if got.Code != http.StatusUnauthorized {
			t.Fatalf("guest %s %s = %d %s, want 401", item.method, item.path, got.Code, got.Body.String())
		}
	}

	// Signing in must stay reachable: the UI has to be able to send the guest
	// somewhere that resolves the dead end.
	login := request(t, router, http.MethodPost, "/api/auth/login", []byte(`{"email":"nobody@example.com","password":"wrong-password"}`))
	if login.Code == http.StatusNotFound {
		t.Fatalf("login endpoint unavailable in optional mode: %d %s", login.Code, login.Body.String())
	}
}

func TestOptionalModeRequiresSessionForDataPlaneWhenUsersExist(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	backend.users = 1
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	for _, path := range []string{
		"/api/projects",
		"/api/state/assets",
		"/api/state/prompts",
		"/api/blobs/anonymous-probe",
		"/api/shared-channels",
	} {
		got := request(t, router, http.MethodGet, path, nil)
		if got.Code != http.StatusUnauthorized {
			t.Fatalf("guest %s = %d %s, want 401", path, got.Code, got.Body.String())
		}
	}
	// Public allowlist still open.
	if got := request(t, router, http.MethodGet, "/api/site-policy", nil); got.Code != http.StatusOK {
		t.Fatalf("site-policy = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, router, http.MethodGet, "/api/auth/me", nil); got.Code != http.StatusOK {
		t.Fatalf("me = %d %s", got.Code, got.Body.String())
	}
}

func TestOptionalZeroUserAdminBootstrapRequiresProcessToken(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	backend.users = 0
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("bootstrap-token")
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)

	if got := request(t, router, http.MethodGet, "/api/admin/channels", nil); got.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous admin = %d %s, want 401", got.Code, got.Body.String())
	}
	req := httptest.NewRequest(http.MethodGet, "/api/admin/channels", nil)
	req.Header.Set("Authorization", "Bearer bootstrap-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("token admin = %d %s", rec.Code, rec.Body.String())
	}
}

func TestOptionalZeroUserDataPlaneRequiresProcessToken(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	backend.users = 0
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("bootstrap-token")
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	for _, item := range []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodGet, "/api/projects", nil},
		{http.MethodPut, "/api/state/assets", []byte(`[]`)},
		{http.MethodPut, "/api/blobs/bootstrap-probe", []byte("probe")},
	} {
		got := request(t, router, item.method, item.path, item.body)
		if got.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s %s = %d %s, want 401", item.method, item.path, got.Code, got.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set("Authorization", "Bearer bootstrap-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("token data-plane read = %d %s", rec.Code, rec.Body.String())
	}
}

// Browsers open /api/runtime/ws with only a single-use ticket in the query string.
// Once accounts exist, requireUserWhenNeeded must still allow that upgrade path;
// the ticket itself is the capability token (and is single-use / short-lived).
func TestRuntimeWebSocketBypassesSessionGateWithTicket(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	backend.users = 1
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)

	router := chi.NewRouter()
	MountServer(router, server)

	// Ticket minting still requires a session when users already exist.
	actor := store.AuthUser{ID: "user-1", TenantID: store.DefaultTenantID, Role: "member", Status: "active"}
	ticketReq := httptest.NewRequest(http.MethodPost, "/api/runtime/ticket", nil)
	ticketReq = ticketReq.WithContext(context.WithValue(ticketReq.Context(), authUserKey, actor))
	ticketRec := httptest.NewRecorder()
	router.ServeHTTP(ticketRec, ticketReq)
	if ticketRec.Code != http.StatusOK {
		t.Fatalf("mint ticket: %d %s", ticketRec.Code, ticketRec.Body.String())
	}
	var payload struct {
		Ticket string `json:"ticket"`
	}
	if err := json.NewDecoder(ticketRec.Body).Decode(&payload); err != nil || payload.Ticket == "" {
		t.Fatalf("ticket payload: %v body=%s", err, ticketRec.Body.String())
	}

	// Anonymous upgrade with a valid ticket must not be rejected as "login required".
	// Without a real WebSocket handshake the handler returns the ticket/origin error
	// path instead of upgrading, but the session gate must already have passed.
	wsReq := httptest.NewRequest(http.MethodGet, "/api/runtime/ws?ticket="+payload.Ticket, nil)
	wsRec := httptest.NewRecorder()
	router.ServeHTTP(wsRec, wsReq)
	if wsRec.Code == http.StatusUnauthorized && strings.Contains(wsRec.Body.String(), "login required") {
		t.Fatalf("runtime ws blocked by session gate: %d %s", wsRec.Code, wsRec.Body.String())
	}
	if wsRec.Code == http.StatusUnauthorized && strings.Contains(wsRec.Body.String(), "runtime ticket is invalid or expired") {
		// Ticket was consumed or rejected after the gate; that is still past login.
		return
	}
	// Any non-login-required outcome is acceptable for this gate regression.
	if strings.Contains(wsRec.Body.String(), "login required") {
		t.Fatalf("unexpected login required: %d %s", wsRec.Code, wsRec.Body.String())
	}
}

func TestRuntimeWebSocketRejectsAnonymousMissingTicketWhenUsersExist(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	backend.users = 1
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)

	wsReq := httptest.NewRequest(http.MethodGet, "/api/runtime/ws", nil)
	wsRec := httptest.NewRecorder()
	router.ServeHTTP(wsRec, wsReq)
	if wsRec.Code != http.StatusUnauthorized {
		t.Fatalf("missing ticket status = %d, want 401; body=%s", wsRec.Code, wsRec.Body.String())
	}
	if strings.Contains(wsRec.Body.String(), "login required") {
		t.Fatalf("missing ticket should fail on ticket auth, not session gate: %s", wsRec.Body.String())
	}
	if !strings.Contains(wsRec.Body.String(), "runtime ticket is invalid or expired") {
		t.Fatalf("missing ticket body = %q", wsRec.Body.String())
	}
}

