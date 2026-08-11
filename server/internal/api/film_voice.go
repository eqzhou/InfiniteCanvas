package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxVoiceSampleBytes          = 20 << 20
	maxVoiceConsentEvidenceBytes = 20 << 20
	maxVoiceCloneSamples         = 10
	voiceCloneExecutorMarker     = "voice-clone"
)

type createVoiceIdentityRequest struct {
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type createVoiceSampleRequest struct {
	StorageKey string `json:"storageKey"`
	Label      string `json:"label,omitempty"`
}

type createVoiceConsentRequest struct {
	Accepted           bool   `json:"accepted"`
	RightsBasis        string `json:"rightsBasis"`
	SubjectDisplayName string `json:"subjectDisplayName"`
	TermsVersion       string `json:"termsVersion"`
	EvidenceStorageKey string `json:"evidenceStorageKey"`
}

type createVoiceCloneRequest struct {
	ProviderID     string   `json:"providerId"`
	Model          string   `json:"model"`
	SampleIDs      []string `json:"sampleIds"`
	ConsentID      string   `json:"consentId"`
	IdempotencyKey string   `json:"idempotencyKey"`
}

type voiceCloneSampleSnapshot struct {
	ID            string `json:"id"`
	StorageKey    string `json:"storageKey"`
	MIMEType      string `json:"mimeType"`
	SHA256        string `json:"sha256"`
	ObjectVersion string `json:"objectVersion,omitempty"`
}

type voiceCloneJobParameters struct {
	Executor        string                     `json:"executor"`
	RequestHash     string                     `json:"requestHash"`
	ProjectID       string                     `json:"projectId"`
	VoiceIdentityID string                     `json:"voiceIdentityId"`
	VersionID       string                     `json:"versionId"`
	ConsentID       string                     `json:"consentId"`
	Samples         []voiceCloneSampleSnapshot `json:"samples"`
}

func mountFilmVoiceRoutes(r chi.Router, server *Server) {
	r.Get("/film/projects/{projectId}/voice-identities", server.listVoiceIdentities)
	r.Post("/film/projects/{projectId}/voice-identities", server.createVoiceIdentity)
	r.Post("/film/projects/{projectId}/voice-identities/{voiceId}/samples", server.addVoiceSample)
	r.Post("/film/projects/{projectId}/voice-identities/{voiceId}/consents", server.createVoiceConsent)
	r.Post("/film/projects/{projectId}/voice-identities/{voiceId}/clone", server.createVoiceClone)
	r.Get("/film/projects/{projectId}/voice-identities/{voiceId}/versions", server.listVoiceVersions)
	r.Post("/film/projects/{projectId}/voice-identities/{voiceId}/versions/{versionId}/sync", server.syncVoiceVersion)
}

func advancedVoiceEnabled() bool {
	return incrementFeatureEnabled(advancedVoiceFeatureEnv)
}

func (s *Server) voiceIdentityStore(w http.ResponseWriter) (store.VoiceIdentityStore, bool) {
	if !advancedVoiceEnabled() {
		w.WriteHeader(http.StatusNotFound)
		return nil, false
	}
	backend, ok := s.store.(store.VoiceIdentityStore)
	if !ok {
		writeFilmError(w, http.StatusServiceUnavailable, "voice_storage_unavailable", "Durable voice identity storage is unavailable")
		return nil, false
	}
	return backend, true
}

func (s *Server) loadVoiceProject(w http.ResponseWriter, r *http.Request) (store.VoiceIdentityStore, string, bool) {
	backend, ok := s.voiceIdentityStore(w)
	if !ok {
		return nil, "", false
	}
	projectID := chi.URLParam(r, "projectId")
	if !validProjectID(projectID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_project", "projectId is invalid")
		return nil, "", false
	}
	if _, _, _, loaded := s.loadFilmProduction(w, r, false); !loaded {
		return nil, "", false
	}
	return backend, projectID, true
}

func cleanVoiceField(value, name string, limit int, required bool) (string, error) {
	value = strings.TrimSpace(value)
	if required && value == "" {
		return "", errors.New(name + " is required")
	}
	if len([]rune(value)) > limit || strings.ContainsRune(value, '\x00') {
		return "", errors.New(name + " is invalid")
	}
	return value, nil
}

func writeVoiceData(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(w, map[string]any{"data": value})
}

func (s *Server) createVoiceIdentity(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	var input createVoiceIdentityRequest
	if err := decodeFilmRequest(w, r, 16<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "A valid voice identity is required")
		return
	}
	title, titleErr := cleanVoiceField(input.Title, "title", 500, true)
	description, descriptionErr := cleanVoiceField(input.Description, "description", 5000, false)
	if titleErr != nil || descriptionErr != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "Voice identity fields are invalid")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	value := store.VoiceIdentity{
		ID: stableFilmID("voice", projectID, now, title), ProjectID: projectID, Revision: 1,
		Title: title, Description: description, CreatedAt: now, UpdatedAt: now,
	}
	created, err := backend.CreateVoiceIdentity(r.Context(), tenantIDFrom(r), projectID, value)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "voice_create_failed", "Voice identity could not be created")
		return
	}
	writeVoiceData(w, http.StatusCreated, created)
}

func (s *Server) listVoiceIdentities(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	values, err := backend.ListVoiceIdentities(r.Context(), tenantIDFrom(r), projectID)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "voice_list_failed", "Voice identities could not be loaded")
		return
	}
	sort.Slice(values, func(i, j int) bool { return values[i].CreatedAt < values[j].CreatedAt })
	writeVoiceData(w, http.StatusOK, values)
}

func (s *Server) addVoiceSample(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	voiceID := chi.URLParam(r, "voiceId")
	if !validProjectID(voiceID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_voice_identity", "Voice identity is invalid")
		return
	}
	if _, err := backend.GetVoiceIdentity(r.Context(), tenantIDFrom(r), projectID, voiceID); errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "voice_identity_not_found", "Voice identity was not found")
		return
	} else if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "voice_read_failed", "Voice identity could not be loaded")
		return
	}
	var input createVoiceSampleRequest
	if err := decodeFilmRequest(w, r, 16<<10, &input); err != nil || !validFilmStorageKey(strings.TrimSpace(input.StorageKey)) {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "A valid sample storageKey is required")
		return
	}
	label, err := cleanVoiceField(input.Label, "label", 500, false)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "Sample label is invalid")
		return
	}
	media, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), strings.TrimSpace(input.StorageKey), maxVoiceSampleBytes)
	if errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "sample_not_found", "Sample media was not found")
		return
	}
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "sample_unavailable", "Sample media could not be verified")
		return
	}
	if len(media.Data) == 0 || !strings.HasPrefix(strings.ToLower(media.Metadata.ContentType), "audio/") {
		writeFilmError(w, http.StatusUnsupportedMediaType, "invalid_sample_media", "Voice samples must be audio media")
		return
	}
	if detected := sniffGeneratedMediaMIME("audio", media.Data); detected == "" || normalizeMediaMIME(media.Metadata.ContentType) != detected {
		writeFilmError(w, http.StatusUnsupportedMediaType, "invalid_sample_media", "Voice sample bytes do not match the declared audio type")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	value := store.VoiceSample{
		ID: stableFilmID("voice_sample", projectID, voiceID, now, input.StorageKey), ProjectID: projectID,
		VoiceIdentityID: voiceID, Label: label, StorageKey: strings.TrimSpace(input.StorageKey),
		MIMEType: media.Metadata.ContentType, SHA256: sha256Hex(media.Data), MediaObjectVersion: blobIdentityVersion(media), CreatedAt: now,
	}
	created, err := backend.AddVoiceSample(r.Context(), tenantIDFrom(r), projectID, value)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "sample_create_failed", "Voice sample could not be recorded")
		return
	}
	writeVoiceData(w, http.StatusCreated, created)
}

func (s *Server) createVoiceConsent(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	actor, authenticated := authUserFrom(r.Context())
	if !authenticated || !strings.EqualFold(actor.Status, "active") || !isTenantAdmin(actor) {
		writeFilmError(w, http.StatusForbidden, "consent_admin_required", "Only an active tenant administrator can record voice consent")
		return
	}
	voiceID := chi.URLParam(r, "voiceId")
	if !validProjectID(voiceID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_voice_identity", "Voice identity is invalid")
		return
	}
	if _, err := backend.GetVoiceIdentity(r.Context(), tenantIDFrom(r), projectID, voiceID); err != nil {
		writeFilmError(w, http.StatusNotFound, "voice_identity_not_found", "Voice identity was not found")
		return
	}
	var input createVoiceConsentRequest
	if err := decodeFilmRequest(w, r, 16<<10, &input); err != nil || !input.Accepted {
		writeFilmError(w, http.StatusBadRequest, "explicit_consent_required", "Voice cloning requires explicit affirmative consent")
		return
	}
	rightsBasis := strings.TrimSpace(input.RightsBasis)
	if rightsBasis != "self" && rightsBasis != "licensed" && rightsBasis != "authorized" {
		writeFilmError(w, http.StatusBadRequest, "invalid_rights_basis", "Voice cloning rights basis is invalid")
		return
	}
	subject, subjectErr := cleanVoiceField(input.SubjectDisplayName, "subjectDisplayName", 500, true)
	terms, termsErr := cleanVoiceField(input.TermsVersion, "termsVersion", 100, true)
	evidenceKey := strings.TrimSpace(input.EvidenceStorageKey)
	actorID := strings.TrimSpace(actor.ID)
	if subjectErr != nil || termsErr != nil || !validProjectID(actorID) || !validFilmStorageKey(evidenceKey) {
		writeFilmError(w, http.StatusBadRequest, "invalid_consent", "Consent audit fields are invalid")
		return
	}
	evidence, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), evidenceKey, maxVoiceConsentEvidenceBytes)
	if errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "consent_evidence_not_found", "Consent evidence was not found")
		return
	}
	if err != nil || len(evidence.Data) == 0 || strings.TrimSpace(evidence.Metadata.ContentType) == "" {
		writeFilmError(w, http.StatusBadRequest, "consent_evidence_invalid", "Consent evidence could not be verified")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	value := store.VoiceConsent{
		ID: stableFilmID("voice_consent", projectID, voiceID, actorID, now), ProjectID: projectID, VoiceIdentityID: voiceID,
		Accepted: true, RightsBasis: rightsBasis, SubjectDisplayName: subject, TermsVersion: terms,
		EvidenceStorageKey: evidenceKey, EvidenceMIMEType: evidence.Metadata.ContentType,
		EvidenceSHA256: sha256Hex(evidence.Data), EvidenceObjectVersion: blobIdentityVersion(evidence),
		ActorID: actorID, AcceptedAt: now,
	}
	created, err := backend.CreateVoiceConsent(r.Context(), tenantIDFrom(r), projectID, value)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "consent_create_failed", "Consent audit could not be recorded")
		return
	}
	writeVoiceData(w, http.StatusCreated, created)
}

func hashVoiceIdempotency(tenantID, projectID, voiceID, key string) string {
	digest := sha256.Sum256([]byte(tenantID + "\x00" + projectID + "\x00" + voiceID + "\x00" + key))
	return hex.EncodeToString(digest[:])
}

func (s *Server) createVoiceClone(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	voiceID := chi.URLParam(r, "voiceId")
	if !validProjectID(voiceID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_voice_identity", "Voice identity is invalid")
		return
	}
	identity, err := backend.GetVoiceIdentity(r.Context(), tenantIDFrom(r), projectID, voiceID)
	if err != nil {
		writeFilmError(w, http.StatusNotFound, "voice_identity_not_found", "Voice identity was not found")
		return
	}
	var input createVoiceCloneRequest
	if err := decodeFilmRequest(w, r, 64<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "A valid clone request is required")
		return
	}
	input.ProviderID, _ = cleanVoiceField(input.ProviderID, "providerId", 128, true)
	input.Model, _ = cleanVoiceField(input.Model, "model", 500, true)
	input.ConsentID, _ = cleanVoiceField(input.ConsentID, "consentId", 128, true)
	input.IdempotencyKey, _ = cleanVoiceField(input.IdempotencyKey, "idempotencyKey", 128, true)
	if !validProjectID(input.ProviderID) || input.Model == "" || !validProjectID(input.ConsentID) || len(input.IdempotencyKey) < 8 || len(input.SampleIDs) == 0 || len(input.SampleIDs) > maxVoiceCloneSamples {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "Clone provider, model, consent, samples and idempotency key are required")
		return
	}
	if !s.requireAllowedModel(w, r, input.Model) {
		return
	}
	consent, err := backend.GetVoiceConsent(r.Context(), tenantIDFrom(r), projectID, input.ConsentID)
	if err != nil || !consent.Accepted || consent.VoiceIdentityID != voiceID || !validSHA256Hex(consent.EvidenceSHA256) || consent.EvidenceStorageKey == "" || consent.EvidenceMIMEType == "" || consent.EvidenceObjectVersion == "" {
		writeFilmError(w, http.StatusBadRequest, "consent_required", "A matching affirmative consent record is required")
		return
	}
	evidence, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), consent.EvidenceStorageKey, maxVoiceConsentEvidenceBytes)
	if err != nil || verifyFilmBlob(evidence, "", consent.EvidenceMIMEType, consent.EvidenceSHA256, consent.EvidenceObjectVersion, 0) != nil {
		writeFilmError(w, http.StatusConflict, "consent_evidence_changed", "Voice consent evidence is unavailable or changed")
		return
	}
	estimatedCredits, err := s.store.GetModelCreditCost(r.Context(), tenantIDFrom(r), input.Model)
	if err != nil || estimatedCredits < 1 || estimatedCredits > 1_000_000_000 {
		writeFilmError(w, http.StatusServiceUnavailable, "billing_unavailable", "Voice clone credit quote is unavailable")
		return
	}
	seen := map[string]struct{}{}
	snapshots := make([]voiceCloneSampleSnapshot, 0, len(input.SampleIDs))
	for _, sampleID := range input.SampleIDs {
		if !validProjectID(sampleID) {
			writeFilmError(w, http.StatusBadRequest, "invalid_sample", "Voice sample is invalid")
			return
		}
		if _, duplicate := seen[sampleID]; duplicate {
			writeFilmError(w, http.StatusBadRequest, "duplicate_sample", "Voice samples must be unique")
			return
		}
		seen[sampleID] = struct{}{}
		sample, sampleErr := backend.GetVoiceSample(r.Context(), tenantIDFrom(r), projectID, sampleID)
		if sampleErr != nil || sample.VoiceIdentityID != voiceID {
			writeFilmError(w, http.StatusBadRequest, "invalid_sample", "Voice samples must belong to this identity")
			return
		}
		media, readErr := s.readTenantBlob(r.Context(), tenantIDFrom(r), sample.StorageKey, maxVoiceSampleBytes)
		if readErr != nil || sha256Hex(media.Data) != sample.SHA256 || blobIdentityVersion(media) != sample.MediaObjectVersion || media.Metadata.ContentType != sample.MIMEType {
			writeFilmError(w, http.StatusConflict, "sample_changed", "A voice sample changed after it was recorded")
			return
		}
		snapshots = append(snapshots, voiceCloneSampleSnapshot{ID: sample.ID, StorageKey: sample.StorageKey, MIMEType: sample.MIMEType, SHA256: sample.SHA256, ObjectVersion: sample.MediaObjectVersion})
	}
	tenantID := tenantIDFrom(r)
	idempotencyHash := hashVoiceIdempotency(tenantID, projectID, voiceID, input.IdempotencyKey)
	versionID := stableFilmID("voice_version", projectID, voiceID, idempotencyHash)
	jobID := stableFilmID("voice_clone_job", projectID, voiceID, idempotencyHash)
	requestHash, _ := hashGenerationInput(struct {
		ProjectID string
		VoiceID   string
		Provider  string
		Model     string
		ConsentID string
		Samples   []voiceCloneSampleSnapshot
	}{projectID, voiceID, input.ProviderID, input.Model, input.ConsentID, snapshots})
	parameters, _ := json.Marshal(voiceCloneJobParameters{
		Executor: voiceCloneExecutorMarker, RequestHash: requestHash, ProjectID: projectID,
		VoiceIdentityID: voiceID, VersionID: versionID, ConsentID: input.ConsentID, Samples: snapshots,
	})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := store.GenerationJob{
		ID: jobID, ProjectID: projectID, Kind: "audio", Status: "queued", Prompt: identity.Title,
		ProviderID: input.ProviderID, Model: input.Model, Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}
	meta, _ := json.Marshal(map[string]any{"jobId": jobID, "kind": "audio", "executor": voiceCloneExecutorMarker, "voiceIdentityId": voiceID})
	value := store.VoiceIdentityVersion{
		ID: versionID, ProjectID: projectID, VoiceIdentityID: voiceID, Status: "queued", SampleIDs: append([]string(nil), input.SampleIDs...),
		ConsentID: input.ConsentID, ProviderID: input.ProviderID, Model: input.Model, GenerationJobID: jobID, CreatedAt: now, UpdatedAt: now,
	}
	atomicBackend, available := s.store.(store.VoiceCloneBatchStore)
	if !available {
		writeFilmError(w, http.StatusServiceUnavailable, "voice_clone_transaction_unavailable", "Atomic voice clone storage is unavailable")
		return
	}
	created, replayed, err := atomicBackend.CreateVoiceCloneBatch(r.Context(), tenantID, userIDFrom(r), projectID, idempotencyHash, value, job, 1, meta, estimatedCredits)
	if err != nil {
		writeGenerationCreationError(w, err)
		return
	}
	if created.ID != versionID || created.ProjectID != projectID || created.VoiceIdentityID != voiceID || created.GenerationJobID != jobID || created.ProviderID != input.ProviderID || created.Model != input.Model || created.ConsentID != input.ConsentID {
		writeFilmError(w, http.StatusConflict, "voice_clone_replay_conflict", "Idempotency key belongs to a different voice clone request")
		return
	}
	if !replayed {
		s.notifyVoiceCloneWorkers()
	}
	status := http.StatusAccepted
	if replayed {
		status = http.StatusOK
	}
	writeVoiceData(w, status, created)
}

func writeGenerationCreationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrQuotaExceeded):
		writeFilmError(w, http.StatusTooManyRequests, "generation_quota_exceeded", "Generation quota exceeded")
	case errors.Is(err, store.ErrInsufficientCredits):
		writeFilmError(w, http.StatusPaymentRequired, "insufficient_credits", "Insufficient credits")
	case errors.Is(err, store.ErrUnauthorized):
		writeFilmError(w, http.StatusUnauthorized, "login_required", "Login is required for voice cloning")
	case errors.Is(err, store.ErrBanned):
		writeFilmError(w, http.StatusForbidden, "account_disabled", "Account is disabled")
	case errors.Is(err, store.ErrConflict):
		writeFilmError(w, http.StatusConflict, "voice_clone_conflict", "Voice clone request conflicts with current billing or idempotency state")
	default:
		writeFilmError(w, http.StatusInternalServerError, "generation_job_failed", "Voice clone generation job could not be stored")
	}
}

func (s *Server) listVoiceVersions(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	voiceID := chi.URLParam(r, "voiceId")
	if !validProjectID(voiceID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_voice_identity", "Voice identity is invalid")
		return
	}
	if _, err := backend.GetVoiceIdentity(r.Context(), tenantIDFrom(r), projectID, voiceID); err != nil {
		writeFilmError(w, http.StatusNotFound, "voice_identity_not_found", "Voice identity was not found")
		return
	}
	values, err := backend.ListVoiceIdentityVersions(r.Context(), tenantIDFrom(r), projectID, voiceID)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "voice_versions_failed", "Voice versions could not be loaded")
		return
	}
	sort.Slice(values, func(i, j int) bool { return values[i].Revision < values[j].Revision })
	writeVoiceData(w, http.StatusOK, values)
}

func (s *Server) syncVoiceVersion(w http.ResponseWriter, r *http.Request) {
	backend, projectID, ok := s.loadVoiceProject(w, r)
	if !ok {
		return
	}
	voiceID, versionID := chi.URLParam(r, "voiceId"), chi.URLParam(r, "versionId")
	if !validProjectID(voiceID) || !validProjectID(versionID) {
		writeFilmError(w, http.StatusBadRequest, "invalid_voice_version", "Voice version is invalid")
		return
	}
	versions, err := backend.ListVoiceIdentityVersions(r.Context(), tenantIDFrom(r), projectID, voiceID)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "voice_versions_failed", "Voice versions could not be loaded")
		return
	}
	var selected store.VoiceIdentityVersion
	found := false
	for _, version := range versions {
		if version.ID == versionID {
			selected, found = version, true
			break
		}
	}
	if !found {
		writeFilmError(w, http.StatusNotFound, "voice_version_not_found", "Voice version was not found")
		return
	}
	if selected.Status == "ready" || selected.Status == "failed" || selected.Status == "canceled" {
		writeVoiceData(w, http.StatusOK, selected)
		return
	}
	job, err := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), selected.GenerationJobID)
	if err != nil {
		writeFilmError(w, http.StatusConflict, "clone_job_unavailable", "Voice clone generation job is unavailable")
		return
	}
	status, providerVoiceID, message := "", "", ""
	switch job.Status {
	case "running":
		status = "running"
	case "succeeded":
		var result struct {
			VoiceID string `json:"voiceId"`
		}
		if json.Unmarshal(job.Result, &result) != nil || strings.TrimSpace(result.VoiceID) == "" {
			status, message = "failed", "Voice clone result is invalid"
		} else {
			status, providerVoiceID = "ready", strings.TrimSpace(result.VoiceID)
		}
	case "failed":
		status, message = "failed", "Voice clone provider failed"
	case "cancelled":
		status, message = "canceled", "Voice clone was canceled"
	default:
		writeVoiceData(w, http.StatusOK, selected)
		return
	}
	updated, err := backend.CompleteVoiceIdentityVersion(r.Context(), tenantIDFrom(r), projectID, selected.ID, job.ID, status, providerVoiceID, message, job.UpdatedAt)
	if err != nil {
		writeFilmError(w, http.StatusConflict, "voice_version_conflict", "Voice version lifecycle changed concurrently")
		return
	}
	writeVoiceData(w, http.StatusOK, updated)
}
