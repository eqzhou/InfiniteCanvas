package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func configureLinuxDoOAuth(t *testing.T) {
	t.Helper()
	// Fixtures only; never real credentials.
	t.Setenv("OPENBOARD_LINUXDO_CLIENT_ID", "test-client-id")
	t.Setenv("OPENBOARD_LINUXDO_CLIENT_SECRET", "test-client-secret-not-real")
	t.Setenv("OPENBOARD_PUBLIC_BASE_URL", "https://board.example")
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
}

func resetOAuthStates(t *testing.T) {
	t.Helper()
	oauthStateMu.Lock()
	oauthStates = map[string]time.Time{}
	oauthStateMu.Unlock()
	t.Cleanup(func() {
		oauthStateMu.Lock()
		oauthStates = map[string]time.Time{}
		oauthStateMu.Unlock()
	})
}

func oauthStateCount() int {
	oauthStateMu.Lock()
	defer oauthStateMu.Unlock()
	return len(oauthStates)
}

func TestRememberOAuthStateSweepsExpiredEntriesBeforeEviction(t *testing.T) {
	resetOAuthStates(t)
	now := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	oauthStateMu.Lock()
	oauthStates["expired"] = now.Add(-time.Second)
	oauthStates["live"] = now.Add(time.Minute)
	for index := 0; index < maxPendingOAuthStates-2; index++ {
		oauthStates[fmt.Sprintf("pending-%d", index)] = now.Add(2 * time.Minute)
	}
	oauthStateMu.Unlock()

	rememberOAuthState("new", now.Add(3*time.Minute), now)

	oauthStateMu.Lock()
	_, expiredPresent := oauthStates["expired"]
	_, livePresent := oauthStates["live"]
	_, newPresent := oauthStates["new"]
	oauthStateMu.Unlock()
	if expiredPresent {
		t.Fatal("expired OAuth state was not swept")
	}
	if !livePresent || !newPresent {
		t.Fatalf("live/new OAuth states present = %v/%v", livePresent, newPresent)
	}
	if got := oauthStateCount(); got != maxPendingOAuthStates {
		t.Fatalf("pending OAuth states = %d, want %d after sweeping", got, maxPendingOAuthStates)
	}
}

func TestLinuxDoOAuthCallbackRejectsAndConsumesExpiredState(t *testing.T) {
	configureLinuxDoOAuth(t)
	resetOAuthStates(t)
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	t.Cleanup(server.Close)
	oauthStateMu.Lock()
	oauthStates["expired-state"] = time.Now().Add(-time.Second)
	oauthStateMu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/linuxdo/callback?code=fixture-code&state=expired-state", nil)
	server.linuxDoOAuthCallback(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("callback status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	oauthStateMu.Lock()
	_, stillPending := oauthStates["expired-state"]
	oauthStateMu.Unlock()
	if stillPending {
		t.Fatal("expired OAuth state remained redeemable after callback")
	}
}

// /api/auth/oauth/linuxdo/start is unauthenticated by necessity, so anyone can
// drive it. Each call inserts a pending state that is not eligible for cleanup
// for ten minutes, so an unbounded map grows with request volume and every
// later call re-scans it under a global lock.
func TestLinuxDoOAuthStartBoundsPendingStates(t *testing.T) {
	configureLinuxDoOAuth(t)
	resetOAuthStates(t)
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	t.Cleanup(server.Close)

	const attempts = maxPendingOAuthStates + 500
	for i := 0; i < attempts; i++ {
		recorder := httptest.NewRecorder()
		server.linuxDoOAuthStart(recorder, httptest.NewRequest(http.MethodGet, "/api/auth/oauth/linuxdo/start", nil))
		if recorder.Code != http.StatusFound {
			t.Fatalf("attempt %d: status = %d, want %d", i, recorder.Code, http.StatusFound)
		}
	}
	if got := oauthStateCount(); got > maxPendingOAuthStates {
		t.Fatalf("pending oauth states = %d, want <= %d", got, maxPendingOAuthStates)
	}
}

// Eviction must never lock legitimate users out: a state issued after the table
// filled up has to remain redeemable.
func TestLinuxDoOAuthStartKeepsNewestStateRedeemableWhenFull(t *testing.T) {
	configureLinuxDoOAuth(t)
	resetOAuthStates(t)
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	t.Cleanup(server.Close)

	for i := 0; i < maxPendingOAuthStates+50; i++ {
		recorder := httptest.NewRecorder()
		server.linuxDoOAuthStart(recorder, httptest.NewRequest(http.MethodGet, "/api/auth/oauth/linuxdo/start", nil))
		if recorder.Code != http.StatusFound {
			t.Fatalf("attempt %d: status = %d", i, recorder.Code)
		}
	}

	final := httptest.NewRecorder()
	server.linuxDoOAuthStart(final, httptest.NewRequest(http.MethodGet, "/api/auth/oauth/linuxdo/start", nil))
	location, err := final.Result().Location()
	if err != nil {
		t.Fatalf("redirect location: %v", err)
	}
	issued := location.Query().Get("state")
	if issued == "" {
		t.Fatal("start did not issue a state")
	}
	oauthStateMu.Lock()
	_, ok := oauthStates[issued]
	oauthStateMu.Unlock()
	if !ok {
		t.Fatal("the freshly issued state was evicted, so the user cannot complete login")
	}
}
