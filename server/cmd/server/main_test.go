package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestServerTimeoutsCoverSlowTextGeneration(t *testing.T) {
	if requestHandlingTimeout < 125*time.Second {
		t.Fatalf("request timeout=%v", requestHandlingTimeout)
	}
	if serverWriteTimeout <= requestHandlingTimeout {
		t.Fatalf("write timeout=%v request timeout=%v", serverWriteTimeout, requestHandlingTimeout)
	}
}

func TestBlobStorageConfigFromEnv(t *testing.T) {
	t.Run("filesystem default", func(t *testing.T) {
		t.Setenv("OPENBOARD_BLOB_BACKEND", "")
		config, err := blobStorageConfigFromEnv()
		if err != nil || config != nil {
			t.Fatalf("config = %#v, %v", config, err)
		}
	})

	t.Run("S3 and R2 settings", func(t *testing.T) {
		t.Setenv("OPENBOARD_BLOB_BACKEND", "s3")
		t.Setenv("OPENBOARD_S3_ENDPOINT", "https://account.r2.cloudflarestorage.com")
		t.Setenv("OPENBOARD_S3_BUCKET", "media-bucket")
		t.Setenv("OPENBOARD_S3_ACCESS_KEY_ID", "access")
		t.Setenv("OPENBOARD_S3_SECRET_ACCESS_KEY", "secret")
		config, err := blobStorageConfigFromEnv()
		if err != nil || config == nil || config.Region != "auto" || config.Prefix != "openboard" {
			t.Fatalf("config = %#v, %v", config, err)
		}
	})

	t.Run("unknown backend", func(t *testing.T) {
		t.Setenv("OPENBOARD_BLOB_BACKEND", "ftp")
		if _, err := blobStorageConfigFromEnv(); err == nil {
			t.Fatal("unknown blob backend accepted")
		}
	})
}

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

	t.Run("allows isolated browser test headers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/projects", nil)
		req.Header.Set("Origin", "http://localhost:5173")
		req.Header.Set("Access-Control-Request-Headers", "x-openboard-e2e-tenant,x-openboard-e2e-token")
		got := httptest.NewRecorder()
		handler.ServeHTTP(got, req)

		allowed := got.Header().Get("Access-Control-Allow-Headers")
		if got.Code != http.StatusNoContent ||
			!strings.Contains(allowed, "X-OpenBoard-E2E-Tenant") ||
			!strings.Contains(allowed, "X-OpenBoard-E2E-Token") ||
			!strings.Contains(allowed, "X-OpenBoard-Config-Version") {
			t.Fatalf("status = %d, allow-headers = %q", got.Code, allowed)
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

func TestRateLimitMiddlewareExemptsE2ETenantProvisioning(t *testing.T) {
	calls := 0
	handler := rateLimitRequests(1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if first.Code != http.StatusNoContent {
		t.Fatalf("first status = %d", first.Code)
	}

	provision := httptest.NewRecorder()
	handler.ServeHTTP(provision, httptest.NewRequest(http.MethodPost, "/api/e2e/tenant", nil))
	if provision.Code != http.StatusNoContent {
		t.Fatalf("provision status = %d", provision.Code)
	}

	limited := httptest.NewRecorder()
	handler.ServeHTTP(limited, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("limited status = %d", limited.Code)
	}
	if calls != 2 {
		t.Fatalf("handler calls = %d, want 2", calls)
	}
}

func TestRateLimitMiddlewareExemptsAuthorizedLoopbackE2ERequests(t *testing.T) {
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "test-only-token")
	handler := rateLimitRequests(1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	e2eRequest := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	e2eRequest.Header.Set("X-OpenBoard-E2E-Token", "test-only-token")
	e2eRequest.RemoteAddr = "127.0.0.1:43210"
	e2eResponse := httptest.NewRecorder()
	handler.ServeHTTP(e2eResponse, e2eRequest)
	if e2eResponse.Code != http.StatusNoContent {
		t.Fatalf("authorized e2e status = %d", e2eResponse.Code)
	}

	remoteRequest := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	remoteRequest.Header.Set("X-OpenBoard-E2E-Token", "test-only-token")
	remoteRequest.RemoteAddr = "203.0.113.8:43210"
	remoteResponse := httptest.NewRecorder()
	handler.ServeHTTP(remoteResponse, remoteRequest)
	if remoteResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("remote e2e status = %d", remoteResponse.Code)
	}
}
