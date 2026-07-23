package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireUserWhenNeededExemptsAuthEntrypoints(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	s := &Server{} // nil store short-circuits required auth after exemptions
	handler := s.requireUserWhenNeeded(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	for _, path := range []string{"/api/health", "/api/auth/login", "/api/auth/usage", "/api/projects"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusTeapot {
			t.Fatalf("%s: got %d want 418 (nil store)", path, rec.Code)
		}
	}
}

func TestUsageNilStore(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/api/auth/usage", nil)
	rec := httptest.NewRecorder()
	s.usage(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil store usage code=%d", rec.Code)
	}
}
