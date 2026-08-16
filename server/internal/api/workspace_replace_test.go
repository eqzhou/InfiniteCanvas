package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func workspaceActorHandler(t *testing.T, backend *filmMemoryStore, actor store.AuthUser) http.Handler {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_FILM_MODE", "true")
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	return withActor(router, actor)
}

func TestWorkspaceReplaceIsOwnerOnlyAndExcludesPersonalSettings(t *testing.T) {
	project := json.RawMessage(`{"schemaVersion":3,"projectKind":"canvas","id":"workspace-config","title":"Workspace config","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	owner := store.AuthUser{ID: "owner-1", TenantID: member.TenantID, Role: "owner", Status: "active"}

	t.Run("member rejected", func(t *testing.T) {
		backend := newFilmMemoryStore()
		current := []byte(`{"theme":"old"}`)
		if err := backend.PutState(t.Context(), member.TenantID, "config", current); err != nil {
			t.Fatal(err)
		}
		handler := workspaceActorHandler(t, backend, member)
		version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
		input := completeWorkspaceRequest(version, []json.RawMessage{project}, []any{})
		body, _ := json.Marshal(input)
		response := request(t, handler, http.MethodPut, "/api/projects", body)
		if response.Code != http.StatusForbidden {
			t.Fatalf("member workspace replace = %d %s", response.Code, response.Body.String())
		}
		stored, err := backend.GetState(t.Context(), member.TenantID, "config")
		if err != nil || !jsonEqual(stored, current) {
			t.Fatalf("member changed tenant config: %s, %v", stored, err)
		}
	})

	t.Run("owner restores tenant data without replacing personal settings", func(t *testing.T) {
		backend := newFilmMemoryStore()
		configKey := userConfigStateKeyPrefix + owner.ID
		secretKey := userSecretStateKeyPrefix + owner.ID
		templateKey := workflowTemplateUserStateKeyPrefix + owner.ID
		for key, value := range map[string][]byte{
			configKey: []byte(`{"theme":"old"}`), secretKey: []byte(`{"nonce":"existing","ciphertext":"existing"}`),
			templateKey: []byte(`{"version":1,"templates":[]}`),
		} {
			if err := backend.PutState(t.Context(), owner.TenantID, key, value); err != nil {
				t.Fatal(err)
			}
		}
		handler := workspaceActorHandler(t, backend, owner)
		version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
		input := completeWorkspaceRequest(version, []json.RawMessage{project}, []any{})
		// Legacy clients may still send these fields. They are intentionally
		// outside the tenant workspace transaction and must be ignored.
		input["config"] = map[string]any{"theme": "new"}
		input["workflowTemplates"] = map[string]any{"version": 1, "templates": []any{map[string]any{"id": "untrusted"}}}
		body, _ := json.Marshal(input)
		response := request(t, handler, http.MethodPut, "/api/projects", body)
		if response.Code != http.StatusOK {
			t.Fatalf("owner workspace replace = %d %s", response.Code, response.Body.String())
		}
		for key, expected := range map[string]string{
			configKey: `{"theme":"old"}`, secretKey: `{"nonce":"existing","ciphertext":"existing"}`,
			templateKey: `{"version":1,"templates":[]}`,
		} {
			stored, err := backend.GetState(t.Context(), owner.TenantID, key)
			if err != nil || !jsonEqual(stored, []byte(expected)) {
				t.Fatalf("personal state %s changed: %s, %v", key, stored, err)
			}
		}
	})
}

func TestWorkspaceReplaceLeavesLegacyTenantSettingsUntouched(t *testing.T) {
	backend := newFilmMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	for key, value := range map[string][]byte{
		"config": []byte(`{"theme":"old"}`), secretStateKey: []byte(`{"nonce":"existing","ciphertext":"existing"}`),
		workflowTemplateStateKey: []byte(`{"version":1,"templates":[]}`),
	} {
		if err := backend.PutState(t.Context(), owner.TenantID, key, value); err != nil {
			t.Fatal(err)
		}
	}
	handler := workspaceActorHandler(t, backend, owner)
	version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
	body, _ := json.Marshal(completeWorkspaceRequest(version, []json.RawMessage{}, []any{}))
	response := request(t, handler, http.MethodPut, "/api/projects", body)
	if response.Code != http.StatusOK {
		t.Fatalf("workspace replacement = %d %s", response.Code, response.Body.String())
	}
	for key, expected := range map[string]string{
		"config": `{"theme":"old"}`, secretStateKey: `{"nonce":"existing","ciphertext":"existing"}`,
		workflowTemplateStateKey: `{"version":1,"templates":[]}`,
	} {
		stored, err := backend.GetState(t.Context(), owner.TenantID, key)
		if err != nil || !jsonEqual(stored, []byte(expected)) {
			t.Fatalf("legacy state %s changed: %s, %v", key, stored, err)
		}
	}
}

func TestWorkspaceRestoreBindsImportedGenerationHistoryToOwner(t *testing.T) {
	backend := newFilmMemoryStore()
	owner := store.AuthUser{ID: "owner-history", TenantID: "tenant-history", Role: "owner", Status: "active"}
	handler := workspaceActorHandler(t, backend, owner)
	version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
	job := store.GenerationJob{
		ID: "restored-history", Kind: "image", Status: "failed", Prompt: "restored",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`), Error: "failed",
		CreatedAt: "2026-08-09T00:00:00Z", UpdatedAt: "2026-08-09T00:00:01Z",
	}
	input := completeWorkspaceRequest(version, []json.RawMessage{}, []any{})
	input["generationJobs"] = []store.GenerationJob{job}
	body, _ := json.Marshal(input)
	response := request(t, handler, http.MethodPut, "/api/projects", body)
	if response.Code != http.StatusOK {
		t.Fatalf("workspace restore = %d %s", response.Code, response.Body.String())
	}
	stored, err := backend.GetGenerationJob(t.Context(), owner.TenantID, job.ID)
	if err != nil || stored.UserID != owner.ID {
		t.Fatalf("restored job owner = %q err=%v", stored.UserID, err)
	}
}

func TestWorkspaceReplaceIsAtomicCASBoundAndRollbackResurrectsTombstones(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	for key, value := range map[string][]byte{
		"assets": []byte(`[{"id":"old-asset"}]`), "config": []byte(`{"theme":"old"}`),
		"prompts": []byte(`[{"id":"old-prompt"}]`), workflowTemplateStateKey: []byte(`{"version":1,"templates":[]}`),
	} {
		if err := backend.PutState(t.Context(), store.DefaultTenantID, key, value); err != nil {
			t.Fatal(err)
		}
	}
	oldJob := store.GenerationJob{ID: "old-job", ProjectID: "film-api", Kind: "image", Status: "succeeded", Prompt: "old", Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{"storageKey":"old-result"}`), CreatedAt: "2026-08-08T00:00:00Z", UpdatedAt: "2026-08-08T00:00:01Z"}
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, oldJob); err != nil {
		t.Fatal(err)
	}
	listed := request(t, handler, http.MethodGet, "/api/projects", nil)
	version := listed.Header().Get("ETag")
	if listed.Code != http.StatusOK || version == "" {
		t.Fatalf("workspace version missing: %d headers=%v body=%s", listed.Code, listed.Header(), listed.Body.String())
	}
	project := json.RawMessage(`{"schemaVersion":3,"projectKind":"canvas","id":"replacement","title":"Replacement","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	newJob := store.GenerationJob{ID: "new-job", ProjectID: "replacement", Kind: "video", Status: "failed", Prompt: "new", Parameters: json.RawMessage(`{"quality":"high"}`), Result: json.RawMessage(`{"partial":true}`), Error: "failed", CreatedAt: "2026-08-09T00:00:00Z", UpdatedAt: "2026-08-09T00:00:01Z"}
	body, _ := json.Marshal(map[string]any{
		"expectedVersion": version, "projects": []json.RawMessage{project}, "films": []any{},
		"generationJobs": []store.GenerationJob{newJob}, "assets": []any{}, "config": map[string]any{"theme": "new"},
		"prompts": []any{}, "workflowTemplates": map[string]any{"version": 1, "templates": []any{}},
	})
	replaced := request(t, handler, http.MethodPut, "/api/projects", body)
	if replaced.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", replaced.Code, replaced.Body.String())
	}
	var replacement struct {
		Data struct {
			Version      string `json:"version"`
			RestoreToken string `json:"restoreToken"`
		} `json:"data"`
	}
	if json.Unmarshal(replaced.Body.Bytes(), &replacement) != nil || replacement.Data.Version == "" || replacement.Data.RestoreToken == "" {
		t.Fatalf("replace response contract: %s", replaced.Body.String())
	}
	if response := request(t, handler, http.MethodGet, "/api/projects/film-api", nil); response.Code != http.StatusNotFound {
		t.Fatalf("old project survived replacement: %d", response.Code)
	}
	rollbackBody, _ := json.Marshal(map[string]any{
		"expectedVersion": replacement.Data.Version, "restoreToken": replacement.Data.RestoreToken,
	})
	rolledBack := request(t, handler, http.MethodPost, "/api/projects/rollback", rollbackBody)
	if rolledBack.Code != http.StatusOK {
		t.Fatalf("rollback: %d %s", rolledBack.Code, rolledBack.Body.String())
	}
	if response := request(t, handler, http.MethodGet, "/api/projects/film-api", nil); response.Code != http.StatusOK {
		t.Fatalf("rollback could not resurrect tombstoned project: %d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil); response.Code != http.StatusOK {
		t.Fatalf("rollback did not restore film aggregate: %d %s", response.Code, response.Body.String())
	}
	restoredJob, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, "old-job")
	if err != nil || restoredJob.Status != oldJob.Status || string(restoredJob.Result) != string(oldJob.Result) {
		t.Fatalf("rollback did not restore generation job status/result: %#v %v", restoredJob, err)
	}
	if _, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, "new-job"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rollback retained replacement generation job: %v", err)
	}
	for key, expected := range map[string]string{"assets": `[{"id":"old-asset"}]`, "config": `{"theme":"old"}`, "prompts": `[{"id":"old-prompt"}]`, workflowTemplateStateKey: `{"version":1,"templates":[]}`} {
		value, err := backend.GetState(t.Context(), store.DefaultTenantID, key)
		if err != nil || !jsonEqual(value, []byte(expected)) {
			t.Fatalf("rollback state %s = %s, %v", key, value, err)
		}
	}
}

func completeWorkspaceRequest(version string, projects []json.RawMessage, films any) map[string]any {
	return map[string]any{
		"expectedVersion": version, "projects": projects, "films": films, "generationJobs": []any{},
		"assets": []any{}, "prompts": []any{},
	}
}

func TestSingleProjectAggregateReplacePreservesOtherServerProjects(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	ownedJob := store.GenerationJob{
		ID: "other-user-history", UserID: "other-user", Kind: "image", Status: "succeeded", Prompt: "private",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: "2026-08-08T00:00:00Z", UpdatedAt: "2026-08-08T00:00:01Z",
	}
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, ownedJob); err != nil {
		t.Fatal(err)
	}
	other := json.RawMessage(`{"schemaVersion":3,"projectKind":"canvas","id":"untouched","title":"Untouched","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/untouched", other); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
	target := json.RawMessage(`{"schemaVersion":3,"projectKind":"canvas","id":"imported","title":"Imported","createdAt":"2026-08-09T00:00:00Z","updatedAt":"2026-08-09T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	body, _ := json.Marshal(map[string]any{"expectedVersion": version, "project": target})
	response := request(t, handler, http.MethodPost, "/api/projects/import", body)
	if response.Code != http.StatusOK {
		t.Fatalf("single project replace: %d %s", response.Code, response.Body.String())
	}
	if untouched := request(t, handler, http.MethodGet, "/api/projects/untouched", nil); untouched.Code != http.StatusOK {
		t.Fatalf("single project import overwrote another project: %d", untouched.Code)
	}
	storedJob, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, ownedJob.ID)
	if err != nil || storedJob.UserID != ownedJob.UserID || storedJob.Prompt != ownedJob.Prompt {
		t.Fatalf("single project import rewrote generation history: %#v %v", storedJob, err)
	}
	var payload struct {
		Data struct {
			MigratedStorageKeys []string `json:"migratedStorageKeys"`
		} `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Data.MigratedStorageKeys == nil {
		t.Fatalf("project import migratedStorageKeys contract: %s", response.Body.String())
	}
}

func TestWorkspaceReplaceRequiresEveryTransactionalMetadataField(t *testing.T) {
	_, handler := filmAPIHandler(t)
	version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
	for _, field := range []string{"projects", "films", "generationJobs", "assets", "prompts"} {
		t.Run(field, func(t *testing.T) {
			input := completeWorkspaceRequest(version, []json.RawMessage{}, []any{})
			delete(input, field)
			body, _ := json.Marshal(input)
			response := request(t, handler, http.MethodPut, "/api/projects", body)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("missing %s accepted: %d %s", field, response.Code, response.Body.String())
			}
		})
	}
}

func TestWorkspaceFilmInputUsesStrictMetadataForTimelineOnlyMedia(t *testing.T) {
	_, handler := filmAPIHandler(t)
	media := []byte("workspace-timeline-only")
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:workspace-timeline", media, map[string]string{"Content-Type": "audio/mpeg"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	project := json.RawMessage(`{"schemaVersion":3,"projectKind":"film","id":"film-api","title":"Film API","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-09T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	document := newFilmDocument("film-api")
	document.Timeline.Tracks[2].Clips = []filmTimelineClip{{ID: "music-only", Revision: 1, Source: "upload:workspace-timeline", Order: 0, Start: 0, End: 1, Volume: 1, Transition: "cut"}}
	metadata := []filmRestoreMedia{{StorageKey: "upload:workspace-timeline", MIMEType: "audio/mpeg", Bytes: int64(len(media)), SHA256: sha256Hex(media), ObjectVersion: blobContentVersion("audio/mpeg", media), Provenance: []filmRestoreMediaProvenance{{Kind: "timeline", EntityID: "music-only", Field: "source"}}}}
	version := strings.Trim(request(t, handler, http.MethodGet, "/api/projects", nil).Header().Get("ETag"), `"`)
	body, _ := json.Marshal(completeWorkspaceRequest(version, []json.RawMessage{project}, []any{map[string]any{"revision": 1, "document": document, "media": metadata}}))
	response := request(t, handler, http.MethodPut, "/api/projects", body)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "upload:workspace-timeline") {
		t.Fatalf("workspace strict media restore: %d %s", response.Code, response.Body.String())
	}
	stored := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	if source := stored.Timeline.Tracks[2].Clips[0].Source; !strings.HasPrefix(source, "film:media:film-api:restore:") {
		t.Fatalf("timeline-only source was not rewritten: %q", source)
	}
}

func TestWorkspaceReplaceConcurrentCASAndRestoreTokensAreTenantIsolated(t *testing.T) {
	backend := newFilmMemoryStore()
	project := func(id string) json.RawMessage {
		return json.RawMessage(`{"id":"` + id + `","title":"` + id + `","updatedAt":"2026-08-08T00:00:00Z"}`)
	}
	for _, tenantID := range []string{"tenant-a", "tenant-b"} {
		if err := backend.PutProject(t.Context(), tenantID, "original", project("original")); err != nil {
			t.Fatal(err)
		}
	}
	version, err := backend.WorkspaceVersion(t.Context(), "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	snapshots := []store.WorkspaceSnapshot{
		{Projects: []store.WorkspaceProject{{ID: "winner-a", Document: project("winner-a")}}},
		{Projects: []store.WorkspaceProject{{ID: "winner-b", Document: project("winner-b")}}},
	}
	errorsByAttempt := make([]error, 2)
	var wait sync.WaitGroup
	for index := range snapshots {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, errorsByAttempt[index] = backend.ReplaceWorkspace(context.Background(), "tenant-a", version, strings.Repeat(string(rune('a'+index)), 64), time.Now().Add(time.Hour), snapshots[index], nil)
		}(index)
	}
	wait.Wait()
	successes, conflicts := 0, 0
	for _, err := range errorsByAttempt {
		if err == nil {
			successes++
		} else if errors.Is(err, store.ErrConflict) {
			conflicts++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent replacements were not serialized: %#v", errorsByAttempt)
	}
	if _, err := backend.RollbackWorkspace(t.Context(), "tenant-b", version, strings.Repeat("a", 64), time.Now()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant workspace token accepted: %v", err)
	}
	if _, err := backend.GetProject(t.Context(), "tenant-b", "original"); err != nil {
		t.Fatalf("cross-tenant attempt mutated tenant-b: %v", err)
	}
}

func TestWorkspaceReplaceRejectsStaleVersionWithoutPartialMutation(t *testing.T) {
	_, handler := filmAPIHandler(t)
	body, _ := json.Marshal(completeWorkspaceRequest("w1-"+strings.Repeat("0", 64), []json.RawMessage{}, []any{}))
	response := request(t, handler, http.MethodPut, "/api/projects", body)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale replacement: %d %s", response.Code, response.Body.String())
	}
	if current := request(t, handler, http.MethodGet, "/api/projects/film-api", nil); current.Code != http.StatusOK {
		t.Fatalf("stale replacement partially mutated workspace: %d", current.Code)
	}
}
