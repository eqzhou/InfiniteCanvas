package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
)

type filmEpisodeInput struct {
	Revision *int    `json:"revision,omitempty"`
	Order    *int    `json:"order,omitempty"`
	Title    *string `json:"title,omitempty"`
	Synopsis *string `json:"synopsis,omitempty"`
}

type filmSceneInput struct {
	Revision  *int    `json:"revision,omitempty"`
	EpisodeID *string `json:"episodeId,omitempty"`
	Order     *int    `json:"order,omitempty"`
	Heading   *string `json:"heading,omitempty"`
	Synopsis  *string `json:"synopsis,omitempty"`
}

type filmShotInput struct {
	Revision           *int      `json:"revision,omitempty"`
	SceneID            *string   `json:"sceneId,omitempty"`
	Order              *int      `json:"order,omitempty"`
	Title              *string   `json:"title,omitempty"`
	Description        *string   `json:"description,omitempty"`
	DurationSeconds    *float64  `json:"durationSeconds,omitempty"`
	AspectRatio        *string   `json:"aspectRatio,omitempty"`
	IdentityVersionIDs *[]string `json:"identityVersionIds,omitempty"`
	StyleAssetID       *string   `json:"styleAssetId,omitempty"`
	ImageStorageKey    *string   `json:"imageStorageKey,omitempty"`
	VideoStorageKey    *string   `json:"videoStorageKey,omitempty"`
	AudioStorageKey    *string   `json:"audioStorageKey,omitempty"`
	Subtitle           *string   `json:"subtitle,omitempty"`
	MediaMIMEType      *string   `json:"mediaMimeType,omitempty"`
}

type filmAssetInput struct {
	Revision        *int    `json:"revision,omitempty"`
	Kind            *string `json:"kind,omitempty"`
	Title           *string `json:"title,omitempty"`
	Description     *string `json:"description,omitempty"`
	ParentAssetID   *string `json:"parentAssetId,omitempty"`
	MediaStorageKey *string `json:"mediaStorageKey,omitempty"`
	Voice           *string `json:"voice,omitempty"`
	StylePrompt     *string `json:"stylePrompt,omitempty"`
	AspectRatio     *string `json:"aspectRatio,omitempty"`
	AgeStage        *string `json:"ageStage,omitempty"`
	Costume         *string `json:"costume,omitempty"`
	StoryPeriod     *string `json:"storyPeriod,omitempty"`
	IsDefault       *bool   `json:"isDefault,omitempty"`
}

func cleanFilmText(value *string, name string, maximum int, required bool) (string, error) {
	if value == nil {
		if required {
			return "", errors.New(name + " is required")
		}
		return "", nil
	}
	clean := strings.TrimSpace(*value)
	if len(clean) > maximum || (required && clean == "") {
		return "", errors.New(name + " is invalid")
	}
	return clean, nil
}

func filmOrder(value *int) (int, error) {
	if value == nil {
		return 0, nil
	}
	if *value < 0 || *value > maxFilmEntities {
		return 0, errors.New("order is outside supported limits")
	}
	return *value, nil
}

func (s *Server) createFilmEpisode(w http.ResponseWriter, r *http.Request) {
	var input filmEpisodeInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	title, err := cleanFilmText(input.Title, "title", 500, true)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	synopsis, err := cleanFilmText(input.Synopsis, "synopsis", 20_000, false)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	order, err := filmOrder(input.Order)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if len(document.Episodes) >= maxFilmEntities {
			return filmDocument{}, errors.New("episode limit reached")
		}
		if input.Order == nil {
			order = len(document.Episodes)
		}
		episode := filmEpisode{
			ID: stableFilmID("episode", document.ProjectID, document.Revision, title), Revision: 1,
			Order: order, Title: title, Synopsis: synopsis, Status: filmStatusDraft,
		}
		document.Episodes = append(document.Episodes, episode)
		normalizeFilmOrdering(&document)
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusCreated, record, document)
	}
}

func (s *Server) updateFilmEpisode(w http.ResponseWriter, r *http.Request) {
	var input filmEpisodeInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil || input.Revision == nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "revision and a valid request body are required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		for index, episode := range document.Episodes {
			if episode.ID != id {
				continue
			}
			if episode.Revision != *input.Revision {
				return filmDocument{}, errors.New("episode revision conflict")
			}
			var err error
			if input.Title != nil {
				episode.Title, err = cleanFilmText(input.Title, "title", 500, true)
			}
			if err == nil && input.Synopsis != nil {
				episode.Synopsis, err = cleanFilmText(input.Synopsis, "synopsis", 20_000, false)
			}
			if err == nil && input.Order != nil {
				episode.Order, err = filmOrder(input.Order)
			}
			if err != nil {
				return filmDocument{}, err
			}
			episode.Revision++
			document.Episodes[index] = episode
			normalizeFilmOrdering(&document)
			document.ProjectionRevision++
			return invalidateFilmStages(document, "script", document.UpdatedAt), nil
		}
		return filmDocument{}, errors.New("episode not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func (s *Server) deleteFilmEpisode(w http.ResponseWriter, r *http.Request) {
	revision := filmOptionalRevision(r)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		found := false
		sceneIDs := map[string]struct{}{}
		episodes := make([]filmEpisode, 0, len(document.Episodes))
		for _, episode := range document.Episodes {
			if episode.ID == id {
				if episode.Revision != revision {
					return filmDocument{}, errors.New("episode revision conflict")
				}
				found = true
				continue
			}
			episodes = append(episodes, episode)
		}
		if !found {
			return filmDocument{}, errors.New("episode not found")
		}
		scenes := make([]filmScene, 0, len(document.Scenes))
		for _, scene := range document.Scenes {
			if scene.EpisodeID == id {
				sceneIDs[scene.ID] = struct{}{}
				continue
			}
			scenes = append(scenes, scene)
		}
		shots := make([]filmShot, 0, len(document.Shots))
		for _, shot := range document.Shots {
			if _, remove := sceneIDs[shot.SceneID]; !remove {
				shots = append(shots, shot)
			}
		}
		document.Episodes, document.Scenes, document.Shots = episodes, scenes, shots
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func filmEpisodeExists(document filmDocument, id string) bool {
	for _, episode := range document.Episodes {
		if episode.ID == id {
			return true
		}
	}
	return false
}

func applyFilmSceneInput(scene filmScene, input filmSceneInput, create bool) (filmScene, error) {
	var err error
	if create || input.EpisodeID != nil {
		scene.EpisodeID, err = cleanFilmText(input.EpisodeID, "episodeId", 128, true)
	}
	if err == nil && (create || input.Heading != nil) {
		scene.Heading, err = cleanFilmText(input.Heading, "heading", 500, true)
	}
	if err == nil && input.Synopsis != nil {
		scene.Synopsis, err = cleanFilmText(input.Synopsis, "synopsis", 20_000, false)
	}
	if err == nil && input.Order != nil {
		scene.Order, err = filmOrder(input.Order)
	}
	return scene, err
}

func (s *Server) createFilmScene(w http.ResponseWriter, r *http.Request) {
	var input filmSceneInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		scene, err := applyFilmSceneInput(filmScene{Revision: 1, Status: filmStatusDraft}, input, true)
		if err != nil {
			return filmDocument{}, err
		}
		if !filmEpisodeExists(document, scene.EpisodeID) {
			return filmDocument{}, errors.New("scene episode does not exist")
		}
		if input.Order == nil {
			scene.Order = len(document.Scenes)
		}
		scene.ID = stableFilmID("scene", document.ProjectID, document.Revision, scene.EpisodeID, scene.Heading)
		document.Scenes = append(document.Scenes, scene)
		normalizeFilmOrdering(&document)
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusCreated, record, document)
	}
}

func (s *Server) updateFilmScene(w http.ResponseWriter, r *http.Request) {
	var input filmSceneInput
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil || input.Revision == nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "revision and a valid request body are required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		for index, scene := range document.Scenes {
			if scene.ID != id {
				continue
			}
			if scene.Revision != *input.Revision {
				return filmDocument{}, errors.New("scene revision conflict")
			}
			updated, err := applyFilmSceneInput(scene, input, false)
			if err != nil {
				return filmDocument{}, err
			}
			if !filmEpisodeExists(document, updated.EpisodeID) {
				return filmDocument{}, errors.New("scene episode does not exist")
			}
			updated.Revision++
			document.Scenes[index] = updated
			normalizeFilmOrdering(&document)
			document.ProjectionRevision++
			return invalidateFilmStages(document, "script", document.UpdatedAt), nil
		}
		return filmDocument{}, errors.New("scene not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func (s *Server) deleteFilmScene(w http.ResponseWriter, r *http.Request) {
	revision := filmOptionalRevision(r)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		found := false
		scenes := make([]filmScene, 0, len(document.Scenes))
		for _, scene := range document.Scenes {
			if scene.ID == id {
				if scene.Revision != revision {
					return filmDocument{}, errors.New("scene revision conflict")
				}
				found = true
				continue
			}
			scenes = append(scenes, scene)
		}
		if !found {
			return filmDocument{}, errors.New("scene not found")
		}
		shots := make([]filmShot, 0, len(document.Shots))
		removedShotIDs := map[string]struct{}{}
		for _, shot := range document.Shots {
			if shot.SceneID != id {
				shots = append(shots, shot)
			} else {
				removedShotIDs[shot.ID] = struct{}{}
			}
		}
		document.Scenes, document.Shots = scenes, shots
		document.Dialogues = slices.DeleteFunc(document.Dialogues, func(dialogue filmDialogue) bool { _, removed := removedShotIDs[dialogue.ShotID]; return removed })
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func filmSceneExists(document filmDocument, id string) bool {
	for _, scene := range document.Scenes {
		if scene.ID == id {
			return true
		}
	}
	return false
}

func applyFilmShotInput(shot filmShot, input filmShotInput, create bool) (filmShot, error) {
	if (input.ImageStorageKey != nil && strings.TrimSpace(*input.ImageStorageKey) != "") ||
		(input.VideoStorageKey != nil && strings.TrimSpace(*input.VideoStorageKey) != "") ||
		(input.AudioStorageKey != nil && strings.TrimSpace(*input.AudioStorageKey) != "") {
		return filmShot{}, errors.New("shot media storage keys can only be bound by generation sync")
	}
	var err error
	if create || input.SceneID != nil {
		shot.SceneID, err = cleanFilmText(input.SceneID, "sceneId", 128, true)
	}
	if err == nil && (create || input.Title != nil) {
		shot.Title, err = cleanFilmText(input.Title, "title", 500, true)
	}
	if err == nil && (create || input.Description != nil) {
		shot.Description, err = cleanFilmText(input.Description, "description", 100_000, true)
	}
	if err != nil {
		return filmShot{}, err
	}
	if input.Order != nil {
		shot.Order, err = filmOrder(input.Order)
	}
	if input.DurationSeconds != nil {
		if *input.DurationSeconds <= 0 || *input.DurationSeconds > 900 {
			return filmShot{}, errors.New("durationSeconds is outside supported limits")
		}
		shot.DurationSeconds = *input.DurationSeconds
	}
	if input.AspectRatio != nil {
		shot.AspectRatio, err = cleanFilmText(input.AspectRatio, "aspectRatio", 20, true)
	}
	if input.IdentityVersionIDs != nil {
		if len(*input.IdentityVersionIDs) > 100 {
			return filmShot{}, errors.New("identityVersionIds exceeds its limit")
		}
		shot.IdentityVersionIDs = append([]string(nil), (*input.IdentityVersionIDs)...)
	}
	stringFields := []struct {
		source *string
		target *string
		name   string
		max    int
	}{
		{input.StyleAssetID, &shot.StyleAssetID, "styleAssetId", 128},
		{input.ImageStorageKey, &shot.ImageStorageKey, "imageStorageKey", 512},
		{input.VideoStorageKey, &shot.VideoStorageKey, "videoStorageKey", 512},
		{input.AudioStorageKey, &shot.AudioStorageKey, "audioStorageKey", 512},
		{input.Subtitle, &shot.Subtitle, "subtitle", 20_000},
		{input.MediaMIMEType, &shot.MediaMIMEType, "mediaMimeType", 128},
	}
	for _, field := range stringFields {
		if field.source == nil {
			continue
		}
		*field.target, err = cleanFilmText(field.source, field.name, field.max, false)
		if err != nil {
			return filmShot{}, err
		}
	}
	return shot, nil
}

func (s *Server) createFilmShot(w http.ResponseWriter, r *http.Request) {
	var input filmShotInput
	if err := decodeFilmRequest(w, r, 256<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if len(document.Shots) >= maxFilmEntities {
			return filmDocument{}, errors.New("shot limit reached")
		}
		shot, err := applyFilmShotInput(filmShot{
			Revision: 1, Status: filmStatusDraft, DurationSeconds: 4,
			AspectRatio: document.AspectRatio, IdentityVersionIDs: []string{},
		}, input, true)
		if err != nil {
			return filmDocument{}, err
		}
		if !filmSceneExists(document, shot.SceneID) {
			return filmDocument{}, errors.New("shot scene does not exist")
		}
		shot.ID = stableFilmID("shot", document.ProjectID, document.Revision, shot.SceneID, shot.Title)
		document.Shots = append(document.Shots, shot)
		normalizeFilmOrdering(&document)
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusCreated, record, document)
	}
}

func (s *Server) updateFilmShot(w http.ResponseWriter, r *http.Request) {
	var input filmShotInput
	if err := decodeFilmRequest(w, r, 256<<10, &input); err != nil || input.Revision == nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "revision and a valid request body are required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		for index, shot := range document.Shots {
			if shot.ID != id {
				continue
			}
			if shot.Revision != *input.Revision {
				return filmDocument{}, errors.New("shot revision conflict")
			}
			updated, err := applyFilmShotInput(shot, input, false)
			if err != nil {
				return filmDocument{}, err
			}
			if !filmSceneExists(document, updated.SceneID) {
				return filmDocument{}, errors.New("shot scene does not exist")
			}
			updated.Revision++
			document.Shots[index] = updated
			normalizeFilmOrdering(&document)
			document.ProjectionRevision++
			return invalidateFilmStages(document, "script", document.UpdatedAt), nil
		}
		return filmDocument{}, errors.New("shot not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func (s *Server) deleteFilmShot(w http.ResponseWriter, r *http.Request) {
	revision := filmOptionalRevision(r)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		shots := make([]filmShot, 0, len(document.Shots))
		found := false
		for _, shot := range document.Shots {
			if shot.ID == id {
				if shot.Revision != revision {
					return filmDocument{}, errors.New("shot revision conflict")
				}
				found = true
				continue
			}
			shots = append(shots, shot)
		}
		if !found {
			return filmDocument{}, errors.New("shot not found")
		}
		document.Shots = shots
		document.Dialogues = slices.DeleteFunc(document.Dialogues, func(dialogue filmDialogue) bool { return dialogue.ShotID == id })
		document.ProjectionRevision++
		return invalidateFilmStages(document, "script", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

var filmAssetKinds = map[string]struct{}{
	"character": {}, "identity": {}, "location": {}, "prop": {}, "style": {}, "voice": {},
}

func applyFilmAssetInput(asset filmAsset, input filmAssetInput, create bool) (filmAsset, error) {
	if input.MediaStorageKey != nil && strings.TrimSpace(*input.MediaStorageKey) != "" {
		return filmAsset{}, errors.New("asset media storage keys can only be bound by a verified media sync")
	}
	var err error
	if create || input.Kind != nil {
		asset.Kind, err = cleanFilmText(input.Kind, "kind", 32, true)
		if _, supported := filmAssetKinds[asset.Kind]; !supported {
			return filmAsset{}, errors.New("asset kind is unsupported")
		}
	}
	if err == nil && (create || input.Title != nil) {
		asset.Title, err = cleanFilmText(input.Title, "title", 500, true)
	}
	if err == nil && input.Description != nil {
		asset.Description, err = cleanFilmText(input.Description, "description", 50_000, false)
	}
	if err != nil {
		return filmAsset{}, err
	}
	fields := []struct {
		source *string
		target *string
		name   string
		max    int
	}{
		{input.ParentAssetID, &asset.ParentAssetID, "parentAssetId", 128},
		{input.MediaStorageKey, &asset.MediaStorageKey, "mediaStorageKey", 512},
		{input.Voice, &asset.Voice, "voice", 500},
		{input.StylePrompt, &asset.StylePrompt, "stylePrompt", 20_000},
		{input.AspectRatio, &asset.AspectRatio, "aspectRatio", 20},
		{input.AgeStage, &asset.AgeStage, "ageStage", 200},
		{input.Costume, &asset.Costume, "costume", 1_000},
		{input.StoryPeriod, &asset.StoryPeriod, "storyPeriod", 500},
	}
	for _, field := range fields {
		if field.source == nil {
			continue
		}
		*field.target, err = cleanFilmText(field.source, field.name, field.max, false)
		if err != nil {
			return filmAsset{}, err
		}
	}
	if input.IsDefault != nil {
		asset.IsDefault = *input.IsDefault
	}
	if asset.Kind != "identity" && (asset.AgeStage != "" || asset.Costume != "" || asset.StoryPeriod != "" || asset.IsDefault) {
		return filmAsset{}, errors.New("identity metadata is only valid for identity assets")
	}
	return asset, nil
}

func selectDefaultFilmIdentity(assets []filmAsset, selected filmAsset) []filmAsset {
	if selected.Kind != "identity" || !selected.IsDefault {
		return assets
	}
	next := append([]filmAsset(nil), assets...)
	for index, asset := range next {
		if asset.ID != selected.ID && asset.Kind == "identity" && asset.ParentAssetID == selected.ParentAssetID && asset.IsDefault {
			asset.IsDefault = false
			asset.Revision++
			next[index] = asset
		}
	}
	return next
}

func (s *Server) createFilmAsset(w http.ResponseWriter, r *http.Request) {
	var input filmAssetInput
	if err := decodeFilmRequest(w, r, 256<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if len(document.Assets) >= maxFilmEntities {
			return filmDocument{}, errors.New("asset limit reached")
		}
		asset, err := applyFilmAssetInput(filmAsset{Revision: 1, Status: filmStatusDraft}, input, true)
		if err != nil {
			return filmDocument{}, err
		}
		asset.ID = stableFilmID("asset", document.ProjectID, document.Revision, asset.Kind, asset.Title)
		document.Assets = append(document.Assets, asset)
		document.Assets = selectDefaultFilmIdentity(document.Assets, asset)
		return invalidateFilmStages(document, "storyboard", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusCreated, record, document)
	}
}

func (s *Server) updateFilmAsset(w http.ResponseWriter, r *http.Request) {
	var input filmAssetInput
	if err := decodeFilmRequest(w, r, 256<<10, &input); err != nil || input.Revision == nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "revision and a valid request body are required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		for index, asset := range document.Assets {
			if asset.ID != id {
				continue
			}
			if asset.Revision != *input.Revision {
				return filmDocument{}, errors.New("asset revision conflict")
			}
			updated, err := applyFilmAssetInput(asset, input, false)
			if err != nil {
				return filmDocument{}, err
			}
			updated.Revision++
			document.Assets[index] = updated
			document.Assets = selectDefaultFilmIdentity(document.Assets, updated)
			return invalidateFilmStages(document, "storyboard", document.UpdatedAt), nil
		}
		return filmDocument{}, errors.New("asset not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func (s *Server) deleteFilmAsset(w http.ResponseWriter, r *http.Request) {
	revision := filmOptionalRevision(r)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		id := chi.URLParam(r, "entityId")
		assets := make([]filmAsset, 0, len(document.Assets))
		found := false
		for _, asset := range document.Assets {
			if asset.ID == id {
				if asset.Revision != revision {
					return filmDocument{}, errors.New("asset revision conflict")
				}
				found = true
				continue
			}
			assets = append(assets, asset)
		}
		if !found {
			return filmDocument{}, errors.New("asset not found")
		}
		document.Assets = assets
		return invalidateFilmStages(document, "storyboard", document.UpdatedAt), nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
