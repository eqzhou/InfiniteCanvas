package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

const currentSchemaVersion = 2

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
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin schema migration: %w", err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, migrationV1); err != nil {
			return fmt.Errorf("apply schema migration 1: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES (1)`); err != nil {
			return fmt.Errorf("record schema migration 1: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit schema migration 1: %w", err)
		}
	}
	if version < 2 {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin schema migration 2: %w", err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, migrationV2); err != nil {
			return fmt.Errorf("apply schema migration 2: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_schema_migrations (version) VALUES (2)`); err != nil {
			return fmt.Errorf("record schema migration 2: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit schema migration 2: %w", err)
		}
	}
	return nil
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

func (s *PostgresStore) ListProjects(ctx context.Context) ([]ProjectSummary, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, title, updated_at FROM openboard_projects ORDER BY updated_at DESC`)
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

func (s *PostgresStore) GetProject(ctx context.Context, id string) ([]byte, error) {
	cacheKey := "openboard:project:" + id
	if s.redis != nil {
		if value, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil {
			return value, nil
		}
	}
	var document []byte
	if err := s.pool.QueryRow(ctx, `SELECT document FROM openboard_projects WHERE id=$1`, id).Scan(&document); err != nil {
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

func (s *PostgresStore) PutProject(ctx context.Context, id string, document []byte) error {
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
	_, err = s.pool.Exec(ctx, `INSERT INTO openboard_projects (id,title,updated_at,document)
		VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET
		title=EXCLUDED.title, updated_at=EXCLUDED.updated_at, document=EXCLUDED.document`, id, metadata.Title, updated, document)
	if err == nil && s.redis != nil {
		_ = s.redis.Del(ctx, "openboard:project:"+id).Err()
	}
	return err
}

func (s *PostgresStore) DeleteProject(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM openboard_projects WHERE id=$1`, id)
	if err == nil && s.redis != nil {
		_ = s.redis.Del(ctx, "openboard:project:"+id).Err()
	}
	return err
}

func (s *PostgresStore) GetState(ctx context.Context, key string) ([]byte, error) {
	var value []byte
	if err := s.pool.QueryRow(ctx, `SELECT value FROM openboard_state WHERE key=$1`, key).Scan(&value); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return value, nil
}

func (s *PostgresStore) PutState(ctx context.Context, key string, value []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO openboard_state (key,value,updated_at) VALUES ($1,$2,now())
		ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, key, value)
	return err
}

func (s *PostgresStore) ListGenerationJobs(ctx context.Context, query GenerationJobQuery) (GenerationJobPage, error) {
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM openboard_generation_jobs
		WHERE ($1='' OR project_id=$1) AND ($2='' OR kind=$2)`, query.ProjectID, query.Kind).Scan(&total); err != nil {
		return GenerationJobPage{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs
		WHERE ($1='' OR project_id=$1) AND ($2='' OR kind=$2)
		ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
		query.ProjectID, query.Kind, query.PageSize, (query.Page-1)*query.PageSize)
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

func (s *PostgresStore) GetGenerationJob(ctx context.Context, id string) (GenerationJob, error) {
	var job GenerationJob
	var created, updated time.Time
	err := s.pool.QueryRow(ctx, `SELECT id, COALESCE(project_id,''), kind, status, prompt,
		provider_id, model, parameters, result, error, created_at, updated_at
		FROM openboard_generation_jobs WHERE id=$1`, id).Scan(
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

func (s *PostgresStore) PutGenerationJob(ctx context.Context, job GenerationJob) error {
	created, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation createdAt: %w", err)
	}
	updated, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("invalid generation updatedAt: %w", err)
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, kind=EXCLUDED.kind,
		status=EXCLUDED.status, prompt=EXCLUDED.prompt, provider_id=EXCLUDED.provider_id,
		model=EXCLUDED.model, parameters=EXCLUDED.parameters, result=EXCLUDED.result,
		error=EXCLUDED.error, updated_at=EXCLUDED.updated_at`, job.ID, job.ProjectID, job.Kind,
		job.Status, job.Prompt, job.ProviderID, job.Model, job.Parameters, job.Result, job.Error,
		created, updated)
	return err
}

func (s *PostgresStore) DeleteGenerationJob(ctx context.Context, id string) error {
	result, err := s.pool.Exec(ctx, `DELETE FROM openboard_generation_jobs WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) ReplaceGenerationJobs(ctx context.Context, jobs []GenerationJob) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM openboard_generation_jobs`); err != nil {
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
			(id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
			VALUES ($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			job.ID, job.ProjectID, job.Kind, job.Status, job.Prompt, job.ProviderID,
			job.Model, job.Parameters, job.Result, job.Error, created, updated); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
