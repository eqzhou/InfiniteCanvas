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

func TestSitePolicyModelCatalogIsAdminOnlyAndBounded(t *testing.T) {
	storeMem := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), storeMem)
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	updated := request(t, r, http.MethodPut, "/api/site-policy", []byte(`{
		"allowRegister": true,
		"allowCustomChannel": true,
		"allowCloudChannel": true,
		"availableModels": ["gpt-image-2", "gpt-image-2", "  ", "gpt-5.5"],
		"defaultImageModel": "gpt-image-2",
		"defaultTextModel": "gpt-5.5"
	}`))
	if updated.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", updated.Code, updated.Body.String())
	}
	var after SitePolicy
	if err := json.Unmarshal(updated.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	// Duplicates and blanks are dropped; order is preserved.
	if len(after.AvailableModels) != 2 || after.AvailableModels[0] != "gpt-image-2" || after.AvailableModels[1] != "gpt-5.5" {
		t.Fatalf("availableModels = %#v", after.AvailableModels)
	}
	if after.DefaultImageModel != "gpt-image-2" || after.DefaultTextModel != "gpt-5.5" {
		t.Fatalf("defaults = %+v", after)
	}

	// The catalog is readable by ordinary users so the picker can narrow itself.
	got := request(t, r, http.MethodGet, "/api/site-policy", nil)
	var readback SitePolicy
	if err := json.Unmarshal(got.Body.Bytes(), &readback); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if len(readback.AvailableModels) != 2 {
		t.Fatalf("readback = %#v", readback.AvailableModels)
	}

	// A default naming a model outside the allow list is rejected before storage.
	bad := request(t, r, http.MethodPut, "/api/site-policy", []byte(`{
		"allowRegister": true, "allowCustomChannel": true, "allowCloudChannel": true,
		"availableModels": ["only-this"],
		"defaultImageModel": "not-in-list"
	}`))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("out-of-list default status=%d body=%s", bad.Code, bad.Body.String())
	}

	// Oversized catalogs are rejected rather than silently truncated.
	models := make([]string, 0, maxSitePolicyModels+1)
	for i := range maxSitePolicyModels + 1 {
		models = append(models, "m"+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	encoded, _ := json.Marshal(map[string]any{
		"allowRegister": true, "allowCustomChannel": true, "allowCloudChannel": true,
		"availableModels": models,
	})
	tooMany := request(t, r, http.MethodPut, "/api/site-policy", encoded)
	if tooMany.Code != http.StatusBadRequest {
		t.Fatalf("oversized catalog status=%d", tooMany.Code)
	}
}

func TestSitePolicyBlocksRegistration(t *testing.T) {
	storeMem := newMemoryStore()
	// Pin the auth mode so the assertion is exact: accepting either 403 or 404
	// would pass even if the policy check were removed entirely.
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	srv := NewServerWithStore(t.TempDir(), storeMem)
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// Persist the policy directly: writing it over HTTP needs an admin session,
	// which is a different boundary from the one under test here.
	if err := srv.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: false, AllowCustomChannel: true, AllowCloudChannel: true,
	}); err != nil {
		t.Fatal(err)
	}

	blocked := request(t, r, http.MethodPost, "/api/auth/register", []byte(`{
		"email":"blocked@example.com",
		"password":"password123",
		"displayName":"Blocked"
	}`))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", blocked.Code, blocked.Body.String())
	}
	if !containsString(blocked.Body.String(), "registration disabled") {
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

func TestSitePolicyRejectsTrailingGarbageAfterTheBody(t *testing.T) {
	storeMem := newMemoryStore()
	srv := NewServerWithStore(t.TempDir(), storeMem)
	defer srv.Close()
	r := chi.NewRouter()
	MountServer(r, srv)

	// Decode alone stops at the first value, so a second document riding along
	// would be accepted and silently ignored.
	got := request(t, r, http.MethodPut, "/api/site-policy",
		[]byte(`{"allowRegister":true,"allowCustomChannel":true,"allowCloudChannel":true} {"allowRegister":false}`))
	if got.Code != http.StatusBadRequest {
		t.Fatalf("trailing garbage status=%d body=%s", got.Code, got.Body.String())
	}
}

func TestRetentionAndSitePolicyWritesRequireATenantAdmin(t *testing.T) {
	backend := newMemoryStore()
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	seedAdminUser(backend, member)
	handler := tenantAdminHandler(t, backend, member)

	// Both consoles govern tenant-wide behaviour, so an ordinary member must be
	// refused rather than merely hidden in the UI.
	for _, item := range []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodPut, "/api/site-policy", []byte(`{"allowRegister":false,"allowCustomChannel":true,"allowCloudChannel":true}`)},
		{http.MethodGet, "/api/ai-call-logs/retention", nil},
		{http.MethodPut, "/api/ai-call-logs/retention", []byte(`{"enabled":true,"retentionDays":30}`)},
	} {
		got := request(t, handler, item.method, item.path, item.body)
		if got.Code != http.StatusForbidden {
			t.Fatalf("%s %s = %d %q", item.method, item.path, got.Code, got.Body.String())
		}
	}
}

func TestServerGenerationRejectsModelsOutsideTheAllowList(t *testing.T) {
	server, _, handler := imageExecutionHandler(t, newScriptedImageExecutor())
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
		AvailableModels: []string{"gpt-image-1"},
	}); err != nil {
		t.Fatal(err)
	}

	// The picker narrows the list client-side, but the allow list is a tenant
	// governance rule: a request naming a model outside it must be refused by
	// the server rather than merely hidden in the UI.
	blocked := postImageJobWithModel(t, handler, "job-blocked", "draw", "banned-model")
	if blocked.code != http.StatusForbidden {
		t.Fatalf("out-of-list model = %d %s", blocked.code, blocked.body)
	}

	// A model inside the list is still accepted.
	allowed := postImageJobWithModel(t, handler, "job-allowed", "draw", "gpt-image-1")
	if allowed.code != http.StatusAccepted {
		t.Fatalf("allowed model = %d %s", allowed.code, allowed.body)
	}
}

func TestServerGenerationAllowsAnyModelWhenTheAllowListIsEmpty(t *testing.T) {
	server, _, handler := imageExecutionHandler(t, newScriptedImageExecutor())
	// An empty allow list means "no restriction"; enforcing it as "deny all"
	// would strand every tenant that never configured a catalog.
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
	}); err != nil {
		t.Fatal(err)
	}
	got := postImageJobWithModel(t, handler, "job-unrestricted", "draw", "anything-goes")
	if got.code != http.StatusAccepted {
		t.Fatalf("unrestricted model = %d %s", got.code, got.body)
	}
}

func postImageJobWithModel(t *testing.T, handler http.Handler, id, prompt, model string) *responseSnapshot {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id": id, "projectId": "board-1", "prompt": prompt,
		"providerId": "image-main", "model": model,
		"parameters": map[string]any{"size": "1024x1024", "quality": "high", "count": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/image", body)
	return &responseSnapshot{code: got.Code, body: append([]byte(nil), got.Body.Bytes()...)}
}

func TestWorkflowStepModelsAreCheckedAgainstTheAllowList(t *testing.T) {
	server, _, handler := imageExecutionHandler(t, newScriptedImageExecutor())
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
		AvailableModels: []string{"gpt-image-1"},
	}); err != nil {
		t.Fatal(err)
	}

	// Workflow steps carry their own model, so the run entry point is a second
	// way to reach a provider with a model the tenant disallowed.
	var template map[string]any
	if err := json.Unmarshal([]byte(validPersonalWorkflowTemplate), &template); err != nil {
		t.Fatal(err)
	}
	steps := template["steps"].([]any)
	steps[0].(map[string]any)["model"] = "banned-model"
	body, err := json.Marshal(map[string]any{
		"id": "workflow_banned", "projectId": "board-1", "templateSnapshot": template,
		"values": map[string]any{"subject": "一只纸雕老虎"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/workflow", body)
	if got.Code != http.StatusForbidden {
		t.Fatalf("banned workflow step model = %d %s", got.Code, got.Body.String())
	}
}

func TestMediaGenerationEntryPointsEnforceTheAllowList(t *testing.T) {
	backend := newMemoryStore()
	server, handler := mediaExecutionServer(t, backend, newScriptedVideoExecutor(nil), newScriptedAudioExecutor())
	t.Cleanup(server.Close)
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
		AvailableModels: []string{"seedance-2", "gpt-4o-mini-tts"},
	}); err != nil {
		t.Fatal(err)
	}

	video := []byte(`{"id":"job-video-banned","projectId":"board-1","prompt":"a moving tiger","providerId":"media-main","model":"banned-video","parameters":{"size":"1280x720","seconds":5,"ratio":"16:9","resolution":"720p","generateAudio":true,"watermark":false,"referenceStorageKeys":[]}}`)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/video", video); got.Code != http.StatusForbidden {
		t.Fatalf("banned video model = %d %s", got.Code, got.Body.String())
	}

	audio := []byte(`{"id":"job-audio-banned","projectId":"board-1","prompt":"hello tiger","providerId":"media-main","model":"banned-audio","parameters":{"voice":"alloy","format":"mp3"}}`)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/audio", audio); got.Code != http.StatusForbidden {
		t.Fatalf("banned audio model = %d %s", got.Code, got.Body.String())
	}

	// A model inside the list still reaches the queue.
	allowed := []byte(`{"id":"job-audio-ok","projectId":"board-1","prompt":"hello tiger","providerId":"media-main","model":"gpt-4o-mini-tts","parameters":{"voice":"alloy","format":"mp3"}}`)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/audio", allowed); got.Code != http.StatusAccepted {
		t.Fatalf("allowed audio model = %d %s", got.Code, got.Body.String())
	}
}
