package api

import (
	"strings"
	"testing"
	"time"

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
