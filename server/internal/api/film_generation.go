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
	ProjectID   string `json:"projectId"`
	Stage       string `json:"stage"`
	ShotID      string `json:"shotId"`
	TaskID      string `json:"taskId"`
	RequestHash string `json:"requestHash"`
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
	case "storyboard", "first_frame":
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
	if (stage == "storyboard" || stage == "first_frame") && config.Size != "" && !imageSizePattern.MatchString(config.Size) {
		return errors.New("storyboard size is invalid")
	}
	if stage == "video" && (config.Seconds < 0 || config.Seconds > 15) {
		return errors.New("video seconds is invalid")
	}
	return nil
}

func filmGenerationRequestHash(projectID, stage string, shots []filmShot, input filmGenerationRunRequest) (string, error) {
	shotIDs := make([]string, len(shots))
	for index, shot := range shots {
		shotIDs[index] = shot.ID
	}
	canonical := struct {
		ProjectID      string               `json:"projectId"`
		Stage          string               `json:"stage"`
		ShotIDs        []string             `json:"shotIds"`
		ProviderID     string               `json:"providerId"`
		Model          string               `json:"model"`
		Config         filmGenerationConfig `json:"config"`
		IdempotencyKey string               `json:"idempotencyKey"`
	}{projectID, stage, shotIDs, strings.TrimSpace(input.ProviderID), strings.TrimSpace(input.Model), input.Config, strings.TrimSpace(input.IdempotencyKey)}
	return hashGenerationInput(canonical)
}

func findFilmIdempotentTasks(document filmDocument, stage, idempotencyKey, requestHash string, shots []filmShot) ([]filmTask, bool, error) {
	wanted := make(map[string]struct{}, len(shots))
	for _, shot := range shots {
		wanted[shot.ID] = struct{}{}
	}
	found := make(map[string]filmTask, len(shots))
	for _, task := range document.Tasks {
		if task.Stage != stage || task.IdempotencyKey != idempotencyKey {
			continue
		}
		if task.RequestHash != requestHash {
			return nil, false, errors.New("idempotency key belongs to a different generation request")
		}
		if _, ok := wanted[task.ShotID]; ok {
			found[task.ShotID] = task
		}
	}
	if len(found) == 0 {
		return nil, false, nil
	}
	if len(found) != len(wanted) {
		return nil, false, errors.New("idempotent generation request is incomplete; sync before retrying")
	}
	result := make([]filmTask, 0, len(found))
	for _, shot := range shots {
		result = append(result, found[shot.ID])
	}
	return result, true, nil
}

func (s *Server) validateFilmGenerationReferences(ctx context.Context, tenantID, stage string, keys []string) error {
	if stage == "storyboard" || stage == "first_frame" {
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
			case "storyboard", "first_frame":
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

func buildFilmGenerationJob(stage string, shot filmShot, projectID, providerID, model, taskID, jobID, requestHash string, config filmGenerationConfig, shared *generationChannelSnapshot, now string) (store.GenerationJob, error) {
	binding := &filmGenerationBinding{ProjectID: projectID, Stage: stage, ShotID: shot.ID, TaskID: taskID, RequestHash: requestHash}
	prompt := strings.TrimSpace(shot.Description)
	job := store.GenerationJob{ID: jobID, ProjectID: projectID, Kind: filmStageGenerationKind(stage), Status: "queued", Prompt: prompt, ProviderID: providerID, Model: model, Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now}
	switch stage {
	case "storyboard", "first_frame":
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
		parameters, err := json.Marshal(persistedMediaJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Ratio: ratio, Resolution: resolution, Seconds: seconds, GenerateAudio: config.GenerateAudio, Watermark: config.Watermark, NegativePrompt: config.NegativePrompt, ReferenceStorageKeys: append([]string(nil), config.ReferenceStorageKeys...), SharedChannel: shared, Film: binding})
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
		if strings.TrimSpace(shot.Subtitle) != "" {
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

func buildFilmGenerationSnapshot(document filmDocument, shot filmShot, providerID, model string, config filmGenerationConfig, now string) *filmGenerationSnapshot {
	identities := make([]filmAsset, 0, len(shot.IdentityVersionIDs))
	wanted := make(map[string]struct{}, len(shot.IdentityVersionIDs))
	for _, id := range shot.IdentityVersionIDs {
		wanted[id] = struct{}{}
	}
	var style *filmAsset
	for _, asset := range document.Assets {
		if _, ok := wanted[asset.ID]; ok && asset.Kind == "identity" {
			identities = append(identities, asset)
		}
		if shot.StyleAssetID != "" && asset.ID == shot.StyleAssetID && asset.Kind == "style" {
			copy := asset
			style = &copy
		}
	}
	sort.SliceStable(identities, func(i, j int) bool { return identities[i].ID < identities[j].ID })
	prompt := strings.TrimSpace(shot.Description)
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
		ShotRevision: shot.Revision, Prompt: prompt, ProviderID: providerID, Model: model,
		Config: config, IdentityVersions: identities, StyleVersion: style,
		StoryboardDirectorSource: cloneDirectorSource(shot.StoryboardDirectorSource),
		FirstFrameDirectorSource: cloneDirectorSource(shot.FirstFrameDirectorSource),
		ReferenceStorageKeys:     append([]string(nil), config.ReferenceStorageKeys...),
		EstimatedGenerations:     1, EstimatedCredits: 1, CreatedAt: now,
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
	default:
		return err
	}
}

func (s *Server) notifyFilmGenerationWorkers(stage string) {
	switch stage {
	case "storyboard", "first_frame":
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
	if err := validateFilmGenerationConfig(stage, input.Config); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	backend, record, document, ok := s.loadFilmProduction(w, r, true)
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
	requestHash, err := filmGenerationRequestHash(document.ProjectID, stage, shots, input)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "generation_request_invalid", "film generation request is invalid")
		return
	}
	if _, replay, replayErr := findFilmIdempotentTasks(document, stage, strings.TrimSpace(input.IdempotencyKey), requestHash, shots); replayErr != nil {
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
	now := time.Now().UTC().Format(time.RFC3339Nano)
	next := cloneFilmDocument(document)
	createdJobs := make([]string, 0, len(shots))
	for _, shot := range shots {
		jobShot, jobConfig := shot, input.Config
		if stage == "audio" {
			jobShot, jobConfig = filmAudioInputs(document, shot, jobConfig)
		}
		if stage == "video" && shot.FirstFrameStorageKey != "" {
			found := false
			for _, key := range jobConfig.ReferenceStorageKeys {
				found = found || key == shot.FirstFrameStorageKey
			}
			if !found {
				jobConfig.ReferenceStorageKeys = append(append([]string(nil), jobConfig.ReferenceStorageKeys...), shot.FirstFrameStorageKey)
			}
			if err := s.validateFilmGenerationReferences(r.Context(), tenantID, stage, jobConfig.ReferenceStorageKeys); err != nil {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				writeFilmOperationError(w, err)
				return
			}
		}
		taskID := stableFilmID("task", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey), shot.ID)
		jobID := stableFilmID("job", document.ProjectID, stage, strings.TrimSpace(input.IdempotencyKey), shot.ID)
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
		job, buildErr := buildFilmGenerationJob(stage, jobShot, document.ProjectID, selectedProviderID, selectedModel, taskID, jobID, requestHash, jobConfig, snapshot, now)
		if buildErr != nil {
			s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
			writeFilmError(w, http.StatusUnprocessableEntity, "generation_request_invalid", buildErr.Error())
			return
		}
		binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: stage, ShotID: shot.ID, TaskID: taskID, RequestHash: requestHash}
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
			meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind, "executor": serverExecutorMarker, "filmProjectId": document.ProjectID, "shotId": shot.ID})
			createErr := s.store.CreateServerGenerationJob(r.Context(), tenantID, userIDFrom(r), job, 1, meta)
			if createErr != nil {
				s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
				mapped := filmGenerationStoreError(createErr)
				if errors.Is(createErr, store.ErrConflict) {
					writeFilmError(w, http.StatusConflict, "generation_job_conflict", "generation job id belongs to another request")
				} else {
					writeFilmOperationError(w, mapped)
				}
				return
			}
			createdJobs = append(createdJobs, jobID)
		}
		next.Tasks = append(next.Tasks, filmTask{ID: taskID, Revision: 1, Stage: stage, ShotID: shot.ID, Title: "Generate " + stage + " for " + shot.Title, Status: filmStatusRunning, Progress: 0, CreatedAt: now, UpdatedAt: now, GenerationJobID: jobID, IdempotencyKey: strings.TrimSpace(input.IdempotencyKey), RequestHash: requestHash, Snapshot: buildFilmGenerationSnapshot(document, jobShot, selectedProviderID, selectedModel, jobConfig, now)})
	}
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
	updated, saveErr := backend.CompareAndSwapFilmProject(r.Context(), tenantID, record.ProjectID, record.Revision, raw)
	if saveErr != nil {
		s.compensateUnreferencedFilmJobs(r.Context(), tenantID, document.ProjectID, createdJobs)
		if errors.Is(saveErr, store.ErrConflict) {
			writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
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
	expectedPrefix := map[string]string{"storyboard": "image/", "first_frame": "image/", "audio": "audio/", "video": "video/"}[stage]
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
			latest[task.ShotID] = index
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
			if shot.AudioStorageKey == "" {
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
	for shotID, taskIndex := range latest {
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
			binding := filmGenerationBinding{ProjectID: next.ProjectID, Stage: stage, ShotID: shotID, TaskID: task.ID, RequestHash: task.RequestHash}
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
					for shotIndex, shot := range next.Shots {
						if shot.ID != shotID {
							continue
						}
						before := shot
						setFilmShotMediaBinding(&shot, stage, item, job.ID)
						shot.MediaMIMEType, shot.Status = item.MIMEType, filmStatusNeedsReview
						if shot.ImageStorageKey != before.ImageStorageKey || shot.FirstFrameStorageKey != before.FirstFrameStorageKey || shot.AudioStorageKey != before.AudioStorageKey ||
							shot.VideoStorageKey != before.VideoStorageKey || shot.MediaMIMEType != before.MediaMIMEType || shot.Status != before.Status {
							shot.Revision++
							next.Shots[shotIndex] = shot
							changed = true
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
