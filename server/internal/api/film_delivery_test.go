package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func filmExportBody(t *testing.T, kind, key string, revision int) []byte {
	t.Helper()
	value, err := json.Marshal(map[string]any{"kind": kind, "revision": revision, "idempotencyKey": key})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func waitForFilmDeliverable(t *testing.T, handler http.Handler, id string, statuses ...string) filmDeliverable {
	t.Helper()
	wanted := map[string]bool{}
	for _, status := range statuses {
		wanted[status] = true
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		document := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
		for _, item := range document.Deliverables {
			if item.ID == id && wanted[item.Status] {
				return item
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("deliverable %s did not reach %v", id, statuses)
	return filmDeliverable{}
}

func seedPersistentFilmExport(t *testing.T, backend *filmMemoryStore, projectID, key string) (string, string) {
	t.Helper()
	document := newFilmDocument(projectID)
	requestHash := strings.Repeat("a", 64)
	jobID := stableFilmID("export-job", projectID, key)
	deliverableID := stableFilmID("deliverable", projectID, key)
	snapshot, _ := json.Marshal(document)
	parameters, _ := json.Marshal(filmExportJobParameters{Executor: filmExportExecutorMarker, ProjectID: projectID, Kind: "manifest", IdempotencyKey: key, RequestHash: requestHash, Snapshot: snapshot})
	document.Deliverables = append(document.Deliverables, filmDeliverable{ID: deliverableID, Revision: 1, Kind: "manifest", Status: filmStatusRunning, Title: "Production manifest", MIMEType: "application/json", IdempotencyKey: key, RequestHash: requestHash, GenerationJobID: jobID, CreatedAt: document.CreatedAt})
	document.Revision++
	raw, _ := json.Marshal(document)
	if _, err := backend.CreateFilmProject(t.Context(), store.DefaultTenantID, projectID, raw); err != nil {
		t.Fatal(err)
	}
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, store.GenerationJob{ID: jobID, ProjectID: projectID, Kind: "export", Status: "queued", Prompt: "film export manifest", Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: document.CreatedAt, UpdatedAt: document.CreatedAt}); err != nil {
		t.Fatal(err)
	}
	return jobID, deliverableID
}

func TestFilmExportWorkerResumesPersistedQueuedJob(t *testing.T) {
	backend := newFilmMemoryStore()
	jobID, deliverableID := seedPersistentFilmExport(t, backend, "film-export-resume", "resume-manifest")
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-export-resume")
		document, _ := decodeFilmDocument(record.Document)
		for _, item := range document.Deliverables {
			if item.ID == deliverableID && item.Status == filmStatusApproved && item.StorageKey != "" {
				job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, jobID)
				if err != nil || job.Status != "succeeded" {
					t.Fatalf("resumed export job = %#v err=%v", job, err)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("persisted export was not resumed")
}

func TestQueuedFilmExportCancellationUpdatesDeliverable(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newFilmMemoryStore()
	jobID, deliverableID := seedPersistentFilmExport(t, backend, "film-export-cancel", "cancel-manifest")
	server := NewServer(t.TempDir())
	server.store = backend
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	response := request(t, router, http.MethodPost, "/api/generation-jobs/"+jobID+"/cancel", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("cancel export: %d %s", response.Code, response.Body.String())
	}
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-export-cancel")
	document, _ := decodeFilmDocument(record.Document)
	for _, item := range document.Deliverables {
		if item.ID == deliverableID && item.Status == filmStatusCanceled && item.Diagnostic != "" {
			return
		}
	}
	t.Fatalf("queued deliverable was not canceled: %#v", document.Deliverables)
}

func TestFilmExportCancellationWinsAfterDeliverableApprovalRace(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newFilmMemoryStore()
	jobID, deliverableID := seedPersistentFilmExport(t, backend, "film-export-cancel-race", "cancel-race")
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-export-cancel-race")
	document, _ := decodeFilmDocument(record.Document)
	document.Deliverables[0].Status = filmStatusApproved
	document.Deliverables[0].StorageKey = "film:deliverable:film-export-cancel-race:" + deliverableID
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw)
	server := NewServer(t.TempDir())
	server.store = backend
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	if response := request(t, router, http.MethodPost, "/api/generation-jobs/"+jobID+"/cancel", nil); response.Code != http.StatusOK {
		t.Fatalf("cancel export race: %d %s", response.Code, response.Body.String())
	}
	record, _ = backend.GetFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID)
	document, _ = decodeFilmDocument(record.Document)
	if document.Deliverables[0].Status != filmStatusCanceled {
		t.Fatalf("approved deliverable won cancellation race: %#v", document.Deliverables[0])
	}
}

func TestCompletedFilmExportCancellationKeepsApprovedDeliverable(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newFilmMemoryStore()
	jobID, _ := seedPersistentFilmExport(t, backend, "film-export-completed", "completed-export")
	backend.mu.Lock()
	job := backend.jobs[tenantKey(store.DefaultTenantID, jobID)]
	job.Status = "succeeded"
	backend.jobs[tenantKey(store.DefaultTenantID, jobID)] = job
	backend.mu.Unlock()
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-export-completed")
	document, _ := decodeFilmDocument(record.Document)
	document.Deliverables[0].Status = filmStatusApproved
	document.Deliverables[0].StorageKey = "film:deliverable:film-export-completed:approved"
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw)
	server := NewServer(t.TempDir())
	server.store = backend
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	if response := request(t, router, http.MethodPost, "/api/generation-jobs/"+jobID+"/cancel", nil); response.Code != http.StatusOK {
		t.Fatalf("cancel completed export: %d %s", response.Code, response.Body.String())
	}
	record, _ = backend.GetFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID)
	document, _ = decodeFilmDocument(record.Document)
	if document.Deliverables[0].Status != filmStatusApproved {
		t.Fatalf("completed export deliverable was canceled: %#v", document.Deliverables[0])
	}
}

func TestFilmStatusReconcilesMissingExportJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	document, _ := decodeFilmDocument(record.Document)
	document.Deliverables = append(document.Deliverables, filmDeliverable{ID: "missing-export", Revision: 1, Kind: "manifest", Status: filmStatusRunning, Title: "Manifest", MIMEType: "application/json", GenerationJobID: "missing-export-job", CreatedAt: document.CreatedAt})
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw)
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	if current.Deliverables[0].Status != filmStatusFailed || current.Deliverables[0].Diagnostic == "" {
		t.Fatalf("missing export job remained running: %#v", current.Deliverables[0])
	}
}

func TestFilmExportIdempotencyReplayReconcilesMissingJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	document, _ := decodeFilmDocument(record.Document)
	input := filmExportRequest{Kind: "manifest", Revision: document.Revision, IdempotencyKey: "missing-replay"}
	requestHash, _ := hashGenerationInput(input)
	document.Deliverables = append(document.Deliverables, filmDeliverable{
		ID: stableFilmID("deliverable", document.ProjectID, input.IdempotencyKey), Revision: 1, Kind: input.Kind,
		Status: filmStatusRunning, Title: "Manifest", MIMEType: "application/json", IdempotencyKey: input.IdempotencyKey,
		RequestHash: requestHash, GenerationJobID: stableFilmID("export-job", document.ProjectID, input.IdempotencyKey), CreatedAt: document.CreatedAt,
	})
	document.Revision++
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, input.Kind, input.IdempotencyKey, input.Revision))
	if response.Code != http.StatusOK {
		t.Fatalf("replay missing export: %d %s", response.Code, response.Body.String())
	}
	current := decodeFilmResponse(t, response)
	if current.Deliverables[len(current.Deliverables)-1].Status != filmStatusFailed {
		t.Fatalf("missing export job was not reconciled on replay: %#v", current.Deliverables)
	}
}

func TestFilmShotsCSVNeutralizesSpreadsheetFormulas(t *testing.T) {
	document := newFilmDocument("csv-safe")
	document.Shots = []filmShot{{ID: "shot", SceneID: "scene", Order: 0, Title: "=CMD()", Description: "+payload", Subtitle: "@lookup", DurationSeconds: 1}}
	value, err := filmShotsCSV(document)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(value, []byte("'=CMD()")) || !bytes.Contains(value, []byte("'+payload")) || !bytes.Contains(value, []byte("'@lookup")) {
		t.Fatalf("unsafe CSV: %s", value)
	}
}

func TestFilmManifestExportIsIdempotentAndStoredOutsideDocument(t *testing.T) {
	_, handler := filmAPIHandler(t)
	current := request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil)
	document := decodeFilmResponse(t, current)
	body := filmExportBody(t, "manifest", "manifest-v1", document.Revision)

	first := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", body)
	if first.Code != http.StatusCreated {
		t.Fatalf("manifest export: %d %s", first.Code, first.Body.String())
	}
	created := decodeFilmResponse(t, first)
	if len(created.Deliverables) != 1 || created.Deliverables[0].GenerationJobID == "" || created.Deliverables[0].Content != "" {
		t.Fatalf("manifest was not queued durably: %#v", created.Deliverables)
	}
	deliverable := waitForFilmDeliverable(t, handler, created.Deliverables[0].ID, filmStatusApproved)
	if deliverable.StorageKey == "" {
		t.Fatalf("manifest was not externalized: %#v", deliverable)
	}

	replay := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", body)
	if replay.Code != http.StatusOK {
		t.Fatalf("manifest replay: %d %s", replay.Code, replay.Body.String())
	}
	if got := decodeFilmResponse(t, replay); len(got.Deliverables) != 1 {
		t.Fatalf("replay duplicated deliverable id: %#v", got.Deliverables)
	}

	download := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables/"+deliverable.ID+"/download", nil)
	if download.Code != http.StatusOK || !bytes.Contains(download.Body.Bytes(), []byte(`"projectId"`)) {
		t.Fatalf("external manifest download: %d %s", download.Code, download.Body.String())
	}
}

func TestFilmExportUsesStableDefaultIdempotencyKey(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
	body, _ := json.Marshal(map[string]any{"kind": "manifest", "revision": document.Revision})
	first := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", body)
	if first.Code != http.StatusCreated {
		t.Fatalf("default export: %d %s", first.Code, first.Body.String())
	}
	replay := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", body)
	if replay.Code != http.StatusOK || len(decodeFilmResponse(t, replay).Deliverables) != 1 {
		t.Fatalf("default export replay: %d %s", replay.Code, replay.Body.String())
	}
}

func TestFilmExportCASFailureCleansNewUnreferencedBlob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
	backend.casErr = store.ErrConflict
	key := "orphan-cleanup"
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "manifest", key, document.Revision))
	if response.Code != http.StatusConflict {
		t.Fatalf("export conflict: %d %s", response.Code, response.Body.String())
	}
	deliverableID := stableFilmID("deliverable", document.ProjectID, key)
	storageKey := "/api/blobs/film:deliverable:" + document.ProjectID + ":" + deliverableID
	if orphan := request(t, handler, http.MethodGet, storageKey, nil); orphan.Code != http.StatusNotFound {
		t.Fatalf("orphan export blob remains: %d %s", orphan.Code, orphan.Body.String())
	}
}

func TestFilmExportRejectsDeliverableRetentionOverflow(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	document, _ := decodeFilmDocument(record.Document)
	document.Deliverables = make([]filmDeliverable, 100)
	for index := range document.Deliverables {
		document.Deliverables[index].ID = fmt.Sprintf("deliverable-%d", index)
	}
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, "film-api", record.Revision, raw)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "manifest", "overflow", document.Revision))
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("deliverable overflow accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmAssetBundleUsesGeneratedSafeZipPaths(t *testing.T) {
	_, handler := filmAPIHandler(t)
	source := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"originalName":"unsafe.txt","text":"INT. ROOM - DAY\nAction."}`))
	if source.Code != http.StatusOK {
		t.Fatal(source.Body.String())
	}
	document := decodeFilmResponse(t, source)
	exported := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "asset_bundle", "bundle-v1", document.Revision))
	if exported.Code != http.StatusCreated {
		t.Fatalf("bundle export: %d %s", exported.Code, exported.Body.String())
	}
	document = decodeFilmResponse(t, exported)
	deliverable := waitForFilmDeliverable(t, handler, document.Deliverables[len(document.Deliverables)-1].ID, filmStatusApproved)
	download := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables/"+deliverable.ID+"/download", nil)
	if download.Code != http.StatusOK || download.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("bundle download: %d %s", download.Code, download.Body.String())
	}
	reader, err := zip.NewReader(bytes.NewReader(download.Body.Bytes()), int64(download.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"script/manuscript.txt": false, "tables/shots.csv": false, "manifest.json": false, "media/inventory.json": false}
	for _, entry := range reader.File {
		if strings.HasPrefix(entry.Name, "/") || strings.Contains(entry.Name, "\\") || strings.Contains(entry.Name, "../") {
			t.Fatalf("unsafe ZIP path %q", entry.Name)
		}
		if _, ok := wanted[entry.Name]; ok {
			wanted[entry.Name] = true
		}
	}
	for name, found := range wanted {
		if !found {
			t.Errorf("bundle is missing %s", name)
		}
	}
}

func TestFilmAssetBundleFailsWhenAnyReferencedMediaIsUnavailable(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	document, _ := decodeFilmDocument(record.Document)
	document, err = decomposeFilmSource(document, "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:missing-bundle-media"
	document.Shots[0].ImageSHA256 = strings.Repeat("a", 64)
	document.Shots[0].MediaMIMEType = "image/png"
	raw, _ := json.Marshal(document)
	_, _ = backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, "film-api", record.Revision, raw)

	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "asset_bundle", "missing-media", document.Revision))
	if response.Code != http.StatusCreated {
		t.Fatalf("bundle task was not queued: %d %s", response.Code, response.Body.String())
	}
	queued := decodeFilmResponse(t, response).Deliverables
	failed := waitForFilmDeliverable(t, handler, queued[len(queued)-1].ID, filmStatusFailed)
	if failed.Diagnostic == "" {
		t.Fatal("failed bundle did not retain a diagnostic")
	}
}

func TestFilmMP4CapabilityAndExportAreDisabledWithoutFFmpeg(t *testing.T) {
	t.Setenv("OPENBOARD_FFMPEG_PATH", "")
	_, handler := filmAPIHandler(t)
	capabilities := request(t, handler, http.MethodGet, "/api/film/capabilities", nil)
	var capabilityPayload struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(capabilities.Body.Bytes(), &capabilityPayload)
	if capabilities.Code != http.StatusOK || capabilityPayload.Data["render"] != false || !bytes.Contains(bytes.ToLower(capabilities.Body.Bytes()), []byte("ffmpeg")) {
		t.Fatalf("capabilities: %d %s", capabilities.Code, capabilities.Body.String())
	}
	for _, name := range []string{"stageGeneration", "generationJobs", "assetBundleExport"} {
		if _, ok := capabilityPayload.Data[name].(bool); !ok {
			t.Fatalf("capability %s is missing or not boolean: %#v", name, capabilityPayload.Data[name])
		}
	}
	document := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", filmExportBody(t, "mp4", "mp4-missing", document.Revision))
	if response.Code != http.StatusServiceUnavailable || !bytes.Contains(bytes.ToLower(response.Body.Bytes()), []byte("ffmpeg")) {
		t.Fatalf("missing FFmpeg export: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmCapabilitiesDefaultClosedWhenFilmModeIsDisabled(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_FILM_MODE", "false")
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	router := chi.NewRouter()
	MountServer(router, server)
	response := request(t, router, http.MethodGet, "/api/film/capabilities", nil)
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"import", "stageGeneration", "generationJobs", "render", "package", "assetBundleExport"} {
		if payload.Data[name] != false {
			t.Fatalf("disabled capability %s = %#v", name, payload.Data[name])
		}
	}
}

type blockingFilmCommandRunner struct {
	started chan struct{}
}

type countingFilmCommandRunner struct{ calls atomic.Int32 }

func (runner *countingFilmCommandRunner) Run(_ context.Context, _ string, _ []string) error {
	runner.calls.Add(1)
	return nil
}

type fakeFilmProbeRunner struct {
	result []byte
	err    error
	calls  atomic.Int32
	args   []string
}

func (runner *fakeFilmProbeRunner) Probe(_ context.Context, _ string, args []string) ([]byte, error) {
	runner.calls.Add(1)
	runner.args = append([]string(nil), args...)
	return append([]byte(nil), runner.result...), runner.err
}

func TestFilmFFmpegCapabilityProbeIsCached(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_FFMPEG_PATH", executable)
	t.Setenv("OPENBOARD_FFPROBE_PATH", executable)
	runner := &countingFilmCommandRunner{}
	probe := &fakeFilmProbeRunner{result: []byte("ffprobe version")}
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	server.filmCommandRunner = runner
	server.filmProbeRunner = probe
	t.Cleanup(server.Close)
	for range 3 {
		if _, available, _ := server.filmFFmpegCapability(t.Context()); !available {
			t.Fatal("fake executable capability unexpectedly unavailable")
		}
	}
	if runner.calls.Load() != 1 || probe.calls.Load() != 1 {
		t.Fatalf("capability spawned ffmpeg=%d ffprobe=%d probes", runner.calls.Load(), probe.calls.Load())
	}
}

func TestFilmMP4CapabilityRequiresFFprobe(t *testing.T) {
	executable, _ := os.Executable()
	t.Setenv("OPENBOARD_FFMPEG_PATH", executable)
	t.Setenv("OPENBOARD_FFPROBE_PATH", "/definitely/missing/ffprobe")
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	server.filmCommandRunner = &countingFilmCommandRunner{}
	t.Cleanup(server.Close)
	if _, available, diagnostic := server.filmFFmpegCapability(t.Context()); available || !strings.Contains(strings.ToLower(diagnostic), "ffprobe") {
		t.Fatalf("missing ffprobe capability available=%v diagnostic=%q", available, diagnostic)
	}
}

func TestFilmFFmpegCapabilityAcceptsSymlinkedExecutables(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ffmpegLink := filepath.Join(dir, "ffmpeg")
	ffprobeLink := filepath.Join(dir, "ffprobe")
	if err := os.Symlink(executable, ffmpegLink); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(executable, ffprobeLink); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_FFMPEG_PATH", ffmpegLink)
	t.Setenv("OPENBOARD_FFPROBE_PATH", ffprobeLink)
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	server.filmCommandRunner = &countingFilmCommandRunner{}
	server.filmProbeRunner = &fakeFilmProbeRunner{result: []byte("ffprobe version")}
	t.Cleanup(server.Close)
	if _, available, diagnostic := server.filmFFmpegCapability(t.Context()); !available {
		t.Fatalf("symlinked ffmpeg/ffprobe should be available, diagnostic=%q", diagnostic)
	}
}

func TestFilmRendererProducesARealPlayableMP4(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	ffprobePath, _ := exec.LookPath("ffprobe")
	if resolved, resolveErr := filepath.EvalSymlinks(ffmpegPath); resolveErr == nil {
		ffmpegPath = resolved
	}
	if resolved, resolveErr := filepath.EvalSymlinks(ffprobePath); resolveErr == nil {
		ffprobePath = resolved
	}
	t.Setenv("OPENBOARD_FFMPEG_PATH", ffmpegPath)
	t.Setenv("OPENBOARD_FFPROBE_PATH", ffprobePath)
	inputPath := filepath.Join(t.TempDir(), "source.mp4")
	command := exec.Command(ffmpegPath, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", inputPath)
	if output, runErr := command.CombinedOutput(); runErr != nil {
		t.Skipf("local ffmpeg cannot create the test fixture: %v %s", runErr, output)
	}
	input, err := os.ReadFile(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	server, backend, handler := filmAPIServerHandler(t)
	storageKey := "upload:film-real-render-source"
	upload := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+storageKey, input, map[string]string{"Content-Type": "video/mp4"})
	if upload.Code != http.StatusNoContent {
		t.Fatalf("upload fixture: %d %s", upload.Code, upload.Body.String())
	}
	value, err := server.readTenantBlob(t.Context(), store.DefaultTenantID, storageKey, int64(len(input))+1)
	if err != nil {
		t.Fatal(err)
	}
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	document, err := decodeFilmDocument(record.Document)
	if err != nil {
		t.Fatal(err)
	}
	shot := filmShot{ID: "shot-real-render", Revision: 1, SceneID: "scene-real-render", Order: 0, Title: "Blue frame", Description: "Blue frame", Status: filmStatusApproved, DurationSeconds: 1, AspectRatio: "16:9", VideoStorageKey: storageKey, VideoSHA256: sha256Hex(input), VideoObjectVersion: blobIdentityVersion(value), MediaMIMEType: "video/mp4", MediaProvenance: "restore"}
	document.Shots = []filmShot{shot}
	document.Timeline = filmTimeline{Revision: 1, Width: 640, Height: 360, FrameRate: 24, Tracks: []filmTimelineTrack{
		{ID: "video-track", Revision: 1, Kind: "video", Title: "Video", Clips: []filmTimelineClip{{ID: "clip-1", Revision: 1, Source: "shot:" + shot.ID, Order: 0, Start: 0, End: 1, Volume: 1, Transition: "cut"}}},
		{ID: "dialogue-track", Revision: 1, Kind: "dialogue", Title: "Dialogue"},
		{ID: "music-track", Revision: 1, Kind: "music", Title: "Music"},
		{ID: "sfx-track", Revision: 1, Kind: "sfx", Title: "SFX"},
		{ID: "subtitle-track", Revision: 1, Kind: "subtitle", Title: "Subtitles"},
	}}
	raw, _ := json.Marshal(document)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw); err != nil {
		t.Fatal(err)
	}
	rendered, err := server.renderFilmMP4(t.Context(), store.DefaultTenantID, document, ffmpegPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(rendered) < 1024 || !bytes.Contains(rendered[:min(len(rendered), 64)], []byte("ftyp")) {
		t.Fatalf("renderer did not return an MP4 container: %d bytes", len(rendered))
	}
	outputPath := filepath.Join(t.TempDir(), "rendered.mp4")
	if err := os.WriteFile(outputPath, rendered, 0o600); err != nil {
		t.Fatal(err)
	}
	probe := exec.Command(ffprobePath, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", outputPath)
	probeOutput, probeErr := probe.CombinedOutput()
	if probeErr != nil || !bytes.Contains(probeOutput, []byte(`"codec_name": "h264"`)) || !bytes.Contains(probeOutput, []byte(`"width": 640`)) || !bytes.Contains(probeOutput, []byte(`"height": 360`)) {
		t.Fatalf("rendered output is not a playable 640x360 H.264 video: err=%v probe=%s", probeErr, probeOutput)
	}
}

func TestFilmFFprobeRejectsMaliciousOrExcessiveContainer(t *testing.T) {
	probe := &fakeFilmProbeRunner{result: []byte(`{"streams":[{"codec_type":"video","width":7680,"height":4320,"duration":"7200","bit_rate":"999999999","nb_frames":"999999999"}],"format":{"duration":"7200","bit_rate":"999999999"}}`)}
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	server.filmProbeRunner = probe
	t.Cleanup(server.Close)
	if err := server.probeFilmInput(t.Context(), "/usr/bin/ffprobe", "/private/input.mp4", "video", 4); err == nil {
		t.Fatal("excessive container metadata was accepted")
	}
	joined := strings.Join(probe.args, " ")
	for _, required := range []string{"-probesize", "-analyzeduration", "-protocol_whitelist", "file,pipe", "-threads", "1"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("bounded ffprobe argument %q missing from %s", required, joined)
		}
	}
}

func TestFilmFFprobeRejectsProbeFailureAndMalformedMetadata(t *testing.T) {
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	server.filmProbeRunner = &fakeFilmProbeRunner{err: errors.New("probe failed")}
	if err := server.probeFilmInput(t.Context(), "/usr/bin/ffprobe", "/private/input.mp4", "video", 4); !errors.Is(err, errFilmFFprobeFailed) {
		t.Fatalf("probe failure = %v", err)
	}
	server.filmProbeRunner = &fakeFilmProbeRunner{result: []byte(`{"streams":[{"codec_type":"attachment"}],"format":{"duration":"1"}}`)}
	if err := server.probeFilmInput(t.Context(), "/usr/bin/ffprobe", "/private/input.mp4", "video", 4); !errors.Is(err, errFilmFFprobeFailed) {
		t.Fatalf("malformed metadata = %v", err)
	}
}

func TestFilmFFprobeReturnsBoundedDurationAndDimensions(t *testing.T) {
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	server.filmProbeRunner = &fakeFilmProbeRunner{result: []byte(`{"streams":[{"codec_type":"video","width":1280,"height":720,"duration":"5","bit_rate":"1000","nb_frames":"120"}],"format":{"duration":"5","bit_rate":"1000"}}`)}
	metadata, err := server.probeFilmInputMetadata(t.Context(), "/usr/bin/ffprobe", "/private/input.mp4", "video", 5)
	if err != nil || metadata.Duration != 5 || metadata.Width != 1280 || metadata.Height != 720 {
		t.Fatalf("probe metadata = %#v err=%v", metadata, err)
	}
}

func TestFilmRenderSemaphoreLimitsTenantConcurrency(t *testing.T) {
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	release, err := server.acquireFilmRender(t.Context(), "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := server.acquireFilmRender(t.Context(), "tenant-a"); !errors.Is(err, errFilmRenderBusy) {
		t.Fatalf("second tenant render = %v", err)
	}
}

func (runner *blockingFilmCommandRunner) Run(ctx context.Context, _ string, _ []string) error {
	close(runner.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestFilmRendererHonorsCancellationAndCleansTemporaryDirectory(t *testing.T) {
	runner := &blockingFilmCommandRunner{started: make(chan struct{})}
	root := t.TempDir()
	server := NewServerWithStore(root, newFilmMemoryStore())
	server.filmCommandRunner = runner
	t.Cleanup(server.Close)

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, err := server.executeFilmFFmpeg(ctx, "/usr/bin/ffmpeg", []string{"-version"}, 10*time.Second)
		done <- err
	}()
	<-runner.started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("renderer cancellation = %v", err)
	}
	entries, err := os.ReadDir(root + "/film-render")
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("render temporary files were not cleaned: %#v", entries)
	}
}
