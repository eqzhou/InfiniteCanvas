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
  "episodes":[{
    "key":"episode-1","title":"The signal","synopsis":"Lin follows the signal.",
    "scenes":[{
      "key":"scene-1","heading":"INT. OLD STATION - NIGHT","synopsis":"Lin enters.",
      "locationKey":"station",
      "shots":[{
        "key":"shot-1","title":"Arrival","description":"Lin steps into the hall.",
        "durationSeconds":4,
        "dialogues":[{"kind":"dialogue","characterKey":"courier","text":"Is anyone here?"}]
      }]
    }]
  }]
}`

func TestParseFilmAIDecompositionAcceptsStrictNestedContract(t *testing.T) {
	candidate, err := parseFilmAIDecompositionCandidate([]byte(validFilmAIDecompositionJSON))
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Summary == "" || len(candidate.Characters) != 1 || len(candidate.Episodes) != 1 ||
		len(candidate.Episodes[0].Scenes) != 1 || len(candidate.Episodes[0].Scenes[0].Shots) != 1 {
		t.Fatalf("candidate was not decoded completely: %#v", candidate)
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
		len(applied.Dialogues) != 1 || applied.Dialogues[0].ShotID != applied.Shots[0].ID {
		t.Fatalf("candidate was not converted to server-owned facts: %#v", applied)
	}
	if applied.AICandidates[0].Status != filmAICandidateApplied || applied.AICandidates[0].AppliedAt == "" ||
		applied.Stages[0].Status != filmStatusNeedsReview {
		t.Fatalf("candidate apply state = %#v stage=%#v", applied.AICandidates[0], applied.Stages[0])
	}
	if _, err := applyFilmAICandidate(applied, candidate.ID, candidate.Revision, time.Now().UTC().Format(time.RFC3339Nano)); err == nil {
		t.Fatal("stale candidate revision was applied twice")
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
