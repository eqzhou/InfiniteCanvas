package store

import "testing"

func TestPostgresStoreImplementsAtomicFilmGenerationBatch(t *testing.T) {
	var backend any = (*PostgresStore)(nil)
	if _, ok := backend.(FilmGenerationBatchStore); !ok {
		t.Fatal("PostgreSQL store does not atomically commit Film CAS, jobs, quota, and credits")
	}
}
