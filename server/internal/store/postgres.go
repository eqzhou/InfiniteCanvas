package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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

// migrationV3SQL is applied statement-by-statement because ALTER ... DROP CONSTRAINT
// needs dynamic primary-key discovery.
const currentSchemaVersion = 3

const defaultStorageQuotaBytes int64 = 1 << 30
const defaultGenerationQuotaMonthly int64 = 1000

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
	if _, err := pool.Exec(ctx, schemaMigrations); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	var version int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM openboard_schema_migrations`).Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > currentSchemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d", version, currentSchemaVersion)
	}
	if version < 1 {
		if err := applyMigration(ctx, pool, 1, migrationV1); err != nil {
			return err
		}
	}
	if version < 2 {
		if err := applyMigration(ctx, pool, 2, migrationV2); err != nil {
			return err
		}
	}
	if version < 3 {
		if err := migrateV3(ctx, pool); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, pool *pgxpool.Pool, version int, sql string) error {
	tx, err := pool.Begin(ctx)
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

func migrateV3(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
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
  generation_quota_monthly bigint NOT NULL DEFAULT 1000,
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

func projectCacheKey(tenantID, id string) string {
	return "openboard:project:" + tenantID + ":" + id
}

func (s *PostgresStore) ListProjects(ctx context.Context, tenantID string) ([]ProjectSummary, error) {
	tenantID = normalizeTenantID(tenantID)
	rows, err := s.pool.Query(ctx, `SELECT id, title, updated_at FROM openboard_projects
		WHERE tenant_id=$1 ORDER BY updated_at DESC`, tenantID)
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
	if err := s.pool.QueryRow(ctx, `SELECT document FROM openboard_projects WHERE tenant_id=$1 AND id=$2`,
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
	_, err = s.pool.Exec(ctx, `INSERT INTO openboard_projects (tenant_id,id,title,updated_at,document)
		VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, id) DO UPDATE SET
		title=EXCLUDED.title, updated_at=EXCLUDED.updated_at, document=EXCLUDED.document`,
		tenantID, id, metadata.Title, updated, document)
	if err == nil && s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, id)).Err()
	}
	return err
}

func (s *PostgresStore) DeleteProject(ctx context.Context, tenantID, id string) error {
	tenantID = normalizeTenantID(tenantID)
	_, err := s.pool.Exec(ctx, `DELETE FROM openboard_projects WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err == nil && s.redis != nil {
		_ = s.redis.Del(ctx, projectCacheKey(tenantID, id)).Err()
	}
	return err
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

func (s *PostgresStore) PutState(ctx context.Context, tenantID, key string, value []byte) error {
	tenantID = normalizeTenantID(tenantID)
	_, err := s.pool.Exec(ctx, `INSERT INTO openboard_state (tenant_id,key,value,updated_at) VALUES ($1,$2,$3,now())
		ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, tenantID, key, value)
	return err
}

func (s *PostgresStore) ListGenerationJobs(ctx context.Context, tenantID string, query GenerationJobQuery) (GenerationJobPage, error) {
	tenantID = normalizeTenantID(tenantID)
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND ($2='' OR project_id=$2) AND ($3='' OR kind=$3)`,
		tenantID, query.ProjectID, query.Kind).Scan(&total); err != nil {
		return GenerationJobPage{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND ($2='' OR project_id=$2) AND ($3='' OR kind=$3)
		ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
		tenantID, query.ProjectID, query.Kind, query.PageSize, (query.Page-1)*query.PageSize)
	if err != nil {
		return GenerationJobPage{}, err
	}
	defer rows.Close()
	items := make([]GenerationJob, 0)
	for rows.Next() {
		var job GenerationJob
		var created, updated time.Time
		if err := rows.Scan(&job.ID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt,
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
	err := s.pool.QueryRow(ctx, `SELECT id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, tenantID, id).Scan(
		&job.ID, &job.ProjectID, &job.Kind, &job.Status, &job.Prompt, &job.ProviderID,
		&job.Model, &job.Parameters, &job.Result, &job.Error, &created, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return GenerationJob{}, ErrNotFound
	}
	if err != nil {
		return GenerationJob{}, err
	}
	job.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	job.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return job, nil
}

func (s *PostgresStore) PutGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation createdAt: %w", err)
	}
	updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation updatedAt: %w", err)
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(tenant_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (tenant_id, id) DO UPDATE SET project_id=EXCLUDED.project_id, kind=EXCLUDED.kind,
		status=EXCLUDED.status, prompt=EXCLUDED.prompt, provider_id=EXCLUDED.provider_id,
		model=EXCLUDED.model, parameters=EXCLUDED.parameters, result=EXCLUDED.result,
		error=EXCLUDED.error, updated_at=EXCLUDED.updated_at`, tenantID, job.ID, job.ProjectID, job.Kind,
		job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
		created, updated)
	return err
}

func (s *PostgresStore) DeleteGenerationJob(ctx context.Context, tenantID, id string) error {
	tenantID = normalizeTenantID(tenantID)
	result, err := s.pool.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) ReplaceGenerationJobs(ctx context.Context, tenantID string, jobs []GenerationJob) error {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE tenant_id=$1`, tenantID); err != nil {
		return err
	}
	for _, job := range jobs {
		created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
		if err != nil {
			return fmt.Errorf("invalid generation createdAt: %w", err)
		}
		updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
		if err != nil {
			return fmt.Errorf("invalid generation updatedAt: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
			(tenant_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
			VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			tenantID, job.ID, job.ProjectID, job.Kind, job.Status, job.Prompt, job.ProviderID,
			job.Model, job.Parameters, job.Result, job.Error, created, updated); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// --- Auth / usage ---

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
	email := strings.ToLower(strings.TrimSpace(input.Email))
	if email == "" || !strings.Contains(email, "@") || len(email) > 320 {
		return AuthUser{}, "", fmt.Errorf("invalid email")
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = strings.Split(email, "@")[0]
	}
	if len(displayName) > 200 {
		displayName = displayName[:200]
	}
	passwordHash, err := HashPassword(input.Password)
	if err != nil {
		return AuthUser{}, "", err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AuthUser{}, "", err
	}
	defer tx.Rollback(ctx)

	var userCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM openboard_users`).Scan(&userCount); err != nil {
		return AuthUser{}, "", err
	}

	userID, err := newID()
	if err != nil {
		return AuthUser{}, "", err
	}

	var tenantID string
	role := "owner"
	if userCount == 0 {
		// First user claims the local tenant (existing data).
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

	if _, err := tx.Exec(ctx, `
INSERT INTO openboard_users (id, tenant_id, email, password_hash, display_name, role)
VALUES ($1, $2, $3, $4, $5, $6)`, userID, tenantID, email, passwordHash, displayName, role); err != nil {
		if strings.Contains(err.Error(), "openboard_users_email") || strings.Contains(err.Error(), "duplicate key") {
			return AuthUser{}, "", ErrConflict
		}
		return AuthUser{}, "", err
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

	if err := tx.Commit(ctx); err != nil {
		return AuthUser{}, "", err
	}
	user := AuthUser{
		ID: userID, TenantID: tenantID, Email: email, DisplayName: displayName, Role: role,
	}
	return user, token, nil
}

func (s *PostgresStore) LoginUser(ctx context.Context, email, password string) (AuthUser, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var user AuthUser
	var passwordHash string
	err := s.pool.QueryRow(ctx, `
SELECT id, tenant_id, email, display_name, role, password_hash
FROM openboard_users WHERE email=$1`, email).Scan(
		&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthUser{}, "", ErrInvalidCredentials
	}
	if err != nil {
		return AuthUser{}, "", err
	}
	if !CheckPassword(passwordHash, password) {
		return AuthUser{}, "", ErrInvalidCredentials
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
	if _, err := s.pool.Exec(ctx, `
INSERT INTO openboard_sessions (id, user_id, token_hash, expires_at)
VALUES ($1, $2, $3, $4)`, sessionID, user.ID, tokenHash, expires); err != nil {
		return AuthUser{}, "", err
	}
	return user, token, nil
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
SELECT u.id, u.tenant_id, u.email, u.display_name, u.role, s.expires_at
FROM openboard_sessions s
JOIN openboard_users u ON u.id = s.user_id
WHERE s.token_hash=$1`, hash).Scan(
		&user.ID, &user.TenantID, &user.Email, &user.DisplayName, &user.Role, &expires)
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
	if usage.GenerationQuotaMonthly > 0 && usage.GenerationThisMonth >= usage.GenerationQuotaMonthly {
		return ErrQuotaExceeded
	}
	return nil
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
