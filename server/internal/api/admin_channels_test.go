package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func sharedChannelHandler(t *testing.T) (*Server, *memoryStore, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	return server, backend, router
}

func putSharedChannelSecret(t *testing.T, router http.Handler, id, apiKey string) *httptest.ResponseRecorder {
	t.Helper()
	listed := request(t, router, http.MethodGet, "/api/admin/channels", nil)
	var channels []adminChannelPublic
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &channels) != nil {
		t.Fatalf("load channel binding: %d %s", listed.Code, listed.Body.String())
	}
	for _, channel := range channels {
		if channel.ID == id {
			body, _ := json.Marshal(adminChannelSecretInput{APIKey: apiKey, SecretBindingID: channel.SecretBindingID})
			return request(t, router, http.MethodPut, "/api/admin/channels/"+id+"/secret", body)
		}
	}
	t.Fatalf("channel %q not found", id)
	return nil
}

func TestAdminSharedChannelsEncryptSecretsAndNeverReturnThem(t *testing.T) {
	_, backend, router := sharedChannelHandler(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer sk-shared-private" {
			t.Fatalf("unexpected provider request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-image-1"},{"id":"gpt-4.1"}]}`))
	}))
	defer upstream.Close()

	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-main", Name: "Shared", BaseURL: upstream.URL, Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 2, TimeoutSeconds: 15, DefaultImageModel: "gpt-image-1",
		Models: []string{"gpt-image-1", "gpt-4.1"},
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-main", "sk-shared-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	stored := backend.state[tenantKey(store.DefaultTenantID, adminChannelSecretsStateKey)]
	if len(stored) == 0 || bytes.Contains(stored, []byte("sk-shared-private")) {
		t.Fatalf("shared secret was not encrypted: %s", stored)
	}
	listed := request(t, router, http.MethodGet, "/api/admin/channels", nil)
	if listed.Code != http.StatusOK || bytes.Contains(listed.Body.Bytes(), []byte("sk-shared-private")) || !bytes.Contains(listed.Body.Bytes(), []byte(`"secretConfigured": true`)) {
		t.Fatalf("unsafe channel list: %d %s", listed.Code, listed.Body.String())
	}
	safe := request(t, router, http.MethodGet, "/api/shared-channels", nil)
	if safe.Code != http.StatusOK || bytes.Contains(safe.Body.Bytes(), []byte(upstream.URL)) || bytes.Contains(safe.Body.Bytes(), []byte("timeoutSeconds")) || !bytes.Contains(safe.Body.Bytes(), []byte("shared-auto")) {
		t.Fatalf("unsafe public shared catalog: %d %s", safe.Code, safe.Body.String())
	}
	if !bytes.Contains(safe.Body.Bytes(), []byte(`"models"`)) || !bytes.Contains(safe.Body.Bytes(), []byte("gpt-image-1")) {
		t.Fatalf("public shared catalog missing models: %s", safe.Body.String())
	}
	models := request(t, router, http.MethodPost, "/api/admin/channels/shared-main/models", nil)
	if models.Code != http.StatusOK || !bytes.Contains(models.Body.Bytes(), []byte("gpt-image-1")) {
		t.Fatalf("models: %d %s", models.Code, models.Body.String())
	}
	connection := request(t, router, http.MethodPost, "/api/admin/channels/shared-main/test", nil)
	if connection.Code != http.StatusOK || !bytes.Contains(connection.Body.Bytes(), []byte(`"ok": true`)) {
		t.Fatalf("connection: %d %s", connection.Code, connection.Body.String())
	}
}

func TestSharedChannelGenerationFallbackPreservesPersonalPrecedence(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", []byte(`{"channels":[],"systemPrompt":"shared system"}`)); err != nil {
		t.Fatal(err)
	}
	channels := []byte(`[{"id":"shared-main","name":"Shared","baseUrl":"https://shared.example","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultImageModel":"gpt-image-1"}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-main", "sk-shared"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	parameters, _ := json.Marshal(persistedImageJobParameters{Executor: serverExecutorMarker, Size: "1024x1024", Count: 1})
	resolved, err := server.resolveImageGenerationRequest(context.Background(), store.DefaultTenantID, store.GenerationJob{
		ProviderID: "shared-main", Model: "", Prompt: "draw", Parameters: parameters,
	})
	if err != nil || resolved.APIKey != "sk-shared" || resolved.Model != "gpt-image-1" || resolved.Prompt != "shared system\n\ndraw" {
		t.Fatalf("shared fallback = %#v, %v", resolved, err)
	}

	personal := []byte(`{"channels":[{"id":"shared-main","baseUrl":"https://personal.example","defaultImageModel":"personal-model","providers":{}}],"systemPrompt":""}`)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", personal); err != nil {
		t.Fatal(err)
	}
	if resolved, err := server.resolveImageGenerationRequest(context.Background(), store.DefaultTenantID, store.GenerationJob{
		ProviderID: "shared-main", Prompt: "draw", Parameters: parameters,
	}); err == nil || resolved.APIKey == "sk-shared" {
		t.Fatalf("personal channel must win without falling through, got %#v, %v", resolved, err)
	}
}

func TestSharedGenerationChannelSnapshotSurvivesAdminChanges(t *testing.T) {
	server, backend, _ := sharedChannelHandler(t)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", []byte(`{"channels":[],"systemPrompt":"original system"}`)); err != nil {
		t.Fatal(err)
	}
	channelList := []adminChannelPublic{{
		ID: "shared-main", Name: "Shared", BaseURL: "https://original.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "original-model", SecretBindingID: "original-binding",
	}}
	channels, _ := json.Marshal(channelList)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, channels); err != nil {
		t.Fatal(err)
	}
	envelope, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, channelList, map[string]string{"shared-main": "sk-original"})
	if err != nil || backend.PutState(context.Background(), store.DefaultTenantID, adminChannelSecretsStateKey, envelope) != nil {
		t.Fatal("failed to seed shared secret")
	}

	providerID, snapshot, err := server.snapshotGenerationChannel(context.Background(), store.DefaultTenantID, "image", "job-snapshot", sharedChannelAutoID, "")
	if err != nil || providerID != "shared-main" || snapshot == nil {
		t.Fatalf("snapshot = %q %#v, %v", providerID, snapshot, err)
	}
	if snapshot.Model != "original-model" || snapshot.TimeoutSeconds != 30 {
		t.Fatalf("snapshot did not bind model and timeout: %#v", snapshot)
	}
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", []byte(`{"channels":[],"systemPrompt":"changed system"}`)); err != nil {
		t.Fatal(err)
	}
	changedList := []adminChannelPublic{{
		ID: "shared-main", Name: "Changed", BaseURL: "https://changed.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "changed-model", SecretBindingID: "changed-binding",
	}}
	changed, _ := json.Marshal(changedList)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, changed); err != nil {
		t.Fatal(err)
	}
	changedEnvelope, _ := server.encryptAdminChannelSecrets(store.DefaultTenantID, changedList, map[string]string{"shared-main": "sk-changed"})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelSecretsStateKey, changedEnvelope); err != nil {
		t.Fatal(err)
	}
	parameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, Size: "1024x1024", Count: 1, SharedChannel: snapshot,
	})
	resolved, err := server.resolveImageGenerationRequest(context.Background(), store.DefaultTenantID, store.GenerationJob{
		ID: "job-snapshot", Kind: "image", ProviderID: providerID, Prompt: "draw", Parameters: parameters,
	})
	if err != nil || resolved.BaseURL != "https://original.example/v1" || resolved.APIKey != "sk-original" || resolved.Model != "original-model" || resolved.ProviderTimeout != 30*time.Second || resolved.Prompt != "original system\n\ndraw" {
		t.Fatalf("snapshot was not immutable: %#v, %v", resolved, err)
	}
}

func TestSharedGenerationSnapshotRejectsTimeoutOutsideAdminBounds(t *testing.T) {
	server, backend, _ := sharedChannelHandler(t)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", []byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	channel := adminChannelPublic{
		ID: "shared-main", BaseURL: "https://shared.example/v1", Protocol: "openai", Enabled: true,
		AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "image-model", SecretBindingID: "binding",
	}
	channels, _ := json.Marshal([]adminChannelPublic{channel})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, channels); err != nil {
		t.Fatal(err)
	}
	envelope, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, []adminChannelPublic{channel}, map[string]string{"shared-main": "sk-shared"})
	if err != nil || backend.PutState(context.Background(), store.DefaultTenantID, adminChannelSecretsStateKey, envelope) != nil {
		t.Fatal("failed to seed shared channel")
	}
	_, snapshot, err := server.snapshotGenerationChannel(context.Background(), store.DefaultTenantID, "image", "job-timeout", "shared-main", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, timeout := range []int{0, 601} {
		changed := *snapshot
		changed.TimeoutSeconds = timeout
		parameters, _ := json.Marshal(persistedImageJobParameters{Executor: serverExecutorMarker, Size: "1024x1024", Count: 1, SharedChannel: &changed})
		_, resolveErr := server.resolveImageGenerationRequest(context.Background(), store.DefaultTenantID, store.GenerationJob{
			ID: "job-timeout", Kind: "image", ProviderID: "shared-main", Model: "image-model", Prompt: "draw", Parameters: parameters,
		})
		if resolveErr == nil {
			t.Fatalf("timeout %d was accepted", timeout)
		}
	}
}

func TestGenerationProviderContextBoundsTheWholeProviderCall(t *testing.T) {
	parent := context.Background()
	personal, cancelPersonal := generationProviderContext(parent, 0)
	cancelPersonal()
	if personal != parent {
		t.Fatal("personal channel context should retain the existing provider defaults")
	}

	shared, cancelShared := generationProviderContext(parent, 10*time.Millisecond)
	defer cancelShared()
	select {
	case <-shared.Done():
		if !errors.Is(shared.Err(), context.DeadlineExceeded) {
			t.Fatalf("shared provider context ended with %v", shared.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("shared provider context did not enforce its timeout")
	}
}

func TestSharedJobCreationPersistsResolvedDefaultModels(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", []byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	channels := []byte(`[{
		"id":"shared-main","name":"Shared","baseUrl":"https://shared.example/v1","protocol":"openai",
		"enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,
		"defaultImageModel":"image-default","defaultVideoModel":"video-default","defaultAudioModel":"audio-default",
		"mediaCapabilities":[
			{"model":"image-default","kind":"image","modes":["text_to_image"],"sizes":["1024x1024"]},
			{"model":"video-default","kind":"video","modes":["text_to_video"]},
			{"model":"audio-default","kind":"audio","modes":["text_to_audio"]}
		]
	}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-main", "sk-shared"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	cases := []struct {
		kind, model, body string
	}{
		{"image", "image-default", `{"id":"shared-image","prompt":"draw","providerId":"shared-main","parameters":{"size":"1024x1024","count":1}}`},
		{"video", "video-default", `{"id":"shared-video","prompt":"move","providerId":"shared-main","parameters":{"ratio":"16:9","resolution":"720p"}}`},
		{"audio", "audio-default", `{"id":"shared-audio","prompt":"speak","providerId":"shared-main","parameters":{"voice":"alloy","format":"mp3"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			got := request(t, router, http.MethodPost, "/api/generation-jobs/"+tc.kind, []byte(tc.body))
			if got.Code != http.StatusAccepted {
				t.Fatalf("create: %d %s", got.Code, got.Body.String())
			}
			var job store.GenerationJob
			if err := json.Unmarshal(got.Body.Bytes(), &job); err != nil || job.Model != tc.model {
				t.Fatalf("persisted model = %q, decode=%v body=%s", job.Model, err, got.Body.String())
			}
			if bytes.Contains(job.Parameters, []byte(`"secret"`)) || bytes.Contains(got.Body.Bytes(), []byte(`"ciphertext"`)) {
				t.Fatalf("public job exposed shared-channel secret: %s", got.Body.String())
			}
			backend.mu.Lock()
			storedJob := backend.jobs[tenantKey(store.DefaultTenantID, "shared-"+tc.kind)]
			backend.mu.Unlock()
			var persisted struct {
				SharedChannel *generationChannelSnapshot `json:"sharedChannel"`
			}
			if err := json.Unmarshal(storedJob.Parameters, &persisted); err != nil || persisted.SharedChannel == nil ||
				persisted.SharedChannel.Model != tc.model || persisted.SharedChannel.TimeoutSeconds != 30 {
				t.Fatalf("persisted snapshot = %#v, decode=%v", persisted.SharedChannel, err)
			}
			if persisted.SharedChannel.Secret.Ciphertext == "" {
				t.Fatal("internal queued job did not retain its encrypted execution credential")
			}
			if tc.kind == "image" {
				resolved, err := server.resolveImageGenerationRequest(context.Background(), store.DefaultTenantID, storedJob)
				if err != nil || resolved.ProviderTimeout != 30*time.Second {
					t.Fatalf("resolved image timeout = %s, err=%v", resolved.ProviderTimeout, err)
				}
			} else {
				resolved, err := server.resolveMediaGenerationRequest(context.Background(), store.DefaultTenantID, storedJob)
				if err != nil || resolved.ProviderTimeout != 30*time.Second {
					t.Fatalf("resolved %s timeout = %s, err=%v", tc.kind, resolved.ProviderTimeout, err)
				}
			}
		})
	}
}

func TestAdminSharedChannelsRejectUnsafeConfiguration(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	cases := [][]byte{
		[]byte(`[{"id":"bad id","name":"x","baseUrl":"https://example.com","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30}]`),
		[]byte(`[{"id":"safe","name":"x","baseUrl":"http://example.com","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30}]`),
		[]byte(`[{"id":"safe","name":"x","baseUrl":"https://user:pass@example.com","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30}]`),
		[]byte(`[{"id":"safe","name":"x","baseUrl":"https://example.com","protocol":"unknown","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30}]`),
	}
	for _, body := range cases {
		if got := request(t, router, http.MethodPut, "/api/admin/channels", body); got.Code != http.StatusBadRequest {
			t.Errorf("unsafe input accepted: %d %s", got.Code, body)
		}
	}
}

func TestAccountTenantChannelsRejectLoopbackAtWriteAndRuntime(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	owner := store.AuthUser{ID: "owner-loopback", TenantID: "tenant-loopback", Role: "owner", Status: "active"}
	handler := withActor(router, owner)
	listed := request(t, handler, http.MethodGet, "/api/tenant/channels", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list tenant channels = %d %s", listed.Code, listed.Body.String())
	}
	body := []byte(`[{"id":"local-provider","name":"Local","baseUrl":"http://127.0.0.1:11434/v1","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultTextModel":"local"}]`)
	got := requestWithHeaders(t, handler, http.MethodPut, "/api/tenant/channels", body, map[string]string{
		adminRevisionHeader: listed.Header().Get(adminRevisionHeader),
	})
	if got.Code != http.StatusBadRequest {
		t.Fatalf("account tenant loopback write = %d %s", got.Code, got.Body.String())
	}

	var channels []adminChannelPublic
	if json.Unmarshal(body, &channels) != nil || backend.PutState(t.Context(), owner.TenantID, adminChannelsStateKey, body) != nil {
		t.Fatal("failed to seed legacy unsafe tenant channel")
	}
	if _, _, err := server.resolveSharedChannel(t.Context(), owner.TenantID, channels[0].ID); err == nil {
		t.Fatal("legacy tenant loopback channel remained executable in account mode")
	}
}

func TestAccountPersonalAndLegacySnapshotChannelsRejectLoopback(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	config := []byte(`{"channels":[{"id":"local","baseUrl":"http://localhost:11434/v1","providers":{"text":{"baseUrl":"http://localhost:11434/v1","model":"local","protocol":"openai"}}}]}`)
	if err := validatePersonalChannelDestinations(config); err == nil {
		t.Fatal("account personal channel accepted a loopback destination")
	}
	if err := validateGenerationSnapshotDestination(generationChannelSnapshot{
		BaseURL: "https://127.0.0.1:8443/v1",
	}); err == nil {
		t.Fatal("legacy tenant snapshot accepted a loopback destination")
	}
	if err := validateGenerationSnapshotDestination(generationChannelSnapshot{
		BaseURL: "http://127.0.0.1:11434/v1", Source: "platform",
	}); err == nil {
		t.Fatal("account platform snapshot accepted a loopback destination")
	}
}

func TestAdminSharedChannelDestinationChangeInvalidatesSecret(t *testing.T) {
	server, _, router := sharedChannelHandler(t)
	oldProvider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer oldProvider.Close()
	newRequests := 0
	newProvider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		newRequests++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer newProvider.Close()

	putChannel := func(baseURL, protocol string) *httptest.ResponseRecorder {
		body, _ := json.Marshal([]adminChannelPublic{{
			ID: "shared-main", Name: "Shared", BaseURL: baseURL, Protocol: protocol,
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 10, DefaultImageModel: "image-model",
		}})
		return putAdminConfigForTest(t, router, "/api/admin/channels", body)
	}
	if got := putChannel(oldProvider.URL, "openai"); got.Code != http.StatusOK {
		t.Fatalf("create channel: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-main", "sk-old-destination"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	listedBeforeRebind := request(t, router, http.MethodGet, "/api/admin/channels", nil)
	var beforeRebind []adminChannelPublic
	if json.Unmarshal(listedBeforeRebind.Body.Bytes(), &beforeRebind) != nil || len(beforeRebind) != 1 {
		t.Fatalf("load old binding: %s", listedBeforeRebind.Body.String())
	}
	oldBinding := beforeRebind[0].SecretBindingID
	if got := putChannel(newProvider.URL, "openai"); got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"secretConfigured": false`)) {
		t.Fatalf("destination update retained secret: %d %s", got.Code, got.Body.String())
	}
	staleBody, _ := json.Marshal(adminChannelSecretInput{APIKey: "sk-from-stale-page", SecretBindingID: oldBinding})
	if got := request(t, router, http.MethodPut, "/api/admin/channels/shared-main/secret", staleBody); got.Code != http.StatusConflict {
		t.Fatalf("stale secret binding accepted: %d %s", got.Code, got.Body.String())
	}
	if _, _, err := server.resolveSharedChannel(context.Background(), store.DefaultTenantID, "shared-main"); err == nil {
		t.Fatal("changed destination resolved with the old secret")
	}
	if got := request(t, router, http.MethodPost, "/api/admin/channels/shared-main/models", nil); got.Code == http.StatusOK {
		t.Fatalf("models unexpectedly used stale secret: %s", got.Body.String())
	}
	if newRequests != 0 {
		t.Fatalf("old secret was sent to the new destination (%d requests)", newRequests)
	}
}

func TestAdminSharedChannelDeleteAndRecreateDoesNotReviveSecret(t *testing.T) {
	server, _, router := sharedChannelHandler(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer provider.Close()
	body, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-main", Name: "Shared", BaseURL: provider.URL, Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 10, DefaultImageModel: "image-model",
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", body); got.Code != http.StatusOK {
		t.Fatalf("create channel: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "shared-main", "sk-deleted"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	if got := deleteAdminConfigForTest(t, router, "/api/admin/channels", "/api/admin/channels/shared-main"); got.Code != http.StatusNoContent {
		t.Fatalf("delete channel: %d %s", got.Code, got.Body.String())
	}
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", body); got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"secretConfigured": false`)) {
		t.Fatalf("recreated channel revived secret: %d %s", got.Code, got.Body.String())
	}
	if _, _, err := server.resolveSharedChannel(context.Background(), store.DefaultTenantID, "shared-main"); err == nil {
		t.Fatal("recreated channel resolved with deleted secret")
	}
}

func TestAdminSharedChannelSecretAADRejectsChangedLifecycleAndDestination(t *testing.T) {
	server, _, _ := sharedChannelHandler(t)
	original := adminChannelPublic{
		ID: "shared-main", BaseURL: "https://old.example/v1", Protocol: "openai", SecretBindingID: "lifecycle-one",
	}
	raw, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, []adminChannelPublic{original}, map[string]string{"shared-main": "sk-bound"})
	if err != nil {
		t.Fatal(err)
	}
	for name, changed := range map[string]adminChannelPublic{
		"lifecycle": {ID: original.ID, BaseURL: original.BaseURL, Protocol: original.Protocol, SecretBindingID: "lifecycle-two"},
		"base url":  {ID: original.ID, BaseURL: "https://new.example/v1", Protocol: original.Protocol, SecretBindingID: original.SecretBindingID},
		"protocol":  {ID: original.ID, BaseURL: original.BaseURL, Protocol: "gemini", SecretBindingID: original.SecretBindingID},
	} {
		t.Run(name, func(t *testing.T) {
			values, decryptErr := server.decryptAdminChannelSecretsRaw(store.DefaultTenantID, []adminChannelPublic{changed}, raw)
			if decryptErr != nil {
				t.Fatal(decryptErr)
			}
			if values[original.ID] != "" {
				t.Fatalf("secret survived %s change", name)
			}
		})
	}
}

func TestAdminSharedChannelUpdateUsesCAS(t *testing.T) {
	_, backend, router := sharedChannelHandler(t)
	original := []byte(`[{"id":"shared-main","name":"Shared","baseUrl":"https://old.example","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultImageModel":"old"}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", original); got.Code != http.StatusOK {
		t.Fatalf("create channel: %d %s", got.Code, got.Body.String())
	}
	backend.compareAndSwapStateErr = store.ErrConflict
	updated := []byte(`[{"id":"shared-main","name":"Shared","baseUrl":"https://new.example","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultImageModel":"new"}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", updated); got.Code != http.StatusConflict {
		t.Fatalf("concurrent update was not rejected: %d %s", got.Code, got.Body.String())
	}
	backend.compareAndSwapStateErr = nil
	channels, err := decodeAdminChannels(backend.state[tenantKey(store.DefaultTenantID, adminChannelsStateKey)])
	if err != nil || len(channels) != 1 || channels[0].BaseURL != "https://old.example" {
		t.Fatalf("conflicting update overwrote channel: %#v, %v", channels, err)
	}
}

func TestAdminSharedChannelFirstSecretSaveRejectsConcurrentChannelChange(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	body := []byte(`[{"id":"shared-main","name":"Shared","baseUrl":"https://old.example","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultImageModel":"image-model"}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", body); got.Code != http.StatusOK {
		t.Fatalf("create channel: %d %s", got.Code, got.Body.String())
	}

	listed := request(t, router, http.MethodGet, "/api/admin/channels", nil)
	var channels []adminChannelPublic
	if json.Unmarshal(listed.Body.Bytes(), &channels) != nil || len(channels) != 1 {
		t.Fatalf("load channel binding: %d %s", listed.Code, listed.Body.String())
	}
	staleBinding := channels[0].SecretBindingID
	backend.compareAndSwapStatesHook = func(tenantID string, _ []store.StateMutation) {
		backend.compareAndSwapStatesHook = nil
		changed := append([]adminChannelPublic(nil), channels...)
		changed[0].BaseURL = "https://new.example"
		changed[0].SecretBindingID = "concurrent-binding"
		raw, _ := json.Marshal(changed)
		backend.state[tenantKey(tenantID, adminChannelsStateKey)] = raw
	}
	secretBody, _ := json.Marshal(adminChannelSecretInput{APIKey: "sk-stale", SecretBindingID: staleBinding})
	got := request(t, router, http.MethodPut, "/api/admin/channels/shared-main/secret", secretBody)
	if got.Code != http.StatusConflict {
		t.Fatalf("concurrent destination update was not rejected: %d %s", got.Code, got.Body.String())
	}
	secrets, err := server.decryptAdminChannelSecrets(context.Background(), store.DefaultTenantID)
	if err != nil {
		t.Fatal(err)
	}
	if secrets["shared-main"] != "" {
		t.Fatal("stale secret was persisted after concurrent destination update")
	}
}

func TestSharedChannelWeightedSelectionIsDeterministicAndCapabilityAware(t *testing.T) {
	server, backend, _ := sharedChannelHandler(t)
	channels := []adminChannelPublic{
		{ID: "image-a", Name: "A", BaseURL: "https://a.example", Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "a"},
		{ID: "image-b", Name: "B", BaseURL: "https://b.example", Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 4, TimeoutSeconds: 30, DefaultImageModel: "b"},
		{ID: "disabled", Name: "Off", BaseURL: "https://off.example", Protocol: "openai", Enabled: false, AllowUserUse: true, Weight: 100, TimeoutSeconds: 30, DefaultImageModel: "off"},
		{ID: "image-only", Name: "Image", BaseURL: "https://image.example", Protocol: "gemini", Enabled: true, AllowUserUse: true, Weight: 100, TimeoutSeconds: 30, DefaultImageModel: "gemini"},
	}
	for index := range channels {
		channels[index].SecretBindingID = "test-binding-" + channels[index].ID
	}
	raw, _ := json.Marshal(channels)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, raw); err != nil {
		t.Fatal(err)
	}
	envelope, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, channels, map[string]string{
		"image-a": "a", "image-b": "b", "disabled": "off", "image-only": "gemini",
	})
	if err != nil || backend.PutState(context.Background(), store.DefaultTenantID, adminChannelSecretsStateKey, envelope) != nil {
		t.Fatal("failed to seed encrypted shared secrets")
	}
	first, err := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "image", "job-stable", "")
	if err != nil {
		t.Fatal(err)
	}
	for range 10 {
		next, selectErr := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "image", "job-stable", "")
		if selectErr != nil || next.ID != first.ID {
			t.Fatalf("selection changed: %s -> %s (%v)", first.ID, next.ID, selectErr)
		}
	}
	video, err := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "video", "job-stable", "requested-model")
	if err != nil || video.ID == "disabled" || video.ID == "image-only" {
		t.Fatalf("video selection ignored eligibility: %#v, %v", video, err)
	}
}

// A non-empty models list is a hard filter: shared-auto must not route a request
// to a channel that the administrator said does not offer that model.
func TestSharedChannelRoutingHonorsPerChannelModelList(t *testing.T) {
	server, backend, _ := sharedChannelHandler(t)
	channels := []adminChannelPublic{
		{
			ID: "only-gpt", Name: "GPT", BaseURL: "https://gpt.example", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 100, TimeoutSeconds: 30,
			DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1", "gpt-image-1.5"},
		},
		{
			ID: "only-seedream", Name: "Seedream", BaseURL: "https://seedream.example", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
			DefaultImageModel: "seedream-4", Models: []string{"seedream-4", "gpt-image-2"},
		},
		{
			ID: "unrestricted", Name: "Open", BaseURL: "https://open.example", Protocol: "openai",
			Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
			DefaultImageModel: "anything",
		},
	}
	for index := range channels {
		channels[index].SecretBindingID = "test-binding-" + channels[index].ID
	}
	raw, _ := json.Marshal(channels)
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, raw); err != nil {
		t.Fatal(err)
	}
	envelope, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, channels, map[string]string{
		"only-gpt": "a", "only-seedream": "b", "unrestricted": "c",
	})
	if err != nil || backend.PutState(context.Background(), store.DefaultTenantID, adminChannelSecretsStateKey, envelope) != nil {
		t.Fatal("failed to seed encrypted shared secrets")
	}

	// Requested model is only on the seedream channel's list, so the high-weight
	// GPT channel must be skipped even though its protocol can do images.
	picked, err := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "image", "job-model", "gpt-image-2")
	if err != nil {
		t.Fatal(err)
	}
	if picked.ID != "only-seedream" {
		t.Fatalf("expected only-seedream for gpt-image-2, got %#v", picked)
	}

	// Empty model list means no restriction, so unrestricted stays eligible for
	// a model neither of the filtered channels advertise.
	open, err := server.selectSharedChannel(context.Background(), store.DefaultTenantID, "image", "job-open", "brand-new-model")
	if err != nil || open.ID != "unrestricted" {
		t.Fatalf("empty models list should stay eligible: %#v, %v", open, err)
	}

	// No channel advertises this model and the unrestricted one is disabled by
	// zeroing its weight via removal — leave it enabled but filter by list only.
	if !sharedChannelSupports(channels[0], "image", "gpt-image-1") {
		t.Fatal("gpt-image-1 should be allowed on only-gpt")
	}
	if sharedChannelSupports(channels[0], "image", "gpt-image-2") {
		t.Fatal("gpt-image-2 must not be allowed on only-gpt")
	}
	if !sharedChannelSupports(channels[2], "image", "anything-goes") {
		t.Fatal("empty models list must not filter")
	}
}

func TestNormalizeAdminChannelCleansModels(t *testing.T) {
	channel, message := normalizeAdminChannel(adminChannelPublic{
		ID: "shared-main", Name: "Shared", BaseURL: "https://api.example.com/v1",
		Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1",
		Models:            []string{" gpt-image-2 ", "", "GPT-image-2", "seedream-4"},
	})
	if message != "" {
		t.Fatalf("normalize failed: %s", message)
	}
	if len(channel.Models) != 2 || channel.Models[0] != "gpt-image-2" || channel.Models[1] != "seedream-4" {
		t.Fatalf("models not cleaned: %#v", channel.Models)
	}
}

func TestNormalizeAdminChannelCleansExplicitMediaCapabilities(t *testing.T) {
	channel, message := normalizeAdminChannel(adminChannelPublic{
		ID: "shared-media", Name: "Shared", BaseURL: "https://api.example.com/v1",
		Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1", "video-model"},
		MediaCapabilities: []adminMediaCapability{
			{Model: " gpt-image-1 ", Kind: " IMAGE ", Modes: []string{" text_to_image ", "TEXT_TO_IMAGE", "image_to_image"}, Sizes: []string{" 1024x1024 ", "1024X1024"}, MaxReferences: 4},
			{Model: "video-model", Kind: "video", Modes: []string{"text_to_video"}, Sizes: []string{"16:9", "720p", "4K"}, Durations: []int{10, 5, 10}},
		},
	})
	if message != "" {
		t.Fatalf("normalize failed: %s", message)
	}
	if len(channel.MediaCapabilities) != 2 {
		t.Fatalf("capabilities = %#v", channel.MediaCapabilities)
	}
	image := channel.MediaCapabilities[0]
	if image.Model != "gpt-image-1" || image.Kind != "image" || !reflect.DeepEqual(image.Modes, []string{"text_to_image", "image_to_image"}) || !reflect.DeepEqual(image.Sizes, []string{"1024x1024"}) || image.MaxReferences != 4 {
		t.Fatalf("image capability not normalized: %#v", image)
	}
	if !reflect.DeepEqual(channel.MediaCapabilities[1].Durations, []int{10, 5}) {
		t.Fatalf("durations not deduplicated: %#v", channel.MediaCapabilities[1])
	}
	if !reflect.DeepEqual(channel.MediaCapabilities[1].Sizes, []string{"16:9", "720p", "4K"}) {
		t.Fatalf("video ratios and resolutions not normalized: %#v", channel.MediaCapabilities[1])
	}
}

func TestNormalizeAdminChannelRejectsInvalidExplicitMediaCapabilities(t *testing.T) {
	base := adminChannelPublic{
		ID: "shared-media", Name: "Shared", BaseURL: "https://api.example.com/v1",
		Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "gpt-image-1", Models: []string{"gpt-image-1", "video-model"},
	}
	tests := []struct {
		name         string
		capabilities []adminMediaCapability
	}{
		{name: "model outside channel", capabilities: []adminMediaCapability{{Model: "other", Kind: "image", Modes: []string{"text_to_image"}}}},
		{name: "invalid kind", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "text", Modes: []string{"text_to_image"}}}},
		{name: "mode does not match kind", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_video"}}}},
		{name: "empty modes", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image"}}},
		{name: "too many references", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, MaxReferences: 17}}},
		{name: "negative references", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, MaxReferences: -1}}},
		{name: "invalid duration", capabilities: []adminMediaCapability{{Model: "video-model", Kind: "video", Modes: []string{"text_to_video"}, Durations: []int{0}}}},
		{name: "duration too large", capabilities: []adminMediaCapability{{Model: "video-model", Kind: "video", Modes: []string{"text_to_video"}, Durations: []int{901}}}},
		{name: "invalid size syntax", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, Sizes: []string{"anything"}}}},
		{name: "size too long", capabilities: []adminMediaCapability{{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}, Sizes: []string{strings.Repeat("x", 101)}}}},
		{name: "duplicate model kind", capabilities: []adminMediaCapability{
			{Model: "gpt-image-1", Kind: "image", Modes: []string{"text_to_image"}},
			{Model: "GPT-IMAGE-1", Kind: "IMAGE", Modes: []string{"text_to_image"}},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := base
			input.MediaCapabilities = test.capabilities
			if _, message := normalizeAdminChannel(input); message == "" {
				t.Fatalf("accepted invalid capabilities: %#v", test.capabilities)
			}
		})
	}
}

func TestAdminSharedChannelResponseNeverIncludesSecretInput(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	body := []byte(`[{
		"id":"shared-main","name":"Shared","baseUrl":"https://api.example.com/v1","protocol":"openai",
		"enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultImageModel":"gpt-image-1",
		"models":["gpt-image-1"],"mediaCapabilities":[{"model":"gpt-image-1","kind":"image","modes":["text_to_image"]}],
		"apiKey":"must-not-be-accepted"
	}]`)
	response := putAdminConfigForTest(t, router, "/api/admin/channels", body)
	if response.Code != http.StatusBadRequest || bytes.Contains(response.Body.Bytes(), []byte("must-not-be-accepted")) {
		t.Fatalf("sensitive field accepted or echoed: %d %s", response.Code, response.Body.String())
	}
}

func TestNormalizeAdminChannelRejectsUserVisibleChannelWithoutDefaultModel(t *testing.T) {
	_, message := normalizeAdminChannel(adminChannelPublic{
		ID: "shared-empty", Name: "Empty", BaseURL: "https://api.example.com/v1",
		Protocol: "openai", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60,
	})
	if message != "shared channel requires a default model" {
		t.Fatalf("message = %q", message)
	}
}

func TestAzureAndKeylessEdgeSharedAudioChannels(t *testing.T) {
	azure, azureMessage := normalizeAdminChannel(adminChannelPublic{
		ID: "azure-tts", Name: "Azure Speech", BaseURL: "https://eastus.tts.speech.microsoft.com",
		Protocol: "azure", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60,
		DefaultAudioModel: "azure-neural-tts",
	})
	if azureMessage != "" || !sharedChannelSupports(azure, "audio", "azure-neural-tts") || sharedChannelSupports(azure, "image", "azure-neural-tts") {
		t.Fatalf("Azure audio channel = %#v, %q", azure, azureMessage)
	}
	edge, edgeMessage := normalizeAdminChannel(adminChannelPublic{
		ID: "edge-tts", Name: "Edge TTS", BaseURL: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud",
		Protocol: "edge", Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60,
		DefaultAudioModel: "edge-tts",
	})
	if edgeMessage != "" || !sharedChannelSupports(edge, "audio", "edge-tts") || adminChannelRequiresSecret(edge) {
		t.Fatalf("Edge audio channel = %#v, %q", edge, edgeMessage)
	}
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]adminChannelPublic{edge})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, adminChannelsStateKey, raw); err != nil {
		t.Fatal(err)
	}
	resolved, key, err := server.resolveSharedChannel(context.Background(), store.DefaultTenantID, edge.ID)
	if err != nil || key != "" || resolved.ID != edge.ID {
		t.Fatalf("resolve keyless Edge channel = %#v key=%q err=%v", resolved, key, err)
	}
	actor := store.AuthUser{ID: "edge-user", TenantID: store.DefaultTenantID, Role: "member", Status: "active"}
	ctx := context.WithValue(context.Background(), authUserKey, actor)
	providerID, snapshot, err := server.snapshotGenerationChannel(
		ctx, store.DefaultTenantID, "audio", "job-edge-shared", edge.ID, "edge-tts")
	if err != nil || providerID != edge.ID || snapshot == nil || snapshot.Secret != (secretEnvelope{}) {
		t.Fatalf("snapshot keyless Edge channel = %q %#v err=%v", providerID, snapshot, err)
	}
}

func TestAdminAzureAudioConnectionUsesSpeechEndpoint(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/cognitiveservices/v1" ||
			r.Header.Get("Ocp-Apim-Subscription-Key") != "azure-secret" {
			http.Error(w, "unexpected request", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3-azure-test"))
	}))
	defer upstream.Close()

	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "azure-audio", Name: "Azure audio", BaseURL: upstream.URL, Protocol: "azure",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 15,
		DefaultAudioModel: "azure-neural-tts",
	}})
	if got := putAdminConfigForTest(t, router, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, router, "azure-audio", "azure-secret"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	connection := request(t, router, http.MethodPost, "/api/admin/channels/azure-audio/test", nil)
	if connection.Code != http.StatusOK {
		t.Fatalf("Azure connection: %d %s", connection.Code, connection.Body.String())
	}
}
