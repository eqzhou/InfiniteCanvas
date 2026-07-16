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

const schema = `
CREATE TABLE IF NOT EXISTS openboard_projects (
  id text PRIMARY KEY,
  title text NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openboard_projects_updated_idx
  ON openboard_projects (updated_at DESC);
CREATE TABLE IF NOT EXISTS openboard_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`

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
	if _, err := pool.Exec(ctx, schema); err != nil {
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
