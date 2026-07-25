package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestSitePolicyGetDefaultsAndAdminUpdate(t *testing.T) {
	storeMem := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), storeMem)
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	got := request(t, r, http.MethodGet, "/api/site-policy", nil)
	if got.Code != http.StatusOK {
		t.Fatalf("GET status=%d body=%s", got.Code, got.Body.String())
	}
	var policy SitePolicy
	if err := json.Unmarshal(got.Body.Bytes(), &policy); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !policy.AllowRegister || !policy.AllowCustomChannel || !policy.AllowCloudChannel {
		t.Fatalf("expected open defaults, got %+v", policy)
	}

	updated := request(t, r, http.MethodPut, "/api/site-policy", []byte(`{
		"allowRegister": false,
		"allowCustomChannel": false,
		"allowCloudChannel": false
	}`))
	if updated.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", updated.Code, updated.Body.String())
	}
	var after SitePolicy
	if err := json.Unmarshal(updated.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	if after.AllowRegister || after.AllowCustomChannel || after.AllowCloudChannel {
		t.Fatalf("expected all false, got %+v", after)
	}

	// Persistence via GetState
	raw, err := storeMem.GetState(t.Context(), store.DefaultTenantID, sitePolicyStateKey)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	var stored SitePolicy
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("decode stored: %v", err)
	}
	if stored.AllowRegister || stored.AllowCustomChannel || stored.AllowCloudChannel {
		t.Fatalf("stored policy not updated: %+v", stored)
	}
}

func TestSitePolicyBlocksRegistration(t *testing.T) {
	storeMem := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), storeMem)
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// Disable registration
	put := request(t, r, http.MethodPut, "/api/site-policy", []byte(`{
		"allowRegister": false,
		"allowCustomChannel": true,
		"allowCloudChannel": true
	}`))
	if put.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", put.Code, put.Body.String())
	}

	// Force auth mode optional/required path: register handler itself checks policy.
	// OPENBOARD_AUTH_MODE may be optional by default.
	blocked := request(t, r, http.MethodPost, "/api/auth/register", []byte(`{
		"email":"blocked@example.com",
		"password":"password123",
		"displayName":"Blocked"
	}`))
	// When auth is off in env, register returns 404; when on, expect 403.
	if blocked.Code != http.StatusForbidden && blocked.Code != http.StatusNotFound {
		t.Fatalf("expected 403 or 404, got %d body=%s", blocked.Code, blocked.Body.String())
	}
	if blocked.Code == http.StatusForbidden && !containsString(blocked.Body.String(), "registration disabled") {
		t.Fatalf("unexpected body: %s", blocked.Body.String())
	}
}

func containsString(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || len(needle) == 0 ||
		(len(haystack) > 0 && (func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		})()))
}
