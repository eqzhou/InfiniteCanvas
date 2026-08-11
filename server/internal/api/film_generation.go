package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmShotRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type filmEpisodeRange struct {
	From int `json:"from"`
	To   int `json:"to"`
}

type filmGenerationConfig struct {
	Size                 string   `json:"size,omitempty"`
	Quality              string   `json:"quality,omitempty"`
	Ratio                string   `json:"ratio,omitempty"`
	Resolution           string   `json:"resolution,omitempty"`
	Seconds              int      `json:"seconds,omitempty"`
	GenerateAudio        bool     `json:"generateAudio,omitempty"`
	Watermark            bool     `json:"watermark,omitempty"`
	NegativePrompt       string   `json:"negativePrompt,omitempty"`
	FrameMode            string   `json:"frameMode,omitempty"`
	ReferenceStorageKeys []string `json:"referenceStorageKeys,omitempty"`
	Voice                string   `json:"voice,omitempty"`
	Format               string   `json:"format,omitempty"`
	Speed                float64  `json:"speed,omitempty"`
	Instructions         string   `json:"instructions,omitempty"`
}

type filmGenerationRunRequest struct {
	Revision       int                  `json:"revision"`
	ShotIDs        []string             `json:"shotIds,omitempty"`
	ShotRange      *filmShotRange       `json:"shotRange,omitempty"`
	EpisodeRange   *filmEpisodeRange    `json:"episodeRange,omitempty"`
	ProviderID     string               `json:"providerId,omitempty"`
	Model          string               `json:"model,omitempty"`
	Config         filmGenerationConfig `json:"config,omitempty"`
	IdempotencyKey string               `json:"idempotencyKey"`
}

type filmGenerationBinding struct {
	ProjectID             string `json:"projectId"`
	Stage                 string `json:"stage"`
	ShotID                string `json:"shotId"`
	DialogueID            string `json:"dialogueId,omitempty"`
	TaskID                string `json:"taskId"`
	ParentGenerationJobID string `json:"parentGenerationJobId,omitempty"`
	RequestHash           string `json:"requestHash"`
}

type filmGenerationTarget struct {
	Shot     filmShot
	Dialogue *filmDialogue
}

func filmGenerationTargets(document filmDocument, stage string, shots []filmShot) []filmGenerationTarget {
	if stage != "audio" {
		targets := make([]filmGenerationTarget, len(shots))
		for index, shot := range shots {
			targets[index] = filmGenerationTarget{Shot: shot}
		}
		return targets
	}
	targets := make([]filmGenerationTarget, 0, len(document.Dialogues))
	for _, shot := range shots {
		dialogues := make([]filmDialogue, 0)
		for _, dialogue := range document.Dialogues {
			if dialogue.ShotID == shot.ID {
				dialogues = append(dialogues, dialogue)
			}
		}
		sort.SliceStable(dialogues, func(i, j int) bool { return dialogues[i].Order < dialogues[j].Order })
		for index := range dialogues {
			dialogue := dialogues[index]
			targets = append(targets, filmGenerationTarget{Shot: shot, Dialogue: &dialogue})
		}
	}
	return targets
}

func filmGenerationTargetID(target filmGenerationTarget) string {
	if target.Dialogue != nil {
		return target.Dialogue.ID
	}
	return target.Shot.ID
}

func filmTaskTargetID(task filmTask) string {
	if task.DialogueID != "" {
		return task.DialogueID
	}
	return task.ShotID
}

type filmStageGenerationParameters struct {
	Executor         string   `json:"executor"`
	ProjectID        string   `json:"projectId"`
	Stage            string   `json:"stage"`
	RequestHash      string   `json:"requestHash"`
	ChildJobIDs      []string `json:"childJobIds"`
	ChildCredits     []int    `json:"childCredits,omitempty"`
	EstimatedCredits int      `json:"estimatedCredits,omitempty"`
}

type filmStageGenerationResult struct {
	Outcome       string  `json:"outcome"`
	Total         int     `json:"total"`
	Queued        int     `json:"queued"`
	Running       int     `json:"running"`
	Succeeded     int     `json:"succeeded"`
	Failed        int     `json:"failed"`
	Cancelled     int     `json:"cancelled"`
	Progress      float64 `json:"progress"`
	ActualCredits int     `json:"actualCredits,omitempty"`
}

func validFilmIdempotencyKey(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

func filmStageGenerationKind(stage string) string {
	switch stage {
	case "storyboard", "first_frame", "last_frame":
		return "image"
	case "audio", "video":
		return stage
	default:
		return ""
	}
}

func filmTaskGenerationKind(stage string) string {
	if stage == "decompose" || stage == "script" {
		return "text"
	}
	return filmStageGenerationKind(stage)
}

func selectFilmGenerationShots(document filmDocument, input filmGenerationRunRequest) ([]filmShot, error) {
	if len(input.ShotIDs) > 1_000 || len(input.ShotIDs) > 0 && (input.ShotRange != nil || input.EpisodeRange != nil) {
		return nil, errors.New("choose either shotIds or production ranges within the shot limit")
	}
	selected := make(map[string]struct{})
	for _, id := range input.ShotIDs {
		if !validProjectID(id) {
			return nil, errors.New("shotIds contains an invalid id")
		}
		if _, duplicate := selected[id]; duplicate {
			return nil, errors.New("shotIds must be unique")
		}
		selected[id] = struct{}{}
	}
	if input.ShotRange != nil {
		if input.ShotRange.Start < 0 || input.ShotRange.End < input.ShotRange.Start || input.ShotRange.End > maxFilmEntities {
			return nil, errors.New("shotRange is invalid")
		}
	}
	if input.EpisodeRange != nil && (input.EpisodeRange.From < 0 || input.EpisodeRange.To < input.EpisodeRange.From || input.EpisodeRange.To > maxFilmEntities) {
		return nil, errors.New("episodeRange is invalid")
	}
	explicitRange := input.ShotRange != nil || input.EpisodeRange != nil
	episodeOrders := make(map[string]int, len(document.Episodes))
	for _, episode := range document.Episodes {
		episodeOrders[episode.ID] = episode.Order
	}
	sceneEpisodes := make(map[string]string, len(document.Scenes))
	for _, scene := range document.Scenes {
		sceneEpisodes[scene.ID] = scene.EpisodeID
	}
	if explicitRange {
		for _, shot := range document.Shots {
			if input.ShotRange != nil && (shot.Order < input.ShotRange.Start || shot.Order > input.ShotRange.End) {
				continue
			}
			if input.EpisodeRange != nil {
				order, ok := episodeOrders[sceneEpisodes[shot.SceneID]]
				if !ok || order < input.EpisodeRange.From || order > input.EpisodeRange.To {
					continue
				}
			}
			selected[shot.ID] = struct{}{}
		}
	}
	if len(selected) == 0 && !explicitRange && len(input.ShotIDs) == 0 {
		for _, shot := range document.Shots {
			selected[shot.ID] = struct{}{}
		}
	}
	shots := make([]filmShot, 0, len(selected))
	for _, shot := range document.Shots {
		if _, ok := selected[shot.ID]; ok {
			shots = append(shots, shot)
			delete(selected, shot.ID)
		}
	}
	if len(selected) > 0 || len(shots) == 0 {
		return nil, errors.New("generation selection contains an unavailable shot")
	}
	sort.SliceStable(shots, func(i, j int) bool {
		if shots[i].Order == shots[j].Order {
			return shots[i].ID < shots[j].ID
		}
		return shots[i].Order < shots[j].Order
	})
	return shots, nil
}

func validateFilmGenerationConfig(stage string, config filmGenerationConfig) error {
	if len(config.ReferenceStorageKeys) > 16 || len(config.Size) > 32 || len(config.Quality) > 50 ||
		len(config.Ratio) > 16 || len(config.Resolution) > 16 || len(config.NegativePrompt) > 2_500 ||
		len(config.Voice) > 100 || len(config.Format) > 16 || len(config.Instructions) > 4_000 ||
		math.IsNaN(config.Speed) || math.IsInf(config.Speed, 0) || config.Speed < 0 || config.Speed > 4 {
		return errors.New("generation config exceeds its limits")
	}
	for _, key := range config.ReferenceStorageKeys {
		if _, ok := blobFilename(key); !ok {
			return errors.New("generation config contains an invalid reference storage key")
		}
	}
	if (stage == "storyboard" || stage == "first_frame" || stage == "last_frame") && config.Size != "" && !imageSizePattern.MatchString(config.Size) {
		return errors.New("storyboard size is invalid")
	}
	if stage == "video" && (config.Seconds < 0 || config.Seconds > 15) {
		return errors.New("video seconds is invalid")
	}
	if stage == "video" && config.FrameMode != "" && config.FrameMode != "references" && config.FrameMode != "first-last" {
		return errors.New("video frame mode is invalid")
	}
	return nil
}

func filmGenerationRequestHash(projectID, stage string, shots []filmShot, input filmGenerationRunRequest) (string, error) {
	targets := make([]filmGenerationTarget, len(shots))
	for index, shot := range shots {
		targets[index] = filmGenerationTarget{Shot: shot}
	}
	return filmGenerationTargetRequestHash(projectID, stage, targets, input)
}

func filmGenerationTargetRequestHash(projectID, stage string, targets []filmGenerationTarget, input filmGenerationRunRequest) (string, error) {
	shotIDs := make([]string, len(targets))
	dialogues := make([]filmDialogue, 0, len(targets))
	for index, target := range targets {
		shotIDs[index] = target.Shot.ID
		if target.Dialogue != nil {
			dialogues = append(dialogues, *target.Dialogue)
		}
	}
	canonical := struct {
		ProjectID      string               `json:"projectId"`
		Stage          string               `json:"stage"`
		ShotIDs        []string             `json:"shotIds"`
		Dialogues      []filmDialogue       `json:"dialogues,omitempty"`
		ProviderID     string               `json:"providerId"`
		Model          string               `json:"model"`
		Config         filmGenerationConfig `json:"config"`
		IdempotencyKey string               `json:"idempotencyKey"`
	}{projectID, stage, shotIDs, dialogues, strings.TrimSpace(input.ProviderID), strings.TrimSpace(input.Model), input.Config, strings.TrimSpace(input.IdempotencyKey)}
	return hashGenerationInput(canonical)
}

func buildFilmStageGenerationJob(projectID, stage, parentJobID, requestHash, now string, childJobIDs []string, childCredits []int) (store.GenerationJob, error) {
	if len(childCredits) != len(childJobIDs) {
		return store.GenerationJob{}, errors.New("Film stage child credit quote is invalid")
	}
	estimatedCredits := 0
	for _, credits := range childCredits {
		if credits < 1 || estimatedCredits > 1_000_000_000-credits {
			return store.GenerationJob{}, errors.New("Film stage child credit quote is invalid")
		}
		estimatedCredits += credits
	}
	parameters, err := json.Marshal(filmStageGenerationParameters{
		Executor: "film-stage", ProjectID: projectID, Stage: stage, RequestHash: requestHash,
		ChildJobIDs: append([]string(nil), childJobIDs...), ChildCredits: append([]int(nil), childCredits...), EstimatedCredits: estimatedCredits,
	})
	if err != nil {
		return store.GenerationJob{}, err
	}
	result, err := json.Marshal(filmStageGenerationResult{Outcome: "queued", Total: len(childJobIDs), Queued: len(childJobIDs)})
	if err != nil {
		return store.GenerationJob{}, err
	}
	return store.GenerationJob{
		ID: parentJobID, ProjectID: projectID, Kind: "film-stage", Status: "queued",
		Prompt: "", Parameters: parameters, Result: result, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func aggregateFilmStageGenerationJob(parent store.GenerationJob, children []store.GenerationJob) (store.GenerationJob, error) {
	var parameters filmStageGenerationParameters
	if parent.Kind != "film-stage" || json.Unmarshal(parent.Parameters, &parameters) != nil || parameters.Executor != "film-stage" || len(parameters.ChildJobIDs) == 0 || len(children) != len(parameters.ChildJobIDs) {
		return store.GenerationJob{}, errors.New("Film stage parent job is invalid")
	}
	if parent.Status == "cancelled" || parent.Status == "canceled" || parent.Status == "deleted" {
		return parent, nil
	}
	byID := make(map[string]store.GenerationJob, len(children))
	for _, child := range children {
		byID[child.ID] = child
	}
	result := filmStageGenerationResult{Total: len(parameters.ChildJobIDs)}
	progressUnits := 0.0
	latestUpdatedAt := parent.UpdatedAt
	for childIndex, childID := range parameters.ChildJobIDs {
		child, ok := byID[childID]
		if !ok {
			return store.GenerationJob{}, errors.New("Film stage child job is unavailable")
		}
		expectedCredits := 0
		if len(parameters.ChildCredits) == len(parameters.ChildJobIDs) {
			expectedCredits = parameters.ChildCredits[childIndex]
		}
		if !filmStageChildMatches(parent.ID, parameters, child, expectedCredits) {
			return store.GenerationJob{}, errors.New("Film stage child job binding is invalid")
		}
		if child.UpdatedAt > latestUpdatedAt {
			latestUpdatedAt = child.UpdatedAt
		}
		switch child.Status {
		case "queued":
			result.Queued++
		case "running":
			result.Running++
			progressUnits += 0.5
		case "succeeded":
			result.Succeeded++
			if len(parameters.ChildCredits) == len(parameters.ChildJobIDs) {
				result.ActualCredits += parameters.ChildCredits[childIndex]
			}
			progressUnits++
		case "failed":
			result.Failed++
			progressUnits++
		case "cancelled", "canceled":
			result.Cancelled++
			progressUnits++
		default:
			return store.GenerationJob{}, errors.New("Film stage child job status is invalid")
		}
	}
	result.Progress = progressUnits / float64(result.Total)
	switch {
	case result.Queued == result.Total:
		parent.Status, result.Outcome = "queued", "queued"
	case result.Queued+result.Running > 0:
		parent.Status, result.Outcome = "running", "running"
	case result.Succeeded == result.Total:
		parent.Status, result.Outcome = "succeeded", "succeeded"
	case result.Cancelled == result.Total:
		parent.Status, result.Outcome = "cancelled", "cancelled"
	case result.Succeeded > 0 || (result.Failed > 0 && result.Cancelled > 0):
		parent.Status, result.Outcome = "failed", "partial_failure"
	default:
		parent.Status, result.Outcome = "failed", "failed"
	}
	parent.Error = ""
	if parent.Status == "failed" {
		parent.Error = "One or more Film generation jobs failed"
	}
	parent.Result, _ = json.Marshal(result)
	parent.UpdatedAt = latestUpdatedAt
	return parent, nil
}

func filmStageChildMatches(parentID string, parameters filmStageGenerationParameters, child store.GenerationJob, expectedCredits int) bool {
	binding, requestHash := filmJobBinding(child)
	credits, hasCredits := filmGenerationJobCreditQuote(child)
	quoteMatches := expectedCredits == 0 || hasCredits && credits == expectedCredits
	return child.ProjectID == parameters.ProjectID && child.Kind == filmStageGenerationKind(parameters.Stage) && binding != nil && binding.ProjectID == parameters.ProjectID &&
		binding.ParentGenerationJobID == parentID && binding.Stage == parameters.Stage && binding.RequestHash == parameters.RequestHash && requestHash == parameters.RequestHash && quoteMatches
}

func filmGenerationJobCreditQuote(job store.GenerationJob) (int, bool) {
	switch job.Kind {
	case "image":
		var parameters persistedImageJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.EstimatedCredits < 1 {
			return 0, false
		}
		return parameters.EstimatedCredits, true
	case "video", "audio":
		var parameters persistedMediaJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.EstimatedCredits < 1 {
			return 0, false
		}
		return parameters.EstimatedCredits, true
	default:
		return 0, false
	}
}

func (s *Server) filmStageGenerationView(ctx context.Context, tenantID string, parent store.GenerationJob) store.GenerationJob {
	if parent.Kind != "film-stage" {
		return parent
	}
	var parameters filmStageGenerationParameters
	if json.Unmarshal(parent.Parameters, &parameters) != nil || len(parameters.ChildJobIDs) == 0 || len(parameters.ChildJobIDs) > 1_000 {
		return parent
	}
	children := make([]store.GenerationJob, 0, len(parameters.ChildJobIDs))
	for _, childID := range parameters.ChildJobIDs {
		child, err := s.store.GetGenerationJob(ctx, tenantID, childID)
		if err != nil {
			return parent
		}
		children = append(children, child)
	}
	aggregated, err := aggregateFilmStageGenerationJob(parent, children)
	if err != nil {
		return parent
	}
	return aggregated
}

func orderedFilmVideoReferences(shot filmShot, configured []string) []string {
	ordered := make([]string, 0, len(configured)+2)
	seen := make(map[string]struct{}, len(configured)+2)
	appendUnique := func(key string) {
		if key == "" {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		ordered = append(ordered, key)
	}
	appendUnique(shot.FirstFrameStorageKey)
	appendUnique(shot.LastFrameStorageKey)
	for _, key := range configured {
		appendUnique(key)
	}
	return ordered
}

func findFilmIdempotentTasks(document filmDocument, stage, idempotencyKey, requestHash string, targets []filmGenerationTarget) ([]filmTask, bool, error) {
	wanted := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		wanted[filmGenerationTargetID(target)] = struct{}{}
	}
	found := make(map[string]filmTask, len(targets))
	for _, task := range document.Tasks {
		if task.Stage != stage || task.IdempotencyKey != idempotencyKey {
			continue
		}
		if task.RequestHash != requestHash {
			return nil, false, errors.New("idempotency key belongs to a different generation request")
		}
		if _, ok := wanted[filmTaskTargetID(task)]; ok {
			found[filmTaskTargetID(task)] = task
		}
	}
	if len(found) == 0 {
		return nil, false, nil
	}
	if len(found) != len(wanted) {
		return nil, false, errors.New("idempotent generation request is incomplete; sync before retrying")
	}
	result := make([]filmTask, 0, len(found))
	for _, target := range targets {
		result = append(result, found[filmGenerationTargetID(target)])
	}
	return result, true, nil
}

func (s *Server) validateFilmGenerationReferences(ctx context.Context, tenantID, stage string, keys []string) error {
	if stage == "storyboard" || stage == "first_frame" || stage == "last_frame" {
		for _, key := range keys {
			if _, err := s.readTenantImageBlobContext(ctx, tenantID, key); err != nil {
				return errors.New("storyboard references must be tenant-owned PNG or JPEG media")
			}
		}
		return nil
	}
	if stage == "video" {
		if err := s.validateVideoReferenceKeys(ctx, tenantID, keys); err != nil {
			return errors.New("video references are invalid or exceed limits")
		}
	}
	return nil
}

func (s *Server) filmGenerationProvider(ctx context.Context, tenantID, stage, providerID, model string) (string, string) {
	providerID = strings.TrimSpace(providerID)
	model = strings.TrimSpace(model)
	if providerID != "" {
		return providerID, model
	}
	var config storedImageConfig
	raw, err := s.store.GetState(ctx, tenantID, "config")
	if err == nil && len(raw) <= 1<<20 && json.Unmarshal(raw, &config) == nil {
		providerID = config.ActiveChannelID
		for _, channel := range config.Channels {
			if channel.ID != providerID || model != "" {
				continue
			}
			switch stage {
			case "storyboard", "first_frame", "last_frame":
				model = channel.DefaultImageModel
			case "video":
				model = channel.DefaultVideoModel
			case "audio":
				model = channel.DefaultAudioModel
			}
		}
	}
	if providerID == "" {
		providerID = sharedChannelAutoID
	}
	return providerID, model
}

func buildFilmGenerationJob(stage string, shot filmShot, projectID, providerID, model, taskID, parentJobID, jobID, requestHash string, config filmGenerationConfig, shared *generationChannelSnapshot, now string) (store.GenerationJob, error) {
	return buildFilmGenerationTargetJob(stage, shot, nil, projectID, providerID, model, taskID, parentJobID, jobID, requestHash, config, shared, now)
}

func buildFilmGenerationTargetJob(stage string, shot filmShot, dialogue *filmDialogue, projectID, providerID, model, taskID, parentJobID, jobID, requestHash string, config filmGenerationConfig, shared *generationChannelSnapshot, now string) (store.GenerationJob, error) {
	dialogueID := ""
	if dialogue != nil {
		dialogueID = dialogue.ID
	}
	binding := &filmGenerationBinding{ProjectID: projectID, Stage: stage, ShotID: shot.ID, DialogueID: dialogueID, TaskID: taskID, ParentGenerationJobID: parentJobID, RequestHash: requestHash}
	prompt := strings.TrimSpace(shot.Description)
	job := store.GenerationJob{ID: jobID, ProjectID: projectID, Kind: filmStageGenerationKind(stage), Status: "queued", Prompt: prompt, ProviderID: providerID, Model: model, Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now}
	switch stage {
	case "storyboard", "first_frame", "last_frame":
		size := config.Size
		if size == "" {
			size = "1024x1024"
		}
		parameters, err := json.Marshal(persistedImageJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Size: size, Quality: config.Quality, Count: 1, ReferenceStorageKeys: append([]string(nil), config.ReferenceStorageKeys...), SharedChannel: shared, Film: binding})
		if err != nil {
			return store.GenerationJob{}, err
		}
		job.Parameters = parameters
	case "video":
		ratio := config.Ratio
		if ratio == "" {
			ratio = shot.AspectRatio
		}
		resolution := config.Resolution
		if resolution == "" {
			resolution = "720p"
		}
		seconds := config.Seconds
		if seconds == 0 {
			seconds = maxInt(1, minInt(15, int(math.Ceil(shot.DurationSeconds))))
		}
		resolvedMode, resolveErr := resolveVideoGenerationMode(config.FrameMode, len(config.ReferenceStorageKeys), 0)
		if resolveErr != nil {
			return store.GenerationJob{}, resolveErr
		}
		parameters, err := json.Marshal(persistedMediaJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Ratio: ratio, Resolution: resolution, Seconds: seconds, GenerateAudio: config.GenerateAudio, Watermark: config.Watermark, FrameMode: normalizeVideoFrameMode(config.FrameMode), NegativePrompt: config.NegativePrompt, ReferenceStorageKeys: append([]string(nil), config.ReferenceStorageKeys...), ResolvedMode: resolvedMode, SharedChannel: shared, Film: binding})
		if err != nil {
			return store.GenerationJob{}, err
		}
		job.Parameters = parameters
	case "audio":
		voice := config.Voice
		if voice == "" {
			voice = "alloy"
		}
		format := config.Format
		if format == "" {
			format = "mp3"
		}
		if dialogue != nil {
			job.Prompt = strings.TrimSpace(dialogue.Text)
		} else if strings.TrimSpace(shot.Subtitle) != "" {
			job.Prompt = strings.TrimSpace(shot.Subtitle)
		}
		parameters, err := json.Marshal(persistedMediaJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Voice: voice, Format: format, Speed: config.Speed, Instructions: config.Instructions, SharedChannel: shared, Film: binding})
		if err != nil {
			return store.GenerationJob{}, err
		}
		job.Parameters = parameters
	default:
		return store.GenerationJob{}, errors.New("film generation stage is unsupported")
	}
	return job, nil
}

func setFilmGenerationJobCreditQuote(job *store.GenerationJob, credits int) error {
	if credits < 1 || credits > 1_000_000_000 {
		return errors.New("Film generation credit quote is invalid")
	}
	switch job.Kind {
	case "text":
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil {
			return errors.New("Film text generation parameters are invalid")
		}
		parameters.EstimatedCredits = credits
		job.Parameters, _ = json.Marshal(parameters)
	case "image":
		var parameters persistedImageJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil {
			return errors.New("Film image generation parameters are invalid")
		}
		parameters.EstimatedCredits = credits
		job.Parameters, _ = json.Marshal(parameters)
	case "video", "audio":
		var parameters persistedMediaJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil {
			return errors.New("Film media generation parameters are invalid")
		}
		parameters.EstimatedCredits = credits
		job.Parameters, _ = json.Marshal(parameters)
	default:
		return errors.New("Film generation kind is invalid")
	}
	return nil
}

func buildFilmGenerationSnapshot(document filmDocument, shot filmShot, providerID, model string, config filmGenerationConfig, now string) *filmGenerationSnapshot {
	return buildFilmGenerationSnapshotWithCapability(document, shot, providerID, model, config, now, "", "")
}

func buildFilmGenerationSnapshotWithCapability(document filmDocument, shot filmShot, providerID, model string, config filmGenerationConfig, now, capabilityVersion, generationMode string) *filmGenerationSnapshot {
	return buildFilmGenerationTargetSnapshotWithCapability(document, shot, nil, providerID, model, config, now, capabilityVersion, generationMode)
}

func buildFilmGenerationTargetSnapshotWithCapability(document filmDocument, shot filmShot, dialogue *filmDialogue, providerID, model string, config filmGenerationConfig, now, capabilityVersion, generationMode string) *filmGenerationSnapshot {
	identities := make([]filmAsset, 0, len(shot.IdentityVersionIDs))
	wanted := make(map[string]struct{}, len(shot.IdentityVersionIDs))
	for _, id := range shot.IdentityVersionIDs {
		wanted[id] = struct{}{}
	}
	var style *filmAsset
	scenes := make(map[string]filmScene, len(document.Scenes))
	for _, scene := range document.Scenes {
		scenes[scene.ID] = scene
	}
	for _, asset := range document.Assets {
		if _, ok := wanted[asset.ID]; ok && filmIdentityAppliesToShot(asset, shot, scenes) {
			identities = append(identities, asset)
		}
		if shot.StyleAssetID != "" && asset.ID == shot.StyleAssetID && asset.Kind == "style" {
			copy := asset
			style = &copy
		}
	}
	sort.SliceStable(identities, func(i, j int) bool { return identities[i].ID < identities[j].ID })
	prompt := strings.TrimSpace(shot.Description)
	if dialogue != nil {
		prompt = strings.TrimSpace(dialogue.Text)
	}
	if strings.TrimSpace(shot.Subtitle) != "" && config.Format != "" {
		prompt = strings.TrimSpace(shot.Subtitle)
	}
	cloneDirectorSource := func(source *filmDirectorSource) *filmDirectorSource {
		if source == nil {
			return nil
		}
		copy := *source
		copy.Snapshot = append(json.RawMessage(nil), source.Snapshot...)
		return &copy
	}
	return &filmGenerationSnapshot{
		ShotRevision: shot.Revision, DialogueVersion: dialogue, Prompt: prompt, ProviderID: providerID, Model: model,
		CapabilityVersion: capabilityVersion, GenerationMode: generationMode,
		Config: config, IdentityVersions: identities, StyleVersion: style,
		StoryboardDirectorSource: cloneDirectorSource(shot.StoryboardDirectorSource),
		FirstFrameDirectorSource: cloneDirectorSource(shot.FirstFrameDirectorSource),
		LastFrameDirectorSource:  cloneDirectorSource(shot.LastFrameDirectorSource),
		ReferenceStorageKeys:     append([]string(nil), config.ReferenceStorageKeys...),
		EstimatedGenerations:     1, EstimatedCredits: 1, CreatedAt: now,
	}
}

func filmDialogueAudioInputs(document filmDocument, target filmGenerationTarget, config filmGenerationConfig) (filmShot, filmGenerationConfig) {
	shot := target.Shot
	if target.Dialogue == nil {
		return filmAudioInputs(document, shot, config)
	}
	dialogue := *target.Dialogue
	shot.Subtitle = strings.TrimSpace(dialogue.Text)
	if config.Voice == "" && dialogue.VoiceAssetID != "" {
		for _, asset := range document.Assets {
			if asset.ID == dialogue.VoiceAssetID && asset.Kind == "voice" {
				config.Voice = asset.Voice
				break
			}
		}
	}
	if config.Instructions == "" && strings.TrimSpace(dialogue.Emotion) != "" {
		config.Instructions = "Emotion direction: " + strings.TrimSpace(dialogue.Emotion)
	}
	return shot, config
}

func filmGenerationMode(stage string, shot filmShot, config filmGenerationConfig) string {
	switch stage {
	case "storyboard", "first_frame", "last_frame":
		if len(config.ReferenceStorageKeys) > 0 || shot.StoryboardDirectorSource != nil || shot.FirstFrameDirectorSource != nil {
			return "image_to_image"
		}
		return "text_to_image"
	case "video":
		if len(config.ReferenceStorageKeys) > 0 || shot.FirstFrameStorageKey != "" || shot.LastFrameStorageKey != "" {
			return "image_to_video"
		}
		return "text_to_video"
	case "audio":
		return "text_to_audio"
	default:
		return ""
	}
}

func filmAudioInputs(document filmDocument, shot filmShot, config filmGenerationConfig) (filmShot, filmGenerationConfig) {
	dialogues := make([]filmDialogue, 0)
	for _, dialogue := range document.Dialogues {
		if dialogue.ShotID == shot.ID {
			dialogues = append(dialogues, dialogue)
		}
	}
	sort.SliceStable(dialogues, func(i, j int) bool { return dialogues[i].Order < dialogues[j].Order })
	lines := make([]string, 0, len(dialogues))
	for _, dialogue := range dialogues {
		lines = append(lines, strings.TrimSpace(dialogue.Text))
		if config.Voice == "" && dialogue.VoiceAssetID != "" {
			for _, asset := range document.Assets {
				if asset.ID == dialogue.VoiceAssetID && asset.Kind == "voice" {
					config.Voice = asset.Voice
					break
				}
			}
		}
	}
	if config.Instructions == "" {
		directions := make([]string, 0, len(dialogues))
		for _, dialogue := range dialogues {
			if emotion := strings.TrimSpace(dialogue.Emotion); emotion != "" {
				directions = append(directions, emotion)
			}
		}
		if len(directions) > 0 {
			config.Instructions = "Emotion direction: " + strings.Join(directions, "; ")
		}
	}
	if len(lines) > 0 {
		shot.Subtitle = strings.Join(lines, "\n")
	}
	return shot, config
}

func filmJobBinding(job store.GenerationJob) (*filmGenerationBinding, string) {
	if job.Kind == "text" {
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) == nil && parameters.Executor == serverExecutorMarker {
			return parameters.Film, parameters.RequestHash
		}
		return nil, ""
	}
	if job.Kind == "image" {
		var parameters persistedImageJobParameters
		if json.Unmarshal(job.Parameters, &parameters) == nil && parameters.Executor == serverExecutorMarker {
			return parameters.Film, parameters.RequestHash
		}
		return nil, ""
	}
	var parameters persistedMediaJobParameters
	if json.Unmarshal(job.Parameters, &parameters) == nil && parameters.Executor == serverExecutorMarker {
		return parameters.Film, parameters.RequestHash
	}
	return nil, ""
}

func matchingFilmGenerationJob(job store.GenerationJob, binding filmGenerationBinding) bool {
	storedBinding, requestHash := filmJobBinding(job)
	expectedKind := filmStageGenerationKind(binding.Stage)
	if binding.Stage == "decompose" || binding.Stage == "script" {
		expectedKind = "text"
	}
	return storedBinding != nil && requestHash == binding.RequestHash && *storedBinding == binding && job.ProjectID == binding.ProjectID && job.Kind == expectedKind
}

func filmGenerationStoreError(err error) error {
	switch {
	case errors.Is(err, store.ErrQuotaExceeded):
		return &toolError{status: http.StatusTooManyRequests, message: "generation quota exceeded"}
	case errors.Is(err, store.ErrInsufficientCredits):
		return &toolError{status: http.StatusPaymentRequired, message: "insufficient credits"}
	case errors.Is(err, store.ErrBanned):
		return &toolError{status: http.StatusForbidden, message: "account is unavailable"}
	case errors.Is(err, store.ErrGone):
		return &toolError{status: http.StatusGone, message: "generation job was previously deleted"}
	case errors.Is(err, store.ErrUnauthorized):
		return &toolError{status: http.StatusUnauthorized, message: "login required for billable generation"}
	default:
		return err
	}
}

func (s *Server) notifyFilmGenerationWorkers(stage string) {
	switch stage {
	case "storyboard", "first_frame", "last_frame":
		s.notifyGenerationWorkers()
	case "audio":
		s.notifyAudioWorkers()
	case "video":
		s.notifyVideoWorkers()
	}
}

func (s *Server) runFilmGenerationStage(w http.ResponseWriter, r *http.Request) {
	var input filmGenerationRunRequest
	if err := decodeFilmRequest(w, r, 256<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	stage := chi.URLParam(r, "stageId")
	if filmStageGenerationKind(stage) == "" || input.Revision < 1 || !validFilmIdempotencyKey(input.IdempotencyKey) || len(input.Model) > 500 || (input.ProviderID != "" && !validProjectID(input.ProviderID)) {
		writeFilmError(w, http.StatusUnprocessableEntity, "generation_request_invalid", "film generation request is invalid")
		return
	}
	checkedModels := map[string]bool{}
	requireAllowedModel := func(model string) bool {
		model = strings.TrimSpace(model)
		if allowed, checked := checkedModels[model]; checked {
			return allowed
		}
		allowed := s.requireAllowedModel(w, r, model)
		checkedModels[model] = allowed
		return allowed
	}
	if !requireAllowedModel(input.Model) {
		return
	}
	if err := validateFilmGenerationConfig(stage, input.Config); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	_, record, document, ok := s.loadFilmProduction(w, r, true)
	if !ok {
		return
	}
	stageIndex, currentStage, err := findFilmStage(document, stage)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	if err := validateFilmStageDependencies(document, stage); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	shots, err := selectFilmGenerationShots(document, input)
	if err != nil {
		writeFilmOperationError(w, err)
		return
	}
	targets := filmGenerationTargets(document, stage, shots)
	if stage == "audio" && len(targets) == 0 {
		writeFilmError(w, http.StatusUnprocessableEntity, "dialogue_required", "audio generation requires at least one dialogue in the selected shots")
		return
	}
	requestHash, err := filmGenerationTargetRequestHash(document.ProjectID, stage, targets, input)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "generation_request_invalid", "film generation request is invalid")
		return
	}
	if _, replay, replayErr := findFilmIdempotentTasks(document, stage, strings.TrimSpace(input.IdempotencyKey), requestHash, targets); replayErr != nil {
		writeFilmError(w, http.StatusConflict, "idempotency_conflict", replayErr.Error())
		return
	} else if replay {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
		return
	}
	if currentStage.Revision != input.Revision {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film stage revision conflict")
		return
	}
	if currentStage.Status == filmStatusApproved {
		writeFilmError(w, http.StatusConflict, "stage_state_conflict", "approved stage must be invalidated before regeneration")
		return
	}
	tenantID := tenantIDFrom(r)
	if err := s.validateFilmGenerationReferences(r.Context(), tenantID, stage, input.Config.ReferenceStorageKeys); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	providerID, model := s.filmGenerationProvider(r.Context(), tenantID, stage, input.ProviderID, input.Model)
	if !requireAllowedModel(model) {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	next := cloneFilmDocument(document)
	createdJobs := make([]string, 0, len(targets))
	atomicBackend, atomicBatch := s.store.(store.FilmGenerationBatchStore)
	if !atomicBatch {
		writeFilmError(w, http.StatusServiceUnavailable, "film_generation_atomic_store_required", "Film media generation requires atomic task persistence")
		return
	}
	parentJobID := stableFilmID("job-stage", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey))
	childJobIDs := make([]string, len(targets))
	for index, target := range targets {
		childJobIDs[index] = stableFilmID("job", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey), filmGenerationTargetID(target))
	}
	reservations := make([]store.FilmGenerationReservation, 0, len(targets)+1)
	childCredits := make([]int, len(targets))
	for targetIndex, target := range targets {
		shot := target.Shot
		jobShot, jobConfig := shot, input.Config
		if stage == "audio" {
			jobShot, jobConfig = filmDialogueAudioInputs(document, target, jobConfig)
		}
		if stage == "video" {
			var modeErr error
			jobConfig, _, modeErr = resolveFilmVideoConfig(shot, jobConfig)
			if modeErr != nil {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmError(w, http.StatusUnprocessableEntity, "generation_request_invalid", modeErr.Error())
				return
			}
			if err := s.validateFilmGenerationReferences(r.Context(), tenantID, stage, jobConfig.ReferenceStorageKeys); err != nil {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmOperationError(w, err)
				return
			}
		}
		targetID := filmGenerationTargetID(target)
		taskID := stableFilmID("task", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey), targetID)
		jobID := stableFilmID("job", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey), targetID)
		selectedProviderID, snapshot, snapshotErr := s.snapshotGenerationChannel(r.Context(), tenantID, filmStageGenerationKind(stage), jobID, providerID, model)
		if snapshotErr != nil {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			writeFilmError(w, http.StatusUnprocessableEntity, "provider_unavailable", "no eligible generation provider is available")
			return
		}
		selectedModel := model
		if snapshot != nil {
			selectedModel = snapshot.Model
		}
		if !requireAllowedModel(selectedModel) {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			return
		}
		unitCredits, creditErr := s.store.GetModelCreditCost(r.Context(), tenantID, selectedModel)
		if creditErr != nil || unitCredits < 1 || unitCredits > 1_000_000_000 {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			writeFilmError(w, http.StatusServiceUnavailable, "billing_unavailable", "Film generation credit quote is unavailable")
			return
		}
		childCredits[targetIndex] = unitCredits
		capabilityVersion, generationMode := "", ""
		if snapshot != nil {
			mediaCatalog, catalogErr := s.buildMediaCapabilityCatalog(r.Context(), tenantID)
			if catalogErr != nil {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmError(w, http.StatusServiceUnavailable, "media_capabilities_unavailable", "media capability catalog is unavailable")
				return
			}
			kind := filmStageGenerationKind(stage)
			for _, capability := range mediaCatalog.Models {
				if capability.ChannelID == selectedProviderID && capability.Model == selectedModel && capability.Kind == kind {
					generationMode = filmGenerationMode(stage, jobShot, jobConfig)
					if validateMediaCapabilityRequest(capability, generationMode, jobConfig) == nil {
						capabilityVersion = mediaCatalog.Version
					}
					break
				}
			}
			if capabilityVersion == "" {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmError(w, http.StatusUnprocessableEntity, "media_capability_unsupported", "selected shared model does not advertise the requested generation mode")
				return
			}
		}
		job, buildErr := buildFilmGenerationTargetJob(stage, jobShot, target.Dialogue, document.ProjectID, selectedProviderID, selectedModel, taskID, parentJobID, jobID, requestHash, jobConfig, snapshot, now)
		if buildErr != nil {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			writeFilmError(w, http.StatusUnprocessableEntity, "generation_request_invalid", buildErr.Error())
			return
		}
		if quoteErr := setFilmGenerationJobCreditQuote(&job, unitCredits); quoteErr != nil {
			writeFilmError(w, http.StatusInternalServerError, "generation_request_invalid", quoteErr.Error())
			return
		}
		dialogueID := ""
		if target.Dialogue != nil {
			dialogueID = target.Dialogue.ID
		}
		binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: stage, ShotID: shot.ID, DialogueID: dialogueID, TaskID: taskID, ParentGenerationJobID: parentJobID, RequestHash: requestHash}
		if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, jobID); getErr == nil {
			if !matchingFilmGenerationJob(existing, binding) {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmError(w, http.StatusConflict, "generation_job_conflict", "generation job id belongs to another request")
				return
			}
		} else if !errors.Is(getErr, store.ErrNotFound) {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			writeFilmError(w, http.StatusInternalServerError, "generation_storage_error", "generation job state is unavailable")
			return
		} else {
			meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind, "executor": serverExecutorMarker, "filmProjectId": document.ProjectID, "shotId": shot.ID, "dialogueId": dialogueID, "parentJobId": parentJobID})
			expectedCredits := unitCredits
			reservations = append(reservations, store.FilmGenerationReservation{Job: job, Units: 1, UsageMeta: meta, ExpectedCredits: &expectedCredits})
		}
		title := "Generate " + stage + " for " + shot.Title
		if target.Dialogue != nil {
			title = "Generate dialogue audio for " + shot.Title
		}
		taskSnapshot := buildFilmGenerationTargetSnapshotWithCapability(document, jobShot, target.Dialogue, selectedProviderID, selectedModel, jobConfig, now, capabilityVersion, generationMode)
		if stage == "video" {
			taskSnapshot.ResolvedMode, _ = resolveVideoGenerationMode(jobConfig.FrameMode, len(jobConfig.ReferenceStorageKeys), 0)
		}
		taskSnapshot.EstimatedCredits = unitCredits
		next.Tasks = append(next.Tasks, filmTask{ID: taskID, Revision: 1, Stage: stage, ShotID: shot.ID, DialogueID: dialogueID, Title: title, Status: filmStatusRunning, Progress: 0, CreatedAt: now, UpdatedAt: now, GenerationJobID: jobID, ParentGenerationJobID: parentJobID, IdempotencyKey: strings.TrimSpace(input.IdempotencyKey), RequestHash: requestHash, Snapshot: taskSnapshot})
	}
	parentJob, buildParentErr := buildFilmStageGenerationJob(document.ProjectID, stage, parentJobID, requestHash, now, childJobIDs, childCredits)
	if buildParentErr != nil {
		writeFilmError(w, http.StatusInternalServerError, "generation_request_invalid", "Film stage parent job could not be created")
		return
	}
	reservations = append([]store.FilmGenerationReservation{{Job: parentJob, Units: 0, UsageMeta: json.RawMessage(`{}`)}}, reservations...)
	if len(next.Tasks) > 1_000 {
		s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
		writeFilmError(w, http.StatusUnprocessableEntity, "film_task_limit", "film task retention limit reached")
		return
	}
	currentStage.Status, currentStage.Error, currentStage.UpdatedAt = filmStatusRunning, "", now
	currentStage.Revision++
	next.Stages[stageIndex] = currentStage
	next.Revision++
	next.UpdatedAt = now
	raw, marshalErr := json.Marshal(next)
	if marshalErr != nil || len(raw) > maxProjectBytes {
		s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	var updated store.FilmRecord
	var saveErr error
	if len(reservations) > 0 {
		updated, saveErr = atomicBackend.CreateFilmGenerationBatch(r.Context(), tenantID, userIDFrom(r), record.ProjectID, record.Revision, raw, reservations)
	}
	if saveErr != nil {
		s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
		if errors.Is(saveErr, store.ErrConflict) {
			writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		} else if errors.Is(saveErr, store.ErrQuotaExceeded) || errors.Is(saveErr, store.ErrInsufficientCredits) || errors.Is(saveErr, store.ErrBanned) || errors.Is(saveErr, store.ErrGone) || errors.Is(saveErr, store.ErrUnauthorized) {
			writeFilmOperationError(w, filmGenerationStoreError(saveErr))
		} else {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be saved")
		}
		return
	}
	s.notifyFilmGenerationWorkers(stage)
	s.writeFilmDocument(w, r, http.StatusAccepted, updated, next)
}

func validFilmGenerationResult(ctx context.Context, server *Server, tenantID, stage string, job store.GenerationJob) (mediaGenerationItem, error) {
	var result struct {
		Items []mediaGenerationItem `json:"items"`
	}
	if json.Unmarshal(job.Result, &result) != nil || len(result.Items) != 1 {
		return mediaGenerationItem{}, errors.New("generation result has no single media item")
	}
	item := result.Items[0]
	if item.StorageKey == "" || item.Bytes <= 0 || item.MIMEType == "" {
		return mediaGenerationItem{}, errors.New("generation result media metadata is invalid")
	}
	expectedPrefix := map[string]string{"storyboard": "image/", "first_frame": "image/", "last_frame": "image/", "audio": "audio/", "video": "video/"}[stage]
	if !strings.HasPrefix(item.MIMEType, expectedPrefix) {
		return mediaGenerationItem{}, errors.New("generation result media type does not match the stage")
	}
	value, err := server.readTenantBlob(ctx, tenantID, item.StorageKey, maxUploadBytes)
	if err != nil || value.Metadata.ContentType != item.MIMEType || len(value.Data) != item.Bytes {
		return mediaGenerationItem{}, errors.New("generation result blob is unavailable or does not match its metadata")
	}
	actualDigest, actualVersion := sha256Hex(value.Data), blobIdentityVersion(value)
	if (item.SHA256 != "" && item.SHA256 != actualDigest) || (item.ObjectVersion != "" && item.ObjectVersion != actualVersion) {
		return mediaGenerationItem{}, errors.New("generation result blob integrity metadata does not match")
	}
	item.SHA256, item.ObjectVersion = actualDigest, actualVersion
	return item, nil
}

func setFilmShotMediaBinding(shot *filmShot, stage string, item mediaGenerationItem, generationJobID string) {
	switch stage {
	case "storyboard":
		shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, generationJobID
	case "first_frame":
		shot.FirstFrameStorageKey, shot.FirstFrameSHA256, shot.FirstFrameObjectVersion, shot.FirstFrameGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, generationJobID
	case "last_frame":
		shot.LastFrameStorageKey, shot.LastFrameSHA256, shot.LastFrameObjectVersion, shot.LastFrameGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, generationJobID
	case "audio":
		shot.AudioStorageKey, shot.AudioSHA256, shot.AudioObjectVersion, shot.AudioGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, generationJobID
	case "video":
		shot.VideoStorageKey, shot.VideoSHA256, shot.VideoObjectVersion, shot.VideoGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, generationJobID
	}
}

func latestFilmStageTasks(document filmDocument, stage string) map[string]int {
	latest := map[string]int{}
	for index, task := range document.Tasks {
		if task.Stage == stage && task.ShotID != "" {
			latest[filmTaskTargetID(task)] = index
		}
	}
	return latest
}

func filmStageHasBoundMedia(document filmDocument, stage string) bool {
	if len(document.Shots) == 0 {
		return false
	}
	for _, shot := range document.Shots {
		switch stage {
		case "storyboard":
			if shot.ImageStorageKey == "" {
				return false
			}
		case "first_frame":
			if shot.FirstFrameStorageKey == "" {
				return false
			}
		case "audio":
			// Dialogue audio is authoritative for scripted shots. Shot-level audio
			// remains a backwards-compatible fallback for imported legacy projects.
			if shot.AudioStorageKey != "" {
				break
			}
			hasDialogue := false
			for _, dialogue := range document.Dialogues {
				if dialogue.ShotID == shot.ID {
					hasDialogue = true
					if dialogue.AudioStorageKey == "" {
						return false
					}
				}
			}
			if !hasDialogue && shot.AudioStorageKey == "" {
				return false
			}
		case "video":
			if shot.VideoStorageKey == "" {
				return false
			}
		}
	}
	return true
}

func (s *Server) syncFilmStage(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	stage := chi.URLParam(r, "stageId")
	if filmStageGenerationKind(stage) == "" {
		writeFilmError(w, http.StatusUnprocessableEntity, "stage_sync_unsupported", "only generation stages can be synchronized")
		return
	}
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	stageIndex, currentStage, err := findFilmStage(document, stage)
	if err != nil || currentStage.Revision != input.Revision {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "film stage revision conflict")
		return
	}
	next := cloneFilmDocument(document)
	latest := latestFilmStageTasks(next, stage)
	active, failed, changed := false, false, false
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tenantID := tenantIDFrom(r)
	for _, taskIndex := range latest {
		task := next.Tasks[taskIndex]
		if task.Status == filmStatusCanceled {
			failed = true
			continue
		}
		job, getErr := s.store.GetGenerationJob(r.Context(), tenantID, task.GenerationJobID)
		if getErr != nil {
			if task.Status != filmStatusFailed || task.Error == "" {
				task.Status, task.Error, task.Progress = filmStatusFailed, "Generation job state is unavailable for this tenant", 0
				changed = true
			}
			failed = true
		} else {
			binding := filmGenerationBinding{ProjectID: next.ProjectID, Stage: stage, ShotID: task.ShotID, DialogueID: task.DialogueID, TaskID: task.ID, ParentGenerationJobID: task.ParentGenerationJobID, RequestHash: task.RequestHash}
			if !matchingFilmGenerationJob(job, binding) {
				task.Status, task.Error, task.Progress = filmStatusFailed, "Generation job binding is invalid", 0
				failed, changed = true, true
			} else {
				switch job.Status {
				case "queued", "running":
					active = true
					progress := 0.0
					if job.Status == "running" {
						progress = 0.5
					}
					if task.Status != filmStatusRunning || task.Progress != progress || task.Error != "" {
						task.Status, task.Progress, task.Error = filmStatusRunning, progress, ""
						changed = true
					}
				case "succeeded":
					item, resultErr := validFilmGenerationResult(r.Context(), s, tenantID, stage, job)
					if resultErr != nil {
						task.Status, task.Error, task.Progress = filmStatusFailed, resultErr.Error(), 0
						failed, changed = true, true
						break
					}
					if task.DialogueID != "" {
						for dialogueIndex, dialogue := range next.Dialogues {
							if dialogue.ID != task.DialogueID || dialogue.ShotID != task.ShotID {
								continue
							}
							dialogue.AudioStorageKey, dialogue.AudioSHA256, dialogue.AudioObjectVersion, dialogue.AudioGenerationJobID = item.StorageKey, item.SHA256, item.ObjectVersion, job.ID
							dialogue.Status, dialogue.Revision = filmStatusNeedsReview, dialogue.Revision+1
							next.Dialogues[dialogueIndex] = dialogue
							changed = true
						}
					} else {
						for shotIndex, shot := range next.Shots {
							if shot.ID != task.ShotID {
								continue
							}
							before := shot
							setFilmShotMediaBinding(&shot, stage, item, job.ID)
							shot.MediaMIMEType, shot.Status = item.MIMEType, filmStatusNeedsReview
							if shot.ImageStorageKey != before.ImageStorageKey || shot.FirstFrameStorageKey != before.FirstFrameStorageKey || shot.LastFrameStorageKey != before.LastFrameStorageKey || shot.AudioStorageKey != before.AudioStorageKey ||
								shot.VideoStorageKey != before.VideoStorageKey || shot.MediaMIMEType != before.MediaMIMEType || shot.Status != before.Status {
								shot.Revision++
								next.Shots[shotIndex] = shot
								changed = true
							}
						}
					}
					if task.Status != filmStatusNeedsReview || task.Progress != 1 || task.Error != "" {
						task.Status, task.Progress, task.Error = filmStatusNeedsReview, 1, ""
						changed = true
					}
				case "failed":
					task.Status, task.Progress, task.Error = filmStatusFailed, 0, stableFilmJobError(job.Status)
					failed, changed = true, true
				case "cancelled":
					task.Status, task.Progress, task.Error = filmStatusCanceled, 0, "Generation was canceled"
					failed, changed = true, true
				default:
					task.Status, task.Progress, task.Error = filmStatusFailed, 0, "Generation job status is invalid"
					failed, changed = true, true
				}
			}
		}
		if changed && task != next.Tasks[taskIndex] {
			task.Revision++
			task.UpdatedAt = now
			next.Tasks[taskIndex] = task
		}
	}
	stageStatus, stageError := filmStatusFailed, "One or more shots require regeneration"
	if active {
		stageStatus, stageError = filmStatusRunning, ""
	} else if !failed && filmStageHasBoundMedia(next, stage) {
		stageStatus, stageError = filmStatusNeedsReview, ""
	}
	if currentStage.Status != stageStatus || currentStage.Error != stageError {
		currentStage.Status, currentStage.Error = stageStatus, stageError
		changed = true
	}
	if !changed {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
		return
	}
	currentStage.Revision++
	currentStage.UpdatedAt = now
	next.Stages[stageIndex] = currentStage
	next.Revision++
	next.UpdatedAt = now
	raw, marshalErr := json.Marshal(next)
	if marshalErr != nil || len(raw) > maxProjectBytes {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	updated, saveErr := backend.CompareAndSwapFilmProject(r.Context(), tenantID, record.ProjectID, record.Revision, raw)
	if errors.Is(saveErr, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		return
	}
	if saveErr != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be saved")
		return
	}
	s.writeFilmDocument(w, r, http.StatusOK, updated, next)
}

func validFilmRequestHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
