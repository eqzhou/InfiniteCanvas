package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

var filmStageOrder = []string{"decompose", "script", "storyboard", "first_frame", "audio", "video", "compose", "delivery"}

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

func validFilmDirectorSource(source *filmDirectorSource, targetStorageKey string) bool {
	return source != nil && source.Revision >= 1 && (source.TargetField == "storyboard" || source.TargetField == "first_frame") &&
		validProjectID(source.CaptureID) && boardIDPattern.MatchString(source.DirectorNodeID) && boardIDPattern.MatchString(source.CameraID) &&
		validFilmText(source.CameraName, 100, true) && source.Width >= 1 && source.Width <= 4096 && source.Height >= 1 && source.Height <= 4096 &&
		strings.HasPrefix(source.StorageKey, "film:media:") && source.StorageKey == targetStorageKey && validSHA256Hex(source.SHA256) &&
		validFilmText(source.ObjectVersion, 512, true) && validDirectorShotSnapshot(source.Snapshot, source.DirectorNodeID, source.CameraID, source.CameraName) &&
		validFilmTimestamp(source.AdoptedAt)
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
	if source.Format != "text" && source.Format != "txt" && source.Format != "markdown" && source.Format != "docx" && source.Format != "pdf" {
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
		if _, supported := filmAssetKinds[asset.Kind]; !supported || asset.Revision < 1 || !validFilmStatus(asset.Status) || !validFilmText(asset.Title, 500, true) || !validFilmText(asset.Description, 50_000, false) || !validFilmText(asset.Voice, 500, false) || !validFilmText(asset.StylePrompt, 20_000, false) || !validFilmText(asset.AspectRatio, 20, false) || !validFilmText(asset.AgeStage, 200, false) || !validFilmText(asset.Costume, 1_000, false) || !validFilmText(asset.StoryPeriod, 500, false) || !validFilmStorageKey(asset.MediaStorageKey) || (asset.Kind != "identity" && (asset.AgeStage != "" || asset.Costume != "" || asset.StoryPeriod != "" || asset.IsDefault)) {
			return nil, nil, nil, nil, fmt.Errorf("film asset %s is invalid", asset.ID)
		}
		assets[asset.ID] = asset
	}
	defaultIdentities := map[string]string{}
	for _, asset := range document.Assets {
		if asset.ParentAssetID != "" {
			if asset.ParentAssetID == asset.ID {
				return nil, nil, nil, nil, fmt.Errorf("film asset %s cannot parent itself", asset.ID)
			}
			if _, exists := assets[asset.ParentAssetID]; !exists {
				return nil, nil, nil, nil, fmt.Errorf("film asset %s references a missing parent", asset.ID)
			}
		}
		if asset.Kind == "identity" && asset.IsDefault {
			if previous := defaultIdentities[asset.ParentAssetID]; previous != "" {
				return nil, nil, nil, nil, fmt.Errorf("film identity assets %s and %s are both default for one character", previous, asset.ID)
			}
			defaultIdentities[asset.ParentAssetID] = asset.ID
		}
	}
	ids = map[string]struct{}{}
	for _, shot := range document.Shots {
		if err := addUniqueFilmID(ids, shot.ID, "shot"); err != nil {
			return nil, nil, nil, nil, err
		}
		if shot.Revision < 1 || shot.Order < 0 || shot.Order > maxFilmEntities || !validFilmText(shot.Title, 500, true) || !validFilmText(shot.Description, 100_000, true) || !validFilmStatus(shot.Status) || math.IsNaN(shot.DurationSeconds) || math.IsInf(shot.DurationSeconds, 0) || shot.DurationSeconds <= 0 || shot.DurationSeconds > 900 || !validFilmText(shot.AspectRatio, 20, true) || len(shot.IdentityVersionIDs) > 100 || !validFilmStorageKey(shot.ImageStorageKey) || !validFilmStorageKey(shot.FirstFrameStorageKey) || !validFilmStorageKey(shot.VideoStorageKey) || !validFilmStorageKey(shot.AudioStorageKey) || !validFilmText(shot.Subtitle, 20_000, false) || (shot.MediaMIMEType != "" && !filmMIMEType.MatchString(shot.MediaMIMEType)) {
			return nil, nil, nil, nil, fmt.Errorf("film shot %s is invalid", shot.ID)
		}
		if source := shot.StoryboardDirectorSource; source != nil && (source.TargetField != "storyboard" || !validFilmDirectorSource(source, shot.ImageStorageKey)) {
			return nil, nil, nil, nil, fmt.Errorf("film shot %s storyboard Director source is invalid", shot.ID)
		}
		if source := shot.FirstFrameDirectorSource; source != nil && (source.TargetField != "first_frame" || !validFilmDirectorSource(source, shot.FirstFrameStorageKey)) {
			return nil, nil, nil, nil, fmt.Errorf("film shot %s first-frame Director source is invalid", shot.ID)
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
	dialogueIDs := map[string]struct{}{}
	for _, dialogue := range document.Dialogues {
		if err := addUniqueFilmID(dialogueIDs, dialogue.ID, "dialogue"); err != nil {
			return nil, nil, nil, nil, err
		}
		if dialogue.Revision < 1 || dialogue.Order < 0 || dialogue.Order > maxFilmEntities || (dialogue.Kind != "dialogue" && dialogue.Kind != "narration") ||
			!validFilmText(dialogue.Text, 20_000, true) || !validFilmStatus(dialogue.Status) || !validFilmStorageKey(dialogue.AudioStorageKey) {
			return nil, nil, nil, nil, fmt.Errorf("film dialogue %s is invalid", dialogue.ID)
		}
		if _, ok := shots[dialogue.ShotID]; !ok {
			return nil, nil, nil, nil, fmt.Errorf("film dialogue %s references a missing shot", dialogue.ID)
		}
		if dialogue.CharacterAssetID != "" {
			if asset, ok := assets[dialogue.CharacterAssetID]; !ok || asset.Kind != "character" {
				return nil, nil, nil, nil, fmt.Errorf("film dialogue %s references a missing character", dialogue.ID)
			}
		}
		if dialogue.VoiceAssetID != "" {
			if asset, ok := assets[dialogue.VoiceAssetID]; !ok || asset.Kind != "voice" {
				return nil, nil, nil, nil, fmt.Errorf("film dialogue %s references a missing voice", dialogue.ID)
			}
		}
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
		generationKind := filmTaskGenerationKind(task.Stage)
		projectLevelTextTask := generationKind == "text" && task.ShotID == "" && task.TextSnapshot != nil && task.Snapshot == nil
		shotMediaTask := generationKind != "" && generationKind != "text" && validProjectID(task.ShotID) && task.Snapshot != nil && task.TextSnapshot == nil
		if _, exists := filmStageDependencies[task.Stage]; !exists || task.Revision < 1 || !validFilmStatus(task.Status) || !validFilmText(task.Title, 500, true) || math.IsNaN(task.Progress) || math.IsInf(task.Progress, 0) || task.Progress < 0 || task.Progress > 1 || !validFilmTimestamp(task.CreatedAt) || !validFilmTimestamp(task.UpdatedAt) || !validFilmText(task.Error, 2_000, false) || (task.GenerationJobID != "" && (!validProjectID(task.GenerationJobID) || (!projectLevelTextTask && !shotMediaTask) || !validFilmIdempotencyKey(task.IdempotencyKey) || !validFilmRequestHash(task.RequestHash))) || (task.GenerationJobID == "" && (task.ShotID != "" || task.IdempotencyKey != "" || task.RequestHash != "" || task.Snapshot != nil || task.TextSnapshot != nil)) {
			return fmt.Errorf("film task %s is invalid", task.ID)
		}
		if task.Snapshot != nil {
			snapshot := task.Snapshot
			if snapshot.ShotRevision < 1 || !validFilmText(snapshot.Prompt, 100_000, true) ||
				!validFilmText(snapshot.ProviderID, 500, true) || !validFilmText(snapshot.Model, 500, true) ||
				len(snapshot.IdentityVersions) > 100 || len(snapshot.ReferenceStorageKeys) > 16 ||
				snapshot.EstimatedGenerations != 1 || snapshot.EstimatedCredits < 0 || !validFilmTimestamp(snapshot.CreatedAt) ||
				validateFilmGenerationConfig(task.Stage, snapshot.Config) != nil {
				return fmt.Errorf("film task %s generation snapshot is invalid", task.ID)
			}
			if (snapshot.CapabilityVersion == "") != (snapshot.GenerationMode == "") || (snapshot.CapabilityVersion != "" && (!validFilmRequestHash(snapshot.CapabilityVersion) || !validFilmGenerationMode(snapshot.GenerationMode))) {
				return fmt.Errorf("film task %s media capability snapshot is invalid", task.ID)
			}
			if snapshot.StoryboardDirectorSource != nil && !validFilmDirectorSource(snapshot.StoryboardDirectorSource, snapshot.StoryboardDirectorSource.StorageKey) {
				return fmt.Errorf("film task %s storyboard Director snapshot is invalid", task.ID)
			}
			if snapshot.FirstFrameDirectorSource != nil && !validFilmDirectorSource(snapshot.FirstFrameDirectorSource, snapshot.FirstFrameDirectorSource.StorageKey) {
				return fmt.Errorf("film task %s Director snapshot is invalid", task.ID)
			}
		}
		if task.TextSnapshot != nil {
			snapshot := task.TextSnapshot
			if snapshot.SourceRevision < 1 || !validFilmRequestHash(snapshot.SourceSHA256) ||
				!validFilmText(snapshot.ProviderID, 500, true) || !validFilmText(snapshot.Model, 500, true) ||
				!validFilmText(snapshot.PromptVersion, 100, true) || !validFilmText(snapshot.OutputSchema, 100, true) ||
				snapshot.EstimatedGenerations != 1 || snapshot.EstimatedCredits < 0 || !validFilmTimestamp(snapshot.CreatedAt) {
				return fmt.Errorf("film task %s text snapshot is invalid", task.ID)
			}
			if task.Stage == "script" && (!validProjectID(snapshot.TargetEntityID) || snapshot.TargetRevision < 1 || !validFilmRequestHash(snapshot.TargetSHA256)) {
				return fmt.Errorf("film task %s text target snapshot is invalid", task.ID)
			}
		}
	}
	return nil
}

func validateFilmAICandidates(candidates []filmAICandidate, tasks []filmTask) error {
	if len(candidates) > 100 {
		return errors.New("film AI candidate retention limit reached")
	}
	taskIDs := make(map[string]struct{}, len(tasks))
	for _, task := range tasks {
		taskIDs[task.ID] = struct{}{}
	}
	ids := make(map[string]struct{}, len(candidates))
	jobs := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if err := addUniqueFilmID(ids, candidate.ID, "AI candidate"); err != nil {
			return err
		}
		if _, duplicate := jobs[candidate.GenerationJobID]; duplicate {
			return errors.New("film AI candidate generation jobs must be unique")
		}
		jobs[candidate.GenerationJobID] = struct{}{}
		_, taskExists := taskIDs[candidate.TaskID]
		validStatus := candidate.Status == filmAICandidateReady || candidate.Status == filmAICandidateStale ||
			candidate.Status == filmAICandidateRejected || candidate.Status == filmAICandidateApplied
		if candidate.Revision < 1 || candidate.Stage != "decompose" || !validStatus || candidate.SourceRevision < 1 ||
			!validFilmRequestHash(candidate.SourceSHA256) || candidate.FilmRevision < 1 || !taskExists ||
			!validProjectID(candidate.GenerationJobID) || !validFilmRequestHash(candidate.RequestHash) ||
			!validFilmTimestamp(candidate.CreatedAt) || (candidate.AppliedAt != "" && !validFilmTimestamp(candidate.AppliedAt)) ||
			validateFilmAIDecomposition(candidate.Decomposition) != nil {
			return fmt.Errorf("film AI candidate %s is invalid", candidate.ID)
		}
	}
	return nil
}

func validateFilmAIScriptCandidates(candidates []filmAIScriptCandidate, tasks []filmTask) error {
	if len(candidates) > 100 {
		return errors.New("film AI script candidate retention limit reached")
	}
	taskIDs := make(map[string]struct{}, len(tasks))
	for _, task := range tasks {
		taskIDs[task.ID] = struct{}{}
	}
	ids := make(map[string]struct{}, len(candidates))
	jobs := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if err := addUniqueFilmID(ids, candidate.ID, "AI script candidate"); err != nil {
			return err
		}
		if _, duplicate := jobs[candidate.GenerationJobID]; duplicate {
			return errors.New("film AI script candidate generation jobs must be unique")
		}
		jobs[candidate.GenerationJobID] = struct{}{}
		_, taskExists := taskIDs[candidate.TaskID]
		validStatus := candidate.Status == filmAICandidateReady || candidate.Status == filmAICandidateStale ||
			candidate.Status == filmAICandidateRejected || candidate.Status == filmAICandidateApplied
		if candidate.Revision < 1 || candidate.Stage != "script" || !validStatus || candidate.SourceRevision < 1 ||
			!validFilmRequestHash(candidate.SourceSHA256) || candidate.FilmRevision < 1 || !validProjectID(candidate.TargetEpisodeID) ||
			candidate.TargetRevision < 1 || !validFilmRequestHash(candidate.TargetSHA256) || !taskExists ||
			!validProjectID(candidate.GenerationJobID) || !validFilmRequestHash(candidate.RequestHash) ||
			!validFilmTimestamp(candidate.CreatedAt) || (candidate.AppliedAt != "" && !validFilmTimestamp(candidate.AppliedAt)) ||
			validateFilmAIScript(candidate.Script) != nil {
			return fmt.Errorf("film AI script candidate %s is invalid", candidate.ID)
		}
	}
	return nil
}

func validateFilmStructureVersions(versions []filmStructureVersion) error {
	if len(versions) > 100 {
		return errors.New("film structure version retention limit reached")
	}
	ids := make(map[string]struct{}, len(versions))
	for _, version := range versions {
		if err := addUniqueFilmID(ids, version.ID, "structure version"); err != nil {
			return err
		}
		if version.Revision < 1 || !validProjectID(version.CandidateID) || !validFilmTimestamp(version.CreatedAt) {
			return fmt.Errorf("film structure version %s is invalid", version.ID)
		}
		snapshot := filmDocument{
			Episodes: version.Episodes, Scenes: version.Scenes, Shots: version.Shots,
			Dialogues: version.Dialogues, Assets: version.Assets,
		}
		if _, _, _, _, err := validateFilmEntities(snapshot); err != nil {
			return fmt.Errorf("film structure version %s is invalid: %w", version.ID, err)
		}
	}
	return nil
}

func validateFilmAdoptions(document filmDocument, shots map[string]filmShot, assets map[string]filmAsset) error {
	if len(document.Adoptions) > 1_000 {
		return errors.New("film adoption history limit reached")
	}
	ids := map[string]struct{}{}
	for _, adoption := range document.Adoptions {
		if err := addUniqueFilmID(ids, adoption.ID, "adoption"); err != nil {
			return err
		}
		expected := filmAdoptionExpectedMIME(adoption.TargetType, adoption.TargetField)
		_, shotExists := shots[adoption.TargetID]
		_, assetExists := assets[adoption.TargetID]
		if adoption.Revision < 1 || adoption.TargetRevision < 2 || expected == "invalid" ||
			(adoption.TargetType == "shot" && !shotExists) || (adoption.TargetType == "asset" && !assetExists) ||
			!validProjectID(adoption.SourceNodeID) || !validFilmStorageKey(adoption.StorageKey) || adoption.StorageKey == "" ||
			!filmMIMEType.MatchString(adoption.MIMEType) || (expected != "" && !strings.HasPrefix(adoption.MIMEType, expected)) ||
			len(adoption.SHA256) != 64 || !validFilmText(adoption.ObjectVersion, 256, true) ||
			(adoption.GenerationJobID != "" && !validProjectID(adoption.GenerationJobID)) ||
			!validFilmText(adoption.Prompt, 100_000, false) || !validFilmText(adoption.ProviderID, 500, false) ||
			!validFilmText(adoption.Model, 500, false) || !validFilmTimestamp(adoption.AdoptedAt) {
			return fmt.Errorf("film adoption %s is invalid", adoption.ID)
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
			"media_corrupt": {}, "subtitle_overflow": {}, "duration_conflict": {}, "identity_drift": {}, "style_drift": {},
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
			if _, exists := issueIDs[repair.IssueID]; !exists || repair.ExpectedRevision < 1 || !validFilmText(repair.Summary, 2_000, true) || !validateFilmRepairPatch(repair.Patch) || !validFilmQualityTarget(repair.TargetType, repair.TargetID, scenes, shots, assets, document.Timeline) || (repair.AppliedAt != "" && !validFilmTimestamp(repair.AppliedAt)) || len(repair.AffectedTargets) > 100 || repair.EstimatedGenerations < 0 || repair.EstimatedGenerations > 100 || repair.EstimatedCredits < 0 {
				return fmt.Errorf("film repair proposal %s is invalid", repair.ID)
			}
		}
	}
	return nil
}

func validateFilmVersions(document filmDocument, shots map[string]filmShot, assets map[string]filmAsset) error {
	if len(document.Versions) > 1_000 {
		return errors.New("film entity version limit reached")
	}
	ids := map[string]struct{}{}
	for _, version := range document.Versions {
		if err := addUniqueFilmID(ids, version.ID, "entity version"); err != nil {
			return err
		}
		validTarget := version.EntityType == "shot" && shots[version.EntityID].ID != "" || version.EntityType == "asset" && assets[version.EntityID].ID != "" || version.EntityType == "timeline" && version.EntityID == "timeline"
		if !validTarget || version.Revision < 1 || len(version.Snapshot) == 0 || len(version.Snapshot) > maxProjectBytes || !json.Valid(version.Snapshot) || !validFilmText(version.Reason, 500, true) || !validFilmTimestamp(version.CreatedAt) {
			return fmt.Errorf("film entity version %s is invalid", version.ID)
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
		_, expectedMIME, _, validKind := filmDeliverableSpec(deliverable.Kind)
		external := deliverable.StorageKey != ""
		terminalMedia := deliverable.Status == filmStatusApproved
		validBytes := (!terminalMedia && deliverable.Bytes == 0 && !external && deliverable.Content == "") ||
			(terminalMedia && deliverable.Bytes > 0 && ((external && deliverable.Content == "") || (!external && deliverable.Bytes == int64(len(deliverable.Content)))))
		validIdempotency := (!external && terminalMedia && deliverable.GenerationJobID == "") ||
			(validFilmIdempotencyKey(deliverable.IdempotencyKey) && validFilmRequestHash(deliverable.RequestHash))
		validJob := deliverable.GenerationJobID == "" || validProjectID(deliverable.GenerationJobID)
		if !validKind || deliverable.Revision < 1 || !validFilmStatus(deliverable.Status) || !validFilmText(deliverable.Title, 500, true) || deliverable.MIMEType != expectedMIME || !validFilmStorageKey(deliverable.StorageKey) || len(deliverable.Content) > maxProjectBytes || !validBytes || !validIdempotency || !validJob || !validFilmText(deliverable.Diagnostic, 2_000, false) || !validFilmTimestamp(deliverable.CreatedAt) {
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
	if err := validateFilmAICandidates(document.AICandidates, document.Tasks); err != nil {
		return err
	}
	if err := validateFilmAIScriptCandidates(document.ScriptCandidates, document.Tasks); err != nil {
		return err
	}
	if err := validateFilmStructureVersions(document.StructureVersions); err != nil {
		return err
	}
	for _, task := range document.Tasks {
		if task.ShotID != "" {
			if _, exists := shots[task.ShotID]; !exists {
				return fmt.Errorf("film task %s references a missing shot", task.ID)
			}
		}
	}
	if err := validateFilmQualityReports(document, scenes, shots, assets); err != nil {
		return err
	}
	if err := validateFilmDeliverables(document.Deliverables); err != nil {
		return err
	}
	if err := validateFilmAdoptions(document, shots, assets); err != nil {
		return err
	}
	if err := validateFilmVersions(document, shots, assets); err != nil {
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
