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
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type contextKey string

const (
	authUserKey               contextKey = "openboardAuthUser"
	bootstrapProcessAccessKey contextKey = "openboardBootstrapProcessAccess"
	sessionHeader                        = "X-OpenBoard-Session"
	bootstrapTokenHeader                 = "X-OpenBoard-Bootstrap-Token"
	e2eTenantHeader                      = "X-OpenBoard-E2E-Tenant"
	e2eTenantTokenHeader                 = "X-OpenBoard-E2E-Token"
)

var e2eTenantIDPattern = regexp.MustCompile(`^e2e-[a-f0-9]{24}$`)

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

func requestHasBootstrapProcessAccess(r *http.Request) bool {
	allowed, _ := r.Context().Value(bootstrapProcessAccessKey).(bool)
	return allowed
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

func authorizeBootstrapToken(r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get(bootstrapTokenHeader))
	expected := strings.TrimSpace(os.Getenv("OPENBOARD_BOOTSTRAP_TOKEN"))
	providedHash := sha256.Sum256([]byte(provided))
	expectedHash := sha256.Sum256([]byte(expected))
	return provided != "" && expected != "" && subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
}

// withE2ETenant gives every browser test an isolated database tenant. The
// override is deliberately unavailable unless the server was started with an
// explicit test token, auth is disabled, and the caller is on loopback.
func (s *Server) withE2ETenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenantID := strings.TrimSpace(r.Header.Get(e2eTenantHeader))
		if tenantID == "" {
			next.ServeHTTP(w, r)
			return
		}
		expectedToken := strings.TrimSpace(os.Getenv("OPENBOARD_E2E_TENANT_TOKEN"))
		if expectedToken == "" {
			next.ServeHTTP(w, r)
			return
		}
		providedToken := strings.TrimSpace(r.Header.Get(e2eTenantTokenHeader))
		expectedHash := sha256.Sum256([]byte(expectedToken))
		providedHash := sha256.Sum256([]byte(providedToken))
		authorized := expectedToken != "" &&
			providedToken != "" &&
			authMode() == "off" &&
			isLoopbackRemote(r.RemoteAddr) &&
			e2eTenantIDPattern.MatchString(tenantID) &&
			subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) == 1
		if !authorized {
			http.Error(w, "test tenant override denied", http.StatusForbidden)
			return
		}
		user := store.AuthUser{
			ID:       tenantID + "-user",
			TenantID: tenantID,
			Role:     "owner",
			Status:   "active",
		}
		ctx := context.WithValue(r.Context(), authUserKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type e2eTenantEnsurer interface {
	EnsureE2ETenant(context.Context, string) error
}

func (s *Server) ensureE2ETenant(w http.ResponseWriter, r *http.Request) {
	expectedToken := strings.TrimSpace(os.Getenv("OPENBOARD_E2E_TENANT_TOKEN"))
	if expectedToken == "" {
		http.NotFound(w, r)
		return
	}
	providedToken := strings.TrimSpace(r.Header.Get(e2eTenantTokenHeader))
	expectedHash := sha256.Sum256([]byte(expectedToken))
	providedHash := sha256.Sum256([]byte(providedToken))
	if authMode() != "off" ||
		providedToken == "" ||
		!isLoopbackRemote(r.RemoteAddr) ||
		subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) != 1 {
		http.Error(w, "test tenant creation denied", http.StatusForbidden)
		return
	}
	var input struct {
		TenantID string `json:"tenantId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&input); err != nil ||
		!e2eTenantIDPattern.MatchString(strings.TrimSpace(input.TenantID)) {
		http.Error(w, "invalid test tenant", http.StatusBadRequest)
		return
	}
	ensurer, ok := s.store.(e2eTenantEnsurer)
	if !ok {
		http.Error(w, "test tenant storage unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := ensurer.EnsureE2ETenant(r.Context(), strings.TrimSpace(input.TenantID)); err != nil {
		http.Error(w, "failed to create test tenant", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isLoopbackRemote(remoteAddr string) bool {
	remoteIP := net.ParseIP(strings.TrimSpace(remoteAddr))
	if remoteIP == nil {
		host, _, splitErr := net.SplitHostPort(remoteAddr)
		if splitErr == nil {
			remoteIP = net.ParseIP(host)
		}
	}
	return remoteIP != nil && remoteIP.IsLoopback()
}

// authorizeSecrets gates the encrypted config-secret bag.
// Any authenticated active user may read/write their own per-user bag. When
// auth is off, the process token
// is required. Optional mode still allows token bootstrap before the first user.
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
		// Users and Owners both sync direct-connect keys; isolation is handled
		// by secretStorageKey, not by this gate.
		if strings.EqualFold(strings.TrimSpace(user.Status), "ban") {
			http.Error(w, "account disabled", http.StatusForbidden)
			return false
		}
		if strings.TrimSpace(user.ID) == "" {
			http.Error(w, "login required", http.StatusUnauthorized)
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
		// /api/runtime/ws authenticates with a single-use ticket in the query
		// string; browsers cannot attach session headers on the WebSocket upgrade.
		if path == "/api/health" || path == "/api/version" ||
			path == "/api/auth/register" || path == "/api/auth/login" || path == "/api/auth/logout" ||
			path == "/api/auth/me" || path == "/api/auth/usage" ||
			path == "/api/auth/oauth/linuxdo/start" || path == "/api/auth/oauth/linuxdo/callback" ||
			path == "/api/site-policy" || path == "/api/billing/estimate" || path == "/api/admin/models" ||
			path == "/api/runtime/ws" ||
			strings.HasPrefix(path, "/api/media/references/") {
			next.ServeHTTP(w, r)
			return
		}
		// Auth disabled: local process-token deployments stay open after requireToken.
		if authMode() == "off" || s.store == nil {
			next.ServeHTTP(w, r)
			return
		}
		if _, ok := authUserFrom(r.Context()); ok {
			next.ServeHTTP(w, r)
			return
		}
		// optional bootstrap: allow process-token tooling only while no users exist.
		// Once accounts exist (or mode is required), anonymous callers cannot touch the data plane.
		if authMode() == "optional" {
			count, err := s.store.CountUsers(r.Context())
			if err != nil {
				http.Error(w, "failed to verify login requirement", http.StatusServiceUnavailable)
				return
			}
			if count == 0 {
				// Match admin bootstrap: never leave the empty-install data plane
				// world-writable. Process-token tooling may still seed local state.
				if !s.authorizeProcessToken(r) {
					http.Error(w, "login required", http.StatusUnauthorized)
					return
				}
				ctx := context.WithValue(r.Context(), bootstrapProcessAccessKey, true)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		http.Error(w, "login required", http.StatusUnauthorized)
	})
}

type authCredentials struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	InviteToken string `json:"inviteToken,omitempty"`
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
	inviteToken := strings.TrimSpace(body.InviteToken)
	userCount, err := s.store.CountUsers(r.Context())
	if err != nil {
		http.Error(w, "failed to verify account bootstrap", http.StatusServiceUnavailable)
		return
	}
	bootstrapAuthorized := false
	if userCount == 0 && inviteToken == "" {
		if !authorizeBootstrapToken(r) {
			http.Error(w, "first account requires bootstrap authorization", http.StatusForbidden)
			return
		}
		bootstrapAuthorized = true
	}
	allowed, err := s.registrationAllowed(r.Context(), sitePolicyTenantForRegister(r))
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return
	}
	// A valid invitation is intentionally allowed to bootstrap a team member
	// even when the public, tenant-wide registration switch is off. The
	// transaction still verifies the token, expiry, and email before creating
	// the account.
	if !allowed && inviteToken == "" && !bootstrapAuthorized {
		http.Error(w, registrationDisabledMessage, http.StatusForbidden)
		return
	}
	user, token, err := s.store.RegisterUser(r.Context(), store.RegisterInput{
		Email: body.Email, Password: body.Password, DisplayName: body.DisplayName, InviteToken: inviteToken,
		BootstrapAuthorized: bootstrapAuthorized,
	})
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "email already registered", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrInvitationInvalid) {
		http.Error(w, "invitation is invalid, expired, revoked, or does not match this email", http.StatusBadRequest)
		return
	}
	if errors.Is(err, store.ErrBootstrapRequired) {
		http.Error(w, "first account requires bootstrap authorization", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
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
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
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
		// Never report a real tenant's storage/generation counters to guests.
		// Optional mode used to fall through to DefaultTenantID ("local").
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
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
	if len(model) > 500 {
		http.Error(w, "invalid model", http.StatusBadRequest)
		return
	}
	units := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("units")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			http.Error(w, "invalid units", http.StatusBadRequest)
			return
		}
		units = n
	}
	providerID := strings.TrimSpace(r.URL.Query().Get("providerId"))
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	mode := strings.TrimSpace(r.URL.Query().Get("mode"))
	capabilityVersion := ""
	if providerID != "" || kind != "" || mode != "" {
		if !validProjectID(providerID) || (kind != "image" && kind != "video" && kind != "audio") || !validFilmGenerationMode(mode) || model == "" {
			http.Error(w, "invalid media capability estimate", http.StatusBadRequest)
			return
		}
		if _, authenticated := authUserFrom(r.Context()); !authenticated && !s.authorizeProcessToken(r) {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
		var err error
		capabilityVersion, err = s.verifySharedMediaCapability(r.Context(), tenantIDFrom(r), providerID, kind, model, mode)
		if err != nil {
			http.Error(w, "shared media capability is unavailable", http.StatusUnprocessableEntity)
			return
		}
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
	response := map[string]any{
		"model":          model,
		"units":          units,
		"creditsPerUnit": cost,
		"totalCredits":   total,
		"balance":        balance,
		"sufficient":     balance >= int64(total),
	}
	if capabilityVersion != "" {
		response["capabilityVersion"] = capabilityVersion
		response["generationMode"] = mode
	}
	writeJSON(w, response)
}

// The OAuth start endpoint is unauthenticated by necessity, so pending states
// must be capped: an unbounded map would grow with request volume for the full
// ten-minute expiry window.
const maxPendingOAuthStates = 4096

var (
	oauthStateMu sync.Mutex
	oauthStates  = map[string]time.Time{}
)

// rememberOAuthState records a pending state, keeping the table bounded. The
// sweep runs only when the table is full, so the common path stays O(1) instead
// of re-scanning every entry under the lock on each request.
func rememberOAuthState(state string, expiresAt time.Time, now time.Time) {
	oauthStateMu.Lock()
	defer oauthStateMu.Unlock()
	if len(oauthStates) >= maxPendingOAuthStates {
		for key, exp := range oauthStates {
			if now.After(exp) {
				delete(oauthStates, key)
			}
		}
	}
	// Still full means the table is under active abuse. Evict the entry closest
	// to expiring rather than rejecting the request, so a flood cannot lock
	// legitimate users out of logging in.
	for len(oauthStates) >= maxPendingOAuthStates {
		oldestKey := ""
		oldestExp := time.Time{}
		for key, exp := range oauthStates {
			if oldestKey == "" || exp.Before(oldestExp) {
				oldestKey, oldestExp = key, exp
			}
		}
		if oldestKey == "" {
			break
		}
		delete(oauthStates, oldestKey)
	}
	oauthStates[state] = expiresAt
}

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
	userCount, err := s.store.CountUsers(r.Context())
	if err != nil {
		http.Error(w, "failed to verify account bootstrap", http.StatusServiceUnavailable)
		return
	}
	if userCount == 0 {
		http.Error(w, "first account requires bootstrap authorization", http.StatusForbidden)
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
	now := time.Now()
	rememberOAuthState(state, now.Add(10*time.Minute), now)
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
	createAllowed, err := s.registrationAllowed(r.Context(), sitePolicyTenantForRegister(r))
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return
	}
	_, sessionToken, err := s.store.UpsertLinuxDoUser(r.Context(), store.LinuxDoUserInput{
		LinuxDoID: linuxID, Email: profile.Email, DisplayName: profile.Name, Username: profile.Username,
		CreateAllowed: createAllowed,
	})
	if errors.Is(err, store.ErrBanned) {
		http.Error(w, "account banned", http.StatusForbidden)
		return
	}
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "email already registered", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrRegistrationDisabled) {
		http.Error(w, registrationDisabledMessage, http.StatusForbidden)
		return
	}
	if errors.Is(err, store.ErrBootstrapRequired) {
		http.Error(w, "first account requires bootstrap authorization", http.StatusForbidden)
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
