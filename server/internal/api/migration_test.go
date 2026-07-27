package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func migrationRequest(t *testing.T, handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func withMigrationActor(handler http.Handler, actor store.AuthUser) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authUserKey, actor)))
	})
}

func TestMigrationRequiresProcessTokenOrAuthenticatedUser(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	handler := chi.NewRouter()
	MountServer(handler, server)
	body := []byte(`{"resources":[]}`)

	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	requests := []struct {
		method, path string
		body         []byte
		headers      map[string]string
	}{
		{http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json"}},
		{http.MethodPut, "/api/migration/projects/board-1", migrationProject("board-1", "Local", "2026-07-03T00:00:00Z"), map[string]string{"If-None-Match": "*"}},
		{http.MethodPut, "/api/migration/state/assets", []byte(`[]`), map[string]string{"If-None-Match": "*"}},
		{http.MethodPut, "/api/migration/secrets/config", []byte(`{}`), map[string]string{"If-None-Match": "*"}},
		{http.MethodPut, "/api/migration/generation-history", []byte(`[]`), map[string]string{"If-None-Match": "*"}},
		{http.MethodPut, "/api/migration/blobs/image%3Atest", []byte("png"), map[string]string{"If-None-Match": "*", "Content-Type": "image/png"}},
	}
	for _, request := range requests {
		if got := migrationRequest(t, handler, request.method, request.path, request.body, request.headers); got.Code != http.StatusUnauthorized {
			t.Fatalf("auth off anonymous %s = %d: %s", request.path, got.Code, got.Body.String())
		}
	}
	if got := migrationRequest(t, handler, http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer test-token"}); got.Code != http.StatusOK {
		t.Fatalf("auth off token migration = %d: %s", got.Code, got.Body.String())
	}

	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	if got := migrationRequest(t, handler, http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer test-token"}); got.Code != http.StatusUnauthorized {
		t.Fatalf("optional token-only migration = %d: %s", got.Code, got.Body.String())
	}
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	if got := migrationRequest(t, withMigrationActor(handler, member), http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json"}); got.Code != http.StatusOK {
		t.Fatalf("optional authenticated migration = %d: %s", got.Code, got.Body.String())
	}
}

func TestMigrationSecretResourcesRequireTenantAdmin(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	handler := chi.NewRouter()
	MountServer(handler, server)
	body := []byte(`{"resources":[{"kind":"secret","id":"config"}]}`)
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	// Tenant-wide secret migration remains admin-only.
	if got := migrationRequest(t, withMigrationActor(handler, member), http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json"}); got.Code != http.StatusForbidden {
		t.Fatalf("member secret preflight = %d: %s", got.Code, got.Body.String())
	}
	if got := migrationRequest(t, withMigrationActor(handler, member), http.MethodPut, "/api/migration/secrets/config", []byte(`{"apiKeys":{},"webdavPass":""}`), map[string]string{"Content-Type": "application/json", "If-None-Match": "*"}); got.Code != http.StatusForbidden {
		t.Fatalf("member migration put secrets = %d: %s", got.Code, got.Body.String())
	}
	// Personal secret bags are writable by members (separate from the tenant bag).
	if got := migrationRequest(t, withMigrationActor(handler, member), http.MethodPut, "/api/secrets/config", []byte(`{"apiKeys":{"direct":{"image":"sk-member"}},"webdavPass":""}`), map[string]string{"Content-Type": "application/json"}); got.Code != http.StatusNoContent {
		t.Fatalf("member put personal secrets = %d: %s", got.Code, got.Body.String())
	}
	if got := migrationRequest(t, withMigrationActor(handler, member), http.MethodGet, "/api/secrets/config", nil, map[string]string{}); got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte("sk-member")) {
		t.Fatalf("member get personal secrets = %d: %s", got.Code, got.Body.String())
	}
	admin := store.AuthUser{ID: "admin-1", TenantID: "tenant-a", Role: "admin", Status: "active"}
	if got := migrationRequest(t, withMigrationActor(handler, admin), http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json"}); got.Code != http.StatusOK {
		t.Fatalf("admin secret preflight = %d: %s", got.Code, got.Body.String())
	}
}

func migrationProject(id, title, updated string) []byte {
	return []byte(`{"schemaVersion":2,"id":"` + id + `","title":"` + title + `","createdAt":"2026-07-01T00:00:00Z","updatedAt":"` + updated + `","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
}

func TestMigrationConditionalProjectAndStatePreserveConcurrentWrites(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	backend := newMemoryStore()
	handler := chi.NewRouter()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	MountServer(handler, server)

	initial := migrationProject("board-1", "Initial", "2026-07-01T00:00:00Z")
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", initial); got.Code != http.StatusNoContent {
		t.Fatalf("seed project = %d: %s", got.Code, got.Body.String())
	}
	versions := migrationRequest(t, handler, http.MethodPost, "/api/migration/versions", []byte(`{"resources":[{"kind":"project","id":"board-1"},{"kind":"state","id":"assets"}]}`), map[string]string{"Content-Type": "application/json", "Authorization": "Bearer test-token"})
	if versions.Code != http.StatusOK {
		t.Fatalf("versions = %d: %s", versions.Code, versions.Body.String())
	}
	var versionBody struct {
		Resources []struct {
			Kind, ID, Version string
			Exists            bool
		} `json:"resources"`
	}
	if err := json.Unmarshal(versions.Body.Bytes(), &versionBody); err != nil {
		t.Fatal(err)
	}
	if len(versionBody.Resources) != 2 || !versionBody.Resources[0].Exists || versionBody.Resources[1].Exists {
		t.Fatalf("unexpected versions: %+v", versionBody.Resources)
	}
	projectVersion := versionBody.Resources[0].Version

	concurrent := migrationProject("board-1", "Concurrent", "2026-07-02T00:00:00Z")
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", concurrent); got.Code != http.StatusNoContent {
		t.Fatalf("concurrent project = %d", got.Code)
	}
	stale := migrationRequest(t, handler, http.MethodPut, "/api/migration/projects/board-1", migrationProject("board-1", "Local", "2026-07-03T00:00:00Z"), map[string]string{"If-Match": `"` + projectVersion + `"`, "Authorization": "Bearer test-token"})
	if stale.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale project = %d: %s", stale.Code, stale.Body.String())
	}
	stored := request(t, handler, http.MethodGet, "/api/projects/board-1", nil)
	if !bytes.Contains(stored.Body.Bytes(), []byte("Concurrent")) {
		t.Fatalf("concurrent project overwritten: %s", stored.Body.String())
	}

	if got := request(t, handler, http.MethodPut, "/api/state/assets", []byte(`[{"id":"remote"}]`)); got.Code != http.StatusNoContent {
		t.Fatalf("concurrent state = %d", got.Code)
	}
	staleState := migrationRequest(t, handler, http.MethodPut, "/api/migration/state/assets", []byte(`[{"id":"local"}]`), map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"})
	if staleState.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale state = %d: %s", staleState.Code, staleState.Body.String())
	}
	state := request(t, handler, http.MethodGet, "/api/state/assets", nil)
	if !bytes.Contains(state.Body.Bytes(), []byte("remote")) {
		t.Fatalf("concurrent state overwritten: %s", state.Body.String())
	}
}

func TestMigrationConditionalSecretsHistoryAndBlobRejectStalePreflight(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	handler := chi.NewRouter()
	MountServer(handler, server)

	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/secrets/config", []byte(`{"apiKeys":{},"webdavPass":"remote"}`), map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusNoContent {
		t.Fatalf("secret create = %d: %s", got.Code, got.Body.String())
	}
	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/secrets/config", []byte(`{"apiKeys":{},"webdavPass":"local"}`), map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusPreconditionFailed {
		t.Fatalf("secret stale = %d: %s", got.Code, got.Body.String())
	}

	activeServerJob := []byte(`[{"id":"job-active","kind":"image","status":"queued","prompt":"bypass","providerId":"provider","parameters":{"executor":"server"},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}]`)
	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/generation-history", activeServerJob, map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusBadRequest {
		t.Fatalf("active server history accepted = %d: %s", got.Code, got.Body.String())
	}
	duplicateJobs := []byte(`[{"id":"job-duplicate","kind":"image","status":"succeeded","prompt":"one","providerId":"provider","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"},{"id":"job-duplicate","kind":"image","status":"succeeded","prompt":"two","providerId":"provider","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}]`)
	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/generation-history", duplicateJobs, map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusBadRequest {
		t.Fatalf("duplicate history accepted = %d: %s", got.Code, got.Body.String())
	}

	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/generation-history", []byte(`[]`), map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusNoContent {
		t.Fatalf("history create = %d: %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(`{"id":"job-race","kind":"image","status":"succeeded","prompt":"remote","providerId":"p","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}`)); got.Code != http.StatusCreated {
		t.Fatalf("history race = %d: %s", got.Code, got.Body.String())
	}
	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/generation-history", []byte(`[]`), map[string]string{"If-None-Match": "*", "Authorization": "Bearer test-token"}); got.Code != http.StatusPreconditionFailed {
		t.Fatalf("history stale = %d: %s", got.Code, got.Body.String())
	}

	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/blobs/image%3Arace", []byte("remote"), map[string]string{"If-None-Match": "*", "Content-Type": "image/png", "Authorization": "Bearer test-token"}); got.Code != http.StatusNoContent {
		t.Fatalf("blob create = %d: %s", got.Code, got.Body.String())
	}
	if got := migrationRequest(t, handler, http.MethodPut, "/api/migration/blobs/image%3Arace", []byte("local"), map[string]string{"If-None-Match": "*", "Content-Type": "image/png", "Authorization": "Bearer test-token"}); got.Code != http.StatusPreconditionFailed {
		t.Fatalf("blob stale = %d: %s", got.Code, got.Body.String())
	}
	blob := request(t, handler, http.MethodGet, "/api/blobs/image%3Arace", nil)
	if blob.Body.String() != "remote" {
		t.Fatalf("blob overwritten: %q", blob.Body.String())
	}
}

func TestMigrationVersionsRejectsExcessiveAndDuplicateResources(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	handler := chi.NewRouter()
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.SetProcessToken("test-token")
	MountServer(handler, server)
	resources := make([]migrationResourceRequest, 101)
	for index := range resources {
		resources[index] = migrationResourceRequest{Kind: "project", ID: "p" + strconv.Itoa(index)}
	}
	body, _ := json.Marshal(map[string]any{"resources": resources})
	if got := migrationRequest(t, handler, http.MethodPost, "/api/migration/versions", body, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer test-token"}); got.Code != http.StatusBadRequest {
		t.Fatalf("excessive = %d", got.Code)
	}
	duplicate := []byte(`{"resources":[{"kind":"state","id":"assets"},{"kind":"state","id":"assets"}]}`)
	if got := migrationRequest(t, handler, http.MethodPost, "/api/migration/versions", duplicate, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer test-token"}); got.Code != http.StatusBadRequest {
		t.Fatalf("duplicate = %d", got.Code)
	}
}
