package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type bootstrapRegistrationStore struct {
	*memoryStore
	input  store.RegisterInput
	called int
}

func (m *bootstrapRegistrationStore) RegisterUser(_ context.Context, input store.RegisterInput) (store.AuthUser, string, error) {
	m.called++
	m.input = input
	if !input.BootstrapAuthorized {
		return store.AuthUser{}, "", store.ErrBootstrapRequired
	}
	return store.AuthUser{ID: "owner-id", TenantID: store.DefaultTenantID, Email: input.Email, Role: "owner", Status: "active"}, "session-token", nil
}

func TestFirstAccountRequiresDedicatedOneTimeBootstrapToken(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_BOOTSTRAP_TOKEN", "dedicated-bootstrap-token")
	backend := &bootstrapRegistrationStore{memoryStore: newMemoryStore()}
	backend.users = 0
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	body := []byte(`{"email":"owner@example.com","password":"password123","displayName":"Owner"}`)

	for _, header := range []string{"", "wrong-token"} {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(body))
		if header != "" {
			req.Header.Set(bootstrapTokenHeader, header)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("bootstrap header %q = %d %s", header, rec.Code, rec.Body.String())
		}
	}
	if backend.called != 0 {
		t.Fatalf("store registration called before bootstrap authorization: %d", backend.called)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(body))
	req.Header.Set(bootstrapTokenHeader, "dedicated-bootstrap-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authorized bootstrap = %d %s", rec.Code, rec.Body.String())
	}
	if backend.called != 1 || !backend.input.BootstrapAuthorized {
		t.Fatalf("bootstrap input = %#v calls=%d", backend.input, backend.called)
	}
}
