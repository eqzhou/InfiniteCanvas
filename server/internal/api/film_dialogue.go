package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type filmDialogueInput struct {
	Revision         *int    `json:"revision,omitempty"`
	ShotID           *string `json:"shotId,omitempty"`
	Order            *int    `json:"order,omitempty"`
	Kind             *string `json:"kind,omitempty"`
	CharacterAssetID *string `json:"characterAssetId,omitempty"`
	VoiceAssetID     *string `json:"voiceAssetId,omitempty"`
	Emotion          *string `json:"emotion,omitempty"`
	Text             *string `json:"text,omitempty"`
}

func applyFilmDialogueInput(dialogue filmDialogue, input filmDialogueInput, create bool) (filmDialogue, error) {
	var err error
	if create || input.ShotID != nil {
		dialogue.ShotID, err = cleanFilmText(input.ShotID, "shotId", 128, true)
	}
	if err == nil && (create || input.Kind != nil) {
		dialogue.Kind, err = cleanFilmText(input.Kind, "kind", 32, true)
	}
	if dialogue.Kind != "dialogue" && dialogue.Kind != "narration" {
		return filmDialogue{}, errors.New("dialogue kind is unsupported")
	}
	if err == nil && (create || input.Text != nil) {
		dialogue.Text, err = cleanFilmText(input.Text, "text", 20_000, true)
	}
	if err == nil && input.Emotion != nil {
		dialogue.Emotion, err = cleanFilmText(input.Emotion, "emotion", 500, false)
	}
	if err != nil {
		return filmDialogue{}, err
	}
	if input.Order != nil {
		dialogue.Order, err = filmOrder(input.Order)
	}
	for _, field := range []struct {
		source *string
		target *string
		name   string
	}{
		{input.CharacterAssetID, &dialogue.CharacterAssetID, "characterAssetId"},
		{input.VoiceAssetID, &dialogue.VoiceAssetID, "voiceAssetId"},
	} {
		if field.source != nil {
			*field.target, err = cleanFilmText(field.source, field.name, 128, false)
			if err != nil {
				return filmDialogue{}, err
			}
		}
	}
	return dialogue, nil
}

func validateFilmDialogueRelations(document filmDocument, dialogue filmDialogue) error {
	shotFound := false
	for _, shot := range document.Shots {
		if shot.ID == dialogue.ShotID {
			shotFound = true
			break
		}
	}
	if !shotFound {
		return errors.New("dialogue shot does not exist")
	}
	for id, kind := range map[string]string{dialogue.CharacterAssetID: "character", dialogue.VoiceAssetID: "voice"} {
		if id == "" {
			continue
		}
		found := false
		for _, asset := range document.Assets {
			if asset.ID == id && asset.Kind == kind {
				found = true
				break
			}
		}
		if !found {
			return errors.New("dialogue asset binding is invalid")
		}
	}
	return nil
}

func (s *Server) createFilmDialogue(w http.ResponseWriter, r *http.Request) {
	var input filmDialogueInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if len(document.Dialogues) >= maxFilmEntities {
			return filmDocument{}, errors.New("dialogue limit reached")
		}
		dialogue, err := applyFilmDialogueInput(filmDialogue{Revision: 1, Status: filmStatusDraft}, input, true)
		if err != nil {
			return filmDocument{}, err
		}
		if err := validateFilmDialogueRelations(document, dialogue); err != nil {
			return filmDocument{}, err
		}
		dialogue.ID = stableFilmID("dialogue", document.ProjectID, document.Revision, dialogue.ShotID, dialogue.Order, dialogue.Text)
		document.Dialogues = append(document.Dialogues, dialogue)
		return invalidateFilmStages(document, "audio", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusCreated, record, document)
	}
}

func (s *Server) updateFilmDialogue(w http.ResponseWriter, r *http.Request) {
	var input filmDialogueInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil || input.Revision == nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "revision and a valid request body are required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		for index, dialogue := range document.Dialogues {
			if dialogue.ID != chi.URLParam(r, "entityId") {
				continue
			}
			if dialogue.Revision != *input.Revision {
				return filmDocument{}, errors.New("dialogue revision conflict")
			}
			updated, err := applyFilmDialogueInput(dialogue, input, false)
			if err != nil {
				return filmDocument{}, err
			}
			if err := validateFilmDialogueRelations(document, updated); err != nil {
				return filmDocument{}, err
			}
			updated.Revision++
			document.Dialogues[index] = updated
			return invalidateFilmStages(document, "audio", document.UpdatedAt), nil
		}
		return filmDocument{}, errors.New("dialogue not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func (s *Server) deleteFilmDialogue(w http.ResponseWriter, r *http.Request) {
	revision := filmOptionalRevision(r)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		next := make([]filmDialogue, 0, len(document.Dialogues))
		found := false
		for _, dialogue := range document.Dialogues {
			if dialogue.ID == chi.URLParam(r, "entityId") {
				if dialogue.Revision != revision {
					return filmDocument{}, errors.New("dialogue revision conflict")
				}
				found = true
				continue
			}
			next = append(next, dialogue)
		}
		if !found {
			return filmDocument{}, errors.New("dialogue not found")
		}
		document.Dialogues = next
		return invalidateFilmStages(document, "audio", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
