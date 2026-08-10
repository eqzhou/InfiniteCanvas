package api

import (
	"strings"
	"testing"
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

func TestParseFilmAIDecompositionRejectsUntrustedStructure(t *testing.T) {
	tests := map[string]string{
		"unknown database field": strings.Replace(validFilmAIDecompositionJSON, `"summary":`, `"storageKey":"film:forged","summary":`, 1),
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
