package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestPlatformChannelAudienceIsTenantScoped(t *testing.T) {
	channel := platformChannelPublic{
		ID: "gpt-imager2", TenantIDs: []string{"tenant-b"},
	}
	if platformChannelVisibleToTenant(channel, "tenant-a") {
		t.Fatal("tenant-a must not see a channel published only to tenant-b")
	}
	if !platformChannelVisibleToTenant(channel, "tenant-b") {
		t.Fatal("tenant-b must see its published channel")
	}
	channel.PublishToAll = true
	if !platformChannelVisibleToTenant(channel, "tenant-a") {
		t.Fatal("publish-to-all channel must be visible to every tenant")
	}
}

func TestAccountPlatformChannelsRejectLoopbackDestinations(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	admin := store.AuthUser{
		ID: "platform-loopback-admin", TenantID: "tenant-loopback", Role: "user",
		Status: "active", PlatformAdmin: true,
	}
	handler := withActor(router, admin)
	listed := request(t, handler, http.MethodGet, "/api/platform/channels", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list platform channels = %d %s", listed.Code, listed.Body.String())
	}
	body := []byte(`[{"id":"platform-local","name":"Local","baseUrl":"http://127.0.0.1:11434/v1","protocol":"openai","enabled":true,"allowUserUse":true,"weight":1,"timeoutSeconds":30,"defaultTextModel":"local","publishToAll":true}]`)
	saved := requestWithHeaders(t, handler, http.MethodPut, "/api/platform/channels", body, map[string]string{
		adminRevisionHeader: listed.Header().Get(adminRevisionHeader),
	})
	if saved.Code != http.StatusBadRequest {
		t.Fatalf("account platform loopback write = %d %s", saved.Code, saved.Body.String())
	}
}

func TestPlatformChannelMigrationCannotReadAnotherTenantSecretBag(t *testing.T) {
	server, _, _ := sharedChannelHandler(t)
	_, err := server.migrateTenantChannelsToPlatform(t.Context(), platformChannelMigrationInput{
		SourceTenantID: "tenant-victim", ChannelIDs: []string{"channel-a"}, PublishToAll: true,
	})
	if !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("cross-tenant migration error = %v", err)
	}
}

func TestPlatformChannelIsPublishedWithoutLeakingSecretOrDestination(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	channel := platformChannelPublic{
		ID: "gpt-imager2", Name: "GPT Imager 2", BaseURL: "https://provider.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "gpt-image-2",
		SecretBindingID: "platform-binding",
		TenantIDs:       []string{"tenant-b"},
	}
	raw, err := json.Marshal([]platformChannelPublic{channel})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), store.DefaultTenantID, platformChannelsStateKey, raw); err != nil {
		t.Fatal(err)
	}
	envelope, err := server.encryptAdminChannelSecrets(platformChannelSecretScope, []adminChannelPublic{channel.adminChannel()}, map[string]string{channel.ID: "sk-platform-private"})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), store.DefaultTenantID, platformChannelSecretsStateKey, envelope); err != nil {
		t.Fatal(err)
	}

	visible := withActor(router, store.AuthUser{ID: "tenant-b-user", TenantID: "tenant-b", Role: "member", Status: "active"})
	response := request(t, visible, http.MethodGet, "/api/shared-channels", nil)
	if response.Code != http.StatusOK || !containsJSONString(response.Body.Bytes(), "gpt-imager2") {
		t.Fatalf("published platform channel = %d %s", response.Code, response.Body.String())
	}
	if containsJSONString(response.Body.Bytes(), "provider.example") || containsJSONString(response.Body.Bytes(), "sk-platform-private") {
		t.Fatalf("platform channel leaked private fields: %s", response.Body.String())
	}

	hidden := withActor(router, store.AuthUser{ID: "tenant-a-user", TenantID: "tenant-a", Role: "member", Status: "active"})
	hiddenResponse := request(t, hidden, http.MethodGet, "/api/shared-channels", nil)
	if hiddenResponse.Code != http.StatusOK || containsJSONString(hiddenResponse.Body.Bytes(), "gpt-imager2") {
		t.Fatalf("unpublished platform channel visible to tenant-a = %d %s", hiddenResponse.Code, hiddenResponse.Body.String())
	}
}

func TestPlatformChannelEndpointsKeepGlobalSecretSeparate(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	initial := request(t, router, http.MethodGet, "/api/platform/channels", nil)
	if initial.Code != http.StatusOK || initial.Header().Get(adminRevisionHeader) == "" {
		t.Fatalf("initial platform catalog = %d %s", initial.Code, initial.Body.String())
	}
	channel := platformChannelPublic{
		ID: "platform-image", Name: "Platform Image", BaseURL: "https://provider.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30, DefaultImageModel: "gpt-image-2", PublishToAll: true,
	}
	body, _ := json.Marshal([]platformChannelPublic{channel})
	saved := requestWithHeaders(t, router, http.MethodPut, "/api/platform/channels", body, map[string]string{
		"Authorization": "Bearer test-token", adminRevisionHeader: initial.Header().Get(adminRevisionHeader),
	})
	if saved.Code != http.StatusOK || !containsJSONString(saved.Body.Bytes(), "platform-image") {
		t.Fatalf("save platform catalog = %d %s", saved.Code, saved.Body.String())
	}
	var savedChannels []platformChannelPublic
	if err := json.Unmarshal(saved.Body.Bytes(), &savedChannels); err != nil || len(savedChannels) != 1 || savedChannels[0].SecretBindingID == "" {
		t.Fatalf("saved platform channels = %s", saved.Body.String())
	}
	var savedRevision string = saved.Header().Get(adminRevisionHeader)
	if savedRevision == "" {
		t.Fatal("save platform catalog did not return a revision")
	}
	updatedBody, _ := json.Marshal(savedChannels)
	updated := requestWithHeaders(t, router, http.MethodPut, "/api/platform/channels", updatedBody, map[string]string{
		"Authorization": "Bearer test-token", adminRevisionHeader: savedRevision,
	})
	if updated.Code != http.StatusOK {
		t.Fatalf("save platform catalog with returned revision = %d %s", updated.Code, updated.Body.String())
	}
	platformCredential := "test-platform-credential"
	secretBody, _ := json.Marshal(adminChannelSecretInput{APIKey: platformCredential, SecretBindingID: savedChannels[0].SecretBindingID})
	secret := requestWithHeaders(t, router, http.MethodPut, "/api/platform/channels/platform-image/secret", secretBody, map[string]string{"Authorization": "Bearer test-token"})
	if secret.Code != http.StatusNoContent {
		t.Fatalf("save platform secret = %d %s", secret.Code, secret.Body.String())
	}
	listed := request(t, router, http.MethodGet, "/api/platform/channels", nil)
	if listed.Code != http.StatusOK || !containsJSONString(listed.Body.Bytes(), `"secretConfigured": true`) || containsJSONString(listed.Body.Bytes(), platformCredential) {
		t.Fatalf("platform admin catalog leaked secret = %d %s", listed.Code, listed.Body.String())
	}
	shared := request(t, withActor(router, store.AuthUser{ID: "tenant-user", TenantID: "tenant-x", Role: "member", Status: "active"}), http.MethodGet, "/api/shared-channels", nil)
	if shared.Code != http.StatusOK || !containsJSONString(shared.Body.Bytes(), "platform-image") || containsJSONString(shared.Body.Bytes(), "provider.example") {
		t.Fatalf("global shared catalog = %d %s", shared.Code, shared.Body.String())
	}
}

func TestMigrateTenantChannelToPlatformPreservesSourceAndPublishes(t *testing.T) {
	_, _, router := sharedChannelHandler(t)
	channel := adminChannelPublic{
		ID: "gpt-imager2", Name: "GPT Imager 2", BaseURL: "https://provider.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "gpt-image-2",
	}
	body, _ := json.Marshal([]adminChannelPublic{channel})
	if saved := putAdminConfigForTest(t, router, "/api/admin/channels", body); saved.Code != http.StatusOK {
		t.Fatalf("save source channel = %d %s", saved.Code, saved.Body.String())
	}
	if secret := putSharedChannelSecret(t, router, channel.ID, "sk-source-private"); secret.Code != http.StatusNoContent {
		t.Fatalf("save source channel secret = %d %s", secret.Code, secret.Body.String())
	}

	migrationBody := []byte(`{"sourceTenantId":"local","channelIds":["gpt-imager2"],"publishToAll":true}`)
	migrated := request(t, router, http.MethodPost, "/api/platform/channels/migrate-local", migrationBody)
	if migrated.Code != http.StatusOK || !containsJSONString(migrated.Body.Bytes(), "gpt-imager2") || !containsJSONString(migrated.Body.Bytes(), `"secretConfigured": true`) {
		t.Fatalf("migrate source channel = %d %s", migrated.Code, migrated.Body.String())
	}
	source := request(t, router, http.MethodGet, "/api/admin/channels", nil)
	if source.Code != http.StatusOK || !containsJSONString(source.Body.Bytes(), "gpt-imager2") {
		t.Fatalf("source channel was not preserved = %d %s", source.Code, source.Body.String())
	}
	visible := request(t, withActor(router, store.AuthUser{ID: "tenant-b-user", TenantID: "tenant-b", Role: "member", Status: "active"}), http.MethodGet, "/api/shared-channels", nil)
	if visible.Code != http.StatusOK || !containsJSONString(visible.Body.Bytes(), "gpt-imager2") || containsJSONString(visible.Body.Bytes(), "provider.example") || containsJSONString(visible.Body.Bytes(), "sk-source-private") {
		t.Fatalf("migrated channel was not safely published = %d %s", visible.Code, visible.Body.String())
	}
}

func TestPlatformChannelMigrationRequiresPlatformAndSourceOwnerCapabilities(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	channel := adminChannelPublic{
		ID: "migration-source", Name: "Migration source", BaseURL: "https://provider.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "gpt-image-2", SecretBindingID: "source-binding",
	}
	raw, _ := json.Marshal([]adminChannelPublic{channel})
	if err := backend.PutState(t.Context(), store.DefaultTenantID, adminChannelsStateKey, raw); err != nil {
		t.Fatal(err)
	}
	secrets, err := server.encryptAdminChannelSecrets(store.DefaultTenantID, []adminChannelPublic{channel}, map[string]string{channel.ID: "sk-source"})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(t.Context(), store.DefaultTenantID, adminChannelSecretsStateKey, secrets); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	body := []byte(`{"sourceTenantId":"local","channelIds":["migration-source"],"publishToAll":true}`)
	platformOnly := store.AuthUser{ID: "platform-only", TenantID: store.DefaultTenantID, Role: "user", Status: "active", PlatformAdmin: true}
	ownerOnly := store.AuthUser{ID: "owner-only", TenantID: store.DefaultTenantID, Role: "owner", Status: "active"}
	dual := store.AuthUser{ID: "dual", TenantID: store.DefaultTenantID, Role: "owner", Status: "active", PlatformAdmin: true}
	if got := request(t, withActor(router, platformOnly), http.MethodPost, "/api/platform/channels/migrate-local", body); got.Code != http.StatusForbidden {
		t.Fatalf("platform-only migration = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, withActor(router, ownerOnly), http.MethodPost, "/api/platform/channels/migrate-local", body); got.Code != http.StatusForbidden {
		t.Fatalf("owner-only migration = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, withActor(router, dual), http.MethodPost, "/api/platform/channels/migrate-local", body); got.Code != http.StatusOK {
		t.Fatalf("dual-capability migration = %d %s", got.Code, got.Body.String())
	}
}

func containsJSONString(raw []byte, value string) bool {
	return len(raw) > 0 && bytes.Contains(raw, []byte(value))
}
