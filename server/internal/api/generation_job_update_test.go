package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestOwnerCannotRewriteAnotherUsersClientGenerationJob(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	backend := newMemoryStore()
	member := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "member", Status: "active"}
	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	job := store.GenerationJob{
		ID: "job-member", UserID: member.ID, Kind: "image", Status: "succeeded",
		Prompt: "original", Parameters: []byte(`{}`), Result: []byte(`{"ok":true}`),
		CreatedAt: "2026-08-01T00:00:00Z", UpdatedAt: "2026-08-01T00:00:00Z",
	}
	if err := backend.CreateGenerationJob(t.Context(), member.TenantID, job); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, NewServerWithStore(t.TempDir(), backend))
	got := request(t, withActor(router, owner), http.MethodPut, "/api/generation-jobs/job-member", []byte(`{
		"id":"job-member","kind":"image","status":"succeeded","prompt":"forged","parameters":{},"result":{},"createdAt":"2026-08-01T00:00:00Z","updatedAt":"2026-08-01T00:00:00Z"
	}`))
	if got.Code != http.StatusNotFound {
		t.Fatalf("owner rewrite = %d %s", got.Code, got.Body.String())
	}
	stored, err := backend.GetGenerationJob(t.Context(), member.TenantID, job.ID)
	if err != nil || stored.Prompt != "original" {
		t.Fatalf("member job was rewritten: %#v err=%v", stored, err)
	}
}

func TestRecoverGenerationJobUsesCompareAndSwapForRunningVersion(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	backend := newMemoryStore()
	job := store.GenerationJob{
		ID: "job-recover-cas", Kind: "image", Status: "running", Prompt: "original",
		Parameters: []byte(`{"ownerClientId":"tab-a"}`), Result: []byte(`{}`),
		CreatedAt: "2026-08-01T00:00:00Z", UpdatedAt: "2026-08-01T00:00:01Z",
	}
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, NewServerWithStore(t.TempDir(), backend))

	first := request(t, router, http.MethodPost, "/api/generation-jobs/job-recover-cas/recover", []byte(`{
		"expectedUpdatedAt":"2026-08-01T00:00:01Z",
		"error":"页面刷新后浏览器任务已中断"
	}`))
	if first.Code != http.StatusOK {
		t.Fatalf("first recovery = %d %s", first.Code, first.Body.String())
	}
	var recovered store.GenerationJob
	if err := json.Unmarshal(first.Body.Bytes(), &recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "failed" || recovered.Error == "" || recovered.UpdatedAt == job.UpdatedAt {
		t.Fatalf("recovered job = %#v, want failed with a new version", recovered)
	}

	stale := request(t, router, http.MethodPost, "/api/generation-jobs/job-recover-cas/recover", []byte(`{
		"expectedUpdatedAt":"2026-08-01T00:00:01Z",
		"error":"stale recovery must not overwrite"
	}`))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale recovery = %d %s, want conflict", stale.Code, stale.Body.String())
	}
	stored, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Error != recovered.Error || stored.UpdatedAt != recovered.UpdatedAt {
		t.Fatalf("stale recovery changed job: stored=%#v recovered=%#v", stored, recovered)
	}

	completed := job
	completed.ID = "job-recover-completed"
	completed.Status = "succeeded"
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, completed); err != nil {
		t.Fatal(err)
	}
	notRunning := request(t, router, http.MethodPost, "/api/generation-jobs/job-recover-completed/recover", []byte(`{
		"expectedUpdatedAt":"2026-08-01T00:00:01Z",
		"error":"must not rewrite a completed job"
	}`))
	if notRunning.Code != http.StatusConflict {
		t.Fatalf("completed recovery = %d %s, want conflict", notRunning.Code, notRunning.Body.String())
	}
}
