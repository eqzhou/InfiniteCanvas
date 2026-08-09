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
	if len(created.Deliverables) != 1 || created.Deliverables[0].StorageKey == "" || created.Deliverables[0].Content != "" {
		t.Fatalf("manifest was not externalized: %#v", created.Deliverables)
	}

	replay := request(t, handler, http.MethodPost, "/api/film/projects/film-api/exports", body)
	if replay.Code != http.StatusOK {
		t.Fatalf("manifest replay: %d %s", replay.Code, replay.Body.String())
	}
	if got := decodeFilmResponse(t, replay); len(got.Deliverables) != 1 {
		t.Fatalf("replay duplicated deliverable id: %#v", got.Deliverables)
	}

	download := request(t, handler, http.MethodGet, "/api/film/projects/film-api/deliverables/"+created.Deliverables[0].ID+"/download", nil)
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
	deliverable := document.Deliverables[len(document.Deliverables)-1]
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
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bundle silently omitted missing media: %d %s", response.Code, response.Body.String())
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
