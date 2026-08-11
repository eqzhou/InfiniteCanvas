package api

import (
	"encoding/json"
	"testing"
)

func TestRestoreFilmDialogueVersionArchivesCurrentAndInvalidatesAudio(t *testing.T) {
	document := newFilmDocument("film-versions")
	document.Episodes = []filmEpisode{{ID: "episode-one", Revision: 1, Order: 1, Title: "Episode", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{ID: "scene-one", Revision: 1, EpisodeID: "episode-one", Order: 1, Heading: "Scene", Status: filmStatusDraft}}
	document.Shots = []filmShot{{ID: "shot-one", Revision: 1, SceneID: "scene-one", Order: 1, Title: "Shot", Description: "Action", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}}
	document.Dialogues = []filmDialogue{{ID: "dialogue-one", Revision: 2, ShotID: "shot-one", Order: 1, Kind: "dialogue", Text: "current", Status: filmStatusApproved, AudioStorageKey: "audio:current"}}
	prior := filmDialogue{ID: "dialogue-one", Revision: 1, ShotID: "shot-one", Order: 1, Kind: "dialogue", Text: "prior", Status: filmStatusNeedsReview, AudioStorageKey: "audio:prior"}
	snapshot, err := json.Marshal(prior)
	if err != nil {
		t.Fatal(err)
	}
	version := filmEntityVersion{ID: "version-dialogue", EntityType: "dialogue", EntityID: prior.ID, Revision: prior.Revision, Snapshot: snapshot}

	restored, err := restoreFilmDialogueVersion(document, version, 2, "2026-08-11T00:01:00Z")
	if err != nil {
		t.Fatalf("restore dialogue version: %v", err)
	}
	if restored.Dialogues[0].Text != "prior" || restored.Dialogues[0].Revision != 3 || restored.Dialogues[0].Status != filmStatusDraft || restored.Dialogues[0].AudioStorageKey != "audio:prior" {
		t.Fatalf("unexpected restored dialogue: %+v", restored.Dialogues[0])
	}
	if len(restored.Versions) != 1 || restored.Versions[0].EntityType != "dialogue" || restored.Versions[0].Revision != 2 {
		t.Fatalf("current dialogue was not archived: %+v", restored.Versions)
	}
	for _, stage := range restored.Stages {
		if filmStageAffectedBy(stage.ID, "audio") && stage.Status != filmStatusDraft {
			t.Fatalf("stage %s was not invalidated: %+v", stage.ID, stage)
		}
	}
}

func TestRestoreFilmAssetAndTimelineVersions(t *testing.T) {
	document := newFilmDocument("film-more-versions")
	document.Assets = []filmAsset{{ID: "asset-one", Revision: 2, Kind: "identity", Title: "Current", Status: filmStatusApproved, MediaStorageKey: "image:current"}}
	priorAsset := filmAsset{ID: "asset-one", Revision: 1, Kind: "identity", Title: "Prior", Status: filmStatusNeedsReview, MediaStorageKey: "image:prior"}
	assetSnapshot, _ := json.Marshal(priorAsset)
	restored, err := restoreFilmAssetVersion(document, filmEntityVersion{ID: "asset-version", EntityType: "asset", EntityID: "asset-one", Revision: 1, Snapshot: assetSnapshot}, 2, "2026-08-11T00:02:00Z")
	if err != nil || restored.Assets[0].Title != "Prior" || restored.Assets[0].Revision != 3 || restored.Assets[0].Status != filmStatusDraft {
		t.Fatalf("restore asset version: %v %+v", err, restored.Assets)
	}

	currentTimeline := restored.Timeline
	currentTimeline.Revision = 3
	restored.Timeline = currentTimeline
	priorTimeline := currentTimeline
	priorTimeline.Revision = 2
	priorTimeline.Width = 1280
	timelineSnapshot, _ := json.Marshal(priorTimeline)
	restored, err = restoreFilmTimelineVersion(restored, filmEntityVersion{ID: "timeline-version", EntityType: "timeline", EntityID: "timeline", Revision: 2, Snapshot: timelineSnapshot}, 3, "2026-08-11T00:03:00Z")
	if err != nil || restored.Timeline.Width != 1280 || restored.Timeline.Revision != 4 {
		t.Fatalf("restore timeline version: %v %+v", err, restored.Timeline)
	}
}

func TestFilmRestoreReferencesProtectsMediaInsideEveryEntityVersion(t *testing.T) {
	document := newFilmDocument("film-version-media")
	document.Tasks = []filmTask{{ID: "task-one", Snapshot: &filmGenerationSnapshot{LastFrameDirectorSource: &filmDirectorSource{StorageKey: "image:task-last"}}}}
	versions := []struct {
		entityType string
		entityID   string
		revision   int
		value      any
		storageKey string
	}{
		{"shot", "shot-one", 1, filmShot{ID: "shot-one", Revision: 1, LastFrameStorageKey: "image:last"}, "image:last"},
		{"dialogue", "dialogue-one", 1, filmDialogue{ID: "dialogue-one", Revision: 1, AudioStorageKey: "audio:line"}, "audio:line"},
		{"asset", "asset-one", 1, filmAsset{ID: "asset-one", Revision: 1, MediaStorageKey: "image:identity"}, "image:identity"},
		{"timeline", "timeline", 1, filmTimeline{Revision: 1, Width: 1920, Height: 1080, FrameRate: 24, Tracks: []filmTimelineTrack{{ID: "track-video", Revision: 1, Kind: "video", Title: "Video", Clips: []filmTimelineClip{{ID: "clip-old", Revision: 1, Source: "video:old", End: 1, Volume: 1, Transition: "cut"}}}}}, "video:old"},
	}
	for _, item := range versions {
		snapshot, _ := json.Marshal(item.value)
		document.Versions = append(document.Versions, filmEntityVersion{ID: "version-" + item.entityType, EntityType: item.entityType, EntityID: item.entityID, Revision: item.revision, Snapshot: snapshot, Reason: "test", CreatedAt: document.CreatedAt})
	}
	document.Timeline.Tracks = append(document.Timeline.Tracks, filmTimelineTrack{ID: "dialogue-track", Revision: 1, Kind: "dialogue", Title: "Dialogue", Clips: []filmTimelineClip{{ID: "dialogue-clip", Revision: 1, Source: "dialogue:dialogue-one", End: 1, Volume: 1, Transition: "cut"}}})
	references := filmRestoreReferences(document)
	for _, item := range versions {
		if len(references[item.storageKey]) == 0 {
			t.Fatalf("version media %s is not protected: %#v", item.storageKey, references)
		}
	}
	if len(references["dialogue:dialogue-one"]) != 0 {
		t.Fatalf("logical dialogue source must not be restored as media: %#v", references["dialogue:dialogue-one"])
	}
	if len(references["image:task-last"]) == 0 {
		t.Fatalf("frozen last-frame Director source is not protected: %#v", references)
	}
}

func TestDetachedFilmVersionRemainsValidButCannotRestoreBrokenRelations(t *testing.T) {
	document := newFilmDocument("film-invalid-version")
	document.Episodes = []filmEpisode{{ID: "episode-one", Revision: 1, Order: 1, Title: "Episode", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{ID: "scene-one", Revision: 1, EpisodeID: "episode-one", Order: 1, Heading: "Scene", Synopsis: "Synopsis", Status: filmStatusDraft}}
	document.Shots = []filmShot{{ID: "shot-one", Revision: 2, SceneID: "scene-one", Order: 1, Title: "Shot", Description: "Action", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}}
	invalid := document.Shots[0]
	invalid.Revision = 1
	invalid.SceneID = "missing-scene"
	snapshot, _ := json.Marshal(invalid)
	document.Versions = []filmEntityVersion{{
		ID: "version-invalid-shot", EntityType: "shot", EntityID: invalid.ID,
		Revision: invalid.Revision, Snapshot: snapshot, Reason: "test", CreatedAt: document.CreatedAt,
	}}

	if err := validateFilmAggregate(document, document.ProjectID); err != nil {
		t.Fatalf("detached historical snapshot should remain auditable: %v", err)
	}
	if _, err := restoreFilmShotVersion(document, document.Versions[0], 2, "2026-08-11T00:04:00Z"); err == nil {
		t.Fatal("expected restore with a missing current scene to be rejected")
	}
}

func TestValidateFilmAggregateRejectsMalformedEntityVersionSnapshot(t *testing.T) {
	document := newFilmDocument("film-malformed-version")
	malformed := filmShot{ID: "shot-old", Revision: 1, SceneID: "scene-old", Order: 1, Title: "", Description: "Action", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}
	snapshot, _ := json.Marshal(malformed)
	document.Versions = []filmEntityVersion{{ID: "version-malformed", EntityType: "shot", EntityID: malformed.ID, Revision: 1, Snapshot: snapshot, Reason: "test", CreatedAt: document.CreatedAt}}
	if err := validateFilmAggregate(document, document.ProjectID); err == nil {
		t.Fatal("expected malformed historical snapshot to be rejected")
	}
}

func TestValidateFilmAggregateRetainsVersionAfterTargetDeletion(t *testing.T) {
	document := newFilmDocument("film-deleted-version-target")
	deleted := filmScene{ID: "scene-deleted", Revision: 1, EpisodeID: "episode-deleted", Order: 0, Heading: "Deleted scene", Status: filmStatusDraft}
	snapshot, _ := json.Marshal(deleted)
	document.Versions = []filmEntityVersion{{ID: "version-deleted-scene", EntityType: "scene", EntityID: deleted.ID, Revision: deleted.Revision, Snapshot: snapshot, Reason: "delete-history", CreatedAt: document.CreatedAt}}
	if err := validateFilmAggregate(document, document.ProjectID); err != nil {
		t.Fatalf("detached history should survive target deletion: %v", err)
	}
}
