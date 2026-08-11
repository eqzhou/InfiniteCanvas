package store

import (
	"context"
	"errors"
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

func scanVoiceConsent(row pgx.Row) (VoiceConsent, error) {
	var value VoiceConsent
	var acceptedAt time.Time
	err := row.Scan(&value.ID, &value.ProjectID, &value.VoiceIdentityID, &value.Accepted, &value.RightsBasis, &value.SubjectDisplayName, &value.TermsVersion, &value.ActorID, &acceptedAt)
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
	acceptedAt, err := parseVoiceTime(value.AcceptedAt)
	if err != nil {
		return VoiceConsent{}, err
	}
	return scanVoiceConsent(s.pool.QueryRow(ctx, `INSERT INTO openboard_film_voice_consents
		(tenant_id,project_id,id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,actor_id,accepted_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id,project_id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,actor_id,accepted_at`,
		normalizeTenantID(tenantID), projectID, value.ID, value.VoiceIdentityID, value.Accepted, value.RightsBasis, value.SubjectDisplayName, value.TermsVersion, value.ActorID, acceptedAt))
}

func (s *PostgresStore) GetVoiceConsent(ctx context.Context, tenantID, projectID, id string) (VoiceConsent, error) {
	return scanVoiceConsent(s.pool.QueryRow(ctx, `SELECT id,project_id,voice_identity_id,accepted,rights_basis,subject_display_name,terms_version,actor_id,accepted_at
		FROM openboard_film_voice_consents WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, normalizeTenantID(tenantID), projectID, id))
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

func (s *PostgresStore) CreateVoiceCloneVersion(ctx context.Context, tenantID, projectID, idempotencyKeyHash string, value VoiceIdentityVersion) (VoiceIdentityVersion, bool, error) {
	tenantID = normalizeTenantID(tenantID)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	defer tx.Rollback(ctx)
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
	var nextRevision int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(revision),0)+1 FROM openboard_film_voice_versions
		WHERE tenant_id=$1 AND project_id=$2 AND voice_identity_id=$3`, tenantID, projectID, value.VoiceIdentityID).Scan(&nextRevision); err != nil {
		return VoiceIdentityVersion{}, false, err
	}
	var consentVoiceID string
	if err := tx.QueryRow(ctx, `SELECT voice_identity_id FROM openboard_film_voice_consents
		WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND accepted`, tenantID, projectID, value.ConsentID).Scan(&consentVoiceID); err != nil || consentVoiceID != value.VoiceIdentityID {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	for _, sampleID := range value.SampleIDs {
		var sampleVoiceID string
		if err := tx.QueryRow(ctx, `SELECT voice_identity_id FROM openboard_film_voice_samples
			WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, tenantID, projectID, sampleID).Scan(&sampleVoiceID); err != nil || sampleVoiceID != value.VoiceIdentityID {
			return VoiceIdentityVersion{}, false, ErrInvalidInput
		}
	}
	var generationExists int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM openboard_generation_jobs
		WHERE tenant_id=$1 AND id=$2 AND project_id=$3 AND kind='audio' AND status='queued'
		AND provider_id=$4 AND model=$5 AND parameters->>'executor'='voice-clone' AND parameters->>'versionId'=$6`,
		tenantID, value.GenerationJobID, projectID, value.ProviderID, value.Model, value.ID).Scan(&generationExists); err != nil {
		return VoiceIdentityVersion{}, false, ErrInvalidInput
	}
	createdAt, err := parseVoiceTime(value.CreatedAt)
	if err != nil {
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
