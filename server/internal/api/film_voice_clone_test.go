package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type voiceFilmMemoryStore struct {
	*filmMemoryStore
	voiceMu          sync.Mutex
	identities       map[string]store.VoiceIdentity
	samples          map[string]store.VoiceSample
	consents         map[string]store.VoiceConsent
	versions         map[string]store.VoiceIdentityVersion
	idempotencies    map[string]string
	legacyJobCreates atomic.Int32
	atomicBatchCalls atomic.Int32
	atomicCredits    atomic.Int32
}

type scriptedVoiceCloneExecutor struct {
	requests chan voiceCloneProviderRequest
}

type rejectingVoiceVersionStore struct {
	*voiceFilmMemoryStore
}

func (m *rejectingVoiceVersionStore) CompleteVoiceIdentityVersion(_ context.Context, _, _, _, _, status, _, _, _ string) (store.VoiceIdentityVersion, error) {
	if status == "running" {
		return store.VoiceIdentityVersion{}, store.ErrConflict
	}
	return store.VoiceIdentityVersion{}, store.ErrNotFound
}

func (e *scriptedVoiceCloneExecutor) Clone(_ context.Context, request voiceCloneProviderRequest) (string, error) {
	e.requests <- request
	return "provider-voice-worker", nil
}

func newVoiceFilmMemoryStore() *voiceFilmMemoryStore {
	return &voiceFilmMemoryStore{
		filmMemoryStore: newFilmMemoryStore(), identities: map[string]store.VoiceIdentity{},
		samples: map[string]store.VoiceSample{}, consents: map[string]store.VoiceConsent{},
		versions: map[string]store.VoiceIdentityVersion{}, idempotencies: map[string]string{},
	}
}

func voiceStoreKey(tenantID, projectID, id string) string {
	return tenantKey(tenantID, projectID+"\x00"+id)
}

func (m *voiceFilmMemoryStore) CreateVoiceIdentity(_ context.Context, tenantID, projectID string, value store.VoiceIdentity) (store.VoiceIdentity, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	key := voiceStoreKey(tenantID, projectID, value.ID)
	if _, exists := m.identities[key]; exists {
		return store.VoiceIdentity{}, store.ErrConflict
	}
	m.identities[key] = value
	return value, nil
}

func (m *voiceFilmMemoryStore) GetVoiceIdentity(_ context.Context, tenantID, projectID, id string) (store.VoiceIdentity, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	value, exists := m.identities[voiceStoreKey(tenantID, projectID, id)]
	if !exists {
		return store.VoiceIdentity{}, store.ErrNotFound
	}
	return value, nil
}

func (m *voiceFilmMemoryStore) ListVoiceIdentities(_ context.Context, tenantID, projectID string) ([]store.VoiceIdentity, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	prefix := voiceStoreKey(tenantID, projectID, "")
	values := []store.VoiceIdentity{}
	for key, value := range m.identities {
		if strings.HasPrefix(key, prefix) {
			values = append(values, value)
		}
	}
	return values, nil
}

func (m *voiceFilmMemoryStore) AddVoiceSample(_ context.Context, tenantID, projectID string, value store.VoiceSample) (store.VoiceSample, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	if _, exists := m.identities[voiceStoreKey(tenantID, projectID, value.VoiceIdentityID)]; !exists {
		return store.VoiceSample{}, store.ErrNotFound
	}
	key := voiceStoreKey(tenantID, projectID, value.ID)
	if _, exists := m.samples[key]; exists {
		return store.VoiceSample{}, store.ErrConflict
	}
	m.samples[key] = value
	return value, nil
}

func (m *voiceFilmMemoryStore) GetVoiceSample(_ context.Context, tenantID, projectID, id string) (store.VoiceSample, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	value, exists := m.samples[voiceStoreKey(tenantID, projectID, id)]
	if !exists {
		return store.VoiceSample{}, store.ErrNotFound
	}
	return value, nil
}

func (m *voiceFilmMemoryStore) ListVoiceSamples(_ context.Context, tenantID, projectID, voiceID string) ([]store.VoiceSample, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	values := []store.VoiceSample{}
	for key, value := range m.samples {
		if strings.HasPrefix(key, voiceStoreKey(tenantID, projectID, "")) && value.VoiceIdentityID == voiceID {
			values = append(values, value)
		}
	}
	return values, nil
}

func (m *voiceFilmMemoryStore) CreateVoiceConsent(_ context.Context, tenantID, projectID string, value store.VoiceConsent) (store.VoiceConsent, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	if _, exists := m.identities[voiceStoreKey(tenantID, projectID, value.VoiceIdentityID)]; !exists {
		return store.VoiceConsent{}, store.ErrNotFound
	}
	key := voiceStoreKey(tenantID, projectID, value.ID)
	if _, exists := m.consents[key]; exists {
		return store.VoiceConsent{}, store.ErrConflict
	}
	m.consents[key] = value
	return value, nil
}

func (m *voiceFilmMemoryStore) GetVoiceConsent(_ context.Context, tenantID, projectID, id string) (store.VoiceConsent, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	value, exists := m.consents[voiceStoreKey(tenantID, projectID, id)]
	if !exists {
		return store.VoiceConsent{}, store.ErrNotFound
	}
	return value, nil
}

func (m *voiceFilmMemoryStore) ListVoiceConsents(_ context.Context, tenantID, projectID, voiceID string) ([]store.VoiceConsent, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	values := []store.VoiceConsent{}
	for key, value := range m.consents {
		if strings.HasPrefix(key, voiceStoreKey(tenantID, projectID, "")) && value.VoiceIdentityID == voiceID {
			values = append(values, value)
		}
	}
	return values, nil
}

func (m *voiceFilmMemoryStore) CreateServerGenerationJob(ctx context.Context, tenantID, userID string, job store.GenerationJob, units int, usageMeta json.RawMessage) error {
	m.legacyJobCreates.Add(1)
	return m.filmMemoryStore.CreateServerGenerationJob(ctx, tenantID, userID, job, units, usageMeta)
}

func (m *voiceFilmMemoryStore) CancelServerGenerationJob(ctx context.Context, tenantID, id string, now time.Time) (store.GenerationJob, error) {
	job, err := m.filmMemoryStore.CancelServerGenerationJob(ctx, tenantID, id, now)
	if err != nil {
		return store.GenerationJob{}, err
	}
	var parameters voiceCloneJobParameters
	if job.Kind == "audio" && json.Unmarshal(job.Parameters, &parameters) == nil && parameters.Executor == voiceCloneExecutorMarker {
		m.voiceMu.Lock()
		key := voiceStoreKey(tenantID, parameters.ProjectID, parameters.VersionID)
		if version, exists := m.versions[key]; exists && (version.Status == "queued" || version.Status == "running") {
			version.Status, version.Error, version.UpdatedAt = "canceled", "Voice clone was canceled", now.UTC().Format(time.RFC3339Nano)
			m.versions[key] = version
		}
		m.voiceMu.Unlock()
	}
	return job, nil
}

// CreateVoiceCloneBatch is the transaction-shaped fake expected by the voice
// API. The production PostgreSQL implementation must provide the same atomic
// boundary; this fake also lets the test prove the legacy two-write path is not
// used.
func (m *voiceFilmMemoryStore) CreateVoiceCloneBatch(_ context.Context, tenantID, userID, projectID, idempotencyKey string, value store.VoiceIdentityVersion, job store.GenerationJob, units int, usageMeta json.RawMessage, expectedCredits int) (store.VoiceIdentityVersion, bool, error) {
	m.atomicBatchCalls.Add(1)
	m.atomicCredits.Store(int32(expectedCredits))
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	idempotency := voiceStoreKey(tenantID, projectID, idempotencyKey)
	if versionID, exists := m.idempotencies[idempotency]; exists {
		return m.versions[voiceStoreKey(tenantID, projectID, versionID)], true, nil
	}
	if _, exists := m.jobs[tenantKey(tenantID, job.ID)]; exists {
		return store.VoiceIdentityVersion{}, false, store.ErrConflict
	}
	value.Revision = 1
	for _, current := range m.versions {
		if current.ProjectID == projectID && current.VoiceIdentityID == value.VoiceIdentityID && current.Revision >= value.Revision {
			value.Revision = current.Revision + 1
		}
	}
	value.IdempotencyKeyHash = idempotencyKey
	m.jobs[tenantKey(tenantID, job.ID)] = job
	m.versions[voiceStoreKey(tenantID, projectID, value.ID)] = value
	m.idempotencies[idempotency] = value.ID
	return value, false, nil
}

func (m *voiceFilmMemoryStore) ListVoiceIdentityVersions(_ context.Context, tenantID, projectID, voiceID string) ([]store.VoiceIdentityVersion, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	values := []store.VoiceIdentityVersion{}
	for key, value := range m.versions {
		if strings.HasPrefix(key, voiceStoreKey(tenantID, projectID, "")) && value.VoiceIdentityID == voiceID {
			values = append(values, value)
		}
	}
	return values, nil
}

func (m *voiceFilmMemoryStore) CompleteVoiceIdentityVersion(_ context.Context, tenantID, projectID, versionID, jobID, status, providerVoiceID, message, updatedAt string) (store.VoiceIdentityVersion, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	key := voiceStoreKey(tenantID, projectID, versionID)
	value, exists := m.versions[key]
	if !exists {
		return store.VoiceIdentityVersion{}, store.ErrNotFound
	}
	if value.GenerationJobID != jobID || (value.Status != "queued" && value.Status != "running") {
		return store.VoiceIdentityVersion{}, store.ErrConflict
	}
	value.Status, value.ProviderVoiceID, value.Error, value.UpdatedAt = status, providerVoiceID, message, updatedAt
	m.versions[key] = value
	if status == "ready" {
		identityKey := voiceStoreKey(tenantID, projectID, value.VoiceIdentityID)
		identity := m.identities[identityKey]
		identity.CurrentVersionID, identity.Revision, identity.UpdatedAt = value.ID, identity.Revision+1, updatedAt
		m.identities[identityKey] = identity
	}
	return value, nil
}

func voiceCloneAPIHandler(t *testing.T) (*Server, *voiceFilmMemoryStore, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_FILM_MODE", "true")
	t.Setenv("OPENBOARD_ADVANCED_VOICE", "true")
	backend := newVoiceFilmMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := http.NewServeMux()
	router.Handle("/", withActor(serverHandler(server), store.AuthUser{ID: "voice-owner", TenantID: store.DefaultTenantID, Role: "owner", Status: "active"}))
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"voice-film","title":"Voice Film","createdAt":"2026-08-11T00:00:00Z","updatedAt":"2026-08-11T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, router, http.MethodPut, "/api/projects/voice-film", project); response.Code != http.StatusNoContent {
		t.Fatalf("seed project: %d %s", response.Code, response.Body.String())
	}
	if response := request(t, router, http.MethodPost, "/api/film/projects/voice-film", []byte(`{}`)); response.Code != http.StatusCreated {
		t.Fatalf("create film: %d %s", response.Code, response.Body.String())
	}
	return server, backend, router
}

func serverHandler(server *Server) http.Handler {
	router := chi.NewRouter()
	MountServer(router, server)
	return router
}

func voiceData[T any](t *testing.T, responseBody []byte) T {
	t.Helper()
	var payload struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		t.Fatalf("decode response: %v body=%s", err, responseBody)
	}
	return payload.Data
}

func createVoiceIdentityAndSample(t *testing.T, handler http.Handler) (store.VoiceIdentity, store.VoiceSample, store.VoiceConsent) {
	t.Helper()
	created := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities", []byte(`{"title":"Lead voice","description":"Calm lead performer"}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create identity: %d %s", created.Code, created.Body.String())
	}
	identity := voiceData[store.VoiceIdentity](t, created.Body.Bytes())
	wav := []byte("RIFF\x24\x00\x00\x00WAVEfmt ")
	upload := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/voice-sample.wav", wav, map[string]string{"Content-Type": "audio/wav"})
	if upload.Code != http.StatusNoContent {
		t.Fatalf("upload sample: %d %s", upload.Code, upload.Body.String())
	}
	sampleResponse := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/samples", []byte(`{"storageKey":"voice-sample.wav","label":"clean read"}`))
	if sampleResponse.Code != http.StatusCreated {
		t.Fatalf("create sample: %d %s", sampleResponse.Code, sampleResponse.Body.String())
	}
	sample := voiceData[store.VoiceSample](t, sampleResponse.Body.Bytes())
	evidence := apimartPNG(t)
	if upload := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/voice-consent.png", evidence, map[string]string{"Content-Type": "image/png"}); upload.Code != http.StatusNoContent {
		t.Fatalf("upload consent evidence: %d %s", upload.Code, upload.Body.String())
	}
	consentResponse := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", []byte(`{"accepted":true,"rightsBasis":"self","subjectDisplayName":"Test Performer","termsVersion":"voice-clone-v1","evidenceStorageKey":"voice-consent.png"}`))
	if consentResponse.Code != http.StatusCreated {
		t.Fatalf("create consent: %d %s", consentResponse.Code, consentResponse.Body.String())
	}
	return identity, sample, voiceData[store.VoiceConsent](t, consentResponse.Body.Bytes())
}

func TestVoiceIdentityListsPersistedSamplesAndConsents(t *testing.T) {
	server, _, ownerHandler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, ownerHandler)
	memberHandler := withActor(serverHandler(server), store.AuthUser{ID: "voice-member", TenantID: store.DefaultTenantID, Role: "member", Status: "active"})

	samplesResponse := request(t, memberHandler, http.MethodGet, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/samples", nil)
	if samplesResponse.Code != http.StatusOK {
		t.Fatalf("list samples: %d %s", samplesResponse.Code, samplesResponse.Body.String())
	}
	samples := voiceData[[]store.VoiceSample](t, samplesResponse.Body.Bytes())
	if len(samples) != 1 || samples[0].ID != sample.ID || samples[0].VoiceIdentityID != identity.ID {
		t.Fatalf("persisted samples=%#v", samples)
	}
	if strings.Contains(samplesResponse.Body.String(), "storageKey") || strings.Contains(samplesResponse.Body.String(), "sha256") {
		t.Fatalf("sample list leaked frozen media identity: %s", samplesResponse.Body.String())
	}

	consentsResponse := request(t, memberHandler, http.MethodGet, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", nil)
	if consentsResponse.Code != http.StatusOK {
		t.Fatalf("list consents: %d %s", consentsResponse.Code, consentsResponse.Body.String())
	}
	consents := voiceData[[]store.VoiceConsent](t, consentsResponse.Body.Bytes())
	if len(consents) != 1 || consents[0].ID != consent.ID || consents[0].VoiceIdentityID != identity.ID {
		t.Fatalf("persisted consents=%#v", consents)
	}
	if strings.Contains(consentsResponse.Body.String(), "evidenceStorageKey") || strings.Contains(consentsResponse.Body.String(), "evidenceSHA256") || strings.Contains(consentsResponse.Body.String(), "actorId") {
		t.Fatalf("consent list leaked evidence identity: %s", consentsResponse.Body.String())
	}
	for _, privateField := range []string{"subjectDisplayName", "termsVersion", "rightsBasis"} {
		if strings.Contains(consentsResponse.Body.String(), privateField) {
			t.Fatalf("consent list leaked private audit field %q: %s", privateField, consentsResponse.Body.String())
		}
	}
}

func TestVoiceCloneRequiresExplicitAuditedConsentAndTenantAudio(t *testing.T) {
	_, _, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	if consent.ActorID != "voice-owner" || consent.AcceptedAt == "" || consent.Accepted != true {
		t.Fatalf("consent audit was incomplete: %#v", consent)
	}
	missingConsent := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["`+sample.ID+`"],"idempotencyKey":"voice-clone-no-consent"}`))
	if missingConsent.Code != http.StatusBadRequest {
		t.Fatalf("clone without consent status=%d body=%s", missingConsent.Code, missingConsent.Body.String())
	}
	rejected := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", []byte(`{"accepted":false,"rightsBasis":"self","subjectDisplayName":"Test Performer","termsVersion":"voice-clone-v1"}`))
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("non-consent was accepted: %d %s", rejected.Code, rejected.Body.String())
	}
	if overwrite := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+consent.EvidenceStorageKey, []byte("changed evidence"), map[string]string{"Content-Type": "image/png"}); overwrite.Code != http.StatusNoContent {
		t.Fatalf("overwrite consent evidence: %d %s", overwrite.Code, overwrite.Body.String())
	}
	changedEvidenceBody := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-changed-evidence"}`)
	if changed := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", changedEvidenceBody); changed.Code != http.StatusConflict {
		t.Fatalf("changed consent evidence status=%d body=%s", changed.Code, changed.Body.String())
	}
	nonAudio := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/not-audio.png", []byte("png"), map[string]string{"Content-Type": "image/png"})
	if nonAudio.Code != http.StatusNoContent {
		t.Fatalf("upload non-audio: %d", nonAudio.Code)
	}
	badSample := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/samples", []byte(`{"storageKey":"not-audio.png"}`))
	if badSample.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-audio sample status=%d body=%s", badSample.Code, badSample.Body.String())
	}
}

func TestVoiceConsentRequiresTenantAdminAndFrozenEvidence(t *testing.T) {
	server, _, ownerHandler := voiceCloneAPIHandler(t)
	created := request(t, ownerHandler, http.MethodPost, "/api/film/projects/voice-film/voice-identities", []byte(`{"title":"Evidence voice"}`))
	identity := voiceData[store.VoiceIdentity](t, created.Body.Bytes())
	evidence := apimartPNG(t)
	if upload := requestWithHeaders(t, ownerHandler, http.MethodPut, "/api/blobs/voice-consent.png", evidence, map[string]string{"Content-Type": "image/png"}); upload.Code != http.StatusNoContent {
		t.Fatalf("upload consent evidence: %d %s", upload.Code, upload.Body.String())
	}
	body := []byte(`{"accepted":true,"rightsBasis":"authorized","subjectDisplayName":"Test Performer","termsVersion":"voice-clone-v1","evidenceStorageKey":"voice-consent.png"}`)
	response := request(t, ownerHandler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", body)
	if response.Code != http.StatusCreated {
		t.Fatalf("audited consent status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Data["evidenceStorageKey"] != "voice-consent.png" || payload.Data["evidenceSHA256"] != sha256Hex(evidence) || payload.Data["evidenceObjectVersion"] == "" {
		t.Fatalf("consent evidence was not frozen: %s", response.Body.String())
	}
	memberHandler := withActor(serverHandler(server), store.AuthUser{ID: "voice-member", TenantID: store.DefaultTenantID, Role: "member", Status: "active"})
	denied := request(t, memberHandler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", []byte(`{"accepted":true,"rightsBasis":"self","subjectDisplayName":"Test Performer","termsVersion":"voice-clone-v1"}`))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("member recorded consent: %d %s", denied.Code, denied.Body.String())
	}
}

func TestVoiceCloneEnforcesSitePolicyModelAndQuotedCredits(t *testing.T) {
	server, backend, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-policy-test"}`)
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: false, AvailableModels: []string{"voice-clone-1"}}); err != nil {
		t.Fatal(err)
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body); response.Code != http.StatusForbidden {
		t.Fatalf("disabled cloud generation status=%d body=%s", response.Code, response.Body.String())
	}
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true, AvailableModels: []string{"other-model"}}); err != nil {
		t.Fatal(err)
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body); response.Code != http.StatusForbidden {
		t.Fatalf("blocked voice model status=%d body=%s", response.Code, response.Body.String())
	}
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true, AvailableModels: []string{"voice-clone-1"}}); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutModelCreditConfig(t.Context(), store.DefaultTenantID, store.ModelCreditConfig{DefaultCredits: 1, ModelCosts: []store.ModelCreditCost{{Model: "voice-clone-1", Credits: 7}}}); err != nil {
		t.Fatal(err)
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body); response.Code != http.StatusAccepted {
		t.Fatalf("allowed voice clone status=%d body=%s", response.Code, response.Body.String())
	}
	if backend.atomicBatchCalls.Load() != 1 || backend.legacyJobCreates.Load() != 0 || backend.atomicCredits.Load() != 7 {
		t.Fatalf("voice clone boundary atomic=%d legacy=%d credits=%d", backend.atomicBatchCalls.Load(), backend.legacyJobCreates.Load(), backend.atomicCredits.Load())
	}
}

func TestVoiceCloneCreatesImmutableVersionAndIdempotentGenerationJob(t *testing.T) {
	_, backend, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-request-1"}`)
	first := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("clone status=%d body=%s", first.Code, first.Body.String())
	}
	version := voiceData[store.VoiceIdentityVersion](t, first.Body.Bytes())
	if version.Revision != 1 || version.Status != "queued" || version.GenerationJobID == "" || version.ConsentID != consent.ID || len(version.SampleIDs) != 1 {
		t.Fatalf("unexpected clone version: %#v", version)
	}
	job, err := backend.GetGenerationJob(context.Background(), store.DefaultTenantID, version.GenerationJobID)
	if err != nil || job.Kind != "audio" || job.ProjectID != "voice-film" || job.ProviderID != "audio-main" || job.Model != "voice-clone-1" {
		t.Fatalf("clone generation job=%#v err=%v", job, err)
	}
	if strings.Contains(string(job.Parameters), "apiKey") || strings.Contains(string(job.Parameters), "secret") || !strings.Contains(string(job.Parameters), `"executor":"voice-clone"`) {
		t.Fatalf("unsafe or unbound clone parameters: %s", job.Parameters)
	}
	replay := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	if replay.Code != http.StatusOK {
		t.Fatalf("idempotent replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	replayed := voiceData[store.VoiceIdentityVersion](t, replay.Body.Bytes())
	if replayed.ID != version.ID || replayed.GenerationJobID != version.GenerationJobID {
		t.Fatalf("idempotency created a new clone: first=%#v replay=%#v", version, replayed)
	}
	versionsResponse := request(t, handler, http.MethodGet, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/versions", nil)
	versions := voiceData[[]store.VoiceIdentityVersion](t, versionsResponse.Body.Bytes())
	if len(versions) != 1 || versions[0].ID != version.ID {
		t.Fatalf("immutable versions=%#v", versions)
	}
	if response := request(t, handler, http.MethodPut, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/versions/"+version.ID, []byte(`{"status":"ready"}`)); response.Code != http.StatusNotFound {
		t.Fatalf("immutable version was editable: %d %s", response.Code, response.Body.String())
	}
}

func TestVoiceCloneFeatureFlagAndProjectIsolation(t *testing.T) {
	t.Setenv("OPENBOARD_ADVANCED_VOICE", "false")
	_, _, handler := voiceCloneAPIHandler(t)
	t.Setenv("OPENBOARD_ADVANCED_VOICE", "false")
	response := request(t, handler, http.MethodGet, "/api/film/projects/voice-film/voice-identities", nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled advanced voice status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestVoiceCloneRejectsUnknownFieldsAndCredentialMaterial(t *testing.T) {
	_, _, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-request-2","apiKey":"must-not-be-accepted"}`)
	response := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("credential material accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestVoiceCloneRecordsStableTimestamps(t *testing.T) {
	_, _, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	acceptedAt, err := time.Parse(time.RFC3339Nano, consent.AcceptedAt)
	if err != nil || time.Since(acceptedAt) > time.Minute {
		t.Fatalf("invalid consent timestamp %q: %v", consent.AcceptedAt, err)
	}
	if identity.CreatedAt == "" || sample.CreatedAt == "" {
		t.Fatalf("missing creation timestamps identity=%#v sample=%#v", identity, sample)
	}
}

func TestVoiceCloneSyncRecoversCompletedGenerationLifecycle(t *testing.T) {
	_, backend, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-sync-1"}`)
	created := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	version := voiceData[store.VoiceIdentityVersion](t, created.Body.Bytes())
	backend.mu.Lock()
	jobKey := tenantKey(store.DefaultTenantID, version.GenerationJobID)
	job := backend.jobs[jobKey]
	job.Status, job.Result, job.UpdatedAt = "succeeded", json.RawMessage(`{"voiceId":"provider-voice-ready"}`), time.Now().UTC().Format(time.RFC3339Nano)
	backend.jobs[jobKey] = job
	backend.mu.Unlock()
	synced := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/versions/"+version.ID+"/sync", nil)
	if synced.Code != http.StatusOK {
		t.Fatalf("sync status=%d body=%s", synced.Code, synced.Body.String())
	}
	ready := voiceData[store.VoiceIdentityVersion](t, synced.Body.Bytes())
	if ready.Status != "ready" || ready.ProviderVoiceID != "provider-voice-ready" {
		t.Fatalf("synced version=%#v", ready)
	}
	current, err := backend.GetVoiceIdentity(t.Context(), store.DefaultTenantID, "voice-film", identity.ID)
	if err != nil || current.CurrentVersionID != version.ID {
		t.Fatalf("current identity=%#v err=%v", current, err)
	}
}

func TestVoiceCloneUsesExistingCancellationAndRefundLifecycle(t *testing.T) {
	_, backend, handler := voiceCloneAPIHandler(t)
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-cancel-1"}`)
	created := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	version := voiceData[store.VoiceIdentityVersion](t, created.Body.Bytes())
	internalJob, internalErr := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, version.GenerationJobID)
	var internalParameters voiceCloneJobParameters
	if internalErr != nil || json.Unmarshal(internalJob.Parameters, &internalParameters) != nil || internalParameters.Executor != voiceCloneExecutorMarker || internalParameters.ProjectID != "voice-film" || internalParameters.VersionID != version.ID {
		t.Fatalf("internal voice job was corrupted before cancellation: job=%#v err=%v", internalJob, internalErr)
	}
	canceled := request(t, handler, http.MethodPost, "/api/generation-jobs/"+version.GenerationJobID+"/cancel", nil)
	var canceledJob store.GenerationJob
	if json.Unmarshal(canceled.Body.Bytes(), &canceledJob) != nil || canceled.Code != http.StatusOK || canceledJob.Status != "cancelled" {
		t.Fatalf("cancel status=%d body=%s", canceled.Code, canceled.Body.String())
	}
	versions, err := backend.ListVoiceIdentityVersions(t.Context(), store.DefaultTenantID, "voice-film", identity.ID)
	if err != nil || len(versions) != 1 || versions[0].Status != "canceled" {
		t.Fatalf("cancel did not atomically update voice version: versions=%#v err=%v", versions, err)
	}
	synced := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/versions/"+version.ID+"/sync", nil)
	value := voiceData[store.VoiceIdentityVersion](t, synced.Body.Bytes())
	if synced.Code != http.StatusOK || value.Status != "canceled" {
		t.Fatalf("sync canceled status=%d value=%#v body=%s", synced.Code, value, synced.Body.String())
	}
}

func TestVoiceCloneWorkerDoesNotCallProviderAfterVersionWasCanceled(t *testing.T) {
	backend := &rejectingVoiceVersionStore{voiceFilmMemoryStore: newVoiceFilmMemoryStore()}
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	executor := &scriptedVoiceCloneExecutor{requests: make(chan voiceCloneProviderRequest, 1)}
	server.voiceCloneExecutor = executor
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "config", []byte(`{"channels":[{"id":"audio-main","name":"Audio","baseUrl":"https://audio.example/v1","defaultAudioModel":"voice-clone-1","providers":{"audio":{"baseUrl":"https://audio.example/v1","model":"voice-clone-1","protocol":"openai"}}}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	secrets, err := server.encryptSecrets([]byte(`{"apiKeys":{"audio-main":{"audio":"unit-value"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "secrets", secrets); err != nil {
		t.Fatal(err)
	}
	parameters, _ := json.Marshal(voiceCloneJobParameters{
		Executor: voiceCloneExecutorMarker, ProjectID: "voice-film", VoiceIdentityID: "voice-one", VersionID: "version-one",
	})
	job := store.GenerationJob{
		ID: "voice-cancel-race", ProjectID: "voice-film", Kind: "audio", Status: "running", ProviderID: "audio-main", Model: "voice-clone-1",
		Prompt: "Lead voice", Parameters: parameters, Result: json.RawMessage(`{}`), LeaseOwner: "worker-one",
	}
	server.executeClaimedVoiceCloneJob(store.TenantGenerationJob{TenantID: store.DefaultTenantID, Job: job})
	select {
	case <-executor.requests:
		t.Fatal("voice clone provider was called after the version transition was rejected")
	default:
	}
}

func TestPublicGenerationJobsRedactVoiceAndComfyUIExecutionSnapshots(t *testing.T) {
	voiceParameters, _ := json.Marshal(voiceCloneJobParameters{
		Executor: voiceCloneExecutorMarker, RequestHash: strings.Repeat("a", 64), ProjectID: "film-one", VoiceIdentityID: "voice-one",
		VersionID: "version-one", ConsentID: "consent-one", Samples: []voiceCloneSampleSnapshot{{ID: "sample-one", StorageKey: "private.wav", MIMEType: "audio/wav", SHA256: strings.Repeat("b", 64), ObjectVersion: "secret-version"}},
	})
	voicePublic := publicGenerationJob(store.GenerationJob{Parameters: voiceParameters})
	for _, secret := range []string{"private.wav", strings.Repeat("b", 64), "secret-version", "consent-one"} {
		if strings.Contains(string(voicePublic.Parameters), secret) {
			t.Fatalf("public voice job leaked %q: %s", secret, voicePublic.Parameters)
		}
	}
	comfyParameters, _ := json.Marshal(comfyUIJobParameters{
		Executor: comfyUIExecutorMarker, BillingUserID: "billing-user", RequestHash: strings.Repeat("c", 64), ApprovalHash: strings.Repeat("d", 64),
		Manifest:       localWorkflowManifest{ID: "private-manifest", Endpoint: "https://internal.example", AllowPrivate: true},
		InputSnapshots: []comfyUIInputSnapshot{{StorageKey: "private.png", MIMEType: "image/png", SHA256: strings.Repeat("e", 64), ObjectVersion: "private-version"}},
	})
	comfyPublic := publicGenerationJob(store.GenerationJob{Parameters: comfyParameters})
	for _, secret := range []string{"billing-user", "internal.example", "private.png", "private-version", strings.Repeat("e", 64), "allowPrivate"} {
		if strings.Contains(string(comfyPublic.Parameters), secret) {
			t.Fatalf("public ComfyUI job leaked %q: %s", secret, comfyPublic.Parameters)
		}
	}
	comfyResult, _ := json.Marshal(comfyUIJobResult{
		ExternalPromptID: "private-prompt",
		Items:            []comfyUIResultItem{{StorageKey: "private-output.png", MIMEType: "image/png", Bytes: 10, Width: 2, Height: 2, SHA256: strings.Repeat("f", 64), ObjectVersion: "output-version"}},
	})
	comfyPublic = publicGenerationJob(store.GenerationJob{Parameters: comfyParameters, Result: comfyResult})
	for _, secret := range []string{"private-prompt", "private-output.png", strings.Repeat("f", 64), "output-version"} {
		if strings.Contains(string(comfyPublic.Result), secret) {
			t.Fatalf("public ComfyUI job leaked result secret %q: %s", secret, comfyPublic.Result)
		}
	}
}

func TestVoiceIdentityListIsProjectScoped(t *testing.T) {
	_, _, handler := voiceCloneAPIHandler(t)
	identity, _, _ := createVoiceIdentityAndSample(t, handler)
	otherProject := []byte(`{"schemaVersion":3,"projectKind":"film","id":"voice-film-other","title":"Other Film","createdAt":"2026-08-11T00:00:00Z","updatedAt":"2026-08-11T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/voice-film-other", otherProject); response.Code != http.StatusNoContent {
		t.Fatalf("seed other project: %d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/voice-film-other", []byte(`{}`)); response.Code != http.StatusCreated {
		t.Fatalf("create other film: %d %s", response.Code, response.Body.String())
	}
	response := request(t, handler, http.MethodGet, "/api/film/projects/voice-film-other/voice-identities", nil)
	values := voiceData[[]store.VoiceIdentity](t, response.Body.Bytes())
	if response.Code != http.StatusOK || len(values) != 0 {
		t.Fatalf("project leaked identity %s: status=%d values=%#v", identity.ID, response.Code, values)
	}
}

func TestHTTPVoiceCloneExecutorUsesBoundedOpenAICompatibleMultipart(t *testing.T) {
	sampleBytes := []byte("RIFF\x24\x00\x00\x00WAVEvoice")
	authValue := "unit-" + "value"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/voice-clones" || r.Header.Get("Authorization") != "Bearer "+authValue {
			t.Fatalf("unexpected provider request path=%s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := r.ParseMultipartForm(maxVoiceSampleBytes * maxVoiceCloneSamples); err != nil {
			t.Fatal(err)
		}
		if r.FormValue("model") != "clone-model" || r.FormValue("name") != "Lead voice" {
			t.Fatalf("provider fields model=%q name=%q", r.FormValue("model"), r.FormValue("name"))
		}
		files := r.MultipartForm.File["samples"]
		if len(files) != 1 || files[0].Header.Get("Content-Type") != "audio/wav" {
			t.Fatalf("sample files=%#v", files)
		}
		file, err := files[0].Open()
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		if string(data) != string(sampleBytes) {
			t.Fatalf("sample data=%q", data)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"voice_id":"provider-voice-1"}}`))
	}))
	defer upstream.Close()
	executor := newHTTPVoiceCloneExecutor()
	voiceID, err := executor.Clone(context.Background(), voiceCloneProviderRequest{
		upstream.URL + "/v1", authValue, "clone-model", "Lead voice",
		[]generatedMedia{{Data: sampleBytes, MIMEType: "audio/wav"}},
	})
	if err != nil || voiceID != "provider-voice-1" {
		t.Fatalf("voiceID=%q err=%v", voiceID, err)
	}
}

func TestVoiceCloneWorkerResolvesExistingChannelWithoutPersistingCredential(t *testing.T) {
	server, backend, handler := voiceCloneAPIHandler(t)
	authValue := "unit-" + "value"
	executor := &scriptedVoiceCloneExecutor{requests: make(chan voiceCloneProviderRequest, 1)}
	server.voiceCloneExecutor = executor
	config := []byte(`{"channels":[{"id":"audio-main","name":"Audio","baseUrl":"https://audio.example/v1","defaultAudioModel":"voice-clone-1","providers":{"audio":{"baseUrl":"https://audio.example/v1","model":"voice-clone-1","protocol":"openai"}}}]}`)
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	if response := putConfigSecrets(t, handler, []byte(`{"apiKeys":{"audio-main":{"audio":"`+authValue+`"}}}`)); response.Code != http.StatusNoContent {
		t.Fatalf("store secrets: %d %s", response.Code, response.Body.String())
	}
	identity, sample, consent := createVoiceIdentityAndSample(t, handler)
	body := []byte(`{"providerId":"audio-main","model":"voice-clone-1","sampleIds":["` + sample.ID + `"],"consentId":"` + consent.ID + `","idempotencyKey":"voice-clone-worker-1"}`)
	created := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/clone", body)
	version := voiceData[store.VoiceIdentityVersion](t, created.Body.Bytes())
	select {
	case providerRequest := <-executor.requests:
		if providerRequest.APIKey != authValue || providerRequest.Model != "voice-clone-1" || len(providerRequest.Samples) != 1 {
			t.Fatalf("provider request=%#v", providerRequest)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("voice clone worker did not execute")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, version.GenerationJobID)
		if err == nil && job.Status == "succeeded" {
			if strings.Contains(string(job.Parameters), authValue) {
				t.Fatalf("credential leaked into generation job: %s", job.Parameters)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("voice clone job did not finish: %#v err=%v", job, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	versions, err := backend.ListVoiceIdentityVersions(t.Context(), store.DefaultTenantID, "voice-film", identity.ID)
	if err != nil || len(versions) != 1 || versions[0].Status != "ready" || versions[0].ProviderVoiceID != "provider-voice-worker" {
		t.Fatalf("versions=%#v err=%v", versions, err)
	}
}
