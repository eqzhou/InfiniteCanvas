package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"unicode/utf8"
)

const maxFilmAICandidateBytes = 4 << 20

type filmAICharacter struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type filmAILocation struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type filmAIDialogue struct {
	Kind         string `json:"kind"`
	CharacterKey string `json:"characterKey"`
	Text         string `json:"text"`
}

type filmAIShot struct {
	Key             string           `json:"key"`
	Title           string           `json:"title"`
	Description     string           `json:"description"`
	DurationSeconds float64          `json:"durationSeconds"`
	Dialogues       []filmAIDialogue `json:"dialogues"`
}

type filmAIScene struct {
	Key         string       `json:"key"`
	Heading     string       `json:"heading"`
	Synopsis    string       `json:"synopsis"`
	LocationKey string       `json:"locationKey"`
	Shots       []filmAIShot `json:"shots"`
}

type filmAIEpisode struct {
	Key      string        `json:"key"`
	Title    string        `json:"title"`
	Synopsis string        `json:"synopsis"`
	Scenes   []filmAIScene `json:"scenes"`
}

type filmAIDecomposition struct {
	Summary    string            `json:"summary"`
	Theme      string            `json:"theme"`
	Characters []filmAICharacter `json:"characters"`
	Locations  []filmAILocation  `json:"locations"`
	Timeline   []string          `json:"timeline"`
	Episodes   []filmAIEpisode   `json:"episodes"`
}

func validFilmAIKey(value string) bool {
	return projectIDPattern.MatchString(value) && len(value) <= 100
}

func validFilmAIString(value string, maxRunes int, required bool) bool {
	if required && strings.TrimSpace(value) == "" {
		return false
	}
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= maxRunes
}

func addFilmAIKey(seen map[string]struct{}, kind, key string) error {
	if !validFilmAIKey(key) {
		return fmt.Errorf("%s key is invalid", kind)
	}
	compound := kind + "\x00" + key
	if _, exists := seen[compound]; exists {
		return fmt.Errorf("%s key is duplicated", kind)
	}
	seen[compound] = struct{}{}
	return nil
}

func validateFilmAIDecomposition(candidate filmAIDecomposition) error {
	if !validFilmAIString(candidate.Summary, 4_000, true) || !validFilmAIString(candidate.Theme, 1_000, false) ||
		candidate.Characters == nil || candidate.Locations == nil || candidate.Timeline == nil || len(candidate.Episodes) == 0 {
		return errors.New("AI decomposition summary or collections are invalid")
	}
	seen := make(map[string]struct{})
	characters := make(map[string]struct{}, len(candidate.Characters))
	locations := make(map[string]struct{}, len(candidate.Locations))
	entities := 0
	for _, character := range candidate.Characters {
		entities++
		if err := addFilmAIKey(seen, "character", character.Key); err != nil {
			return err
		}
		if !validFilmAIString(character.Name, 500, true) || !validFilmAIString(character.Description, 4_000, false) {
			return errors.New("AI character is invalid")
		}
		characters[character.Key] = struct{}{}
	}
	for _, location := range candidate.Locations {
		entities++
		if err := addFilmAIKey(seen, "location", location.Key); err != nil {
			return err
		}
		if !validFilmAIString(location.Name, 500, true) || !validFilmAIString(location.Description, 4_000, false) {
			return errors.New("AI location is invalid")
		}
		locations[location.Key] = struct{}{}
	}
	if len(candidate.Timeline) > maxFilmEntities {
		return errors.New("AI timeline exceeds limits")
	}
	for _, event := range candidate.Timeline {
		if !validFilmAIString(event, 2_000, true) {
			return errors.New("AI timeline event is invalid")
		}
	}
	for _, episode := range candidate.Episodes {
		entities++
		if err := addFilmAIKey(seen, "episode", episode.Key); err != nil {
			return err
		}
		if !validFilmAIString(episode.Title, 500, true) || !validFilmAIString(episode.Synopsis, 4_000, false) || len(episode.Scenes) == 0 {
			return errors.New("AI episode is invalid")
		}
		for _, scene := range episode.Scenes {
			entities++
			if err := addFilmAIKey(seen, "scene", scene.Key); err != nil {
				return err
			}
			if !validFilmAIString(scene.Heading, 500, true) || !validFilmAIString(scene.Synopsis, 4_000, false) || len(scene.Shots) == 0 {
				return errors.New("AI scene is invalid")
			}
			if scene.LocationKey != "" {
				if _, exists := locations[scene.LocationKey]; !exists {
					return errors.New("AI scene references an unavailable location")
				}
			}
			for _, shot := range scene.Shots {
				entities++
				if entities > maxFilmEntities {
					return errors.New("AI decomposition exceeds entity limits")
				}
				if err := addFilmAIKey(seen, "shot", shot.Key); err != nil {
					return err
				}
				if !validFilmAIString(shot.Title, 500, true) || !validFilmAIString(shot.Description, 4_000, true) ||
					math.IsNaN(shot.DurationSeconds) || math.IsInf(shot.DurationSeconds, 0) || shot.DurationSeconds < 1.0/120 || shot.DurationSeconds > 900 || shot.Dialogues == nil {
					return errors.New("AI shot is invalid")
				}
				for _, dialogue := range shot.Dialogues {
					entities++
					if entities > maxFilmEntities || (dialogue.Kind != "dialogue" && dialogue.Kind != "narration") || !validFilmAIString(dialogue.Text, 10_000, true) {
						return errors.New("AI dialogue is invalid")
					}
					if dialogue.Kind == "dialogue" {
						if _, exists := characters[dialogue.CharacterKey]; !exists {
							return errors.New("AI dialogue references an unavailable character")
						}
					} else if dialogue.CharacterKey != "" {
						return errors.New("AI narration cannot reference a character")
					}
				}
			}
		}
	}
	if entities > maxFilmEntities {
		return errors.New("AI decomposition exceeds entity limits")
	}
	return nil
}

func parseFilmAIDecompositionCandidate(value []byte) (filmAIDecomposition, error) {
	if len(value) == 0 || len(value) > maxFilmAICandidateBytes {
		return filmAIDecomposition{}, errors.New("AI decomposition response exceeds limits")
	}
	if err := rejectFilmAIDuplicateJSONFields(value); err != nil {
		return filmAIDecomposition{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	var candidate filmAIDecomposition
	if err := decoder.Decode(&candidate); err != nil {
		return filmAIDecomposition{}, errors.New("AI decomposition response is not valid strict JSON")
	}
	if err := ensureFilmAIJSONEOF(decoder); err != nil {
		return filmAIDecomposition{}, err
	}
	if err := validateFilmAIDecomposition(candidate); err != nil {
		return filmAIDecomposition{}, err
	}
	return candidate, nil
}

func rejectFilmAIDuplicateJSONFields(value []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				nameToken, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := nameToken.(string)
				if !ok {
					return errors.New("AI decomposition object key is invalid")
				}
				if _, exists := seen[name]; exists {
					return errors.New("AI decomposition response contains duplicate fields")
				}
				seen[name] = struct{}{}
				if err := visit(); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := visit(); err != nil {
					return err
				}
			}
		default:
			return errors.New("AI decomposition JSON is invalid")
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		closingDelimiter, ok := closing.(json.Delim)
		if !ok || delimiter == '{' && closingDelimiter != '}' || delimiter == '[' && closingDelimiter != ']' {
			return errors.New("AI decomposition JSON is invalid")
		}
		return nil
	}
	if err := visit(); err != nil {
		return errors.New("AI decomposition response is not valid strict JSON")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("AI decomposition response contains trailing content")
	}
	return nil
}

func ensureFilmAIJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("AI decomposition response contains trailing content")
	}
	return nil
}
