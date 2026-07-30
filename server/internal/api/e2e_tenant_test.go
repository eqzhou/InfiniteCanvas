package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func (*memoryStore) EnsureE2ETenant(context.Context, string) error {
	return nil
}

func TestWithE2ETenantScopesAuthorizedLoopbackRequests(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "test-only-token")
	server := NewServer(t.TempDir())
	handler := server.withE2ETenant(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(tenantIDFrom(r)))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	// chi's RealIP middleware normalizes loopback requests to a bare IP.
	req.RemoteAddr = "127.0.0.1"
	req.Header.Set(e2eTenantHeader, "e2e-0123456789abcdef01234567")
	req.Header.Set(e2eTenantTokenHeader, "test-only-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Body.String() != "e2e-0123456789abcdef01234567" {
		t.Fatalf("tenant=%q", response.Body.String())
	}
}

func TestWithE2ETenantRejectsUnauthorizedOverrides(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "test-only-token")
	server := NewServer(t.TempDir())
	handler := server.withE2ETenant(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler must not run")
	}))

	tests := []struct {
		name        string
		remoteAddr  string
		tenant      string
		headerValue string
	}{
		{name: "wrong token", remoteAddr: "127.0.0.1:43210", tenant: "e2e-0123456789abcdef01234567", headerValue: "wrong"},
		{name: "remote request", remoteAddr: "203.0.113.8:43210", tenant: "e2e-0123456789abcdef01234567", headerValue: "test-only-token"},
		{name: "invalid tenant", remoteAddr: "127.0.0.1:43210", tenant: "../../default", headerValue: "test-only-token"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
			req.RemoteAddr = tt.remoteAddr
			req.Header.Set(e2eTenantHeader, tt.tenant)
			req.Header.Set(e2eTenantTokenHeader, tt.headerValue)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestWithE2ETenantIsDisabledWithoutExplicitToken(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "")
	server := NewServer(t.TempDir())
	handler := server.withE2ETenant(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(tenantIDFrom(r)))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set(e2eTenantHeader, "e2e-0123456789abcdef01234567")
	req.Header.Set(e2eTenantTokenHeader, "anything")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)

	if response.Code != http.StatusOK || response.Body.String() != store.DefaultTenantID {
		t.Fatalf("status=%d tenant=%q", response.Code, response.Body.String())
	}
}

func TestEnsureE2ETenantCreatesAuthorizedTenant(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "test-only-token")
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	req := httptest.NewRequest(http.MethodPost, "/api/e2e/tenant", strings.NewReader(
		`{"tenantId":"e2e-0123456789abcdef01234567"}`,
	))
	req.RemoteAddr = "127.0.0.1"
	req.Header.Set(e2eTenantTokenHeader, "test-only-token")
	response := httptest.NewRecorder()

	server.ensureE2ETenant(response, req)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
