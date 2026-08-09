package api

import (
	"reflect"
	"strings"
	"testing"
)

func TestDecomposeFilmSourceIsDeterministic(t *testing.T) {
	document := newFilmDocument("project-film")
	source := "EPISODE 1 — Arrival\nINT. OBSERVATORY - NIGHT\nMira opens the dome. The telescope turns.\n\nEXT. HILL ROAD - DAWN\nA courier stops at the gate."

	first, err := decomposeFilmSource(document, source)
	if err != nil {
		t.Fatal(err)
	}
	second, err := decomposeFilmSource(document, source)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("deterministic fallback returned different documents")
	}
	if len(first.Episodes) != 1 || len(first.Scenes) != 2 || len(first.Shots) < 2 {
		t.Fatalf("unexpected decomposition: episodes=%d scenes=%d shots=%d", len(first.Episodes), len(first.Scenes), len(first.Shots))
	}
	for _, shot := range first.Shots {
		if shot.Status != filmStatusDraft || shot.Revision != 1 {
			t.Fatalf("generated shot was not a revision-one draft: %#v", shot)
		}
	}
}

func TestFilmValidationCreatesNonDestructiveRepairs(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-quality"), "INT. EDIT SUITE - DAY\nA blank monitor flickers.")
	if err != nil {
		t.Fatal(err)
	}
	before := cloneFilmDocument(document)
	report, err := validateFilmDocument(document)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(document, before) {
		t.Fatal("quality validation mutated the film document")
	}
	if len(report.Issues) == 0 || len(report.Repairs) == 0 {
		t.Fatalf("expected issues and repairs, got %#v", report)
	}
	for _, repair := range report.Repairs {
		if repair.Approved {
			t.Fatal("repair was approved without a user decision")
		}
	}
}

func TestFilmReadOnlyCheckDoesNotPersistOrApproveProposals(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-check"), "INT. ROOM - DAY\nA light flickers.")
	if err != nil {
		t.Fatal(err)
	}
	report, err := checkFilmDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.QualityReports) != 0 || len(report.Repairs) == 0 {
		t.Fatalf("read-only check mutated document or omitted proposals: %#v", document.QualityReports)
	}
	for _, proposal := range report.Repairs {
		if proposal.Approved || proposal.AppliedAt != "" {
			t.Fatalf("proposal self-approved: %#v", proposal)
		}
	}
}

func TestApplyFilmRepairRequiresApprovalAndRevision(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-repair"), "INT. SOUNDSTAGE - DAY\nAn actor crosses the empty set.")
	if err != nil {
		t.Fatal(err)
	}
	report, err := validateFilmDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	document.QualityReports = []filmQualityReport{report}
	repairID := report.Repairs[0].ID

	if _, err := applyFilmRepair(document, repairID); err == nil {
		t.Fatal("unapproved repair was applied")
	}
	document.QualityReports[0].Repairs[0].Approved = true
	repaired, err := applyFilmRepair(document, repairID)
	if err != nil {
		t.Fatal(err)
	}
	if len(repaired.Versions) != 1 || repaired.Versions[0].EntityID != document.Shots[0].ID || repaired.Versions[0].Revision != document.Shots[0].Revision {
		t.Fatalf("repair did not preserve the previous entity version: %#v", repaired.Versions)
	}
	if _, err := applyFilmRepair(repaired, repairID); err == nil {
		t.Fatal("stale repair revision was accepted")
	}
}

func TestFilmStageRunRequiresRealArtifactsAndCreatesReviewPreparation(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-stage"), "INT. SET - DAY\nA performer crosses the set.")
	if err != nil {
		t.Fatal(err)
	}
	now := "2026-08-08T00:00:00Z"

	next, err := updateFilmStage(document, "decompose", "approve", document.Stages[0].Revision, now)
	if err != nil {
		t.Fatal(err)
	}
	next, err = updateFilmStage(next, "script", "run", next.Stages[1].Revision, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Tasks) != 1 || next.Tasks[0].Progress != 0 || next.Tasks[0].Title != "Prepare script review" {
		t.Fatalf("stage run claimed generation progress: %#v", next.Tasks)
	}
	next, err = updateFilmStage(next, "script", "approve", next.Stages[1].Revision, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := updateFilmStage(next, "storyboard", "run", next.Stages[2].Revision, now); err == nil || !strings.Contains(err.Error(), "image media") {
		t.Fatalf("storyboard without images returned %v", err)
	}
}

func TestFilmInputChangesInvalidateAffectedAndDownstreamStages(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-invalidate"), "INT. SET - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	for index := range document.Stages {
		document.Stages[index].Status = filmStatusApproved
	}

	invalidated := invalidateFilmStages(document, "storyboard", "2026-08-08T00:00:00Z")
	for _, stage := range invalidated.Stages {
		shouldRemainApproved := stage.ID == "decompose" || stage.ID == "script"
		if shouldRemainApproved && stage.Status != filmStatusApproved {
			t.Fatalf("upstream stage %s was invalidated", stage.ID)
		}
		if !shouldRemainApproved && stage.Status != filmStatusDraft {
			t.Fatalf("stage %s was not invalidated: %s", stage.ID, stage.Status)
		}
	}
}

func TestFilmStageReadinessChecksEveryRequiredArtifact(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("project-readiness"), "INT. SET - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		stage string
		text  string
	}{
		{"storyboard", "image media"},
		{"audio", "audio media"},
		{"video", "video media"},
		{"compose", "persisted timeline"},
		{"delivery", "real deliverable"},
	}
	for _, check := range checks {
		if err := validateFilmStageReadiness(document, check.stage); err == nil || !strings.Contains(err.Error(), check.text) {
			t.Fatalf("%s readiness returned %v", check.stage, err)
		}
	}

	document.Shots[0].ImageStorageKey = "image:shot"
	document.Shots[0].AudioStorageKey = "media:audio"
	document.Shots[0].VideoStorageKey = "media:video"
	document.Timeline.Revision = 2
	document.Deliverables = []filmDeliverable{{Kind: "manifest", Status: filmStatusApproved, Bytes: 2, Content: "{}"}}
	for _, stage := range []string{"storyboard", "audio", "video", "compose", "delivery"} {
		if err := validateFilmStageReadiness(document, stage); err != nil {
			t.Fatalf("ready %s rejected: %v", stage, err)
		}
	}
}

func TestFilmAggregateLimitsIncludeDecompositionEntities(t *testing.T) {
	document := newFilmDocument("project-limit")
	document.Episodes = make([]filmEpisode, maxFilmEntities)
	document.Scenes = []filmScene{{ID: "overflow"}}
	if err := validateFilmAggregateLimits(document); err == nil {
		t.Fatal("aggregate entity limit was not enforced")
	}
}

func TestFilmDecompositionEnforcesCountersBeforeAppending(t *testing.T) {
	tests := []struct {
		name   string
		source string
		limits filmDecompositionLimits
		want   string
	}{
		{"episodes", "EPISODE 1\nOne.\nEPISODE 2\nTwo.", filmDecompositionLimits{Episodes: 1, Scenes: 10, Shots: 10, Entities: 20}, "episode"},
		{"scenes", "INT. ONE - DAY\nOne.\nINT. TWO - DAY\nTwo.", filmDecompositionLimits{Episodes: 10, Scenes: 1, Shots: 10, Entities: 20}, "scene"},
		{"shots", "INT. ONE - DAY\nOne. Two.", filmDecompositionLimits{Episodes: 10, Scenes: 10, Shots: 1, Entities: 20}, "shot"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := decomposeFilmSourceWithLimits(newFilmDocument("project-boundary"), test.source, test.limits)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected bounded %s error, got %v", test.want, err)
			}
		})
	}
}

func TestFilmQualityValidationAbortsAtIssueAndRepairCaps(t *testing.T) {
	document := newFilmDocument("project-quality-cap")
	document.Scenes = make([]filmScene, maxFilmQualityIssues)
	for index := range document.Scenes {
		document.Scenes[index] = filmScene{ID: stableFilmID("scene", index), Revision: 1}
	}
	report, err := validateFilmDocument(document)
	if err != nil || len(report.Issues) != maxFilmQualityIssues {
		t.Fatalf("exact issue boundary rejected: issues=%d err=%v", len(report.Issues), err)
	}

	document.Scenes = make([]filmScene, maxFilmQualityIssues+1)
	for index := range document.Scenes {
		document.Scenes[index] = filmScene{ID: stableFilmID("scene", index), Revision: 1}
	}
	if _, err := validateFilmDocument(document); err == nil || !strings.Contains(err.Error(), "issue limit") {
		t.Fatalf("expected issue cap, got %v", err)
	}

	document = newFilmDocument("project-repair-boundary")
	document.Shots = make([]filmShot, maxFilmRepairProposals)
	for index := range document.Shots {
		document.Shots[index] = filmShot{
			ID: stableFilmID("shot", index), Revision: 1, SceneID: "scene", DurationSeconds: 4,
			AspectRatio: "4:3", Description: "Action", IdentityVersionIDs: []string{},
			ImageStorageKey: "image:ready", AudioStorageKey: "audio:ready", Subtitle: "subtitle",
		}
	}
	report, err = validateFilmDocument(document)
	if err != nil || len(report.Repairs) != maxFilmRepairProposals {
		t.Fatalf("exact repair boundary rejected: repairs=%d err=%v", len(report.Repairs), err)
	}

	document = newFilmDocument("project-repair-cap")
	document.Shots = make([]filmShot, maxFilmRepairProposals+1)
	for index := range document.Shots {
		document.Shots[index] = filmShot{
			ID: stableFilmID("shot", index), Revision: 1, SceneID: "scene", DurationSeconds: 4,
			AspectRatio: "4:3", Description: "Action", IdentityVersionIDs: []string{},
			ImageStorageKey: "image:ready", AudioStorageKey: "audio:ready", Subtitle: "subtitle",
		}
	}
	if _, err := validateFilmDocument(document); err == nil || !strings.Contains(err.Error(), "repair limit") {
		t.Fatalf("expected repair cap, got %v", err)
	}
}

func TestBuildFFmpegArgumentsUsesValidatedArgumentsWithoutShell(t *testing.T) {
	timeline := defaultFilmTimeline()
	timeline.Tracks[0].Clips = []filmTimelineClip{{
		ID: "clip-1", Source: "/private/input.mp4", Start: 0, End: 5,
		TrimIn: 1, TrimOut: 0, Volume: 0.8, FadeIn: 0.25, FadeOut: 0.5,
		Transition: "cut", Revision: 1,
	}}
	args, err := buildFilmFFmpegArguments(timeline, "/private/output.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if len(args) == 0 || args[len(args)-1] != "/private/output.mp4" {
		t.Fatalf("unexpected ffmpeg args: %#v", args)
	}
	for _, arg := range args {
		if arg == "sh" || arg == "-c" || arg == ";" {
			t.Fatalf("shell token leaked into ffmpeg arguments: %#v", args)
		}
	}
	timeline.Tracks[0].Clips[0].Source = "https://example.com/input.mp4;touch /tmp/pwned"
	if _, err := buildFilmFFmpegArguments(timeline, "/private/output.mp4"); err == nil {
		t.Fatal("unsafe clip source was accepted")
	}
}

func TestBuildFFmpegArgumentsPreservesVideoGapsAndRejectsOverlap(t *testing.T) {
	timeline := defaultFilmTimeline()
	timeline.Tracks[0].Clips = []filmTimelineClip{
		{ID: "clip-a", Source: "/private/a.mp4", Start: 2, End: 4, Transition: "cut", Revision: 1},
		{ID: "clip-b", Source: "/private/b.mp4", Start: 5, End: 7, Transition: "cut", Revision: 1, Order: 1},
	}
	args, err := buildFilmFFmpegArguments(timeline, "/private/output.mp4")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "color=c=black") || !strings.Contains(joined, "setpts=PTS-STARTPTS+2.000/TB") || !strings.Contains(joined, "d=7.000") {
		t.Fatalf("video gap lost from filter graph: %s", joined)
	}
	timeline.Tracks[0].Clips[1].Start = 3.5
	if _, err := buildFilmFFmpegArguments(timeline, "/private/output.mp4"); err == nil {
		t.Fatal("overlapping video clips were silently accepted")
	}
}

func TestFilmTimelineRejectsExcessivePixelFrameBudget(t *testing.T) {
	timeline := defaultFilmTimeline()
	timeline.Width, timeline.Height, timeline.FrameRate = 3840, 2160, 60
	timeline.Tracks[0].Clips = []filmTimelineClip{{ID: "expensive", Source: "/private/a.mp4", Start: 0, End: 3600, Transition: "cut", Revision: 1}}
	if err := validateFilmTimeline(timeline); err == nil {
		t.Fatal("excessive pixel-frame render budget was accepted")
	}
}
