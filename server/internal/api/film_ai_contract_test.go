package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const validFilmAIDecompositionJSON = `{
  "summary":"A courier discovers a hidden signal.",
  "theme":"trust",
  "characters":[{"key":"courier","name":"Lin","description":"A careful courier"}],
  "locations":[{"key":"station","name":"Old station","description":"An abandoned terminal"}],
  "timeline":["night one"],
  "relationships":[{"fromCharacterKey":"courier","toCharacterKey":"courier","relation":"inner conflict","description":"Lin doubts her own instincts."}],
  "beats":[{"key":"signal-found","episodeKey":"episode-1","title":"Signal found","description":"Lin locates the transmitter."}],
  "characterArcs":[{"characterKey":"courier","summary":"Lin learns to trust her instincts."}],
  "episodes":[{
    "key":"episode-1","title":"The signal","synopsis":"Lin follows the signal.",
    "scenes":[{
      "key":"scene-1","heading":"INT. OLD STATION - NIGHT","synopsis":"Lin enters.",
      "locationKey":"station",
      "shots":[{
        "key":"shot-1","title":"Arrival","description":"Lin steps into the hall.",
        "durationSeconds":4,
        "dialogues":[{"kind":"dialogue","characterKey":"courier","emotion":"guarded curiosity","text":"Is anyone here?"}]
      }]
    }]
  }]
}`

const validFilmAIScriptJSON = `{
  "summary":"Lin follows the signal into the station.",
  "scenes":[{
    "key":"scene-1","heading":"INT. OLD STATION - NIGHT","synopsis":"Lin enters the terminal.",
    "shots":[{
      "key":"shot-1","title":"Arrival","description":"Lin crosses the empty hall.","durationSeconds":4,
      "dialogues":[{"kind":"dialogue","speaker":"Lin","emotion":"guarded curiosity","text":"Is anyone here?"}]
    }]
  }]
}`

func TestParseFilmAIDecompositionAcceptsStrictNestedContract(t *testing.T) {
	candidate, err := parseFilmAIDecompositionCandidate([]byte(validFilmAIDecompositionJSON))
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Summary == "" || len(candidate.Characters) != 1 || len(candidate.Episodes) != 1 ||
		len(candidate.Episodes[0].Scenes) != 1 || len(candidate.Episodes[0].Scenes[0].Shots) != 1 ||
		len(candidate.Relationships) != 1 || len(candidate.Beats) != 1 || len(candidate.CharacterArcs) != 1 {
		t.Fatalf("candidate was not decoded completely: %#v", candidate)
	}
}

func TestParseFilmAIScriptAcceptsStrictEpisodeContract(t *testing.T) {
	script, err := parseFilmAIScriptCandidate([]byte(validFilmAIScriptJSON))
	if err != nil {
		t.Fatal(err)
	}
	if script.Summary == "" || len(script.Scenes) != 1 || len(script.Scenes[0].Shots) != 1 ||
		len(script.Scenes[0].Shots[0].Dialogues) != 1 || script.Scenes[0].Shots[0].Dialogues[0].Emotion != "guarded curiosity" {
		t.Fatalf("script candidate was not decoded completely: %#v", script)
	}
}

func TestParseFilmAIScriptRejectsForgedAndAmbiguousStructure(t *testing.T) {
	for name, value := range map[string]string{
		"database id":       strings.Replace(validFilmAIScriptJSON, `"summary":`, `"episodeId":"episode-forged","summary":`, 1),
		"duplicate key":     strings.Replace(validFilmAIScriptJSON, `"shots":[{`, `"shots":[{"key":"shot-1","title":"Duplicate","description":"x","durationSeconds":1,"dialogues":[]},{`, 1),
		"invalid duration":  strings.Replace(validFilmAIScriptJSON, `"durationSeconds":4`, `"durationSeconds":0`, 1),
		"oversized emotion": strings.Replace(validFilmAIScriptJSON, `"guarded curiosity"`, `"`+strings.Repeat("x", 501)+`"`, 1),
		"markdown":          "```json\n" + validFilmAIScriptJSON + "\n```",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseFilmAIScriptCandidate([]byte(value)); err == nil {
				t.Fatal("unsafe script candidate was accepted")
			}
		})
	}
}

func filmTextCandidateFixture(t *testing.T) (filmDocument, store.GenerationJob) {
	t.Helper()
	document, err := decomposeFilmSource(newFilmDocument("film-ai"), "INT. OLD ROOM - DAY\nOriginal structure.")
	if err != nil {
		t.Fatal(err)
	}
	document.Source.Revision = 1
	document.Source.Text = "INT. OLD ROOM - DAY\nOriginal structure."
	now := time.Now().UTC().Format(time.RFC3339Nano)
	sourceSHA := filmSourceSHA256(document.Source)
	requestHash := strings.Repeat("a", 64)
	document.Tasks = append(document.Tasks, filmTask{
		ID: "task-ai", Revision: 1, Stage: "decompose", Title: "AI story decomposition",
		Status: filmStatusRunning, CreatedAt: now, UpdatedAt: now,
		GenerationJobID: "job-ai", IdempotencyKey: "candidate-pass", RequestHash: requestHash,
		TextSnapshot: &filmTextGenerationSnapshot{
			SourceRevision: document.Source.Revision, SourceSHA256: sourceSHA, ProviderID: "provider-text",
			Model: "gpt-text", PromptVersion: filmDecomposePromptVersion, OutputSchema: filmDecomposeOutputSchema,
			EstimatedGenerations: 1, CreatedAt: now,
		},
	})
	parameters, err := json.Marshal(persistedTextJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash, Operation: "film_decompose",
		PromptVersion: filmDecomposePromptVersion, OutputSchema: filmDecomposeOutputSchema,
		SourceRevision: document.Source.Revision, SourceSHA256: sourceSHA, FilmRevision: document.Revision,
		Film: &filmGenerationBinding{ProjectID: document.ProjectID, Stage: "decompose", TaskID: "task-ai", RequestHash: requestHash},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(providerTextResult{Text: validFilmAIDecompositionJSON})
	if err != nil {
		t.Fatal(err)
	}
	return document, store.GenerationJob{
		ID: "job-ai", ProjectID: document.ProjectID, Kind: "text", Status: "succeeded",
		ProviderID: "provider-text", Model: "gpt-text", Parameters: parameters, Result: result,
	}
}

func TestIntegrateFilmTextResultCreatesReviewCandidateWithoutOverwritingFacts(t *testing.T) {
	document, job := filmTextCandidateFixture(t)
	episodes, scenes, shots := document.Episodes, document.Scenes, document.Shots
	next, err := integrateFilmTextJobResult(document, job, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Episodes, episodes) || !reflect.DeepEqual(next.Scenes, scenes) || !reflect.DeepEqual(next.Shots, shots) {
		t.Fatal("AI candidate overwrote approved production facts before review")
	}
	if len(next.AICandidates) != 1 || next.AICandidates[0].Status != filmAICandidateReady ||
		next.AICandidates[0].TaskID != "task-ai" || next.Tasks[len(next.Tasks)-1].Status != filmStatusNeedsReview ||
		next.Stages[0].Status != filmStatusNeedsReview {
		t.Fatalf("candidate review state = %#v task=%#v stage=%#v", next.AICandidates, next.Tasks[len(next.Tasks)-1], next.Stages[0])
	}
}

func TestIntegrateFilmTextResultMarksChangedSourceAsStale(t *testing.T) {
	document, job := filmTextCandidateFixture(t)
	document.Source.Revision++
	document.Source.Text = "A newer manuscript"
	next, err := integrateFilmTextJobResult(document, job, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	if len(next.AICandidates) != 1 || next.AICandidates[0].Status != filmAICandidateStale ||
		next.Tasks[len(next.Tasks)-1].Status != filmStatusFailed || next.Stages[0].Status != filmStatusDraft {
		t.Fatalf("stale candidate was not isolated: %#v", next)
	}
}

func TestSyncFilmTextJobCandidatePersistsReviewState(t *testing.T) {
	document, job := filmTextCandidateFixture(t)
	backend := newFilmMemoryStore()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backend.CreateFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, raw); err != nil {
		t.Fatal(err)
	}
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.syncFilmTextJobCandidate(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := decodeFilmDocument(record.Document)
	if err != nil || len(stored.AICandidates) != 1 || stored.AICandidates[0].Status != filmAICandidateReady ||
		stored.Tasks[len(stored.Tasks)-1].Status != filmStatusNeedsReview {
		t.Fatalf("persisted candidate = %#v err=%v", stored, err)
	}
	if err := server.syncFilmTextJobCandidate(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	record, _ = backend.GetFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID)
	stored, _ = decodeFilmDocument(record.Document)
	if len(stored.AICandidates) != 1 {
		t.Fatalf("worker retry duplicated candidate: %#v", stored.AICandidates)
	}
}

func TestApplyFilmAICandidateVersionsOldStructureAndGeneratesServerIDs(t *testing.T) {
	document, job := filmTextCandidateFixture(t)
	ready, err := integrateFilmTextJobResult(document, job, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	candidate := ready.AICandidates[0]
	oldEpisodes := append([]filmEpisode(nil), ready.Episodes...)
	applied, err := applyFilmAICandidate(ready, candidate.ID, candidate.Revision, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.StructureVersions) != 1 || !reflect.DeepEqual(applied.StructureVersions[0].Episodes, oldEpisodes) {
		t.Fatalf("old story structure was not versioned: %#v", applied.StructureVersions)
	}
	if len(applied.Episodes) != 1 || applied.Episodes[0].Title != "The signal" || applied.Episodes[0].ID == "episode-1" ||
		len(applied.Scenes) != 1 || applied.Scenes[0].EpisodeID != applied.Episodes[0].ID || applied.Scenes[0].ID == "scene-1" ||
		len(applied.Shots) != 1 || applied.Shots[0].SceneID != applied.Scenes[0].ID || applied.Shots[0].ID == "shot-1" ||
		len(applied.Dialogues) != 1 || applied.Dialogues[0].ShotID != applied.Shots[0].ID || applied.Dialogues[0].Emotion != "guarded curiosity" {
		t.Fatalf("candidate was not converted to server-owned facts: %#v", applied)
	}
	if len(applied.Story.Relationships) != 1 || len(applied.Story.Beats) != 1 || len(applied.Story.CharacterArcs) != 1 ||
		applied.Story.Relationships[0].CharacterAssetID == "" || applied.Story.Beats[0].EpisodeID != applied.Episodes[0].ID {
		t.Fatalf("story graph was not converted to server-owned references: %#v", applied.Story)
	}
	if applied.AICandidates[0].Status != filmAICandidateApplied || applied.AICandidates[0].AppliedAt == "" ||
		applied.Stages[0].Status != filmStatusNeedsReview {
		t.Fatalf("candidate apply state = %#v stage=%#v", applied.AICandidates[0], applied.Stages[0])
	}
	if _, err := applyFilmAICandidate(applied, candidate.ID, candidate.Revision, time.Now().UTC().Format(time.RFC3339Nano)); err == nil {
		t.Fatal("stale candidate revision was applied twice")
	}
}

func TestRestoreFilmStructureVersionIsReversibleAndRevisionChecked(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	document := newFilmDocument("film-structure-restore")
	document.Revision = 7
	document.Story = filmStoryBible{Summary: "current"}
	document.Episodes = []filmEpisode{{ID: "episode-current", Revision: 1, Order: 0, Title: "Current", Status: filmStatusDraft}}
	document.Tasks = []filmTask{{ID: "task-old", Revision: 1, Stage: "storyboard", ShotID: "shot-current", Title: "Old task", Status: filmStatusFailed, CreatedAt: now, UpdatedAt: now}}
	document.QualityReports = []filmQualityReport{{ID: "quality-old", Revision: 1, CreatedAt: now}}
	document.Deliverables = []filmDeliverable{{ID: "delivery-old"}}
	document.StructureVersions = []filmStructureVersion{{
		ID: "structure-old", Revision: 1, CandidateID: "candidate-old", Story: filmStoryBible{Summary: "old"},
		Episodes: []filmEpisode{{ID: "episode-old", Revision: 1, Order: 0, Title: "Old", Status: filmStatusDraft}}, CreatedAt: now,
	}}
	restored, err := restoreFilmStructureVersion(document, "structure-old", document.Revision, now)
	if err != nil || restored.Story.Summary != "old" || restored.Episodes[0].ID != "episode-old" || len(restored.StructureVersions) != 2 {
		t.Fatalf("structure restore = %#v err=%v", restored, err)
	}
	if restored.StructureVersions[1].Story.Summary != "current" || restored.StructureVersions[1].Episodes[0].ID != "episode-current" {
		t.Fatalf("restore did not archive the displaced structure: %#v", restored.StructureVersions[1])
	}
	if len(restored.Tasks) != 0 || len(restored.QualityReports) != 0 || len(restored.Deliverables) != 0 || restored.Timeline.Revision != 1 {
		t.Fatalf("restore retained derived state: tasks=%#v quality=%#v deliverables=%#v timeline=%#v", restored.Tasks, restored.QualityReports, restored.Deliverables, restored.Timeline)
	}
	active := cloneFilmDocument(document)
	active.Tasks[0].Status = filmStatusRunning
	if _, err := restoreFilmStructureVersion(active, "structure-old", active.Revision, now); err == nil {
		t.Fatal("structure restore was accepted while a generation task was active")
	}
	if _, err := restoreFilmStructureVersion(document, "structure-old", document.Revision-1, now); err == nil {
		t.Fatal("stale structure restore was accepted")
	}
}

func TestIntegrateAndApplyFilmAIScriptCandidateUsesFrozenEpisode(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("film-script"), "EPISODE 1\nINT. OLD STATION - NIGHT\nOriginal action.\nEPISODE 2\nEXT. ROAD - DAY\nOther episode.")
	if err != nil {
		t.Fatal(err)
	}
	document.Stages[0].Status = filmStatusApproved
	target := document.Episodes[0]
	_, targetRevision, targetSHA, err := filmScriptTargetSnapshot(document, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	requestHash := strings.Repeat("c", 64)
	document.Tasks = append(document.Tasks, filmTask{
		ID: "task-script", Revision: 1, Stage: "script", Title: "AI episode script", Status: filmStatusRunning,
		CreatedAt: now, UpdatedAt: now, GenerationJobID: "job-script", RequestHash: requestHash,
		TextSnapshot: &filmTextGenerationSnapshot{
			SourceRevision: document.Source.Revision, SourceSHA256: filmSourceSHA256(document.Source), ProviderID: "provider-text",
			Model: "gpt-text", PromptVersion: filmScriptPromptVersion, OutputSchema: filmScriptOutputSchema,
			TargetEntityID: target.ID, TargetRevision: targetRevision, TargetSHA256: targetSHA, EstimatedGenerations: 1, CreatedAt: now,
		},
	})
	parameters, _ := json.Marshal(persistedTextJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash, Operation: "film_script",
		PromptVersion: filmScriptPromptVersion, OutputSchema: filmScriptOutputSchema,
		SourceRevision: document.Source.Revision, SourceSHA256: filmSourceSHA256(document.Source), FilmRevision: document.Revision,
		TargetEntityID: target.ID, TargetRevision: targetRevision, TargetSHA256: targetSHA,
		Film: &filmGenerationBinding{ProjectID: document.ProjectID, Stage: "script", TaskID: "task-script", RequestHash: requestHash},
	})
	result, _ := json.Marshal(providerTextResult{Text: validFilmAIScriptJSON})
	job := store.GenerationJob{ID: "job-script", ProjectID: document.ProjectID, Kind: "text", Status: "succeeded", ProviderID: "provider-text", Model: "gpt-text", Parameters: parameters, Result: result}

	ready, err := integrateFilmTextJobResult(document, job, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(ready.ScriptCandidates) != 1 || ready.ScriptCandidates[0].Status != filmAICandidateReady || len(ready.Episodes) != 2 {
		t.Fatalf("script candidate overwrote facts before review: %#v", ready)
	}
	candidate := ready.ScriptCandidates[0]
	applied, err := applyFilmAIScriptCandidate(ready, candidate.ID, candidate.Revision, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Episodes) != 2 || applied.Episodes[1].ID != document.Episodes[1].ID ||
		applied.Episodes[0].Synopsis != candidate.Script.Summary || applied.ScriptCandidates[0].Status != filmAICandidateApplied {
		t.Fatalf("script candidate was not applied to only its frozen episode: %#v", applied)
	}
}

func TestFilmAIScriptCandidateBecomesStaleWhenTargetChanges(t *testing.T) {
	document, job := filmTextCandidateFixture(t)
	document.Tasks[len(document.Tasks)-1].Stage = "script"
	document.Tasks[len(document.Tasks)-1].TextSnapshot = &filmTextGenerationSnapshot{
		SourceRevision: 1, SourceSHA256: strings.Repeat("a", 64), ProviderID: "provider-text", Model: "gpt-text",
		PromptVersion: filmScriptPromptVersion, OutputSchema: filmScriptOutputSchema, TargetEntityID: "missing",
		TargetRevision: 1, TargetSHA256: strings.Repeat("b", 64), EstimatedGenerations: 1,
		CreatedAt: document.Tasks[len(document.Tasks)-1].CreatedAt,
	}
	job.Parameters = json.RawMessage(`{"executor":"server","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"film_script","promptVersion":"film-script-v2","outputSchema":"film-script-v2","sourceRevision":1,"sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","filmRevision":1,"targetEntityId":"missing","targetRevision":1,"targetSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","film":{"projectId":"film-ai","stage":"script","taskId":"task-ai","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`)
	job.Result, _ = json.Marshal(providerTextResult{Text: validFilmAIScriptJSON})
	stale, err := integrateFilmTextJobResult(document, job, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil || len(stale.ScriptCandidates) != 1 || stale.ScriptCandidates[0].Status != filmAICandidateStale ||
		stale.Tasks[len(stale.Tasks)-1].Status != filmStatusFailed {
		t.Fatalf("script result with unavailable frozen target was not isolated as stale: %#v err=%v", stale, err)
	}
}

func TestParseFilmAIDecompositionRejectsUntrustedStructure(t *testing.T) {
	tests := map[string]string{
		"unknown database field": strings.Replace(validFilmAIDecompositionJSON, `"summary":`, `"storageKey":"film:forged","summary":`, 1),
		"duplicate json field":   strings.Replace(validFilmAIDecompositionJSON, `"summary":`, `"summary":"shadow","summary":`, 1),
		"trailing json":          validFilmAIDecompositionJSON + `{}`,
		"duplicate shot key": strings.Replace(validFilmAIDecompositionJSON,
			`"shots":[{`, `"shots":[{"key":"shot-1","title":"Duplicate","description":"x","durationSeconds":1,"dialogues":[]},{`, 1),
		"dangling character": strings.Replace(validFilmAIDecompositionJSON, `"characterKey":"courier"`, `"characterKey":"missing"`, 1),
		"unsafe duration":    strings.Replace(validFilmAIDecompositionJSON, `"durationSeconds":4`, `"durationSeconds":-1`, 1),
		"markdown wrapper":   "```json\n" + validFilmAIDecompositionJSON + "\n```",
	}
	for name, value := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := parseFilmAIDecompositionCandidate([]byte(value)); err == nil {
				t.Fatal("unsafe AI decomposition was accepted")
			}
		})
	}
}

func TestParseFilmAIDecompositionEnforcesEntityLimit(t *testing.T) {
	shots := strings.Repeat(`{"key":"shot-x","title":"x","description":"x","durationSeconds":1,"dialogues":[]},`, maxFilmEntities+1)
	value := `{"summary":"x","theme":"x","characters":[],"locations":[],"timeline":[],"episodes":[{"key":"ep","title":"x","synopsis":"x","scenes":[{"key":"scene","heading":"x","synopsis":"x","locationKey":"","shots":[` + strings.TrimSuffix(shots, ",") + `]}]}]}`
	if _, err := parseFilmAIDecompositionCandidate([]byte(value)); err == nil {
		t.Fatal("oversized AI decomposition was accepted")
	}
}
