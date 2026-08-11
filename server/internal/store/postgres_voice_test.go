package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestVoiceCloneGenerationClaimIsNarrowlyScoped(t *testing.T) {
	if currentSchemaVersion < 24 {
		t.Fatalf("audited atomic voice cloning requires schema v24 or newer, got v%d", currentSchemaVersion)
	}
	if !validServerGenerationClaim(GenerationClaim{Kind: "audio", Executor: "voice-clone"}) {
		t.Fatal("voice clone worker claim was rejected")
	}
	for _, claim := range []GenerationClaim{{Kind: "video", Executor: "voice-clone"}, {Kind: "audio", Executor: "voice-clone-admin"}} {
		if validServerGenerationClaim(claim) {
			t.Fatalf("invalid voice clone claim accepted: %#v", claim)
		}
	}
}

func TestPostgresVoiceIdentitySnapshotsAreTenantScopedAndImmutable(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL voice identity tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL voice identity tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("voice-store-%d", time.Now().UnixNano())
	projectID := "voice-film"
	if err := backend.PutProject(t.Context(), tenantID, projectID, []byte(`{"title":"Voice Film","updatedAt":"2026-08-11T00:00:00Z"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.CreateFilmProject(t.Context(), tenantID, projectID, []byte(completeFilmProjectionDocument)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	identity, err := backend.CreateVoiceIdentity(t.Context(), tenantID, projectID, VoiceIdentity{ID: "voice-one", Title: "Lead", CreatedAt: now, UpdatedAt: now})
	if err != nil || identity.Revision != 1 {
		t.Fatalf("identity=%#v err=%v", identity, err)
	}
	sample, err := backend.AddVoiceSample(t.Context(), tenantID, projectID, VoiceSample{
		ID: "sample-one", VoiceIdentityID: identity.ID, StorageKey: "voice-sample.wav", MIMEType: "audio/wav",
		SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", MediaObjectVersion: "blob-v1", CreatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	consent, err := backend.CreateVoiceConsent(t.Context(), tenantID, projectID, VoiceConsent{
		ID: "consent-one", VoiceIdentityID: identity.ID, Accepted: true, RightsBasis: "self",
		SubjectDisplayName: "Performer", TermsVersion: "voice-clone-v1", ActorID: "owner-one", AcceptedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	job := GenerationJob{
		ID: "voice-job-one", ProjectID: projectID, Kind: "audio", Status: "queued", Prompt: "Lead", ProviderID: "audio-main", Model: "clone-model",
		Parameters: json.RawMessage(`{"executor":"voice-clone","versionId":"version-one"}`), Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}
	if err := backend.CreateGenerationJob(t.Context(), tenantID, job); err != nil {
		t.Fatal(err)
	}
	version, replayed, err := backend.CreateVoiceCloneVersion(t.Context(), tenantID, projectID,
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", VoiceIdentityVersion{
			ID: "version-one", VoiceIdentityID: identity.ID, SampleIDs: []string{sample.ID}, ConsentID: consent.ID,
			ProviderID: job.ProviderID, Model: job.Model, GenerationJobID: job.ID, CreatedAt: now, UpdatedAt: now,
		})
	if err != nil || replayed || version.Revision != 1 || version.Status != "queued" {
		t.Fatalf("version=%#v replayed=%v err=%v", version, replayed, err)
	}
	replay, replayed, err := backend.CreateVoiceCloneVersion(t.Context(), tenantID, projectID,
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", VoiceIdentityVersion{ID: "different-version"})
	if err != nil || !replayed || replay.ID != version.ID {
		t.Fatalf("replay=%#v replayed=%v err=%v", replay, replayed, err)
	}
	if _, err := backend.GetVoiceIdentity(t.Context(), tenantID+"-other", projectID, identity.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant identity read err=%v", err)
	}
	readyAt := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	ready, err := backend.CompleteVoiceIdentityVersion(t.Context(), tenantID, projectID, version.ID, job.ID, "ready", "provider-voice-1", "", readyAt)
	if err != nil || ready.ProviderVoiceID != "provider-voice-1" || ready.Status != "ready" || ready.SampleIDs[0] != sample.ID {
		t.Fatalf("ready=%#v err=%v", ready, err)
	}
	current, err := backend.GetVoiceIdentity(t.Context(), tenantID, projectID, identity.ID)
	if err != nil || current.CurrentVersionID != version.ID || current.Revision != 2 {
		t.Fatalf("current=%#v err=%v", current, err)
	}
	if _, err := backend.CompleteVoiceIdentityVersion(t.Context(), tenantID, projectID, version.ID, job.ID, "failed", "", "overwrite", readyAt); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminal immutable version changed: %v", err)
	}
}
