package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

func applyFilmAICandidate(document filmDocument, candidateID string, expectedRevision int, now string) (filmDocument, error) {
	if !validProjectID(candidateID) || expectedRevision < 1 || !validFilmTimestamp(now) {
		return filmDocument{}, errors.New("AI candidate apply request is invalid")
	}
	candidateIndex := -1
	var candidate filmAICandidate
	for index, current := range document.AICandidates {
		if current.ID == candidateID {
			candidateIndex, candidate = index, current
			break
		}
	}
	if candidateIndex < 0 {
		return filmDocument{}, errors.New("AI candidate not found")
	}
	if candidate.Revision != expectedRevision {
		return filmDocument{}, errors.New("AI candidate revision conflict")
	}
	if candidate.Status != filmAICandidateReady || candidate.SourceRevision != document.Source.Revision ||
		candidate.SourceSHA256 != filmSourceSHA256(document.Source) {
		return filmDocument{}, errors.New("AI candidate is not current and review-ready")
	}
	if err := validateFilmAIDecomposition(candidate.Decomposition); err != nil {
		return filmDocument{}, err
	}
	next := cloneFilmDocument(document)
	next.StructureVersions = append(next.StructureVersions, filmStructureVersion{
		ID: stableFilmID("structure", document.ProjectID, candidate.ID, document.Revision), Revision: 1,
		CandidateID: candidate.ID, Episodes: append([]filmEpisode(nil), document.Episodes...),
		Scenes: append([]filmScene(nil), document.Scenes...), Shots: append([]filmShot(nil), document.Shots...),
		Dialogues: append([]filmDialogue(nil), document.Dialogues...), Assets: append([]filmAsset(nil), document.Assets...),
		CreatedAt: now,
	})
	if len(next.StructureVersions) > 100 {
		return filmDocument{}, errors.New("film structure version retention limit reached")
	}

	characterIDs := make(map[string]string, len(candidate.Decomposition.Characters))
	assets := make([]filmAsset, 0, len(candidate.Decomposition.Characters)+len(candidate.Decomposition.Locations)+len(document.Assets))
	for _, asset := range document.Assets {
		if asset.Kind != "character" && asset.Kind != "identity" && asset.Kind != "location" {
			assets = append(assets, asset)
		}
	}
	for _, character := range candidate.Decomposition.Characters {
		id := stableFilmID("asset", document.ProjectID, candidate.ID, "character", character.Key)
		characterIDs[character.Key] = id
		assets = append(assets, filmAsset{ID: id, Revision: 1, Kind: "character", Title: character.Name, Description: character.Description, Status: filmStatusDraft})
	}
	for _, location := range candidate.Decomposition.Locations {
		assets = append(assets, filmAsset{
			ID:       stableFilmID("asset", document.ProjectID, candidate.ID, "location", location.Key),
			Revision: 1, Kind: "location", Title: location.Name, Description: location.Description, Status: filmStatusDraft,
		})
	}

	episodes := make([]filmEpisode, 0, len(candidate.Decomposition.Episodes))
	scenes := make([]filmScene, 0)
	shots := make([]filmShot, 0)
	dialogues := make([]filmDialogue, 0)
	for episodeOrder, sourceEpisode := range candidate.Decomposition.Episodes {
		episodeID := stableFilmID("episode", document.ProjectID, candidate.ID, sourceEpisode.Key)
		episodes = append(episodes, filmEpisode{
			ID: episodeID, Revision: 1, Order: episodeOrder, Title: sourceEpisode.Title,
			Synopsis: sourceEpisode.Synopsis, Status: filmStatusDraft,
		})
		for sceneOrder, sourceScene := range sourceEpisode.Scenes {
			sceneID := stableFilmID("scene", episodeID, sourceScene.Key)
			scenes = append(scenes, filmScene{
				ID: sceneID, Revision: 1, EpisodeID: episodeID, Order: sceneOrder,
				Heading: sourceScene.Heading, Synopsis: sourceScene.Synopsis, Status: filmStatusDraft,
			})
			for shotOrder, sourceShot := range sourceScene.Shots {
				shotID := stableFilmID("shot", sceneID, sourceShot.Key)
				shots = append(shots, filmShot{
					ID: shotID, Revision: 1, SceneID: sceneID, Order: shotOrder, Title: sourceShot.Title,
					Description: sourceShot.Description, Status: filmStatusDraft, DurationSeconds: sourceShot.DurationSeconds,
					AspectRatio: document.AspectRatio, IdentityVersionIDs: []string{},
				})
				for dialogueOrder, sourceDialogue := range sourceShot.Dialogues {
					characterID := ""
					if sourceDialogue.CharacterKey != "" {
						characterID = characterIDs[sourceDialogue.CharacterKey]
						if characterID == "" {
							return filmDocument{}, fmt.Errorf("AI dialogue character %s is unavailable", sourceDialogue.CharacterKey)
						}
					}
					dialogues = append(dialogues, filmDialogue{
						ID: stableFilmID("dialogue", shotID, dialogueOrder, sourceDialogue.Text), Revision: 1,
						ShotID: shotID, Order: dialogueOrder, Kind: sourceDialogue.Kind,
						CharacterAssetID: characterID, Text: sourceDialogue.Text, Status: filmStatusDraft,
					})
				}
			}
		}
	}
	next.Episodes, next.Scenes, next.Shots, next.Dialogues, next.Assets = episodes, scenes, shots, dialogues, assets
	updatedCandidate := next.AICandidates[candidateIndex]
	updatedCandidate.Revision++
	updatedCandidate.Status = filmAICandidateApplied
	updatedCandidate.AppliedAt = now
	next.AICandidates[candidateIndex] = updatedCandidate
	next = invalidateFilmStages(next, "script", now)
	next.Revision++
	next.UpdatedAt = now
	if _, _, _, _, err := validateFilmEntities(next); err != nil {
		return filmDocument{}, err
	}
	if err := validateFilmAggregateLimits(next); err != nil {
		return filmDocument{}, err
	}
	return next, nil
}

func (s *Server) applyFilmAICandidateHandler(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		return applyFilmAICandidate(
			document, chi.URLParam(r, "candidateId"), input.Revision,
			time.Now().UTC().Format(time.RFC3339Nano),
		)
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
