package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestPostgresFilmEntityProjectionTracksFilmCAS(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL Film projection tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL Film projection tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("film-projection-%d", time.Now().UnixNano())
	projectID := "film-projection"
	project := []byte(`{"title":"Film Projection","updatedAt":"2026-08-09T00:00:00Z"}`)
	if err := backend.PutProject(t.Context(), tenantID, projectID, project); err != nil {
		t.Fatal(err)
	}
	first := []byte(`{"source":{"revision":1},"episodes":[{"id":"episode-1","revision":1}],"scenes":[],"shots":[{"id":"shot-1","revision":1}],"dialogues":[],"assets":[],"stages":[],"tasks":[],"qualityReports":[],"deliverables":[],"adoptions":[],"versions":[],"timeline":{"revision":1}}`)
	record, err := backend.CreateFilmProject(t.Context(), tenantID, projectID, first)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&count); err != nil || count != 4 {
		t.Fatalf("initial projection count=%d err=%v", count, err)
	}
	second := []byte(`{"source":{"revision":2},"episodes":[{"id":"episode-1","revision":2}],"scenes":[],"shots":[{"id":"shot-2","revision":1}],"dialogues":[],"assets":[],"stages":[],"tasks":[],"qualityReports":[],"deliverables":[],"adoptions":[],"versions":[],"timeline":{"revision":2}}`)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), tenantID, projectID, record.Revision, second); err != nil {
		t.Fatal(err)
	}
	var oldCount, newCount int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE entity_id='shot-1'), count(*) FILTER (WHERE entity_id='shot-2') FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&oldCount, &newCount); err != nil || oldCount != 0 || newCount != 1 {
		t.Fatalf("CAS projection old=%d new=%d err=%v", oldCount, newCount, err)
	}
}
