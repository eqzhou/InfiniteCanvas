package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

func snapshotFilmStructure(document filmDocument, id, candidateID, now string) filmStructureVersion {
	copy := cloneFilmDocument(document)
	return filmStructureVersion{
		ID: id, Revision: 1, CandidateID: candidateID, Story: copy.Story,
		Episodes: copy.Episodes, Scenes: copy.Scenes, Shots: copy.Shots,
		Dialogues: copy.Dialogues, Assets: copy.Assets, CreatedAt: now,
	}
}

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
	next.StructureVersions = append(next.StructureVersions, snapshotFilmStructure(document, stableFilmID("structure", document.ProjectID, candidate.ID, document.Revision), candidate.ID, now))
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
	episodeIDs := make(map[string]string, len(candidate.Decomposition.Episodes))
	scenes := make([]filmScene, 0)
	shots := make([]filmShot, 0)
	dialogues := make([]filmDialogue, 0)
	for episodeOrder, sourceEpisode := range candidate.Decomposition.Episodes {
		episodeID := stableFilmID("episode", document.ProjectID, candidate.ID, sourceEpisode.Key)
		episodeIDs[sourceEpisode.Key] = episodeID
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
						CharacterAssetID: characterID, Emotion: sourceDialogue.Emotion, Text: sourceDialogue.Text, Status: filmStatusDraft,
					})
				}
			}
		}
	}
	relationships := make([]filmStoryRelationship, 0, len(candidate.Decomposition.Relationships))
	for _, relationship := range candidate.Decomposition.Relationships {
		relationships = append(relationships, filmStoryRelationship{CharacterAssetID: characterIDs[relationship.FromCharacterKey], RelatedCharacterAssetID: characterIDs[relationship.ToCharacterKey], Relation: relationship.Relation, Description: relationship.Description})
	}
	beats := make([]filmStoryBeat, 0, len(candidate.Decomposition.Beats))
	for order, beat := range candidate.Decomposition.Beats {
		beats = append(beats, filmStoryBeat{ID: stableFilmID("beat", document.ProjectID, candidate.ID, beat.Key), EpisodeID: episodeIDs[beat.EpisodeKey], Order: order, Title: beat.Title, Description: beat.Description})
	}
	arcs := make([]filmCharacterArc, 0, len(candidate.Decomposition.CharacterArcs))
	for _, arc := range candidate.Decomposition.CharacterArcs {
		arcs = append(arcs, filmCharacterArc{CharacterAssetID: characterIDs[arc.CharacterKey], Summary: arc.Summary})
	}
	next.Story = filmStoryBible{Summary: candidate.Decomposition.Summary, Theme: candidate.Decomposition.Theme, Timeline: append([]string(nil), candidate.Decomposition.Timeline...), Relationships: relationships, Beats: beats, CharacterArcs: arcs}
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

func restoreFilmStructureVersion(document filmDocument, versionID string, expectedRevision int, now string) (filmDocument, error) {
	if !validProjectID(versionID) || expectedRevision != document.Revision || !validFilmTimestamp(now) {
		return filmDocument{}, errors.New("film structure restore revision conflict")
	}
	var selected *filmStructureVersion
	for index := range document.StructureVersions {
		if document.StructureVersions[index].ID == versionID {
			copy := document.StructureVersions[index]
			selected = &copy
			break
		}
	}
	if selected == nil {
		return filmDocument{}, errors.New("film structure version not found")
	}
	next := cloneFilmDocument(document)
	for _, task := range document.Tasks {
		if task.Status == filmStatusRunning {
			return filmDocument{}, errors.New("film structure cannot be restored while generation tasks are active")
		}
	}
	current := snapshotFilmStructure(document, stableFilmID("structure", document.ProjectID, "restore", document.Revision), stableFilmID("restore-candidate", selected.ID), now)
	if len(next.StructureVersions) >= 100 {
		return filmDocument{}, errors.New("film structure version retention limit reached")
	}
	next.StructureVersions = append(next.StructureVersions, current)
	next.Story = selected.Story
	next.Episodes = append([]filmEpisode(nil), selected.Episodes...)
	next.Scenes = append([]filmScene(nil), selected.Scenes...)
	next.Shots = append([]filmShot(nil), selected.Shots...)
	next.Dialogues = append([]filmDialogue(nil), selected.Dialogues...)
	next.Assets = append([]filmAsset(nil), selected.Assets...)
	next.Tasks = nil
	next.AICandidates = nil
	next.ScriptCandidates = nil
	next.QualityReports = nil
	next.Deliverables = nil
	next.Adoptions = nil
	next.Versions = nil
	next.Timeline = defaultFilmTimeline()
	next.ProjectionRevision++
	next = invalidateFilmStages(next, "decompose", now)
	next.Revision++
	next.UpdatedAt = now
	if err := validateFilmAggregate(next, next.ProjectID); err != nil {
		return filmDocument{}, err
	}
	return next, nil
}

func (s *Server) restoreFilmStructureVersionHandler(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		return restoreFilmStructureVersion(document, chi.URLParam(r, "versionId"), input.Revision, time.Now().UTC().Format(time.RFC3339Nano))
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
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
