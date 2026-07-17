package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/openboard/openboard/server/internal/api"
	"github.com/openboard/openboard/server/internal/appdir"
	"github.com/openboard/openboard/server/internal/store"
)

func main() {
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

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(timeoutRequests(60 * time.Second))
	r.Use(cors(origins))
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
		if err := appServer.SetSecretKey(os.Getenv("OPENBOARD_MASTER_KEY")); err != nil {
			log.Fatal(err)
		}
	} else {
		appServer = api.NewServer(dataDir)
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
		ReadTimeout:       65 * time.Second,
		WriteTimeout:      65 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func timeoutRequests(timeout time.Duration) func(http.Handler) http.Handler {
	withTimeout := middleware.Timeout(timeout)
	return func(next http.Handler) http.Handler {
		timed := withTimeout(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/runtime/ws" || r.URL.Path == "/api/codex/events" {
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
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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

func requireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/runtime/ws" && r.URL.Query().Get("ticket") != "" {
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
