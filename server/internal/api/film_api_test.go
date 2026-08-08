package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmMemoryStore struct {
	*memoryStore
	filmMu sync.Mutex
	films  map[string]store.FilmRecord
}

func newFilmMemoryStore() *filmMemoryStore {
	return &filmMemoryStore{memoryStore: newMemoryStore(), films: map[string]store.FilmRecord{}}
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
	backend := newFilmMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
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
	for index := range document.Shots {
		shot := document.Shots[index]
		mediaBody, _ := json.Marshal(map[string]any{"revision": shot.Revision, "imageStorageKey": "image:shot-" + shot.ID})
		response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+shot.ID, mediaBody)
		if response.Code != http.StatusOK {
			t.Fatalf("attach storyboard media: %d %s", response.Code, response.Body.String())
		}
		document = decodeFilmResponse(t, response)
	}

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

	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", []byte(`{"revision":1}`))
	if run.Code != http.StatusAccepted {
		t.Fatalf("run stage: %d %s", run.Code, run.Body.String())
	}
	document = decodeFilmResponse(t, run)
	stage := document.Stages[2]
	if stage.Status != filmStatusNeedsReview {
		t.Fatalf("generated stage status=%q", stage.Status)
	}
	approveBody, _ := json.Marshal(map[string]any{"revision": stage.Revision})
	approved := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/approve", approveBody)
	if approved.Code != http.StatusOK {
		t.Fatalf("approve stage: %d %s", approved.Code, approved.Body.String())
	}

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
	exportBody, _ := json.Marshal(map[string]any{"kind": "manifest", "revision": document.Revision})
	exported := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", exportBody)
	if exported.Code != http.StatusCreated {
		t.Fatalf("manifest export: %d %s", exported.Code, exported.Body.String())
	}
	deliverables := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables", nil)
	if deliverables.Code != http.StatusOK || !bytes.Contains(deliverables.Body.Bytes(), []byte(`"manifest"`)) || bytes.Contains(deliverables.Body.Bytes(), []byte(`"asset_bundle"`)) {
		t.Fatalf("deliverables: %d %s", deliverables.Code, deliverables.Body.String())
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

	blocked := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", []byte(`{"revision":1}`))
	if blocked.Code != http.StatusConflict {
		t.Fatalf("stage dependency bypassed: %d %s", blocked.Code, blocked.Body.String())
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
	_, handler := filmAPIHandler(t)
	production := request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil)
	document := decodeFilmResponse(t, production)

	stale := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", []byte(`{"kind":"manifest","revision":999}`))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale export accepted: %d %s", stale.Code, stale.Body.String())
	}
	mp4Body, _ := json.Marshal(map[string]any{"kind": "mp4", "revision": document.Revision})
	mp4 := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", mp4Body)
	if mp4.Code != http.StatusNotImplemented || bytes.Contains(mp4.Body.Bytes(), []byte("OPENBOARD_FFMPEG_PATH")) {
		t.Fatalf("mp4 was not safely disabled: %d %s", mp4.Code, mp4.Body.String())
	}
	assetBundleBody, _ := json.Marshal(map[string]any{"kind": "asset_bundle", "revision": document.Revision})
	assetBundle := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", assetBundleBody)
	if assetBundle.Code != http.StatusUnprocessableEntity {
		t.Fatalf("fake asset bundle accepted: %d %s", assetBundle.Code, assetBundle.Body.String())
	}

	manifestBody, _ := json.Marshal(map[string]any{"kind": "manifest", "revision": document.Revision})
	manifest := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", manifestBody)
	if manifest.Code != http.StatusCreated {
		t.Fatalf("manifest: %d %s", manifest.Code, manifest.Body.String())
	}
	document = decodeFilmResponse(t, manifest)
	deliverable := document.Deliverables[len(document.Deliverables)-1]
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
