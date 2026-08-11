package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func integrateFilmScriptJobResult(document filmDocument, job store.GenerationJob, parameters persistedTextJobParameters, taskIndex int, text, now string) (filmDocument, error) {
	script, err := parseFilmAIScriptCandidate([]byte(text))
	if err != nil {
		return filmDocument{}, err
	}
	_, targetRevision, targetSHA, targetErr := filmScriptTargetSnapshot(document, parameters.TargetEntityID)
	stale := document.Source.Revision != parameters.SourceRevision || filmSourceSHA256(document.Source) != parameters.SourceSHA256 ||
		targetErr != nil || targetRevision != parameters.TargetRevision || targetSHA != parameters.TargetSHA256
	next := cloneFilmDocument(document)
	status := filmAICandidateReady
	if stale {
		status = filmAICandidateStale
	}
	next.ScriptCandidates = append(next.ScriptCandidates, filmAIScriptCandidate{
		ID: stableFilmID("script-candidate", document.ProjectID, job.ID), Revision: 1, Stage: "script", Status: status,
		SourceRevision: parameters.SourceRevision, SourceSHA256: parameters.SourceSHA256, FilmRevision: parameters.FilmRevision,
		TargetEpisodeID: parameters.TargetEntityID, TargetRevision: parameters.TargetRevision, TargetSHA256: parameters.TargetSHA256,
		TaskID: parameters.Film.TaskID, GenerationJobID: job.ID, RequestHash: parameters.RequestHash, Script: script, CreatedAt: now,
	})
	if len(next.ScriptCandidates) > 100 {
		return filmDocument{}, errors.New("film AI script candidate retention limit reached")
	}
	task := next.Tasks[taskIndex]
	task.Revision++
	task.Progress = 1
	task.UpdatedAt = now
	stageIndex, stage, err := findFilmStage(next, "script")
	if err != nil {
		return filmDocument{}, err
	}
	stage.Revision++
	stage.UpdatedAt = now
	if stale {
		task.Status, task.Error = filmStatusFailed, "Target episode changed while AI script generation was running"
		stage.Status, stage.Error = filmStatusDraft, "AI script is stale because the target episode changed"
	} else {
		task.Status, task.Error = filmStatusNeedsReview, ""
		stage.Status, stage.Error = filmStatusNeedsReview, ""
	}
	next.Tasks[taskIndex] = task
	next.Stages[stageIndex] = stage
	next.Revision++
	next.UpdatedAt = now
	if err := validateFilmAggregateLimits(next); err != nil {
		return filmDocument{}, err
	}
	return next, nil
}

func applyFilmAIScriptCandidate(document filmDocument, candidateID string, expectedRevision int, now string) (filmDocument, error) {
	if !validProjectID(candidateID) || expectedRevision < 1 || !validFilmTimestamp(now) {
		return filmDocument{}, errors.New("AI script candidate apply request is invalid")
	}
	candidateIndex := -1
	var candidate filmAIScriptCandidate
	for index, current := range document.ScriptCandidates {
		if current.ID == candidateID {
			candidateIndex, candidate = index, current
			break
		}
	}
	if candidateIndex < 0 || candidate.Revision != expectedRevision {
		return filmDocument{}, errors.New("AI script candidate revision conflict")
	}
	_, targetRevision, targetSHA, err := filmScriptTargetSnapshot(document, candidate.TargetEpisodeID)
	if err != nil || candidate.Status != filmAICandidateReady || candidate.SourceRevision != document.Source.Revision ||
		candidate.SourceSHA256 != filmSourceSHA256(document.Source) || candidate.TargetRevision != targetRevision || candidate.TargetSHA256 != targetSHA {
		return filmDocument{}, errors.New("AI script candidate is not current and review-ready")
	}
	if err := validateFilmAIScript(candidate.Script); err != nil {
		return filmDocument{}, err
	}
	next := cloneFilmDocument(document)
	next.StructureVersions = append(next.StructureVersions, snapshotFilmStructure(document, stableFilmID("structure", document.ProjectID, candidate.ID, document.Revision), candidate.ID, now))
	if len(next.StructureVersions) > 100 {
		return filmDocument{}, errors.New("film structure version retention limit reached")
	}
	oldSceneIDs := make(map[string]struct{})
	for _, scene := range document.Scenes {
		if scene.EpisodeID == candidate.TargetEpisodeID {
			oldSceneIDs[scene.ID] = struct{}{}
		}
	}
	oldShotIDs := make(map[string]struct{})
	for _, shot := range document.Shots {
		if _, belongs := oldSceneIDs[shot.SceneID]; belongs {
			oldShotIDs[shot.ID] = struct{}{}
		}
	}
	scenes := make([]filmScene, 0, len(document.Scenes)+len(candidate.Script.Scenes))
	for _, scene := range document.Scenes {
		if _, replaced := oldSceneIDs[scene.ID]; !replaced {
			scenes = append(scenes, scene)
		}
	}
	shots := make([]filmShot, 0, len(document.Shots))
	for _, shot := range document.Shots {
		if _, replaced := oldShotIDs[shot.ID]; !replaced {
			shots = append(shots, shot)
		}
	}
	dialogues := make([]filmDialogue, 0, len(document.Dialogues))
	for _, dialogue := range document.Dialogues {
		if _, replaced := oldShotIDs[dialogue.ShotID]; !replaced {
			dialogues = append(dialogues, dialogue)
		}
	}
	characterIDs := make(map[string]string)
	duplicateNames := make(map[string]struct{})
	for _, asset := range document.Assets {
		if asset.Kind != "character" {
			continue
		}
		name := strings.TrimSpace(asset.Title)
		if _, exists := characterIDs[name]; exists {
			delete(characterIDs, name)
			duplicateNames[name] = struct{}{}
		} else if _, duplicate := duplicateNames[name]; !duplicate {
			characterIDs[name] = asset.ID
		}
	}
	for sceneOrder, sourceScene := range candidate.Script.Scenes {
		sceneID := stableFilmID("scene", candidate.TargetEpisodeID, candidate.ID, sourceScene.Key)
		scenes = append(scenes, filmScene{ID: sceneID, Revision: 1, EpisodeID: candidate.TargetEpisodeID, Order: sceneOrder, Heading: sourceScene.Heading, Synopsis: sourceScene.Synopsis, Status: filmStatusDraft})
		for shotOrder, sourceShot := range sourceScene.Shots {
			shotID := stableFilmID("shot", sceneID, sourceShot.Key)
			shots = append(shots, filmShot{ID: shotID, Revision: 1, SceneID: sceneID, Order: shotOrder, Title: sourceShot.Title, Description: sourceShot.Description, Status: filmStatusDraft, DurationSeconds: sourceShot.DurationSeconds, AspectRatio: document.AspectRatio, IdentityVersionIDs: []string{}})
			for dialogueOrder, sourceDialogue := range sourceShot.Dialogues {
				dialogues = append(dialogues, filmDialogue{ID: stableFilmID("dialogue", shotID, dialogueOrder, sourceDialogue.Text), Revision: 1, ShotID: shotID, Order: dialogueOrder, Kind: sourceDialogue.Kind, CharacterAssetID: characterIDs[strings.TrimSpace(sourceDialogue.Speaker)], Emotion: sourceDialogue.Emotion, Text: sourceDialogue.Text, Status: filmStatusDraft})
			}
		}
	}
	for index, episode := range next.Episodes {
		if episode.ID == candidate.TargetEpisodeID {
			episode.Revision++
			episode.Synopsis = candidate.Script.Summary
			episode.Status = filmStatusDraft
			next.Episodes[index] = episode
			break
		}
	}
	next.Scenes, next.Shots, next.Dialogues = scenes, shots, dialogues
	next = pruneFilmIdentityScopes(next)
	updated := next.ScriptCandidates[candidateIndex]
	updated.Revision++
	updated.Status = filmAICandidateApplied
	updated.AppliedAt = now
	next.ScriptCandidates[candidateIndex] = updated
	next = invalidateFilmStages(next, "storyboard", now)
	next.QualityReports = []filmQualityReport{}
	next.ProjectionRevision++
	next.Revision++
	next.UpdatedAt = now
	if _, _, _, _, err := validateFilmEntities(next); err != nil {
		return filmDocument{}, err
	}
	return next, validateFilmAggregateLimits(next)
}

func (s *Server) applyFilmAIScriptCandidateHandler(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		return applyFilmAIScriptCandidate(document, chi.URLParam(r, "candidateId"), input.Revision, time.Now().UTC().Format(time.RFC3339Nano))
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
