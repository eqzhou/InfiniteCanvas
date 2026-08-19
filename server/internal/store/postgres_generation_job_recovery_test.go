package store

import (
	"errors"
	"testing"
	"time"
)

func TestFailGenerationJobIfUnchangedOnlyTransitionsMatchingRunningVersion(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	t.Cleanup(func() { _, _ = backend.pool.Exec(t.Context(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID) })
	now := time.Now().UTC().Truncate(time.Microsecond)
	job := GenerationJob{
		ID: "recover-cas-store", Kind: "image", Status: "running", Prompt: "recover",
		Parameters: []byte(`{"ownerClientId":"tab-a"}`), Result: []byte(`{}`),
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(t.Context(), tenantID, job); err != nil {
		t.Fatal(err)
	}

	recovered, err := backend.FailGenerationJobIfUnchanged(t.Context(), tenantID, job.ID, job.UpdatedAt, "interrupted")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "failed" || recovered.Error != "interrupted" || recovered.UpdatedAt == job.UpdatedAt {
		t.Fatalf("recovered job = %#v, want failed with a new version", recovered)
	}
	if _, err := backend.FailGenerationJobIfUnchanged(t.Context(), tenantID, job.ID, job.UpdatedAt, "stale"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale recovery error = %v, want ErrConflict", err)
	}

	completed := job
	completed.ID = "recover-cas-completed"
	completed.Status = "succeeded"
	if err := backend.CreateGenerationJob(t.Context(), tenantID, completed); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.FailGenerationJobIfUnchanged(t.Context(), tenantID, completed.ID, completed.UpdatedAt, "must not rewrite a completed job"); !errors.Is(err, ErrConflict) {
		t.Fatalf("completed recovery error = %v, want ErrConflict", err)
	}
}
