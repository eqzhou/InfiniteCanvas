package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
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
