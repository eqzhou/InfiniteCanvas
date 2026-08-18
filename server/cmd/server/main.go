package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/openboard/openboard/server/internal/api"
	"github.com/openboard/openboard/server/internal/appdir"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	requestHandlingTimeout = 125 * time.Second
	serverReadTimeout      = 230 * time.Second
	serverWriteTimeout     = 240 * time.Second
)

func main() {
	debugFlag := flag.Bool("debug", false, "write dated Agent diagnostics under OPENBOARD_DATA/debug")
	flag.Parse()
	addr := env("OPENBOARD_ADDR", "127.0.0.1:8790")
	dataDir := env("OPENBOARD_DATA", appdir.DefaultDataDir())
	token := os.Getenv("OPENBOARD_TOKEN")
	if !isLoopbackAddress(addr) {
		log.Fatal("OPENBOARD_ADDR must be loopback; use a TLS reverse proxy for remote access")
	}
	origins := parseOrigins(env("OPENBOARD_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"))
	if err := api.SecureDataDir(dataDir); err != nil {
		log.Fatal(err)
	}
	var debugLog io.WriteCloser
	if *debugFlag || strings.EqualFold(strings.TrimSpace(os.Getenv("OPENBOARD_DEBUG")), "true") {
		var err error
		debugLog, err = api.NewDatedDebugLogWriter(dataDir)
		if err != nil {
			log.Fatal(err)
		}
		defer debugLog.Close()
		log.SetOutput(io.MultiWriter(os.Stderr, debugLog))
		log.Printf("dated debug logging enabled (data=%s)", dataDir)
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(redactRuntimeTicketLogs)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(timeoutRequests(requestHandlingTimeout))
	r.Use(cors(origins))
	r.Use(rateLimitRequests(1_200, time.Minute))
	r.Use(requireToken(token))

	var appServer *api.Server
	if databaseURL := os.Getenv("OPENBOARD_DATABASE_URL"); databaseURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		backend, err := store.Open(ctx, databaseURL, os.Getenv("OPENBOARD_REDIS_URL"))
		cancel()
		if err != nil {
			log.Fatal(err)
		}
		defer backend.Close()
		appServer = api.NewServerWithStore(dataDir, backend)
		appServer.SetProcessToken(token)
		if err := appServer.SetSecretKey(os.Getenv("OPENBOARD_MASTER_KEY")); err != nil {
			log.Fatal(err)
		}
	} else {
		appServer = api.NewServer(dataDir)
	}
	defer appServer.Close()
	if debugLog != nil {
		appServer.SetDebugLogWriter(debugLog)
	}
	if config, err := blobStorageConfigFromEnv(); err != nil {
		log.Fatal(err)
	} else if config != nil {
		if err := appServer.ConfigureS3BlobStorage(*config); err != nil {
			log.Fatal(err)
		}
	}
	appServer.SetRuntimeOrigins(origins)
	if _, err := api.WriteConnectionFile(dataDir, "http://"+addr, token); err != nil {
		log.Fatal(err)
	}
	api.MountServer(r, appServer)

	log.Printf("OpenBoard local server listening on %s (data=%s)", addr, dataDir)
	server := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       serverReadTimeout,
		WriteTimeout:      serverWriteTimeout,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	shutdownSignal, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-shutdownSignal.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func blobStorageConfigFromEnv() (*api.S3BlobStorageConfig, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("OPENBOARD_BLOB_BACKEND")))
	if backend == "" || backend == "filesystem" {
		return nil, nil
	}
	if backend != "s3" {
		return nil, fmt.Errorf("OPENBOARD_BLOB_BACKEND must be filesystem or s3")
	}
	allowInsecure := false
	if raw := strings.TrimSpace(os.Getenv("OPENBOARD_S3_ALLOW_INSECURE_LOOPBACK")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, fmt.Errorf("OPENBOARD_S3_ALLOW_INSECURE_LOOPBACK must be a boolean")
		}
		allowInsecure = parsed
	}
	return &api.S3BlobStorageConfig{
		Endpoint:              os.Getenv("OPENBOARD_S3_ENDPOINT"),
		Bucket:                os.Getenv("OPENBOARD_S3_BUCKET"),
		Region:                env("OPENBOARD_S3_REGION", "auto"),
		Prefix:                env("OPENBOARD_S3_PREFIX", "openboard"),
		AccessKeyID:           os.Getenv("OPENBOARD_S3_ACCESS_KEY_ID"),
		SecretAccessKey:       os.Getenv("OPENBOARD_S3_SECRET_ACCESS_KEY"),
		SessionToken:          os.Getenv("OPENBOARD_S3_SESSION_TOKEN"),
		AllowInsecureLoopback: allowInsecure,
	}, nil
}

func rateLimitRequests(limit int, window time.Duration) func(http.Handler) http.Handler {
	if limit < 1 || window <= 0 {
		panic("rate limit and window must be positive")
	}
	var mu sync.Mutex
	started := time.Now()
	count := 0
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if (r.Method == http.MethodPost && r.URL.Path == "/api/e2e/tenant") ||
				authorizedLoopbackE2ERequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			now := time.Now()
			mu.Lock()
			if now.Sub(started) >= window {
				started = now
				count = 0
			}
			if count >= limit {
				remaining := window - now.Sub(started)
				seconds := int64((remaining + time.Second - 1) / time.Second)
				if seconds < 1 {
					seconds = 1
				}
				mu.Unlock()
				w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
				http.Error(w, "request rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			count++
			mu.Unlock()
			next.ServeHTTP(w, r)
		})
	}
}

func authorizedLoopbackE2ERequest(r *http.Request) bool {
	expected := strings.TrimSpace(os.Getenv("OPENBOARD_E2E_TENANT_TOKEN"))
	provided := strings.TrimSpace(r.Header.Get("X-OpenBoard-E2E-Token"))
	if expected == "" || len(expected) != len(provided) ||
		subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) != 1 {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func timeoutRequests(timeout time.Duration) func(http.Handler) http.Handler {
	withTimeout := middleware.Timeout(timeout)
	return func(next http.Handler) http.Handler {
		timed := withTimeout(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/runtime/ws" || r.URL.Path == "/api/codex/events" ||
				strings.HasPrefix(r.URL.Path, "/api/blobs/") {
				next.ServeHTTP(w, r)
				return
			}
			timed.ServeHTTP(w, r)
		})
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseOrigins(value string) map[string]struct{} {
	origins := make(map[string]struct{})
	for _, raw := range strings.Split(value, ",") {
		if origin := strings.TrimSpace(raw); origin != "" {
			origins[origin] = struct{}{}
		}
	}
	return origins
}

func cors(origins map[string]struct{}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if _, allowed := origins[origin]; !allowed {
					http.Error(w, "origin is not allowed", http.StatusForbidden)
					return
				}
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
			w.Header().Set(
				"Access-Control-Allow-Headers",
				"Content-Type, Authorization, X-OpenBoard-Session, X-OpenBoard-Config-Version, X-OpenBoard-E2E-Tenant, X-OpenBoard-E2E-Token",
			)
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isLoopbackAddress(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func redactRuntimeTicketLogs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/runtime/ws" && r.URL.Query().Get("ticket") != "" {
			query := r.URL.Query()
			query.Set("ticket", "redacted")
			cloned := r.Clone(r.Context())
			cloned.URL.RawQuery = query.Encode()
			cloned.RequestURI = cloned.URL.RequestURI()
			next.ServeHTTP(w, cloned)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/runtime/ws" && api.RuntimeSocketTicket(r) != "" {
				next.ServeHTTP(w, r)
				return
			}
			provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
