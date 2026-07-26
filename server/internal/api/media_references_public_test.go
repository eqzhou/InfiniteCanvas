package api

import (
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestPublicMediaReferenceURLRequiresAReachableBaseURL(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)

	// Without a public base URL there is nothing a third-party provider could
	// fetch, so the caller must be able to fail closed.
	if url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4"); url != "" {
		t.Fatalf("unset base URL produced %q", url)
	}

	// Loopback and plain HTTP bases are unreachable for the provider too.
	for _, base := range []string{"http://127.0.0.1:8787", "https://localhost:8787", "http://example.com"} {
		t.Setenv("OPENBOARD_PUBLIC_BASE_URL", base)
		if url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4"); url != "" {
			t.Fatalf("base %q produced %q", base, url)
		}
	}

	t.Setenv("OPENBOARD_PUBLIC_BASE_URL", "https://canvas.example.com/")
	url := server.publicMediaReferenceURL(t.Context(), store.DefaultTenantID, "media/ref.mp4")
	if !strings.HasPrefix(url, "https://canvas.example.com/api/media/references/") {
		t.Fatalf("public url = %q", url)
	}
	// The token, not the storage key, is what travels to the provider.
	if strings.Contains(url, "media/ref.mp4") {
		t.Fatalf("public url leaked the storage key: %q", url)
	}
}
