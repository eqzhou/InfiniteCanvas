package store

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestGenerationQuotaHasNoUnlimitedZeroSentinel(t *testing.T) {
	tests := []struct {
		name      string
		used      int64
		requested int
		quota     int64
		exceeded  bool
	}{
		{name: "zero blocks first generation", used: 0, requested: 1, quota: 0, exceeded: true},
		{name: "remaining allowance permits request", used: 2, requested: 1, quota: 3, exceeded: false},
		{name: "request cannot cross allowance", used: 2, requested: 2, quota: 3, exceeded: true},
		{name: "fully used allowance blocks request", used: 3, requested: 1, quota: 3, exceeded: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := generationQuotaExceeded(test.used, test.requested, test.quota); got != test.exceeded {
				t.Fatalf("generationQuotaExceeded(%d, %d, %d) = %v", test.used, test.requested, test.quota, got)
			}
		})
	}
}

func TestOnlyProviderGenerationConsumesQuotaAndCredits(t *testing.T) {
	for _, kind := range []string{"text", "image", "video", "audio"} {
		if !generationJobConsumesQuota(kind) {
			t.Fatalf("%s should consume generation quota", kind)
		}
	}
	for _, kind := range []string{"export", "workflow", "film-stage"} {
		if generationJobConsumesQuota(kind) {
			t.Fatalf("%s should not consume model generation quota", kind)
		}
	}
}

func TestFilmStageGenerationJobsAreDurableButNeverClaimable(t *testing.T) {
	if currentSchemaVersion < 21 {
		t.Fatalf("Film stage parent jobs require PostgreSQL schema v21 or newer, got v%d", currentSchemaVersion)
	}
	for _, executor := range []string{"film-stage", "server", "workflow", "film-export"} {
		if validServerGenerationClaim(GenerationClaim{Kind: "film-stage", Executor: executor}) {
			t.Fatalf("Film stage parent job became worker-claimable with executor %q", executor)
		}
	}
}

func TestServerGenerationClaimAcceptsDurableTextWorker(t *testing.T) {
	if !validServerGenerationClaim(GenerationClaim{Kind: "text", Executor: "server"}) {
		t.Fatal("text server worker claim was rejected")
	}
	for _, claim := range []GenerationClaim{
		{Kind: "text", Executor: "workflow"},
		{Kind: "workflow", Executor: "server"},
		{Kind: "unknown", Executor: "server"},
	} {
		if validServerGenerationClaim(claim) {
			t.Fatalf("invalid claim was accepted: %#v", claim)
		}
	}
}

func TestServerOwnedGenerationJobIncludesDurableTextWorker(t *testing.T) {
	job := GenerationJob{Kind: "text", Parameters: json.RawMessage(`{"executor":"server"}`)}
	if !serverOwnedGenerationJob(job) {
		t.Fatal("text server job is not protected by server-owned job lifecycle operations")
	}
}

func TestFilmGenerationBatchRetriesSerializationFailuresAtMostThreeTimes(t *testing.T) {
	attempts := 0
	record, err := retryFilmGenerationBatch(func() (FilmRecord, error) {
		attempts++
		if attempts < 3 {
			return FilmRecord{}, &pgconn.PgError{Code: "40001"}
		}
		return FilmRecord{ProjectID: "film", Revision: 2}, nil
	})
	if err != nil || record.ProjectID != "film" || attempts != 3 {
		t.Fatalf("serialization retry did not succeed on the third attempt: record=%#v attempts=%d err=%v", record, attempts, err)
	}

	attempts = 0
	serializationErr := &pgconn.PgError{Code: "40001"}
	_, err = retryFilmGenerationBatch(func() (FilmRecord, error) {
		attempts++
		return FilmRecord{}, serializationErr
	})
	if !errors.Is(err, serializationErr) || attempts != 3 {
		t.Fatalf("serialization retry exceeded its three-attempt bound: attempts=%d err=%v", attempts, err)
	}
}
