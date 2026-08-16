package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestMediaCapabilityCatalogDerivesOnlyEnabledSharedChannelDefaults(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channels, _ := json.Marshal([]adminChannelPublic{
		{ID: "media-main", Name: "Media", BaseURL: "https://secret.example/v1", Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "gpt-image-1", DefaultVideoModel: "video-1", Models: []string{"gpt-image-1", "video-1", "unknown-model"}, MediaCapabilities: []adminMediaCapability{
			{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, Sizes: []string{"1024x1024"}},
			{Model: "video-1", Kind: "video", Modes: []string{"text_to_video"}, Durations: []int{5}},
		}},
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

func TestMediaCapabilityCatalogUsesExplicitCapabilitiesAndPublishesSafeDefaultBaselines(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channels, _ := json.Marshal([]adminChannelPublic{
		{
			ID: "explicit", Name: "Explicit", BaseURL: "https://explicit.example/v1", Protocol: "apimart",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
			DefaultImageModel: "doubao-seedream-5-0-pro", Models: []string{"doubao-seedream-5-0-pro", "custom-video"},
			MediaCapabilities: []adminMediaCapability{
				{Model: "doubao-seedream-5-0-pro", Kind: "image", Modes: []string{"text_to_image"}, Sizes: []string{"1:1"}, MaxReferences: 0},
				{Model: "custom-video", Kind: "video", Modes: []string{"text_to_video", "image_to_video"}, Durations: []int{5, 10}, MaxReferences: 2},
			},
		},
		{
			ID: "registered", Name: "Registered", BaseURL: "https://registered.example/v1", Protocol: "apimart",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
			DefaultVideoModel: "doubao-seedance-2.0", Models: []string{"doubao-seedance-2.0"},
		},
		{
			ID: "unknown", Name: "Unknown", BaseURL: "https://unknown.example/v1", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
			DefaultImageModel: "brand-new-image", Models: []string{"brand-new-image"},
		},
	})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	for _, id := range []string{"explicit", "registered", "unknown"} {
		if got := putSharedChannelSecret(t, router, id, "sk-private-"+id); got.Code != http.StatusNoContent {
			t.Fatalf("put %s secret: %d %s", id, got.Code, got.Body.String())
		}
	}

	response := request(t, router, http.MethodGet, "/api/media-capabilities", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("catalog: %d %s", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte("sk-private")) || bytes.Contains(response.Body.Bytes(), []byte("explicit.example")) {
		t.Fatalf("catalog leaked sensitive data: %s", response.Body.String())
	}
	var catalog mediaCapabilityCatalog
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Models) != 4 {
		t.Fatalf("models = %#v", catalog.Models)
	}
	var explicitImage, explicitVideo, registeredVideo, unknownImage *mediaModelCapability
	for index := range catalog.Models {
		capability := &catalog.Models[index]
		switch capability.ChannelID + "/" + capability.Model {
		case "explicit/doubao-seedream-5-0-pro":
			explicitImage = capability
		case "explicit/custom-video":
			explicitVideo = capability
		case "registered/doubao-seedance-2.0":
			registeredVideo = capability
		case "unknown/brand-new-image":
			unknownImage = capability
		}
	}
	if explicitImage == nil || !reflect.DeepEqual(explicitImage.Modes, []string{"text_to_image"}) || explicitImage.MaxReferences != 0 || !reflect.DeepEqual(explicitImage.Sizes, []string{"1:1"}) {
		t.Fatalf("explicit capability did not override registry: %#v", explicitImage)
	}
	if explicitVideo == nil || explicitVideo.MaxReferences != 2 || !reflect.DeepEqual(explicitVideo.Durations, []int{5, 10}) {
		t.Fatalf("explicit non-default capability missing: %#v", explicitVideo)
	}
	if unknownImage == nil || !reflect.DeepEqual(unknownImage.Modes, []string{"text_to_image"}) || unknownImage.MaxReferences != 0 || len(unknownImage.Sizes) != 0 {
		t.Fatalf("unknown default must publish only a safe text-to-image baseline: %#v", unknownImage)
	}
	if registeredVideo == nil || registeredVideo.MaxReferences != 9 || len(registeredVideo.Durations) != 11 ||
		!reflect.DeepEqual(registeredVideo.Ratios, []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"}) ||
		!reflect.DeepEqual(registeredVideo.Resolutions, []string{"480p", "720p", "1080p", "4k"}) {
		t.Fatalf("registered default capability missing: %#v", registeredVideo)
	}
}

func TestMediaCapabilityUsesRegisteredProviderModelLimits(t *testing.T) {
	openAI := capabilityForChannelDefault(adminChannelPublic{ID: "openai", Name: "OpenAI", Protocol: "openai"}, "image", "gpt-image-2")
	if openAI.MaxReferences != 16 || !reflect.DeepEqual(openAI.Modes, []string{"text_to_image", "image_to_image"}) ||
		!reflect.DeepEqual(openAI.Sizes, []string{"1:1", "2:3", "3:2"}) {
		t.Fatalf("OpenAI image capability drifted from the client registry: %#v", openAI)
	}
	channel := adminChannelPublic{ID: "apimart", Name: "API Mart", Protocol: "apimart"}
	image := capabilityForChannelDefault(channel, "image", "doubao-seedream-5-0-pro")
	if image.MaxReferences != 10 || !reflect.DeepEqual(image.Sizes, []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "auto"}) {
		t.Fatalf("image capability ignored provider registry: %#v", image)
	}
	video := capabilityForChannelDefault(channel, "video", "doubao-seedance-2.0")
	if video.MaxReferences != 9 || len(video.Durations) != 11 || video.Durations[5] != 10 ||
		!reflect.DeepEqual(video.Ratios, []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"}) ||
		!reflect.DeepEqual(video.Resolutions, []string{"480p", "720p", "1080p", "4k"}) {
		t.Fatalf("video capability ignored provider registry: %#v", video)
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
		MediaCapabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image", "image_to_image"}, Sizes: []string{"1024x1024"}, MaxReferences: 16}},
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

func TestSharedAutoImageRoutesBeforeFreezingCapability(t *testing.T) {
	executor := newScriptedImageExecutor()
	server, _, router := imageExecutionHandler(t, executor)
	channels, _ := json.Marshal([]adminChannelPublic{
		{
			ID: "grok-image", Name: "Grok", BaseURL: "https://grok.example/v1", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 100, TimeoutSeconds: 30, DefaultImageModel: "grok-imagine-image-2.0",
		},
		{
			ID: "gpt-image", Name: "GPT", BaseURL: "https://gpt.example/v1", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "gpt-image-2",
		},
	})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	for _, id := range []string{"grok-image", "gpt-image"} {
		if got := putSharedChannelSecret(t, router, id, "credential-"+id); got.Code != http.StatusNoContent {
			t.Fatalf("put %s secret: %d %s", id, got.Code, got.Body.String())
		}
	}
	jobID := ""
	for index := range 200 {
		candidate := fmt.Sprintf("shared-auto-capability-%d", index)
		unfiltered, err := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "image", candidate, "gpt-image-2")
		if err == nil && unfiltered.ID == "grok-image" {
			jobID = candidate
			break
		}
	}
	if jobID == "" {
		t.Fatal("test setup did not produce an incompatible unfiltered route")
	}
	body, _ := json.Marshal(map[string]any{
		"id": jobID, "projectId": "board-1", "prompt": "a tiger", "providerId": sharedChannelAutoID, "model": "gpt-image-2",
		"parameters": map[string]any{"size": "1024x1024", "quality": "high", "count": 1, "referenceStorageKeys": []string{}},
	})
	created := request(t, router, http.MethodPost, "/api/generation-jobs/image", body)
	if created.Code != http.StatusAccepted {
		t.Fatalf("capability-aware shared-auto create = %d %s", created.Code, created.Body.String())
	}
	started := awaitExecutorStart(t, executor)
	if started.BaseURL != "https://gpt.example/v1" || started.Model != "gpt-image-2" {
		t.Fatalf("shared-auto selected an incompatible channel: %#v", started)
	}
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	executor.release <- scriptedImageResult{images: []generatedImage{{Data: png, MIMEType: "image/png"}}}
	server.generationWG.Wait()
}

func TestSharedVideoAndAudioJobsFreezeCatalogResolution(t *testing.T) {
	backend := newMemoryStore()
	_, router := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-media", Name: "Shared media", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultVideoModel: "video-main", DefaultAudioModel: "audio-main", Models: []string{"video-main", "audio-main"},
		MediaCapabilities: []adminMediaCapability{
			{Model: "video-main", Kind: "video", Modes: []string{"text_to_video", "image_to_video"}, Durations: []int{5}, MaxReferences: 1},
			{Model: "audio-main", Kind: "audio", Modes: []string{"text_to_audio"}},
		},
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
		if id == "shared-video" && parameters.ResolvedMode != "text_to_video" {
			t.Fatalf("%s resolved video mode was not frozen: %s", id, job.Parameters)
		}
	}
}

func TestBillingEstimateUsesTheSameSharedMediaCatalogVersion(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "billing-image", Name: "Billing image", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1"},
		MediaCapabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, Sizes: []string{"1024x1024"}}},
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "billing-image", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	basicAnonymous := requestWithHeaders(t, router, http.MethodGet, "/api/billing/estimate?model=gpt-image-1&units=2", nil, nil)
	if basicAnonymous.Code != http.StatusOK {
		t.Fatalf("anonymous basic estimate: %d %s", basicAnonymous.Code, basicAnonymous.Body.String())
	}
	mediaAnonymous := requestWithHeaders(t, router, http.MethodGet, "/api/billing/estimate?model=gpt-image-1&units=2&providerId=billing-image&kind=image&mode=text_to_image", nil, nil)
	if mediaAnonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous media capability estimate = %d %s", mediaAnonymous.Code, mediaAnonymous.Body.String())
	}
	estimate := request(t, router, http.MethodGet, "/api/billing/estimate?model=gpt-image-1&units=2&providerId=billing-image&kind=image&mode=text_to_image", nil)
	if estimate.Code != http.StatusOK {
		t.Fatalf("estimate: %d %s", estimate.Code, estimate.Body.String())
	}
	var payload map[string]any
	if json.Unmarshal(estimate.Body.Bytes(), &payload) != nil {
		t.Fatalf("estimate JSON is invalid: %s", estimate.Body.String())
	}
	capabilityVersion, versionOK := payload["capabilityVersion"].(string)
	if !versionOK || len(capabilityVersion) != 64 || payload["generationMode"] != "text_to_image" {
		t.Fatalf("estimate did not freeze capability version: %s", estimate.Body.String())
	}
	rejected := request(t, router, http.MethodGet, "/api/billing/estimate?model=unlisted&units=1&providerId=billing-image&kind=image&mode=text_to_image", nil)
	if rejected.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unlisted estimate accepted: %d %s", rejected.Code, rejected.Body.String())
	}
}

func TestMediaCapabilityRequestEnforcesConfiguredLimits(t *testing.T) {
	capability := mediaModelCapability{Modes: []string{"image_to_video"}, Ratios: []string{"16:9"}, Resolutions: []string{"720p"}, Durations: []int{5, 6, 7, 8, 9, 10}, MaxReferences: 1}
	valid := filmGenerationConfig{Ratio: "16:9", Resolution: "720p", Seconds: 7, ReferenceStorageKeys: []string{"image:one"}}
	if err := validateMediaCapabilityRequest(capability, "image_to_video", valid); err != nil {
		t.Fatalf("valid capability request rejected: %v", err)
	}
	for name, config := range map[string]filmGenerationConfig{
		"references": {Ratio: "16:9", Resolution: "720p", Seconds: 5, ReferenceStorageKeys: []string{"image:one", "image:two"}},
		"ratio":      {Ratio: "9:16", Resolution: "720p", Seconds: 5, ReferenceStorageKeys: []string{"image:one"}},
		"resolution": {Ratio: "16:9", Resolution: "2160p", Seconds: 5, ReferenceStorageKeys: []string{"image:one"}},
		"duration":   {Ratio: "16:9", Resolution: "720p", Seconds: 11, ReferenceStorageKeys: []string{"image:one"}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateMediaCapabilityRequest(capability, "image_to_video", config); err == nil {
				t.Fatal("capability limit was bypassed")
			}
		})
	}
}
