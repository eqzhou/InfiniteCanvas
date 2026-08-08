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

func TestDeletedProjectRemovesFilmAggregate(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	const projectID = "proj-film-delete"
	if err := backend.PutProject(ctx, tenantID, projectID, tombstoneProjectDocument(t, "Film", time.Now().UTC())); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := backend.CreateFilmProject(ctx, tenantID, projectID, []byte(`{"schemaVersion":1}`)); err != nil {
		t.Fatalf("seed film: %v", err)
	}
	if err := backend.DeleteProject(ctx, tenantID, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	if _, err := backend.GetFilmProject(ctx, tenantID, projectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted film aggregate remains readable: %v", err)
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
	// ErrGone, not ErrConflict: the project is gone, so the client must stop rather
	// than treat this as a version race and retry the write.
	if !errors.Is(err, ErrGone) {
		t.Fatalf("CAS create over a tombstone should return ErrGone, got %v", err)
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

	if _, err := backend.GetGenerationJob(ctx, tenantID, job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned job should be unreadable, got %v", err)
	}
	var status string
	var result []byte
	if err := backend.pool.QueryRow(ctx, `SELECT status, result FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID).Scan(&status, &result); err != nil {
		t.Fatalf("read raw tombstone: %v", err)
	}
	if status != "deleted" {
		t.Fatalf("expected deleted status, got %q", status)
	}
	if strings.Contains(string(result), secret) {
		t.Fatalf("deleted job still carries its result payload: %s", result)
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

	if _, err := backend.GetGenerationJob(ctx, tenantID, job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bulk tombstone should be unreadable, got %v", err)
	}
	var result []byte
	if err := backend.pool.QueryRow(ctx, `SELECT result FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID).Scan(&result); err != nil {
		t.Fatalf("read raw tombstone: %v", err)
	}
	if strings.Contains(string(result), secret) {
		t.Fatalf("bulk-deleted job still carries its result payload: %s", result)
	}
}

func TestDeletedGenerationJobResistsRecreation(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	job := GenerationJob{
		ID: "job-no-resurrection", Kind: "image", Status: "succeeded", Prompt: "original",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if err := backend.DeleteGenerationJob(ctx, tenantID, job.ID); err != nil {
		t.Fatalf("delete generation job: %v", err)
	}

	stale := job
	stale.Status = "succeeded"
	stale.Prompt = "stale write"
	stale.UpdatedAt = now.Add(time.Second).Format(time.RFC3339Nano)
	for name, write := range map[string]func() error{
		"put":    func() error { return backend.PutGenerationJob(ctx, tenantID, stale) },
		"create": func() error { return backend.CreateGenerationJob(ctx, tenantID, stale) },
		"server create": func() error {
			return backend.CreateServerGenerationJob(ctx, tenantID, "", stale, 1, json.RawMessage(`{}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := write(); !errors.Is(err, ErrGone) {
				t.Fatalf("write over tombstone should return ErrGone, got %v", err)
			}
		})
	}
	if _, err := backend.GetGenerationJob(ctx, tenantID, job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted generation job must stay unreadable, got %v", err)
	}
	var status, prompt string
	if err := backend.pool.QueryRow(ctx, `SELECT status, prompt FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID).Scan(&status, &prompt); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" || prompt != "original" {
		t.Fatalf("tombstone was changed: status=%q prompt=%q", status, prompt)
	}

	fakeTombstone := stale
	fakeTombstone.ID = "job-client-deleted-status"
	fakeTombstone.Status = "deleted"
	for name, write := range map[string]func() error{
		"put":    func() error { return backend.PutGenerationJob(ctx, tenantID, fakeTombstone) },
		"create": func() error { return backend.CreateGenerationJob(ctx, tenantID, fakeTombstone) },
		"server create": func() error {
			return backend.CreateServerGenerationJob(ctx, tenantID, "", fakeTombstone, 1, json.RawMessage(`{}`))
		},
	} {
		t.Run("reject deleted status/"+name, func(t *testing.T) {
			if err := write(); !errors.Is(err, ErrGone) {
				t.Fatalf("direct deleted-status write should return ErrGone, got %v", err)
			}
		})
	}
}

func TestGenerationHistoryRestoreCannotReplaceTombstones(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	job := GenerationJob{
		ID: "job-restore-tombstone", Kind: "image", Status: "succeeded", Prompt: "original",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if err := backend.DeleteGenerationJob(ctx, tenantID, job.ID); err != nil {
		t.Fatalf("delete generation job: %v", err)
	}

	stale := job
	stale.Prompt = "stale restore"
	stale.UpdatedAt = now.Add(time.Minute).Format(time.RFC3339Nano)
	if err := backend.ReplaceGenerationJobs(ctx, tenantID, []GenerationJob{stale}); !errors.Is(err, ErrGone) {
		t.Fatalf("full restore over tombstone should return ErrGone, got %v", err)
	}
	page, err := backend.ListGenerationJobs(ctx, tenantID, GenerationJobQuery{Page: 1, PageSize: 100, IncludeDeleted: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.CompareAndSwapGenerationJobs(ctx, tenantID, GenerationJobsVersion(page.Items), []GenerationJob{stale}); !errors.Is(err, ErrGone) {
		t.Fatalf("CAS restore over tombstone should return ErrGone, got %v", err)
	}

	var status, prompt string
	if err := backend.pool.QueryRow(ctx, `SELECT status,prompt FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID).Scan(&status, &prompt); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" || prompt != "original" {
		t.Fatalf("restore changed tombstone: status=%q prompt=%q", status, prompt)
	}
}

func TestPurgeGenerationTombstonesRequiresDeletedStatus(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	ctx := t.Context()
	now := time.Now().UTC()
	job := GenerationJob{
		ID: "job-live-with-deleted-at", Kind: "image", Status: "succeeded", Prompt: "keep",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(ctx, tenantID, job); err != nil {
		t.Fatalf("seed generation job: %v", err)
	}
	if _, err := backend.pool.Exec(ctx, `UPDATE openboard_generation_jobs SET deleted_at=$3 WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID, now.Add(-8*24*time.Hour)); err != nil {
		t.Fatalf("seed inconsistent deleted_at: %v", err)
	}
	if _, err := backend.PurgeExpiredTombstones(ctx, now); err != nil {
		t.Fatalf("purge tombstones: %v", err)
	}
	var rows int
	if err := backend.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, job.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatal("purge removed a generation row whose status was not deleted")
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
