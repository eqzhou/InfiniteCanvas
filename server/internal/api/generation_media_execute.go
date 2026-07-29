package api

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxGeneratedVideoBytes = 64 << 20
	maxGeneratedAudioBytes = 32 << 20
	maxMediaReferenceBytes = 64 << 20
)

var (
	videoRatioPattern = regexp.MustCompile(`^[1-9][0-9]?:[1-9][0-9]?$`)
	mediaTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)
)

type generatedMedia struct {
	Data     []byte
	MIMEType string
	// PublicURL is set when the provider must fetch the media itself. Providers
	// such as Ark pull reference media from their own network, so local bytes
	// are unusable there.
	PublicURL string
}

type videoProviderCheckpoint struct {
	Protocol string `json:"protocol"`
	TaskID   string `json:"taskId"`
}

type videoGenerationRequest struct {
	BaseURL        string
	APIKey         string
	Protocol       string
	Model          string
	Prompt         string
	NegativePrompt string
	Mode           string
	Size           string
	Seconds        int
	Ratio          string
	Resolution     string
	GenerateAudio  bool
	Watermark      bool
	FrameMode      string
	References     []generatedMedia
	MultiShot      bool
	ShotType       string
	Shots          []videoGenerationShot
	Elements       []videoGenerationElement
	Template       *imageProviderTemplate
}

type videoGenerationShot struct {
	Index    int    `json:"index"`
	Prompt   string `json:"prompt"`
	Duration int    `json:"duration"`
}

type videoGenerationElement struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	ImageURLs   []string `json:"imageUrls"`
}

type audioGenerationRequest struct {
	BaseURL string
	APIKey  string
	Model   string
	Prompt  string
	Voice   string
	Format  string
	// Speed is the OpenAI-compatible playback rate. Zero means "unset" and is
	// omitted from the provider request so the provider default applies.
	Speed        float64
	Instructions string
}

type videoExecutor interface {
	Generate(context.Context, videoGenerationRequest, *videoProviderCheckpoint, func(videoProviderCheckpoint) error) (generatedMedia, error)
}

type audioExecutor interface {
	Generate(context.Context, audioGenerationRequest) (generatedMedia, error)
}

type createVideoJobRequest struct {
	ID         string                   `json:"id"`
	ProjectID  string                   `json:"projectId,omitempty"`
	Prompt     string                   `json:"prompt"`
	ProviderID string                   `json:"providerId"`
	Model      string                   `json:"model,omitempty"`
	Parameters createVideoJobParameters `json:"parameters"`
}

type createVideoJobParameters struct {
	Size                 string                   `json:"size,omitempty"`
	Seconds              int                      `json:"seconds,omitempty"`
	Ratio                string                   `json:"ratio"`
	Resolution           string                   `json:"resolution"`
	GenerateAudio        bool                     `json:"generateAudio,omitempty"`
	Watermark            bool                     `json:"watermark,omitempty"`
	FrameMode            string                   `json:"frameMode,omitempty"`
	NegativePrompt       string                   `json:"negativePrompt,omitempty"`
	Mode                 string                   `json:"mode,omitempty"`
	MultiShot            bool                     `json:"multiShot,omitempty"`
	ShotType             string                   `json:"shotType,omitempty"`
	Shots                []videoGenerationShot    `json:"shots,omitempty"`
	Elements             []videoGenerationElement `json:"elements,omitempty"`
	ReferenceStorageKeys []string                 `json:"referenceStorageKeys,omitempty"`
}

type createAudioJobRequest struct {
	ID         string                   `json:"id"`
	ProjectID  string                   `json:"projectId,omitempty"`
	Prompt     string                   `json:"prompt"`
	ProviderID string                   `json:"providerId"`
	Model      string                   `json:"model,omitempty"`
	Parameters createAudioJobParameters `json:"parameters"`
}

type createAudioJobParameters struct {
	Voice  string `json:"voice"`
	Format string `json:"format"`
	// Speed 0 means unset; the provider default applies.
	Speed        float64 `json:"speed,omitempty"`
	Instructions string  `json:"instructions,omitempty"`
}

type persistedMediaJobParameters struct {
	Executor             string                     `json:"executor"`
	RequestHash          string                     `json:"requestHash"`
	Size                 string                     `json:"size,omitempty"`
	Seconds              int                        `json:"seconds,omitempty"`
	Ratio                string                     `json:"ratio,omitempty"`
	Resolution           string                     `json:"resolution,omitempty"`
	GenerateAudio        bool                       `json:"generateAudio,omitempty"`
	Watermark            bool                       `json:"watermark,omitempty"`
	FrameMode            string                     `json:"frameMode,omitempty"`
	NegativePrompt       string                     `json:"negativePrompt,omitempty"`
	Mode                 string                     `json:"mode,omitempty"`
	MultiShot            bool                       `json:"multiShot,omitempty"`
	ShotType             string                     `json:"shotType,omitempty"`
	Shots                []videoGenerationShot      `json:"shots,omitempty"`
	Elements             []videoGenerationElement   `json:"elements,omitempty"`
	ReferenceStorageKeys []string                   `json:"referenceStorageKeys,omitempty"`
	Voice                string                     `json:"voice,omitempty"`
	Format               string                     `json:"format,omitempty"`
	Speed                float64                    `json:"speed,omitempty"`
	Instructions         string                     `json:"instructions,omitempty"`
	SharedChannel        *generationChannelSnapshot `json:"sharedChannel,omitempty"`
}

type serverMediaJobResult struct {
	UpstreamTask *videoProviderCheckpoint `json:"upstreamTask,omitempty"`
	Items        []mediaGenerationItem    `json:"items,omitempty"`
}

type mediaGenerationItem struct {
	StorageKey string `json:"storageKey"`
	MIMEType   string `json:"mimeType"`
	Bytes      int    `json:"bytes"`
}

func (s *Server) createServerVideoJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil || s.videoExecutor == nil || s.secrets == nil {
		http.Error(w, "server video generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	var input createVideoJobRequest
	if !decodeStrictGenerationInput(w, r, &input) || !validCreateVideoJob(input) {
		http.Error(w, "invalid video generation job", http.StatusBadRequest)
		return
	}
	// The tenant model allow list is a governance rule, so it must hold here
	// and not only in the picker the client renders.
	if !s.requireAllowedModel(w, r, input.Model) {
		return
	}
	hash, err := hashGenerationInput(input)
	if err != nil {
		http.Error(w, "invalid video generation job", http.StatusBadRequest)
		return
	}
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), input.ID); getErr == nil && isMatchingServerMediaJob(existing, "video", hash) {
		writeJSON(w, publicGenerationJob(existing))
		return
	}
	tenantID := tenantIDFrom(r)
	selectedProviderID, sharedSnapshot, err := s.snapshotGenerationChannel(r.Context(), tenantID, "video", input.ID, input.ProviderID, input.Model)
	if err != nil {
		http.Error(w, "no eligible shared video channel", http.StatusUnprocessableEntity)
		return
	}
	input.ProviderID = selectedProviderID
	if sharedSnapshot != nil {
		input.Model = sharedSnapshot.Model
	}
	if err := s.validateVideoReferenceKeys(r.Context(), tenantIDFrom(r), input.Parameters.ReferenceStorageKeys); err != nil {
		http.Error(w, "video references are invalid or exceed limits", http.StatusBadRequest)
		return
	}
	parameters, _ := json.Marshal(persistedMediaJobParameters{
		Executor: serverExecutorMarker, RequestHash: hash, Size: input.Parameters.Size, Seconds: input.Parameters.Seconds,
		Ratio: input.Parameters.Ratio, Resolution: input.Parameters.Resolution,
		GenerateAudio: input.Parameters.GenerateAudio, Watermark: input.Parameters.Watermark,
		FrameMode:      normalizeVideoFrameMode(input.Parameters.FrameMode),
		NegativePrompt: strings.TrimSpace(input.Parameters.NegativePrompt), Mode: input.Parameters.Mode,
		MultiShot: input.Parameters.MultiShot, ShotType: input.Parameters.ShotType,
		Shots:                append([]videoGenerationShot(nil), input.Parameters.Shots...),
		Elements:             cloneVideoGenerationElements(input.Parameters.Elements),
		ReferenceStorageKeys: append([]string(nil), input.Parameters.ReferenceStorageKeys...),
		SharedChannel:        sharedSnapshot,
	})
	s.createServerMediaJob(w, r, store.GenerationJob{
		ID: input.ID, ProjectID: input.ProjectID, Kind: "video", Status: "queued",
		Prompt: strings.TrimSpace(input.Prompt), ProviderID: input.ProviderID, Model: input.Model,
		Parameters: parameters, Result: json.RawMessage(`{}`),
	}, hash, s.notifyVideoWorkers)
}

func (s *Server) createServerAudioJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil || s.audioExecutor == nil || s.secrets == nil {
		http.Error(w, "server audio generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	var input createAudioJobRequest
	if !decodeStrictGenerationInput(w, r, &input) || !validCreateAudioJob(input) {
		http.Error(w, "invalid audio generation job", http.StatusBadRequest)
		return
	}
	if !s.requireAllowedModel(w, r, input.Model) {
		return
	}
	hash, err := hashGenerationInput(input)
	if err != nil {
		http.Error(w, "invalid audio generation job", http.StatusBadRequest)
		return
	}
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), input.ID); getErr == nil && isMatchingServerMediaJob(existing, "audio", hash) {
		writeJSON(w, publicGenerationJob(existing))
		return
	}
	tenantID := tenantIDFrom(r)
	selectedProviderID, sharedSnapshot, err := s.snapshotGenerationChannel(r.Context(), tenantID, "audio", input.ID, input.ProviderID, input.Model)
	if err != nil {
		http.Error(w, "no eligible shared audio channel", http.StatusUnprocessableEntity)
		return
	}
	input.ProviderID = selectedProviderID
	if sharedSnapshot != nil {
		input.Model = sharedSnapshot.Model
	}
	parameters, _ := json.Marshal(persistedMediaJobParameters{
		Executor: serverExecutorMarker, RequestHash: hash,
		Voice: input.Parameters.Voice, Format: input.Parameters.Format,
		Speed: input.Parameters.Speed, Instructions: input.Parameters.Instructions,
		SharedChannel: sharedSnapshot,
	})
	s.createServerMediaJob(w, r, store.GenerationJob{
		ID: input.ID, ProjectID: input.ProjectID, Kind: "audio", Status: "queued",
		Prompt: strings.TrimSpace(input.Prompt), ProviderID: input.ProviderID, Model: input.Model,
		Parameters: parameters, Result: json.RawMessage(`{}`),
	}, hash, s.notifyAudioWorkers)
}

func decodeStrictGenerationInput(w http.ResponseWriter, r *http.Request, output any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationJobBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(output) == nil && ensureJSONEOF(decoder) == nil
}

func normalizeVideoFrameMode(value string) string {
	if value == "first-last" {
		return "first-last"
	}
	return "references"
}

func allowsPromptlessAPIMartVideo(model, frameMode string, referenceCount int) bool {
	capability, ok := resolveProviderModelCapability("apimart", "video", model)
	if !ok {
		return false
	}
	switch capability.Family {
	case "seedance-2.0":
		return referenceCount > 0
	case "happyhorse-1.1":
		return normalizeVideoFrameMode(frameMode) == "first-last" && referenceCount == 1
	case "kling-3.0-turbo":
		return referenceCount == 1
	default:
		return false
	}
}

func validCreateVideoJob(input createVideoJobRequest) bool {
	if input.Parameters.FrameMode != "" && input.Parameters.FrameMode != "references" && input.Parameters.FrameMode != "first-last" {
		return false
	}
	seedanceModel := isAPIMartSeedanceModel(input.Model)
	identityPrompt := input.Prompt
	if strings.TrimSpace(identityPrompt) == "" && strings.EqualFold(strings.TrimSpace(input.Model), "kling-v3") &&
		input.Parameters.MultiShot && input.Parameters.ShotType == "customize" && len(input.Parameters.Shots) > 0 {
		identityPrompt = "multi-shot"
	} else if strings.TrimSpace(identityPrompt) == "" && allowsPromptlessAPIMartVideo(
		input.Model, input.Parameters.FrameMode, len(input.Parameters.ReferenceStorageKeys),
	) {
		identityPrompt = "reference-media"
	}
	if !validServerMediaIdentity(input.ID, input.ProjectID, input.ProviderID, input.Model, identityPrompt) ||
		(input.Parameters.Size != "" && !imageSizePattern.MatchString(input.Parameters.Size)) ||
		(input.Parameters.Seconds != 0 && (input.Parameters.Seconds < 1 || input.Parameters.Seconds > 15)) ||
		(input.Parameters.Ratio == "adaptive" && !seedanceModel) ||
		(input.Parameters.Ratio != "adaptive" && !videoRatioPattern.MatchString(input.Parameters.Ratio)) ||
		(input.Parameters.Resolution != "480p" && input.Parameters.Resolution != "720p" && input.Parameters.Resolution != "1080p" &&
			(input.Parameters.Resolution != "4k" || !strings.EqualFold(strings.TrimSpace(input.Model), "doubao-seedance-2.0"))) ||
		len(input.Parameters.ReferenceStorageKeys) > 15 || len(input.Parameters.NegativePrompt) > 2_500 ||
		len(input.Parameters.Mode) > 20 || len(input.Parameters.ShotType) > 20 || len(input.Parameters.Shots) > 6 ||
		len(input.Parameters.Elements) > 3 {
		return false
	}
	for _, key := range input.Parameters.ReferenceStorageKeys {
		if _, ok := blobFilename(key); !ok {
			return false
		}
	}
	for _, shot := range input.Parameters.Shots {
		if shot.Index < 1 || shot.Index > 6 || shot.Duration < 1 || shot.Duration > 15 ||
			len(strings.TrimSpace(shot.Prompt)) < 1 || len(shot.Prompt) > 512 {
			return false
		}
	}
	for _, element := range input.Parameters.Elements {
		if len(element.Name) < 1 || len(element.Name) > 64 || len(element.Description) < 1 ||
			len(element.Description) > 1_000 || len(element.ImageURLs) < 2 || len(element.ImageURLs) > 4 {
			return false
		}
		for _, rawURL := range element.ImageURLs {
			if validateAPIMartPublicURL(rawURL) != nil {
				return false
			}
		}
	}
	return true
}

func cloneVideoGenerationElements(values []videoGenerationElement) []videoGenerationElement {
	result := make([]videoGenerationElement, len(values))
	for index, value := range values {
		result[index] = value
		result[index].ImageURLs = append([]string(nil), value.ImageURLs...)
	}
	return result
}

func validCreateAudioJob(input createAudioJobRequest) bool {
	if !validServerMediaIdentity(input.ID, input.ProjectID, input.ProviderID, input.Model, input.Prompt) ||
		!mediaTokenPattern.MatchString(input.Parameters.Voice) {
		return false
	}
	switch input.Parameters.Format {
	case "mp3", "wav", "opus", "aac", "flac", "pcm":
		return true
	default:
		return false
	}
}

func validServerMediaIdentity(id, projectID, providerID, model, prompt string) bool {
	return validProjectID(id) && (projectID == "" || validProjectID(projectID)) && validProjectID(providerID) &&
		len(model) <= 500 && strings.TrimSpace(prompt) != "" && len(strings.TrimSpace(prompt)) <= 100_000
}

func hashGenerationInput(input any) (string, error) {
	value, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Server) createServerMediaJob(w http.ResponseWriter, r *http.Request, job store.GenerationJob, requestHash string, notify func()) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job.CreatedAt, job.UpdatedAt = now, now
	meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind, "executor": serverExecutorMarker})
	err := s.store.CreateServerGenerationJob(r.Context(), tenantIDFrom(r), userIDFrom(r), job, 1, meta)
	if errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), job.ID)
		if getErr == nil && isMatchingServerMediaJob(existing, job.Kind, requestHash) {
			writeJSON(w, publicGenerationJob(existing))
			return
		}
		http.Error(w, "generation job id already belongs to another request", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrGone) {
		http.Error(w, "generation job was deleted", http.StatusGone)
		return
	}
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "generation quota exceeded", http.StatusTooManyRequests)
		return
	}
	if errors.Is(err, store.ErrInsufficientCredits) {
		http.Error(w, "insufficient credits", http.StatusPaymentRequired)
		return
	}
	if errors.Is(err, store.ErrBanned) {
		http.Error(w, "account banned", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "failed to store generation job", http.StatusInternalServerError)
		return
	}
	notify()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, publicGenerationJob(job))
}

func isMatchingServerMediaJob(job store.GenerationJob, kind, requestHash string) bool {
	var parameters persistedMediaJobParameters
	return job.Kind == kind && json.Unmarshal(job.Parameters, &parameters) == nil &&
		parameters.Executor == serverExecutorMarker && parameters.RequestHash == requestHash
}

func (s *Server) validateVideoReferenceKeys(ctx context.Context, tenantID string, keys []string) error {
	counts := map[string]int{}
	total := 0
	for _, key := range keys {
		value, err := s.readTenantBlob(ctx, tenantID, key, maxMediaReferenceBytes)
		if err != nil {
			return err
		}
		kind := mediaMIMEKind(value.Metadata.ContentType)
		if kind == "" {
			return errors.New("unsupported reference media")
		}
		counts[kind]++
		if (kind == "image" && counts[kind] > 9) || (kind != "image" && counts[kind] > 3) {
			return errors.New("too many media references")
		}
		total += len(value.Data)
		if total > maxMediaReferenceBytes {
			return errors.New("media references exceed total size limit")
		}
	}
	return nil
}

func mediaMIMEKind(value string) string {
	switch {
	case strings.HasPrefix(value, "image/"):
		return "image"
	case strings.HasPrefix(value, "video/"):
		return "video"
	case strings.HasPrefix(value, "audio/"):
		return "audio"
	default:
		return ""
	}
}

func (s *Server) startVideoWorkers(count int) {
	if s.store == nil || count < 1 || s.videoExecutor == nil {
		return
	}
	s.videoWorkersOnce.Do(func() {
		for range count {
			s.videoWorkerWG.Add(1)
			go s.mediaWorkerLoop("video", s.videoWake, &s.videoWorkerWG, &s.videoWG, s.executeClaimedVideoJob)
		}
		s.notifyVideoWorkers()
	})
}

func (s *Server) startAudioWorkers(count int) {
	if s.store == nil || count < 1 || s.audioExecutor == nil {
		return
	}
	s.audioWorkersOnce.Do(func() {
		for range count {
			s.audioWorkerWG.Add(1)
			go s.mediaWorkerLoop("audio", s.audioWake, &s.audioWorkerWG, &s.audioWG, s.executeClaimedAudioJob)
		}
		s.notifyAudioWorkers()
	})
}

func (s *Server) mediaWorkerLoop(kind string, wake <-chan struct{}, workerWG, activeWG *sync.WaitGroup, execute func(store.TenantGenerationJob)) {
	defer workerWG.Done()
	for {
		now := time.Now().UTC()
		claimed, err := s.store.ClaimServerGenerationJob(s.generationRoot,
			store.GenerationClaim{Kind: kind, Executor: serverExecutorMarker}, randomGenerationOwner(), now, now.Add(generationLeaseDuration))
		if err == nil {
			activeWG.Add(1)
			execute(claimed)
			activeWG.Done()
			continue
		}
		select {
		case <-s.generationRoot.Done():
			return
		case <-wake:
		case <-time.After(time.Second):
		}
	}
}

func (s *Server) notifyVideoWorkers() {
	select {
	case s.videoWake <- struct{}{}:
	default:
	}
}

func (s *Server) notifyAudioWorkers() {
	select {
	case s.audioWake <- struct{}{}:
	default:
	}
}

func (s *Server) executeClaimedVideoJob(claimed store.TenantGenerationJob) {
	s.executeClaimedMediaJob(claimed, func(ctx context.Context, request resolvedMediaRequest, checkpoint func(videoProviderCheckpoint) error) (generatedMedia, error) {
		return s.videoExecutor.Generate(ctx, request.Video, request.Checkpoint, checkpoint)
	})
}

func (s *Server) executeClaimedAudioJob(claimed store.TenantGenerationJob) {
	s.executeClaimedMediaJob(claimed, func(ctx context.Context, request resolvedMediaRequest, _ func(videoProviderCheckpoint) error) (generatedMedia, error) {
		return s.audioExecutor.Generate(ctx, request.Audio)
	})
}

type resolvedMediaRequest struct {
	Video           videoGenerationRequest
	Audio           audioGenerationRequest
	Checkpoint      *videoProviderCheckpoint
	ProviderTimeout time.Duration
}

func (s *Server) executeClaimedMediaJob(claimed store.TenantGenerationJob, generate func(context.Context, resolvedMediaRequest, func(videoProviderCheckpoint) error) (generatedMedia, error)) {
	tenantID, job := claimed.TenantID, claimed.Job
	startedAt := time.Now().UTC()
	ctx, cancel := context.WithCancel(s.generationRoot)
	key := tenantID + "\x00" + job.ID
	s.generationMu.Lock()
	s.generationCancels[key] = cancel
	s.generationMu.Unlock()
	watchDone := make(chan struct{})
	go s.watchGenerationCancellation(ctx, cancel, watchDone, tenantID, job.ID, job.LeaseOwner)
	defer func() {
		close(watchDone)
		s.generationMu.Lock()
		delete(s.generationCancels, key)
		s.generationMu.Unlock()
		cancel()
	}()
	var auditRequest any
	finish := func(status string, result json.RawMessage, message string) bool {
		if s.generationRoot.Err() != nil {
			return false
		}
		if result == nil {
			result = json.RawMessage(`{}`)
		}
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer finishCancel()
		_, err := s.store.CompleteServerGenerationJob(finishCtx, tenantID, job.ID, job.LeaseOwner, status, result, message, time.Now().UTC())
		durationMs := time.Since(startedAt).Milliseconds()
		s.recordAICallLog(finishCtx, tenantID, job, status, durationMs, message, auditRequest, result)
		return err == nil
	}
	request, err := s.resolveMediaGenerationRequest(ctx, tenantID, job)
	if err != nil {
		log.Printf("server %s job %s/%s configuration failed: %v", job.Kind, tenantID, job.ID, err)
		finish("failed", nil, "生成配置不可用，请检查渠道和密钥")
		return
	}
	auditRequest = mediaRequestAuditPayload(request, job.Kind)
	providerCtx, providerCancel := generationProviderContext(ctx, request.ProviderTimeout)
	defer providerCancel()
	checkpoint := func(value videoProviderCheckpoint) error {
		if !validVideoCheckpoint(value) {
			return errors.New("invalid video provider checkpoint")
		}
		result, _ := json.Marshal(serverMediaJobResult{UpstreamTask: &value})
		_, err := s.store.CheckpointServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, result, time.Now().UTC())
		return err
	}
	media, err := generate(providerCtx, request, checkpoint)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			finish("cancelled", nil, "已取消")
			return
		}
		log.Printf("server %s job %s/%s provider failed: %v", job.Kind, tenantID, job.ID, err)
		finish("failed", nil, "生成失败，请检查模型服务配置后重试")
		return
	}
	item, storageKey, err := s.persistGeneratedMedia(ctx, tenantID, "", job.ID, job.LeaseOwner, job.Kind, media)
	if err != nil {
		log.Printf("server %s job %s/%s persistence failed: %v", job.Kind, tenantID, job.ID, err)
		if storageKey != "" {
			_ = s.deleteTenantBlob(context.Background(), tenantID, "", storageKey)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			finish("cancelled", nil, "已取消")
		} else {
			finish("failed", nil, "生成结果无效或保存失败")
		}
		return
	}
	result, _ := json.Marshal(serverMediaJobResult{Items: []mediaGenerationItem{item}})
	if !finish("succeeded", result, "") {
		_ = s.deleteTenantBlob(context.Background(), tenantID, "", storageKey)
	}
}

func (s *Server) resolveMediaGenerationRequest(ctx context.Context, tenantID string, job store.GenerationJob) (resolvedMediaRequest, error) {
	var parameters persistedMediaJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Executor != serverExecutorMarker {
		return resolvedMediaRequest{}, errors.New("invalid media job parameters")
	}
	configValue, err := s.store.GetState(ctx, tenantID, "config")
	if err != nil || len(configValue) > 1<<20 {
		return resolvedMediaRequest{}, errors.New("generation config unavailable")
	}
	var config storedImageConfig
	if json.Unmarshal(configValue, &config) != nil || len(config.Channels) > 100 {
		return resolvedMediaRequest{}, errors.New("invalid generation config")
	}
	var channel *storedImageChannel
	for index := range config.Channels {
		if config.Channels[index].ID == job.ProviderID {
			channel = &config.Channels[index]
			break
		}
	}
	apiKey := ""
	systemPrompt := config.SystemPrompt
	providerTimeout := time.Duration(0)
	personalChannel := channel != nil
	if parameters.SharedChannel != nil {
		snapshot := parameters.SharedChannel
		if snapshot.ProviderID != job.ProviderID {
			return resolvedMediaRequest{}, errors.New("invalid generation channel snapshot")
		}
		apiKey, err = s.openGenerationChannelSecret(tenantID, job.ID, job.Kind, *snapshot)
		if err != nil {
			return resolvedMediaRequest{}, err
		}
		providerTimeout, err = generationChannelTimeout(snapshot)
		if err != nil {
			return resolvedMediaRequest{}, err
		}
		channel = &storedImageChannel{
			ID: snapshot.ProviderID, BaseURL: snapshot.BaseURL,
			DefaultVideoModel: snapshot.Model, DefaultAudioModel: snapshot.Model,
			Providers: map[string]storedImageProvider{job.Kind: {BaseURL: snapshot.BaseURL, Model: snapshot.Model, Protocol: snapshot.Protocol}},
		}
		systemPrompt = snapshot.SystemPrompt
	} else if channel == nil {
		shared, sharedSecret, sharedErr := s.resolveSharedChannel(ctx, tenantID, job.ProviderID)
		if sharedErr != nil {
			return resolvedMediaRequest{}, errors.New("channel not found")
		}
		providerTimeout, err = personalChannelTimeout(shared.TimeoutSeconds)
		if err != nil {
			return resolvedMediaRequest{}, err
		}
		value := sharedChannelStoredValue(shared)
		channel, apiKey = &value, sharedSecret
	} else {
		secretValue, secretErr := s.decryptSecrets(ctx, tenantID)
		if secretErr != nil {
			return resolvedMediaRequest{}, secretErr
		}
		var secrets storedConfigSecrets
		if json.Unmarshal(secretValue, &secrets) != nil {
			return resolvedMediaRequest{}, errors.New("invalid secrets")
		}
		apiKey = secrets.APIKeys[job.ProviderID][job.Kind]
	}
	if personalChannel {
		providerTimeout, err = personalChannelTimeout(channel.TimeoutSeconds)
		if err != nil {
			return resolvedMediaRequest{}, err
		}
	}
	provider, ok := channel.Providers[job.Kind]
	if !ok {
		model := channel.DefaultVideoModel
		if job.Kind == "audio" {
			model = channel.DefaultAudioModel
		}
		provider = storedImageProvider{BaseURL: channel.BaseURL, Model: model, Protocol: "openai"}
	}
	protocol := provider.Protocol
	if protocol == "" {
		protocol = "openai"
	}
	if job.Kind == "video" && (protocol == "openai") &&
		(strings.Contains(provider.BaseURL, "/api/v3") || strings.Contains(provider.BaseURL, "/api/plan/v3")) {
		protocol = "ark"
	}
	if (job.Kind == "video" && protocol != "openai" && protocol != "ark" && protocol != "template" && protocol != "apimart" && protocol != "kie") ||
		(job.Kind == "audio" && protocol != "openai") || len(provider.BaseURL) > 8<<10 {
		return resolvedMediaRequest{}, errors.New("unsupported media provider")
	}
	if job.Kind == "video" && protocol == "template" {
		if err := validateImageProviderTemplate(provider.Template); err != nil {
			return resolvedMediaRequest{}, err
		}
	}
	if _, err := validateGenerationURL(provider.BaseURL); err != nil {
		return resolvedMediaRequest{}, err
	}
	if apiKey == "" || len(apiKey) > 64<<10 {
		return resolvedMediaRequest{}, errors.New("missing media api key")
	}
	model := strings.TrimSpace(job.Model)
	if model == "" {
		model = provider.Model
	}
	if model == "" || len(model) > 500 {
		return resolvedMediaRequest{}, errors.New("missing media model")
	}
	prompt := strings.TrimSpace(job.Prompt)
	if systemPrompt = strings.TrimSpace(systemPrompt); systemPrompt != "" {
		prompt = systemPrompt + "\n\n" + prompt
	}
	if job.Kind == "video" && strings.TrimSpace(prompt) == "" &&
		!(protocol == "apimart" && allowsPromptlessAPIMartVideo(
			model, parameters.FrameMode, len(parameters.ReferenceStorageKeys),
		)) {
		return resolvedMediaRequest{}, errors.New("missing media prompt")
	}
	request := resolvedMediaRequest{ProviderTimeout: providerTimeout}
	if job.Kind == "video" {
		for _, key := range parameters.ReferenceStorageKeys {
			value, err := s.readTenantBlob(ctx, tenantID, key, maxMediaReferenceBytes)
			if err != nil {
				return resolvedMediaRequest{}, err
			}
			reference := generatedMedia{Data: value.Data, MIMEType: value.Metadata.ContentType}
			// Providers that fetch reference media themselves cannot read local
			// bytes. Mint a short-lived public token URL when the deployment
			// advertises a reachable base URL; otherwise leave it empty so the
			// provider adapter fails closed with an actionable message.
			// Only mint for protocols that actually read PublicURL: any other
			// one would publish tenant media to an anonymous URL for nothing.
			if mediaMIMEKind(reference.MIMEType) != "image" && providerFetchesReferenceMedia(protocol) {
				reference.PublicURL = s.publicMediaReferenceURL(ctx, tenantID, key, referenceMediaTTL(providerTimeout))
			}
			request.Video.References = append(request.Video.References, reference)
		}
		request.Video.BaseURL, request.Video.APIKey, request.Video.Protocol = provider.BaseURL, apiKey, protocol
		request.Video.Template, request.Video.Size = provider.Template, parameters.Size
		request.Video.Model, request.Video.Prompt = model, prompt
		request.Video.Seconds, request.Video.Ratio, request.Video.Resolution = parameters.Seconds, parameters.Ratio, parameters.Resolution
		request.Video.GenerateAudio, request.Video.Watermark = parameters.GenerateAudio, parameters.Watermark
		request.Video.FrameMode = normalizeVideoFrameMode(parameters.FrameMode)
		request.Video.NegativePrompt, request.Video.Mode = parameters.NegativePrompt, parameters.Mode
		request.Video.MultiShot, request.Video.ShotType = parameters.MultiShot, parameters.ShotType
		request.Video.Shots = append([]videoGenerationShot(nil), parameters.Shots...)
		request.Video.Elements = cloneVideoGenerationElements(parameters.Elements)
		if protocol == "apimart" {
			if err := validateAPIMartVideoRequest(request.Video); err != nil {
				return resolvedMediaRequest{}, err
			}
		}
		var result serverMediaJobResult
		if len(job.Result) > 0 && string(job.Result) != "{}" {
			if json.Unmarshal(job.Result, &result) != nil || (result.UpstreamTask != nil && !validVideoCheckpoint(*result.UpstreamTask)) {
				return resolvedMediaRequest{}, errors.New("invalid video checkpoint")
			}
		}
		request.Checkpoint = result.UpstreamTask
	} else {
		request.Audio = audioGenerationRequest{
			BaseURL: provider.BaseURL, APIKey: apiKey, Model: model, Prompt: prompt,
			Voice: parameters.Voice, Format: parameters.Format,
			Speed: parameters.Speed, Instructions: parameters.Instructions,
		}
	}
	return request, nil
}

func validVideoCheckpoint(value videoProviderCheckpoint) bool {
	return (value.Protocol == "openai" || value.Protocol == "ark" || value.Protocol == "apimart" || value.Protocol == "kie") && len(value.TaskID) > 0 && len(value.TaskID) <= 1000 && !strings.ContainsAny(value.TaskID, "\r\n\x00")
}

func (s *Server) persistGeneratedMedia(ctx context.Context, tenantID, userID, jobID, attemptID, kind string, media generatedMedia) (mediaGenerationItem, string, error) {
	mimeType, err := validateGeneratedMedia(kind, media)
	if err != nil {
		return mediaGenerationItem{}, "", err
	}
	sum := sha256.Sum256(append([]byte(fmt.Sprintf("%s:%s:", jobID, attemptID)), media.Data...))
	key := "media:generated:" + kind + ":" + jobID + ":" + hex.EncodeToString(sum[:12])
	if err := s.storeTenantBlob(ctx, tenantID, userID, key, mimeType, media.Data); err != nil {
		return mediaGenerationItem{}, "", err
	}
	return mediaGenerationItem{StorageKey: key, MIMEType: mimeType, Bytes: len(media.Data)}, key, nil
}

func validateGeneratedMedia(kind string, media generatedMedia) (string, error) {
	limit := maxGeneratedVideoBytes
	if kind == "audio" {
		limit = maxGeneratedAudioBytes
	}
	if len(media.Data) == 0 || len(media.Data) > limit {
		return "", errors.New("generated media exceeds size limit")
	}
	declared := normalizeMediaMIME(media.MIMEType)
	detected := sniffGeneratedMediaMIME(kind, media.Data)
	if kind == "audio" && declared == "audio/pcm" {
		detected = "audio/pcm"
	}
	if detected == "" {
		return "", errors.New("unsupported generated media type")
	}
	if media.MIMEType != "" && declared != detected {
		return "", errors.New("generated media content type mismatch")
	}
	return detected, nil
}

func normalizeMediaMIME(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	if value == "audio/mp3" {
		return "audio/mpeg"
	}
	return value
}

func sniffGeneratedMediaMIME(kind string, data []byte) string {
	if kind == "video" {
		if validGeneratedMP4(data) {
			return "video/mp4"
		}
		if len(data) >= 12 && data[0] == 0x1a && data[1] == 0x45 && data[2] == 0xdf && data[3] == 0xa3 && bytesContains(data[4:], []byte{0x18, 0x53, 0x80, 0x67}) {
			return "video/webm"
		}
		return ""
	}
	if len(data) >= 3 && string(data[:3]) == "ID3" {
		return "audio/mpeg"
	}
	if len(data) >= 2 && data[0] == 0xff && (data[1]&0xe0) == 0xe0 {
		return "audio/mpeg"
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE" {
		return "audio/wav"
	}
	if len(data) >= 4 && string(data[:4]) == "OggS" {
		return "audio/ogg"
	}
	if len(data) >= 4 && string(data[:4]) == "fLaC" {
		return "audio/flac"
	}
	if len(data) >= 2 && data[0] == 0xff && (data[1]&0xf6) == 0xf0 {
		return "audio/aac"
	}
	return ""
}

func validGeneratedMP4(data []byte) bool {
	if len(data) < 24 || string(data[4:8]) != "ftyp" {
		return false
	}
	foundMedia := false
	for offset, boxes := 0, 0; offset+8 <= len(data) && boxes < 10_000; boxes++ {
		size := int64(binary.BigEndian.Uint32(data[offset : offset+4]))
		header := int64(8)
		if size == 1 {
			if offset+16 > len(data) {
				return false
			}
			size = int64(binary.BigEndian.Uint64(data[offset+8 : offset+16]))
			header = 16
		} else if size == 0 {
			size = int64(len(data) - offset)
		}
		if size < header || size > int64(len(data)-offset) {
			return false
		}
		boxType := string(data[offset+4 : offset+8])
		if boxType == "mdat" || boxType == "moov" || boxType == "moof" {
			foundMedia = true
		}
		offset += int(size)
		if offset == len(data) {
			return foundMedia
		}
	}
	return false
}

func bytesContains(data, needle []byte) bool {
	if len(needle) == 0 || len(data) < len(needle) {
		return false
	}
	for index := 0; index <= len(data)-len(needle); index++ {
		match := true
		for offset := range needle {
			if data[index+offset] != needle[offset] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
