package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const schemaMigrations = `
CREATE TABLE IF NOT EXISTS openboard_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`

const migrationV1 = `
CREATE TABLE IF NOT EXISTS openboard_projects (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) <= 500),
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_projects_updated_idx
  ON openboard_projects (updated_at DESC);
CREATE TABLE IF NOT EXISTS openboard_state (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 128),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`

const migrationV2 = `
CREATE TABLE IF NOT EXISTS openboard_generation_jobs (
  id text PRIMARY KEY,
  project_id text,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  prompt text NOT NULL,
  provider_id text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_created_idx
  ON openboard_generation_jobs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_project_kind_idx
  ON openboard_generation_jobs (project_id, kind, created_at DESC);`

const migrationV4 = `
ALTER TABLE openboard_generation_jobs
  ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_server_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE parameters->>'executor' = 'server' AND status IN ('queued', 'running');`

const migrationV5Indexes = `
DROP INDEX IF EXISTS openboard_generation_jobs_server_claim_idx;
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_image_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE kind='image' AND parameters->>'executor'='server' AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_workflow_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE kind='workflow' AND parameters->>'executor'='workflow' AND status IN ('queued','running');`

const migrationV6Indexes = `
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_video_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE kind='video' AND parameters->>'executor'='server' AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_audio_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE kind='audio' AND parameters->>'executor'='server' AND status IN ('queued','running');`

// migrationV3SQL is applied statement-by-statement because ALTER ... DROP CONSTRAINT
// needs dynamic primary-key discovery.
const currentSchemaVersion = 28

// tombstoneRetention keeps a deleted-row marker around long enough to outlive a
// stale browser tab that still holds the pre-delete document. Without it an
// ordinary autosave would recreate the project the user just removed.
const tombstoneRetention = 7 * 24 * time.Hour

const defaultStorageQuotaBytes int64 = 1 << 30
const defaultGenerationQuotaMonthly int64 = 0

type PostgresStore struct {
	pool  *pgxpool.Pool
	redis *redis.Client
}

func Open(ctx context.Context, databaseURL, redisURL string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	s := &PostgresStore{pool: pool}
	if err := pool.Ping(ctx); err != nil {
		s.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if err := migrate(ctx, pool); err != nil {
		s.Close()
		return nil, fmt.Errorf("migrate postgres: %w", err)
	}
	if redisURL != "" {
		options, err := redis.ParseURL(redisURL)
		if err != nil {
			s.Close()
			return nil, fmt.Errorf("parse redis url: %w", err)
		}
		s.redis = redis.NewClient(options)
		if err := s.redis.Ping(ctx).Err(); err != nil {
			s.Close()
			return nil, fmt.Errorf("ping redis: %w", err)
		}
	}
	return s, nil
}

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	lockConnection, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire schema migration lock connection: %w", err)
	}
	defer lockConnection.Release()
	const migrationLockID int64 = 0x4f50454e424f4152
	if _, err := lockConnection.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("lock schema migrations: %w", err)
	}
	defer func() {
		_, _ = lockConnection.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, migrationLockID)
	}()
	if _, err := lockConnection.Exec(ctx, schemaMigrations); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	var version int
	if err := lockConnection.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM openboard_schema_migrations`).Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > currentSchemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d", version, currentSchemaVersion)
	}
	if version < 1 {
		if err := applyMigration(ctx, lockConnection, 1, migrationV1); err != nil {
			return err
		}
	}
	if version < 2 {
		if err := applyMigration(ctx, lockConnection, 2, migrationV2); err != nil {
			return err
		}
	}
	if version < 3 {
		if err := migrateV3(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 4 {
		if err := applyMigration(ctx, lockConnection, 4, migrationV4); err != nil {
			return err
		}
	}
	if version < 5 {
		if err := migrateV5(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 6 {
		if err := migrateV6(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 7 {
		if err := migrateV7(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 8 {
		if err := migrateV8(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 9 {
		if err := migrateV9(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 10 {
		if err := migrateV10(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 11 {
		if err := migrateV11(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 12 {
		if err := migrateV12(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 13 {
		if err := migrateV13(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 14 {
		if err := migrateV14(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 15 {
		if err := migrateV15(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 16 {
		if err := migrateV16(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 17 {
		if err := migrateV17(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 18 {
		if err := migrateV18(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 19 {
		if err := migrateV19(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 20 {
		if err := migrateV20(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 21 {
		if err := migrateV21(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 22 {
		if err := migrateV22(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 23 {
		if err := migrateV23(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 24 {
		if err := migrateV24(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 25 {
		if err := migrateV25(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 26 {
		if err := migrateV26(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 27 {
		if err := migrateV27(ctx, lockConnection); err != nil {
			return err
		}
	}
	if version < 28 {
		if err := migrateV28(ctx, lockConnection); err != nil {
			return err
		}
	}
	return nil
}

const generationJobOwnershipBackfillSQL = `
-- Prefer durable billing and audit evidence that was written alongside the
-- original job. Every candidate must still resolve to an active account in
-- the same tenant; stale or cross-tenant identifiers are ignored.
WITH reserve_owner AS (
  SELECT DISTINCT ON (credit.tenant_id,credit.job_id)
    credit.tenant_id,credit.job_id,credit.user_id
  FROM openboard_credit_logs AS credit
  JOIN openboard_users AS account
    ON account.tenant_id=credit.tenant_id
   AND account.id=credit.user_id
   AND account.status='active'
  WHERE credit.reason='reserve' AND credit.job_id<>'' AND credit.user_id<>''
  ORDER BY credit.tenant_id,credit.job_id,credit.id
)
UPDATE openboard_generation_jobs AS job
SET user_id=evidence.user_id
FROM reserve_owner AS evidence
WHERE job.tenant_id=evidence.tenant_id
  AND job.id=evidence.job_id
  AND job.user_id='';

WITH usage_owner AS (
  SELECT DISTINCT ON (usage.tenant_id,usage.meta->>'jobId')
    usage.tenant_id,usage.meta->>'jobId' AS job_id,usage.user_id
  FROM openboard_usage_events AS usage
  JOIN openboard_users AS account
    ON account.tenant_id=usage.tenant_id
   AND account.id=usage.user_id
   AND account.status='active'
  WHERE usage.kind='generation'
    AND usage.user_id IS NOT NULL
    AND usage.user_id<>''
    AND usage.meta->>'jobId'<>''
  ORDER BY usage.tenant_id,usage.meta->>'jobId',usage.id
)
UPDATE openboard_generation_jobs AS job
SET user_id=evidence.user_id
FROM usage_owner AS evidence
WHERE job.tenant_id=evidence.tenant_id
  AND job.id=evidence.job_id
  AND job.user_id='';

WITH ai_call_owner AS (
  SELECT DISTINCT ON (ai_call.tenant_id,ai_call.job_id)
    ai_call.tenant_id,ai_call.job_id,ai_call.user_id
  FROM openboard_ai_call_logs AS ai_call
  JOIN openboard_users AS account
    ON account.tenant_id=ai_call.tenant_id
   AND account.id=ai_call.user_id
   AND account.status='active'
  WHERE ai_call.job_id<>'' AND ai_call.user_id<>''
  ORDER BY ai_call.tenant_id,ai_call.job_id,ai_call.created_at,ai_call.id
)
UPDATE openboard_generation_jobs AS job
SET user_id=evidence.user_id
FROM ai_call_owner AS evidence
WHERE job.tenant_id=evidence.tenant_id
  AND job.id=evidence.job_id
  AND job.user_id='';

-- Only server-defined executor/kind pairs may supply identity through job
-- parameters. Generic browser job parameters are intentionally not trusted.
WITH parameter_owner AS (
  SELECT job.tenant_id,job.id,account.id AS user_id
  FROM openboard_generation_jobs AS job
  JOIN openboard_users AS account
    ON account.tenant_id=job.tenant_id
   AND account.status='active'
   AND account.id=CASE
     WHEN job.kind='workflow' AND job.parameters->>'executor'='workflow'
       THEN job.parameters->>'billingUserId'
     WHEN job.kind IN ('image','video','audio') AND job.parameters->>'executor'='comfyui'
       THEN job.parameters->>'billingUserId'
     WHEN job.kind='export' AND job.parameters->>'executor'='film-export'
       THEN job.parameters->>'userId'
     ELSE NULL
   END
  WHERE job.user_id=''
)
UPDATE openboard_generation_jobs AS job
SET user_id=evidence.user_id
FROM parameter_owner AS evidence
WHERE job.tenant_id=evidence.tenant_id
  AND job.id=evidence.id
  AND job.user_id='';

-- Film-stage parents do not consume credits themselves. They inherit an
-- owner only when every referenced child exists and all children resolve to
-- the same active tenant account.
WITH film_child_owner AS (
  SELECT parent.tenant_id,parent.id,MIN(child_account.id) AS user_id
  FROM openboard_generation_jobs AS parent
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(parent.parameters->'childJobIds')='array'
        THEN parent.parameters->'childJobIds'
      ELSE '[]'::jsonb
    END
  ) AS child_ref(child_id)
  LEFT JOIN openboard_generation_jobs AS child
    ON child.tenant_id=parent.tenant_id AND child.id=child_ref.child_id
  LEFT JOIN openboard_users AS child_account
    ON child_account.tenant_id=parent.tenant_id
   AND child_account.id=child.user_id
   AND child_account.status='active'
  WHERE parent.user_id=''
    AND parent.kind='film-stage'
    AND parent.parameters->>'executor'='film-stage'
  GROUP BY parent.tenant_id,parent.id
  HAVING COUNT(*)>0
    AND COUNT(child_account.id)=COUNT(*)
    AND COUNT(DISTINCT child_account.id)=1
)
UPDATE openboard_generation_jobs AS job
SET user_id=evidence.user_id
FROM film_child_owner AS evidence
WHERE job.tenant_id=evidence.tenant_id
  AND job.id=evidence.id
  AND job.user_id='';

-- Old browser-only jobs may have no durable actor evidence. Assign only those
-- remaining rows to a deterministic active tenant Owner. Ownerless tenants
-- remain deliberately unclaimed so a normal user never inherits another
-- account's prompts or generated media.
WITH canonical_user AS (
  SELECT DISTINCT ON (tenant_id) tenant_id,id
  FROM openboard_users
  WHERE status='active' AND role IN ('owner','admin')
  ORDER BY tenant_id,created_at,id
)
UPDATE openboard_generation_jobs AS job
SET user_id=account.id
FROM canonical_user AS account
WHERE job.tenant_id=account.tenant_id AND job.user_id='';
`

func migrateV28(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 28, `
ALTER TABLE openboard_generation_jobs
  ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT '';

`+generationJobOwnershipBackfillSQL+`

CREATE INDEX IF NOT EXISTS openboard_generation_jobs_tenant_user_created_idx
  ON openboard_generation_jobs (tenant_id,user_id,created_at DESC,id DESC);

-- Claim legacy single-user settings for exactly one deterministic tenant
-- owner. The encrypted value is copied as-is, so the migration never exposes
-- plaintext credentials and ON CONFLICT preserves settings already saved in
-- the new personal scope.
WITH canonical_owner AS (
  SELECT DISTINCT ON (tenant_id) tenant_id,id
  FROM openboard_users
  WHERE role='owner' AND status='active'
  ORDER BY tenant_id,created_at,id
)
INSERT INTO openboard_state (tenant_id,key,value,updated_at)
SELECT state.tenant_id,'__user_config_v1:' || owner.id,state.value,state.updated_at
FROM openboard_state AS state
JOIN canonical_owner AS owner ON owner.tenant_id=state.tenant_id
WHERE state.key='config'
ON CONFLICT (tenant_id,key) DO NOTHING;

WITH canonical_owner AS (
  SELECT DISTINCT ON (tenant_id) tenant_id,id
  FROM openboard_users
  WHERE role='owner' AND status='active'
  ORDER BY tenant_id,created_at,id
)
INSERT INTO openboard_state (tenant_id,key,value,updated_at)
SELECT state.tenant_id,'__encrypted_user_config_secrets_v1:' || owner.id,state.value,state.updated_at
FROM openboard_state AS state
JOIN canonical_owner AS owner ON owner.tenant_id=state.tenant_id
WHERE state.key='__encrypted_config_secrets'
ON CONFLICT (tenant_id,key) DO NOTHING;

WITH canonical_owner AS (
  SELECT DISTINCT ON (tenant_id) tenant_id,id
  FROM openboard_users
  WHERE role='owner' AND status='active'
  ORDER BY tenant_id,created_at,id
)
INSERT INTO openboard_state (tenant_id,key,value,updated_at)
SELECT state.tenant_id,'__user_workflow_templates_v1:' || owner.id,state.value,state.updated_at
FROM openboard_state AS state
JOIN canonical_owner AS owner ON owner.tenant_id=state.tenant_id
WHERE state.key='workflow-templates'
ON CONFLICT (tenant_id,key) DO NOTHING;
`)
}

func migrateV27(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 27, `
-- The former tenant-admin role is retained in the database constraint for
-- rolling-upgrade compatibility. It had tenant-management authority, so map
-- existing accounts to Owner rather than silently revoking that authority.
UPDATE openboard_users SET role='owner' WHERE role='admin';
-- Pending legacy admin invitations keep their constrained storage value. The
-- registration transaction canonicalizes them to Owner when consumed; new
-- invitation writes only permit ordinary tenant users.
`)
}

func migrateV24(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 24, `
ALTER TABLE openboard_film_voice_consents
  ADD COLUMN IF NOT EXISTS evidence_storage_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_mime_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_sha256 text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_object_version text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS openboard_film_voice_consents_evidence_idx
  ON openboard_film_voice_consents (tenant_id,project_id,evidence_sha256)
  WHERE evidence_sha256 <> '';
`)
}

func migrateV25(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 25, `
CREATE TABLE IF NOT EXISTS openboard_tenant_invitations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES openboard_tenants(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id text REFERENCES openboard_users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_by text NOT NULL REFERENCES openboard_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_tenant_invitations_tenant_created_idx
  ON openboard_tenant_invitations (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS openboard_tenant_invitations_active_email_idx
	ON openboard_tenant_invitations (tenant_id, lower(email))
	WHERE accepted_at IS NULL AND revoked_at IS NULL;
`)
}

func migrateV26(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 26, `
WITH duplicates AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id, lower(email) ORDER BY created_at DESC, id DESC) AS row_number
  FROM openboard_tenant_invitations
  WHERE accepted_at IS NULL AND revoked_at IS NULL
)
UPDATE openboard_tenant_invitations AS invitations
SET revoked_at=now()
FROM duplicates
WHERE invitations.id=duplicates.id AND duplicates.row_number > 1;
DROP INDEX IF EXISTS openboard_tenant_invitations_active_email_idx;
CREATE UNIQUE INDEX openboard_tenant_invitations_active_email_idx
  ON openboard_tenant_invitations (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
`)
}

func migrateV23(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 23, `
CREATE TABLE IF NOT EXISTS openboard_film_voice_identities (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  current_version_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES openboard_film_projects (tenant_id,project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS openboard_film_voice_identities_project_idx
  ON openboard_film_voice_identities (tenant_id,project_id,created_at,id);
CREATE TABLE IF NOT EXISTS openboard_film_voice_samples (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  voice_identity_id text NOT NULL,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 500),
  storage_key text NOT NULL CHECK (char_length(storage_key) BETWEEN 1 AND 512),
  mime_type text NOT NULL CHECK (mime_type LIKE 'audio/%' AND char_length(mime_type) <= 100),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_object_version text NOT NULL DEFAULT '' CHECK (char_length(media_object_version) <= 512),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,id),
  FOREIGN KEY (tenant_id,project_id,voice_identity_id)
    REFERENCES openboard_film_voice_identities (tenant_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS openboard_film_voice_consents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  voice_identity_id text NOT NULL,
  accepted boolean NOT NULL CHECK (accepted),
  rights_basis text NOT NULL CHECK (rights_basis IN ('self','licensed','authorized')),
  subject_display_name text NOT NULL CHECK (char_length(subject_display_name) BETWEEN 1 AND 500),
  terms_version text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 100),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,id),
  FOREIGN KEY (tenant_id,project_id,voice_identity_id)
    REFERENCES openboard_film_voice_identities (tenant_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS openboard_film_voice_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  voice_identity_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('queued','running','ready','failed','canceled')),
  consent_id text NOT NULL,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 500),
  provider_voice_id text NOT NULL DEFAULT '' CHECK (char_length(provider_voice_id) <= 1000),
  generation_job_id text NOT NULL CHECK (char_length(generation_job_id) BETWEEN 1 AND 128),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  error text NOT NULL DEFAULT '' CHECK (char_length(error) <= 2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,id),
  UNIQUE (tenant_id,project_id,voice_identity_id,revision),
  UNIQUE (tenant_id,project_id,idempotency_key_hash),
  UNIQUE (tenant_id,generation_job_id),
  FOREIGN KEY (tenant_id,project_id,voice_identity_id)
    REFERENCES openboard_film_voice_identities (tenant_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,project_id,consent_id)
    REFERENCES openboard_film_voice_consents (tenant_id,project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,generation_job_id)
    REFERENCES openboard_generation_jobs (tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS openboard_film_voice_version_samples (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  version_id text NOT NULL,
  sample_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (tenant_id,project_id,version_id,sample_id),
  UNIQUE (tenant_id,project_id,version_id,position),
  FOREIGN KEY (tenant_id,project_id,version_id)
    REFERENCES openboard_film_voice_versions (tenant_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,project_id,sample_id)
    REFERENCES openboard_film_voice_samples (tenant_id,project_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS openboard_film_voice_versions_identity_idx
  ON openboard_film_voice_versions (tenant_id,project_id,voice_identity_id,revision DESC);
`)
}

func migrateV22(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 22, `
ALTER TABLE openboard_film_entities
  ADD COLUMN IF NOT EXISTS aggregate_revision integer NOT NULL DEFAULT 1 CHECK (aggregate_revision > 0),
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT '';
UPDATE openboard_film_entities entity
SET aggregate_revision=project.revision,
    position=CASE WHEN COALESCE(entity.document->>'order','') ~ '^[0-9]+$'
      THEN LEAST(2147483647,(entity.document->>'order')::numeric)::integer ELSE 0 END,
    status=COALESCE(entity.document->>'status','')
FROM openboard_film_projects project
WHERE entity.tenant_id=project.tenant_id AND entity.project_id=project.project_id;
UPDATE openboard_film_entities SET entity_type='stage_approval' WHERE entity_type='stage';
INSERT INTO openboard_film_entities
  (tenant_id,project_id,entity_type,entity_id,revision,aggregate_revision,position,status,document)
SELECT tenant_id,project_id,'projection','projection',
  CASE WHEN COALESCE(document->>'projectionRevision','') ~ '^[1-9][0-9]*$'
    THEN LEAST(2147483647,(document->>'projectionRevision')::numeric)::integer ELSE 1 END,
  revision,0,'',jsonb_build_object('revision',
    CASE WHEN COALESCE(document->>'projectionRevision','') ~ '^[1-9][0-9]*$'
      THEN LEAST(2147483647,(document->>'projectionRevision')::numeric)::integer ELSE 1 END)
FROM openboard_film_projects
ON CONFLICT (tenant_id,project_id,entity_type,entity_id) DO UPDATE
SET revision=EXCLUDED.revision,aggregate_revision=EXCLUDED.aggregate_revision,
    position=0,status='',document=EXCLUDED.document,updated_at=clock_timestamp();
ALTER TABLE openboard_film_entities DROP CONSTRAINT IF EXISTS openboard_film_entities_type_check;
ALTER TABLE openboard_film_entities ADD CONSTRAINT openboard_film_entities_type_check CHECK (entity_type IN (
  'source','episode','scene','shot','dialogue','asset','stage_approval','task','quality_report',
  'timeline','deliverable','adoption','entity_version','projection'
));
CREATE INDEX IF NOT EXISTS openboard_film_entities_status_idx
  ON openboard_film_entities (tenant_id,project_id,entity_type,status,position,entity_id);
CREATE INDEX IF NOT EXISTS openboard_film_entities_aggregate_revision_idx
  ON openboard_film_entities (tenant_id,project_id,aggregate_revision);
CREATE TABLE IF NOT EXISTS openboard_film_entity_relations (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN (
    'scene_episode','shot_scene','dialogue_shot','asset_parent','asset_episode','asset_scene',
    'asset_shot','shot_identity','shot_style','dialogue_character','dialogue_voice'
  )),
  source_type text NOT NULL,
  source_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  aggregate_revision integer NOT NULL CHECK (aggregate_revision > 0),
  PRIMARY KEY (tenant_id,project_id,relation_type,source_type,source_id,target_type,target_id),
  FOREIGN KEY (tenant_id,project_id,source_type,source_id)
    REFERENCES openboard_film_entities (tenant_id,project_id,entity_type,entity_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,project_id,target_type,target_id)
    REFERENCES openboard_film_entities (tenant_id,project_id,entity_type,entity_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS openboard_film_entity_relations_source_idx
  ON openboard_film_entity_relations (tenant_id,project_id,source_type,source_id,relation_type,position);
CREATE INDEX IF NOT EXISTS openboard_film_entity_relations_target_idx
  ON openboard_film_entity_relations (tenant_id,project_id,target_type,target_id,relation_type);
INSERT INTO openboard_film_entity_relations
  (tenant_id,project_id,relation_type,source_type,source_id,target_type,target_id,position,aggregate_revision)
SELECT source.tenant_id,source.project_id,edge.relation_type,source.entity_type,source.entity_id,
  edge.target_type,edge.target_id,edge.position,source.aggregate_revision
FROM openboard_film_entities source
CROSS JOIN LATERAL (
  SELECT 'scene_episode', 'episode', source.document->>'episodeId', 0 WHERE source.entity_type='scene'
  UNION ALL SELECT 'shot_scene', 'scene', source.document->>'sceneId', 0 WHERE source.entity_type='shot'
  UNION ALL SELECT 'dialogue_shot', 'shot', source.document->>'shotId', 0 WHERE source.entity_type='dialogue'
  UNION ALL SELECT 'asset_parent', 'asset', source.document->>'parentAssetId', 0
    WHERE source.entity_type='asset' AND COALESCE(source.document->>'parentAssetId','')<>''
  UNION ALL SELECT 'shot_style', 'asset', source.document->>'styleAssetId', 0
    WHERE source.entity_type='shot' AND COALESCE(source.document->>'styleAssetId','')<>''
  UNION ALL SELECT 'dialogue_character', 'asset', source.document->>'characterAssetId', 0
    WHERE source.entity_type='dialogue' AND COALESCE(source.document->>'characterAssetId','')<>''
  UNION ALL SELECT 'dialogue_voice', 'asset', source.document->>'voiceAssetId', 0
    WHERE source.entity_type='dialogue' AND COALESCE(source.document->>'voiceAssetId','')<>''
) edge(relation_type,target_type,target_id,position)
JOIN openboard_film_entities target ON target.tenant_id=source.tenant_id AND target.project_id=source.project_id
  AND target.entity_type=edge.target_type AND target.entity_id=edge.target_id
ON CONFLICT DO NOTHING;
INSERT INTO openboard_film_entity_relations
  (tenant_id,project_id,relation_type,source_type,source_id,target_type,target_id,position,aggregate_revision)
SELECT source.tenant_id,source.project_id,edge.relation_type,source.entity_type,source.entity_id,
  edge.target_type,edge.target_id,edge.position,source.aggregate_revision
FROM openboard_film_entities source
CROSS JOIN LATERAL (
  SELECT 'shot_identity','asset',item.value,item.ordinality::integer-1
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(source.document->'identityVersionIds')='array' THEN source.document->'identityVersionIds' ELSE '[]'::jsonb END) WITH ORDINALITY item(value,ordinality)
    WHERE source.entity_type='shot'
  UNION ALL SELECT 'asset_episode','episode',item.value,item.ordinality::integer-1
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(source.document->'episodeIds')='array' THEN source.document->'episodeIds' ELSE '[]'::jsonb END) WITH ORDINALITY item(value,ordinality)
    WHERE source.entity_type='asset'
  UNION ALL SELECT 'asset_scene','scene',item.value,item.ordinality::integer-1
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(source.document->'sceneIds')='array' THEN source.document->'sceneIds' ELSE '[]'::jsonb END) WITH ORDINALITY item(value,ordinality)
    WHERE source.entity_type='asset'
  UNION ALL SELECT 'asset_shot','shot',item.value,item.ordinality::integer-1
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(source.document->'shotIds')='array' THEN source.document->'shotIds' ELSE '[]'::jsonb END) WITH ORDINALITY item(value,ordinality)
    WHERE source.entity_type='asset'
) edge(relation_type,target_type,target_id,position)
JOIN openboard_film_entities target ON target.tenant_id=source.tenant_id AND target.project_id=source.project_id
  AND target.entity_type=edge.target_type AND target.entity_id=edge.target_id
ON CONFLICT DO NOTHING;
`)
}

func migrateV21(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 21, `
ALTER TABLE openboard_generation_jobs DROP CONSTRAINT IF EXISTS openboard_generation_jobs_kind_check_v6;
ALTER TABLE openboard_generation_jobs
  ADD CONSTRAINT openboard_generation_jobs_kind_check_v7
  CHECK (kind IN ('text','image','video','audio','workflow','export','film-stage'));
`)
}

func migrateV20(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 20, `
ALTER TABLE openboard_tenants ALTER COLUMN generation_quota_monthly SET DEFAULT 0;
ALTER TABLE openboard_tenants DROP CONSTRAINT IF EXISTS openboard_tenants_generation_quota_nonnegative;
ALTER TABLE openboard_tenants
  ADD CONSTRAINT openboard_tenants_generation_quota_nonnegative CHECK (generation_quota_monthly >= 0);
`)
}

func migrateV19(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 19, `
ALTER TABLE openboard_generation_jobs DROP CONSTRAINT IF EXISTS openboard_generation_jobs_kind_check_v6;
ALTER TABLE openboard_generation_jobs
  ADD CONSTRAINT openboard_generation_jobs_kind_check_v6 CHECK (kind IN ('image','video','audio','workflow','export'));
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_film_export_claim_idx
  ON openboard_generation_jobs (status, lease_expires_at, created_at)
  WHERE kind='export' AND parameters->>'executor'='film-export' AND status IN ('queued','running');
`)
}

func migrateV18(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 18, `
CREATE TABLE IF NOT EXISTS openboard_film_entities (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, entity_type, entity_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES openboard_film_projects (tenant_id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS openboard_film_entities_lookup_idx
  ON openboard_film_entities (tenant_id, project_id, entity_type, updated_at DESC);
INSERT INTO openboard_film_entities (tenant_id,project_id,entity_type,entity_id,revision,document)
SELECT project.tenant_id, project.project_id,
  CASE field.key WHEN 'episodes' THEN 'episode' WHEN 'scenes' THEN 'scene' WHEN 'shots' THEN 'shot'
    WHEN 'dialogues' THEN 'dialogue' WHEN 'assets' THEN 'asset' WHEN 'stages' THEN 'stage'
    WHEN 'tasks' THEN 'task' WHEN 'qualityReports' THEN 'quality_report' WHEN 'deliverables' THEN 'deliverable'
    WHEN 'adoptions' THEN 'adoption' WHEN 'versions' THEN 'entity_version' END,
  entity.value->>'id', GREATEST(1, COALESCE((entity.value->>'revision')::integer, 1)),
  CASE WHEN field.key='shots'
    AND jsonb_typeof(project.document->'stages')='array' AND jsonb_array_length(project.document->'stages')=7
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(project.document->'stages') stage WHERE stage->>'id'='storyboard' AND stage->>'status'='approved')
    AND COALESCE(entity.value->>'firstFrameStorageKey','')=''
  THEN entity.value || jsonb_strip_nulls(jsonb_build_object(
    'firstFrameStorageKey',entity.value->'imageStorageKey','firstFrameSha256',entity.value->'imageSha256',
    'firstFrameObjectVersion',entity.value->'imageObjectVersion','firstFrameGenerationJobId',entity.value->'imageGenerationJobId'))
  ELSE entity.value END
FROM openboard_film_projects project
CROSS JOIN LATERAL jsonb_each(project.document) field
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(field.value)='array' THEN field.value ELSE '[]'::jsonb END) entity(value)
WHERE field.key IN ('episodes','scenes','shots','dialogues','assets','stages','tasks','qualityReports','deliverables','adoptions','versions')
  AND entity.value ? 'id' AND entity.value->>'id' <> ''
ON CONFLICT (tenant_id,project_id,entity_type,entity_id) DO UPDATE
SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=clock_timestamp();
INSERT INTO openboard_film_entities (tenant_id,project_id,entity_type,entity_id,revision,document)
SELECT project.tenant_id,project.project_id,'stage','first_frame',1,jsonb_build_object(
  'id','first_frame','revision',1,
  'status',CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(project.document->'stages') stage WHERE stage->>'id'='storyboard' AND stage->>'status'='approved') THEN 'approved' ELSE 'draft' END,
  'updatedAt',project.document->>'updatedAt')
FROM openboard_film_projects project
WHERE jsonb_typeof(project.document->'stages')='array' AND jsonb_array_length(project.document->'stages')=7
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(project.document->'stages') stage WHERE stage->>'id'='first_frame')
ON CONFLICT (tenant_id,project_id,entity_type,entity_id) DO UPDATE
SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=clock_timestamp();
INSERT INTO openboard_film_entities (tenant_id,project_id,entity_type,entity_id,revision,document)
SELECT tenant_id,project_id,kind,kind,GREATEST(1,COALESCE((document->kind->>'revision')::integer,1)),document->kind
FROM openboard_film_projects CROSS JOIN (VALUES ('source'),('timeline')) kinds(kind)
WHERE jsonb_typeof(document->kind)='object'
ON CONFLICT (tenant_id,project_id,entity_type,entity_id) DO UPDATE
SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=clock_timestamp();
`)
}

func migrateV17(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 17, `
ALTER TABLE openboard_film_restore_tokens
  ADD COLUMN IF NOT EXISTS created_media jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE openboard_workspace_restore_tokens
  ADD COLUMN IF NOT EXISTS created_media jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS openboard_film_cleanup_generations (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  generation_id text NOT NULL,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, generation_id)
);
CREATE INDEX IF NOT EXISTS openboard_film_cleanup_pending_idx
  ON openboard_film_cleanup_generations (tenant_id, project_id, created_at)
  WHERE completed_at IS NULL;
`)
}

func migrateV16(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 16, `
CREATE TABLE IF NOT EXISTS openboard_workspace_restore_tokens (
  tenant_id text NOT NULL,
  token_digest text NOT NULL CHECK (char_length(token_digest) = 64),
  prior_snapshot jsonb NOT NULL,
  applied_version text NOT NULL CHECK (char_length(applied_version) = 67),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, token_digest)
);
CREATE INDEX IF NOT EXISTS openboard_workspace_restore_tokens_expiry_idx
  ON openboard_workspace_restore_tokens (expires_at) WHERE consumed_at IS NULL;
`)
}

func migrateV15(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 15, `
CREATE TABLE IF NOT EXISTS openboard_film_restore_tokens (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  token_digest text NOT NULL CHECK (char_length(token_digest) = 64),
  prior_exists boolean NOT NULL,
  prior_document jsonb,
  applied_revision integer NOT NULL CHECK (applied_revision > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, token_digest),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES openboard_projects (tenant_id, id) ON DELETE CASCADE,
  CHECK ((prior_exists AND prior_document IS NOT NULL) OR (NOT prior_exists AND prior_document IS NULL))
);
CREATE INDEX IF NOT EXISTS openboard_film_restore_tokens_expiry_idx
  ON openboard_film_restore_tokens (expires_at) WHERE consumed_at IS NULL;
`)
}

func migrateV14(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 14, `
CREATE TABLE IF NOT EXISTS openboard_film_projects (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES openboard_projects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS openboard_film_projects_tenant_updated_idx
  ON openboard_film_projects (tenant_id, updated_at DESC, project_id);
`)
}

func migrateV13(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 13, `
ALTER TABLE openboard_projects
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS openboard_projects_tenant_deleted_idx
  ON openboard_projects (tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;
ALTER TABLE openboard_generation_jobs
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
UPDATE openboard_generation_jobs
SET deleted_at = COALESCE(deleted_at, updated_at), result = '{}'::jsonb
WHERE status = 'deleted';
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_tenant_deleted_idx
  ON openboard_generation_jobs (tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;
`)
}

func migrateV12(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 12, `
UPDATE openboard_generation_jobs
SET parameters = parameters #- '{sharedChannel,secret}'
WHERE status IN ('succeeded','failed','cancelled','deleted')
  AND parameters #> '{sharedChannel,secret}' IS NOT NULL;
`)
}

func migrateV11(ctx context.Context, connection *pgxpool.Conn) error {
	return applyMigration(ctx, connection, 11, `
ALTER TABLE openboard_credit_logs
  ADD COLUMN IF NOT EXISTS actor_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS openboard_credit_logs_tenant_idempotency_uidx
  ON openboard_credit_logs (tenant_id, idempotency_key)
  WHERE idempotency_key <> '';
CREATE INDEX IF NOT EXISTS openboard_credit_logs_tenant_reason_created_idx
  ON openboard_credit_logs (tenant_id, reason, created_at DESC, id DESC);
`)
}

func migrateV10(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 10: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
ALTER TABLE openboard_users
  ADD COLUMN IF NOT EXISTS credits bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS linux_do_id text;
DO $$ BEGIN
  ALTER TABLE openboard_users DROP CONSTRAINT IF EXISTS openboard_users_status_check;
  ALTER TABLE openboard_users ADD CONSTRAINT openboard_users_status_check CHECK (status IN ('active','ban'));
EXCEPTION WHEN others THEN NULL;
END $$;
ALTER TABLE openboard_users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE openboard_users ALTER COLUMN password_hash SET DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS openboard_users_linux_do_id_uidx
  ON openboard_users (linux_do_id) WHERE linux_do_id IS NOT NULL AND linux_do_id <> '';
CREATE TABLE IF NOT EXISTS openboard_credit_logs (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES openboard_tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  job_id text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  delta bigint NOT NULL,
  balance_after bigint NOT NULL,
  reason text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_credit_logs_user_created_idx
  ON openboard_credit_logs (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS openboard_credit_logs_job_reason_idx
  ON openboard_credit_logs (tenant_id, job_id, reason);
CREATE TABLE IF NOT EXISTS openboard_media_references (
  token text PRIMARY KEY,
  tenant_id text NOT NULL,
  storage_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_media_references_expires_idx
  ON openboard_media_references (expires_at);
`); err != nil {
		return fmt.Errorf("apply schema migration 10: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if _, err := connection.Exec(ctx, `INSERT INTO openboard_schema_migrations(version) VALUES (10)`); err != nil {
		return fmt.Errorf("record schema migration 10: %w", err)
	}
	return nil
}
func migrateV9(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 9: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
CREATE TABLE IF NOT EXISTS openboard_ai_call_logs (
  tenant_id text NOT NULL,
  id text NOT NULL,
  job_id text NOT NULL DEFAULT '',
  user_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  channel_id text NOT NULL DEFAULT '',
  channel_name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  protocol text NOT NULL DEFAULT '',
  status text NOT NULL,
  duration_ms bigint NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS openboard_ai_call_logs_tenant_created_idx
  ON openboard_ai_call_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS openboard_ai_call_logs_tenant_kind_created_idx
  ON openboard_ai_call_logs (tenant_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS openboard_ai_call_logs_tenant_status_created_idx
  ON openboard_ai_call_logs (tenant_id, status, created_at DESC);
`); err != nil {
		return fmt.Errorf("create ai call logs table: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if _, err := connection.Exec(ctx, `INSERT INTO openboard_schema_migrations(version) VALUES (9)`); err != nil {
		return fmt.Errorf("record schema migration 9: %w", err)
	}
	return nil
}

func migrateV8(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 8: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
CREATE TABLE IF NOT EXISTS openboard_library_assets (
  tenant_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','image','video','audio')),
  title text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  content text NOT NULL DEFAULT '',
  cover_url text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS openboard_library_assets_tenant_updated_idx
  ON openboard_library_assets (tenant_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS openboard_library_assets_tenant_kind_idx
  ON openboard_library_assets (tenant_id, kind, updated_at DESC);
`); err != nil {
		return fmt.Errorf("create library assets table: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if _, err := connection.Exec(ctx, `INSERT INTO openboard_schema_migrations(version) VALUES (8)`); err != nil {
		return fmt.Errorf("record schema migration 8: %w", err)
	}
	return nil
}

func migrateV7(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 7: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT c.conname FROM pg_constraint c
		JOIN pg_class t ON c.conrelid=t.oid JOIN pg_namespace n ON t.relnamespace=n.oid
		WHERE c.contype='c' AND t.relname='openboard_generation_jobs'
		AND n.nspname=current_schema() AND pg_get_constraintdef(c.oid) LIKE '%status%'`)
	if err != nil {
		return fmt.Errorf("list generation job status constraints: %w", err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, name := range names {
		if !safeIdent(name) {
			return errors.New("unsafe generation status constraint")
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE openboard_generation_jobs DROP CONSTRAINT %s`, name)); err != nil {
			return fmt.Errorf("drop status constraint %s: %w", name, err)
		}
	}
	if _, err := tx.Exec(ctx, `ALTER TABLE openboard_generation_jobs
		ADD CONSTRAINT openboard_generation_jobs_status_check_v7
		CHECK (status IN ('queued','running','succeeded','failed','cancelled','deleted'))`); err != nil {
		return fmt.Errorf("add deleted status constraint: %w", err)
	}
	if _, err := tx.Exec(ctx, `CREATE INDEX IF NOT EXISTS openboard_generation_jobs_tenant_active_created_idx
		ON openboard_generation_jobs (tenant_id, created_at DESC, id DESC)
		WHERE status <> 'deleted'`); err != nil {
		return fmt.Errorf("active generation index: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if _, err := connection.Exec(ctx, `INSERT INTO openboard_schema_migrations(version) VALUES (7)`); err != nil {
		return fmt.Errorf("record schema migration 7: %w", err)
	}
	return nil
}

func migrateV6(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 6: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT c.conname FROM pg_constraint c
		JOIN pg_class t ON c.conrelid=t.oid JOIN pg_namespace n ON t.relnamespace=n.oid
		WHERE c.contype='c' AND t.relname='openboard_generation_jobs'
		  AND n.nspname=current_schema() AND pg_get_constraintdef(c.oid) LIKE '%kind%'`)
	if err != nil {
		return fmt.Errorf("find generation kind constraints: %w", err)
	}
	var constraints []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		constraints = append(constraints, name)
	}
	rows.Close()
	// Without this check a mid-iteration failure would truncate the list, leaving a
	// stale kind constraint in place while migration 6 is still recorded as applied.
	// CHECK constraints are ANDed, so a surviving v5 constraint would reject every
	// audio insert permanently.
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list generation kind constraints: %w", err)
	}
	for _, name := range constraints {
		if !safeIdent(name) {
			return errors.New("unsafe generation kind constraint")
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE openboard_generation_jobs DROP CONSTRAINT %s`, name)); err != nil {
			return fmt.Errorf("drop generation kind constraint: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `ALTER TABLE openboard_generation_jobs
		ADD CONSTRAINT openboard_generation_jobs_kind_check_v6 CHECK (kind IN ('image','video','audio','workflow'))`); err != nil {
		return fmt.Errorf("add generation kind constraint: %w", err)
	}
	if _, err := tx.Exec(ctx, migrationV6Indexes); err != nil {
		return fmt.Errorf("add media generation claim indexes: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES (6)`); err != nil {
		return fmt.Errorf("record schema migration 6: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema migration 6: %w", err)
	}
	return nil
}

func migrateV5(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 5: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT c.conname FROM pg_constraint c
		JOIN pg_class t ON c.conrelid=t.oid JOIN pg_namespace n ON t.relnamespace=n.oid
		WHERE c.contype='c' AND t.relname='openboard_generation_jobs'
		  AND n.nspname=current_schema() AND pg_get_constraintdef(c.oid) LIKE '%kind%'`)
	if err != nil {
		return fmt.Errorf("find generation kind constraints: %w", err)
	}
	var constraints []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		constraints = append(constraints, name)
	}
	rows.Close()
	// A truncated list here would leave a stale kind constraint behind while the
	// migration is still recorded as applied. See migrateV6 for the same guard.
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list generation kind constraints: %w", err)
	}
	for _, name := range constraints {
		if !safeIdent(name) {
			return errors.New("unsafe generation kind constraint")
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE openboard_generation_jobs DROP CONSTRAINT %s`, name)); err != nil {
			return fmt.Errorf("drop generation kind constraint: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `ALTER TABLE openboard_generation_jobs
		ADD CONSTRAINT openboard_generation_jobs_kind_check_v5 CHECK (kind IN ('image','video','workflow'))`); err != nil {
		return fmt.Errorf("add generation kind constraint: %w", err)
	}
	if _, err := tx.Exec(ctx, migrationV5Indexes); err != nil {
		return fmt.Errorf("add generation claim indexes: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES (5)`); err != nil {
		return fmt.Errorf("record schema migration 5: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema migration 5: %w", err)
	}
	return nil
}

func applyMigration(ctx context.Context, connection *pgxpool.Conn, version int, sql string) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration %d: %w", version, err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, sql); err != nil {
		return fmt.Errorf("apply schema migration %d: %w", version, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES ($1)`, version); err != nil {
		return fmt.Errorf("record schema migration %d: %w", version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema migration %d: %w", version, err)
	}
	return nil
}

func migrateV3(ctx context.Context, connection *pgxpool.Conn) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema migration 3: %w", err)
	}
	defer tx.Rollback(ctx)

	// Tenants, users, sessions, usage.
	if _, err := tx.Exec(ctx, `
CREATE TABLE IF NOT EXISTS openboard_tenants (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  plan text NOT NULL DEFAULT 'free',
  storage_quota_bytes bigint NOT NULL DEFAULT 1073741824,
  generation_quota_monthly bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS openboard_users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES openboard_tenants(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_users_tenant_idx ON openboard_users (tenant_id);
CREATE TABLE IF NOT EXISTS openboard_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES openboard_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_sessions_user_idx ON openboard_sessions (user_id);
CREATE INDEX IF NOT EXISTS openboard_sessions_expires_idx ON openboard_sessions (expires_at);
CREATE TABLE IF NOT EXISTS openboard_usage_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES openboard_tenants(id) ON DELETE CASCADE,
  user_id text,
  kind text NOT NULL,
  units int NOT NULL DEFAULT 1,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_usage_events_tenant_created_idx
  ON openboard_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS openboard_usage_events_tenant_kind_created_idx
  ON openboard_usage_events (tenant_id, kind, created_at DESC);
`); err != nil {
		return fmt.Errorf("apply schema migration 3 auth tables: %w", err)
	}

	// Seed local tenant.
	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, 'Local', 'free', $2, $3)
ON CONFLICT (id) DO NOTHING`, DefaultTenantID, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
		return fmt.Errorf("seed local tenant: %w", err)
	}

	// Add tenant_id to projects.
	if _, err := tx.Exec(ctx, `
ALTER TABLE openboard_projects
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local'`); err != nil {
		return fmt.Errorf("add projects.tenant_id: %w", err)
	}
	// Rebuild projects PK to (tenant_id, id).
	if err := rebuildPrimaryKey(ctx, tx, "openboard_projects", []string{"tenant_id", "id"}); err != nil {
		return fmt.Errorf("rebuild projects primary key: %w", err)
	}
	if _, err := tx.Exec(ctx, `
CREATE INDEX IF NOT EXISTS openboard_projects_tenant_updated_idx
  ON openboard_projects (tenant_id, updated_at DESC)`); err != nil {
		return fmt.Errorf("projects tenant index: %w", err)
	}

	// State: add tenant_id, change PK to (tenant_id, key).
	if _, err := tx.Exec(ctx, `
ALTER TABLE openboard_state
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local'`); err != nil {
		return fmt.Errorf("add state.tenant_id: %w", err)
	}
	if err := rebuildPrimaryKey(ctx, tx, "openboard_state", []string{"tenant_id", "key"}); err != nil {
		return fmt.Errorf("rebuild state primary key: %w", err)
	}

	// Generation jobs: add tenant_id, rebuild PK.
	if _, err := tx.Exec(ctx, `
ALTER TABLE openboard_generation_jobs
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local'`); err != nil {
		return fmt.Errorf("add generation_jobs.tenant_id: %w", err)
	}
	if err := rebuildPrimaryKey(ctx, tx, "openboard_generation_jobs", []string{"tenant_id", "id"}); err != nil {
		return fmt.Errorf("rebuild generation_jobs primary key: %w", err)
	}
	if _, err := tx.Exec(ctx, `
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_tenant_created_idx
  ON openboard_generation_jobs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS openboard_generation_jobs_tenant_project_kind_idx
  ON openboard_generation_jobs (tenant_id, project_id, kind, created_at DESC)`); err != nil {
		return fmt.Errorf("generation_jobs tenant indexes: %w", err)
	}

	if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES (3)`); err != nil {
		return fmt.Errorf("record schema migration 3: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema migration 3: %w", err)
	}
	return nil
}

func rebuildPrimaryKey(ctx context.Context, tx pgx.Tx, table string, columns []string) error {
	var constraintName string
	err := tx.QueryRow(ctx, `
SELECT c.conname
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE c.contype = 'p' AND t.relname = $1 AND n.nspname = current_schema()`, table).Scan(&constraintName)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if constraintName != "" {
		// Quote identifier safely (constraint names from catalog are safe, but be strict).
		if !safeIdent(constraintName) || !safeIdent(table) {
			return fmt.Errorf("unsafe identifier")
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s DROP CONSTRAINT %s`, table, constraintName)); err != nil {
			return err
		}
	}
	colList := strings.Join(columns, ", ")
	for _, col := range columns {
		if !safeIdent(col) {
			return fmt.Errorf("unsafe column identifier")
		}
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s ADD PRIMARY KEY (%s)`, table, colList)); err != nil {
		// If PK already matches (re-run safety), ignore duplicate_object.
		if !strings.Contains(err.Error(), "already exists") && !strings.Contains(err.Error(), "multiple primary keys") {
			return err
		}
	}
	return nil
}

func safeIdent(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func normalizeTenantID(tenantID string) string {
	if tenantID == "" {
		return DefaultTenantID
	}
	return tenantID
}

func (s *PostgresStore) Close() {
	if s.redis != nil {
		_ = s.redis.Close()
	}
	if s.pool != nil {
		s.pool.Close()
	}
}

func (s *PostgresStore) Ping(ctx context.Context) error {
	if err := s.pool.Ping(ctx); err != nil {
		return err
	}
	if s.redis != nil {
		return s.redis.Ping(ctx).Err()
	}
	return nil
}

// EnsureE2ETenant creates an isolated tenant used only by the explicitly gated
// browser-test harness. Product code never calls this method directly.
func (s *PostgresStore) EnsureE2ETenant(ctx context.Context, tenantID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, 'Browser E2E', 'free', $2, $3)
ON CONFLICT (id) DO NOTHING`,
		tenantID, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_users (id,tenant_id,email,password_hash,display_name,role,credits,status)
VALUES ($1,$2,$3,'','Browser E2E owner','owner',0,'active')
ON CONFLICT (id) DO NOTHING`, tenantID+"-user", tenantID, tenantID+"@e2e.invalid"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func projectCacheKey(tenantID, id string) string {
	return "openboard:project:" + tenantID + ":" + id
}

func (s *PostgresStore) ListProjects(ctx context.Context, tenantID string) ([]ProjectSummary, error) {
	tenantID = normalizeTenantID(tenantID)
	rows, err := s.pool.Query(ctx, `SELECT id, title, updated_at FROM openboard_projects
		WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ProjectSummary, 0)
	for rows.Next() {
		var item ProjectSummary
		var updated time.Time
		if err := rows.Scan(&item.ID, &item.Title, &updated); err != nil {
			return nil, err
		}
		item.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) GetProject(ctx context.Context, tenantID, id string) ([]byte, error) {
	tenantID = normalizeTenantID(tenantID)
	cacheKey := projectCacheKey(tenantID, id)
	if s.redis != nil {
		if value, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil {
			return value, nil
		}
	}
	var document []byte
	if err := s.pool.QueryRow(ctx, `SELECT document FROM openboard_projects
		WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
		tenantID, id).Scan(&document); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if s.redis != nil {
		_ = s.redis.Set(ctx, cacheKey, document, 5*time.Minute).Err()
	}
	return document, nil
}

func (s *PostgresStore) PutProject(ctx context.Context, tenantID, id string, document []byte) error {
	tenantID = normalizeTenantID(tenantID)
	var metadata struct {
		Title     string `json:"title"`
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.Unmarshal(document, &metadata); err != nil {
		return err
	}
	updated, err := time.Parse(time.RFC3339Nano, metadata.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid updatedAt: %w", err)
	}
	// A tombstoned row must survive an autosave from a tab that still holds the
	// pre-delete document; otherwise the delete silently undoes itself.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `INSERT INTO openboard_projects (tenant_id,id,title,updated_at,document)
		VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, id) DO UPDATE SET
		title=EXCLUDED.title, updated_at=EXCLUDED.updated_at, document=EXCLUDED.document
		WHERE openboard_projects.deleted_at IS NULL`,
		tenantID, id, metadata.Title, updated, document)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrGone
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, id)).Err()
	}
	return nil
}

func (s *PostgresStore) CompareAndSwapProject(ctx context.Context, tenantID, id string, expected, document []byte) error {
	tenantID = normalizeTenantID(tenantID)
	var metadata struct{ Title, UpdatedAt string }
	if err := json.Unmarshal(document, &metadata); err != nil {
		return err
	}
	updated, err := time.Parse(time.RFC3339Nano, metadata.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid updatedAt: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	var result pgconn.CommandTag
	if expected == nil {
		// Create-only. A live row or a tombstone both collide; distinguish them so a
		// migration that hits a deleted project can stop instead of retrying forever.
		result, err = tx.Exec(ctx, `INSERT INTO openboard_projects (tenant_id,id,title,updated_at,document)
			VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,id) DO NOTHING`, tenantID, id, metadata.Title, updated, document)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			var deletedAt *time.Time
			lookupErr := tx.QueryRow(ctx,
				`SELECT deleted_at FROM openboard_projects WHERE tenant_id=$1 AND id=$2`,
				tenantID, id).Scan(&deletedAt)
			if lookupErr != nil {
				return lookupErr
			}
			if deletedAt != nil {
				return ErrGone
			}
			return ErrConflict
		}
	} else {
		result, err = tx.Exec(ctx, `UPDATE openboard_projects SET title=$4,updated_at=$5,document=$6
			WHERE tenant_id=$1 AND id=$2 AND document=$3::jsonb AND deleted_at IS NULL`,
			tenantID, id, string(expected), metadata.Title, updated, document)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return ErrConflict
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, id)).Err()
	}
	return nil
}

func (s *PostgresStore) DeleteProject(ctx context.Context, tenantID, id string) error {
	tenantID = normalizeTenantID(tenantID)
	// Soft-delete and drop the document body: the tombstone only has to block
	// stale writes, it does not need to keep the canvas contents around.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE openboard_generation_jobs
		SET deleted_at=COALESCE(deleted_at,clock_timestamp()),result='{}'::jsonb
		WHERE tenant_id=$1 AND project_id=$2 AND deleted_at IS NULL`, tenantID, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, id); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE openboard_projects
		SET deleted_at=COALESCE(deleted_at, clock_timestamp()), document='{}'::jsonb
		WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, tenantID, id)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err == nil && s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, id)).Err()
	}
	return err
}

func enqueueFilmCleanupGenerationTx(ctx context.Context, tx pgx.Tx, tenantID, projectID, generationID string, documents []json.RawMessage, media []WorkspaceMedia) error {
	filtered := make([]WorkspaceMedia, 0, len(media))
	for _, item := range media {
		if item.ProjectID == projectID {
			filtered = append(filtered, item)
		}
	}
	documentsJSON, err := json.Marshal(documents)
	if err != nil {
		return err
	}
	mediaJSON, err := json.Marshal(filtered)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO openboard_film_cleanup_generations
		(tenant_id,project_id,generation_id,documents,media) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (tenant_id,project_id,generation_id) DO NOTHING`, tenantID, projectID, generationID, documentsJSON, mediaJSON)
	return err
}

func (s *PostgresStore) DeleteProjectWithFilmCleanup(ctx context.Context, tenantID, projectID, generationID string) error {
	tenantID = normalizeTenantID(tenantID)
	if projectID == "" || generationID == "" {
		return ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	documents := []json.RawMessage{}
	media := []WorkspaceMedia{}
	var current []byte
	if err := tx.QueryRow(ctx, `SELECT document FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&current); err == nil {
		documents = append(documents, append([]byte(nil), current...))
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT prior_document,created_media FROM openboard_film_restore_tokens
		WHERE tenant_id=$1 AND project_id=$2 AND consumed_at IS NULL`, tenantID, projectID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var prior []byte
		var created []byte
		if err := rows.Scan(&prior, &created); err != nil {
			rows.Close()
			return err
		}
		if len(prior) > 0 {
			documents = append(documents, append([]byte(nil), prior...))
		}
		var items []WorkspaceMedia
		if json.Unmarshal(created, &items) != nil {
			rows.Close()
			return ErrInvalidInput
		}
		media = append(media, items...)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT prior_snapshot,created_media FROM openboard_workspace_restore_tokens
		WHERE tenant_id=$1 AND consumed_at IS NULL`, tenantID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var priorJSON, createdJSON []byte
		if err := rows.Scan(&priorJSON, &createdJSON); err != nil {
			rows.Close()
			return err
		}
		var snapshot WorkspaceSnapshot
		if json.Unmarshal(priorJSON, &snapshot) != nil {
			rows.Close()
			return ErrInvalidInput
		}
		for _, film := range snapshot.Films {
			if film.ProjectID == projectID {
				documents = append(documents, append([]byte(nil), film.Document...))
			}
		}
		var items []WorkspaceMedia
		if json.Unmarshal(createdJSON, &items) != nil {
			rows.Close()
			return ErrInvalidInput
		}
		media = append(media, items...)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := enqueueFilmCleanupGenerationTx(ctx, tx, tenantID, projectID, generationID, documents, media); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_film_restore_tokens WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID); err != nil {
		return err
	}
	// A workspace token can resurrect this project, so deleting one project
	// invalidates tenant workspace rollback tokens after their media history is captured.
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_workspace_restore_tokens WHERE tenant_id=$1`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs
		SET deleted_at=COALESCE(deleted_at,clock_timestamp()),status='deleted',result='{}'::jsonb,
		lease_owner='',lease_expires_at=NULL WHERE tenant_id=$1 AND project_id=$2 AND deleted_at IS NULL`, tenantID, projectID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_projects SET deleted_at=COALESCE(deleted_at,clock_timestamp()),document='{}'::jsonb
		WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, tenantID, projectID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, projectID)).Err()
	}
	return nil
}

func (s *PostgresStore) ListFilmCleanupGenerations(ctx context.Context, tenantID, projectID string) ([]FilmCleanupGeneration, error) {
	tenantID = normalizeTenantID(tenantID)
	rows, err := s.pool.Query(ctx, `SELECT generation_id,documents,media FROM openboard_film_cleanup_generations
		WHERE tenant_id=$1 AND project_id=$2 AND completed_at IS NULL ORDER BY created_at,generation_id`, tenantID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FilmCleanupGeneration{}
	for rows.Next() {
		var item FilmCleanupGeneration
		var documentsJSON, mediaJSON []byte
		if err := rows.Scan(&item.GenerationID, &documentsJSON, &mediaJSON); err != nil {
			return nil, err
		}
		item.ProjectID = projectID
		if json.Unmarshal(documentsJSON, &item.Documents) != nil || json.Unmarshal(mediaJSON, &item.Media) != nil {
			return nil, ErrInvalidInput
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) CompleteFilmCleanupGeneration(ctx context.Context, tenantID, projectID, generationID string) error {
	tenantID = normalizeTenantID(tenantID)
	result, err := s.pool.Exec(ctx, `UPDATE openboard_film_cleanup_generations SET completed_at=clock_timestamp()
		WHERE tenant_id=$1 AND project_id=$2 AND generation_id=$3 AND completed_at IS NULL`, tenantID, projectID, generationID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) GetFilmProject(ctx context.Context, tenantID, projectID string) (FilmRecord, error) {
	tenantID = normalizeTenantID(tenantID)
	var record FilmRecord
	var updated time.Time
	err := s.pool.QueryRow(ctx, `SELECT project_id, revision, document, updated_at
		FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).
		Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilmRecord{}, ErrNotFound
	}
	if err != nil {
		return FilmRecord{}, err
	}
	record.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func syncFilmEntityProjection(ctx context.Context, tx pgx.Tx, tenantID, projectID string, aggregateRevision int, document []byte) error {
	entities, relations, err := buildFilmRelationalProjection(document, aggregateRevision)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID); err != nil {
		return err
	}
	for _, entity := range entities {
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_entities
			(tenant_id,project_id,entity_type,entity_id,revision,aggregate_revision,position,status,document)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, tenantID, projectID, entity.EntityType, entity.EntityID,
			entity.Revision, entity.AggregateRevision, entity.Position, entity.Status, entity.Document); err != nil {
			return err
		}
	}
	for _, relation := range relations {
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_entity_relations
			(tenant_id,project_id,relation_type,source_type,source_id,target_type,target_id,position,aggregate_revision)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, tenantID, projectID, relation.RelationType,
			relation.SourceType, relation.SourceID, relation.TargetType, relation.TargetID,
			relation.Position, relation.AggregateRevision); err != nil {
			return err
		}
	}
	return nil
}

func (s *PostgresStore) CreateFilmProject(ctx context.Context, tenantID, projectID string, document []byte) (FilmRecord, error) {
	tenantID = normalizeTenantID(tenantID)
	if !json.Valid(document) {
		return FilmRecord{}, ErrInvalidInput
	}
	var record FilmRecord
	var updated time.Time
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilmRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return FilmRecord{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO openboard_film_projects
		(tenant_id, project_id, revision, document) VALUES ($1,$2,1,$3)
		ON CONFLICT (tenant_id, project_id) DO NOTHING
		RETURNING project_id, revision, document, updated_at`, tenantID, projectID, document).
		Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilmRecord{}, ErrConflict
	}
	if err != nil {
		return FilmRecord{}, err
	}
	if err := syncFilmEntityProjection(ctx, tx, tenantID, projectID, record.Revision, document); err != nil {
		return FilmRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FilmRecord{}, err
	}
	record.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func (s *PostgresStore) CompareAndSwapFilmProject(
	ctx context.Context,
	tenantID string,
	projectID string,
	expectedRevision int,
	document []byte,
) (FilmRecord, error) {
	tenantID = normalizeTenantID(tenantID)
	if expectedRevision < 1 || !json.Valid(document) {
		return FilmRecord{}, ErrInvalidInput
	}
	var record FilmRecord
	var updated time.Time
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilmRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return FilmRecord{}, err
	}
	err = tx.QueryRow(ctx, `UPDATE openboard_film_projects
		SET revision=revision+1, document=$4, updated_at=clock_timestamp()
		WHERE tenant_id=$1 AND project_id=$2 AND revision=$3
		RETURNING project_id, revision, document, updated_at`, tenantID, projectID, expectedRevision, document).
		Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		lookupErr := tx.QueryRow(ctx, `SELECT true FROM openboard_film_projects
			WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&exists)
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return FilmRecord{}, ErrNotFound
		}
		if lookupErr != nil {
			return FilmRecord{}, lookupErr
		}
		return FilmRecord{}, ErrConflict
	}
	if err != nil {
		return FilmRecord{}, err
	}
	if err := syncFilmEntityProjection(ctx, tx, tenantID, projectID, record.Revision, document); err != nil {
		return FilmRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FilmRecord{}, err
	}
	record.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func (s *PostgresStore) CreateFilmGenerationBatch(
	ctx context.Context,
	tenantID, userID, projectID string,
	expectedRevision int,
	document []byte,
	reservations []FilmGenerationReservation,
) (FilmRecord, error) {
	return retryFilmGenerationBatch(func() (FilmRecord, error) {
		return s.createFilmGenerationBatchOnce(ctx, tenantID, userID, projectID, expectedRevision, document, reservations)
	})
}

func retryFilmGenerationBatch(operation func() (FilmRecord, error)) (FilmRecord, error) {
	var lastErr error
	for range 3 {
		record, err := operation()
		if !isSerializationFailure(err) {
			return record, err
		}
		lastErr = err
	}
	return FilmRecord{}, lastErr
}

func (s *PostgresStore) createFilmGenerationBatchOnce(
	ctx context.Context,
	tenantID, userID, projectID string,
	expectedRevision int,
	document []byte,
	reservations []FilmGenerationReservation,
) (FilmRecord, error) {
	tenantID = normalizeTenantID(tenantID)
	userID = strings.TrimSpace(userID)
	if len(userID) > 128 {
		return FilmRecord{}, ErrInvalidInput
	}
	if expectedRevision < 1 || !json.Valid(document) || len(reservations) == 0 || len(reservations) > 1_000 {
		return FilmRecord{}, ErrInvalidInput
	}
	if strings.TrimSpace(userID) == "" {
		for _, reservation := range reservations {
			if generationJobConsumesQuota(reservation.Job.Kind) {
				return FilmRecord{}, ErrUnauthorized
			}
		}
	}
	type preparedReservation struct {
		reservation FilmGenerationReservation
		created     time.Time
		updated     time.Time
	}
	prepared := make([]preparedReservation, len(reservations))
	totalUnits := 0
	for index, reservation := range reservations {
		job := reservation.Job
		if job.Status != "queued" || job.ProjectID != projectID || job.ID == "" || job.Kind == "" || !json.Valid(job.Parameters) || !json.Valid(job.Result) {
			return FilmRecord{}, ErrInvalidInput
		}
		created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
		if err != nil {
			return FilmRecord{}, fmt.Errorf("invalid generation createdAt: %w", err)
		}
		updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
		if err != nil {
			return FilmRecord{}, fmt.Errorf("invalid generation updatedAt: %w", err)
		}
		if len(reservation.UsageMeta) == 0 {
			reservation.UsageMeta = json.RawMessage(`{}`)
		}
		if !json.Valid(reservation.UsageMeta) {
			return FilmRecord{}, ErrInvalidInput
		}
		if generationJobConsumesQuota(job.Kind) {
			if reservation.Units < 1 {
				reservation.Units = 1
			}
			totalUnits += reservation.Units
		}
		prepared[index] = preparedReservation{reservation: reservation, created: created, updated: updated}
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return FilmRecord{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return FilmRecord{}, err
	}
	var record FilmRecord
	var filmUpdated time.Time
	err = tx.QueryRow(ctx, `UPDATE openboard_film_projects
		SET revision=revision+1, document=$4, updated_at=clock_timestamp()
		WHERE tenant_id=$1 AND project_id=$2 AND revision=$3
		RETURNING project_id, revision, document, updated_at`, tenantID, projectID, expectedRevision, document).
		Scan(&record.ProjectID, &record.Revision, &record.Document, &filmUpdated)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		lookupErr := tx.QueryRow(ctx, `SELECT true FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&exists)
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return FilmRecord{}, ErrNotFound
		}
		if lookupErr != nil {
			return FilmRecord{}, lookupErr
		}
		return FilmRecord{}, ErrConflict
	}
	if err != nil {
		return FilmRecord{}, err
	}
	if totalUnits > 0 {
		var quota int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(
			(SELECT generation_quota_monthly FROM openboard_tenants WHERE id=$1), $2)`,
			tenantID, defaultGenerationQuotaMonthly).Scan(&quota); err != nil {
			return FilmRecord{}, err
		}
		now := time.Now().UTC()
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		var used int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(units), 0) FROM openboard_usage_events
			WHERE tenant_id=$1 AND kind='generation' AND created_at >= $2`, tenantID, monthStart).Scan(&used); err != nil {
			return FilmRecord{}, err
		}
		if generationQuotaExceeded(used, totalUnits, quota) {
			return FilmRecord{}, ErrQuotaExceeded
		}
	}
	for _, item := range prepared {
		reservation, job := item.reservation, item.reservation.Job
		inserted, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
			(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			ON CONFLICT (tenant_id, id) DO NOTHING`, tenantID, userID, job.ID, job.ProjectID, job.Kind,
			job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
			item.created, item.updated)
		if err != nil {
			return FilmRecord{}, err
		}
		if inserted.RowsAffected() == 0 {
			return FilmRecord{}, generationJobConflictError(ctx, tx, tenantID, job.ID)
		}
		if !generationJobConsumesQuota(job.Kind) {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
			VALUES ($1,$2,'generation',$3,$4)`, tenantID, userID, reservation.Units, reservation.UsageMeta); err != nil {
			return FilmRecord{}, err
		}
		cost, err := s.modelCreditCostTx(ctx, tx, tenantID, job.Model)
		if err != nil {
			return FilmRecord{}, err
		}
		totalCredits := cost * reservation.Units
		if reservation.ExpectedCredits != nil && *reservation.ExpectedCredits != totalCredits {
			return FilmRecord{}, ErrConflict
		}
		if err := s.reserveCreditsTx(ctx, tx, tenantID, userID, job.ID, job.Model, totalCredits, reservation.UsageMeta); err != nil {
			return FilmRecord{}, err
		}
	}
	if err := syncFilmEntityProjection(ctx, tx, tenantID, projectID, record.Revision, document); err != nil {
		return FilmRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FilmRecord{}, err
	}
	record.UpdatedAt = filmUpdated.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func (s *PostgresStore) RestoreFilmProject(
	ctx context.Context,
	tenantID string,
	projectID string,
	expectedRevision int,
	document []byte,
	tokenDigest string,
	expiresAt time.Time,
	createdMedia []WorkspaceMedia,
) (FilmRecord, error) {
	tenantID = normalizeTenantID(tenantID)
	if expectedRevision < 0 || !json.Valid(document) || len(tokenDigest) != 64 || !expiresAt.After(time.Now()) {
		return FilmRecord{}, ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilmRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return FilmRecord{}, err
	}
	var priorRevision int
	var priorDocument []byte
	lookupErr := tx.QueryRow(ctx, `SELECT revision, document FROM openboard_film_projects
		WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`, tenantID, projectID).Scan(&priorRevision, &priorDocument)
	priorExists := lookupErr == nil
	if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return FilmRecord{}, lookupErr
	}
	if priorExists && priorRevision != expectedRevision || !priorExists && expectedRevision != 0 {
		if !priorExists {
			return FilmRecord{}, ErrNotFound
		}
		return FilmRecord{}, ErrConflict
	}
	var record FilmRecord
	var updated time.Time
	if priorExists {
		err = tx.QueryRow(ctx, `UPDATE openboard_film_projects
			SET revision=revision+1, document=$4, updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND project_id=$2 AND revision=$3
			RETURNING project_id, revision, document, updated_at`, tenantID, projectID, expectedRevision, document).
			Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
	} else {
		err = tx.QueryRow(ctx, `INSERT INTO openboard_film_projects
			(tenant_id, project_id, revision, document) VALUES ($1,$2,1,$3)
			RETURNING project_id, revision, document, updated_at`, tenantID, projectID, document).
			Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
	}
	if err != nil {
		return FilmRecord{}, err
	}
	if err := syncFilmEntityProjection(ctx, tx, tenantID, projectID, record.Revision, document); err != nil {
		return FilmRecord{}, err
	}
	var prior any
	if priorExists {
		prior = priorDocument
	}
	createdMediaJSON, err := json.Marshal(createdMedia)
	if err != nil {
		return FilmRecord{}, ErrInvalidInput
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_restore_tokens
		(tenant_id,project_id,token_digest,prior_exists,prior_document,applied_revision,expires_at,created_media)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, tenantID, projectID, tokenDigest, priorExists, prior, record.Revision, expiresAt, createdMediaJSON); err != nil {
		return FilmRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FilmRecord{}, err
	}
	record.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func (s *PostgresStore) RollbackFilmProject(
	ctx context.Context,
	tenantID string,
	projectID string,
	expectedRevision int,
	tokenDigest string,
	now time.Time,
) (FilmRecord, bool, error) {
	tenantID = normalizeTenantID(tenantID)
	if expectedRevision < 1 || len(tokenDigest) != 64 {
		return FilmRecord{}, false, ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilmRecord{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return FilmRecord{}, false, err
	}
	var priorExists bool
	var priorDocument []byte
	var appliedRevision int
	var createdMediaJSON []byte
	err = tx.QueryRow(ctx, `SELECT prior_exists, prior_document, applied_revision, created_media
		FROM openboard_film_restore_tokens
		WHERE tenant_id=$1 AND project_id=$2 AND token_digest=$3
		  AND consumed_at IS NULL AND expires_at>$4 FOR UPDATE`, tenantID, projectID, tokenDigest, now).
		Scan(&priorExists, &priorDocument, &appliedRevision, &createdMediaJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilmRecord{}, false, ErrNotFound
	}
	if err != nil {
		return FilmRecord{}, false, err
	}
	if expectedRevision != appliedRevision {
		return FilmRecord{}, false, ErrConflict
	}
	var record FilmRecord
	if priorExists {
		var updated time.Time
		err = tx.QueryRow(ctx, `UPDATE openboard_film_projects
			SET revision=revision+1, document=$4, updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND project_id=$2 AND revision=$3
			RETURNING project_id, revision, document, updated_at`, tenantID, projectID, expectedRevision, priorDocument).
			Scan(&record.ProjectID, &record.Revision, &record.Document, &updated)
		if errors.Is(err, pgx.ErrNoRows) {
			return FilmRecord{}, false, ErrConflict
		}
		if err != nil {
			return FilmRecord{}, false, err
		}
		if err := syncFilmEntityProjection(ctx, tx, tenantID, projectID, record.Revision, priorDocument); err != nil {
			return FilmRecord{}, false, err
		}
		record.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	} else {
		result, deleteErr := tx.Exec(ctx, `DELETE FROM openboard_film_projects
			WHERE tenant_id=$1 AND project_id=$2 AND revision=$3`, tenantID, projectID, expectedRevision)
		if deleteErr != nil {
			return FilmRecord{}, false, deleteErr
		}
		if result.RowsAffected() != 1 {
			return FilmRecord{}, false, ErrConflict
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_film_restore_tokens SET consumed_at=$4
		WHERE tenant_id=$1 AND project_id=$2 AND token_digest=$3`, tenantID, projectID, tokenDigest, now); err != nil {
		return FilmRecord{}, false, err
	}
	var createdMedia []WorkspaceMedia
	if json.Unmarshal(createdMediaJSON, &createdMedia) != nil {
		return FilmRecord{}, false, ErrInvalidInput
	}
	if len(createdMedia) > 0 {
		generationID := "restore-" + tokenDigest[:24]
		if err := enqueueFilmCleanupGenerationTx(ctx, tx, tenantID, projectID, generationID, nil, createdMedia); err != nil {
			return FilmRecord{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return FilmRecord{}, false, err
	}
	return record, priorExists, nil
}

func loadWorkspaceSnapshot(ctx context.Context, tx pgx.Tx, tenantID string) (WorkspaceSnapshot, error) {
	snapshot := WorkspaceSnapshot{Projects: []WorkspaceProject{}, Films: []WorkspaceFilm{}, GenerationJobs: []WorkspaceGenerationJob{}, States: []WorkspaceState{}}
	rows, err := tx.Query(ctx, `SELECT id, document FROM openboard_projects
		WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY id`, tenantID)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	for rows.Next() {
		var item WorkspaceProject
		if err := rows.Scan(&item.ID, &item.Document); err != nil {
			rows.Close()
			return WorkspaceSnapshot{}, err
		}
		snapshot.Projects = append(snapshot.Projects, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	rows, err = tx.Query(ctx, `SELECT project_id, revision, document FROM openboard_film_projects
		WHERE tenant_id=$1 ORDER BY project_id`, tenantID)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item WorkspaceFilm
		if err := rows.Scan(&item.ProjectID, &item.Revision, &item.Document); err != nil {
			return WorkspaceSnapshot{}, err
		}
		snapshot.Films = append(snapshot.Films, item)
	}
	if err := rows.Err(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT id,user_id,COALESCE(project_id,''),kind,status,prompt,provider_id,model,
		parameters,result,error,created_at,updated_at,lease_owner,lease_expires_at,deleted_at
		FROM openboard_generation_jobs WHERE tenant_id=$1 ORDER BY id`, tenantID)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	for rows.Next() {
		var item WorkspaceGenerationJob
		var created, updated time.Time
		var leaseExpires, deletedAt *time.Time
		if err := rows.Scan(&item.Job.ID, &item.UserID, &item.Job.ProjectID, &item.Job.Kind, &item.Job.Status, &item.Job.Prompt,
			&item.Job.ProviderID, &item.Job.Model, &item.Job.Parameters, &item.Job.Result, &item.Job.Error,
			&created, &updated, &item.Job.LeaseOwner, &leaseExpires, &deletedAt); err != nil {
			rows.Close()
			return WorkspaceSnapshot{}, err
		}
		item.Job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		item.Job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		item.Job.UserID = item.UserID
		if leaseExpires != nil {
			item.Job.LeaseExpiresAt = leaseExpires.UTC().Format(time.RFC3339Nano)
		}
		if deletedAt != nil {
			item.DeletedAt = deletedAt.UTC().Format(time.RFC3339Nano)
		}
		snapshot.GenerationJobs = append(snapshot.GenerationJobs, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkspaceSnapshot{}, err
	}
	rows.Close()
	for _, key := range workspaceManagedStateKeys {
		var value []byte
		err := tx.QueryRow(ctx, `SELECT value FROM openboard_state WHERE tenant_id=$1 AND key=$2`, tenantID, key).Scan(&value)
		if errors.Is(err, pgx.ErrNoRows) {
			snapshot.States = append(snapshot.States, WorkspaceState{Key: key})
			continue
		}
		if err != nil {
			return WorkspaceSnapshot{}, err
		}
		snapshot.States = append(snapshot.States, WorkspaceState{Key: key, Exists: true, Value: value})
	}
	return snapshot, nil
}

var workspaceManagedStateKeys = []string{"assets", "prompts"}

func validateWorkspaceFilmRevisions(current, desired WorkspaceSnapshot) error {
	revisions := make(map[string]int, len(current.Films))
	for _, film := range current.Films {
		revisions[film.ProjectID] = film.Revision
	}
	for _, film := range desired.Films {
		if film.Revision != revisions[film.ProjectID] {
			return ErrConflict
		}
	}
	return nil
}

func workspaceHasActiveServerGenerationJobs(snapshot WorkspaceSnapshot) bool {
	for _, item := range snapshot.GenerationJobs {
		if (item.Job.Status == "queued" || item.Job.Status == "running") && serverOwnedGenerationJob(item.Job) {
			return true
		}
	}
	return false
}

func upsertWorkspaceProject(ctx context.Context, tx pgx.Tx, tenantID string, project WorkspaceProject) error {
	var metadata struct {
		Title     string `json:"title"`
		UpdatedAt string `json:"updatedAt"`
	}
	if json.Unmarshal(project.Document, &metadata) != nil {
		return ErrInvalidInput
	}
	updated, err := time.Parse(time.RFC3339Nano, metadata.UpdatedAt)
	if err != nil {
		return ErrInvalidInput
	}
	_, err = tx.Exec(ctx, `INSERT INTO openboard_projects
		(tenant_id,id,title,updated_at,document,deleted_at) VALUES ($1,$2,$3,$4,$5,NULL)
		ON CONFLICT (tenant_id,id) DO UPDATE SET title=EXCLUDED.title,
		updated_at=EXCLUDED.updated_at,document=EXCLUDED.document,deleted_at=NULL`,
		tenantID, project.ID, metadata.Title, updated, project.Document)
	return err
}

func applyWorkspaceSnapshot(ctx context.Context, tx pgx.Tx, tenantID string, snapshot WorkspaceSnapshot) error {
	filmRevisions := map[string]int{}
	rows, err := tx.Query(ctx, `SELECT project_id, revision FROM openboard_film_projects WHERE tenant_id=$1`, tenantID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var projectID string
		var revision int
		if err := rows.Scan(&projectID, &revision); err != nil {
			rows.Close()
			return err
		}
		filmRevisions[projectID] = revision
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	projectIDs := make([]string, 0, len(snapshot.Projects))
	for _, project := range snapshot.Projects {
		projectIDs = append(projectIDs, project.ID)
		if err := upsertWorkspaceProject(ctx, tx, tenantID, project); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_film_projects WHERE tenant_id=$1`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_projects
		SET deleted_at=COALESCE(deleted_at,clock_timestamp()),document='{}'::jsonb
		WHERE tenant_id=$1 AND deleted_at IS NULL AND NOT (id=ANY($2))`, tenantID, projectIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1`, tenantID); err != nil {
		return err
	}
	for _, item := range snapshot.GenerationJobs {
		userID := strings.TrimSpace(item.UserID)
		if userID == "" {
			userID = strings.TrimSpace(item.Job.UserID)
		}
		if len(userID) > 128 {
			return ErrInvalidInput
		}
		created, err := time.Parse(time.RFC3339Nano, item.Job.CreatedAt)
		if err != nil {
			return ErrInvalidInput
		}
		updated, err := time.Parse(time.RFC3339Nano, item.Job.UpdatedAt)
		if err != nil {
			return ErrInvalidInput
		}
		var leaseExpires, deletedAt any
		if item.Job.LeaseExpiresAt != "" {
			parsed, err := time.Parse(time.RFC3339Nano, item.Job.LeaseExpiresAt)
			if err != nil {
				return ErrInvalidInput
			}
			leaseExpires = parsed
		}
		if item.DeletedAt != "" {
			parsed, err := time.Parse(time.RFC3339Nano, item.DeletedAt)
			if err != nil {
				return ErrInvalidInput
			}
			deletedAt = parsed
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
			(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,
			 created_at,updated_at,lease_owner,lease_expires_at,deleted_at)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
			tenantID, userID, item.Job.ID, item.Job.ProjectID, item.Job.Kind, item.Job.Status, item.Job.Prompt,
			item.Job.ProviderID, item.Job.Model, item.Job.Parameters, item.Job.Result, item.Job.Error,
			created, updated, item.Job.LeaseOwner, leaseExpires, deletedAt); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_state WHERE tenant_id=$1 AND key=ANY($2)`, tenantID, workspaceManagedStateKeys); err != nil {
		return err
	}
	seenStateKeys := make(map[string]struct{}, len(snapshot.States))
	for _, state := range snapshot.States {
		if !slices.Contains(workspaceManagedStateKeys, state.Key) {
			return ErrInvalidInput
		}
		if _, duplicate := seenStateKeys[state.Key]; duplicate {
			return ErrInvalidInput
		}
		seenStateKeys[state.Key] = struct{}{}
		if !state.Exists {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at)
			VALUES ($1,$2,$3,clock_timestamp())`, tenantID, state.Key, state.Value); err != nil {
			return err
		}
	}
	for _, film := range snapshot.Films {
		revision := film.Revision
		if filmRevisions[film.ProjectID] > revision {
			revision = filmRevisions[film.ProjectID]
		}
		revision++
		if revision < 1 {
			revision = 1
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_projects
			(tenant_id,project_id,revision,document) VALUES ($1,$2,$3,$4)`, tenantID, film.ProjectID, revision, film.Document); err != nil {
			return err
		}
		if err := syncFilmEntityProjection(ctx, tx, tenantID, film.ProjectID, revision, film.Document); err != nil {
			return err
		}
	}
	return nil
}

// applyWorkspaceProjectSnapshot updates only the selected project aggregate.
// It intentionally leaves generation history, state, and unrelated projects
// untouched; recreating those tables for a one-project import loses ownership
// metadata and races independent user activity.
func applyWorkspaceProjectSnapshot(ctx context.Context, tx pgx.Tx, tenantID string, project WorkspaceProject, film *WorkspaceFilm) error {
	if err := upsertWorkspaceProject(ctx, tx, tenantID, project); err != nil {
		return err
	}
	currentRevision := 0
	err := tx.QueryRow(ctx, `SELECT revision FROM openboard_film_projects
		WHERE tenant_id=$1 AND project_id=$2`, tenantID, project.ID).Scan(&currentRevision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_film_projects WHERE tenant_id=$1 AND project_id=$2`, tenantID, project.ID); err != nil {
		return err
	}
	if film == nil {
		return nil
	}
	revision := currentRevision
	if film.Revision > revision {
		revision = film.Revision
	}
	revision++
	if revision < 1 {
		revision = 1
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_projects
		(tenant_id,project_id,revision,document) VALUES ($1,$2,$3,$4)`, tenantID, film.ProjectID, revision, film.Document); err != nil {
		return err
	}
	return syncFilmEntityProjection(ctx, tx, tenantID, film.ProjectID, revision, film.Document)
}

func lockWorkspace(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('openboard-workspace:' || $1, 0))`, tenantID)
	return err
}

func (s *PostgresStore) WorkspaceVersion(ctx context.Context, tenantID string) (string, error) {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return "", err
	}
	snapshot, err := loadWorkspaceSnapshot(ctx, tx, tenantID)
	if err != nil {
		return "", err
	}
	return ComputeWorkspaceVersion(snapshot)
}

func (s *PostgresStore) ReplaceWorkspace(ctx context.Context, tenantID, expectedVersion, tokenDigest string, expiresAt time.Time, snapshot WorkspaceSnapshot, createdMedia []WorkspaceMedia) (WorkspaceReplaceResult, error) {
	tenantID = normalizeTenantID(tenantID)
	desiredVersion, err := ComputeWorkspaceVersion(snapshot)
	if err != nil || len(tokenDigest) != 64 || expectedVersion == "" || !expiresAt.After(time.Now()) {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	prior, err := loadWorkspaceSnapshot(ctx, tx, tenantID)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	currentVersion, err := ComputeWorkspaceVersion(prior)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if currentVersion != expectedVersion {
		return WorkspaceReplaceResult{}, ErrConflict
	}
	if workspaceHasActiveServerGenerationJobs(prior) {
		return WorkspaceReplaceResult{}, ErrConflict
	}
	if workspaceHasActiveServerGenerationJobs(snapshot) {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	if err := validateWorkspaceFilmRevisions(prior, snapshot); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	priorJSON, err := json.Marshal(prior)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if err := applyWorkspaceSnapshot(ctx, tx, tenantID, snapshot); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	createdMediaJSON, err := json.Marshal(createdMedia)
	if err != nil {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_workspace_restore_tokens
		(tenant_id,token_digest,prior_snapshot,applied_version,expires_at,created_media) VALUES ($1,$2,$3,$4,$5,$6)`,
		tenantID, tokenDigest, priorJSON, desiredVersion, expiresAt, createdMediaJSON); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if s.redis != nil {
		for _, project := range append(prior.Projects, snapshot.Projects...) {
			_ = s.redis.Del(ctx, projectCacheKey(tenantID, project.ID)).Err()
		}
	}
	return WorkspaceReplaceResult{Version: desiredVersion}, nil
}

func (s *PostgresStore) ReplaceWorkspaceProject(ctx context.Context, tenantID, projectID, expectedVersion, tokenDigest string, expiresAt time.Time, project WorkspaceProject, film *WorkspaceFilm, createdMedia []WorkspaceMedia) (WorkspaceReplaceResult, error) {
	tenantID = normalizeTenantID(tenantID)
	if project.ID != projectID || film != nil && film.ProjectID != projectID || expectedVersion == "" || len(tokenDigest) != 64 || !expiresAt.After(time.Now()) {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	prior, err := loadWorkspaceSnapshot(ctx, tx, tenantID)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	currentVersion, err := ComputeWorkspaceVersion(prior)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if currentVersion != expectedVersion {
		return WorkspaceReplaceResult{}, ErrConflict
	}
	desired := WorkspaceSnapshot{
		Projects: append([]WorkspaceProject(nil), prior.Projects...), Films: append([]WorkspaceFilm(nil), prior.Films...),
		GenerationJobs: append([]WorkspaceGenerationJob(nil), prior.GenerationJobs...), States: append([]WorkspaceState(nil), prior.States...),
	}
	replaced := false
	for index := range desired.Projects {
		if desired.Projects[index].ID == projectID {
			desired.Projects[index] = project
			replaced = true
			break
		}
	}
	if !replaced {
		desired.Projects = append(desired.Projects, project)
	}
	nextFilms := make([]WorkspaceFilm, 0, len(desired.Films)+1)
	for _, current := range desired.Films {
		if current.ProjectID != projectID {
			nextFilms = append(nextFilms, current)
		}
	}
	if film != nil {
		nextFilms = append(nextFilms, *film)
	}
	desired.Films = nextFilms
	if err := validateWorkspaceFilmRevisions(prior, desired); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	desiredVersion, err := ComputeWorkspaceVersion(desired)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	priorJSON, _ := json.Marshal(prior)
	createdMediaJSON, _ := json.Marshal(createdMedia)
	if err := applyWorkspaceProjectSnapshot(ctx, tx, tenantID, project, film); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_workspace_restore_tokens
		(tenant_id,token_digest,prior_snapshot,applied_version,expires_at,created_media)
		VALUES ($1,$2,$3,$4,$5,$6)`, tenantID, tokenDigest, priorJSON, desiredVersion, expiresAt, createdMediaJSON); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, projectID)).Err()
	}
	return WorkspaceReplaceResult{Version: desiredVersion}, nil
}

func (s *PostgresStore) RollbackWorkspace(ctx context.Context, tenantID, expectedVersion, tokenDigest string, now time.Time) (WorkspaceReplaceResult, error) {
	tenantID = normalizeTenantID(tenantID)
	if expectedVersion == "" || len(tokenDigest) != 64 {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	var priorJSON []byte
	var appliedVersion string
	var createdMediaJSON []byte
	err = tx.QueryRow(ctx, `SELECT prior_snapshot,applied_version,created_media FROM openboard_workspace_restore_tokens
		WHERE tenant_id=$1 AND token_digest=$2 AND consumed_at IS NULL AND expires_at>$3 FOR UPDATE`, tenantID, tokenDigest, now).
		Scan(&priorJSON, &appliedVersion, &createdMediaJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkspaceReplaceResult{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	current, err := loadWorkspaceSnapshot(ctx, tx, tenantID)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	currentVersion, err := ComputeWorkspaceVersion(current)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if currentVersion != expectedVersion || appliedVersion != expectedVersion {
		return WorkspaceReplaceResult{}, ErrConflict
	}
	var prior WorkspaceSnapshot
	if json.Unmarshal(priorJSON, &prior) != nil {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	if workspaceHasActiveServerGenerationJobs(current) || workspaceHasActiveServerGenerationJobs(prior) {
		return WorkspaceReplaceResult{}, ErrConflict
	}
	if err := applyWorkspaceSnapshot(ctx, tx, tenantID, prior); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	version, err := ComputeWorkspaceVersion(prior)
	if err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_workspace_restore_tokens SET consumed_at=$3
		WHERE tenant_id=$1 AND token_digest=$2`, tenantID, tokenDigest, now); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	var createdMedia []WorkspaceMedia
	if json.Unmarshal(createdMediaJSON, &createdMedia) != nil {
		return WorkspaceReplaceResult{}, ErrInvalidInput
	}
	cleanupProjects := map[string]struct{}{}
	for _, media := range createdMedia {
		cleanupProjects[media.ProjectID] = struct{}{}
	}
	for projectID := range cleanupProjects {
		generationID := "workspace-" + tokenDigest[:24]
		if err := enqueueFilmCleanupGenerationTx(ctx, tx, tenantID, projectID, generationID, nil, createdMedia); err != nil {
			return WorkspaceReplaceResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceReplaceResult{}, err
	}
	if s.redis != nil {
		for _, project := range append(current.Projects, prior.Projects...) {
			_ = s.redis.Del(ctx, projectCacheKey(tenantID, project.ID)).Err()
		}
	}
	projectIDs := make([]string, 0, len(cleanupProjects))
	for projectID := range cleanupProjects {
		projectIDs = append(projectIDs, projectID)
	}
	return WorkspaceReplaceResult{Version: version, CleanupProjectIDs: projectIDs}, nil
}

func (s *PostgresStore) GetState(ctx context.Context, tenantID, key string) ([]byte, error) {
	tenantID = normalizeTenantID(tenantID)
	var value []byte
	if err := s.pool.QueryRow(ctx, `SELECT value FROM openboard_state WHERE tenant_id=$1 AND key=$2`,
		tenantID, key).Scan(&value); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return value, nil
}

func (s *PostgresStore) GetStates(ctx context.Context, tenantID string, keys []string) (map[string][]byte, error) {
	tenantID = normalizeTenantID(tenantID)
	rows, err := s.pool.Query(ctx, `SELECT key, value FROM openboard_state
		WHERE tenant_id=$1 AND key=ANY($2)`, tenantID, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make(map[string][]byte, len(keys))
	for rows.Next() {
		var key string
		var value []byte
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		values[key] = value
	}
	return values, rows.Err()
}

func (s *PostgresStore) ListStateTenants(ctx context.Context, key string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT tenant_id FROM openboard_state WHERE key=$1 ORDER BY tenant_id`, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tenantIDs := make([]string, 0)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, err
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tenantIDs, nil
}

func (s *PostgresStore) PutState(ctx context.Context, tenantID, key string, value []byte) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at) VALUES ($1,$2,$3,now())
		ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, tenantID, key, value)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CompareAndSwapState(ctx context.Context, tenantID, key string, expected, value []byte) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	if expected == nil {
		result, err := tx.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at)
			VALUES ($1,$2,$3,now()) ON CONFLICT (tenant_id,key) DO NOTHING`, tenantID, key, string(value))
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return ErrConflict
		}
		return tx.Commit(ctx)
	}
	result, err := tx.Exec(ctx, `UPDATE openboard_state SET value=$4, updated_at=now()
		WHERE tenant_id=$1 AND key=$2 AND value=$3::jsonb`, tenantID, key, string(expected), string(value))
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CompareAndSwapStates(ctx context.Context, tenantID string, mutations []StateMutation) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	for _, mutation := range mutations {
		var current []byte
		err := tx.QueryRow(ctx, `SELECT value FROM openboard_state
			WHERE tenant_id=$1 AND key=$2 FOR UPDATE`, tenantID, mutation.Key).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			if mutation.Expected != nil {
				return ErrConflict
			}
			continue
		}
		if err != nil {
			return err
		}
		if mutation.Expected == nil || !bytes.Equal(current, mutation.Expected) {
			return ErrConflict
		}
	}
	for _, mutation := range mutations {
		var result pgconn.CommandTag
		if mutation.Expected == nil {
			result, err = tx.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at)
				VALUES ($1,$2,$3,now()) ON CONFLICT (tenant_id,key) DO NOTHING`,
				tenantID, mutation.Key, string(mutation.Value))
		} else {
			result, err = tx.Exec(ctx, `UPDATE openboard_state SET value=$4, updated_at=now()
				WHERE tenant_id=$1 AND key=$2 AND value=$3::jsonb`,
				tenantID, mutation.Key, string(mutation.Expected), string(mutation.Value))
		}
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return ErrConflict
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ListGenerationJobs(ctx context.Context, tenantID string, query GenerationJobQuery) (GenerationJobPage, error) {
	tenantID = normalizeTenantID(tenantID)
	query.UserID = strings.TrimSpace(query.UserID)
	query.Status = strings.TrimSpace(query.Status)
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 20
	}
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND ($2='' OR user_id=$2) AND ($3='' OR project_id=$3)
		  AND ($4='' OR kind=$4)
		  AND (
		    $5='' OR $5='all'
		    OR ($5='succeeded' AND status IN ('succeeded', 'running', 'queued'))
		    OR ($5='failed' AND status IN ('failed', 'cancelled'))
		    OR status=$5
		  )
		  AND ($6 OR status <> 'deleted')`,
		tenantID, query.UserID, query.ProjectID, query.Kind, query.Status, query.IncludeDeleted).Scan(&total); err != nil {
		return GenerationJobPage{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, user_id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND ($2='' OR user_id=$2) AND ($3='' OR project_id=$3)
		  AND ($4='' OR kind=$4)
		  AND (
		    $5='' OR $5='all'
		    OR ($5='succeeded' AND status IN ('succeeded', 'running', 'queued'))
		    OR ($5='failed' AND status IN ('failed', 'cancelled'))
		    OR status=$5
		  )
		  AND ($6 OR status <> 'deleted')
		ORDER BY created_at DESC, id DESC LIMIT $7 OFFSET $8`,
		tenantID, query.UserID, query.ProjectID, query.Kind, query.Status, query.IncludeDeleted, query.PageSize, (query.Page-1)*query.PageSize)
	if err != nil {
		return GenerationJobPage{}, err
	}
	defer rows.Close()
	items := make([]GenerationJob, 0)
	for rows.Next() {
		var job GenerationJob
		var created, updated time.Time
		if err := rows.Scan(&job.ID, &job.UserID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt,
			&job.ProviderID, &job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated); err != nil {
			return GenerationJobPage{}, err
		}
		job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		items = append(items, job)
	}
	if err := rows.Err(); err != nil {
		return GenerationJobPage{}, err
	}
	return GenerationJobPage{Items: items, Page: query.Page, PageSize: query.PageSize, Total: total}, nil
}

func (s *PostgresStore) GetGenerationJob(ctx context.Context, tenantID, id string) (GenerationJob, error) {
	tenantID = normalizeTenantID(tenantID)
	var job GenerationJob
	var created, updated time.Time
	var leaseExpires *time.Time
	err := s.pool.QueryRow(ctx, `SELECT id, user_id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at,
		lease_owner, lease_expires_at
		FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, tenantID, id).Scan(
		&job.ID, &job.UserID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt, &job.ProviderID,
		&job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated,
		&job.LeaseOwner, &leaseExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		return GenerationJob{}, ErrNotFound
	}
	if err != nil {
		return GenerationJob{}, err
	}
	job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if leaseExpires != nil {
		job.LeaseExpiresAt = leaseExpires.UTC().Format(time.RFC3339Nano)
	}
	return job, nil
}

func (s *PostgresStore) PutGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	job.UserID = strings.TrimSpace(job.UserID)
	if len(job.UserID) > 128 {
		return ErrInvalidInput
	}
	if job.Status == "deleted" {
		return ErrGone
	}
	created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation createdAt: %w", err)
	}
	updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation updatedAt: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (tenant_id, id) DO UPDATE SET project_id=EXCLUDED.project_id, kind=EXCLUDED.kind,
		status=EXCLUDED.status, prompt=EXCLUDED.prompt, provider_id=EXCLUDED.provider_id,
		model=EXCLUDED.model, parameters=EXCLUDED.parameters, result=EXCLUDED.result,
		error=EXCLUDED.error, updated_at=EXCLUDED.updated_at
		WHERE openboard_generation_jobs.deleted_at IS NULL AND openboard_generation_jobs.status <> 'deleted'`, tenantID, job.UserID, job.ID, job.ProjectID, job.Kind,
		job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
		created, updated)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrGone
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CreateGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	job.UserID = strings.TrimSpace(job.UserID)
	if len(job.UserID) > 128 {
		return ErrInvalidInput
	}
	if job.Status == "deleted" {
		return ErrGone
	}
	created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation createdAt: %w", err)
	}
	updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation updatedAt: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (tenant_id, id) DO NOTHING`, tenantID, job.UserID, job.ID, job.ProjectID, job.Kind,
		job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
		created, updated)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return generationJobConflictError(ctx, tx, tenantID, job.ID)
	}
	return tx.Commit(ctx)
}

func generationJobConflictError(ctx context.Context, tx pgx.Tx, tenantID, id string) error {
	var deletedAt *time.Time
	var status string
	if err := tx.QueryRow(ctx, `SELECT status, deleted_at FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`,
		tenantID, id).Scan(&status, &deletedAt); err != nil {
		return err
	}
	if deletedAt != nil || status == "deleted" {
		return ErrGone
	}
	return ErrConflict
}

func (s *PostgresStore) CreateServerGenerationJob(ctx context.Context, tenantID, userID string, job GenerationJob, units int, usageMeta json.RawMessage) error {
	tenantID = normalizeTenantID(tenantID)
	userID = strings.TrimSpace(userID)
	if len(userID) > 128 {
		return ErrInvalidInput
	}
	if job.Status == "deleted" {
		return ErrGone
	}
	billableGeneration := generationJobConsumesQuota(job.Kind)
	if billableGeneration && strings.TrimSpace(userID) == "" {
		return ErrUnauthorized
	}
	if billableGeneration && units < 1 {
		units = 1
	}
	if len(usageMeta) == 0 {
		usageMeta = json.RawMessage(`{}`)
	}
	created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation createdAt: %w", err)
	}
	updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation updatedAt: %w", err)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (tenant_id, id) DO NOTHING`, tenantID, userID, job.ID, job.ProjectID, job.Kind,
		job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
		created, updated)
	if err != nil {
		return err
	}
	if inserted.RowsAffected() == 0 {
		return generationJobConflictError(ctx, tx, tenantID, job.ID)
	}
	if billableGeneration {
		var quota int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(
		(SELECT generation_quota_monthly FROM openboard_tenants WHERE id=$1), $2)`,
			tenantID, defaultGenerationQuotaMonthly).Scan(&quota); err != nil {
			return err
		}
		now := time.Now().UTC()
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		var used int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(units), 0) FROM openboard_usage_events
		WHERE tenant_id=$1 AND kind='generation' AND created_at >= $2`, tenantID, monthStart).Scan(&used); err != nil {
			return err
		}
		if generationQuotaExceeded(used, units, quota) {
			return ErrQuotaExceeded
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
		VALUES ($1,$2,'generation',$3,$4)`, tenantID, userID, units, usageMeta); err != nil {
			return err
		}
		cost, err := s.modelCreditCostTx(ctx, tx, tenantID, job.Model)
		if err != nil {
			return err
		}
		amount := cost * units
		if err := s.reserveCreditsTx(ctx, tx, tenantID, userID, job.ID, job.Model, amount, usageMeta); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func generationJobConsumesQuota(kind string) bool {
	switch kind {
	case "text", "image", "video", "audio":
		return true
	default:
		return false
	}
}

func validServerGenerationClaim(claim GenerationClaim) bool {
	return ((claim.Kind == "text" || claim.Kind == "image" || claim.Kind == "video" || claim.Kind == "audio") && claim.Executor == "server") ||
		(claim.Kind == "audio" && claim.Executor == "voice-clone") ||
		((claim.Kind == "image" || claim.Kind == "video" || claim.Kind == "audio") && claim.Executor == "comfyui") ||
		(claim.Kind == "workflow" && claim.Executor == "workflow") ||
		(claim.Kind == "export" && claim.Executor == "film-export")
}

func (s *PostgresStore) ClaimServerGenerationJob(ctx context.Context, claim GenerationClaim, owner string, now, leaseUntil time.Time) (TenantGenerationJob, error) {
	if !validServerGenerationClaim(claim) {
		return TenantGenerationJob{}, errors.New("invalid generation claim")
	}
	_ = now
	_ = leaseUntil
	for range 16 {
		var tenantID, id string
		err := s.pool.QueryRow(ctx, `SELECT tenant_id,id FROM openboard_generation_jobs
			WHERE kind=$1 AND parameters->>'executor'=$2 AND deleted_at IS NULL
			  AND (NOT $3 OR user_id<>'')
			  AND (status='queued' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())))
			ORDER BY created_at,id LIMIT 1`, claim.Kind, claim.Executor, claim.RequireUserID).Scan(&tenantID, &id)
		if errors.Is(err, pgx.ErrNoRows) {
			return TenantGenerationJob{}, ErrNotFound
		}
		if err != nil {
			return TenantGenerationJob{}, err
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return TenantGenerationJob{}, err
		}
		if err := lockWorkspace(ctx, tx, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			return TenantGenerationJob{}, err
		}
		var claimed TenantGenerationJob
		var created, updated time.Time
		var leaseExpires *time.Time
		err = tx.QueryRow(ctx, `UPDATE openboard_generation_jobs SET
			status='running',lease_owner=$3,lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL AND
			 (status='queued' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp())))
			RETURNING tenant_id,user_id,id,COALESCE(project_id,''),kind,status,prompt,provider_id,model,parameters,result,error,
			created_at,updated_at,lease_owner,lease_expires_at`, tenantID, id, owner).Scan(
			&claimed.TenantID, &claimed.Job.UserID, &claimed.Job.ID, &claimed.Job.ProjectID, &claimed.Job.Kind, &claimed.Job.Status,
			&claimed.Job.Prompt, &claimed.Job.ProviderID, &claimed.Job.Model, &claimed.Job.Parameters,
			&claimed.Job.Result, &claimed.Job.Error, &created, &updated, &claimed.Job.LeaseOwner, &leaseExpires)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			continue
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return TenantGenerationJob{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return TenantGenerationJob{}, err
		}
		claimed.Job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		claimed.Job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		if leaseExpires != nil {
			claimed.Job.LeaseExpiresAt = leaseExpires.UTC().Format(time.RFC3339Nano)
		}
		return claimed, nil
	}
	return TenantGenerationJob{}, ErrConflict
}

func (s *PostgresStore) CheckpointServerGenerationJob(ctx context.Context, tenantID, id, owner string, result json.RawMessage, now time.Time) (GenerationJob, error) {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GenerationJob{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return GenerationJob{}, err
	}
	row := tx.QueryRow(ctx, `UPDATE openboard_generation_jobs SET result=$4, updated_at=$5
		WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND status='running'
		RETURNING id, user_id, COALESCE(project_id,''), kind, status, prompt, provider_id, model,
		parameters, result, error, created_at, updated_at`, tenantID, id, owner, result, now)
	var job GenerationJob
	var created, updated time.Time
	err = row.Scan(&job.ID, &job.UserID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt, &job.ProviderID,
		&job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return GenerationJob{}, ErrConflict
	}
	if err != nil {
		return GenerationJob{}, err
	}
	job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if err := tx.Commit(ctx); err != nil {
		return GenerationJob{}, err
	}
	return job, nil
}

func (s *PostgresStore) RenewServerGenerationJobLease(ctx context.Context, tenantID, id, owner string, now, leaseUntil time.Time) error {
	tenantID = normalizeTenantID(tenantID)
	_ = now
	_ = leaseUntil
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs SET
		lease_expires_at=clock_timestamp() + interval '2 minutes', updated_at=clock_timestamp()
		WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND status='running'`,
		tenantID, id, owner)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CompleteServerGenerationJob(ctx context.Context, tenantID, id, owner, status string, result json.RawMessage, errorMessage string, now time.Time) (GenerationJob, error) {
	tenantID = normalizeTenantID(tenantID)
	if status != "succeeded" && status != "failed" && status != "cancelled" {
		return GenerationJob{}, errors.New("invalid server generation terminal status")
	}
	var lastErr error
	for range 3 {
		job, err := s.completeServerGenerationJobOnce(ctx, tenantID, id, owner, status, result, errorMessage, now)
		if !isSerializationFailure(err) {
			return job, err
		}
		lastErr = err
	}
	return GenerationJob{}, lastErr
}

func (s *PostgresStore) completeServerGenerationJobOnce(ctx context.Context, tenantID, id, owner, status string, result json.RawMessage, errorMessage string, now time.Time) (GenerationJob, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return GenerationJob{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return GenerationJob{}, err
	}
	job, err := scanGenerationJob(tx.QueryRow(ctx, `UPDATE openboard_generation_jobs SET
		status=$4, result=$5, error=$6, updated_at=$7, lease_owner='', lease_expires_at=NULL,
		parameters=parameters #- '{sharedChannel,secret}'
		WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND status='running'
		RETURNING id, user_id, COALESCE(project_id,''), kind, status, prompt, provider_id, model,
		parameters, result, error, created_at, updated_at`, tenantID, id, owner, status, result, errorMessage, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return GenerationJob{}, ErrConflict
	}
	if err != nil {
		return GenerationJob{}, err
	}
	if status == "failed" || status == "cancelled" {
		if err := s.refundCreditsTx(ctx, tx, tenantID, "", id, status); err != nil {
			return GenerationJob{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return GenerationJob{}, err
	}
	return job, nil
}

func (s *PostgresStore) CancelServerGenerationJob(ctx context.Context, tenantID, id string, now time.Time) (GenerationJob, error) {
	tenantID = normalizeTenantID(tenantID)
	var lastErr error
	for range 3 {
		job, err := s.cancelServerGenerationJobOnce(ctx, tenantID, id, now)
		if !isSerializationFailure(err) {
			return job, err
		}
		lastErr = err
	}
	return GenerationJob{}, lastErr
}

func (s *PostgresStore) cancelServerGenerationJobOnce(ctx context.Context, tenantID, id string, now time.Time) (GenerationJob, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return GenerationJob{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return GenerationJob{}, err
	}
	job, err := scanGenerationJob(tx.QueryRow(ctx, `UPDATE openboard_generation_jobs SET
		status='cancelled', error='已取消', updated_at=$3, lease_owner='', lease_expires_at=NULL,
		parameters=parameters #- '{sharedChannel,secret}',
		result=CASE WHEN kind='workflow' THEN jsonb_set(result, '{steps}', COALESCE((
		  SELECT jsonb_object_agg(step.key, CASE
		    WHEN step.value->>'status' IN ('pending','queued','running')
		      THEN step.value || jsonb_build_object('status','cancelled','error','已取消')
		    ELSE step.value END)
		  FROM jsonb_each(result->'steps') AS step
		), '{}'::jsonb), true) ELSE result END
		WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running') AND
		  ((kind IN ('text','image','video','audio') AND parameters->>'executor'='server') OR
		   (kind IN ('image','video','audio') AND parameters->>'executor'='comfyui') OR
		   (kind='audio' AND parameters->>'executor'='voice-clone') OR
		   (kind='workflow' AND parameters->>'executor'='workflow') OR
		   (kind='film-stage' AND parameters->>'executor'='film-stage') OR
		   (kind='export' AND parameters->>'executor'='film-export'))
		RETURNING id, user_id, COALESCE(project_id,''), kind, status, prompt, provider_id, model,
		parameters, result, error, created_at, updated_at`, tenantID, id, now))
	if errors.Is(err, pgx.ErrNoRows) {
		job, getErr := scanGenerationJob(tx.QueryRow(ctx, `SELECT id, user_id, COALESCE(project_id,''), kind, status, prompt,
			provider_id, model, parameters, result, error, created_at, updated_at
			FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, tenantID, id))
		if errors.Is(getErr, pgx.ErrNoRows) {
			return GenerationJob{}, ErrNotFound
		}
		if getErr != nil {
			return GenerationJob{}, getErr
		}
		if !serverOwnedGenerationJob(job) {
			return GenerationJob{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return GenerationJob{}, err
		}
		return job, nil
	}
	if err != nil {
		return GenerationJob{}, err
	}
	if err := s.refundCreditsTx(ctx, tx, tenantID, "", id, "cancelled"); err != nil {
		return GenerationJob{}, err
	}
	if job.Kind == "audio" {
		var parameters struct {
			Executor  string `json:"executor"`
			VersionID string `json:"versionId"`
		}
		if json.Unmarshal(job.Parameters, &parameters) == nil && parameters.Executor == "voice-clone" && parameters.VersionID != "" {
			if _, err := tx.Exec(ctx, `UPDATE openboard_film_voice_versions
				SET status='canceled',error='Voice clone was canceled',updated_at=$4
				WHERE tenant_id=$1 AND generation_job_id=$2 AND id=$3 AND status IN ('queued','running')`,
				tenantID, id, parameters.VersionID, now); err != nil {
				return GenerationJob{}, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return GenerationJob{}, err
	}
	return job, nil
}

func scanGenerationJob(row pgx.Row) (GenerationJob, error) {
	var job GenerationJob
	var created, updated time.Time
	err := row.Scan(&job.ID, &job.UserID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt, &job.ProviderID,
		&job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated)
	if err != nil {
		return GenerationJob{}, err
	}
	job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return job, nil
}

func serverOwnedGenerationJob(job GenerationJob) bool {
	var value struct {
		Executor string `json:"executor"`
	}
	if json.Unmarshal(job.Parameters, &value) != nil {
		return false
	}
	return ((job.Kind == "text" || job.Kind == "image" || job.Kind == "video" || job.Kind == "audio") && value.Executor == "server") ||
		(job.Kind == "audio" && value.Executor == "voice-clone") ||
		((job.Kind == "image" || job.Kind == "video" || job.Kind == "audio") && value.Executor == "comfyui") ||
		(job.Kind == "workflow" && value.Executor == "workflow") ||
		(job.Kind == "export" && value.Executor == "film-export") ||
		(job.Kind == "film-stage" && value.Executor == "film-stage")
}

func (s *PostgresStore) DeleteGenerationJob(ctx context.Context, tenantID, id string) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	if err := rejectReferencedFilmStageChildren(ctx, tx, tenantID, []string{id}); err != nil {
		return err
	}
	// Soft-delete: hide from history while preserving tombstone for multi-device sync/cleanup.
	result, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs SET
		status='deleted', error=CASE WHEN error='' THEN '已删除' ELSE error END,
		result='{}'::jsonb, deleted_at=COALESCE(deleted_at, clock_timestamp()),
		updated_at=clock_timestamp(), lease_owner='', lease_expires_at=NULL
		WHERE tenant_id=$1 AND id=$2 AND status <> 'deleted'`, tenantID, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		// Idempotent: already deleted counts as success for history hide.
		var status string
		err = tx.QueryRow(ctx, `SELECT status FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, tenantID, id).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if status != "deleted" {
			return ErrNotFound
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) DeleteGenerationJobs(ctx context.Context, tenantID string, ids []string) (int64, error) {
	tenantID = normalizeTenantID(tenantID)
	if len(ids) == 0 {
		return 0, nil
	}
	if len(ids) > 100 {
		return 0, errors.New("too many generation job ids")
	}
	unique := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	if len(unique) == 0 {
		return 0, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return 0, err
	}
	if err := rejectReferencedFilmStageChildren(ctx, tx, tenantID, unique); err != nil {
		return 0, err
	}
	// Soft-delete selected history rows; cancel any active leases first.
	result, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs SET
		status='deleted', error=CASE WHEN status IN ('queued','running') THEN '已批量删除' WHEN error='' THEN '已删除' ELSE error END,
		result='{}'::jsonb, deleted_at=COALESCE(deleted_at, clock_timestamp()),
		updated_at=clock_timestamp(), lease_owner='', lease_expires_at=NULL
		WHERE tenant_id=$1 AND id = ANY($2) AND status <> 'deleted'`, tenantID, unique)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

func rejectReferencedFilmStageChildren(ctx context.Context, tx pgx.Tx, tenantID string, deleting []string) error {
	var referenced bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1
		FROM openboard_generation_jobs parent
		CROSS JOIN LATERAL jsonb_array_elements_text(
			CASE WHEN jsonb_typeof(parent.parameters->'childJobIds') = 'array'
				THEN parent.parameters->'childJobIds' ELSE '[]'::jsonb END
		) AS child(id)
		WHERE parent.tenant_id=$1 AND parent.kind='film-stage' AND parent.status <> 'deleted'
			AND NOT (parent.id = ANY($2)) AND child.id = ANY($2)
	)`, tenantID, deleting).Scan(&referenced)
	if err != nil {
		return err
	}
	if referenced {
		return ErrConflict
	}
	return nil
}

func (s *PostgresStore) DeleteGenerationJobsForProject(ctx context.Context, tenantID, projectID string) (int64, error) {
	tenantID = normalizeTenantID(tenantID)
	if projectID == "" {
		return 0, errors.New("project id is required")
	}
	var lastErr error
	for range 3 {
		deleted, err := s.deleteGenerationJobsForProjectOnce(ctx, tenantID, projectID)
		if !isSerializationFailure(err) {
			return deleted, err
		}
		lastErr = err
	}
	return 0, lastErr
}

func (s *PostgresStore) deleteGenerationJobsForProjectOnce(ctx context.Context, tenantID, projectID string) (int64, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return 0, err
	}
	// Cancel active jobs with the same refund path as explicit cancellation so
	// project deletion cannot burn reserved credits.
	rows, err := tx.Query(ctx, `SELECT id FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND project_id=$2 AND status IN ('queued','running')
		ORDER BY id ASC`, tenantID, projectID)
	if err != nil {
		return 0, err
	}
	activeIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		activeIDs = append(activeIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, id := range activeIDs {
		if _, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs SET
			status='cancelled', error='项目已删除', updated_at=clock_timestamp(), lease_owner='', lease_expires_at=NULL,
			parameters=parameters #- '{sharedChannel,secret}',
			result=CASE WHEN kind='workflow' THEN jsonb_set(result, '{steps}', COALESCE((
			  SELECT jsonb_object_agg(step.key, CASE
			    WHEN step.value->>'status' IN ('pending','queued','running')
			      THEN step.value || jsonb_build_object('status','cancelled','error','项目已删除')
			    ELSE step.value END)
			  FROM jsonb_each(result->'steps') AS step
			), '{}'::jsonb), true) ELSE result END
			WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')`, tenantID, id); err != nil {
			return 0, err
		}
		if err := s.refundCreditsTx(ctx, tx, tenantID, "", id, "cancelled"); err != nil {
			return 0, err
		}
	}
	result, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

func (s *PostgresStore) ReplaceGenerationJobs(ctx context.Context, tenantID string, jobs []GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	if collision, err := generationRestoreTouchesTombstone(ctx, tx, tenantID, jobs); err != nil {
		return err
	} else if collision {
		return ErrGone
	}
	var activeServerJobs int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND status IN ('queued','running') AND
		  ((kind IN ('text','image','video','audio') AND parameters->>'executor'='server') OR
		   (kind IN ('image','video','audio') AND parameters->>'executor'='comfyui') OR
		   (kind='audio' AND parameters->>'executor'='voice-clone') OR
		   (kind='workflow' AND parameters->>'executor'='workflow') OR
		   (kind='film-stage' AND parameters->>'executor'='film-stage') OR
		   (kind='export' AND parameters->>'executor'='film-export'))`, tenantID).Scan(&activeServerJobs); err != nil {
		return err
	}
	if activeServerJobs > 0 {
		return ErrConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1 AND deleted_at IS NULL`, tenantID); err != nil {
		return err
	}
	for _, job := range jobs {
		job.UserID = strings.TrimSpace(job.UserID)
		if len(job.UserID) > 128 {
			return ErrInvalidInput
		}
		created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
		if err != nil {
			return fmt.Errorf("invalid generation createdAt: %w", err)
		}
		updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
		if err != nil {
			return fmt.Errorf("invalid generation updatedAt: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
			(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			tenantID, job.UserID, job.ID, job.ProjectID, job.Kind, job.Status, job.Prompt, job.ProviderID,
			job.Model, job.Parameters, job.Result, job.Error, created, updated); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CompareAndSwapGenerationJobs(ctx context.Context, tenantID, expectedVersion string, jobs []GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, user_id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs WHERE tenant_id=$1 ORDER BY id`, tenantID)
	if err != nil {
		return err
	}
	current := make([]GenerationJob, 0)
	for rows.Next() {
		var job GenerationJob
		var created, updated time.Time
		if err := rows.Scan(&job.ID, &job.UserID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt, &job.ProviderID, &job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated); err != nil {
			rows.Close()
			return err
		}
		job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		current = append(current, job)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if GenerationJobsVersion(current) != expectedVersion {
		return ErrConflict
	}
	if collision, err := generationRestoreTouchesTombstone(ctx, tx, tenantID, jobs); err != nil {
		return err
	} else if collision {
		return ErrGone
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs WHERE tenant_id=$1 AND status IN ('queued','running') AND
			((kind IN ('text','image','video','audio') AND parameters->>'executor'='server') OR
			 (kind IN ('image','video','audio') AND parameters->>'executor'='comfyui') OR
			 (kind='audio' AND parameters->>'executor'='voice-clone') OR
			 (kind='workflow' AND parameters->>'executor'='workflow') OR
			 (kind='film-stage' AND parameters->>'executor'='film-stage') OR
			 (kind='export' AND parameters->>'executor'='film-export'))`, tenantID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		return ErrConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1 AND deleted_at IS NULL`, tenantID); err != nil {
		return err
	}
	currentOwners := make(map[string]string, len(current))
	for _, job := range current {
		currentOwners[job.ID] = job.UserID
	}
	for _, job := range jobs {
		job.UserID = strings.TrimSpace(job.UserID)
		if job.UserID == "" {
			job.UserID = currentOwners[job.ID]
		}
		if len(job.UserID) > 128 {
			return ErrInvalidInput
		}
		created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
		if err != nil {
			return err
		}
		updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
			(tenant_id,user_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, tenantID, job.UserID, job.ID, job.ProjectID, job.Kind, job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error, created, updated); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func generationRestoreTouchesTombstone(ctx context.Context, tx pgx.Tx, tenantID string, jobs []GenerationJob) (bool, error) {
	ids := make([]string, 0, len(jobs))
	for _, job := range jobs {
		if job.Status == "deleted" {
			return true, nil
		}
		ids = append(ids, job.ID)
	}
	if len(ids) == 0 {
		return false, nil
	}
	var collision bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND id=ANY($2::text[])
	)`, tenantID, ids).Scan(&collision)
	return collision, err
}

// --- Server material library ---

func normalizeLibraryAssetQuery(query LibraryAssetQuery) LibraryAssetQuery {
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 24
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	query.Q = strings.TrimSpace(query.Q)
	query.Kind = strings.TrimSpace(query.Kind)
	query.Tag = strings.TrimSpace(query.Tag)
	return query
}

func scanLibraryAsset(scanner interface {
	Scan(dest ...any) error
}) (LibraryAsset, error) {
	var asset LibraryAsset
	var tags []byte
	var created, updated time.Time
	if err := scanner.Scan(
		&asset.ID, &asset.Kind, &asset.Title, &tags, &asset.Content, &asset.CoverURL, &asset.Source, &asset.Notes, &created, &updated,
	); err != nil {
		return LibraryAsset{}, err
	}
	if len(tags) == 0 {
		asset.Tags = []string{}
	} else if err := json.Unmarshal(tags, &asset.Tags); err != nil {
		return LibraryAsset{}, fmt.Errorf("decode library asset tags: %w", err)
	}
	if asset.Tags == nil {
		asset.Tags = []string{}
	}
	asset.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	asset.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return asset, nil
}

func (s *PostgresStore) ListLibraryAssets(ctx context.Context, tenantID string, query LibraryAssetQuery) (LibraryAssetPage, error) {
	query = normalizeLibraryAssetQuery(query)
	args := []any{tenantID}
	where := []string{"tenant_id = $1"}
	if query.Kind != "" {
		args = append(args, query.Kind)
		where = append(where, fmt.Sprintf("kind = $%d", len(args)))
	}
	if query.Tag != "" {
		args = append(args, query.Tag)
		where = append(where, fmt.Sprintf("EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t(tag) WHERE lower(t.tag) = lower($%d))", len(args)))
	}
	if query.Q != "" {
		args = append(args, "%"+strings.ToLower(query.Q)+"%")
		where = append(where, fmt.Sprintf(`(
			lower(title) LIKE $%d OR lower(content) LIKE $%d OR lower(source) LIKE $%d OR lower(notes) LIKE $%d OR
			EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t(tag) WHERE lower(t.tag) LIKE $%d)
		)`, len(args), len(args), len(args), len(args), len(args)))
	}
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM openboard_library_assets WHERE "+clause, args...).Scan(&total); err != nil {
		return LibraryAssetPage{}, err
	}
	args = append(args, query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := s.pool.Query(ctx, `
SELECT id, kind, title, tags, content, cover_url, source, notes, created_at, updated_at
FROM openboard_library_assets
WHERE `+clause+`
ORDER BY updated_at DESC, id DESC
LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return LibraryAssetPage{}, err
	}
	defer rows.Close()
	items := make([]LibraryAsset, 0)
	for rows.Next() {
		asset, err := scanLibraryAsset(rows)
		if err != nil {
			return LibraryAssetPage{}, err
		}
		items = append(items, asset)
	}
	if err := rows.Err(); err != nil {
		return LibraryAssetPage{}, err
	}
	return LibraryAssetPage{Items: items, Page: query.Page, PageSize: query.PageSize, Total: total}, nil
}

func (s *PostgresStore) GetLibraryAsset(ctx context.Context, tenantID, id string) (LibraryAsset, error) {
	row := s.pool.QueryRow(ctx, `
SELECT id, kind, title, tags, content, cover_url, source, notes, created_at, updated_at
FROM openboard_library_assets
WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	asset, err := scanLibraryAsset(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return LibraryAsset{}, ErrNotFound
	}
	return asset, err
}

func normalizeLibraryAssetWrite(asset LibraryAsset, now time.Time, create bool) (LibraryAsset, error) {
	asset.Title = strings.TrimSpace(asset.Title)
	asset.Kind = strings.TrimSpace(asset.Kind)
	asset.Content = strings.TrimSpace(asset.Content)
	asset.CoverURL = strings.TrimSpace(asset.CoverURL)
	asset.Source = strings.TrimSpace(asset.Source)
	asset.Notes = strings.TrimSpace(asset.Notes)
	if asset.Title == "" {
		return LibraryAsset{}, fmt.Errorf("title is required")
	}
	switch asset.Kind {
	case LibraryAssetText, LibraryAssetImage, LibraryAssetVideo, LibraryAssetAudio:
	default:
		return LibraryAsset{}, fmt.Errorf("invalid kind")
	}
	if asset.Kind == LibraryAssetText {
		if asset.Content == "" {
			return LibraryAsset{}, fmt.Errorf("content is required for text assets")
		}
	} else if asset.Content == "" && asset.CoverURL == "" {
		return LibraryAsset{}, fmt.Errorf("content or coverUrl is required")
	}
	asset.Title = truncateTextUTF8Bytes(asset.Title, 200)
	if len(asset.Content) > 20_000 {
		return LibraryAsset{}, fmt.Errorf("content too long")
	}
	if len(asset.CoverURL) > 2_000 || len(asset.Source) > 2_000 || len(asset.Notes) > 4_000 {
		return LibraryAsset{}, fmt.Errorf("field too long")
	}
	tags := make([]string, 0, len(asset.Tags))
	seen := map[string]struct{}{}
	for _, tag := range asset.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		tag = truncateTextUTF8Bytes(tag, 64)
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		tags = append(tags, tag)
		if len(tags) >= 20 {
			break
		}
	}
	asset.Tags = tags
	if create {
		if asset.ID == "" {
			id, err := newID()
			if err != nil {
				return LibraryAsset{}, err
			}
			asset.ID = "lib_" + id
		}
		asset.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	}
	asset.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	return asset, nil
}

func (s *PostgresStore) CreateLibraryAsset(ctx context.Context, tenantID string, asset LibraryAsset) (LibraryAsset, error) {
	now := time.Now().UTC()
	asset, err := normalizeLibraryAssetWrite(asset, now, true)
	if err != nil {
		return LibraryAsset{}, err
	}
	tags, err := json.Marshal(asset.Tags)
	if err != nil {
		return LibraryAsset{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, asset.CreatedAt)
	if err != nil {
		return LibraryAsset{}, err
	}
	updated, err := time.Parse(time.RFC3339Nano, asset.UpdatedAt)
	if err != nil {
		return LibraryAsset{}, err
	}
	if _, err := s.pool.Exec(ctx, `
INSERT INTO openboard_library_assets
  (tenant_id, id, kind, title, tags, content, cover_url, source, notes, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		tenantID, asset.ID, asset.Kind, asset.Title, tags, asset.Content, asset.CoverURL, asset.Source, asset.Notes, created, updated,
	); err != nil {
		return LibraryAsset{}, err
	}
	return asset, nil
}

func (s *PostgresStore) UpdateLibraryAsset(ctx context.Context, tenantID string, asset LibraryAsset) (LibraryAsset, error) {
	existing, err := s.GetLibraryAsset(ctx, tenantID, asset.ID)
	if err != nil {
		return LibraryAsset{}, err
	}
	asset.CreatedAt = existing.CreatedAt
	asset, err = normalizeLibraryAssetWrite(asset, time.Now().UTC(), false)
	if err != nil {
		return LibraryAsset{}, err
	}
	tags, err := json.Marshal(asset.Tags)
	if err != nil {
		return LibraryAsset{}, err
	}
	updated, err := time.Parse(time.RFC3339Nano, asset.UpdatedAt)
	if err != nil {
		return LibraryAsset{}, err
	}
	cmd, err := s.pool.Exec(ctx, `
UPDATE openboard_library_assets
SET kind=$3, title=$4, tags=$5, content=$6, cover_url=$7, source=$8, notes=$9, updated_at=$10
WHERE tenant_id=$1 AND id=$2`,
		tenantID, asset.ID, asset.Kind, asset.Title, tags, asset.Content, asset.CoverURL, asset.Source, asset.Notes, updated,
	)
	if err != nil {
		return LibraryAsset{}, err
	}
	if cmd.RowsAffected() == 0 {
		return LibraryAsset{}, ErrNotFound
	}
	return asset, nil
}

func (s *PostgresStore) DeleteLibraryAsset(ctx context.Context, tenantID, id string) error {
	cmd, err := s.pool.Exec(ctx, `DELETE FROM openboard_library_assets WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- AI call logs ---

func normalizeAICallLogQuery(query AICallLogQuery) AICallLogQuery {
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 24
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	query.Q = strings.TrimSpace(query.Q)
	query.Kind = strings.TrimSpace(query.Kind)
	query.Status = strings.TrimSpace(query.Status)
	query.Channel = strings.TrimSpace(query.Channel)
	return query
}

func scanAICallLog(scanner interface {
	Scan(dest ...any) error
}) (AICallLog, error) {
	var entry AICallLog
	var created time.Time
	var request, response []byte
	if err := scanner.Scan(
		&entry.ID, &entry.JobID, &entry.UserID, &entry.Kind, &entry.ChannelID, &entry.ChannelName,
		&entry.Model, &entry.Protocol, &entry.Status, &entry.DurationMs, &entry.Error, &request, &response, &created,
	); err != nil {
		return AICallLog{}, err
	}
	if len(request) == 0 {
		entry.RequestJSON = json.RawMessage(`{}`)
	} else {
		entry.RequestJSON = json.RawMessage(request)
	}
	if len(response) == 0 {
		entry.ResponseJSON = json.RawMessage(`{}`)
	} else {
		entry.ResponseJSON = json.RawMessage(response)
	}
	entry.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return entry, nil
}

func normalizeAICallLogWrite(entry AICallLog, now time.Time) (AICallLog, error) {
	entry.Kind = strings.TrimSpace(entry.Kind)
	entry.Status = strings.TrimSpace(entry.Status)
	entry.JobID = strings.TrimSpace(entry.JobID)
	entry.UserID = strings.TrimSpace(entry.UserID)
	entry.ChannelID = strings.TrimSpace(entry.ChannelID)
	entry.ChannelName = strings.TrimSpace(entry.ChannelName)
	entry.Model = strings.TrimSpace(entry.Model)
	entry.Protocol = strings.TrimSpace(entry.Protocol)
	entry.Error = strings.TrimSpace(entry.Error)
	if entry.Kind == "" {
		return AICallLog{}, fmt.Errorf("kind is required")
	}
	if entry.Status == "" {
		return AICallLog{}, fmt.Errorf("status is required")
	}
	if entry.DurationMs < 0 {
		entry.DurationMs = 0
	}
	if len(entry.RequestJSON) == 0 {
		entry.RequestJSON = json.RawMessage(`{}`)
	}
	if len(entry.ResponseJSON) == 0 {
		entry.ResponseJSON = json.RawMessage(`{}`)
	}
	if !json.Valid(entry.RequestJSON) || !json.Valid(entry.ResponseJSON) {
		return AICallLog{}, fmt.Errorf("invalid request/response json")
	}
	if len(entry.RequestJSON) > 256*1024 || len(entry.ResponseJSON) > 256*1024 {
		return AICallLog{}, fmt.Errorf("request/response too large")
	}
	if entry.ID == "" {
		id, err := newID()
		if err != nil {
			return AICallLog{}, err
		}
		entry.ID = "ailog_" + id
	}
	if entry.CreatedAt == "" {
		entry.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	}
	return entry, nil
}

func (s *PostgresStore) CreateAICallLog(ctx context.Context, tenantID string, entry AICallLog) (AICallLog, error) {
	tenantID = normalizeTenantID(tenantID)
	entry, err := normalizeAICallLogWrite(entry, time.Now().UTC())
	if err != nil {
		return AICallLog{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, entry.CreatedAt)
	if err != nil {
		return AICallLog{}, err
	}
	if _, err := s.pool.Exec(ctx, `
INSERT INTO openboard_ai_call_logs
  (tenant_id, id, job_id, user_id, kind, channel_id, channel_name, model, protocol, status, duration_ms, error, request, response, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		tenantID, entry.ID, entry.JobID, entry.UserID, entry.Kind, entry.ChannelID, entry.ChannelName, entry.Model, entry.Protocol,
		entry.Status, entry.DurationMs, entry.Error, []byte(entry.RequestJSON), []byte(entry.ResponseJSON), created,
	); err != nil {
		return AICallLog{}, err
	}
	return entry, nil
}

func (s *PostgresStore) ListAICallLogs(ctx context.Context, tenantID string, query AICallLogQuery) (AICallLogPage, error) {
	tenantID = normalizeTenantID(tenantID)
	query = normalizeAICallLogQuery(query)
	args := []any{tenantID}
	where := []string{"tenant_id = $1"}
	if query.Kind != "" {
		args = append(args, query.Kind)
		where = append(where, fmt.Sprintf("kind = $%d", len(args)))
	}
	if query.Status != "" {
		args = append(args, query.Status)
		where = append(where, fmt.Sprintf("status = $%d", len(args)))
	}
	if query.Channel != "" {
		args = append(args, query.Channel)
		where = append(where, fmt.Sprintf("(channel_id = $%d OR channel_name = $%d)", len(args), len(args)))
	}
	if query.Q != "" {
		args = append(args, "%"+strings.ToLower(query.Q)+"%")
		where = append(where, fmt.Sprintf(`(
			lower(id) LIKE $%d OR lower(job_id) LIKE $%d OR lower(model) LIKE $%d OR lower(channel_id) LIKE $%d OR lower(channel_name) LIKE $%d OR lower(error) LIKE $%d
		)`, len(args), len(args), len(args), len(args), len(args), len(args)))
	}
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM openboard_ai_call_logs WHERE "+clause, args...).Scan(&total); err != nil {
		return AICallLogPage{}, err
	}
	args = append(args, query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := s.pool.Query(ctx, `
SELECT id, job_id, user_id, kind, channel_id, channel_name, model, protocol, status, duration_ms, error, request, response, created_at
FROM openboard_ai_call_logs
WHERE `+clause+`
ORDER BY created_at DESC, id DESC
LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return AICallLogPage{}, err
	}
	defer rows.Close()
	items := make([]AICallLog, 0)
	for rows.Next() {
		entry, err := scanAICallLog(rows)
		if err != nil {
			return AICallLogPage{}, err
		}
		items = append(items, entry)
	}
	if err := rows.Err(); err != nil {
		return AICallLogPage{}, err
	}
	return AICallLogPage{Items: items, Page: query.Page, PageSize: query.PageSize, Total: total}, nil
}

func (s *PostgresStore) GetAICallLog(ctx context.Context, tenantID, id string) (AICallLog, error) {
	tenantID = normalizeTenantID(tenantID)
	row := s.pool.QueryRow(ctx, `
SELECT id, job_id, user_id, kind, channel_id, channel_name, model, protocol, status, duration_ms, error, request, response, created_at
FROM openboard_ai_call_logs
WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	entry, err := scanAICallLog(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return AICallLog{}, ErrNotFound
	}
	return entry, err
}

func (s *PostgresStore) DeleteAICallLogsBefore(ctx context.Context, tenantID string, before time.Time) (int64, error) {
	tenantID = normalizeTenantID(tenantID)
	cmd, err := s.pool.Exec(ctx, `DELETE FROM openboard_ai_call_logs WHERE tenant_id=$1 AND created_at < $2`, tenantID, before.UTC())
	if err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}

func (s *PostgresStore) DeleteAICallLogs(ctx context.Context, tenantID string, ids []string) (int64, error) {
	tenantID = normalizeTenantID(tenantID)
	if len(ids) == 0 {
		return 0, nil
	}
	cmd, err := s.pool.Exec(ctx, `DELETE FROM openboard_ai_call_logs WHERE tenant_id=$1 AND id = ANY($2)`, tenantID, ids)
	if err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}

// --- Auth / usage ---

const accountBootstrapLockID int64 = 0x4f42415554484254

func lockAccountBootstrap(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, accountBootstrapLockID)
	return err
}

func validateBootstrapClaim(userCount int, authorized bool) error {
	if (userCount == 0) != authorized {
		return ErrBootstrapRequired
	}
	return nil
}

func claimLegacyLocalDataTx(ctx context.Context, tx pgx.Tx, userID string) error {
	for _, mapping := range []struct {
		legacyKey string
		userKey   string
	}{
		{legacyKey: "config", userKey: "__user_config_v1:" + userID},
		{legacyKey: "__encrypted_config_secrets", userKey: "__encrypted_user_config_secrets_v1:" + userID},
		{legacyKey: "workflow-templates", userKey: "__user_workflow_templates_v1:" + userID},
	} {
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at)
			SELECT tenant_id,$3,value,updated_at FROM openboard_state
			WHERE tenant_id=$1 AND key=$2
			ON CONFLICT (tenant_id,key) DO NOTHING`, DefaultTenantID, mapping.legacyKey, mapping.userKey); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE openboard_generation_jobs
		SET user_id=$2 WHERE tenant_id=$1 AND user_id=''`, DefaultTenantID, userID)
	return err
}

func (s *PostgresStore) CountUsers(ctx context.Context) (int, error) {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_users`).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func newID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func (s *PostgresStore) RegisterUser(ctx context.Context, input RegisterInput) (AuthUser, string, error) {
	email, validEmail := NormalizeEmail(input.Email)
	if !validEmail {
		return AuthUser{}, "", fmt.Errorf("invalid email")
	}
	inviteToken := strings.TrimSpace(input.InviteToken)
	if len(inviteToken) > 256 {
		return AuthUser{}, "", ErrInvalidInput
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = strings.Split(email, "@")[0]
	}
	displayName = truncateTextUTF8Bytes(displayName, 200)
	passwordHash, err := HashPassword(input.Password)
	if err != nil {
		return AuthUser{}, "", err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AuthUser{}, "", err
	}
	defer tx.Rollback(ctx)
	if inviteToken == "" {
		if err := lockAccountBootstrap(ctx, tx); err != nil {
			return AuthUser{}, "", err
		}
	}

	userID, err := newID()
	if err != nil {
		return AuthUser{}, "", err
	}

	var tenantID string
	role := "owner"
	var invitationID string
	firstUser := false
	if inviteToken != "" {
		var invitationEmail string
		if err := tx.QueryRow(ctx, `
SELECT id, tenant_id, email, role
FROM openboard_tenant_invitations
WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
FOR UPDATE`, HashSessionToken(inviteToken)).Scan(&invitationID, &tenantID, &invitationEmail, &role); errors.Is(err, pgx.ErrNoRows) {
			return AuthUser{}, "", ErrInvitationInvalid
		} else if err != nil {
			return AuthUser{}, "", err
		} else if !strings.EqualFold(strings.TrimSpace(invitationEmail), email) {
			return AuthUser{}, "", ErrInvitationInvalid
		}
		role = strings.ToLower(strings.TrimSpace(role))
		if role != "member" && role != "admin" {
			return AuthUser{}, "", ErrInvitationInvalid
		}
		role = CanonicalTenantRole(role)
	} else {
		var userCount int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_users`).Scan(&userCount); err != nil {
			return AuthUser{}, "", err
		}
		if err := validateBootstrapClaim(userCount, input.BootstrapAuthorized); err != nil {
			return AuthUser{}, "", err
		}
		if userCount == 0 {
			// First user claims the local tenant (existing data).
			firstUser = true
			tenantID = DefaultTenantID
			if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, 'Local', 'free', $2, $3)
ON CONFLICT (id) DO NOTHING`, DefaultTenantID, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
				return AuthUser{}, "", err
			}
		} else {
			tenantID, err = newID()
			if err != nil {
				return AuthUser{}, "", err
			}
			name := displayName + "'s workspace"
			if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, $2, 'free', $3, $4)`, tenantID, name, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
				return AuthUser{}, "", err
			}
		}
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_users (id, tenant_id, email, password_hash, display_name, role)
VALUES ($1, $2, $3, $4, $5, $6)`, userID, tenantID, email, passwordHash, displayName, role); err != nil {
		if strings.Contains(err.Error(), "openboard_users_email") || strings.Contains(err.Error(), "duplicate key") {
			return AuthUser{}, "", ErrConflict
		}
		return AuthUser{}, "", err
	}
	if firstUser {
		if err := claimLegacyLocalDataTx(ctx, tx, userID); err != nil {
			return AuthUser{}, "", err
		}
	}

	token, tokenHash, err := NewSessionToken()
	if err != nil {
		return AuthUser{}, "", err
	}
	sessionID, err := newID()
	if err != nil {
		return AuthUser{}, "", err
	}
	expires := time.Now().UTC().Add(30 * 24 * time.Hour)
	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_sessions (id, user_id, token_hash, expires_at)
VALUES ($1, $2, $3, $4)`, sessionID, userID, tokenHash, expires); err != nil {
		return AuthUser{}, "", err
	}
	if invitationID != "" {
		result, err := tx.Exec(ctx, `
UPDATE openboard_tenant_invitations
SET accepted_at=now(), accepted_user_id=$2
WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, invitationID, userID)
		if err != nil {
			return AuthUser{}, "", err
		}
		if result.RowsAffected() != 1 {
			return AuthUser{}, "", ErrInvitationInvalid
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, "", err
	}
	user := AuthUser{
		ID: userID, TenantID: tenantID, Email: email, DisplayName: displayName, Role: role, Status: "active", Credits: 0,
	}
	user.PlatformAdmin = IsConfiguredPlatformAdminUserID(user.ID)
	return user, token, nil
}

func (s *PostgresStore) LoginUser(ctx context.Context, email, password string) (AuthUser, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var user AuthUser
	var passwordHash string
	err := s.pool.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,''), COALESCE(password_hash,'')
FROM openboard_users WHERE email=$1`, email).Scan(
		&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &user.Credits, &user.Status, &user.LinuxDoID, &passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, "", ErrInvalidCredentials
	}
	if err != nil {
		return AuthUser{}, "", err
	}
	if passwordHash == "" || !CheckPassword(passwordHash, password) {
		return AuthUser{}, "", ErrInvalidCredentials
	}
	if strings.EqualFold(user.Status, "ban") {
		return AuthUser{}, "", ErrBanned
	}
	user.PlatformAdmin = IsConfiguredPlatformAdminUserID(user.ID)
	token, tokenHash, err := NewSessionToken()
	if err != nil {
		return AuthUser{}, "", err
	}
	sessionID, err := newID()
	if err != nil {
		return AuthUser{}, "", err
	}
	expires := time.Now().UTC().Add(30 * 24 * time.Hour)
	if _, err := s.pool.Exec(ctx, `
INSERT INTO openboard_sessions (id, user_id, token_hash, expires_at)
VALUES ($1, $2, $3, $4)`, sessionID, user.ID, tokenHash, expires); err != nil {
		return AuthUser{}, "", err
	}
	return user, token, nil
}

func (s *PostgresStore) ChangeUserPassword(ctx context.Context, userID, currentPassword, newPassword, keepSessionToken string) error {
	return s.updateUserPassword(ctx, userID, currentPassword, newPassword, keepSessionToken, true)
}

func (s *PostgresStore) ResetUserPassword(ctx context.Context, userID, newPassword string) error {
	return s.updateUserPassword(ctx, userID, "", newPassword, "", false)
}

func (s *PostgresStore) updateUserPassword(ctx context.Context, userID, currentPassword, newPassword, keepSessionToken string, verifyCurrent bool) error {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(userID) > 128 {
		return ErrInvalidInput
	}
	if err := ValidateNewPassword(newPassword); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var passwordHash string
	err = tx.QueryRow(ctx, `SELECT COALESCE(password_hash,'') FROM openboard_users WHERE id=$1 FOR UPDATE`, userID).Scan(&passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if verifyCurrent {
		if err := VerifyCurrentPassword(passwordHash, currentPassword); err != nil {
			return err
		}
		if passwordHash != "" && currentPassword == newPassword {
			return ErrPasswordUnchanged
		}
	}
	nextHash, err := HashPassword(newPassword)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET password_hash=$2 WHERE id=$1`, userID, nextHash); err != nil {
		return err
	}
	if keepSessionToken != "" {
		_, err = tx.Exec(ctx, `DELETE FROM openboard_sessions WHERE user_id=$1 AND token_hash<>$2`, userID, HashSessionToken(keepSessionToken))
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM openboard_sessions WHERE user_id=$1`, userID)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) LogoutSession(ctx context.Context, sessionToken string) error {
	if sessionToken == "" {
		return nil
	}
	hash := HashSessionToken(sessionToken)
	_, err := s.pool.Exec(ctx, `DELETE FROM openboard_sessions WHERE token_hash=$1`, hash)
	return err
}

func (s *PostgresStore) LookupSession(ctx context.Context, sessionToken string) (AuthUser, error) {
	if sessionToken == "" {
		return AuthUser{}, ErrUnauthorized
	}
	hash := HashSessionToken(sessionToken)
	var user AuthUser
	var expires time.Time
	err := s.pool.QueryRow(ctx, `
SELECT u.id, u.tenant_id, u.email, u.display_name, u.role, COALESCE(u.credits,0), COALESCE(u.status,'active'), COALESCE(u.linux_do_id,''), s.expires_at
FROM openboard_sessions s
JOIN openboard_users u ON u.id = s.user_id
WHERE s.token_hash=$1`, hash).Scan(
		&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &user.Credits, &user.Status, &user.LinuxDoID, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, ErrUnauthorized
	}
	if err != nil {
		return AuthUser{}, err
	}
	if time.Now().UTC().After(expires.UTC()) {
		_, _ = s.pool.Exec(ctx, `DELETE FROM openboard_sessions WHERE token_hash=$1`, hash)
		return AuthUser{}, ErrUnauthorized
	}
	if strings.EqualFold(user.Status, "ban") {
		return AuthUser{}, ErrBanned
	}
	user.PlatformAdmin = IsConfiguredPlatformAdminUserID(user.ID)
	return user, nil
}

func (s *PostgresStore) GetTenant(ctx context.Context, tenantID string) (Tenant, error) {
	tenantID = normalizeTenantID(tenantID)
	var t Tenant
	var created time.Time
	err := s.pool.QueryRow(ctx, `
SELECT id, name, plan, storage_quota_bytes, generation_quota_monthly, created_at
FROM openboard_tenants WHERE id=$1`, tenantID).Scan(
		&t.ID, &t.Name, &t.Plan, &t.StorageQuotaBytes, &t.GenerationQuotaMonthly, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tenant{}, ErrNotFound
	}
	if err != nil {
		return Tenant{}, err
	}
	t.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return t, nil
}

func (s *PostgresStore) UpdateTenantGenerationQuota(ctx context.Context, tenantID string, quota int64) (Tenant, error) {
	if quota < 0 {
		return Tenant{}, ErrInvalidInput
	}
	tenantID = normalizeTenantID(tenantID)
	result, err := s.pool.Exec(ctx, `UPDATE openboard_tenants SET generation_quota_monthly=$2 WHERE id=$1`, tenantID, quota)
	if err != nil {
		return Tenant{}, err
	}
	if result.RowsAffected() == 0 {
		return Tenant{}, ErrNotFound
	}
	return s.GetTenant(ctx, tenantID)
}

func normalizePage(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	return page, pageSize
}

func (s *PostgresStore) ListTenants(ctx context.Context, query TenantQuery) (TenantPage, error) {
	page, pageSize := normalizePage(query.Page, query.PageSize)
	q := strings.TrimSpace(query.Q)
	like := "%" + strings.ToLower(q) + "%"
	var total int
	var err error
	if q == "" {
		err = s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_tenants`).Scan(&total)
	} else {
		err = s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_tenants WHERE lower(id) LIKE $1 OR lower(name) LIKE $1`, like).Scan(&total)
	}
	if err != nil {
		return TenantPage{}, err
	}
	offset := (page - 1) * pageSize
	rows, err := s.pool.Query(ctx, `
SELECT t.id, t.name, t.plan, t.storage_quota_bytes, t.generation_quota_monthly, t.created_at, count(u.id)
FROM openboard_tenants t
LEFT JOIN openboard_users u ON u.tenant_id=t.id
WHERE ($1 = '' OR lower(t.id) LIKE $2 OR lower(t.name) LIKE $2)
GROUP BY t.id, t.name, t.plan, t.storage_quota_bytes, t.generation_quota_monthly, t.created_at
ORDER BY t.created_at DESC, t.id DESC LIMIT $3 OFFSET $4`, q, like, pageSize, offset)
	if err != nil {
		return TenantPage{}, err
	}
	defer rows.Close()
	items := make([]Tenant, 0, pageSize)
	for rows.Next() {
		var item Tenant
		var created time.Time
		if err := rows.Scan(&item.ID, &item.Name, &item.Plan, &item.StorageQuotaBytes, &item.GenerationQuotaMonthly, &created, &item.UserCount); err != nil {
			return TenantPage{}, err
		}
		item.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return TenantPage{}, err
	}
	return TenantPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func (s *PostgresStore) ListPlatformUsers(ctx context.Context, query PlatformUserQuery) (UserPage, error) {
	page, pageSize := normalizePage(query.Page, query.PageSize)
	tenantID := strings.TrimSpace(query.TenantID)
	q := strings.TrimSpace(query.Q)
	like := "%" + strings.ToLower(q) + "%"
	var total int
	where := `($1 = '' OR tenant_id=$1) AND ($2 = '' OR lower(email) LIKE $3 OR lower(display_name) LIKE $3)`
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_users WHERE `+where, tenantID, q, like).Scan(&total); err != nil {
		return UserPage{}, err
	}
	offset := (page - 1) * pageSize
	rows, err := s.pool.Query(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users
WHERE `+where+`
ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`, tenantID, q, like, pageSize, offset)
	if err != nil {
		return UserPage{}, err
	}
	defer rows.Close()
	items := make([]AuthUser, 0, pageSize)
	for rows.Next() {
		user, err := scanAuthUser(rows)
		if err != nil {
			return UserPage{}, err
		}
		items = append(items, user)
	}
	if err := rows.Err(); err != nil {
		return UserPage{}, err
	}
	return UserPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func (s *PostgresStore) GetUserAnyTenant(ctx context.Context, userID string) (AuthUser, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(userID) > 128 {
		return AuthUser{}, ErrInvalidInput
	}
	user, err := scanAuthUser(s.pool.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE id=$1`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, ErrNotFound
	}
	return user, err
}

func (s *PostgresStore) CreateTenantInvitation(ctx context.Context, input TenantInvitationInput) (CreatedTenantInvitation, error) {
	tenantID := normalizeTenantID(input.TenantID)
	createdBy := strings.TrimSpace(input.CreatedBy)
	email, validEmail := NormalizeEmail(input.Email)
	role := strings.ToLower(strings.TrimSpace(input.Role))
	if createdBy == "" || !validEmail ||
		role != "member" || input.ExpiresAt.Before(time.Now().UTC()) ||
		input.ExpiresAt.After(time.Now().UTC().Add(30*24*time.Hour)) {
		return CreatedTenantInvitation{}, ErrInvalidInput
	}
	var accountExists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM openboard_users WHERE lower(email)=lower($1))`, email).Scan(&accountExists); err != nil {
		return CreatedTenantInvitation{}, err
	}
	if accountExists {
		return CreatedTenantInvitation{}, ErrConflict
	}
	var tenantExists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM openboard_tenants WHERE id=$1)`, tenantID).Scan(&tenantExists); err != nil {
		return CreatedTenantInvitation{}, err
	}
	if !tenantExists {
		return CreatedTenantInvitation{}, ErrNotFound
	}
	// Expired invitations must not make an address permanently unavailable.
	// The partial unique index intentionally covers all unaccepted invitations,
	// so old rows are explicitly revoked before inserting a replacement.
	if _, err := s.pool.Exec(ctx, `
UPDATE openboard_tenant_invitations
SET revoked_at=now()
WHERE tenant_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`, tenantID, email); err != nil {
		return CreatedTenantInvitation{}, err
	}
	token, tokenHash, err := NewSessionToken()
	if err != nil {
		return CreatedTenantInvitation{}, err
	}
	id, err := newID()
	if err != nil {
		return CreatedTenantInvitation{}, err
	}
	var invitation TenantInvitation
	var created, expires time.Time
	err = s.pool.QueryRow(ctx, `
INSERT INTO openboard_tenant_invitations (id, tenant_id, email, role, token_hash, expires_at, created_by)
SELECT $1, $2, $3, $4, $5, $6, $7
		WHERE EXISTS (SELECT 1 FROM openboard_users WHERE id=$7 AND tenant_id=$2 AND role='owner' AND status='active')
RETURNING id, tenant_id, email, role, expires_at, created_at`, id, tenantID, email, role, tokenHash, input.ExpiresAt.UTC(), createdBy).
		Scan(&invitation.ID, &invitation.TenantID, &invitation.Email, &invitation.Role, &expires, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatedTenantInvitation{}, ErrUnauthorized
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate key") {
			return CreatedTenantInvitation{}, ErrConflict
		}
		return CreatedTenantInvitation{}, err
	}
	invitation.ExpiresAt = expires.UTC()
	invitation.CreatedAt = created.UTC()
	invitation.CreatedBy = createdBy
	return CreatedTenantInvitation{TenantInvitation: invitation, Token: token}, nil
}

func (s *PostgresStore) ListTenantInvitations(ctx context.Context, tenantID string) ([]TenantInvitation, error) {
	tenantID = normalizeTenantID(tenantID)
	rows, err := s.pool.Query(ctx, `
SELECT id, tenant_id, email, role, expires_at, accepted_at, accepted_user_id, revoked_at, created_by, created_at
FROM openboard_tenant_invitations WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]TenantInvitation, 0)
	for rows.Next() {
		var item TenantInvitation
		if err := rows.Scan(&item.ID, &item.TenantID, &item.Email, &item.Role, &item.ExpiresAt, &item.AcceptedAt, &item.AcceptedUserID, &item.RevokedAt, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.ExpiresAt = item.ExpiresAt.UTC()
		item.CreatedAt = item.CreatedAt.UTC()
		if item.AcceptedAt != nil {
			value := item.AcceptedAt.UTC()
			item.AcceptedAt = &value
		}
		if item.RevokedAt != nil {
			value := item.RevokedAt.UTC()
			item.RevokedAt = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) RevokeTenantInvitation(ctx context.Context, tenantID, invitationID string) error {
	tenantID = normalizeTenantID(tenantID)
	invitationID = strings.TrimSpace(invitationID)
	if invitationID == "" || len(invitationID) > 128 {
		return ErrInvalidInput
	}
	result, err := s.pool.Exec(ctx, `
UPDATE openboard_tenant_invitations SET revoked_at=now()
WHERE tenant_id=$1 AND id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, tenantID, invitationID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) RecordUsage(ctx context.Context, tenantID, userID, kind string, units int, meta json.RawMessage) error {
	tenantID = normalizeTenantID(tenantID)
	if units < 1 {
		units = 1
	}
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	var userArg any
	if userID != "" {
		userArg = userID
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO openboard_usage_events (tenant_id, user_id, kind, units, meta)
VALUES ($1, $2, $3, $4, $5)`, tenantID, userArg, kind, units, meta)
	return err
}

func (s *PostgresStore) GetUsage(ctx context.Context, tenantID string) (UsageSummary, error) {
	tenantID = normalizeTenantID(tenantID)
	tenant, err := s.GetTenant(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return UsageSummary{
				StorageQuotaBytes:      defaultStorageQuotaBytes,
				GenerationQuotaMonthly: defaultGenerationQuotaMonthly,
				Plan:                   "free",
			}, nil
		}
		return UsageSummary{}, err
	}
	// Approximate storage from usage events of kind storage_bytes (net), fallback 0.
	var storageBytes int64
	_ = s.pool.QueryRow(ctx, `
SELECT COALESCE(SUM(units), 0) FROM openboard_usage_events
WHERE tenant_id=$1 AND kind='storage_bytes'`, tenantID).Scan(&storageBytes)

	// Generation count this calendar month (UTC).
	var generation int64
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	if err := s.pool.QueryRow(ctx, `
SELECT COALESCE(SUM(units), 0) FROM openboard_usage_events
WHERE tenant_id=$1 AND kind='generation' AND created_at >= $2`, tenantID, monthStart).Scan(&generation); err != nil {
		return UsageSummary{}, err
	}
	if storageBytes < 0 {
		storageBytes = 0
	}
	return UsageSummary{
		StorageBytes:           storageBytes,
		GenerationThisMonth:    generation,
		StorageQuotaBytes:      tenant.StorageQuotaBytes,
		GenerationQuotaMonthly: tenant.GenerationQuotaMonthly,
		Plan:                   tenant.Plan,
	}, nil
}

func (s *PostgresStore) CheckGenerationQuota(ctx context.Context, tenantID string) error {
	usage, err := s.GetUsage(ctx, tenantID)
	if err != nil {
		return err
	}
	if generationQuotaExceeded(usage.GenerationThisMonth, 1, usage.GenerationQuotaMonthly) {
		return ErrQuotaExceeded
	}
	return nil
}

func generationQuotaExceeded(used int64, requested int, quota int64) bool {
	if requested < 1 {
		requested = 1
	}
	if quota < 0 || used >= quota {
		return true
	}
	return int64(requested) > quota-used
}

func (s *PostgresStore) CheckStorageQuota(ctx context.Context, tenantID string, additionalBytes int64) error {
	usage, err := s.GetUsage(ctx, tenantID)
	if err != nil {
		return err
	}
	if usage.StorageQuotaBytes > 0 && usage.StorageBytes+additionalBytes > usage.StorageQuotaBytes {
		return ErrQuotaExceeded
	}
	return nil
}

func (s *PostgresStore) ReserveStorageUsage(ctx context.Context, tenantID, userID string, additionalBytes int64, meta json.RawMessage) error {
	if additionalBytes <= 0 {
		return nil
	}
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var reservation struct {
		ReservationID string `json:"reservationId"`
	}
	_ = json.Unmarshal(meta, &reservation)
	if reservation.ReservationID != "" {
		lockKey := "blob-reserve:" + tenantID + ":" + reservation.ReservationID
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM openboard_usage_events
			WHERE tenant_id=$1 AND kind='storage_bytes' AND meta->>'reservationId'=$2
		)`, tenantID, reservation.ReservationID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return tx.Commit(ctx)
		}
	}
	var quota int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(
		(SELECT storage_quota_bytes FROM openboard_tenants WHERE id=$1), $2)`,
		tenantID, defaultStorageQuotaBytes).Scan(&quota); err != nil {
		return err
	}
	var used int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(units), 0) FROM openboard_usage_events
		WHERE tenant_id=$1 AND kind='storage_bytes'`, tenantID).Scan(&used); err != nil {
		return err
	}
	if quota > 0 && used+additionalBytes > quota {
		return ErrQuotaExceeded
	}
	var userArg any
	if userID != "" {
		userArg = userID
	}
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
		VALUES ($1,$2,'storage_bytes',$3,$4)`, tenantID, userArg, additionalBytes, meta); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ReleaseStorageUsage(ctx context.Context, tenantID, userID string, bytes int64, meta json.RawMessage) error {
	if bytes <= 0 {
		return nil
	}
	tenantID = normalizeTenantID(tenantID)
	var userArg any
	if userID != "" {
		userArg = userID
	}
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	var release struct {
		ReleaseOf string `json:"releaseOf"`
	}
	if json.Unmarshal(meta, &release) != nil || release.ReleaseOf == "" {
		_, err := s.pool.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
			VALUES ($1,$2,'storage_bytes',$3,$4)`, tenantID, userArg, -bytes, meta)
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	lockKey := "blob-release:" + tenantID + ":" + release.ReleaseOf
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM openboard_usage_events
		WHERE tenant_id=$1 AND kind='storage_bytes' AND meta->>'releaseOf'=$2
	)`, tenantID, release.ReleaseOf).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
			VALUES ($1,$2,'storage_bytes',$3,$4)`, tenantID, userArg, -bytes, meta); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

const adminBillingStateKey = "adminBilling"

func scanAuthUser(row pgx.Row) (AuthUser, error) {
	var user AuthUser
	err := row.Scan(&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &user.Credits, &user.Status, &user.LinuxDoID)
	if err != nil {
		return AuthUser{}, err
	}
	if user.Status == "" {
		user.Status = "active"
	}
	if role := CanonicalTenantRole(user.Role); role != "" {
		user.Role = role
	}
	user.PlatformAdmin = IsConfiguredPlatformAdminUserID(user.ID)
	return user, nil
}

func (s *PostgresStore) GetUser(ctx context.Context, tenantID, userID string) (AuthUser, error) {
	tenantID = normalizeTenantID(tenantID)
	user, err := scanAuthUser(s.pool.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, ErrNotFound
	}
	return user, err
}

func (s *PostgresStore) ListUsers(ctx context.Context, tenantID string, query UserQuery) (UserPage, error) {
	tenantID = normalizeTenantID(tenantID)
	page, pageSize := query.Page, query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	q := strings.TrimSpace(query.Q)
	like := "%" + strings.ToLower(q) + "%"
	var total int
	var err error
	if q == "" {
		err = s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_users WHERE tenant_id=$1`, tenantID).Scan(&total)
	} else {
		err = s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_users WHERE tenant_id=$1 AND (lower(email) LIKE $2 OR lower(display_name) LIKE $2)`, tenantID, like).Scan(&total)
	}
	if err != nil {
		return UserPage{}, err
	}
	offset := (page - 1) * pageSize
	var rows pgx.Rows
	if q == "" {
		rows, err = s.pool.Query(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, tenantID, pageSize, offset)
	} else {
		rows, err = s.pool.Query(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 AND (lower(email) LIKE $2 OR lower(display_name) LIKE $2)
ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`, tenantID, like, pageSize, offset)
	}
	if err != nil {
		return UserPage{}, err
	}
	defer rows.Close()
	items := make([]AuthUser, 0, pageSize)
	for rows.Next() {
		user, err := scanAuthUser(rows)
		if err != nil {
			return UserPage{}, err
		}
		items = append(items, user)
	}
	if err := rows.Err(); err != nil {
		return UserPage{}, err
	}
	return UserPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func isSerializationFailure(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "40001"
}

func (s *PostgresStore) UpdateUser(ctx context.Context, tenantID, userID string, patch UserPatch) (AuthUser, error) {
	var lastErr error
	for range 3 {
		user, err := s.updateUserOnce(ctx, tenantID, userID, patch)
		if !isSerializationFailure(err) {
			return user, err
		}
		lastErr = err
	}
	return AuthUser{}, lastErr
}

func (s *PostgresStore) updateUserOnce(ctx context.Context, tenantID, userID string, patch UserPatch) (AuthUser, error) {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return AuthUser{}, err
	}
	defer tx.Rollback(ctx)
	user, err := scanAuthUser(tx.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, ErrNotFound
	}
	if err != nil {
		return AuthUser{}, err
	}
	if !strings.EqualFold(strings.TrimSpace(patch.ActorRole), "owner") && strings.EqualFold(user.Role, "owner") && (patch.Role != nil || patch.Status != nil) {
		return AuthUser{}, ErrUnauthorized
	}
	wasActiveOwner := strings.EqualFold(user.Role, "owner") && strings.EqualFold(user.Status, "active")
	if patch.Role != nil {
		role := strings.ToLower(strings.TrimSpace(*patch.Role))
		switch role {
		case "owner", "admin", "member":
			user.Role = role
		default:
			return AuthUser{}, ErrInvalidInput
		}
	}
	if patch.Status != nil {
		status := strings.ToLower(strings.TrimSpace(*patch.Status))
		if status != "active" && status != "ban" {
			return AuthUser{}, ErrInvalidInput
		}
		user.Status = status
	}
	if wasActiveOwner && (!strings.EqualFold(user.Role, "owner") || !strings.EqualFold(user.Status, "active")) {
		var activeOwners int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_users WHERE tenant_id=$1 AND role='owner' AND status='active'`, tenantID).Scan(&activeOwners); err != nil {
			return AuthUser{}, err
		}
		if activeOwners <= 1 {
			return AuthUser{}, ErrLastOwner
		}
	}
	if patch.DisplayName != nil {
		user.DisplayName = truncateTextUTF8Bytes(strings.TrimSpace(*patch.DisplayName), 200)
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET role=$3, status=$4, display_name=$5 WHERE tenant_id=$1 AND id=$2`,
		tenantID, userID, user.Role, user.Status, user.DisplayName); err != nil {
		return AuthUser{}, err
	}
	if patch.CreditsDelta != nil && *patch.CreditsDelta != 0 {
		user, err = s.adjustCreditsTx(ctx, tx, tenantID, userID, *patch.CreditsDelta, "admin_adjust", json.RawMessage(`{}`))
		if err != nil {
			return AuthUser{}, err
		}
	} else {
		user, err = scanAuthUser(tx.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID))
		if err != nil {
			return AuthUser{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, err
	}
	return user, nil
}

func (s *PostgresStore) GetModelCreditConfig(ctx context.Context, tenantID string) (ModelCreditConfig, error) {
	// Credit pricing is platform-owned. Keep the parameter for interface
	// compatibility, but resolve every tenant against the global catalog.
	tenantID = DefaultTenantID
	cfg := ModelCreditConfig{ModelCosts: []ModelCreditCost{}, DefaultCredits: 1}
	raw, err := s.GetState(ctx, tenantID, adminBillingStateKey)
	if errors.Is(err, ErrNotFound) || len(raw) == 0 {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return ModelCreditConfig{}, ErrInvalidInput
	}
	if cfg.ModelCosts == nil {
		cfg.ModelCosts = []ModelCreditCost{}
	}
	if cfg.DefaultCredits < 1 {
		cfg.DefaultCredits = 1
	}
	for index := range cfg.ModelCosts {
		if cfg.ModelCosts[index].Credits < 1 {
			cfg.ModelCosts[index].Credits = 1
		}
	}
	return cfg, nil
}

func (s *PostgresStore) PutModelCreditConfig(ctx context.Context, tenantID string, config ModelCreditConfig) error {
	tenantID = DefaultTenantID
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	return s.PutState(ctx, tenantID, adminBillingStateKey, raw)
}

func (s *PostgresStore) GetModelCreditCost(ctx context.Context, tenantID, model string) (int, error) {
	cfg, err := s.GetModelCreditConfig(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	model = strings.TrimSpace(model)
	for _, item := range cfg.ModelCosts {
		if strings.EqualFold(strings.TrimSpace(item.Model), model) {
			return item.Credits, nil
		}
	}
	return cfg.DefaultCredits, nil
}

func (s *PostgresStore) modelCreditCostTx(ctx context.Context, tx pgx.Tx, tenantID, model string) (int, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT value FROM openboard_state WHERE tenant_id=$1 AND key=$2`,
		DefaultTenantID, adminBillingStateKey).Scan(&raw)
	cfg := ModelCreditConfig{ModelCosts: []ModelCreditCost{}, DefaultCredits: 1}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if err == nil && len(raw) > 0 && json.Unmarshal(raw, &cfg) != nil {
		return 0, ErrInvalidInput
	}
	model = strings.TrimSpace(model)
	for _, item := range cfg.ModelCosts {
		if strings.EqualFold(strings.TrimSpace(item.Model), model) {
			if item.Credits < 1 {
				return 1, nil
			}
			return item.Credits, nil
		}
	}
	if cfg.DefaultCredits < 1 {
		return 1, nil
	}
	return cfg.DefaultCredits, nil
}

func scanCreditLog(row pgx.Row) (CreditLog, error) {
	var item CreditLog
	err := row.Scan(&item.ID, &item.UserID, &item.ActorID, &item.JobID, &item.Model, &item.Delta,
		&item.BalanceAfter, &item.Reason, &item.IdempotencyKey, &item.Meta, &item.CreatedAt)
	return item, err
}

func (s *PostgresStore) ListCreditLogs(ctx context.Context, tenantID string, query CreditLogQuery) (CreditLogPage, error) {
	tenantID = normalizeTenantID(tenantID)
	page, pageSize := query.Page, query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	args := []any{tenantID}
	where := []string{"tenant_id=$1"}
	add := func(column, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		args = append(args, value)
		where = append(where, fmt.Sprintf("%s=$%d", column, len(args)))
	}
	add("user_id", query.UserID)
	add("reason", query.Reason)
	add("model", query.Model)
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM openboard_credit_logs WHERE "+clause, args...).Scan(&total); err != nil {
		return CreditLogPage{}, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.pool.Query(ctx, `SELECT id,user_id,actor_id,job_id,model,delta,balance_after,reason,idempotency_key,meta,created_at
FROM openboard_credit_logs WHERE `+clause+fmt.Sprintf(" ORDER BY created_at DESC,id DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return CreditLogPage{}, err
	}
	defer rows.Close()
	items := make([]CreditLog, 0, pageSize)
	for rows.Next() {
		item, err := scanCreditLog(rows)
		if err != nil {
			return CreditLogPage{}, err
		}
		item.TenantID = tenantID
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return CreditLogPage{}, err
	}
	return CreditLogPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func (s *PostgresStore) AdjustCreditsIdempotent(ctx context.Context, tenantID, userID, actorID, idempotencyKey string, delta int64, reason string, meta json.RawMessage) (AuthUser, CreditLog, bool, error) {
	var lastErr error
	for range 3 {
		user, logEntry, replayed, err := s.adjustCreditsIdempotentOnce(ctx, tenantID, userID, actorID, idempotencyKey, delta, reason, meta)
		if !isSerializationFailure(err) {
			return user, logEntry, replayed, err
		}
		lastErr = err
	}
	return AuthUser{}, CreditLog{}, false, lastErr
}

func (s *PostgresStore) adjustCreditsIdempotentOnce(ctx context.Context, tenantID, userID, actorID, idempotencyKey string, delta int64, reason string, meta json.RawMessage) (AuthUser, CreditLog, bool, error) {
	tenantID = normalizeTenantID(tenantID)
	if userID == "" || actorID == "" || idempotencyKey == "" || delta == 0 || reason == "" {
		return AuthUser{}, CreditLog{}, false, ErrInvalidInput
	}
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	defer tx.Rollback(ctx)
	lockKey := "credit-adjust:" + tenantID + ":" + idempotencyKey
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	existing, err := scanCreditLog(tx.QueryRow(ctx, `SELECT id,user_id,actor_id,job_id,model,delta,balance_after,reason,idempotency_key,meta,created_at
FROM openboard_credit_logs WHERE tenant_id=$1 AND idempotency_key=$2`, tenantID, idempotencyKey))
	if err == nil {
		existing.TenantID = tenantID
		if existing.UserID != userID || existing.ActorID != actorID || existing.Delta != delta || existing.Reason != reason {
			return AuthUser{}, CreditLog{}, false, ErrConflict
		}
		user, err := scanAuthUser(tx.QueryRow(ctx, `SELECT id,tenant_id,email,display_name,role,COALESCE(credits,0),COALESCE(status,'active'),COALESCE(linux_do_id,'') FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID))
		if err != nil {
			return AuthUser{}, CreditLog{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AuthUser{}, CreditLog{}, false, err
		}
		return user, existing, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, CreditLog{}, false, err
	}
	var balance int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(credits,0) FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, userID).Scan(&balance); errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, CreditLog{}, false, ErrNotFound
	} else if err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	next := balance + delta
	if next < 0 {
		return AuthUser{}, CreditLog{}, false, ErrInsufficientCredits
	}
	if (delta > 0 && next < balance) || (delta < 0 && next > balance) {
		return AuthUser{}, CreditLog{}, false, ErrInvalidInput
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET credits=$3 WHERE tenant_id=$1 AND id=$2`, tenantID, userID, next); err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	created, err := scanCreditLog(tx.QueryRow(ctx, `INSERT INTO openboard_credit_logs
(tenant_id,user_id,actor_id,job_id,model,delta,balance_after,reason,idempotency_key,meta)
VALUES ($1,$2,$3,'','',$4,$5,$6,$7,$8)
RETURNING id,user_id,actor_id,job_id,model,delta,balance_after,reason,idempotency_key,meta,created_at`,
		tenantID, userID, actorID, delta, next, reason, idempotencyKey, meta))
	if err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	created.TenantID = tenantID
	user, err := scanAuthUser(tx.QueryRow(ctx, `SELECT id,tenant_id,email,display_name,role,COALESCE(credits,0),COALESCE(status,'active'),COALESCE(linux_do_id,'') FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID))
	if err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, CreditLog{}, false, err
	}
	return user, created, false, nil
}

func (s *PostgresStore) reserveCreditsTx(ctx context.Context, tx pgx.Tx, tenantID, userID, jobID, model string, amount int, meta json.RawMessage) error {
	if amount <= 0 || userID == "" {
		return nil
	}
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM openboard_credit_logs WHERE tenant_id=$1 AND job_id=$2 AND reason='reserve')`, tenantID, jobID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	var balance int64
	var status string
	err := tx.QueryRow(ctx, `SELECT COALESCE(credits,0), COALESCE(status,'active') FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, userID).Scan(&balance, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if strings.EqualFold(status, "ban") {
		return ErrBanned
	}
	if balance < int64(amount) {
		return ErrInsufficientCredits
	}
	balance -= int64(amount)
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET credits=$3 WHERE tenant_id=$1 AND id=$2`, tenantID, userID, balance); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_credit_logs (tenant_id,user_id,job_id,model,delta,balance_after,reason,meta)
		VALUES ($1,$2,$3,$4,$5,$6,'reserve',$7)`, tenantID, userID, jobID, model, -int64(amount), balance, meta); err != nil {
		return err
	}
	return nil
}

func (s *PostgresStore) ReserveCredits(ctx context.Context, tenantID, userID, jobID, model string, amount int, meta json.RawMessage) error {
	tenantID = normalizeTenantID(tenantID)
	if amount <= 0 || userID == "" {
		return nil
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.reserveCreditsTx(ctx, tx, tenantID, userID, jobID, model, amount, meta); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RefundCredits(ctx context.Context, tenantID, userID, jobID, reason string) error {
	tenantID = normalizeTenantID(tenantID)
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return nil
	}
	reason = strings.ToLower(strings.TrimSpace(reason))
	if reason == "" {
		reason = "refund"
	}
	if reason != "refund" && reason != "failed" && reason != "cancelled" {
		return ErrInvalidInput
	}
	var lastErr error
	for range 3 {
		err := s.refundCreditsOnce(ctx, tenantID, userID, jobID, reason)
		if !isSerializationFailure(err) {
			return err
		}
		lastErr = err
	}
	return lastErr
}

func (s *PostgresStore) refundCreditsOnce(ctx context.Context, tenantID, userID, jobID, reason string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.refundCreditsTx(ctx, tx, tenantID, userID, jobID, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) refundCreditsTx(ctx context.Context, tx pgx.Tx, tenantID, userID, jobID, reason string) error {
	var refunded bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM openboard_credit_logs WHERE tenant_id=$1 AND job_id=$2 AND reason IN ('refund','failed','cancelled'))`, tenantID, jobID).Scan(&refunded); err != nil {
		return err
	}
	if refunded {
		return nil
	}
	var reservedUser string
	var amount int64
	err := tx.QueryRow(ctx, `SELECT user_id, ABS(delta) FROM openboard_credit_logs WHERE tenant_id=$1 AND job_id=$2 AND reason='reserve' ORDER BY id ASC LIMIT 1`, tenantID, jobID).Scan(&reservedUser, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if userID == "" {
		userID = reservedUser
	}
	var balance int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(credits,0) FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, userID).Scan(&balance); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	next := balance + amount
	if amount < 0 || next < balance {
		return ErrInvalidInput
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET credits=$3 WHERE tenant_id=$1 AND id=$2`, tenantID, userID, next); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_credit_logs (tenant_id,user_id,job_id,model,delta,balance_after,reason,meta)
		VALUES ($1,$2,$3,'',$4,$5,$6,'{}'::jsonb)`, tenantID, userID, jobID, amount, next, reason); err != nil {
		return err
	}
	return nil
}

func (s *PostgresStore) adjustCreditsTx(ctx context.Context, tx pgx.Tx, tenantID, userID string, delta int64, reason string, meta json.RawMessage) (AuthUser, error) {
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	var balance int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(credits,0) FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, userID).Scan(&balance); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AuthUser{}, ErrNotFound
		}
		return AuthUser{}, err
	}
	next := balance + delta
	if next < 0 {
		return AuthUser{}, ErrInsufficientCredits
	}
	if (delta > 0 && next < balance) || (delta < 0 && next > balance) {
		return AuthUser{}, ErrInvalidInput
	}
	if _, err := tx.Exec(ctx, `UPDATE openboard_users SET credits=$3 WHERE tenant_id=$1 AND id=$2`, tenantID, userID, next); err != nil {
		return AuthUser{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_credit_logs (tenant_id,user_id,job_id,model,delta,balance_after,reason,meta)
		VALUES ($1,$2,'','',$3,$4,$5,$6)`, tenantID, userID, delta, next, reason, meta); err != nil {
		return AuthUser{}, err
	}
	return scanAuthUser(tx.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID))
}

func (s *PostgresStore) AdjustCredits(ctx context.Context, tenantID, userID string, delta int, reason string, meta json.RawMessage) (AuthUser, error) {
	tenantID = normalizeTenantID(tenantID)
	if delta == 0 {
		return s.GetUser(ctx, tenantID, userID)
	}
	if reason == "" {
		reason = "adjust"
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return AuthUser{}, err
	}
	defer tx.Rollback(ctx)
	user, err := s.adjustCreditsTx(ctx, tx, tenantID, userID, int64(delta), reason, meta)
	if err != nil {
		return AuthUser{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, err
	}
	return user, nil
}

func (s *PostgresStore) UpsertLinuxDoUser(ctx context.Context, input LinuxDoUserInput) (AuthUser, string, error) {
	linuxID := strings.TrimSpace(input.LinuxDoID)
	if linuxID == "" {
		return AuthUser{}, "", fmt.Errorf("missing linux.do id")
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	if email == "" {
		email = "linuxdo_" + linuxID + "@users.noreply.linux.do"
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = strings.TrimSpace(input.Username)
	}
	if displayName == "" {
		displayName = "Linux.do User"
	}
	displayName = truncateTextUTF8Bytes(displayName, 200)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AuthUser{}, "", err
	}
	defer tx.Rollback(ctx)
	if err := lockAccountBootstrap(ctx, tx); err != nil {
		return AuthUser{}, "", err
	}
	var user AuthUser
	err = tx.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, COALESCE(credits,0), COALESCE(status,'active'), COALESCE(linux_do_id,'')
FROM openboard_users WHERE linux_do_id=$1`, linuxID).Scan(
		&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &user.Credits, &user.Status, &user.LinuxDoID)
	if err == nil {
		if strings.EqualFold(user.Status, "ban") {
			return AuthUser{}, "", ErrBanned
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		var userCount int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_users`).Scan(&userCount); err != nil {
			return AuthUser{}, "", err
		}
		if err := validateBootstrapClaim(userCount, input.BootstrapAuthorized); err != nil {
			return AuthUser{}, "", err
		}
		if !input.CreateAllowed {
			return AuthUser{}, "", ErrRegistrationDisabled
		}
		userID, err := newID()
		if err != nil {
			return AuthUser{}, "", err
		}
		role := "owner"
		var tenantID string
		if userCount == 0 {
			tenantID = DefaultTenantID
			if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, 'Local', 'free', $2, $3)
ON CONFLICT (id) DO NOTHING`, DefaultTenantID, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
				return AuthUser{}, "", err
			}
		} else {
			tenantID, err = newID()
			if err != nil {
				return AuthUser{}, "", err
			}
			name := displayName + "'s workspace"
			if _, err := tx.Exec(ctx, `
INSERT INTO openboard_tenants (id, name, plan, storage_quota_bytes, generation_quota_monthly)
VALUES ($1, $2, 'free', $3, $4)`, tenantID, name, defaultStorageQuotaBytes, defaultGenerationQuotaMonthly); err != nil {
				return AuthUser{}, "", err
			}
			role = "owner"
		}
		// Never auto-link by email alone: a colliding password account would
		// otherwise be taken over by any Linux.do identity that reports the same
		// address.
		var existingCount int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_users WHERE email=$1`, email).Scan(&existingCount); err != nil {
			return AuthUser{}, "", err
		}
		if existingCount > 0 {
			return AuthUser{}, "", ErrConflict
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO openboard_users (id, tenant_id, email, password_hash, display_name, role, credits, status, linux_do_id)
VALUES ($1,$2,$3,'',$4,$5,0,'active',$6)`, userID, tenantID, email, displayName, role, linuxID); err != nil {
			if strings.Contains(err.Error(), "openboard_users_email") || strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "openboard_users_linux_do") {
				return AuthUser{}, "", ErrConflict
			}
			return AuthUser{}, "", err
		}
		user = AuthUser{
			ID: userID, TenantID: tenantID, Email: email, DisplayName: displayName,
			Role: role, Credits: 0, Status: "active", LinuxDoID: linuxID,
		}
	} else {
		return AuthUser{}, "", err
	}
	user.PlatformAdmin = IsConfiguredPlatformAdminUserID(user.ID)
	token, tokenHash, err := NewSessionToken()
	if err != nil {
		return AuthUser{}, "", err
	}
	sessionID, err := newID()
	if err != nil {
		return AuthUser{}, "", err
	}
	expires := time.Now().UTC().Add(30 * 24 * time.Hour)
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, sessionID, user.ID, tokenHash, expires); err != nil {
		return AuthUser{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, "", err
	}
	return user, token, nil
}

func (s *PostgresStore) CreateMediaReference(ctx context.Context, tenantID, storageKey string, expiresAt time.Time) (MediaReference, error) {
	tenantID = normalizeTenantID(tenantID)
	storageKey = strings.TrimSpace(storageKey)
	if storageKey == "" || len(storageKey) > 512 {
		return MediaReference{}, fmt.Errorf("invalid storage key")
	}
	if expiresAt.IsZero() || expiresAt.Before(time.Now().UTC()) {
		expiresAt = time.Now().UTC().Add(15 * time.Minute)
	}
	token, err := newID()
	if err != nil {
		return MediaReference{}, err
	}
	token += newIDMust()
	if _, err := s.pool.Exec(ctx, `INSERT INTO openboard_media_references (token, tenant_id, storage_key, expires_at) VALUES ($1,$2,$3,$4)`,
		token, tenantID, storageKey, expiresAt.UTC()); err != nil {
		return MediaReference{}, err
	}
	return MediaReference{Token: token, TenantID: tenantID, StorageKey: storageKey, ExpiresAt: expiresAt.UTC()}, nil
}

func newIDMust() string {
	id, err := newID()
	if err != nil {
		return ""
	}
	return id
}

func (s *PostgresStore) GetMediaReference(ctx context.Context, token string) (MediaReference, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return MediaReference{}, ErrNotFound
	}
	var ref MediaReference
	var expires time.Time
	err := s.pool.QueryRow(ctx, `SELECT token, tenant_id, storage_key, expires_at FROM openboard_media_references WHERE token=$1`, token).Scan(
		&ref.Token, &ref.TenantID, &ref.StorageKey, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaReference{}, ErrNotFound
	}
	if err != nil {
		return MediaReference{}, err
	}
	ref.ExpiresAt = expires.UTC()
	if time.Now().UTC().After(ref.ExpiresAt) {
		_, _ = s.pool.Exec(ctx, `DELETE FROM openboard_media_references WHERE token=$1`, token)
		return MediaReference{}, ErrNotFound
	}
	return ref, nil
}

func (s *PostgresStore) DeleteExpiredMediaReferences(ctx context.Context, now time.Time) (int64, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cmd, err := s.pool.Exec(ctx, `DELETE FROM openboard_media_references WHERE expires_at < $1`, now.UTC())
	if err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}

// PurgeExpiredTombstones drops deleted-row markers once they are older than the
// retention window. Keeping them forever would leak storage for every canvas a
// user ever removed, while dropping them early lets a stale tab resurrect data.
func (s *PostgresStore) PurgeExpiredTombstones(ctx context.Context, now time.Time) (int64, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cutoff := now.UTC().Add(-tombstoneRetention)
	projects, err := s.pool.Exec(ctx,
		`DELETE FROM openboard_projects WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	jobs, err := s.pool.Exec(ctx,
		`DELETE FROM openboard_generation_jobs WHERE status='deleted' AND deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return projects.RowsAffected(), err
	}
	return projects.RowsAffected() + jobs.RowsAffected(), nil
}
