package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	filmEpisodeHeading = regexp.MustCompile(`(?i)^(EPISODE[[:space:]]+[0-9]+|第[[:space:]]*[一二三四五六七八九十百0-9]+[[:space:]]*集)`)
	filmSceneHeading   = regexp.MustCompile(`(?i)^((INT|EXT|INT/EXT|EXT/INT)\.?[[:space:]]|内景[：:[:space:]]|外景[：:[:space:]]|内外景[：:[:space:]]|场景[[:space:]]*[0-9]+)`)
	filmMIMEType       = regexp.MustCompile(`(?i)^(image|video|audio)/[a-z0-9.+-]+$`)
)

func stableFilmID(prefix string, values ...any) string {
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = fmt.Sprint(value)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return prefix + "_" + hex.EncodeToString(sum[:8])
}

func defaultFilmTimeline() filmTimeline {
	kinds := []string{"video", "dialogue", "music", "sfx", "subtitle"}
	titles := []string{"Picture", "Dialogue", "Music", "Sound effects", "Subtitles"}
	tracks := make([]filmTimelineTrack, len(kinds))
	for index, kind := range kinds {
		tracks[index] = filmTimelineTrack{ID: "track_" + kind, Revision: 1, Kind: kind, Title: titles[index], Clips: []filmTimelineClip{}}
	}
	return filmTimeline{Revision: 1, Width: 1920, Height: 1080, FrameRate: 24, Tracks: tracks}
}

func newFilmDocument(projectID string) filmDocument {
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	stageIDs := []string{"decompose", "script", "storyboard", "audio", "video", "compose", "delivery"}
	stages := make([]filmStage, len(stageIDs))
	for index, id := range stageIDs {
		stages[index] = filmStage{ID: id, Revision: 1, Status: filmStatusDraft, UpdatedAt: timestamp}
	}
	return filmDocument{
		SchemaVersion: 1, ProjectID: projectID, Revision: 1, CreatedAt: timestamp, UpdatedAt: timestamp,
		AspectRatio: "16:9", Source: filmSource{Format: "text", ImportedAt: timestamp},
		Episodes: []filmEpisode{}, Scenes: []filmScene{}, Shots: []filmShot{}, Assets: []filmAsset{},
		Stages: stages, Tasks: []filmTask{}, QualityReports: []filmQualityReport{},
		Timeline: defaultFilmTimeline(), Deliverables: []filmDeliverable{},
	}
}

func cloneFilmDocument(document filmDocument) filmDocument {
	raw, _ := json.Marshal(document)
	var clone filmDocument
	_ = json.Unmarshal(raw, &clone)
	return clone
}

type filmEpisodeBlock struct {
	title string
	lines []string
}

type filmSceneBlock struct {
	heading string
	body    []string
}

type filmDecompositionLimits struct {
	Episodes int
	Scenes   int
	Shots    int
	Entities int
}

var defaultFilmDecompositionLimits = filmDecompositionLimits{
	Episodes: maxFilmEntities,
	Scenes:   maxFilmEntities,
	Shots:    maxFilmEntities,
	Entities: maxFilmEntities,
}

func splitFilmSentences(body string) []string {
	fields := strings.FieldsFunc(body, func(character rune) bool {
		return character == '.' || character == '!' || character == '?' || character == '。' || character == '！' || character == '？' || character == '\n'
	})
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if value := strings.TrimSpace(field); value != "" {
			result = append(result, value)
		}
		if len(result) == 24 {
			break
		}
	}
	if len(result) == 0 {
		return []string{"Establish the scene and principal action."}
	}
	return result
}

func decomposeFilmSource(document filmDocument, source string) (filmDocument, error) {
	return decomposeFilmSourceWithLimits(document, source, defaultFilmDecompositionLimits)
}

func decomposeFilmSourceWithLimits(document filmDocument, source string, limits filmDecompositionLimits) (filmDocument, error) {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n"))
	lines := strings.Split(normalized, "\n")
	episodeBlocks := []filmEpisodeBlock{}
	currentEpisode := filmEpisodeBlock{title: "Episode 1", lines: []string{}}
	appendEpisode := func(block filmEpisodeBlock) error {
		if len(episodeBlocks) >= limits.Episodes {
			return errors.New("film decomposition episode limit reached")
		}
		episodeBlocks = append(episodeBlocks, block)
		return nil
	}
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if filmEpisodeHeading.MatchString(line) {
			if len(currentEpisode.lines) > 0 || len(episodeBlocks) > 0 {
				if err := appendEpisode(currentEpisode); err != nil {
					return filmDocument{}, err
				}
			}
			currentEpisode = filmEpisodeBlock{title: line, lines: []string{}}
			continue
		}
		currentEpisode.lines = append(currentEpisode.lines, line)
	}
	if len(currentEpisode.lines) > 0 || len(episodeBlocks) == 0 {
		if err := appendEpisode(currentEpisode); err != nil {
			return filmDocument{}, err
		}
	}

	episodes := []filmEpisode{}
	scenes := []filmScene{}
	shots := []filmShot{}
	sceneCount := 0
	for episodeIndex, block := range episodeBlocks {
		if len(episodes) >= limits.Episodes || len(episodes)+len(scenes)+len(shots) >= limits.Entities {
			return filmDocument{}, errors.New("film decomposition episode limit reached")
		}
		episodeID := stableFilmID("episode", document.ProjectID, episodeIndex, block.title)
		sceneBlocks := []filmSceneBlock{}
		currentScene := filmSceneBlock{heading: "SCENE 1", body: []string{}}
		appendScene := func(block filmSceneBlock) error {
			if sceneCount >= limits.Scenes {
				return errors.New("film decomposition scene limit reached")
			}
			sceneBlocks = append(sceneBlocks, block)
			sceneCount++
			return nil
		}
		for _, line := range block.lines {
			if filmSceneHeading.MatchString(line) {
				if len(currentScene.body) > 0 || len(sceneBlocks) > 0 {
					if err := appendScene(currentScene); err != nil {
						return filmDocument{}, err
					}
				}
				currentScene = filmSceneBlock{heading: line, body: []string{}}
				continue
			}
			if line != "" {
				currentScene.body = append(currentScene.body, line)
			}
		}
		if len(currentScene.body) > 0 || len(sceneBlocks) == 0 {
			if err := appendScene(currentScene); err != nil {
				return filmDocument{}, err
			}
		}
		synopsisParts := []string{}
		for _, scene := range sceneBlocks {
			synopsisParts = append(synopsisParts, scene.body...)
		}
		episodes = append(episodes, filmEpisode{ID: episodeID, Revision: 1, Order: episodeIndex, Title: block.title, Synopsis: truncateRunes(strings.Join(synopsisParts, " "), 600), Status: filmStatusDraft})
		for sceneIndex, block := range sceneBlocks {
			if len(scenes) >= limits.Scenes || len(episodes)+len(scenes)+len(shots) >= limits.Entities {
				return filmDocument{}, errors.New("film decomposition scene limit reached")
			}
			sceneID := stableFilmID("scene", episodeID, sceneIndex, block.heading)
			body := strings.TrimSpace(strings.Join(block.body, " "))
			scenes = append(scenes, filmScene{ID: sceneID, Revision: 1, EpisodeID: episodeID, Order: sceneIndex, Heading: block.heading, Synopsis: truncateRunes(body, 1000), Status: filmStatusDraft})
			for shotIndex, sentence := range splitFilmSentences(body) {
				if len(shots) >= limits.Shots || len(episodes)+len(scenes)+len(shots) >= limits.Entities {
					return filmDocument{}, errors.New("film decomposition shot limit reached")
				}
				shots = append(shots, filmShot{
					ID: stableFilmID("shot", sceneID, shotIndex, sentence), Revision: 1, SceneID: sceneID, Order: shotIndex,
					Title: fmt.Sprintf("Shot %d", shotIndex+1), Description: sentence, Status: filmStatusDraft,
					DurationSeconds: 4, AspectRatio: document.AspectRatio, IdentityVersionIDs: []string{},
				})
			}
		}
	}
	next := cloneFilmDocument(document)
	next.Revision++
	next.Source = filmSource{Revision: document.Source.Revision + 1, Text: normalized, Format: document.Source.Format, OriginalName: document.Source.OriginalName, ImportedAt: document.UpdatedAt}
	next.Episodes, next.Scenes, next.Shots = episodes, scenes, shots
	next.QualityReports = []filmQualityReport{}
	next.ProjectionRevision++
	next = invalidateFilmStages(next, "decompose", document.UpdatedAt)
	for index, stage := range next.Stages {
		if stage.ID == "decompose" {
			next.Stages[index] = filmStage{ID: stage.ID, Revision: stage.Revision + 1, Status: filmStatusNeedsReview, UpdatedAt: document.UpdatedAt}
		}
	}
	return next, nil
}

func truncateRunes(value string, limit int) string {
	characters := []rune(value)
	if len(characters) <= limit {
		return value
	}
	return string(characters[:limit])
}

func newFilmIssue(code, targetType, targetID, message, severity string) filmQualityIssue {
	return filmQualityIssue{ID: stableFilmID("issue", code, targetType, targetID), Code: code, Severity: severity, TargetType: targetType, TargetID: targetID, Message: message}
}

func filmShotRepair(qualityIssue filmQualityIssue, shot filmShot) (filmRepairProposal, bool) {
	patch := map[string]any{}
	summary := ""
	switch qualityIssue.Code {
	case "missing_media":
		patch["description"] = shot.Description + "\nMedia pending."
		summary = "Mark the draft description for a new media generation pass."
	case "missing_audio", "media_invalid":
		patch["status"] = filmStatusDraft
		summary = "Return the shot to draft for safe regeneration."
	case "duration_invalid":
		patch["durationSeconds"] = float64(4)
		summary = "Reset shot duration to four seconds."
	case "aspect_mismatch":
		patch["aspectRatio"] = "16:9"
		summary = "Align this shot with the project delivery aspect."
	case "missing_subtitle":
		patch["subtitle"] = shot.Description
		summary = "Use the approved shot description as a subtitle draft."
	default:
		return filmRepairProposal{}, false
	}
	return filmRepairProposal{ID: stableFilmID("repair", qualityIssue.ID), IssueID: qualityIssue.ID, TargetType: "shot", TargetID: shot.ID, ExpectedRevision: shot.Revision, Patch: patch, Summary: summary}, true
}

func validateFilmDocument(document filmDocument) (filmQualityReport, error) {
	issues := []filmQualityIssue{}
	appendIssue := func(issue filmQualityIssue) error {
		if len(issues) >= maxFilmQualityIssues {
			return errors.New("film quality issue limit reached")
		}
		issues = append(issues, issue)
		return nil
	}
	shotsByScene := map[string]int{}
	for _, shot := range document.Shots {
		shotsByScene[shot.SceneID]++
	}
	for _, scene := range document.Scenes {
		if shotsByScene[scene.ID] == 0 {
			if err := appendIssue(newFilmIssue("missing_shots", "scene", scene.ID, "Scene has no planned shots.", "error")); err != nil {
				return filmQualityReport{}, err
			}
		}
	}
	identityIDs, styleIDs := map[string]struct{}{}, map[string]struct{}{}
	for _, asset := range document.Assets {
		if asset.Kind == "identity" {
			identityIDs[asset.ID] = struct{}{}
		}
		if asset.Kind == "style" {
			styleIDs[asset.ID] = struct{}{}
		}
	}
	shotByID := map[string]filmShot{}
	for _, shot := range document.Shots {
		shotByID[shot.ID] = shot
		if shot.ImageStorageKey == "" && shot.VideoStorageKey == "" {
			if err := appendIssue(newFilmIssue("missing_media", "shot", shot.ID, "Shot has no image or video media.", "error")); err != nil {
				return filmQualityReport{}, err
			}
		}
		for _, identityID := range shot.IdentityVersionIDs {
			if _, exists := identityIDs[identityID]; !exists {
				if err := appendIssue(newFilmIssue("identity_mismatch", "shot", shot.ID, "Shot references an unavailable identity version.", "warning")); err != nil {
					return filmQualityReport{}, err
				}
				break
			}
		}
		if shot.StyleAssetID != "" {
			if _, exists := styleIDs[shot.StyleAssetID]; !exists {
				if err := appendIssue(newFilmIssue("style_mismatch", "shot", shot.ID, "Shot references an unavailable style asset.", "warning")); err != nil {
					return filmQualityReport{}, err
				}
			}
		}
		if shot.AspectRatio != document.AspectRatio {
			if err := appendIssue(newFilmIssue("aspect_mismatch", "shot", shot.ID, "Shot aspect does not match the project delivery aspect.", "warning")); err != nil {
				return filmQualityReport{}, err
			}
		}
		if shot.AudioStorageKey == "" {
			if err := appendIssue(newFilmIssue("missing_audio", "shot", shot.ID, "Shot has no dialogue or audio media.", "warning")); err != nil {
				return filmQualityReport{}, err
			}
		}
		if math.IsNaN(shot.DurationSeconds) || math.IsInf(shot.DurationSeconds, 0) || shot.DurationSeconds <= 0 || shot.DurationSeconds > 900 {
			if err := appendIssue(newFilmIssue("duration_invalid", "shot", shot.ID, "Shot duration is outside production limits.", "error")); err != nil {
				return filmQualityReport{}, err
			}
		}
		if strings.TrimSpace(shot.Subtitle) == "" {
			if err := appendIssue(newFilmIssue("missing_subtitle", "shot", shot.ID, "Shot has no subtitle draft.", "warning")); err != nil {
				return filmQualityReport{}, err
			}
		}
		if shot.MediaMIMEType != "" && !filmMIMEType.MatchString(shot.MediaMIMEType) {
			if err := appendIssue(newFilmIssue("media_invalid", "shot", shot.ID, "Shot media type is invalid.", "error")); err != nil {
				return filmQualityReport{}, err
			}
		}
	}
	repairs := []filmRepairProposal{}
	for _, qualityIssue := range issues {
		if shot, exists := shotByID[qualityIssue.TargetID]; exists {
			if repair, ok := filmShotRepair(qualityIssue, shot); ok {
				if len(repairs) >= maxFilmRepairProposals {
					return filmQualityReport{}, errors.New("film quality repair limit reached")
				}
				repairs = append(repairs, repair)
			}
		}
	}
	return filmQualityReport{ID: stableFilmID("quality", document.ProjectID, document.Revision), Revision: 1, CreatedAt: document.UpdatedAt, Issues: issues, Repairs: repairs}, nil
}

func applyFilmRepair(document filmDocument, repairID string) (filmDocument, error) {
	var repair *filmRepairProposal
	for reportIndex := range document.QualityReports {
		for repairIndex := range document.QualityReports[reportIndex].Repairs {
			candidate := &document.QualityReports[reportIndex].Repairs[repairIndex]
			if candidate.ID == repairID {
				repair = candidate
				break
			}
		}
	}
	if repair == nil {
		return filmDocument{}, errors.New("repair not found")
	}
	if !repair.Approved {
		return filmDocument{}, errors.New("repair is not user approved")
	}
	next := cloneFilmDocument(document)
	for index, shot := range next.Shots {
		if shot.ID != repair.TargetID {
			continue
		}
		if shot.Revision != repair.ExpectedRevision {
			return filmDocument{}, errors.New("repair revision conflict")
		}
		for key, value := range repair.Patch {
			switch key {
			case "title":
				shot.Title, _ = value.(string)
			case "description":
				shot.Description, _ = value.(string)
			case "durationSeconds":
				shot.DurationSeconds, _ = value.(float64)
			case "aspectRatio":
				shot.AspectRatio, _ = value.(string)
			case "subtitle":
				shot.Subtitle, _ = value.(string)
			case "status":
				shot.Status, _ = value.(string)
			}
		}
		shot.Revision++
		next.Shots[index] = shot
		next.Revision++
		now := time.Now().UTC().Format(time.RFC3339Nano)
		for reportIndex := range next.QualityReports {
			for repairIndex := range next.QualityReports[reportIndex].Repairs {
				if next.QualityReports[reportIndex].Repairs[repairIndex].ID == repairID {
					next.QualityReports[reportIndex].Repairs[repairIndex].AppliedAt = now
				}
			}
		}
		return invalidateFilmStages(next, "script", now), nil
	}
	return filmDocument{}, errors.New("repair target not found")
}

func normalizeFilmOrdering(document *filmDocument) {
	sort.SliceStable(document.Episodes, func(i, j int) bool { return document.Episodes[i].Order < document.Episodes[j].Order })
	sort.SliceStable(document.Scenes, func(i, j int) bool { return document.Scenes[i].Order < document.Scenes[j].Order })
	sort.SliceStable(document.Shots, func(i, j int) bool { return document.Shots[i].Order < document.Shots[j].Order })
}

var filmStageDependencies = map[string][]string{
	"decompose":  {},
	"script":     {"decompose"},
	"storyboard": {"script"},
	"audio":      {"storyboard"},
	"video":      {"storyboard"},
	"compose":    {"audio", "video"},
	"delivery":   {"compose"},
}

func filmStageAffectedBy(stageID, changedStageID string) bool {
	if stageID == changedStageID {
		return true
	}
	for _, dependency := range filmStageDependencies[stageID] {
		if filmStageAffectedBy(dependency, changedStageID) {
			return true
		}
	}
	return false
}

func invalidateFilmStages(document filmDocument, changedStageID, now string) filmDocument {
	next := cloneFilmDocument(document)
	affected := map[string]struct{}{}
	for index, stage := range next.Stages {
		if !filmStageAffectedBy(stage.ID, changedStageID) {
			continue
		}
		affected[stage.ID] = struct{}{}
		if stage.Status == filmStatusDraft && stage.Error == "" {
			continue
		}
		stage.Status = filmStatusDraft
		stage.Error = ""
		stage.Revision++
		stage.UpdatedAt = now
		next.Stages[index] = stage
	}
	for index, task := range next.Tasks {
		if _, ok := affected[task.Stage]; !ok || (task.Status != filmStatusRunning && task.Status != filmStatusNeedsReview) {
			continue
		}
		task.Status = filmStatusCanceled
		task.Progress = 0
		task.Revision++
		task.UpdatedAt = now
		next.Tasks[index] = task
	}
	return next
}

func validateFilmAggregateLimits(document filmDocument) error {
	entityCount := len(document.Episodes) + len(document.Scenes) + len(document.Shots) + len(document.Assets)
	if entityCount > maxFilmEntities {
		return errors.New("film aggregate entity limit reached")
	}
	if len(document.Tasks) > 1_000 || len(document.QualityReports) > 20 || len(document.Deliverables) > 100 {
		return errors.New("film aggregate retention limit reached")
	}
	issues, repairs := 0, 0
	for _, report := range document.QualityReports {
		issues += len(report.Issues)
		repairs += len(report.Repairs)
		if issues > maxFilmQualityIssues || repairs > maxFilmRepairProposals {
			return errors.New("film quality report nested limit reached")
		}
	}
	if len(document.Source.Text) > maxFilmSourceBytes {
		return errors.New("film source exceeds its limit")
	}
	return validateFilmTimeline(document.Timeline)
}

func findFilmStage(document filmDocument, stageID string) (int, filmStage, error) {
	if _, supported := filmStageDependencies[stageID]; !supported {
		return -1, filmStage{}, errors.New("film stage is unsupported")
	}
	for index, stage := range document.Stages {
		if stage.ID == stageID {
			return index, stage, nil
		}
	}
	return -1, filmStage{}, errors.New("film stage is missing")
}

func validateFilmStageDependencies(document filmDocument, stageID string) error {
	for _, dependencyID := range filmStageDependencies[stageID] {
		_, dependency, err := findFilmStage(document, dependencyID)
		if err != nil {
			return err
		}
		if dependency.Status != filmStatusApproved {
			return fmt.Errorf("stage %s requires approved stage %s", stageID, dependencyID)
		}
	}
	return nil
}

func validateFilmStageReadiness(document filmDocument, stageID string) error {
	switch stageID {
	case "decompose":
		if strings.TrimSpace(document.Source.Text) == "" || len(document.Episodes) == 0 || len(document.Scenes) == 0 || len(document.Shots) == 0 {
			return errors.New("decompose requires an imported manuscript with episodes, scenes, and shots")
		}
	case "script":
		if len(document.Episodes) == 0 || len(document.Scenes) == 0 || len(document.Shots) == 0 {
			return errors.New("script requires episodes, scenes, and shots")
		}
	case "storyboard":
		for _, shot := range document.Shots {
			if strings.TrimSpace(shot.ImageStorageKey) == "" {
				return fmt.Errorf("storyboard requires image media for shot %s", shot.ID)
			}
		}
	case "audio":
		for _, shot := range document.Shots {
			if strings.TrimSpace(shot.AudioStorageKey) == "" {
				return fmt.Errorf("audio requires audio media for shot %s", shot.ID)
			}
		}
	case "video":
		for _, shot := range document.Shots {
			if strings.TrimSpace(shot.VideoStorageKey) == "" {
				return fmt.Errorf("video requires video media for shot %s", shot.ID)
			}
		}
	case "compose":
		if document.Timeline.Revision <= 1 {
			return errors.New("compose requires a valid persisted timeline")
		}
		if err := validateFilmTimeline(document.Timeline); err != nil {
			return fmt.Errorf("compose requires a valid persisted timeline: %w", err)
		}
	case "delivery":
		for _, deliverable := range document.Deliverables {
			if deliverable.Status == filmStatusApproved && deliverable.Bytes > 0 && (deliverable.Content != "" || deliverable.StorageKey != "") {
				return nil
			}
		}
		return errors.New("delivery requires a real deliverable")
	}
	return nil
}

func updateFilmStage(document filmDocument, stageID, action string, expectedRevision int, now string) (filmDocument, error) {
	index, stage, err := findFilmStage(document, stageID)
	if err != nil {
		return filmDocument{}, err
	}
	if stage.Revision != expectedRevision {
		return filmDocument{}, errors.New("stage revision conflict")
	}
	next := cloneFilmDocument(document)
	switch action {
	case "run":
		if err := validateFilmStageDependencies(document, stageID); err != nil {
			return filmDocument{}, err
		}
		if err := validateFilmStageReadiness(document, stageID); err != nil {
			return filmDocument{}, err
		}
		if stage.Status == filmStatusRunning || stage.Status == filmStatusApproved {
			return filmDocument{}, errors.New("stage cannot run from its current state")
		}
		stage.Status = filmStatusNeedsReview
		stage.Error = ""
		task := filmTask{
			ID: stableFilmID("task", document.ProjectID, stageID, document.Revision), Revision: 1,
			Stage: stageID, Title: "Prepare " + stageID + " review", Status: filmStatusNeedsReview,
			Progress: 0, CreatedAt: now, UpdatedAt: now,
		}
		next.Tasks = append(next.Tasks, task)
		if len(next.Tasks) > 1_000 {
			next.Tasks = next.Tasks[len(next.Tasks)-1_000:]
		}
	case "approve":
		if stage.Status != filmStatusNeedsReview {
			return filmDocument{}, errors.New("only a review-ready stage can be approved")
		}
		stage.Status = filmStatusApproved
		stage.Error = ""
	case "reject":
		if stage.Status != filmStatusNeedsReview {
			return filmDocument{}, errors.New("only a review-ready stage can be rejected")
		}
		stage.Status = filmStatusDraft
		stage.Error = "Rejected for revision"
	default:
		return filmDocument{}, errors.New("film stage action is unsupported")
	}
	stage.Revision++
	stage.UpdatedAt = now
	next.Stages[index] = stage
	next.Revision++
	next.UpdatedAt = now
	return next, nil
}
