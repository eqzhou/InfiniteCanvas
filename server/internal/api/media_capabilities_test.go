package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestMediaCapabilityCatalogDerivesOnlyEnabledSharedChannelDefaults(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channels, _ := json.Marshal([]adminChannelPublic{
		{ID: "media-main", Name: "Media", BaseURL: "https://secret.example/v1", Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "gpt-image-1", DefaultVideoModel: "video-1", Models: []string{"gpt-image-1", "video-1", "unknown-model"}},
		{ID: "disabled", Name: "Disabled", BaseURL: "https://disabled.example", Protocol: "openai", Enabled: false, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "hidden-image"},
	})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "media-main", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}

	response := request(t, router, http.MethodGet, "/api/media-capabilities", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("catalog: %d %s", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte("sk-private")) || bytes.Contains(response.Body.Bytes(), []byte("secret.example")) || bytes.Contains(response.Body.Bytes(), []byte("hidden-image")) || bytes.Contains(response.Body.Bytes(), []byte("unknown-model")) {
		t.Fatalf("catalog leaked or guessed capabilities: %s", response.Body.String())
	}
	var catalog mediaCapabilityCatalog
	if json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog.Version) != 64 || len(catalog.Models) != 2 {
		t.Fatalf("invalid catalog: %#v", catalog)
	}
	if catalog.Models[0].ChannelID != "media-main" || catalog.Models[0].Modes[0] == "" || catalog.Models[0].Protocol != "openai" {
		t.Fatalf("incomplete catalog: %#v", catalog.Models)
	}
}

func TestFilmGenerationSnapshotFreezesMediaCapabilityResolution(t *testing.T) {
	document := newFilmDocument("film-capability-snapshot")
	shot := filmShot{ID: "shot-main", Revision: 2, Description: "Frame"}
	snapshot := buildFilmGenerationSnapshotWithCapability(document, shot, "shared-main", "image-main", filmGenerationConfig{}, document.CreatedAt, strings.Repeat("a", 64), "image_to_image")
	if snapshot.CapabilityVersion == "" || snapshot.GenerationMode != "image_to_image" {
		t.Fatalf("media capability resolution was not frozen: %#v", snapshot)
	}
}
