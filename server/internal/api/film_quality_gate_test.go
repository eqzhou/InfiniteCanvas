package api

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

type oversizedQualityBlobStore struct{ gets int }

func (s *oversizedQualityBlobStore) Kind() string               { return "quality-test" }
func (s *oversizedQualityBlobStore) Ping(context.Context) error { return nil }
func (s *oversizedQualityBlobStore) Put(context.Context, string, string, blobObject, string) (string, error) {
	return "", errors.New("not implemented")
}
func (s *oversizedQualityBlobStore) Delete(context.Context, string, string, string) error {
	return errors.New("not implemented")
}
func (s *oversizedQualityBlobStore) Get(context.Context, string, string, int64) (blobObject, error) {
	s.gets++
	return blobObject{}, errBlobObjectTooLarge
}

func TestFilmQualityGateLimitsTenantConcurrencyAndRate(t *testing.T) {
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	release, err := server.acquireFilmQualityCheck(t.Context(), "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.acquireFilmQualityCheck(t.Context(), "tenant-a"); !errors.Is(err, errFilmQualityBusy) {
		t.Fatalf("same tenant concurrent quality check err = %v", err)
	}
	release()
	for range maxFilmQualityChecksPerTenantMinute - 1 {
		release, err = server.acquireFilmQualityCheck(t.Context(), "tenant-a")
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	if _, err := server.acquireFilmQualityCheck(t.Context(), "tenant-a"); !errors.Is(err, errFilmQualityBusy) {
		t.Fatalf("quality rate limit err = %v", err)
	}
}

func TestFilmNestedMediaReferencesAreRestorableAndCleaned(t *testing.T) {
	document := newFilmDocument("nested-media")
	document.Dialogues = []filmDialogue{{ID: "dialogue", AudioStorageKey: "film:media:nested-media:dialogue"}}
	document.Tasks = []filmTask{{ID: "task", Snapshot: &filmGenerationSnapshot{
		IdentityVersions:     []filmAsset{{ID: "identity", MediaStorageKey: "film:media:nested-media:identity"}},
		StyleVersion:         &filmAsset{ID: "style", MediaStorageKey: "film:media:nested-media:style"},
		ReferenceStorageKeys: []string{"film:media:nested-media:reference"},
	}}}
	references := filmRestoreReferences(document)
	for _, key := range []string{
		"film:media:nested-media:dialogue", "film:media:nested-media:identity",
		"film:media:nested-media:style", "film:media:nested-media:reference",
	} {
		if len(references[key]) == 0 {
			t.Fatalf("nested reference %s was omitted", key)
		}
	}
	manifest := filmCleanupInventory(document, document.ProjectID)
	if len(manifest.Items) != 4 {
		t.Fatalf("nested cleanup inventory = %#v", manifest.Items)
	}
}

func TestFilmQualityStopsWhenOneObjectExceedsRemainingBudget(t *testing.T) {
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	objects := &oversizedQualityBlobStore{}
	server.setBlobObjectStore(objects)
	document := newFilmDocument("quality-budget")
	document.Episodes = []filmEpisode{{ID: "episode", Revision: 1, Title: "Episode", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{ID: "scene", Revision: 1, EpisodeID: "episode", Heading: "INT. ROOM", Status: filmStatusDraft}}
	document.Shots = []filmShot{{ID: "shot", Revision: 1, SceneID: "scene", Title: "Shot", Description: "Action", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9", ImageStorageKey: "media:oversized"}}

	_, err := server.validateFilmDocumentWithMedia(t.Context(), "tenant", document)
	if !errors.Is(err, errFilmQualityMedia) || objects.gets != 1 {
		t.Fatalf("quality budget err=%v gets=%d", err, objects.gets)
	}
}

func TestFilmQualityChecksFormalDirectorSceneMedia(t *testing.T) {
	server := NewServer(t.TempDir())
	t.Cleanup(server.Close)
	document := newFilmDocument("quality-director")
	document.Episodes = []filmEpisode{{ID: "episode", Revision: 1, Title: "Episode", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{
		ID: "scene", Revision: 1, EpisodeID: "episode", Heading: "INT. ROOM", Status: filmStatusDraft,
		DirectorSource: &filmDirectorSource{StorageKey: "film:media:quality-director:missing-director", SHA256: strings.Repeat("a", 64), ObjectVersion: "missing-v1"},
	}}
	document.Shots = []filmShot{{ID: "shot", Revision: 1, SceneID: "scene", Title: "Shot", Description: "Action", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}}

	report, err := server.validateFilmDocumentWithMedia(t.Context(), "tenant", document)
	if err != nil {
		t.Fatal(err)
	}
	for _, issue := range report.Issues {
		if issue.Code == "media_corrupt" && issue.TargetType == "scene" && issue.TargetID == "scene" {
			return
		}
	}
	t.Fatalf("missing Director scene media issue: %#v", report.Issues)
}

func TestFilmQualityUsesFFprobeForRealVideoDurationAndAspect(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_FFMPEG_PATH", executable)
	t.Setenv("OPENBOARD_FFPROBE_PATH", executable)
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	server.filmCommandRunner = &countingFilmCommandRunner{}
	server.filmProbeRunner = &fakeFilmProbeRunner{result: []byte(`{"streams":[{"codec_type":"video","width":720,"height":1280,"duration":"9","bit_rate":"1000","nb_frames":"120"}],"format":{"duration":"9","bit_rate":"1000"}}`)}
	video := []byte("bounded-video")
	key := "film:media:quality-probe:video"
	if err := server.storeTenantBlobConditional(t.Context(), "tenant", "", key, "video/mp4", video, blobVersionAbsent); err != nil {
		t.Fatal(err)
	}
	document := newFilmDocument("quality-probe")
	document.Episodes = []filmEpisode{{ID: "episode", Revision: 1, Title: "Episode", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{ID: "scene", Revision: 1, EpisodeID: "episode", Heading: "INT. ROOM", Status: filmStatusDraft}}
	document.Shots = []filmShot{{ID: "shot", Revision: 1, SceneID: "scene", Title: "Shot", Description: "Action", Status: filmStatusDraft, DurationSeconds: 4, AspectRatio: "16:9", VideoStorageKey: key, VideoSHA256: sha256Hex(video)}}
	report, err := server.validateFilmDocumentWithMedia(t.Context(), "tenant", document)
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"media_duration_mismatch": false, "media_aspect_mismatch": false}
	for _, issue := range report.Issues {
		if _, ok := wanted[issue.Code]; ok {
			wanted[issue.Code] = true
		}
	}
	if !wanted["media_duration_mismatch"] || !wanted["media_aspect_mismatch"] {
		t.Fatalf("FFprobe mismatches not reported: %#v", report.Issues)
	}
}
