package api

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func passwordHandler(t *testing.T, backend *memoryStore, actor store.AuthUser) http.Handler {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	router := chi.NewRouter()
	MountServer(router, NewServerWithStore(t.TempDir(), backend))
	if actor.ID == "" {
		return router
	}
	return withActor(router, actor)
}

func seedPasswordUser(t *testing.T, backend *memoryStore, user store.AuthUser, password string) {
	t.Helper()
	backend.authUsers[tenantKey(user.TenantID, user.ID)] = user
	if password == "" {
		return
	}
	hash, err := store.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	backend.passwordHashes[user.ID] = hash
}

func TestChangePasswordRequiresSession(t *testing.T) {
	backend := newMemoryStore()
	handler := passwordHandler(t, backend, store.AuthUser{})
	got := request(t, handler, http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"old-password","newPassword":"new-password"}`))
	if got.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous change = %d %s", got.Code, got.Body.String())
	}
}

func TestChangePasswordRejectsWrongCurrent(t *testing.T) {
	backend := newMemoryStore()
	user := store.AuthUser{ID: "user-1", TenantID: "tenant-a", Email: "user@example.com", Role: "member", Status: "active"}
	seedPasswordUser(t, backend, user, "old-password")
	got := request(t, passwordHandler(t, backend, user), http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"wrong-password","newPassword":"new-password"}`))
	if got.Code != http.StatusUnauthorized {
		t.Fatalf("wrong current = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[user.ID], "old-password") {
		t.Fatal("password hash changed after rejected current password")
	}
}

func TestChangePasswordUpdatesHashAndKeepsCurrentSession(t *testing.T) {
	backend := newMemoryStore()
	user := store.AuthUser{ID: "user-1", TenantID: "tenant-a", Email: "user@example.com", Role: "member", Status: "active"}
	seedPasswordUser(t, backend, user, "old-password")
	currentHash := store.HashSessionToken("keep-session")
	otherHash := store.HashSessionToken("other-session")
	backend.sessions[currentHash] = user.ID
	backend.sessions[otherHash] = user.ID
	got := requestWithHeaders(t, passwordHandler(t, backend, user), http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"old-password","newPassword":"new-password"}`), map[string]string{
		sessionHeader: "keep-session",
	})
	if got.Code != http.StatusNoContent {
		t.Fatalf("change password = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[user.ID], "new-password") {
		t.Fatal("new password was not stored")
	}
	if _, ok := backend.sessions[currentHash]; !ok {
		t.Fatal("current session was revoked")
	}
	if _, ok := backend.sessions[otherHash]; ok {
		t.Fatal("other sessions must be revoked after a password change")
	}
}

func TestChangePasswordRejectsUnchangedPassword(t *testing.T) {
	backend := newMemoryStore()
	user := store.AuthUser{ID: "user-1", TenantID: "tenant-a", Email: "user@example.com", Role: "member", Status: "active"}
	seedPasswordUser(t, backend, user, "old-password")
	got := request(t, passwordHandler(t, backend, user), http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"old-password","newPassword":"old-password"}`))
	if got.Code != http.StatusBadRequest {
		t.Fatalf("unchanged password = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[user.ID], "old-password") {
		t.Fatal("password hash changed when new password matched current")
	}
}

func TestChangePasswordRejectsShortPassword(t *testing.T) {
	backend := newMemoryStore()
	user := store.AuthUser{ID: "user-1", TenantID: "tenant-a", Email: "user@example.com", Role: "member", Status: "active"}
	seedPasswordUser(t, backend, user, "old-password")
	got := request(t, passwordHandler(t, backend, user), http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"old-password","newPassword":"short"}`))
	if got.Code != http.StatusBadRequest {
		t.Fatalf("short password = %d %s", got.Code, got.Body.String())
	}
}

func TestChangePasswordAllowsOauthAccountToSetFirstPassword(t *testing.T) {
	backend := newMemoryStore()
	user := store.AuthUser{ID: "oauth-1", TenantID: "tenant-a", Email: "oauth@example.com", Role: "member", Status: "active", LinuxDoID: "42"}
	seedPasswordUser(t, backend, user, "")
	got := request(t, passwordHandler(t, backend, user), http.MethodPut, "/api/auth/password", []byte(`{"currentPassword":"","newPassword":"first-password"}`))
	if got.Code != http.StatusNoContent {
		t.Fatalf("oauth set password = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[user.ID], "first-password") {
		t.Fatal("first password was not stored")
	}
}

func TestPlatformAdminCanResetUserPassword(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	actor := store.AuthUser{ID: "platform-1", TenantID: "tenant-a", Role: "member", Status: "active", PlatformAdmin: true}
	target := store.AuthUser{ID: "user-2", TenantID: "tenant-b", Email: "member@example.com", Role: "member", Status: "active"}
	seedPasswordUser(t, backend.memoryStore, target, "old-password")
	backend.sessions[store.HashSessionToken("stolen-session")] = target.ID
	got := request(t, capabilityHandler(t, backend, actor), http.MethodPut, "/api/platform/users/user-2/password", []byte(`{"password":"reset-password"}`))
	if got.Code != http.StatusNoContent {
		t.Fatalf("platform reset = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[target.ID], "reset-password") {
		t.Fatal("reset password was not stored")
	}
	if len(backend.sessions) != 0 {
		t.Fatalf("reset must revoke sessions: %#v", backend.sessions)
	}
}

func TestPlatformPasswordResetRejectsOrdinaryUsers(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	actor := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	target := store.AuthUser{ID: "user-2", TenantID: "tenant-b", Role: "member", Status: "active"}
	seedPasswordUser(t, backend.memoryStore, target, "old-password")
	got := request(t, capabilityHandler(t, backend, actor), http.MethodPut, "/api/platform/users/user-2/password", []byte(`{"password":"reset-password"}`))
	if got.Code != http.StatusForbidden {
		t.Fatalf("owner reset = %d %s", got.Code, got.Body.String())
	}
	if !store.CheckPassword(backend.passwordHashes[target.ID], "old-password") {
		t.Fatal("password changed without platform admin")
	}
}
