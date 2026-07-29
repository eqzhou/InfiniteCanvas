package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestPublicMediaReferenceURLRequiresAReachableBaseURL(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)

	// Without a public base URL there is nothing a third-party provider could
	// fetch, so the caller must be able to fail closed.
	if url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4", defaultMediaReferenceTTL); url != "" {
		t.Fatalf("unset base URL produced %q", url)
	}

	// Loopback and plain HTTP bases are unreachable for the provider too.
	for _, base := range []string{"http://127.0.0.1:8787", "https://localhost:8787", "http://example.com"} {
		t.Setenv("OPENBOARD_PUBLIC_BASE_URL", base)
		if url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4", defaultMediaReferenceTTL); url != "" {
			t.Fatalf("base %q produced %q", base, url)
		}
	}

	t.Setenv("OPENBOARD_PUBLIC_BASE_URL", "https://canvas.example.com/")
	url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4", defaultMediaReferenceTTL)
	if !strings.HasPrefix(url, "https://canvas.example.com/api/media/references/") {
		t.Fatalf("public url = %q", url)
	}
	// The token, not the storage key, is what travels to the provider.
	if strings.Contains(url, "media/ref.mp4") {
		t.Fatalf("public url leaked the storage key: %q", url)
	}
}

func TestReferenceMediaTokensAreMintedOnlyForProvidersThatFetchThemselves(t *testing.T) {
	// Only Ark reads generatedMedia.PublicURL. Minting a token for any other
	// protocol publishes tenant media to an anonymous URL for no reason.
	for protocol, wanted := range map[string]bool{
		"ark": true, "openai": false, "template": false, "apimart": false, "kie": false,
	} {
		if got := providerFetchesReferenceMedia(protocol); got != wanted {
			t.Fatalf("providerFetchesReferenceMedia(%q) = %v, want %v", protocol, got, wanted)
		}
	}
}

func TestPublicMediaReferenceLifetimeIsBoundedByTheProviderTimeout(t *testing.T) {
	// A reference only has to outlive the provider call, so the 24h ceiling
	// used for admin-minted tokens is far too generous here.
	if referenceMediaTTL(0) > defaultMediaReferenceTTL {
		t.Fatalf("default reference ttl = %s, want <= %s", referenceMediaTTL(0), defaultMediaReferenceTTL)
	}
	if ttl := referenceMediaTTL(2 * time.Hour); ttl > maxMediaReferenceTTL {
		t.Fatalf("ttl = %s exceeds the ceiling", ttl)
	}
	// A longer provider timeout must still be covered by the token.
	if ttl := referenceMediaTTL(2 * time.Hour); ttl < 2*time.Hour {
		t.Fatalf("ttl = %s does not outlive the provider call", ttl)
	}
}

func TestExpiredMediaReferencesAreSweptRatherThanAccumulating(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)

	// Relative to the real clock: the memory store also expires rows lazily on
	// read, so a fixed calendar date would make the assertion time-dependent.
	now := time.Now().UTC()
	live, err := backend.CreateMediaReference(t.Context(), store.DefaultTenantID, "media/live.mp4", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backend.CreateMediaReference(t.Context(), store.DefaultTenantID, "media/stale.mp4", now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	// Expired rows are only removed lazily on read today, so a token nobody
	// ever fetches would live in the table forever.
	if deleted := server.sweepExpiredMediaReferences(t.Context(), now); deleted != 1 {
		t.Fatalf("swept %d rows, want 1", deleted)
	}
	if _, err := backend.GetMediaReference(t.Context(), live.Token); err != nil {
		t.Fatalf("sweep removed a live reference: %v", err)
	}
}

func TestMediaReferenceServesBytesWithSafeHeaders(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)

	ctx := t.Context()
	if err := server.storeTenantBlob(ctx, "tenant-a", "user-a", "shot.png", "image/png", []byte("png-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := server.storeTenantBlob(ctx, "tenant-a", "user-a", "raw.bin", "application/octet-stream", []byte("bin-bytes")); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor := store.AuthUser{ID: "user-a", TenantID: "tenant-a", Role: "member", Status: "active"}
			r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, server)

	// Mint via authenticated API so existence checks run under the caller tenant.
	mint := httptest.NewRequest(http.MethodPost, "/api/media/references", bytes.NewReader([]byte(
		`{"storageKeys":["shot.png","raw.bin"],"ttlSeconds":120}`,
	)))
	mint.Header.Set("Content-Type", "application/json")
	minted := httptest.NewRecorder()
	router.ServeHTTP(minted, mint)
	if minted.Code != http.StatusCreated {
		t.Fatalf("mint status=%d body=%s", minted.Code, minted.Body.String())
	}
	var payload struct {
		Items []store.MediaReference `json:"items"`
	}
	if err := json.NewDecoder(minted.Body).Decode(&payload); err != nil || len(payload.Items) != 2 {
		t.Fatalf("mint payload=%s err=%v", minted.Body.String(), err)
	}

	byKey := map[string]store.MediaReference{}
	for _, item := range payload.Items {
		byKey[item.StorageKey] = item
	}

	// Public GET uses only the token; no session required.
	image := httptest.NewRecorder()
	router.ServeHTTP(image, httptest.NewRequest(http.MethodGet, "/api/media/references/"+byKey["shot.png"].Token, nil))
	if image.Code != http.StatusOK || image.Body.String() != "png-bytes" {
		t.Fatalf("image ref status=%d body=%s", image.Code, image.Body.String())
	}
	if image.Header().Get("Content-Type") != "image/png" || image.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("image headers=%#v", image.Header())
	}
	if image.Header().Get("Content-Disposition") != "" {
		t.Fatalf("image should stay inline for providers, got %q", image.Header().Get("Content-Disposition"))
	}

	raw := httptest.NewRecorder()
	router.ServeHTTP(raw, httptest.NewRequest(http.MethodGet, "/api/media/references/"+byKey["raw.bin"].Token, nil))
	if raw.Code != http.StatusOK || raw.Body.String() != "bin-bytes" {
		t.Fatalf("raw ref status=%d body=%s", raw.Code, raw.Body.String())
	}
	if raw.Header().Get("Content-Disposition") != "attachment" {
		t.Fatalf("octet-stream disposition=%q", raw.Header().Get("Content-Disposition"))
	}

	// A token minted for tenant-a must not resolve a same-named key under tenant-b.
	if err := server.storeTenantBlob(ctx, "tenant-b", "user-b", "shot.png", "image/png", []byte("other-tenant")); err != nil {
		t.Fatal(err)
	}
	cross := httptest.NewRecorder()
	router.ServeHTTP(cross, httptest.NewRequest(http.MethodGet, "/api/media/references/"+byKey["shot.png"].Token, nil))
	if cross.Code != http.StatusOK || cross.Body.String() != "png-bytes" {
		t.Fatalf("token must stay bound to minting tenant: status=%d body=%s", cross.Code, cross.Body.String())
	}
}

func TestCreateMediaReferencesRejectsForeignTenantKeys(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	ctx := t.Context()
	if err := server.storeTenantBlob(ctx, "tenant-b", "user-b", "secret.png", "image/png", []byte("secret")); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor := store.AuthUser{ID: "user-a", TenantID: "tenant-a", Role: "member", Status: "active"}
			r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, server)

	req := httptest.NewRequest(http.MethodPost, "/api/media/references", bytes.NewReader([]byte(`{"storageKeys":["secret.png"]}`)))
	req.Header.Set("Content-Type", "application/json")
	got := httptest.NewRecorder()
	router.ServeHTTP(got, req)
	if got.Code != http.StatusNotFound {
		t.Fatalf("foreign key mint status=%d body=%s, want 404", got.Code, got.Body.String())
	}
}
