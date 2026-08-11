package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type voiceFilmMemoryStore struct {
	*filmMemoryStore
	voiceMu       sync.Mutex
	identities    map[string]store.VoiceIdentity
	samples       map[string]store.VoiceSample
	consents      map[string]store.VoiceConsent
	versions      map[string]store.VoiceIdentityVersion
	idempotencies map[string]string
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

func (m *voiceFilmMemoryStore) CreateVoiceCloneVersion(_ context.Context, tenantID, projectID, idempotencyKey string, value store.VoiceIdentityVersion) (store.VoiceIdentityVersion, bool, error) {
	m.voiceMu.Lock()
	defer m.voiceMu.Unlock()
	idempotency := voiceStoreKey(tenantID, projectID, idempotencyKey)
	if versionID, exists := m.idempotencies[idempotency]; exists {
		return m.versions[voiceStoreKey(tenantID, projectID, versionID)], true, nil
	}
	key := voiceStoreKey(tenantID, projectID, value.ID)
	if _, exists := m.versions[key]; exists {
		return store.VoiceIdentityVersion{}, false, store.ErrConflict
	}
	m.versions[key], m.idempotencies[idempotency] = value, value.ID
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

func voiceCloneAPIHandler(t *testing.T) (*Server, *voiceFilmMemoryStore, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_FILM_MODE", "true")
	t.Setenv("OPENBOARD_ADVANCED_VOICE", "true")
	backend := newVoiceFilmMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := http.NewServeMux()
	router.Handle("/", withActor(serverHandler(server), store.AuthUser{ID: "voice-owner", TenantID: store.DefaultTenantID, Role: "owner", Status: "active"}))
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"voice-film","title":"Voice Film","nodes":[],"edges":[]}`)
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
	consentResponse := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/consents", []byte(`{"accepted":true,"rightsBasis":"self","subjectDisplayName":"Test Performer","termsVersion":"voice-clone-v1"}`))
	if consentResponse.Code != http.StatusCreated {
		t.Fatalf("create consent: %d %s", consentResponse.Code, consentResponse.Body.String())
	}
	return identity, sample, voiceData[store.VoiceConsent](t, consentResponse.Body.Bytes())
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
	nonAudio := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/not-audio.png", []byte("png"), map[string]string{"Content-Type": "image/png"})
	if nonAudio.Code != http.StatusNoContent {
		t.Fatalf("upload non-audio: %d", nonAudio.Code)
	}
	badSample := request(t, handler, http.MethodPost, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/samples", []byte(`{"storageKey":"not-audio.png"}`))
	if badSample.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-audio sample status=%d body=%s", badSample.Code, badSample.Body.String())
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
	if response := request(t, handler, http.MethodPut, "/api/film/projects/voice-film/voice-identities/"+identity.ID+"/versions/"+version.ID, []byte(`{"status":"ready"}`)); response.Code != http.StatusMethodNotAllowed {
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
