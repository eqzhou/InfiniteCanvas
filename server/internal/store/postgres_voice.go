package store

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func parseVoiceTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, ErrInvalidInput
	}
	return parsed, nil
}

func scanVoiceIdentity(row pgx.Row) (VoiceIdentity, error) {
	var value VoiceIdentity
	var createdAt, updatedAt time.Time
	err := row.Scan(&value.ID, &value.ProjectID, &value.Revision, &value.Title, &value.Description, &value.CurrentVersionID, &createdAt, &updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoiceIdentity{}, ErrNotFound
		}
		return VoiceIdentity{}, err
	}
	value.CreatedAt, value.UpdatedAt = createdAt.UTC().Format(time.RFC3339Nano), updatedAt.UTC().Format(time.RFC3339Nano)
	return value, nil
}

func (s *PostgresStore) CreateVoiceIdentity(ctx context.Context, tenantID, projectID string, value VoiceIdentity) (VoiceIdentity, error) {
	createdAt, err := parseVoiceTime(value.CreatedAt)
	if err != nil {
		return VoiceIdentity{}, err
	}
	updatedAt, err := parseVoiceTime(value.UpdatedAt)
	if err != nil {
		return VoiceIdentity{}, err
	}
	value.Revision = 1
	return scanVoiceIdentity(s.pool.QueryRow(ctx, `INSERT INTO openboard_film_voice_identities
		(tenant_id,project_id,id,revision,title,description,created_at,updated_at)
		VALUES ($1,$2,$3,1,$4,$5,$6,$7)
		RETURNING id,project_id,revision,title,description,current_version_id,created_at,updated_at`,
		normalizeTenantID(tenantID), projectID, value.ID, value.Title, value.Description, createdAt, updatedAt))
}

func (s *PostgresStore) GetVoiceIdentity(ctx context.Context, tenantID, projectID, id string) (VoiceIdentity, error) {
	return scanVoiceIdentity(s.pool.QueryRow(ctx, `SELECT id,project_id,revision,title,description,current_version_id,created_at,updated_at
		FROM openboard_film_voice_identities WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, normalizeTenantID(tenantID), projectID, id))
}

func (s *PostgresStore) ListVoiceIdentities(ctx context.Context, tenantID, projectID string) ([]VoiceIdentity, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,project_id,revision,title,description,current_version_id,created_at,updated_at
		FROM openboard_film_voice_identities WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at,id`, normalizeTenantID(tenantID), projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []VoiceIdentity{}
	for rows.Next() {
		value, scanErr := scanVoiceIdentity(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func scanVoiceSample(row pgx.Row) (VoiceSample, error) {
	var value VoiceSample
	var createdAt time.Time
	err := row.Scan(&value.ID, &value.ProjectID, &value.VoiceIdentityID, &value.Label, &value.StorageKey, &value.MIMEType, &value.SHA256, &value.MediaObjectVersion, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoiceSample{}, ErrNotFound
		}
		return VoiceSample{}, err
	}
	value.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	return value, nil
}

func (s *PostgresStore) AddVoiceSample(ctx context.Context, tenantID, projectID string, value VoiceSample) (VoiceSample, error) {
	createdAt, err := parseVoiceTime(value.CreatedAt)
	if err != nil {
		return VoiceSample{}, err
	}
	return scanVoiceSample(s.pool.QueryRow(ctx, `INSERT INTO openboard_film_voice_samples
		(tenant_id,project_id,id,voice_identity_id,label,storage_key,mime_type,sha256,media_object_version,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id,project_id,voice_identity_id,label,storage_key,mime_type,sha256,media_object_version,created_at`,
		normalizeTenantID(tenantID), projectID, value.ID, value.VoiceIdentityID, value.Label, value.StorageKey, value.MIMEType, value.SHA256, value.MediaObjectVersion, createdAt))
}

func (s *PostgresStore) GetVoiceSample(ctx context.Context, tenantID, projectID, id string) (VoiceSample, error) {
	return scanVoiceSample(s.pool.QueryRow(ctx, `SELECT id,project_id,voice_identity_id,label,storage_key,mime_type,sha256,media_object_version,created_at
		FROM openboard_film_voice_samples WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, normalizeTenantID(tenantID), projectID, id))
}

func (s *PostgresStore) ListVoiceSamples(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceSample, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,project_id,voice_identity_id,label,storage_key,mime_type,sha256,media_object_version,created_at
		FROM openboard_film_voice_samples WHERE tenant_id=$1 AND project_id=$2 AND voice_identity_id=$3 ORDER BY created_at,id`, normalizeTenantID(tenantID), projectID, voiceIdentityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []VoiceSample{}
	for rows.Next() {
		value, scanErr := scanVoiceSample(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func scanVoiceConsent(row pgx.Row) (VoiceConsent, error) {
	var value VoiceConsent
	var acceptedAt time.Time
	err := row.Scan(&value.ID, &value.ProjectID, &value.VoiceIdentityID, &value.Accepted, &value.RightsBasis, &value.SubjectDisplayName, &value.TermsVersion,
		&value.EvidenceStorageKey, &value.EvidenceMIMEType, &value.EvidenceSHA256, &value.EvidenceObjectVersion, &value.ActorID, &acceptedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoiceConsent{}, ErrNotFound
		}
		return VoiceConsent{}, err
	}
	value.AcceptedAt = acceptedAt.UTC().Format(time.RFC3339Nano)
	return value, nil
}

func (s *PostgresStore) CreateVoiceConsent(ctx context.Context, tenantID, projectID string, value VoiceConsent) (VoiceConsent, error) {
	if !value.Accepted || value.VoiceIdentityID == "" || value.SubjectDisplayName == "" || value.TermsVersion == "" ||
		value.EvidenceStorageKey == "" || value.EvidenceMIMEType == "" || value.EvidenceObjectVersion == "" || value.ActorID == "" ||
		(value.RightsBasis != "self" && value.RightsBasis != "licensed" && value.RightsBasis != "authorized") || !validVoiceSHA256(value.EvidenceSHA256) {
		return VoiceConsent{}, ErrInvalidInput
	}
	acceptedAt, err := parseVoiceTime(value.AcceptedAt)
	if err != nil {
		return VoiceConsent{}, err
	}
	return scanVoiceConsent(s.pool.QueryRow(ctx, `INSERT INTO openboard_film_voice_consents
		(tenant_id,project_id,id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,evidence_storage_key,evidence_mime_type,evidence_sha256,evidence_object_version,actor_id,accepted_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		RETURNING id,project_id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,evidence_storage_key,evidence_mime_type,evidence_sha256,evidence_object_version,actor_id,accepted_at`,
		normalizeTenantID(tenantID), projectID, value.ID, value.VoiceIdentityID, value.Accepted, value.RightsBasis, value.SubjectDisplayName, value.TermsVersion,
		value.EvidenceStorageKey, value.EvidenceMIMEType, value.EvidenceSHA256, value.EvidenceObjectVersion, value.ActorID, acceptedAt))
}

func validVoiceSHA256(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (s *PostgresStore) GetVoiceConsent(ctx context.Context, tenantID, projectID, id string) (VoiceConsent, error) {
	return scanVoiceConsent(s.pool.QueryRow(ctx, `SELECT id,project_id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,evidence_storage_key,evidence_mime_type,evidence_sha256,evidence_object_version,actor_id,accepted_at
		FROM openboard_film_voice_consents WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, normalizeTenantID(tenantID), projectID, id))
}

func (s *PostgresStore) ListVoiceConsents(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceConsent, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,project_id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,evidence_storage_key,evidence_mime_type,evidence_sha256,evidence_object_version,actor_id,accepted_at
		FROM openboard_film_voice_consents WHERE tenant_id=$1 AND project_id=$2 AND voice_identity_id=$3 ORDER BY accepted_at,id`, normalizeTenantID(tenantID), projectID, voiceIdentityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []VoiceConsent{}
	for rows.Next() {
		value, scanErr := scanVoiceConsent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func scanVoiceVersion(row pgx.Row) (VoiceIdentityVersion, error) {
	var value VoiceIdentityVersion
	var createdAt, updatedAt time.Time
	err := row.Scan(&value.ID, &value.ProjectID, &value.VoiceIdentityID, &value.Revision, &value.Status, &value.ConsentID,
		&value.ProviderID, &value.Model, &value.ProviderVoiceID, &value.GenerationJobID, &value.IdempotencyKeyHash,
		&value.Error, &createdAt, &updatedAt, &value.SampleIDs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoiceIdentityVersion{}, ErrNotFound
		}
		return VoiceIdentityVersion{}, err
	}
	value.CreatedAt, value.UpdatedAt = createdAt.UTC().Format(time.RFC3339Nano), updatedAt.UTC().Format(time.RFC3339Nano)
	return value, nil
}

const voiceVersionSelect = `SELECT version.id,version.project_id,version.voice_identity_id,version.revision,version.status,version.consent_id,
	version.provider_id,version.model,version.provider_voice_id,version.generation_job_id,version.idempotency_key_hash,
	version.error,version.created_at,version.updated_at,COALESCE(array_agg(link.sample_id ORDER BY link.position) FILTER (WHERE link.sample_id IS NOT NULL),'{}')
	FROM openboard_film_voice_versions version LEFT JOIN openboard_film_voice_version_samples link
	ON link.tenant_id=version.tenant_id AND link.project_id=version.project_id AND link.version_id=version.id`

func (s *PostgresStore) CreateVoiceCloneBatch(ctx context.Context, tenantID, userID, projectID, idempotencyKeyHash string, value VoiceIdentityVersion, job GenerationJob, units int, usageMeta json.RawMessage, expectedCredits int) (VoiceIdentityVersion, bool, error) {
	var lastErr error
	for range 3 {
		created, replayed, err := s.createVoiceCloneBatchOnce(ctx, tenantID, userID, projectID, idempotencyKeyHash, value, job, units, usageMeta, expectedCredits)
		if !isSerializationFailure(err) {
			return created, replayed, err
		}
		lastErr = err
	}
	return VoiceIdentityVersion{}, false, lastErr
}

func (s *PostgresStore) createVoiceCloneBatchOnce(ctx context.Context, tenantID, userID, projectID, idempotencyKeyHash string, value VoiceIdentityVersion, job GenerationJob, units int, usageMeta json.RawMessage, expectedCredits int) (VoiceIdentityVersion, bool, error) {
	tenantID = normalizeTenantID(tenantID)
	var binding struct {
		Executor        string `json:"executor"`
		ProjectID       string `json:"projectId"`
		VoiceIdentityID string `json:"voiceIdentityId"`
		VersionID       string `json:"versionId"`
		ConsentID       string `json:"consentId"`
	}
	if strings.TrimSpace(userID) == "" || projectID == "" || !validVoiceSHA256(idempotencyKeyHash) || value.ID == "" || value.VoiceIdentityID == "" || len(value.SampleIDs) == 0 || len(value.SampleIDs) > 10 ||
		value.GenerationJobID != job.ID || value.ProjectID != projectID || job.ProjectID != projectID || job.Kind != "audio" || job.Status != "queued" ||
		value.ProviderID == "" || value.Model == "" || value.ProviderID != job.ProviderID || value.Model != job.Model || units < 1 || units > 1_000 || expectedCredits < 1 || expectedCredits > 1_000_000_000 ||
		json.Unmarshal(job.Parameters, &binding) != nil || binding.Executor != "voice-clone" || binding.ProjectID != projectID || binding.VoiceIdentityID != value.VoiceIdentityID ||
		binding.VersionID != value.ID || binding.ConsentID != value.ConsentID || !json.Valid(job.Result) || !json.Valid(usageMeta) {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	seenSamples := make(map[string]struct{}, len(value.SampleIDs))
	for _, sampleID := range value.SampleIDs {
		if sampleID == "" {
			return VoiceIdentityVersion{}, false, ErrInvalidInput
		}
		if _, duplicate := seenSamples[sampleID]; duplicate {
			return VoiceIdentityVersion{}, false, ErrInvalidInput
		}
		seenSamples[sampleID] = struct{}{}
	}
	createdAt, err := parseVoiceTime(value.CreatedAt)
	if err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	jobCreatedAt, err := time.Parse(time.RFC3339Nano, job.CreatedAt)
	if err != nil {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	jobUpdatedAt, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	defer tx.Rollback(ctx)
	if err := lockWorkspace(ctx, tx, tenantID); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	existing, getErr := scanVoiceVersion(tx.QueryRow(ctx, voiceVersionSelect+`
		WHERE version.tenant_id=$1 AND version.project_id=$2 AND version.idempotency_key_hash=$3
		GROUP BY version.tenant_id,version.project_id,version.id`, tenantID, projectID, idempotencyKeyHash))
	if getErr == nil {
		return existing, true, tx.Commit(ctx)
	}
	if !errors.Is(getErr, ErrNotFound) {
		return VoiceIdentityVersion{}, false, getErr
	}
	var identityExists int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM openboard_film_voice_identities
		WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, tenantID, projectID, value.VoiceIdentityID).Scan(&identityExists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoiceIdentityVersion{}, false, ErrNotFound
		}
		return VoiceIdentityVersion{}, false, err
	}
	var consentVoiceID, evidenceDigest, evidenceVersion string
	if err := tx.QueryRow(ctx, `SELECT voice_identity_id,evidence_sha256,evidence_object_version FROM openboard_film_voice_consents
		WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND accepted
		AND evidence_sha256 ~ '^[a-f0-9]{64}$' AND evidence_object_version <> ''`, tenantID, projectID, value.ConsentID).
		Scan(&consentVoiceID, &evidenceDigest, &evidenceVersion); err != nil || consentVoiceID != value.VoiceIdentityID || evidenceDigest == "" || evidenceVersion == "" {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	for _, sampleID := range value.SampleIDs {
		var sampleVoiceID string
		if err := tx.QueryRow(ctx, `SELECT voice_identity_id FROM openboard_film_voice_samples
			WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, tenantID, projectID, sampleID).Scan(&sampleVoiceID); err != nil || sampleVoiceID != value.VoiceIdentityID {
			return VoiceIdentityVersion{}, false, ErrInvalidInput
		}
	}
	var nextRevision int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(revision),0)+1 FROM openboard_film_voice_versions
		WHERE tenant_id=$1 AND project_id=$2 AND voice_identity_id=$3`, tenantID, projectID, value.VoiceIdentityID).Scan(&nextRevision); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO openboard_generation_jobs
		(tenant_id,id,project_id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (tenant_id,id) DO NOTHING`, tenantID, job.ID, job.ProjectID, job.Kind, job.Status, job.Prompt,
		job.ProviderID, job.Model, job.Parameters, job.Result, job.Error, jobCreatedAt, jobUpdatedAt)
	if err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	if inserted.RowsAffected() == 0 {
		return VoiceIdentityVersion{}, false, generationJobConflictError(ctx, tx, tenantID, job.ID)
	}
	var quota int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT generation_quota_monthly FROM openboard_tenants WHERE id=$1),$2)`, tenantID, defaultGenerationQuotaMonthly).Scan(&quota); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var used int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(units),0) FROM openboard_usage_events
		WHERE tenant_id=$1 AND kind='generation' AND created_at >= $2`, tenantID, monthStart).Scan(&used); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	if generationQuotaExceeded(used, units, quota) {
		return VoiceIdentityVersion{}, false, ErrQuotaExceeded
	}
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
		VALUES ($1,$2,'generation',$3,$4)`, tenantID, userID, units, usageMeta); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	cost, err := s.modelCreditCostTx(ctx, tx, tenantID, job.Model)
	if err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	if cost < 1 || cost > 1_000_000_000/units {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	totalCredits := cost * units
	if totalCredits != expectedCredits {
		return VoiceIdentityVersion{}, false, ErrConflict
	}
	if err := s.reserveCreditsTx(ctx, tx, tenantID, userID, job.ID, job.Model, totalCredits, usageMeta); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	value.Revision, value.IdempotencyKeyHash = nextRevision, idempotencyKeyHash
	if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_voice_versions
		(tenant_id,project_id,id,voice_identity_id,revision,status,consent_id,provider_id,model,generation_job_id,idempotency_key_hash,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$11)`, tenantID, projectID, value.ID, value.VoiceIdentityID,
		value.Revision, value.ConsentID, value.ProviderID, value.Model, value.GenerationJobID, idempotencyKeyHash, createdAt); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	for position, sampleID := range value.SampleIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO openboard_film_voice_version_samples
			(tenant_id,project_id,version_id,sample_id,position) VALUES ($1,$2,$3,$4,$5)`, tenantID, projectID, value.ID, sampleID, position); err != nil {
			return VoiceIdentityVersion{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	value.Status, value.UpdatedAt = "queued", value.CreatedAt
	return value, false, nil
}

func (s *PostgresStore) ListVoiceIdentityVersions(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceIdentityVersion, error) {
	rows, err := s.pool.Query(ctx, voiceVersionSelect+` WHERE version.tenant_id=$1 AND version.project_id=$2 AND version.voice_identity_id=$3
		GROUP BY version.tenant_id,version.project_id,version.id ORDER BY version.revision`, normalizeTenantID(tenantID), projectID, voiceIdentityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []VoiceIdentityVersion{}
	for rows.Next() {
		value, scanErr := scanVoiceVersion(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func (s *PostgresStore) CompleteVoiceIdentityVersion(ctx context.Context, tenantID, projectID, versionID, jobID, status, providerVoiceID, message, updatedAt string) (VoiceIdentityVersion, error) {
	if status != "running" && status != "ready" && status != "failed" && status != "canceled" {
		return VoiceIdentityVersion{}, ErrInvalidInput
	}
	when, err := parseVoiceTime(updatedAt)
	if err != nil {
		return VoiceIdentityVersion{}, err
	}
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return VoiceIdentityVersion{}, err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE openboard_film_voice_versions SET status=$5,provider_voice_id=$6,error=$7,updated_at=$8
		WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND generation_job_id=$4
		AND status IN ('queued','running')`, tenantID, projectID, versionID, jobID, status, providerVoiceID, message, when)
	if err != nil {
		return VoiceIdentityVersion{}, err
	}
	if result.RowsAffected() == 0 {
		return VoiceIdentityVersion{}, ErrConflict
	}
	if status == "ready" {
		if _, err := tx.Exec(ctx, `UPDATE openboard_film_voice_identities identity SET current_version_id=$4,revision=revision+1,updated_at=$5
			FROM openboard_film_voice_versions version WHERE identity.tenant_id=$1 AND identity.project_id=$2 AND identity.id=version.voice_identity_id
			AND version.tenant_id=$1 AND version.project_id=$2 AND version.id=$3`, tenantID, projectID, versionID, versionID, when); err != nil {
			return VoiceIdentityVersion{}, err
		}
	}
	value, err := scanVoiceVersion(tx.QueryRow(ctx, voiceVersionSelect+` WHERE version.tenant_id=$1 AND version.project_id=$2 AND version.id=$3
		GROUP BY version.tenant_id,version.project_id,version.id`, tenantID, projectID, versionID))
	if err != nil {
		return VoiceIdentityVersion{}, err
	}
	return value, tx.Commit(ctx)
}
