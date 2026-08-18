package api

import (
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
