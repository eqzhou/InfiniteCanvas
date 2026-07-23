package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

type contextKey string

const (
	authUserKey   contextKey = "openboardAuthUser"
	sessionHeader            = "X-OpenBoard-Session"
)

func authMode() string {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("OPENBOARD_AUTH_MODE")))
	switch mode {
	case "off", "optional", "required":
		return mode
	default:
		return "optional"
	}
}

func authUserFrom(ctx context.Context) (store.AuthUser, bool) {
	user, ok := ctx.Value(authUserKey).(store.AuthUser)
	return user, ok
}

func tenantIDFrom(r *http.Request) string {
	if user, ok := authUserFrom(r.Context()); ok && user.TenantID != "" {
		return user.TenantID
	}
	return store.DefaultTenantID
}

func userIDFrom(r *http.Request) string {
	if user, ok := authUserFrom(r.Context()); ok {
		return user.ID
	}
	return ""
}

func (s *Server) withSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.store == nil {
			next.ServeHTTP(w, r)
			return
		}
		token := strings.TrimSpace(r.Header.Get(sessionHeader))
		if token == "" {
			if c, err := r.Cookie("openboard_session"); err == nil {
				token = strings.TrimSpace(c.Value)
			}
		}
		if token != "" {
			user, err := s.store.LookupSession(r.Context(), token)
			if err == nil {
				ctx := context.WithValue(r.Context(), authUserKey, user)
				r = r.WithContext(ctx)
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUserWhenNeeded(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Public process endpoints and auth entrypoints. me/usage enforce their own session rules.
		if path == "/api/health" || path == "/api/version" ||
			path == "/api/auth/register" || path == "/api/auth/login" || path == "/api/auth/logout" ||
			path == "/api/auth/me" || path == "/api/auth/usage" {
			next.ServeHTTP(w, r)
			return
		}
		if authMode() != "required" || s.store == nil {
			next.ServeHTTP(w, r)
			return
		}
		if _, ok := authUserFrom(r.Context()); !ok {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type authCredentials struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	if authMode() == "off" {
		http.Error(w, "auth disabled", http.StatusNotFound)
		return
	}
	var body authCredentials
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	user, token, err := s.store.RegisterUser(r.Context(), store.RegisterInput{
		Email: body.Email, Password: body.Password, DisplayName: body.DisplayName,
	})
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "email already registered", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"user": user, "sessionToken": token})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	if authMode() == "off" {
		http.Error(w, "auth disabled", http.StatusNotFound)
		return
	}
	var body authCredentials
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	user, token, err := s.store.LoginUser(r.Context(), body.Email, body.Password)
	if errors.Is(err, store.ErrInvalidCredentials) || errors.Is(err, store.ErrUnauthorized) {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, "login failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"user": user, "sessionToken": token})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	token := strings.TrimSpace(r.Header.Get(sessionHeader))
	if token == "" {
		if c, err := r.Cookie("openboard_session"); err == nil {
			token = c.Value
		}
	}
	_ = s.store.LogoutSession(r.Context(), token)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	if authMode() == "off" {
		http.Error(w, "auth disabled", http.StatusNotFound)
		return
	}
	user, ok := authUserFrom(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, map[string]any{"user": user, "authMode": authMode()})
}

func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	if authMode() == "off" {
		http.Error(w, "auth disabled", http.StatusNotFound)
		return
	}
	// /api/auth/* is exempt from requireUserWhenNeeded; enforce session here so
	// required mode (and optional with an invalid token) cannot read tenant usage anonymously.
	if _, ok := authUserFrom(r.Context()); !ok {
		if authMode() == "required" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// optional without session: report default local workspace usage only
	}
	summary, err := s.store.GetUsage(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load usage", http.StatusInternalServerError)
		return
	}
	writeJSON(w, summary)
}
