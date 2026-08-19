package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMediaReferenceTokenDigestIsNotTheBearerToken(t *testing.T) {
	const referenceCredential = "legacy-media-reference-token"
	digest := HashMediaReferenceToken(referenceCredential)
	if digest == referenceCredential {
		t.Fatal("media reference token digest must differ from bearer token")
	}
}

func TestPostgresMediaReferenceLegacyPlaintextTokenIsMigrated(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL media reference tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL media reference tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("media-reference-%d", time.Now().UnixNano())
	const referenceCredential = "legacy-media-token-for-migration"
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_media_references (token,tenant_id,storage_key,expires_at,token_hashed)
VALUES ($1,$2,'legacy/key.png',$3,false)`, referenceCredential, tenantID, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_media_references WHERE tenant_id=$1`, tenantID)
	})

	ref, err := backend.GetMediaReference(t.Context(), referenceCredential)
	if err != nil || ref.Token != referenceCredential || ref.TenantID != tenantID || ref.StorageKey != "legacy/key.png" {
		t.Fatalf("legacy media reference = %#v, err=%v", ref, err)
	}
	var storedToken string
	if err := backend.pool.QueryRow(t.Context(), `SELECT token FROM openboard_media_references WHERE tenant_id=$1`, tenantID).Scan(&storedToken); err != nil {
		t.Fatal(err)
	}
	if storedToken != HashMediaReferenceToken(referenceCredential) {
		t.Fatalf("stored token = %q, want hash %q", storedToken, HashMediaReferenceToken(referenceCredential))
	}
	var tokenHashed bool
	if err := backend.pool.QueryRow(t.Context(), `SELECT token_hashed FROM openboard_media_references WHERE tenant_id=$1`, tenantID).Scan(&tokenHashed); err != nil {
		t.Fatal(err)
	}
	if !tokenHashed {
		t.Fatal("migrated legacy media reference is not marked hashed")
	}
	if _, err := backend.GetMediaReference(t.Context(), HashMediaReferenceToken(referenceCredential)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("migrated legacy digest was accepted as bearer: err=%v", err)
	}
}

func TestPostgresMediaReferenceMigrationPreservesExistingHashes(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL media reference tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL media reference tests")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(adminPool.Close)

	schemaName := fmt.Sprintf("media_reference_migration_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, `CREATE SCHEMA `+schemaName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DROP SCHEMA `+schemaName+` CASCADE`)
	})

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if err := migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}

	const referenceCredential = "existing-hashed-media-reference-token"
	digest := HashMediaReferenceToken(referenceCredential)
	if _, err := pool.Exec(ctx, `ALTER TABLE openboard_media_references DROP COLUMN token_hashed`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM openboard_schema_migrations WHERE version>=29`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO openboard_media_references (token,tenant_id,storage_key,expires_at)
VALUES ($1,'migration-tenant','migration/key.png',$2)`, digest, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	// The fixture is deliberately an old schema: the row was already hashed by
	// the release before V29, but the marker column did not exist yet.
	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("upgrade old hashed schema: %v", err)
	}
	backend := &PostgresStore{pool: pool}
	ref, err := backend.GetMediaReference(ctx, referenceCredential)
	if err != nil || ref.StorageKey != "migration/key.png" {
		t.Fatalf("existing hashed media reference = %#v, err=%v", ref, err)
	}
	if _, err := backend.GetMediaReference(ctx, digest); !errors.Is(err, ErrNotFound) {
		t.Fatalf("existing media reference digest was accepted as bearer: err=%v", err)
	}
	var tokenHashed bool
	if err := pool.QueryRow(ctx, `SELECT token_hashed FROM openboard_media_references WHERE token=$1`, digest).Scan(&tokenHashed); err != nil {
		t.Fatal(err)
	}
	if !tokenHashed {
		t.Fatal("existing hashed media reference was not marked hashed during migration")
	}

	// Also repair the shape produced by the unreleased V29 implementation,
	// which added the marker with a false default.
	if _, err := pool.Exec(ctx, `UPDATE openboard_media_references SET token_hashed=false WHERE token=$1`, digest); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM openboard_schema_migrations WHERE version=30`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("repair V29 marker: %v", err)
	}
	if _, err := backend.GetMediaReference(ctx, referenceCredential); err != nil {
		t.Fatalf("hashed media reference after V29 repair: %v", err)
	}
	if _, err := backend.GetMediaReference(ctx, digest); !errors.Is(err, ErrNotFound) {
		t.Fatalf("digest accepted after V29 repair: %v", err)
	}
}

func TestPostgresMediaReferenceDigestCannotBeUsedAsBearer(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL media reference tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL media reference tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("media-reference-digest-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_media_references WHERE tenant_id=$1`, tenantID)
	})

	created, err := backend.CreateMediaReference(t.Context(), tenantID, "hashed/key.png", time.Now().UTC().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	digest := HashMediaReferenceToken(created.Token)
	if _, err := backend.GetMediaReference(t.Context(), digest); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stored media reference digest was accepted as bearer: err=%v", err)
	}
	var storedToken string
	var tokenHashed bool
	if err := backend.pool.QueryRow(t.Context(), `SELECT token,token_hashed FROM openboard_media_references WHERE tenant_id=$1`, tenantID).Scan(&storedToken, &tokenHashed); err != nil {
		t.Fatal(err)
	}
	if storedToken != digest || !tokenHashed {
		t.Fatalf("digest request changed hashed row: token=%q hashed=%v", storedToken, tokenHashed)
	}
	if _, err := backend.GetMediaReference(t.Context(), created.Token); err != nil {
		t.Fatalf("original media reference stopped working after digest request: %v", err)
	}
}
