package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
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

func TestSharedImageJobFreezesCatalogVersionAndRejectsUnlistedModels(t *testing.T) {
	_, backend, router := imageExecutionHandler(t, newScriptedImageExecutor())
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-image", Name: "Shared image", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1"},
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-image", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	body := func(id, model string) []byte {
		value, _ := json.Marshal(map[string]any{
			"id": id, "projectId": "board-1", "prompt": "a tiger", "providerId": "shared-image", "model": model,
			"parameters": map[string]any{"size": "1024x1024", "quality": "high", "count": 1, "referenceStorageKeys": []string{}},
		})
		return value
	}
	created := request(t, router, http.MethodPost, "/api/generation-jobs/image", body("shared-catalog-ok", "gpt-image-1"))
	if created.Code != http.StatusAccepted {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, "shared-catalog-ok")
	if err != nil {
		t.Fatal(err)
	}
	var parameters persistedImageJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || len(parameters.CapabilityVersion) != 64 || parameters.GenerationMode != "text_to_image" {
		t.Fatalf("catalog resolution was not frozen: %s", job.Parameters)
	}
	rejected := request(t, router, http.MethodPost, "/api/generation-jobs/image", body("shared-catalog-bad", "unlisted-image"))
	if rejected.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unlisted shared model accepted: %d %s", rejected.Code, rejected.Body.String())
	}
}

func TestSharedVideoAndAudioJobsFreezeCatalogResolution(t *testing.T) {
	backend := newMemoryStore()
	_, router := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-media", Name: "Shared media", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultVideoModel: "video-main", DefaultAudioModel: "audio-main", Models: []string{"video-main", "audio-main"},
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-media", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	video := request(t, router, http.MethodPost, "/api/generation-jobs/video", []byte(`{"id":"shared-video","projectId":"board-1","prompt":"a tiger","providerId":"shared-media","model":"video-main","parameters":{"seconds":5,"ratio":"16:9","resolution":"720p","referenceStorageKeys":[]}}`))
	if video.Code != http.StatusAccepted {
		t.Fatalf("video: %d %s", video.Code, video.Body.String())
	}
	audio := request(t, router, http.MethodPost, "/api/generation-jobs/audio", []byte(`{"id":"shared-audio","projectId":"board-1","prompt":"hello","providerId":"shared-media","model":"audio-main","parameters":{"voice":"alloy","format":"mp3"}}`))
	if audio.Code != http.StatusAccepted {
		t.Fatalf("audio: %d %s", audio.Code, audio.Body.String())
	}
	for id, expectedMode := range map[string]string{"shared-video": "text_to_video", "shared-audio": "text_to_audio"} {
		job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, id)
		if err != nil {
			t.Fatal(err)
		}
		var parameters persistedMediaJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || len(parameters.CapabilityVersion) != 64 || parameters.GenerationMode != expectedMode {
			t.Fatalf("%s catalog resolution was not frozen: %s", id, job.Parameters)
		}
	}
}

func TestBillingEstimateUsesTheSameSharedMediaCatalogVersion(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "billing-image", Name: "Billing image", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1"},
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "billing-image", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	estimate := request(t, router, http.MethodGet, "/api/billing/estimate?model=gpt-image-1&units=2&providerId=billing-image&kind=image&mode=text_to_image", nil)
	if estimate.Code != http.StatusOK || !bytes.Contains(estimate.Body.Bytes(), []byte(`"generationMode":"text_to_image"`)) {
		t.Fatalf("estimate: %d %s", estimate.Code, estimate.Body.String())
	}
	var payload map[string]any
	if json.Unmarshal(estimate.Body.Bytes(), &payload) != nil {
		t.Fatalf("estimate JSON is invalid: %s", estimate.Body.String())
	}
	capabilityVersion, versionOK := payload["capabilityVersion"].(string)
	if !versionOK || len(capabilityVersion) != 64 {
		t.Fatalf("estimate did not freeze capability version: %s", estimate.Body.String())
	}
	rejected := request(t, router, http.MethodGet, "/api/billing/estimate?model=unlisted&units=1&providerId=billing-image&kind=image&mode=text_to_image", nil)
	if rejected.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unlisted estimate accepted: %d %s", rejected.Code, rejected.Body.String())
	}
}
