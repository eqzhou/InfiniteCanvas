package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmMemoryStore struct {
	*memoryStore
	filmMu             sync.Mutex
	films              map[string]store.FilmRecord
	casHook            func()
	casErr             error
	tokens             map[string]filmMemoryRestoreToken
	workspaceTokens    map[string]filmMemoryWorkspaceToken
	cleanupGenerations map[string]store.FilmCleanupGeneration
}

type filmMemoryWorkspaceToken struct {
	prior          store.WorkspaceSnapshot
	appliedVersion string
	expiresAt      time.Time
	consumed       bool
	createdMedia   []store.WorkspaceMedia
}

type filmMemoryRestoreToken struct {
	prior           store.FilmRecord
	priorExists     bool
	appliedRevision int
	expiresAt       time.Time
	consumed        bool
	createdMedia    []store.WorkspaceMedia
}

func newFilmMemoryStore() *filmMemoryStore {
	return &filmMemoryStore{
		memoryStore: newMemoryStore(), films: map[string]store.FilmRecord{}, tokens: map[string]filmMemoryRestoreToken{},
		workspaceTokens: map[string]filmMemoryWorkspaceToken{}, cleanupGenerations: map[string]store.FilmCleanupGeneration{},
	}
}

func (m *filmMemoryStore) workspaceSnapshotLocked(tenantID string) store.WorkspaceSnapshot {
	snapshot := store.WorkspaceSnapshot{Projects: []store.WorkspaceProject{}, Films: []store.WorkspaceFilm{}, GenerationJobs: []store.WorkspaceGenerationJob{}, States: []store.WorkspaceState{}}
	prefix := tenantKey(tenantID, "")
	for key, document := range m.projects {
		if strings.HasPrefix(key, prefix) {
			snapshot.Projects = append(snapshot.Projects, store.WorkspaceProject{ID: strings.TrimPrefix(key, prefix), Document: append([]byte(nil), document...)})
		}
	}
	for key, record := range m.films {
		if strings.HasPrefix(key, prefix) {
			snapshot.Films = append(snapshot.Films, store.WorkspaceFilm{ProjectID: strings.TrimPrefix(key, prefix), Revision: record.Revision, Document: append([]byte(nil), record.Document...)})
		}
	}
	for key, job := range m.jobs {
		if strings.HasPrefix(key, prefix) {
			snapshot.GenerationJobs = append(snapshot.GenerationJobs, store.WorkspaceGenerationJob{Job: job})
		}
	}
	for _, key := range workspaceTransactionStateKeys {
		value, exists := m.state[tenantKey(tenantID, key)]
		snapshot.States = append(snapshot.States, store.WorkspaceState{Key: key, Exists: exists, Value: append([]byte(nil), value...)})
	}
	return snapshot
}

func (m *filmMemoryStore) WorkspaceVersion(_ context.Context, tenantID string) (string, error) {
	m.mu.RLock()
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	defer m.mu.RUnlock()
	return store.ComputeWorkspaceVersion(m.workspaceSnapshotLocked(tenantID))
}

func (m *filmMemoryStore) applyWorkspaceLocked(tenantID string, snapshot store.WorkspaceSnapshot) {
	prefix := tenantKey(tenantID, "")
	filmRevisions := map[string]int{}
	for key := range m.projects {
		if strings.HasPrefix(key, prefix) {
			delete(m.projects, key)
		}
	}
	for key := range m.films {
		if strings.HasPrefix(key, prefix) {
			filmRevisions[strings.TrimPrefix(key, prefix)] = m.films[key].Revision
			delete(m.films, key)
		}
	}
	for key := range m.jobs {
		if strings.HasPrefix(key, prefix) {
			delete(m.jobs, key)
		}
	}
	for _, key := range workspaceTransactionStateKeys {
		delete(m.state, tenantKey(tenantID, key))
	}
	for _, project := range snapshot.Projects {
		m.projects[tenantKey(tenantID, project.ID)] = append([]byte(nil), project.Document...)
	}
	for _, film := range snapshot.Films {
		revision := film.Revision
		if current := filmRevisions[film.ProjectID]; current > revision {
			revision = current
		}
		revision++
		if revision < 1 {
			revision = 1
		}
		m.films[tenantKey(tenantID, film.ProjectID)] = store.FilmRecord{ProjectID: film.ProjectID, Revision: revision, Document: append([]byte(nil), film.Document...)}
	}
	for _, item := range snapshot.GenerationJobs {
		m.jobs[tenantKey(tenantID, item.Job.ID)] = item.Job
	}
	for _, state := range snapshot.States {
		if state.Exists {
			m.state[tenantKey(tenantID, state.Key)] = append([]byte(nil), state.Value...)
		}
	}
}

func (m *filmMemoryStore) ReplaceWorkspace(_ context.Context, tenantID, expectedVersion, tokenDigest string, expiresAt time.Time, snapshot store.WorkspaceSnapshot, createdMedia []store.WorkspaceMedia) (store.WorkspaceReplaceResult, error) {
	m.mu.Lock()
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	defer m.mu.Unlock()
	prior := m.workspaceSnapshotLocked(tenantID)
	currentVersion, _ := store.ComputeWorkspaceVersion(prior)
	if currentVersion != expectedVersion {
		return store.WorkspaceReplaceResult{}, store.ErrConflict
	}
	currentFilmRevisions := map[string]int{}
	for _, film := range prior.Films {
		currentFilmRevisions[film.ProjectID] = film.Revision
	}
	for _, film := range snapshot.Films {
		if film.Revision != currentFilmRevisions[film.ProjectID] {
			return store.WorkspaceReplaceResult{}, store.ErrConflict
		}
	}
	version, err := store.ComputeWorkspaceVersion(snapshot)
	if err != nil {
		return store.WorkspaceReplaceResult{}, err
	}
	m.applyWorkspaceLocked(tenantID, snapshot)
	m.workspaceTokens[tenantKey(tenantID, tokenDigest)] = filmMemoryWorkspaceToken{prior: prior, appliedVersion: version, expiresAt: expiresAt, createdMedia: append([]store.WorkspaceMedia(nil), createdMedia...)}
	return store.WorkspaceReplaceResult{Version: version}, nil
}

func (m *filmMemoryStore) ReplaceWorkspaceProject(ctx context.Context, tenantID, projectID, expectedVersion, tokenDigest string, expiresAt time.Time, project store.WorkspaceProject, film *store.WorkspaceFilm, createdMedia []store.WorkspaceMedia) (store.WorkspaceReplaceResult, error) {
	m.mu.RLock()
	m.filmMu.Lock()
	prior := m.workspaceSnapshotLocked(tenantID)
	m.filmMu.Unlock()
	m.mu.RUnlock()
	desired := store.WorkspaceSnapshot{Projects: append([]store.WorkspaceProject(nil), prior.Projects...), Films: append([]store.WorkspaceFilm(nil), prior.Films...), GenerationJobs: append([]store.WorkspaceGenerationJob(nil), prior.GenerationJobs...), States: append([]store.WorkspaceState(nil), prior.States...)}
	found := false
	for index := range desired.Projects {
		if desired.Projects[index].ID == projectID {
			desired.Projects[index], found = project, true
		}
	}
	if !found {
		desired.Projects = append(desired.Projects, project)
	}
	films := desired.Films[:0]
	for _, current := range desired.Films {
		if current.ProjectID != projectID {
			films = append(films, current)
		}
	}
	if film != nil {
		films = append(films, *film)
	}
	desired.Films = films
	return m.ReplaceWorkspace(ctx, tenantID, expectedVersion, tokenDigest, expiresAt, desired, createdMedia)
}

func (m *filmMemoryStore) RollbackWorkspace(_ context.Context, tenantID, expectedVersion, tokenDigest string, now time.Time) (store.WorkspaceReplaceResult, error) {
	m.mu.Lock()
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, tokenDigest)
	token, ok := m.workspaceTokens[key]
	if !ok || token.consumed || !now.Before(token.expiresAt) {
		return store.WorkspaceReplaceResult{}, store.ErrNotFound
	}
	currentVersion, _ := store.ComputeWorkspaceVersion(m.workspaceSnapshotLocked(tenantID))
	if currentVersion != expectedVersion || token.appliedVersion != expectedVersion {
		return store.WorkspaceReplaceResult{}, store.ErrConflict
	}
	m.applyWorkspaceLocked(tenantID, token.prior)
	cleanupProjects := map[string]struct{}{}
	for _, media := range token.createdMedia {
		cleanupProjects[media.ProjectID] = struct{}{}
	}
	for projectID := range cleanupProjects {
		generationID := "workspace-" + tokenDigest[:24]
		m.cleanupGenerations[tenantKey(tenantID, projectID+"\x00"+generationID)] = store.FilmCleanupGeneration{GenerationID: generationID, ProjectID: projectID, Media: append([]store.WorkspaceMedia(nil), token.createdMedia...)}
	}
	token.consumed = true
	m.workspaceTokens[key] = token
	version, err := store.ComputeWorkspaceVersion(token.prior)
	projectIDs := make([]string, 0, len(cleanupProjects))
	for projectID := range cleanupProjects {
		projectIDs = append(projectIDs, projectID)
	}
	return store.WorkspaceReplaceResult{Version: version, CleanupProjectIDs: projectIDs}, err
}

func (m *filmMemoryStore) RestoreFilmProject(_ context.Context, tenantID, projectID string, expectedRevision int, document []byte, tokenDigest string, expiresAt time.Time, createdMedia []store.WorkspaceMedia) (store.FilmRecord, error) {
	if m.casHook != nil {
		m.casHook()
	}
	if m.casErr != nil {
		return store.FilmRecord{}, m.casErr
	}
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	key := tenantKey(tenantID, projectID)
	prior, exists := m.films[key]
	if !exists && expectedRevision != 0 {
		return store.FilmRecord{}, store.ErrNotFound
	}
	if exists && prior.Revision != expectedRevision || !exists && expectedRevision != 0 {
		return store.FilmRecord{}, store.ErrConflict
	}
	nextRevision := 1
	if exists {
		nextRevision = prior.Revision + 1
	}
	record := store.FilmRecord{ProjectID: projectID, Revision: nextRevision, Document: append([]byte(nil), document...)}
	m.films[key] = record
	m.tokens[tenantKey(tenantID, projectID+"\x00"+tokenDigest)] = filmMemoryRestoreToken{
		prior: prior, priorExists: exists, appliedRevision: nextRevision, expiresAt: expiresAt, createdMedia: append([]store.WorkspaceMedia(nil), createdMedia...),
	}
	return record, nil
}

func (m *filmMemoryStore) RollbackFilmProject(_ context.Context, tenantID, projectID string, expectedRevision int, tokenDigest string, now time.Time) (store.FilmRecord, bool, error) {
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	tokenKey := tenantKey(tenantID, projectID+"\x00"+tokenDigest)
	token, ok := m.tokens[tokenKey]
	if !ok || token.consumed || !now.Before(token.expiresAt) {
		return store.FilmRecord{}, false, store.ErrNotFound
	}
	key := tenantKey(tenantID, projectID)
	current, exists := m.films[key]
	if !exists || current.Revision != expectedRevision || token.appliedRevision != expectedRevision {
		return store.FilmRecord{}, false, store.ErrConflict
	}
	token.consumed = true
	m.tokens[tokenKey] = token
	if len(token.createdMedia) > 0 {
		generationID := "restore-" + tokenDigest[:24]
		m.cleanupGenerations[tenantKey(tenantID, projectID+"\x00"+generationID)] = store.FilmCleanupGeneration{GenerationID: generationID, ProjectID: projectID, Media: append([]store.WorkspaceMedia(nil), token.createdMedia...)}
	}
	if !token.priorExists {
		delete(m.films, key)
		return store.FilmRecord{}, false, nil
	}
	record := token.prior
	record.Revision = current.Revision + 1
	record.Document = append([]byte(nil), token.prior.Document...)
	m.films[key] = record
	return record, true, nil
}

func (m *filmMemoryStore) DeleteProjectWithFilmCleanup(_ context.Context, tenantID, projectID, generationID string) error {
	m.mu.Lock()
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	defer m.mu.Unlock()
	documents := []json.RawMessage{}
	media := []store.WorkspaceMedia{}
	if current, ok := m.films[tenantKey(tenantID, projectID)]; ok {
		documents = append(documents, append([]byte(nil), current.Document...))
	}
	tenantPrefix := tenantKey(tenantID, "")
	filmTokenPrefix := tenantKey(tenantID, projectID+"\x00")
	for key, token := range m.tokens {
		if strings.HasPrefix(key, filmTokenPrefix) {
			if token.priorExists {
				documents = append(documents, append([]byte(nil), token.prior.Document...))
			}
			media = append(media, token.createdMedia...)
			delete(m.tokens, key)
		}
	}
	for key, token := range m.workspaceTokens {
		if strings.HasPrefix(key, tenantPrefix) && !token.consumed {
			for _, film := range token.prior.Films {
				if film.ProjectID == projectID {
					documents = append(documents, append([]byte(nil), film.Document...))
				}
			}
			media = append(media, token.createdMedia...)
			delete(m.workspaceTokens, key)
		}
	}
	filtered := media[:0]
	for _, item := range media {
		if item.ProjectID == projectID {
			filtered = append(filtered, item)
		}
	}
	m.cleanupGenerations[tenantKey(tenantID, projectID+"\x00"+generationID)] = store.FilmCleanupGeneration{GenerationID: generationID, ProjectID: projectID, Documents: documents, Media: append([]store.WorkspaceMedia(nil), filtered...)}
	delete(m.projects, tenantKey(tenantID, projectID))
	delete(m.films, tenantKey(tenantID, projectID))
	for key, job := range m.jobs {
		if strings.HasPrefix(key, tenantPrefix) && job.ProjectID == projectID {
			delete(m.jobs, key)
		}
	}
	return nil
}

func (m *filmMemoryStore) ListFilmCleanupGenerations(_ context.Context, tenantID, projectID string) ([]store.FilmCleanupGeneration, error) {
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	prefix := tenantKey(tenantID, projectID+"\x00")
	out := []store.FilmCleanupGeneration{}
	for key, generation := range m.cleanupGenerations {
		if strings.HasPrefix(key, prefix) {
			out = append(out, generation)
		}
	}
	return out, nil
}

func (m *filmMemoryStore) CompleteFilmCleanupGeneration(_ context.Context, tenantID, projectID, generationID string) error {
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	key := tenantKey(tenantID, projectID+"\x00"+generationID)
	if _, ok := m.cleanupGenerations[key]; !ok {
		return store.ErrNotFound
	}
	delete(m.cleanupGenerations, key)
	return nil
}

func (m *filmMemoryStore) GetFilmProject(_ context.Context, tenantID, projectID string) (store.FilmRecord, error) {
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	record, ok := m.films[tenantKey(tenantID, projectID)]
	if !ok {
		return store.FilmRecord{}, store.ErrNotFound
	}
	record.Document = append([]byte(nil), record.Document...)
	return record, nil
}

func (m *filmMemoryStore) CreateFilmProject(_ context.Context, tenantID, projectID string, document []byte) (store.FilmRecord, error) {
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	key := tenantKey(tenantID, projectID)
	if _, exists := m.films[key]; exists {
		return store.FilmRecord{}, store.ErrConflict
	}
	record := store.FilmRecord{ProjectID: projectID, Revision: 1, Document: append([]byte(nil), document...)}
	m.films[key] = record
	return record, nil
}

func (m *filmMemoryStore) CompareAndSwapFilmProject(_ context.Context, tenantID, projectID string, expectedRevision int, document []byte) (store.FilmRecord, error) {
	if m.casHook != nil {
		m.casHook()
	}
	if m.casErr != nil {
		return store.FilmRecord{}, m.casErr
	}
	m.filmMu.Lock()
	defer m.filmMu.Unlock()
	key := tenantKey(tenantID, projectID)
	record, exists := m.films[key]
	if !exists {
		return store.FilmRecord{}, store.ErrNotFound
	}
	if record.Revision != expectedRevision {
		return store.FilmRecord{}, store.ErrConflict
	}
	record.Revision++
	record.Document = append([]byte(nil), document...)
	m.films[key] = record
	return record, nil
}

func filmAPIHandler(t *testing.T) (*filmMemoryStore, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_FILM_MODE", "true")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newFilmMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"film-api","title":"Film API","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, router, http.MethodPut, "/api/projects/film-api", project); response.Code != http.StatusNoContent {
		t.Fatalf("seed project: %d %s", response.Code, response.Body.String())
	}
	if response := request(t, router, http.MethodPost, "/api/film/projects/film-api", []byte(`{}`)); response.Code != http.StatusCreated {
		t.Fatalf("create film production: %d %s", response.Code, response.Body.String())
	}
	return backend, router
}

func decodeFilmResponse(t *testing.T, response *httptest.ResponseRecorder) filmDocument {
	t.Helper()
	var payload struct {
		Data filmDocument `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode film response: %v body=%s", err, response.Body.String())
	}
	return payload.Data
}

func TestFilmAPIVerticalWorkflowAndRevisionConflicts(t *testing.T) {
	_, handler := filmAPIHandler(t)

	status := request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil)
	if status.Code != http.StatusOK {
		t.Fatalf("status: %d %s", status.Code, status.Body.String())
	}

	source := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. OBSERVATORY - NIGHT\nMira opens the dome. The telescope turns."}`))
	if source.Code != http.StatusOK {
		t.Fatalf("source: %d %s", source.Code, source.Body.String())
	}
	document := decodeFilmResponse(t, source)
	if len(document.Episodes) != 1 || len(document.Scenes) != 1 || len(document.Shots) != 2 {
		t.Fatalf("unexpected decomposition: %#v", document)
	}

	stale := request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+document.Shots[0].ID,
		[]byte(`{"revision":0,"title":"Stale"}`))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale update: %d %s", stale.Code, stale.Body.String())
	}
	updateBody, _ := json.Marshal(map[string]any{"revision": document.Shots[0].Revision, "title": "Dome opens", "durationSeconds": 6})
	updated := request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+document.Shots[0].ID, updateBody)
	if updated.Code != http.StatusOK {
		t.Fatalf("shot update: %d %s", updated.Code, updated.Body.String())
	}
	document = decodeFilmResponse(t, updated)
	decompose := document.Stages[0]
	approveDecompose, _ := json.Marshal(map[string]any{"revision": decompose.Revision})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approveDecompose)
	if response.Code != http.StatusOK {
		t.Fatalf("approve decompose: %d %s", response.Code, response.Body.String())
	}
	document = decodeFilmResponse(t, response)
	script := document.Stages[1]
	runScript, _ := json.Marshal(map[string]any{"revision": script.Revision})
	response = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/run", runScript)
	if response.Code != http.StatusAccepted {
		t.Fatalf("run script: %d %s", response.Code, response.Body.String())
	}
	document = decodeFilmResponse(t, response)
	script = document.Stages[1]
	approveScript, _ := json.Marshal(map[string]any{"revision": script.Revision})
	response = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/approve", approveScript)
	if response.Code != http.StatusOK {
		t.Fatalf("approve script: %d %s", response.Code, response.Body.String())
	}
	document = decodeFilmResponse(t, response)

	validated := request(t, handler, http.MethodPost, "/api/film/projects/film-api/validate", []byte(`{}`))
	if validated.Code != http.StatusOK {
		t.Fatalf("validate: %d %s", validated.Code, validated.Body.String())
	}
	document = decodeFilmResponse(t, validated)
	if len(document.QualityReports) != 1 || len(document.QualityReports[0].Repairs) == 0 {
		t.Fatalf("quality report missing: %#v", document.QualityReports)
	}
	repair := document.QualityReports[0].Repairs[0]
	applyBody, _ := json.Marshal(map[string]any{"revision": repair.ExpectedRevision, "approved": true})
	applied := request(t, handler, http.MethodPost, "/api/film/projects/film-api/repairs/"+repair.ID+"/apply", applyBody)
	if applied.Code != http.StatusOK {
		t.Fatalf("apply repair: %d %s", applied.Code, applied.Body.String())
	}

	timeline := document.Timeline
	timeline.Tracks[4].Clips = []filmTimelineClip{{
		ID: "subtitle-1", Revision: 1, Source: "shot:" + document.Shots[0].ID, Order: 0,
		Start: 0, End: 2, Volume: 1, Transition: "cut", Text: "The dome opens.",
	}}
	timelineBody, _ := json.Marshal(timeline)
	timelinePut := request(t, handler, http.MethodPut, "/api/film/projects/film-api/timeline", timelineBody)
	if timelinePut.Code != http.StatusOK {
		t.Fatalf("timeline put: %d %s", timelinePut.Code, timelinePut.Body.String())
	}

	document = decodeFilmResponse(t, timelinePut)
	exportBody, _ := json.Marshal(map[string]any{"kind": "manifest", "revision": document.Revision, "idempotencyKey": "vertical-manifest"})
	exported := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", exportBody)
	if exported.Code != http.StatusCreated {
		t.Fatalf("manifest export: %d %s", exported.Code, exported.Body.String())
	}
	deliverables := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables", nil)
	if deliverables.Code != http.StatusOK || !bytes.Contains(deliverables.Body.Bytes(), []byte(`"manifest"`)) || bytes.Contains(deliverables.Body.Bytes(), []byte(`"asset_bundle"`)) {
		t.Fatalf("deliverables: %d %s", deliverables.Code, deliverables.Body.String())
	}
}

func TestFilmMutationResponseKeepsCapabilityEnvelope(t *testing.T) {
	_, handler := filmAPIHandler(t)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/episodes", []byte(`{"title":"Episode"}`))
	if response.Code != http.StatusCreated || !bytes.Contains(response.Body.Bytes(), []byte(`"stageGeneration"`)) || !bytes.Contains(response.Body.Bytes(), []byte(`"assetBundleExport"`)) {
		t.Fatalf("mutation capability envelope: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmIdentityVersionStoresProductionMetadata(t *testing.T) {
	_, handler := filmAPIHandler(t)
	characterResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/assets", []byte(`{"kind":"character","title":"Mira"}`))
	character := decodeFilmResponse(t, characterResponse).Assets[0]
	body, _ := json.Marshal(map[string]any{"kind": "identity", "title": "Mira / Winter", "parentAssetId": character.ID, "ageStage": "adult", "costume": "winter field coat", "storyPeriod": "episode 3", "isDefault": true})
	created := request(t, handler, http.MethodPost, "/api/film/projects/film-api/assets", body)
	if created.Code != http.StatusCreated {
		t.Fatalf("identity metadata: %d %s", created.Code, created.Body.String())
	}
	identity := decodeFilmResponse(t, created).Assets[1]
	if identity.ParentAssetID != character.ID || identity.AgeStage != "adult" || identity.Costume != "winter field coat" || identity.StoryPeriod != "episode 3" || !identity.IsDefault {
		t.Fatalf("identity metadata was not preserved: %#v", identity)
	}
	secondBody, _ := json.Marshal(map[string]any{"kind": "identity", "title": "Mira / Summer", "parentAssetId": character.ID, "isDefault": true})
	second := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/assets", secondBody))
	if second.Assets[1].IsDefault || second.Assets[1].Revision != identity.Revision+1 || !second.Assets[2].IsDefault {
		t.Fatalf("default identity selection was not exclusive: %#v", second.Assets)
	}
	invalid := request(t, handler, http.MethodPost, "/api/film/projects/film-api/assets", []byte(`{"kind":"prop","title":"Coat","ageStage":"adult"}`))
	if invalid.Code != http.StatusUnprocessableEntity {
		t.Fatalf("non-identity metadata accepted: %d %s", invalid.Code, invalid.Body.String())
	}
}

func TestFilmAPIRejectsCanvasProjectsAndDisabledCapability(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	canvas := []byte(`{"schemaVersion":3,"projectKind":"canvas","id":"canvas-api","title":"Canvas","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/canvas-api", canvas); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	if response := request(t, handler, http.MethodGet, "/api/film/projects/canvas-api/status", nil); response.Code != http.StatusConflict {
		t.Fatalf("canvas project accepted: %d %s", response.Code, response.Body.String())
	}

	t.Setenv("OPENBOARD_FILM_MODE", "false")
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	if response := request(t, router, http.MethodGet, "/api/film/projects/film-api/status", nil); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled film API: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmStoreIsTenantScoped(t *testing.T) {
	backend := newFilmMemoryStore()
	document, _ := json.Marshal(newFilmDocument("shared-project"))
	if _, err := backend.CreateFilmProject(t.Context(), "tenant-a", "shared-project", document); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.GetFilmProject(t.Context(), "tenant-b", "shared-project"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant film read returned %v", err)
	}
}

func TestFilmAPIStrictImportsCRUDAndProjectionCAS(t *testing.T) {
	_, handler := filmAPIHandler(t)

	unsupported := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"format":"pdf","text":"%PDF"}`))
	if unsupported.Code != http.StatusUnsupportedMediaType || !bytes.Contains(unsupported.Body.Bytes(), []byte("unsupported_import_format")) {
		t.Fatalf("unsupported import: %d %s", unsupported.Code, unsupported.Body.String())
	}
	unknownField := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"SCENE 1\nAction.","unexpected":true}`))
	if unknownField.Code != http.StatusBadRequest {
		t.Fatalf("unknown source field accepted: %d %s", unknownField.Code, unknownField.Body.String())
	}

	episodeResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/episodes", []byte(`{"title":"Episode Alpha","synopsis":"A bounded synopsis."}`))
	if episodeResponse.Code != http.StatusCreated {
		t.Fatalf("create episode: %d %s", episodeResponse.Code, episodeResponse.Body.String())
	}
	document := decodeFilmResponse(t, episodeResponse)
	assetResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/assets", []byte(`{"kind":"style","title":"Cool dusk"}`))
	if assetResponse.Code != http.StatusCreated {
		t.Fatalf("create asset: %d %s", assetResponse.Code, assetResponse.Body.String())
	}
	if len(decodeFilmResponse(t, assetResponse).Assets) != 1 {
		t.Fatal("created asset was not persisted")
	}

	projectionBody, _ := json.Marshal(map[string]any{
		"projectionKey":    "episode:" + document.Episodes[0].ID,
		"expectedRevision": document.Episodes[0].Revision,
		"fields":           map[string]any{"title": "Projected title"},
	})
	projection := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/commit", projectionBody)
	if projection.Code != http.StatusOK {
		t.Fatalf("projection commit: %d %s", projection.Code, projection.Body.String())
	}
	staleProjection := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/commit", projectionBody)
	if staleProjection.Code != http.StatusConflict {
		t.Fatalf("stale projection accepted: %d %s", staleProjection.Code, staleProjection.Body.String())
	}

	blocked := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", []byte(`{"revision":1,"providerId":"provider-a","idempotencyKey":"dependency-check"}`))
	if blocked.Code != http.StatusConflict {
		t.Fatalf("stage dependency bypassed: %d %s", blocked.Code, blocked.Body.String())
	}
}

func TestFilmCanvasMediaAdoptionBindsVerifiedTenantBlobAndProvenance(t *testing.T) {
	_, handler := filmAPIHandler(t)
	imported := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nA performer enters."}`))
	document := decodeFilmResponse(t, imported)
	payload := []byte("independent-image-bytes")
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:canvas-candidate", payload, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatalf("seed candidate: %d %s", response.Code, response.Body.String())
	}
	body, _ := json.Marshal(map[string]any{
		"targetType": "shot", "targetId": document.Shots[0].ID, "targetField": "image",
		"expectedRevision": document.Shots[0].Revision, "sourceNodeId": "node-candidate",
		"storageKey": "image:canvas-candidate",
	})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/adopt", body)
	if response.Code != http.StatusOK {
		t.Fatalf("adopt candidate: %d %s", response.Code, response.Body.String())
	}
	adopted := decodeFilmResponse(t, response)
	if adopted.Shots[0].ImageStorageKey != "image:canvas-candidate" || adopted.Shots[0].Revision != document.Shots[0].Revision+1 ||
		len(adopted.Adoptions) != 1 || adopted.Adoptions[0].SourceNodeID != "node-candidate" || adopted.Adoptions[0].SHA256 != sha256Hex(payload) {
		t.Fatalf("adoption was not durably attributed: %#v %#v", adopted.Shots[0], adopted.Adoptions)
	}
	stale := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/adopt", body)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale adoption accepted: %d %s", stale.Code, stale.Body.String())
	}
}

func TestFilmDialogueCRUDUsesRevisionAndShotRelations(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nA performer enters."}`)))
	if len(document.Dialogues) != 1 || document.Dialogues[0].Kind != "narration" {
		t.Fatalf("decomposition did not create a narration draft: %#v", document.Dialogues)
	}
	created := request(t, handler, http.MethodPost, "/api/film/projects/film-api/dialogues", []byte(`{"shotId":"`+document.Shots[0].ID+`","kind":"dialogue","text":"We begin."}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create dialogue: %d %s", created.Code, created.Body.String())
	}
	dialogue := decodeFilmResponse(t, created).Dialogues[1]
	updated := request(t, handler, http.MethodPut, "/api/film/projects/film-api/dialogues/"+dialogue.ID, []byte(`{"revision":1,"text":"We begin now."}`))
	if updated.Code != http.StatusOK || decodeFilmResponse(t, updated).Dialogues[1].Revision != 2 {
		t.Fatalf("update dialogue: %d %s", updated.Code, updated.Body.String())
	}
	stale := request(t, handler, http.MethodPut, "/api/film/projects/film-api/dialogues/"+dialogue.ID, []byte(`{"revision":1,"text":"stale"}`))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale dialogue update accepted: %d %s", stale.Code, stale.Body.String())
	}
}

func TestFilmQualityValidationDetectsMediaChangedAfterAdoption(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nA performer enters."}`)))
	_ = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:quality-candidate", []byte("original"), map[string]string{"Content-Type": "image/png"})
	body, _ := json.Marshal(map[string]any{"targetType": "shot", "targetId": document.Shots[0].ID, "targetField": "image", "expectedRevision": document.Shots[0].Revision, "sourceNodeId": "node-quality", "storageKey": "image:quality-candidate"})
	adopted := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/adopt", body)
	if adopted.Code != http.StatusOK {
		t.Fatal(adopted.Body.String())
	}
	_ = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:quality-candidate", []byte("changed"), map[string]string{"Content-Type": "image/png"})
	validated := request(t, handler, http.MethodPost, "/api/film/projects/film-api/validate", []byte(`{}`))
	if validated.Code != http.StatusOK || !bytes.Contains(validated.Body.Bytes(), []byte(`"media_corrupt"`)) {
		t.Fatalf("changed media was not reported: %d %s", validated.Code, validated.Body.String())
	}
}

func TestFilmAPISceneCRUDInvalidationAndCapabilities(t *testing.T) {
	_, handler := filmAPIHandler(t)
	capabilities := request(t, handler, http.MethodGet, "/api/film/capabilities", nil)
	if capabilities.Code != http.StatusOK || !bytes.Contains(capabilities.Body.Bytes(), []byte(`"available": true`)) || !bytes.Contains(capabilities.Body.Bytes(), []byte(`"mp4Export": false`)) {
		t.Fatalf("capabilities: %d %s", capabilities.Code, capabilities.Body.String())
	}

	episodeResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/episodes", []byte(`{"title":"Episode"}`))
	document := decodeFilmResponse(t, episodeResponse)
	episodeID := document.Episodes[0].ID
	createBody, _ := json.Marshal(map[string]any{"episodeId": episodeID, "heading": "INT. STAGE - DAY", "synopsis": "A scene."})
	created := request(t, handler, http.MethodPost, "/api/film/projects/film-api/scenes", createBody)
	if created.Code != http.StatusCreated {
		t.Fatalf("create scene: %d %s", created.Code, created.Body.String())
	}
	document = decodeFilmResponse(t, created)
	scene := document.Scenes[0]
	updateBody, _ := json.Marshal(map[string]any{"revision": scene.Revision, "heading": "EXT. STAGE - NIGHT"})
	updated := request(t, handler, http.MethodPut, "/api/film/projects/film-api/scenes/"+scene.ID, updateBody)
	if updated.Code != http.StatusOK || decodeFilmResponse(t, updated).Scenes[0].Heading != "EXT. STAGE - NIGHT" {
		t.Fatalf("update scene: %d %s", updated.Code, updated.Body.String())
	}
	document = decodeFilmResponse(t, updated)
	deleted := request(t, handler, http.MethodDelete, "/api/film/projects/film-api/scenes/"+scene.ID+"?revision="+strconv.Itoa(document.Scenes[0].Revision), nil)
	if deleted.Code != http.StatusOK || len(decodeFilmResponse(t, deleted).Scenes) != 0 {
		t.Fatalf("delete scene: %d %s", deleted.Code, deleted.Body.String())
	}
}

func TestFilmAPIExportRevisionMP4DisableAndAuthenticatedDownload(t *testing.T) {
	t.Setenv("OPENBOARD_FFMPEG_PATH", "")
	_, handler := filmAPIHandler(t)
	production := request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil)
	document := decodeFilmResponse(t, production)

	stale := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", []byte(`{"kind":"manifest","revision":999,"idempotencyKey":"stale-export"}`))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale export accepted: %d %s", stale.Code, stale.Body.String())
	}
	mp4Body, _ := json.Marshal(map[string]any{"kind": "mp4", "revision": document.Revision, "idempotencyKey": "missing-mp4"})
	mp4 := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", mp4Body)
	if mp4.Code != http.StatusServiceUnavailable || bytes.Contains(mp4.Body.Bytes(), []byte("/usr/")) {
		t.Fatalf("mp4 was not safely disabled: %d %s", mp4.Code, mp4.Body.String())
	}
	assetBundleBody, _ := json.Marshal(map[string]any{"kind": "asset_bundle", "revision": document.Revision, "idempotencyKey": "empty-bundle"})
	assetBundle := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", assetBundleBody)
	if assetBundle.Code != http.StatusCreated {
		t.Fatalf("asset bundle: %d %s", assetBundle.Code, assetBundle.Body.String())
	}

	document = decodeFilmResponse(t, assetBundle)
	manifestBody, _ := json.Marshal(map[string]any{"kind": "manifest", "revision": document.Revision, "idempotencyKey": "download-manifest"})
	manifest := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", manifestBody)
	if manifest.Code != http.StatusCreated {
		t.Fatalf("manifest: %d %s", manifest.Code, manifest.Body.String())
	}
	document = decodeFilmResponse(t, manifest)
	deliverable := waitForFilmDeliverable(t, handler, document.Deliverables[len(document.Deliverables)-1].ID, filmStatusApproved)
	download := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables/"+deliverable.ID+"/download", nil)
	if download.Code != http.StatusOK || download.Header().Get("Content-Type") != "application/json" || !bytes.Contains(download.Body.Bytes(), []byte(`"projectId"`)) {
		t.Fatalf("download: %d %s", download.Code, download.Body.String())
	}
}

func TestFilmAPIRestoreUsesCreateAndCAS(t *testing.T) {
	_, handler := filmAPIHandler(t)
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"film-restored","title":"Restored","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/film-restored", project); response.Code != http.StatusNoContent {
		t.Fatalf("seed restore project: %d %s", response.Code, response.Body.String())
	}
	createDocument := newFilmDocument("film-restored")
	createDocument.AspectRatio = "1:1"
	createBody, _ := json.Marshal(map[string]any{"revision": 0, "document": createDocument})
	created := request(t, handler, http.MethodPut, "/api/film/projects/film-restored/restore", createBody)
	if created.Code != http.StatusOK || decodeFilmResponse(t, created).AspectRatio != "1:1" {
		t.Fatalf("create restore: %d %s", created.Code, created.Body.String())
	}

	current := request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil)
	document := decodeFilmResponse(t, current)
	document.AspectRatio = "4:3"
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
	restored := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if restored.Code != http.StatusOK || decodeFilmResponse(t, restored).AspectRatio != "4:3" {
		t.Fatalf("restore: %d %s", restored.Code, restored.Body.String())
	}
	stale := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale restore accepted: %d %s", stale.Code, stale.Body.String())
	}
}

func TestFilmAPIRestoreRejectsCorruptAggregates(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*filmDocument)
	}{
		{"empty stages", func(document *filmDocument) { document.Stages = []filmStage{} }},
		{"missing stage", func(document *filmDocument) { document.Stages = document.Stages[:len(document.Stages)-1] }},
		{"duplicate entity ids", func(document *filmDocument) {
			document.Episodes = []filmEpisode{
				{ID: "episode_duplicate", Revision: 1, Title: "One", Status: filmStatusDraft},
				{ID: "episode_duplicate", Revision: 1, Title: "Two", Status: filmStatusDraft},
			}
		}},
		{"broken scene relation", func(document *filmDocument) {
			document.Scenes = []filmScene{{ID: "scene_orphan", Revision: 1, EpisodeID: "episode_missing", Heading: "INT. VOID - DAY", Status: filmStatusDraft}}
		}},
		{"broken shot relation", func(document *filmDocument) {
			document.Shots = []filmShot{{
				ID: "shot_orphan", Revision: 1, SceneID: "scene_missing", Title: "Shot", Description: "Action",
				Status: filmStatusDraft, DurationSeconds: 4, AspectRatio: "16:9", IdentityVersionIDs: []string{},
			}}
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, handler := filmAPIHandler(t)
			document := newFilmDocument("film-api")
			test.mutate(&document)
			body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
			response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("corrupt restore accepted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestFilmAPIRestoreRejectsUnverifiedMediaStorageKey(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nA light turns on.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "image:unverified-restore"
	document.Shots[0].MediaMIMEType = "image/png"
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusUnprocessableEntity || !bytes.Contains(bytes.ToLower(response.Body.Bytes()), []byte("verified")) {
		t.Fatalf("unverified restore media accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmRestoreCASFailureCleansRehydratedMedia(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	media := []byte("restore-cas-media")
	digest := sha256Hex(media)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:restore-cas", media, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:restore-cas"
	document.Shots[0].ImageSHA256 = digest
	document.Shots[0].MediaMIMEType = "image/png"
	backend.casErr = store.ErrConflict
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusConflict {
		t.Fatalf("restore conflict: %d %s", response.Code, response.Body.String())
	}
	key := restoredFilmMediaKey("film-api", digest, "")
	if orphan := request(t, handler, http.MethodGet, "/api/blobs/"+key, nil); orphan.Code != http.StatusNotFound {
		t.Fatalf("orphan restore media remains: %d %s", orphan.Code, orphan.Body.String())
	}
}

func TestFilmAPIRestoreAllowsDigestVerifiedTenantUploadsForShotsAndAssets(t *testing.T) {
	_, handler := filmAPIHandler(t)
	image := []byte("tenant-image-payload")
	digest := sha256.Sum256(image)
	digestHex := hex.EncodeToString(digest[:])
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:film-restore", image, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatalf("seed upload: %d %s", response.Code, response.Body.String())
	}
	video := []byte("tenant-video-payload")
	videoDigest := sha256Hex(video)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:film-restore-video", video, map[string]string{"Content-Type": "video/mp4"}); response.Code != http.StatusNoContent {
		t.Fatalf("seed video: %d %s", response.Code, response.Body.String())
	}
	deliverableBytes := []byte(`{"restored":true}`)
	deliverableDigest := sha256Hex(deliverableBytes)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:film-restore-deliverable", deliverableBytes, map[string]string{"Content-Type": "application/json"}); response.Code != http.StatusNoContent {
		t.Fatalf("seed deliverable: %d %s", response.Code, response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nA light turns on.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:film-restore"
	document.Shots[0].ImageSHA256 = digestHex
	document.Shots[0].VideoStorageKey = "upload:film-restore-video"
	document.Shots[0].VideoSHA256 = videoDigest
	document.Shots[0].MediaMIMEType = "image/png"
	document.Assets = []filmAsset{{ID: "asset-upload", Revision: 1, Kind: "style", Title: "Upload", Status: filmStatusDraft, Description: "Tenant upload", MediaStorageKey: "upload:film-restore", MediaMIMEType: "image/png", MediaSHA256: digestHex}}
	document.Timeline.Tracks[0].Clips = []filmTimelineClip{{ID: "restore-video", Revision: 1, Source: "upload:film-restore-video", Order: 0, Start: 0, End: 1, Volume: 1, Transition: "cut"}}
	document.Deliverables = []filmDeliverable{{ID: "restored-manifest", Revision: 1, Kind: "manifest", Status: filmStatusApproved, Title: "Restored manifest", MIMEType: "application/json", StorageKey: "upload:film-restore-deliverable", SHA256: deliverableDigest, Bytes: int64(len(deliverableBytes)), IdempotencyKey: "restore-manifest", RequestHash: strings.Repeat("a", 64), CreatedAt: document.CreatedAt}}
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusOK {
		t.Fatalf("verified restore rejected: %d %s", response.Code, response.Body.String())
	}
	restored := decodeFilmResponse(t, response)
	if !strings.HasPrefix(restored.Shots[0].ImageStorageKey, "film:media:film-api:") || !strings.HasPrefix(restored.Shots[0].VideoStorageKey, "film:media:film-api:") || !strings.HasPrefix(restored.Assets[0].MediaStorageKey, "film:media:film-api:") || restored.Timeline.Tracks[0].Clips[0].Source != restored.Shots[0].VideoStorageKey || !strings.HasPrefix(restored.Deliverables[0].StorageKey, "film:deliverable:film-api:") {
		t.Fatalf("restore did not rehydrate protected media references: %#v %#v %#v", restored.Shots[0], restored.Timeline, restored.Deliverables)
	}
	bundle := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "asset_bundle", "restored-bundle", restored.Revision))
	if bundle.Code != http.StatusCreated {
		t.Fatalf("restored media still depends on old jobs: %d %s", bundle.Code, bundle.Body.String())
	}

	document.Shots[0].ImageSHA256 = strings.Repeat("0", 64)
	body, _ = json.Marshal(map[string]any{"revision": decodeFilmResponse(t, bundle).Revision, "document": document})
	response = request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong digest restore accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmRestoreMediaMetadataIsStrictAndReturnsMigratedStorageKeys(t *testing.T) {
	_, handler := filmAPIHandler(t)
	media := []byte("restore-metadata")
	digest := sha256Hex(media)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:restore-metadata", media, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:restore-metadata"
	document.Shots[0].ImageSHA256 = digest
	document.Shots[0].ImageObjectVersion = blobContentVersion("image/png", media)
	document.Shots[0].MediaMIMEType = "image/png"
	mediaMetadata := []map[string]any{{
		"storageKey": "upload:restore-metadata", "mimeType": "image/png", "bytes": len(media), "sha256": digest,
		"objectVersion": document.Shots[0].ImageObjectVersion, "provenance": []map[string]any{{"kind": "shot", "entityId": document.Shots[0].ID, "field": "imageStorageKey"}},
	}}
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document, "media": mediaMetadata})
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusOK {
		t.Fatalf("metadata restore: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Meta struct {
			Rehydration struct {
				MigratedStorageKeys []string `json:"migratedStorageKeys"`
			} `json:"rehydration"`
		} `json:"meta"`
	}
	if json.Unmarshal(response.Body.Bytes(), &payload) != nil || len(payload.Meta.Rehydration.MigratedStorageKeys) != 1 || payload.Meta.Rehydration.MigratedStorageKeys[0] != "upload:restore-metadata" {
		t.Fatalf("restore migration metadata = %s", response.Body.String())
	}

	badMetadata := append([]map[string]any(nil), mediaMetadata...)
	badMetadata[0] = map[string]any{
		"storageKey": "upload:restore-metadata", "mimeType": "image/png", "bytes": len(media) + 1, "sha256": digest,
		"objectVersion": document.Shots[0].ImageObjectVersion, "provenance": []map[string]any{{"kind": "shot", "entityId": document.Shots[0].ID, "field": "videoStorageKey"}},
	}
	body, _ = json.Marshal(map[string]any{"revision": 2, "document": document, "media": badMetadata})
	bad := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if bad.Code != http.StatusUnprocessableEntity {
		t.Fatalf("mismatched restore metadata accepted: %d %s", bad.Code, bad.Body.String())
	}
}

func TestFilmRestoreMetadataValidatesEverySharedKeyProvenance(t *testing.T) {
	media := []byte("shared-identity")
	digest := sha256Hex(media)
	version := blobContentVersion("image/png", media)
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:shared-identity"
	document.Shots[0].ImageSHA256 = digest
	document.Shots[0].ImageObjectVersion = version
	document.Assets = []filmAsset{{
		ID: "asset-shared", Revision: 1, Kind: "style", Title: "Shared", Status: filmStatusDraft,
		Description: "Shared media", MediaStorageKey: "upload:shared-identity", MediaMIMEType: "image/png",
		MediaSHA256: strings.Repeat("0", 64), MediaObjectVersion: version,
	}}
	metadata := []filmRestoreMedia{{
		StorageKey: "upload:shared-identity", MIMEType: "image/png", Bytes: int64(len(media)), SHA256: digest, ObjectVersion: version,
		Provenance: []filmRestoreMediaProvenance{
			{Kind: "shot", EntityID: document.Shots[0].ID, Field: "imageStorageKey"},
			{Kind: "asset", EntityID: "asset-shared", Field: "mediaStorageKey"},
		},
	}}
	if err := validateFilmRestoreMediaMetadata(document, metadata); err == nil {
		t.Fatal("shared storage key skipped a mismatched provenance identity")
	}
}

func TestFilmRestoreRehydratesIndependentTimelineMediaFromStrictMetadata(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := newFilmDocument("film-api")
	tests := []struct {
		trackIndex int
		key        string
		mimeType   string
		data       []byte
	}{
		{trackIndex: 0, key: "upload:timeline-video", mimeType: "video/mp4", data: []byte("timeline-video")},
		{trackIndex: 2, key: "upload:timeline-music", mimeType: "audio/mpeg", data: []byte("timeline-music")},
		{trackIndex: 4, key: "upload:timeline-subtitle", mimeType: "application/x-subrip", data: []byte("1\n00:00:00,000 --> 00:00:01,000\nHello\n")},
	}
	metadata := make([]filmRestoreMedia, 0, len(tests))
	for _, test := range tests {
		if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+test.key, test.data, map[string]string{"Content-Type": test.mimeType}); response.Code != http.StatusNoContent {
			t.Fatalf("seed %s: %d %s", test.key, response.Code, response.Body.String())
		}
		clipID := "clip-" + strconv.Itoa(test.trackIndex)
		document.Timeline.Tracks[test.trackIndex].Clips = []filmTimelineClip{{
			ID: clipID, Revision: 1, Source: test.key, Order: 0, Start: 0, End: 1, Volume: 1, Transition: "cut",
		}}
		metadata = append(metadata, filmRestoreMedia{
			StorageKey: test.key, MIMEType: test.mimeType, Bytes: int64(len(test.data)), SHA256: sha256Hex(test.data),
			ObjectVersion: blobContentVersion(test.mimeType, test.data),
			Provenance:    []filmRestoreMediaProvenance{{Kind: "timeline", EntityID: clipID, Field: "source"}},
		})
	}
	body, _ := json.Marshal(filmRestoreRequest{Revision: 1, Document: document, Media: metadata})
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if response.Code != http.StatusOK {
		t.Fatalf("timeline restore: %d %s", response.Code, response.Body.String())
	}
	restored := decodeFilmResponse(t, response)
	for _, test := range tests {
		source := restored.Timeline.Tracks[test.trackIndex].Clips[0].Source
		if !strings.HasPrefix(source, "film:media:film-api:restore:") {
			t.Fatalf("track %d source was not rehydrated: %q", test.trackIndex, source)
		}
	}
}

func TestFilmRestoreAllowsOnlyCurrentlyReferencedProtectedMedia(t *testing.T) {
	_, handler := filmAPIHandler(t)
	restoreImage := func(projectID, sourceKey string, revision int, payload []byte) filmDocument {
		t.Helper()
		if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+sourceKey, payload, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
			t.Fatalf("seed %s: %d %s", sourceKey, response.Code, response.Body.String())
		}
		document, err := decomposeFilmSource(newFilmDocument(projectID), "INT. ROOM - DAY\nAction.")
		if err != nil {
			t.Fatal(err)
		}
		document.Shots[0].ImageStorageKey = sourceKey
		document.Shots[0].ImageSHA256 = sha256Hex(payload)
		document.Shots[0].MediaMIMEType = "image/png"
		body, _ := json.Marshal(map[string]any{"revision": revision, "document": document})
		response := request(t, handler, http.MethodPut, "/api/film/projects/"+projectID+"/restore", body)
		if response.Code != http.StatusOK {
			t.Fatalf("restore %s: %d %s", projectID, response.Code, response.Body.String())
		}
		return decodeFilmResponse(t, response)
	}

	current := restoreImage("film-api", "upload:protected-current", 1, []byte("current"))
	body, _ := json.Marshal(map[string]any{"revision": 2, "document": current})
	rollback := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if rollback.Code != http.StatusOK {
		t.Fatalf("safe protected rollback rejected: %d %s", rollback.Code, rollback.Body.String())
	}

	otherProject := []byte(`{"schemaVersion":3,"projectKind":"film","id":"film-other","title":"Other","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/film-other", otherProject); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	other := restoreImage("film-other", "upload:protected-other", 0, []byte("other"))
	latest := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	latest.Shots[0].ImageStorageKey = other.Shots[0].ImageStorageKey
	latest.Shots[0].ImageSHA256 = other.Shots[0].ImageSHA256
	latest.Shots[0].ImageObjectVersion = other.Shots[0].ImageObjectVersion
	body, _ = json.Marshal(map[string]any{"revision": 3, "document": latest})
	injected := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if injected.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unreferenced protected key injection accepted: %d %s", injected.Code, injected.Body.String())
	}
}

func TestFilmRestoreTokenRollsBackAggregateAndProtectedMediaWithCASBinding(t *testing.T) {
	_, handler := filmAPIHandler(t)
	restore := func(revision int, source string, payload []byte) (filmDocument, string, int) {
		t.Helper()
		if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+source, payload, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
			t.Fatalf("seed %s: %d %s", source, response.Code, response.Body.String())
		}
		document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
		if err != nil {
			t.Fatal(err)
		}
		document.Source.Text = source
		document.Shots[0].ImageStorageKey = source
		document.Shots[0].ImageSHA256 = sha256Hex(payload)
		document.Shots[0].MediaMIMEType = "image/png"
		body, _ := json.Marshal(filmRestoreRequest{Revision: revision, Document: document})
		response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
		if response.Code != http.StatusOK {
			t.Fatalf("restore %s: %d %s", source, response.Code, response.Body.String())
		}
		var result struct {
			Data filmDocument `json:"data"`
			Meta struct {
				RecordRevision int `json:"recordRevision"`
				Rehydration    struct {
					RestoreToken string `json:"restoreToken"`
				} `json:"rehydration"`
			} `json:"meta"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Meta.Rehydration.RestoreToken == "" {
			t.Fatalf("restore token missing: %v %s", err, response.Body.String())
		}
		return result.Data, result.Meta.Rehydration.RestoreToken, result.Meta.RecordRevision
	}

	first, _, _ := restore(1, "upload:rollback-first", []byte("first"))
	_, secondToken, secondRecordRevision := restore(2, "upload:rollback-second", []byte("second"))
	rollbackBody, _ := json.Marshal(map[string]any{"revision": secondRecordRevision, "restoreToken": secondToken})
	rolledBack := request(t, handler, http.MethodPost, "/api/film/projects/film-api/restore/rollback", rollbackBody)
	if rolledBack.Code != http.StatusOK {
		t.Fatalf("rollback: %d %s", rolledBack.Code, rolledBack.Body.String())
	}
	result := decodeFilmResponse(t, rolledBack)
	if result.Source.Text != "upload:rollback-first" || result.Shots[0].ImageStorageKey != first.Shots[0].ImageStorageKey {
		t.Fatalf("rollback did not restore old aggregate/media: %#v", result)
	}

	otherProject := bytes.ReplaceAll([]byte(`{"schemaVersion":3,"projectKind":"film","id":"film-api","title":"Film API","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`), []byte("film-api"), []byte("film-other"))
	if response := request(t, handler, http.MethodPut, "/api/projects/film-other", otherProject); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/film-other", []byte(`{}`)); response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	crossBody, _ := json.Marshal(map[string]any{"revision": 1, "restoreToken": secondToken})
	cross := request(t, handler, http.MethodPost, "/api/film/projects/film-other/restore/rollback", crossBody)
	if cross.Code != http.StatusNotFound {
		t.Fatalf("cross-project restore token accepted: %d %s", cross.Code, cross.Body.String())
	}
}

func TestFilmRestoreCASLoserDoesNotDeleteWinnerReferencedMedia(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	media := []byte("restore-winner")
	digest := sha256Hex(media)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:restore-winner", media, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:restore-winner"
	document.Shots[0].ImageSHA256 = digest
	document.Shots[0].MediaMIMEType = "image/png"
	body, _ := json.Marshal(map[string]any{"revision": 1, "document": document})
	blocked := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	backend.casHook = func() {
		if calls.Add(1) == 1 {
			close(blocked)
			<-release
		}
	}
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { firstDone <- request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body) }()
	<-blocked
	winner := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	close(release)
	loser := <-firstDone
	if winner.Code != http.StatusOK || loser.Code != http.StatusConflict {
		t.Fatalf("restore race winner=%d %s loser=%d %s", winner.Code, winner.Body.String(), loser.Code, loser.Body.String())
	}
	key := restoredFilmMediaKey("film-api", digest, "")
	if blob := request(t, handler, http.MethodGet, "/api/blobs/"+key, nil); blob.Code != http.StatusOK || !bytes.Equal(blob.Body.Bytes(), media) {
		t.Fatalf("CAS loser deleted winner media: %d %q", blob.Code, blob.Body.Bytes())
	}
}
