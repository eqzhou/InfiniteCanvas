package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func openTombstoneTestStore(t *testing.T) *PostgresStore {
	t.Helper()
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL tombstone tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL tombstone tests")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	backend, err := Open(ctx, databaseURL, "")
	if err != nil {
		t.Fatalf("open PostgreSQL test store: %v", err)
	}
	t.Cleanup(backend.Close)
	return backend
}

func seedTombstoneTenant(t *testing.T, backend *PostgresStore) string {
	t.Helper()
	tenantID := fmt.Sprintf("tombstone-%d", time.Now().UnixNano())
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_tenants (id,name) VALUES ($1,$2)
ON CONFLICT (id) DO NOTHING`, tenantID, tenantID); err != nil {
		t.Fatal(err)
	}
	return tenantID
}

func tombstoneProjectDocument(t *testing.T, title string, updatedAt time.Time) []byte {
	t.Helper()
	document, err := json.Marshal(map[string]any{
		"title":     title,
		"updatedAt": updatedAt.UTC().Format(time.RFC3339Nano),
		"nodes":     []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

// A tab that still holds a pre-delete document must not be able to autosave the
// project back into existence. Upstream keeps a tombstone for exactly this reason.
func TestDeletedProjectResistsStaleAutosave(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	const projectID = "proj-stale-autosave"
	now := time.Now().UTC()

	if err := backend.PutProject(ctx, tenantID, projectID, tombstoneProjectDocument(t, "原始画布", now)); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := backend.DeleteProject(ctx, tenantID, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}

	staleWrite := backend.PutProject(ctx, tenantID, projectID,
		tombstoneProjectDocument(t, "陈旧标签页写回", now.Add(time.Second)))
	if !errors.Is(staleWrite, ErrGone) {
		t.Fatalf("stale autosave should be refused with ErrGone, got %v", staleWrite)
	}

	if _, err := backend.GetProject(ctx, tenantID, projectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted project must stay unreadable, got %v", err)
	}
	summaries, err := backend.ListProjects(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	for _, summary := range summaries {
		if summary.ID == projectID {
			t.Fatalf("deleted project reappeared in listing: %+v", summary)
		}
	}
}

// The compare-and-swap path also creates rows when expected is nil, so it needs
// the same tombstone guard as the plain upsert.
func TestDeletedProjectResistsCompareAndSwapRecreate(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	const projectID = "proj-stale-cas"
	now := time.Now().UTC()

	if err := backend.PutProject(ctx, tenantID, projectID, tombstoneProjectDocument(t, "原始画布", now)); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := backend.DeleteProject(ctx, tenantID, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}

	err := backend.CompareAndSwapProject(ctx, tenantID, projectID, nil,
		tombstoneProjectDocument(t, "CAS 复活", now.Add(time.Second)))
	if !errors.Is(err, ErrGone) && !errors.Is(err, ErrConflict) {
		t.Fatalf("CAS create over a tombstone should fail, got %v", err)
	}
	if _, err := backend.GetProject(ctx, tenantID, projectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted project must stay unreadable, got %v", err)
	}
}

// Deleting a generation job must drop the generated payload, not merely hide the row.
func TestDeletedGenerationJobDropsResultPayload(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	const secret = "https://example.invalid/generated-secret.png"
	job := GenerationJob{
		ID:         "job-tombstone",
		Kind:       "image",
		Status:     "succeeded",
		Prompt:     "a cat",
		Parameters: json.RawMessage(`{"size":"1024x1024"}`),
		Result:     json.RawMessage(fmt.Sprintf(`{"images":[{"url":%q}]}`, secret)),
		CreatedAt:  now.Format(time.RFC3339Nano),
		UpdatedAt:  now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if err := backend.DeleteGenerationJob(ctx, tenantID, job.ID); err != nil {
		t.Fatalf("delete generation job: %v", err)
	}

	stored, err := backend.GetGenerationJob(ctx, tenantID, job.ID)
	if err != nil {
		t.Fatalf("read tombstoned job: %v", err)
	}
	if stored.Status != "deleted" {
		t.Fatalf("expected deleted status, got %q", stored.Status)
	}
	if strings.Contains(string(stored.Result), secret) {
		t.Fatalf("deleted job still carries its result payload: %s", stored.Result)
	}
}

// Bulk delete uses its own SQL statement and must clear payloads the same way.
func TestBulkDeletedGenerationJobsDropResultPayload(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	const secret = "https://example.invalid/bulk-secret.png"
	job := GenerationJob{
		ID:         "job-bulk-tombstone",
		Kind:       "image",
		Status:     "succeeded",
		Prompt:     "a dog",
		Parameters: json.RawMessage(`{}`),
		Result:     json.RawMessage(fmt.Sprintf(`{"images":[{"url":%q}]}`, secret)),
		CreatedAt:  now.Format(time.RFC3339Nano),
		UpdatedAt:  now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if _, err := backend.DeleteGenerationJobs(ctx, tenantID, []string{job.ID}); err != nil {
		t.Fatalf("bulk delete generation job: %v", err)
	}

	stored, err := backend.GetGenerationJob(ctx, tenantID, job.ID)
	if err != nil {
		t.Fatalf("read tombstoned job: %v", err)
	}
	if strings.Contains(string(stored.Result), secret) {
		t.Fatalf("bulk-deleted job still carries its result payload: %s", stored.Result)
	}
}

// Tombstones exist to outlive stale caches, not to accumulate forever.
func TestExpiredTombstonesArePhysicallyRemoved(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	const projectID = "proj-expired-tombstone"
	const jobID = "job-expired-tombstone"

	if err := backend.PutProject(ctx, tenantID, projectID, tombstoneProjectDocument(t, "待清理", now)); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := backend.DeleteProject(ctx, tenantID, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	job := GenerationJob{
		ID: jobID, Kind: "image", Status: "succeeded", Prompt: "cleanup",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if err := backend.DeleteGenerationJob(ctx, tenantID, jobID); err != nil {
		t.Fatalf("delete generation job: %v", err)
	}

	// Well inside the retention window nothing may be purged yet.
	if _, err := backend.PurgeExpiredTombstones(ctx, now.Add(time.Hour)); err != nil {
		t.Fatalf("early purge: %v", err)
	}
	var stillThere int
	if err := backend.pool.QueryRow(ctx,
		`SELECT count(*) FROM openboard_projects WHERE tenant_id=$1 AND id=$2`,
		tenantID, projectID).Scan(&stillThere); err != nil {
		t.Fatal(err)
	}
	if stillThere != 1 {
		t.Fatalf("tombstone purged before the retention window elapsed")
	}

	// Past the window both tombstones must be gone from disk.
	if _, err := backend.PurgeExpiredTombstones(ctx, now.Add(8*24*time.Hour)); err != nil {
		t.Fatalf("late purge: %v", err)
	}
	var projectRows, jobRows int
	if err := backend.pool.QueryRow(ctx,
		`SELECT count(*) FROM openboard_projects WHERE tenant_id=$1 AND id=$2`,
		tenantID, projectID).Scan(&projectRows); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(ctx,
		`SELECT count(*) FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, jobID).Scan(&jobRows); err != nil {
		t.Fatal(err)
	}
	if projectRows != 0 {
		t.Fatalf("expired project tombstone still on disk")
	}
	if jobRows != 0 {
		t.Fatalf("expired generation job tombstone still on disk")
	}
}
