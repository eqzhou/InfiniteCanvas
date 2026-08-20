package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func openE2ETenantTestStore(t *testing.T) *PostgresStore {
	t.Helper()
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for E2E tenant PostgreSQL tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for E2E tenant PostgreSQL tests")
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

func TestEnsureE2ETenantUsesFiniteGenerationQuota(t *testing.T) {
	backend := openE2ETenantTestStore(t)
	tenantID := fmt.Sprintf("e2e-quota-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_users WHERE tenant_id=$1`, tenantID)
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID)
	})

	if err := backend.EnsureE2ETenant(t.Context(), tenantID); err != nil {
		t.Fatalf("ensure E2E tenant: %v", err)
	}

	var quota int64
	if err := backend.pool.QueryRow(t.Context(), `
SELECT generation_quota_monthly FROM openboard_tenants WHERE id=$1`, tenantID).Scan(&quota); err != nil {
		t.Fatalf("read E2E tenant quota: %v", err)
	}
	if quota != 1_000 {
		t.Fatalf("E2E tenant generation quota = %d, want finite test quota 1000", quota)
	}
}

func TestEnsureE2ETenantRepairsQuotaOnRetry(t *testing.T) {
	backend := openE2ETenantTestStore(t)
	tenantID := fmt.Sprintf("e2e-quota-retry-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_users WHERE tenant_id=$1`, tenantID)
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID)
	})

	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, 'Browser E2E', 'free', $2, 0)`, tenantID, defaultStorageQuotaBytes); err != nil {
		t.Fatalf("seed E2E tenant: %v", err)
	}

	if err := backend.EnsureE2ETenant(t.Context(), tenantID); err != nil {
		t.Fatalf("retry ensure E2E tenant: %v", err)
	}

	var quota int64
	if err := backend.pool.QueryRow(t.Context(), `
SELECT generation_quota_monthly FROM openboard_tenants WHERE id=$1`, tenantID).Scan(&quota); err != nil {
		t.Fatalf("read repaired E2E tenant quota: %v", err)
	}
	if quota != 1_000 {
		t.Fatalf("repaired E2E tenant generation quota = %d, want finite test quota 1000", quota)
	}
}
