package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

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

func (s *Server) authorizeProcessToken(r *http.Request) bool {
	provided := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	providedHash := sha256.Sum256([]byte(provided))
	expectedHash := sha256.Sum256([]byte(s.processToken))
	return provided != "" && s.processToken != "" && subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
}

// authorizeMigration protects the bulk read/write surface even when the rest
// of the local API is intentionally open. In authenticated deployments a
// process token must not impersonate a tenant user.
func (s *Server) authorizeMigration(w http.ResponseWriter, r *http.Request) bool {
	if authMode() == "off" {
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return false
		}
		return true
	}
	if _, ok := authUserFrom(r.Context()); !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return false
	}
	return true
}

func (s *Server) authorizeSecrets(w http.ResponseWriter, r *http.Request) bool {
	if authMode() == "off" {
		if s.processToken == "" {
			http.Error(w, "secret storage requires an access token when authentication is disabled", http.StatusServiceUnavailable)
			return false
		}
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return false
		}
		return true
	}
	if user, ok := authUserFrom(r.Context()); ok {
		if !isTenantAdmin(user) {
			http.Error(w, "admin required", http.StatusForbidden)
			return false
		}
		return true
	}
	if authMode() == "optional" && s.store != nil {
		count, err := s.store.CountUsers(r.Context())
		if err == nil && count == 0 && s.authorizeProcessToken(r) {
			return true
		}
		if err != nil {
			http.Error(w, "failed to verify secret access", http.StatusServiceUnavailable)
			return false
		}
		if count == 0 && s.processToken == "" {
			http.Error(w, "secret bootstrap requires an access token", http.StatusServiceUnavailable)
			return false
		}
	}
	http.Error(w, "login required", http.StatusUnauthorized)
	return false
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
			path == "/api/auth/me" || path == "/api/auth/usage" ||
			path == "/api/auth/oauth/linuxdo/start" || path == "/api/auth/oauth/linuxdo/callback" ||
			path == "/api/site-policy" || path == "/api/billing/estimate" || path == "/api/admin/models" ||
			strings.HasPrefix(path, "/api/media/references/") {
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
	allowed, err := s.registrationAllowed(r.Context(), sitePolicyTenantForRegister(r))
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return
	}
	if !allowed {
		http.Error(w, registrationDisabledMessage, http.StatusForbidden)
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
	if errors.Is(err, store.ErrBanned) {
		http.Error(w, "account banned", http.StatusForbidden)
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
		if authMode() == "required" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// optional mode exposes a guest identity so the UI can stay open.
		writeJSON(w, map[string]any{
			"user":     guestUser(),
			"authMode": authMode(),
			"guest":    true,
		})
		return
	}
	writeJSON(w, map[string]any{"user": user, "authMode": authMode(), "guest": false})
}

func guestUser() store.AuthUser {
	return store.AuthUser{
		ID: "", TenantID: store.DefaultTenantID, Email: "", DisplayName: "访客",
		Role: "guest", Credits: 0, Status: "active",
	}
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
	if user, ok := authUserFrom(r.Context()); ok {
		summary.Credits = user.Credits
	}
	writeJSON(w, summary)
}

func (s *Server) estimateCredits(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "billing unavailable", http.StatusServiceUnavailable)
		return
	}
	model := strings.TrimSpace(r.URL.Query().Get("model"))
	units := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("units")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			http.Error(w, "invalid units", http.StatusBadRequest)
			return
		}
		units = n
	}
	cost, err := s.store.GetModelCreditCost(r.Context(), tenantIDFrom(r), model)
	if err != nil {
		http.Error(w, "failed to estimate credits", http.StatusInternalServerError)
		return
	}
	balance := int64(0)
	if user, ok := authUserFrom(r.Context()); ok {
		balance = user.Credits
	}
	total := cost * units
	writeJSON(w, map[string]any{
		"model":          model,
		"units":          units,
		"creditsPerUnit": cost,
		"totalCredits":   total,
		"balance":        balance,
		"sufficient":     balance >= int64(total) || cost == 0,
	})
}

var (
	oauthStateMu sync.Mutex
	oauthStates  = map[string]time.Time{}
)

func linuxDoOAuthConfigured() bool {
	return strings.TrimSpace(os.Getenv("OPENBOARD_LINUXDO_CLIENT_ID")) != "" &&
		strings.TrimSpace(os.Getenv("OPENBOARD_LINUXDO_CLIENT_SECRET")) != ""
}

func publicBaseURL() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv("OPENBOARD_PUBLIC_BASE_URL")), "/")
}

func linuxDoRedirectURL() string {
	if v := strings.TrimSpace(os.Getenv("OPENBOARD_LINUXDO_REDIRECT_URL")); v != "" {
		return v
	}
	base := publicBaseURL()
	if base == "" {
		return ""
	}
	return base + "/api/auth/oauth/linuxdo/callback"
}

func (s *Server) linuxDoOAuthStart(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || authMode() == "off" {
		http.Error(w, "oauth unavailable", http.StatusNotFound)
		return
	}
	if !linuxDoOAuthConfigured() {
		http.Error(w, "linux.do oauth not configured", http.StatusServiceUnavailable)
		return
	}
	redirectURL := linuxDoRedirectURL()
	if redirectURL == "" {
		http.Error(w, "OPENBOARD_PUBLIC_BASE_URL or OPENBOARD_LINUXDO_REDIRECT_URL required", http.StatusServiceUnavailable)
		return
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, "failed to start oauth", http.StatusInternalServerError)
		return
	}
	state := hex.EncodeToString(raw)
	oauthStateMu.Lock()
	now := time.Now()
	for key, exp := range oauthStates {
		if now.After(exp) {
			delete(oauthStates, key)
		}
	}
	oauthStates[state] = now.Add(10 * time.Minute)
	oauthStateMu.Unlock()
	q := url.Values{}
	q.Set("client_id", os.Getenv("OPENBOARD_LINUXDO_CLIENT_ID"))
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirectURL)
	q.Set("state", state)
	q.Set("scope", "user")
	http.Redirect(w, r, "https://connect.linux.do/oauth2/authorize?"+q.Encode(), http.StatusFound)
}

func (s *Server) linuxDoOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || authMode() == "off" {
		http.Error(w, "oauth unavailable", http.StatusNotFound)
		return
	}
	if !linuxDoOAuthConfigured() {
		http.Error(w, "linux.do oauth not configured", http.StatusServiceUnavailable)
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		http.Error(w, "invalid oauth callback", http.StatusBadRequest)
		return
	}
	oauthStateMu.Lock()
	exp, ok := oauthStates[state]
	delete(oauthStates, state)
	oauthStateMu.Unlock()
	if !ok || time.Now().After(exp) {
		http.Error(w, "invalid oauth state", http.StatusBadRequest)
		return
	}
	redirectURL := linuxDoRedirectURL()
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURL)
	form.Set("client_id", os.Getenv("OPENBOARD_LINUXDO_CLIENT_ID"))
	form.Set("client_secret", os.Getenv("OPENBOARD_LINUXDO_CLIENT_SECRET"))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://connect.linux.do/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		http.Error(w, "oauth token request failed", http.StatusBadGateway)
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "oauth token exchange failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		http.Error(w, "oauth token exchange rejected", http.StatusBadGateway)
		return
	}
	var tokenPayload struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal(body, &tokenPayload) != nil || tokenPayload.AccessToken == "" {
		http.Error(w, "invalid oauth token response", http.StatusBadGateway)
		return
	}
	userReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://connect.linux.do/api/user", nil)
	if err != nil {
		http.Error(w, "oauth user request failed", http.StatusBadGateway)
		return
	}
	userReq.Header.Set("Authorization", "Bearer "+tokenPayload.AccessToken)
	userResp, err := http.DefaultClient.Do(userReq)
	if err != nil {
		http.Error(w, "oauth user fetch failed", http.StatusBadGateway)
		return
	}
	defer userResp.Body.Close()
	userBody, _ := io.ReadAll(io.LimitReader(userResp.Body, 1<<20))
	if userResp.StatusCode >= 300 {
		http.Error(w, "oauth user fetch rejected", http.StatusBadGateway)
		return
	}
	var profile struct {
		ID       any    `json:"id"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Email    string `json:"email"`
	}
	if json.Unmarshal(userBody, &profile) != nil {
		http.Error(w, "invalid oauth user response", http.StatusBadGateway)
		return
	}
	linuxID := strings.TrimSpace(fmt.Sprint(profile.ID))
	if linuxID == "" || linuxID == "<nil>" {
		http.Error(w, "missing linux.do user id", http.StatusBadGateway)
		return
	}
	_, sessionToken, err := s.store.UpsertLinuxDoUser(r.Context(), store.LinuxDoUserInput{
		LinuxDoID: linuxID, Email: profile.Email, DisplayName: profile.Name, Username: profile.Username,
	})
	if errors.Is(err, store.ErrBanned) {
		http.Error(w, "account banned", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "failed to create session", http.StatusInternalServerError)
		return
	}
	front := publicBaseURL()
	if front == "" {
		front = "/"
	}
	// Prefer app root with fragment token so SPA can pick it up without logging query secrets.
	target := front
	if !strings.HasSuffix(target, "/") && !strings.Contains(strings.TrimPrefix(target, "http://"), "/") && !strings.Contains(strings.TrimPrefix(target, "https://"), "/") {
		target += "/"
	}
	if strings.Contains(target, "#") {
		target = strings.SplitN(target, "#", 2)[0]
	}
	http.Redirect(w, r, target+"#openboard_session="+url.QueryEscape(sessionToken), http.StatusFound)
}
