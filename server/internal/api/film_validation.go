package api

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

var filmStageOrder = []string{"decompose", "script", "storyboard", "audio", "video", "compose", "delivery"}

func validFilmStatus(status string) bool {
	switch status {
	case filmStatusDraft, filmStatusRunning, filmStatusNeedsReview, filmStatusApproved, filmStatusFailed, filmStatusCanceled:
		return true
	default:
		return false
	}
}

func validFilmTimestamp(value string) bool {
	if value == "" {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func validFilmText(value string, maximum int, required bool) bool {
	return len(value) <= maximum && (!required || strings.TrimSpace(value) != "")
}

func validFilmStorageKey(value string) bool {
	return len(value) <= 512 && !strings.ContainsAny(value, "\x00\r\n")
}

func addUniqueFilmID(ids map[string]struct{}, id, kind string) error {
	if !validProjectID(id) {
		return fmt.Errorf("film %s id is invalid", kind)
	}
	if _, exists := ids[id]; exists {
		return fmt.Errorf("film %s ids must be unique", kind)
	}
	ids[id] = struct{}{}
	return nil
}

func validateFilmSource(source filmSource) error {
	if source.Revision < 0 || len(source.Text) > maxFilmSourceBytes || len(source.OriginalName) > 255 || !validFilmTimestamp(source.ImportedAt) {
		return errors.New("film source is invalid")
	}
	if source.Format != "text" && source.Format != "txt" && source.Format != "markdown" {
		return errors.New("film source format is unsupported")
	}
	return nil
}

func validateFilmStages(stages []filmStage) error {
	if len(stages) != len(filmStageOrder) {
		return errors.New("film stages must contain the exact production topology")
	}
	seen := map[string]struct{}{}
	for index, stage := range stages {
		if stage.ID != filmStageOrder[index] {
			return errors.New("film stages must use the exact production topology")
		}
		if err := addUniqueFilmID(seen, stage.ID, "stage"); err != nil {
			return err
		}
		if stage.Revision < 1 || !validFilmStatus(stage.Status) || !validFilmTimestamp(stage.UpdatedAt) || !validFilmText(stage.Error, 2_000, false) {
			return fmt.Errorf("film stage %s is invalid", stage.ID)
		}
	}
	return nil
}

func validateFilmEntities(document filmDocument) (map[string]filmEpisode, map[string]filmScene, map[string]filmShot, map[string]filmAsset, error) {
	episodes := make(map[string]filmEpisode, len(document.Episodes))
	scenes := make(map[string]filmScene, len(document.Scenes))
	shots := make(map[string]filmShot, len(document.Shots))
	assets := make(map[string]filmAsset, len(document.Assets))
	ids := map[string]struct{}{}
	for _, episode := range document.Episodes {
		if err := addUniqueFilmID(ids, episode.ID, "episode"); err != nil {
			return nil, nil, nil, nil, err
		}
		if episode.Revision < 1 || episode.Order < 0 || episode.Order > maxFilmEntities || !validFilmText(episode.Title, 500, true) || !validFilmText(episode.Synopsis, 20_000, false) || !validFilmStatus(episode.Status) {
			return nil, nil, nil, nil, fmt.Errorf("film episode %s is invalid", episode.ID)
		}
		episodes[episode.ID] = episode
	}
	ids = map[string]struct{}{}
	for _, scene := range document.Scenes {
		if err := addUniqueFilmID(ids, scene.ID, "scene"); err != nil {
			return nil, nil, nil, nil, err
		}
		if scene.Revision < 1 || scene.Order < 0 || scene.Order > maxFilmEntities || !validFilmText(scene.Heading, 500, true) || !validFilmText(scene.Synopsis, 20_000, false) || !validFilmStatus(scene.Status) {
			return nil, nil, nil, nil, fmt.Errorf("film scene %s is invalid", scene.ID)
		}
		if _, exists := episodes[scene.EpisodeID]; !exists {
			return nil, nil, nil, nil, fmt.Errorf("film scene %s references a missing episode", scene.ID)
		}
		scenes[scene.ID] = scene
	}
	ids = map[string]struct{}{}
	for _, asset := range document.Assets {
		if err := addUniqueFilmID(ids, asset.ID, "asset"); err != nil {
			return nil, nil, nil, nil, err
		}
		if _, supported := filmAssetKinds[asset.Kind]; !supported || asset.Revision < 1 || !validFilmStatus(asset.Status) || !validFilmText(asset.Title, 500, true) || !validFilmText(asset.Description, 50_000, false) || !validFilmText(asset.Voice, 500, false) || !validFilmText(asset.StylePrompt, 20_000, false) || !validFilmText(asset.AspectRatio, 20, false) || !validFilmStorageKey(asset.MediaStorageKey) {
			return nil, nil, nil, nil, fmt.Errorf("film asset %s is invalid", asset.ID)
		}
		assets[asset.ID] = asset
	}
	for _, asset := range document.Assets {
		if asset.ParentAssetID != "" {
			if asset.ParentAssetID == asset.ID {
				return nil, nil, nil, nil, fmt.Errorf("film asset %s cannot parent itself", asset.ID)
			}
			if _, exists := assets[asset.ParentAssetID]; !exists {
				return nil, nil, nil, nil, fmt.Errorf("film asset %s references a missing parent", asset.ID)
			}
		}
	}
	ids = map[string]struct{}{}
	for _, shot := range document.Shots {
		if err := addUniqueFilmID(ids, shot.ID, "shot"); err != nil {
			return nil, nil, nil, nil, err
		}
		if shot.Revision < 1 || shot.Order < 0 || shot.Order > maxFilmEntities || !validFilmText(shot.Title, 500, true) || !validFilmText(shot.Description, 100_000, true) || !validFilmStatus(shot.Status) || math.IsNaN(shot.DurationSeconds) || math.IsInf(shot.DurationSeconds, 0) || shot.DurationSeconds <= 0 || shot.DurationSeconds > 900 || !validFilmText(shot.AspectRatio, 20, true) || len(shot.IdentityVersionIDs) > 100 || !validFilmStorageKey(shot.ImageStorageKey) || !validFilmStorageKey(shot.VideoStorageKey) || !validFilmStorageKey(shot.AudioStorageKey) || !validFilmText(shot.Subtitle, 20_000, false) || (shot.MediaMIMEType != "" && !filmMIMEType.MatchString(shot.MediaMIMEType)) {
			return nil, nil, nil, nil, fmt.Errorf("film shot %s is invalid", shot.ID)
		}
		if _, exists := scenes[shot.SceneID]; !exists {
			return nil, nil, nil, nil, fmt.Errorf("film shot %s references a missing scene", shot.ID)
		}
		identityIDs := map[string]struct{}{}
		for _, assetID := range shot.IdentityVersionIDs {
			if err := addUniqueFilmID(identityIDs, assetID, "shot identity reference"); err != nil {
				return nil, nil, nil, nil, err
			}
			asset, exists := assets[assetID]
			if !exists || asset.Kind != "identity" {
				return nil, nil, nil, nil, fmt.Errorf("film shot %s references a missing identity asset", shot.ID)
			}
		}
		if shot.StyleAssetID != "" {
			asset, exists := assets[shot.StyleAssetID]
			if !exists || asset.Kind != "style" {
				return nil, nil, nil, nil, fmt.Errorf("film shot %s references a missing style asset", shot.ID)
			}
		}
		shots[shot.ID] = shot
	}
	return episodes, scenes, shots, assets, nil
}

func validateFilmTasks(tasks []filmTask) error {
	if len(tasks) > 1_000 {
		return errors.New("film task retention limit reached")
	}
	ids := map[string]struct{}{}
	for _, task := range tasks {
		if err := addUniqueFilmID(ids, task.ID, "task"); err != nil {
			return err
		}
		if _, exists := filmStageDependencies[task.Stage]; !exists || task.Revision < 1 || !validFilmStatus(task.Status) || !validFilmText(task.Title, 500, true) || math.IsNaN(task.Progress) || math.IsInf(task.Progress, 0) || task.Progress < 0 || task.Progress > 1 || !validFilmTimestamp(task.CreatedAt) || !validFilmTimestamp(task.UpdatedAt) || !validFilmText(task.Error, 2_000, false) || (task.GenerationJobID != "" && !validProjectID(task.GenerationJobID)) {
			return fmt.Errorf("film task %s is invalid", task.ID)
		}
	}
	return nil
}

func validFilmQualityTarget(targetType, targetID string, scenes map[string]filmScene, shots map[string]filmShot, assets map[string]filmAsset, timeline filmTimeline) bool {
	switch targetType {
	case "scene":
		_, ok := scenes[targetID]
		return ok
	case "shot":
		_, ok := shots[targetID]
		return ok
	case "asset":
		_, ok := assets[targetID]
		return ok
	case "timeline":
		if targetID == "timeline" {
			return true
		}
		for _, track := range timeline.Tracks {
			if track.ID == targetID {
				return true
			}
			for _, clip := range track.Clips {
				if clip.ID == targetID {
					return true
				}
			}
		}
	}
	return false
}

func validateFilmRepairPatch(patch map[string]any) bool {
	if patch == nil || len(patch) == 0 || len(patch) > 20 {
		return false
	}
	for key, value := range patch {
		if !validFilmText(key, 64, true) {
			return false
		}
		switch typed := value.(type) {
		case string:
			if len(typed) > 100_000 {
				return false
			}
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return false
			}
		case bool:
		default:
			return false
		}
	}
	return true
}

func validateFilmQualityReports(document filmDocument, scenes map[string]filmScene, shots map[string]filmShot, assets map[string]filmAsset) error {
	if len(document.QualityReports) > 20 {
		return errors.New("film quality report retention limit reached")
	}
	reportIDs := map[string]struct{}{}
	totalIssues, totalRepairs := 0, 0
	for _, report := range document.QualityReports {
		if err := addUniqueFilmID(reportIDs, report.ID, "quality report"); err != nil {
			return err
		}
		if report.Revision < 1 || !validFilmTimestamp(report.CreatedAt) {
			return fmt.Errorf("film quality report %s is invalid", report.ID)
		}
		totalIssues += len(report.Issues)
		totalRepairs += len(report.Repairs)
		if totalIssues > maxFilmQualityIssues || totalRepairs > maxFilmRepairProposals {
			return errors.New("film quality report nested limit reached")
		}
		issueIDs := map[string]struct{}{}
		validIssueCodes := map[string]struct{}{
			"missing_shots": {}, "missing_media": {}, "identity_mismatch": {}, "style_mismatch": {},
			"aspect_mismatch": {}, "missing_audio": {}, "duration_invalid": {}, "missing_subtitle": {}, "media_invalid": {},
		}
		for _, issue := range report.Issues {
			if err := addUniqueFilmID(issueIDs, issue.ID, "quality issue"); err != nil {
				return err
			}
			_, validCode := validIssueCodes[issue.Code]
			if !validCode || (issue.Severity != "warning" && issue.Severity != "error") || !validFilmText(issue.Message, 2_000, true) || !validFilmQualityTarget(issue.TargetType, issue.TargetID, scenes, shots, assets, document.Timeline) {
				return fmt.Errorf("film quality issue %s is invalid", issue.ID)
			}
		}
		repairIDs := map[string]struct{}{}
		for _, repair := range report.Repairs {
			if err := addUniqueFilmID(repairIDs, repair.ID, "repair proposal"); err != nil {
				return err
			}
			if _, exists := issueIDs[repair.IssueID]; !exists || repair.ExpectedRevision < 1 || !validFilmText(repair.Summary, 2_000, true) || !validateFilmRepairPatch(repair.Patch) || !validFilmQualityTarget(repair.TargetType, repair.TargetID, scenes, shots, assets, document.Timeline) || (repair.AppliedAt != "" && !validFilmTimestamp(repair.AppliedAt)) {
				return fmt.Errorf("film repair proposal %s is invalid", repair.ID)
			}
		}
	}
	return nil
}

func validateFilmDeliverables(deliverables []filmDeliverable) error {
	if len(deliverables) > 100 {
		return errors.New("film deliverable retention limit reached")
	}
	ids := map[string]struct{}{}
	for _, deliverable := range deliverables {
		if err := addUniqueFilmID(ids, deliverable.ID, "deliverable"); err != nil {
			return err
		}
		validKind := deliverable.Kind == "manifest" || deliverable.Kind == "srt"
		expectedMIME := "application/json"
		if deliverable.Kind == "srt" {
			expectedMIME = "application/x-subrip"
		}
		if !validKind || deliverable.Revision < 1 || !validFilmStatus(deliverable.Status) || !validFilmText(deliverable.Title, 500, true) || deliverable.MIMEType != expectedMIME || deliverable.StorageKey != "" || len(deliverable.Content) > maxProjectBytes || deliverable.Bytes < 0 || deliverable.Bytes != int64(len(deliverable.Content)) || !validFilmText(deliverable.Diagnostic, 2_000, false) || !validFilmTimestamp(deliverable.CreatedAt) {
			return fmt.Errorf("film deliverable %s is invalid", deliverable.ID)
		}
	}
	return nil
}

func validateFilmAggregate(document filmDocument, projectID string) error {
	if document.SchemaVersion != 1 || document.ProjectID != projectID || !validProjectID(projectID) || document.Revision < 1 || document.ProjectionRevision < 0 || !validFilmTimestamp(document.CreatedAt) || !validFilmTimestamp(document.UpdatedAt) || !validFilmText(document.AspectRatio, 20, true) {
		return errors.New("film restore document identity is invalid")
	}
	if err := validateFilmSource(document.Source); err != nil {
		return err
	}
	if err := validateFilmAggregateLimits(document); err != nil {
		return err
	}
	if err := validateFilmStages(document.Stages); err != nil {
		return err
	}
	_, scenes, shots, assets, err := validateFilmEntities(document)
	if err != nil {
		return err
	}
	if err := validateFilmTasks(document.Tasks); err != nil {
		return err
	}
	if err := validateFilmQualityReports(document, scenes, shots, assets); err != nil {
		return err
	}
	if err := validateFilmDeliverables(document.Deliverables); err != nil {
		return err
	}
	for _, stage := range document.Stages {
		if stage.Status != filmStatusNeedsReview && stage.Status != filmStatusApproved {
			continue
		}
		if err := validateFilmStageDependencies(document, stage.ID); err != nil {
			return fmt.Errorf("film stage topology is inconsistent: %w", err)
		}
		if err := validateFilmStageReadiness(document, stage.ID); err != nil {
			return fmt.Errorf("film stage readiness is invalid: %w", err)
		}
	}
	return nil
}
