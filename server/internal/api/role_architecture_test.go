package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func TestGenerationHistoryIsUserScopedWhileOwnerCanInspectTenantJobs(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	memberA := store.AuthUser{ID: "member-a", TenantID: owner.TenantID, Role: "member", Status: "active"}
	memberB := store.AuthUser{ID: "member-b", TenantID: owner.TenantID, Role: "member", Status: "active"}
	for _, user := range []store.AuthUser{owner, memberA, memberB} {
		seedAdminUser(backend.memoryStore, user)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, job := range []store.GenerationJob{
		{ID: "job-member-a", UserID: memberA.ID, Kind: "image", Status: "succeeded", Prompt: "member a private prompt", Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now},
		{ID: "job-member-b", UserID: memberB.ID, Kind: "image", Status: "succeeded", Prompt: "member b private prompt", Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now},
		{ID: "job-member-b-active", UserID: memberB.ID, Kind: "image", Status: "queued", Prompt: "member b paid task", Parameters: json.RawMessage(`{"executor":"server"}`), Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now},
	} {
		if err := backend.CreateGenerationJob(t.Context(), owner.TenantID, job); err != nil {
			t.Fatal(err)
		}
	}

	memberHandler := capabilityHandler(t, backend, memberA)
	listed := request(t, memberHandler, http.MethodGet, "/api/generation-jobs?page=1&pageSize=100", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte("job-member-a")) || bytes.Contains(listed.Body.Bytes(), []byte("member b private prompt")) {
		t.Fatalf("member history scope = %d %s", listed.Code, listed.Body.String())
	}
	for _, check := range []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodGet, "/api/generation-jobs/job-member-b", nil},
		{http.MethodPut, "/api/generation-jobs/job-member-b", []byte(`{"id":"job-member-b","kind":"image","status":"failed","prompt":"tampered","parameters":{},"result":{}}`)},
		{http.MethodPost, "/api/generation-jobs/job-member-b-active/cancel", nil},
	} {
		got := request(t, memberHandler, check.method, check.path, check.body)
		if got.Code != http.StatusNotFound {
			t.Fatalf("member %s %s = %d %s", check.method, check.path, got.Code, got.Body.String())
		}
	}

	created := request(t, memberHandler, http.MethodPost, "/api/generation-jobs", []byte(`{
		"id":"job-created-by-a","kind":"image","status":"succeeded","prompt":"own",
		"parameters":{},"result":{}
	}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("member create = %d %s", created.Code, created.Body.String())
	}
	stored, err := backend.GetGenerationJob(t.Context(), owner.TenantID, "job-created-by-a")
	if err != nil || stored.UserID != memberA.ID {
		t.Fatalf("created job owner = %q err=%v", stored.UserID, err)
	}

	ownerHandler := capabilityHandler(t, backend, owner)
	ownerList := request(t, ownerHandler, http.MethodGet, "/api/generation-jobs?page=1&pageSize=100", nil)
	if ownerList.Code != http.StatusOK || !bytes.Contains(ownerList.Body.Bytes(), []byte("member b private prompt")) {
		t.Fatalf("owner tenant history = %d %s", ownerList.Code, ownerList.Body.String())
	}
	if got := request(t, ownerHandler, http.MethodPost, "/api/generation-jobs/job-member-b-active/cancel", nil); got.Code != http.StatusOK {
		t.Fatalf("owner cancel tenant job = %d %s", got.Code, got.Body.String())
	}
	ownerRequest := requestWithActorContext(owner)
	if !requestCanAccessGenerationJob(ownerRequest, store.GenerationJob{UserID: memberB.ID}) {
		t.Fatal("owner lost tenant-history inspection access")
	}
	if requestOwnsGenerationJob(ownerRequest, store.GenerationJob{UserID: memberB.ID}) {
		t.Fatal("owner was allowed to reuse another account's idempotent task")
	}
}

func TestRoleArchitectureSeparatesPlatformAndTenantCapabilities(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Email: "owner@example.com", Role: "owner", Status: "active"}
	platformUser := store.AuthUser{ID: "platform-a", TenantID: "tenant-a", Email: "platform@example.com", Role: "member", Status: "active", PlatformAdmin: true}
	member := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Email: "member@example.com", Role: "member", Status: "active"}
	for _, user := range []store.AuthUser{owner, platformUser, member} {
		seedAdminUser(backend.memoryStore, user)
	}

	if got := request(t, capabilityHandler(t, backend, owner), http.MethodGet, "/api/tenant/channels", nil); got.Code != http.StatusOK {
		t.Fatalf("owner tenant channels = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, platformUser), http.MethodGet, "/api/tenant/channels", nil); got.Code != http.StatusForbidden {
		t.Fatalf("platform-only user tenant channels = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, member), http.MethodGet, "/api/tenant/channels", nil); got.Code != http.StatusForbidden {
		t.Fatalf("member tenant channels = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, owner), http.MethodGet, "/api/platform/tenants", nil); got.Code != http.StatusForbidden {
		t.Fatalf("owner platform tenants = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, platformUser), http.MethodGet, "/api/platform/tenants", nil); got.Code != http.StatusOK {
		t.Fatalf("platform user platform tenants = %d %s", got.Code, got.Body.String())
	}
}

func TestConfiguredPlatformGrantUsesImmutableUserIDNotUnverifiedEmail(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	actor := store.AuthUser{ID: "stable-user-id", TenantID: "tenant-a", Email: "allowlisted@example.com", Role: "member", Status: "active"}
	seedAdminUser(backend.memoryStore, actor)
	t.Setenv("OPENBOARD_PLATFORM_ADMIN_EMAILS", actor.Email)
	t.Setenv("OPENBOARD_PLATFORM_ADMIN_USER_IDS", "")

	if got := request(t, capabilityHandler(t, backend, actor), http.MethodGet, "/api/platform/tenants", nil); got.Code != http.StatusForbidden {
		t.Fatalf("unverified email grant = %d %s", got.Code, got.Body.String())
	}
	t.Setenv("OPENBOARD_PLATFORM_ADMIN_USER_IDS", actor.ID)
	if got := request(t, capabilityHandler(t, backend, actor), http.MethodGet, "/api/platform/tenants", nil); got.Code != http.StatusOK {
		t.Fatalf("stable user-id grant = %d %s", got.Code, got.Body.String())
	}
}

func TestTenantOwnerCannotMintQuotaCreditsOrChangePlatformPricing(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Email: "owner@example.com", Role: "owner", Status: "active"}
	target := store.AuthUser{ID: "member-a", TenantID: owner.TenantID, Email: "member@example.com", Role: "member", Status: "active", Credits: 10}
	seedAdminUser(backend, owner)
	seedAdminUser(backend, target)
	handler := tenantAdminHandler(t, backend, owner)

	checks := []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodPut, "/api/admin/tenant-quota", []byte(`{"generationQuotaMonthly":999999}`)},
		{http.MethodPost, "/api/admin/users/member-a/credit-adjustments", []byte(`{"delta":5,"reason":"owner mint","idempotencyKey":"owner-mint-0001"}`)},
		{http.MethodPut, "/api/admin/models", []byte(`{"modelCosts":[],"defaultCredits":1,"revision":"legacy"}`)},
	}
	for _, check := range checks {
		got := request(t, handler, check.method, check.path, check.body)
		if got.Code != http.StatusForbidden || got.Body.String() != "platform administrator required\n" {
			t.Fatalf("%s %s = %d %q", check.method, check.path, got.Code, got.Body.String())
		}
	}
	if got := backend.credits[tenantKey(owner.TenantID, target.ID)]; got != 10 {
		t.Fatalf("owner changed credits: %d", got)
	}
}

func TestPlatformAndTenantPoliciesHaveIndependentWriters(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Email: "owner@example.com", Role: "owner", Status: "active"}
	platformUser := store.AuthUser{ID: "platform-a", TenantID: "tenant-a", Email: "platform@example.com", Role: "member", Status: "active", PlatformAdmin: true}
	for _, user := range []store.AuthUser{owner, platformUser} {
		seedAdminUser(backend.memoryStore, user)
	}

	tenantBody := []byte(`{"allowCustomChannel":false,"allowCloudChannel":true,"availableModels":["gpt-image-1"],"defaultImageModel":"gpt-image-1"}`)
	if got := request(t, capabilityHandler(t, backend, owner), http.MethodPut, "/api/tenant/policy", tenantBody); got.Code != http.StatusOK {
		t.Fatalf("owner tenant policy = %d %s", got.Code, got.Body.String())
	}
	legacyTenantRaw, err := backend.GetState(t.Context(), owner.TenantID, sitePolicyStateKey)
	if err != nil {
		t.Fatalf("tenant policy compatibility projection: %v", err)
	}
	var legacyTenant SitePolicy
	if json.Unmarshal(legacyTenantRaw, &legacyTenant) != nil || legacyTenant.AllowCustomChannel || !legacyTenant.AllowCloudChannel || legacyTenant.DefaultImageModel != "gpt-image-1" {
		t.Fatalf("tenant compatibility policy = %s", legacyTenantRaw)
	}
	if got := request(t, capabilityHandler(t, backend, platformUser), http.MethodPut, "/api/tenant/policy", tenantBody); got.Code != http.StatusForbidden {
		t.Fatalf("platform-only tenant policy = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, owner), http.MethodPut, "/api/platform/policy", []byte(`{"allowRegister":false}`)); got.Code != http.StatusForbidden {
		t.Fatalf("owner platform policy = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, capabilityHandler(t, backend, platformUser), http.MethodPut, "/api/platform/policy", []byte(`{"allowRegister":false}`)); got.Code != http.StatusOK {
		t.Fatalf("platform policy = %d %s", got.Code, got.Body.String())
	}
	legacyPlatformRaw, err := backend.GetState(t.Context(), store.DefaultTenantID, sitePolicyStateKey)
	if err != nil {
		t.Fatalf("platform policy compatibility projection: %v", err)
	}
	var legacyPlatform SitePolicy
	if json.Unmarshal(legacyPlatformRaw, &legacyPlatform) != nil || legacyPlatform.AllowRegister {
		t.Fatalf("platform compatibility policy = %s", legacyPlatformRaw)
	}

	legacy := request(t, capabilityHandler(t, backend, owner), http.MethodPut, "/api/site-policy", []byte(`{"allowRegister":true,"allowCustomChannel":true,"allowCloudChannel":true}`))
	if legacy.Code != http.StatusForbidden {
		t.Fatalf("owner legacy registration change = %d %s", legacy.Code, legacy.Body.String())
	}
}

func TestAuthenticatedOwnerConfigAndSecretsArePersonal(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	r := requestWithActorContext(owner)

	configKey, tenantWide := requestStateStorageKey(r, "config")
	if tenantWide || configKey != "__user_config_v1:"+owner.ID {
		t.Fatalf("owner config scope = %q tenantWide=%v", configKey, tenantWide)
	}
	secretKey, secretTenantWide := secretStorageKey(r)
	if secretTenantWide || secretKey != userSecretStateKeyPrefix+owner.ID {
		t.Fatalf("owner secret scope = %q tenantWide=%v", secretKey, secretTenantWide)
	}
}

func TestAuthOffE2EIdentityUsesTheSameTenantConfigAsGenerationWorkers(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	owner := store.AuthUser{ID: "e2e-owner", TenantID: "e2e-tenant", Role: "owner", Status: "active"}
	r := requestWithActorContext(owner)

	configKey, tenantWide := requestStateStorageKey(r, "config")
	secretKey, secretTenantWide := secretStorageKey(r)
	workerConfigKey, workerSecretKey, err := generationCredentialStorageKeys(owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !tenantWide || configKey != workerConfigKey || configKey != "config" {
		t.Fatalf("auth-off config scope = %q tenantWide=%v, worker=%q", configKey, tenantWide, workerConfigKey)
	}
	if !secretTenantWide || secretKey != workerSecretKey || secretKey != secretStateKey {
		t.Fatalf("auth-off secret scope = %q tenantWide=%v, worker=%q", secretKey, secretTenantWide, workerSecretKey)
	}
}

func TestRoleArchitectureLimitsUserMutationsToOwningScope(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Email: "owner@example.com", Role: "owner", Status: "active"}
	platformUser := store.AuthUser{ID: "platform-a", TenantID: "tenant-b", Email: "platform@example.com", Role: "member", Status: "active", PlatformAdmin: true}
	member := store.AuthUser{ID: "member-a", TenantID: owner.TenantID, Email: "member@example.com", Role: "member", Status: "active"}
	for _, user := range []store.AuthUser{owner, platformUser, member} {
		seedAdminUser(backend.memoryStore, user)
	}

	platformHandler := capabilityHandler(t, backend, platformUser)
	if got := request(t, platformHandler, http.MethodPatch, "/api/platform/users/member-a", []byte(`{"role":"owner"}`)); got.Code != http.StatusBadRequest {
		t.Fatalf("platform role update = %d %s", got.Code, got.Body.String())
	}
	if target, err := backend.GetUser(context.Background(), owner.TenantID, member.ID); err != nil || target.Role != "member" {
		t.Fatalf("platform changed tenant role: %#v %v", target, err)
	}

	ownerHandler := capabilityHandler(t, backend, owner)
	if got := request(t, ownerHandler, http.MethodPatch, "/api/tenant/members/member-a", []byte(`{"displayName":"renamed outside tenant role policy"}`)); got.Code != http.StatusBadRequest {
		t.Fatalf("owner profile update = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, ownerHandler, http.MethodPatch, "/api/tenant/members/member-a", []byte(`{"status":"ban"}`)); got.Code != http.StatusOK {
		t.Fatalf("owner status update = %d %s", got.Code, got.Body.String())
	}
}

func TestTenantOwnerCannotDisableAPlatformAdministratorAccount(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	platformMember := store.AuthUser{ID: "platform-a", TenantID: owner.TenantID, Role: "member", Status: "active", PlatformAdmin: true}
	seedAdminUser(backend.memoryStore, owner)
	seedAdminUser(backend.memoryStore, platformMember)

	got := request(t, capabilityHandler(t, backend, owner), http.MethodPatch, "/api/tenant/members/platform-a", []byte(`{"status":"ban"}`))
	if got.Code != http.StatusForbidden {
		t.Fatalf("owner disabled platform account = %d %s", got.Code, got.Body.String())
	}
	stored, err := backend.GetUser(context.Background(), owner.TenantID, platformMember.ID)
	if err != nil || stored.Status != "active" {
		t.Fatalf("platform account status = %#v %v", stored, err)
	}
}

func TestOrdinaryUserCannotReplaceOrBulkDeleteTenantWorkspace(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	member := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "member", Status: "active"}
	seedAdminUser(backend.memoryStore, member)
	handler := capabilityHandler(t, backend, member)
	checks := []struct {
		method string
		path   string
	}{
		{http.MethodPut, "/api/projects"},
		{http.MethodPost, "/api/projects/rollback"},
		{http.MethodPut, "/api/generation-jobs"},
		{http.MethodPost, "/api/generation-jobs/bulk-delete"},
		{http.MethodDelete, "/api/generation-jobs/job-a"},
		{http.MethodDelete, "/api/generation-jobs/project/project-a"},
		{http.MethodDelete, "/api/projects/project-a"},
	}
	for _, check := range checks {
		got := request(t, handler, check.method, check.path, []byte(`{}`))
		if got.Code != http.StatusForbidden || got.Body.String() != "tenant owner required\n" {
			t.Fatalf("member %s %s = %d %q", check.method, check.path, got.Code, got.Body.String())
		}
	}
}

func TestSharedChannelCatalogIdentifiesTenantPlatformAndAutomaticSources(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	tenantChannel := adminChannelPublic{
		ID: "tenant-image", Name: "Tenant Image", BaseURL: "https://tenant.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "tenant-model",
		SecretBindingID: "tenant-binding",
	}
	platformChannel := platformChannelPublic{
		ID: "platform-image", Name: "Platform Image", BaseURL: "https://platform.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "platform-model", PublishToAll: true,
		SecretBindingID: "platform-binding",
	}
	tenantRaw, _ := json.Marshal([]adminChannelPublic{tenantChannel})
	platformRaw, _ := json.Marshal([]platformChannelPublic{platformChannel})
	if err := backend.PutState(context.Background(), "tenant-a", adminChannelsStateKey, tenantRaw); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), store.DefaultTenantID, platformChannelsStateKey, platformRaw); err != nil {
		t.Fatal(err)
	}
	tenantSecrets, err := server.encryptAdminChannelSecrets("tenant-a", []adminChannelPublic{tenantChannel}, map[string]string{tenantChannel.ID: "tenant-secret"})
	if err != nil {
		t.Fatal(err)
	}
	platformSecrets, err := server.encryptAdminChannelSecrets(platformChannelSecretScope, []adminChannelPublic{platformChannel.adminChannel()}, map[string]string{platformChannel.ID: "platform-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), "tenant-a", adminChannelSecretsStateKey, tenantSecrets); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), store.DefaultTenantID, platformChannelSecretsStateKey, platformSecrets); err != nil {
		t.Fatal(err)
	}

	response := request(t, withActor(router, store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "member", Status: "active"}), http.MethodGet, "/api/shared-channels", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("catalog = %d %s", response.Code, response.Body.String())
	}
	var catalog []sharedChannelPublic
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	sources := make(map[string]string, len(catalog))
	for _, item := range catalog {
		sources[item.ID] = item.Source
	}
	if sources[sharedChannelAutoID] != "automatic" || sources[tenantChannel.ID] != "tenant" || sources[platformChannel.ID] != "platform" {
		t.Fatalf("catalog sources = %#v", sources)
	}
}

func TestDisabledTenantChannelShadowsMatchingPlatformChannel(t *testing.T) {
	server, backend, router := sharedChannelHandler(t)
	tenantChannel := adminChannelPublic{
		ID: "shared-image", Name: "Tenant opt-out", BaseURL: "https://tenant.example/v1", Protocol: "openai",
		Enabled: false, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "tenant-model",
	}
	platformChannel := platformChannelPublic{
		ID: "shared-image", Name: "Platform Image", BaseURL: "https://platform.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 60, DefaultImageModel: "platform-model",
		PublishToAll: true, SecretBindingID: "platform-binding",
	}
	tenantRaw, _ := json.Marshal([]adminChannelPublic{tenantChannel})
	platformRaw, _ := json.Marshal([]platformChannelPublic{platformChannel})
	if err := backend.PutState(t.Context(), "tenant-a", adminChannelsStateKey, tenantRaw); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(t.Context(), store.DefaultTenantID, platformChannelsStateKey, platformRaw); err != nil {
		t.Fatal(err)
	}
	platformSecrets, err := server.encryptAdminChannelSecrets(platformChannelSecretScope, []adminChannelPublic{platformChannel.adminChannel()}, map[string]string{platformChannel.ID: "platform-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(t.Context(), store.DefaultTenantID, platformChannelSecretsStateKey, platformSecrets); err != nil {
		t.Fatal(err)
	}
	actor := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "member", Status: "active"}
	response := request(t, withActor(router, actor), http.MethodGet, "/api/shared-channels", nil)
	if response.Code != http.StatusOK || containsJSONString(response.Body.Bytes(), platformChannel.ID) {
		t.Fatalf("disabled tenant shadow catalog = %d %s", response.Code, response.Body.String())
	}
	if _, _, err := server.resolveSharedChannel(t.Context(), actor.TenantID, platformChannel.ID); err == nil {
		t.Fatal("disabled tenant shadow unexpectedly fell through to the platform channel")
	}
}

func requestWithActorContext(actor store.AuthUser) *http.Request {
	request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://example.test/api/config", nil)
	return request.WithContext(context.WithValue(request.Context(), authUserKey, actor))
}
