package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCORSMiddleware(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := cors(map[string]struct{}{"http://localhost:5173": {}})(next)

	t.Run("allows configured origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Origin", "http://localhost:5173")
		got := httptest.NewRecorder()
		handler.ServeHTTP(got, req)

		if got.Code != http.StatusTeapot || got.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
			t.Fatalf("status = %d, allow-origin = %q", got.Code, got.Header().Get("Access-Control-Allow-Origin"))
		}
	})

	t.Run("rejects unconfigured preflight", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/projects", nil)
		req.Header.Set("Origin", "https://attacker.example")
		got := httptest.NewRecorder()
		handler.ServeHTTP(got, req)

		if got.Code != http.StatusForbidden {
			t.Fatalf("status = %d", got.Code)
		}
	})

	t.Run("permits same-origin clients without origin header", func(t *testing.T) {
		got := httptest.NewRecorder()
		handler.ServeHTTP(got, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if got.Code != http.StatusTeapot {
			t.Fatalf("status = %d", got.Code)
		}
	})
}

func TestParseOrigins(t *testing.T) {
	got := parseOrigins(" http://localhost:5173,https://canvas.example, ")
	if len(got) != 2 {
		t.Fatalf("origins = %#v", got)
	}
	if _, ok := got["https://canvas.example"]; !ok {
		t.Fatal("expected trimmed origin")
	}
}

func TestLoopbackAddressAndTokenMiddleware(t *testing.T) {
	if !isLoopbackAddress("127.0.0.1:8790") || !isLoopbackAddress("[::1]:8790") {
		t.Fatal("expected loopback addresses")
	}
	if isLoopbackAddress("0.0.0.0:8790") || isLoopbackAddress(":8790") {
		t.Fatal("wildcard addresses must not be treated as loopback")
	}

	handler := requireToken("secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer secret")
	authorized := httptest.NewRecorder()
	handler.ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusNoContent {
		t.Fatalf("authorized status = %d", authorized.Code)
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	handler := rateLimitRequests(2, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for attempt := 0; attempt < 2; attempt++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if response.Code != http.StatusNoContent {
			t.Fatalf("attempt %d status = %d", attempt, response.Code)
		}
	}
	limited := httptest.NewRecorder()
	handler.ServeHTTP(limited, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("limited status = %d", limited.Code)
	}
	if limited.Header().Get("Retry-After") == "" {
		t.Fatal("rate-limited response must include Retry-After")
	}
}
