package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestVoiceIdentityReadyUpdateQualifiesRevisionColumn(t *testing.T) {
	source, err := os.ReadFile("postgres_voice.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "revision=identity.revision+1") {
		t.Fatal("ready update must qualify identity.revision; the joined version table also has revision")
	}
}

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
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_tenants (id,name,generation_quota_monthly) VALUES ($1,$2,100)
ON CONFLICT (id) DO NOTHING`, tenantID, tenantID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID)
	})
	if err := backend.PutProject(t.Context(), tenantID, projectID, []byte(`{"title":"Voice Film","updatedAt":"2026-08-11T00:00:00Z"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.CreateFilmProject(t.Context(), tenantID, projectID, []byte(completeFilmProjectionDocument)); err != nil {
		t.Fatal(err)
	}
	userID := "voice-owner-" + tenantID
	if _, err := backend.pool.Exec(t.Context(), `INSERT INTO openboard_users
		(id,tenant_id,email,password_hash,display_name,role,credits,status)
		VALUES ($1,$2,$3,'','Voice owner','owner',100,'active')`, userID, tenantID, tenantID+"@example.invalid"); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutModelCreditConfig(t.Context(), tenantID, ModelCreditConfig{DefaultCredits: 1, ModelCosts: []ModelCreditCost{{Model: "clone-model", Credits: 7}}}); err != nil {
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
		SubjectDisplayName: "Performer", TermsVersion: "voice-clone-v1", EvidenceStorageKey: "consent.txt",
		EvidenceMIMEType: "text/plain", EvidenceSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		EvidenceObjectVersion: "blob-consent-v1", ActorID: "owner-one", AcceptedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	samples, err := backend.ListVoiceSamples(t.Context(), tenantID, projectID, identity.ID)
	if err != nil || len(samples) != 1 || samples[0].ID != sample.ID {
		t.Fatalf("samples=%#v err=%v", samples, err)
	}
	consents, err := backend.ListVoiceConsents(t.Context(), tenantID, projectID, identity.ID)
	if err != nil || len(consents) != 1 || consents[0].ID != consent.ID {
		t.Fatalf("consents=%#v err=%v", consents, err)
	}
	if other, err := backend.ListVoiceSamples(t.Context(), tenantID+"-other", projectID, identity.ID); err != nil || len(other) != 0 {
		t.Fatalf("cross-tenant samples=%#v err=%v", other, err)
	}
	job := GenerationJob{
		ID: "voice-job-one", ProjectID: projectID, Kind: "audio", Status: "queued", Prompt: "Lead", ProviderID: "audio-main", Model: "clone-model",
		Parameters: json.RawMessage(`{"executor":"voice-clone","projectId":"voice-film","voiceIdentityId":"voice-one","versionId":"version-one","consentId":"consent-one"}`), Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}
	version, replayed, err := backend.CreateVoiceCloneBatch(t.Context(), tenantID, userID, projectID,
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", VoiceIdentityVersion{
			ID: "version-one", ProjectID: projectID, VoiceIdentityID: identity.ID, SampleIDs: []string{sample.ID}, ConsentID: consent.ID,
			ProviderID: job.ProviderID, Model: job.Model, GenerationJobID: job.ID, CreatedAt: now, UpdatedAt: now,
		}, job, 1, json.RawMessage(`{"operation":"voice_clone"}`), 7)
	if err != nil || replayed || version.Revision != 1 || version.Status != "queued" {
		t.Fatalf("version=%#v replayed=%v err=%v", version, replayed, err)
	}
	replay, replayed, err := backend.CreateVoiceCloneBatch(t.Context(), tenantID, userID, projectID,
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", version, job, 1, json.RawMessage(`{}`), 7)
	if err != nil || !replayed || replay.ID != version.ID {
		t.Fatalf("replay=%#v replayed=%v err=%v", replay, replayed, err)
	}
	var credits int64
	if err := backend.pool.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID).Scan(&credits); err != nil || credits != 93 {
		t.Fatalf("voice clone model cost credits=%d err=%v", credits, err)
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

	cancelJob := job
	cancelJob.ID = "voice-job-cancel"
	cancelJob.Parameters = json.RawMessage(`{"executor":"voice-clone","projectId":"voice-film","voiceIdentityId":"voice-one","versionId":"version-cancel","consentId":"consent-one"}`)
	cancelVersion, replayed, err := backend.CreateVoiceCloneBatch(t.Context(), tenantID, userID, projectID,
		"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", VoiceIdentityVersion{
			ID: "version-cancel", ProjectID: projectID, VoiceIdentityID: identity.ID, SampleIDs: []string{sample.ID}, ConsentID: consent.ID,
			ProviderID: cancelJob.ProviderID, Model: cancelJob.Model, GenerationJobID: cancelJob.ID, CreatedAt: now, UpdatedAt: now,
		}, cancelJob, 1, json.RawMessage(`{"operation":"voice_clone"}`), 7)
	if err != nil || replayed || cancelVersion.Status != "queued" {
		t.Fatalf("cancel version=%#v replayed=%v err=%v", cancelVersion, replayed, err)
	}
	if _, err := backend.CancelServerGenerationJob(t.Context(), tenantID, cancelJob.ID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	canceledVersions, err := backend.ListVoiceIdentityVersions(t.Context(), tenantID, projectID, identity.ID)
	if err != nil || len(canceledVersions) != 2 || canceledVersions[1].Status != "canceled" {
		t.Fatalf("atomic canceled versions=%#v err=%v", canceledVersions, err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2`, tenantID, userID).Scan(&credits); err != nil || credits != 93 {
		t.Fatalf("voice clone cancel refund credits=%d err=%v", credits, err)
	}
}
