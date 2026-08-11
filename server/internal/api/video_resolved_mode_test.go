package api

import (
	"strings"
	"testing"
)

func TestResolveVideoGenerationMode(t *testing.T) {
	tests := []struct {
		name       string
		frameMode  string
		references int
		elements   int
		want       string
		wantError  bool
	}{
		{name: "text", frameMode: "references", want: "text_to_video"},
		{name: "single reference", frameMode: "references", references: 1, want: "reference_to_video"},
		{name: "elements are references", frameMode: "references", elements: 1, want: "reference_to_video"},
		{name: "first frame", frameMode: "first-last", references: 1, want: "first_frame_to_video"},
		{name: "first and last frame", frameMode: "first-last", references: 2, want: "first_last_frame_to_video"},
		{name: "missing first frame", frameMode: "first-last", wantError: true},
		{name: "too many ordered frames", frameMode: "first-last", references: 3, wantError: true},
		{name: "elements cannot become ordered frames", frameMode: "first-last", references: 1, elements: 1, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveVideoGenerationMode(test.frameMode, test.references, test.elements)
			if (err != nil) != test.wantError || got != test.want {
				t.Fatalf("resolve = %q err=%v, want %q error=%v", got, err, test.want, test.wantError)
			}
		})
	}
}

func TestResolvedVideoModeMapsToStableCapabilityMode(t *testing.T) {
	for resolved, want := range map[string]string{
		"text_to_video":             "text_to_video",
		"first_frame_to_video":      "image_to_video",
		"first_last_frame_to_video": "image_to_video",
		"reference_to_video":        "image_to_video",
	} {
		if got := videoCapabilityMode(resolved); got != want {
			t.Fatalf("capability mode for %s = %s, want %s", resolved, got, want)
		}
	}
	if got := videoCapabilityMode("unknown"); got != "" {
		t.Fatalf("unknown resolved mode must fail closed, got %s", got)
	}
}

func TestValidateFrozenVideoModeRejectsInputDrift(t *testing.T) {
	if got, err := validateFrozenVideoMode("first_frame_to_video", "first-last", 1, 0); err != nil || got != "first_frame_to_video" {
		t.Fatalf("matching frozen mode rejected: got=%q err=%v", got, err)
	}
	if _, err := validateFrozenVideoMode("text_to_video", "references", 1, 0); err == nil {
		t.Fatal("a frozen text mode must not be reinterpreted after a reference is added")
	}
	if got, err := validateFrozenVideoMode("", "references", 1, 0); err != nil || got != "reference_to_video" {
		t.Fatalf("legacy jobs should resolve once without drift: got=%q err=%v", got, err)
	}
}

func TestResolveFilmVideoConfigPreservesFrameIntent(t *testing.T) {
	firstOnly, mode, err := resolveFilmVideoConfig(
		filmShot{FirstFrameStorageKey: "image:first"},
		filmGenerationConfig{},
	)
	if err != nil || mode != "first_frame_to_video" || firstOnly.FrameMode != "first-last" || len(firstOnly.ReferenceStorageKeys) != 1 {
		t.Fatalf("first-frame config = %#v mode=%q err=%v", firstOnly, mode, err)
	}

	firstLast, mode, err := resolveFilmVideoConfig(
		filmShot{FirstFrameStorageKey: "image:first", LastFrameStorageKey: "image:last"},
		filmGenerationConfig{},
	)
	if err != nil || mode != "first_last_frame_to_video" || firstLast.FrameMode != "first-last" || len(firstLast.ReferenceStorageKeys) != 2 {
		t.Fatalf("first-last config = %#v mode=%q err=%v", firstLast, mode, err)
	}

	references, mode, err := resolveFilmVideoConfig(
		filmShot{FirstFrameStorageKey: "image:first"},
		filmGenerationConfig{ReferenceStorageKeys: []string{"image:style"}},
	)
	if err != nil || mode != "reference_to_video" || references.FrameMode != "references" || len(references.ReferenceStorageKeys) != 2 {
		t.Fatalf("reference config = %#v mode=%q err=%v", references, mode, err)
	}
}

func TestFilmTaskValidationRejectsResolvedModeDrift(t *testing.T) {
	now := "2026-08-11T00:00:00Z"
	task := filmTask{
		ID: "task-video", Revision: 1, Stage: "video", ShotID: "shot-1", Title: "Video",
		Status: filmStatusRunning, CreatedAt: now, UpdatedAt: now,
		GenerationJobID: "job-video", IdempotencyKey: "video-mode", RequestHash: strings.Repeat("a", 64),
		Snapshot: &filmGenerationSnapshot{
			ShotRevision: 1, Prompt: "Prompt", ProviderID: "provider", Model: "model",
			Config:           filmGenerationConfig{FrameMode: "first-last", ReferenceStorageKeys: []string{"image:first"}},
			IdentityVersions: []filmAsset{}, ReferenceStorageKeys: []string{"image:first"},
			EstimatedGenerations: 1, CreatedAt: now, ResolvedMode: "first_frame_to_video",
		},
	}
	if err := validateFilmTasks([]filmTask{task}); err != nil {
		t.Fatalf("matching mode rejected: %v", err)
	}
	task.Snapshot.ResolvedMode = "text_to_video"
	if err := validateFilmTasks([]filmTask{task}); err == nil {
		t.Fatal("film snapshot mode drift must be rejected")
	}
}
