package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxGeneratedImageBytes  = 24 << 20
	maxGeneratedTotalBytes  = 24 << 20
	maxGeneratedPixels      = 12_000_000
	serverExecutorMarker    = "server"
	generationLeaseDuration = 2 * time.Minute
	generationLeaseRenewal  = 10 * time.Second
)

var imageSizePattern = regexp.MustCompile(`^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$`)
var geminiImageModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$`)
var generatedImageDecodeSlot = make(chan struct{}, 1)

type imageGenerationRequest struct {
	Protocol              string
	BaseURL               string
	APIKey                string
	Model                 string
	Prompt                string
	Size                  string
	Quality               string
	Count                 int
	TransparentBackground bool
	References            []generatedImage
	Template              *imageProviderTemplate
}

type generatedImage struct {
	Data     []byte
	MIMEType string
}

type imageExecutor interface {
	Generate(context.Context, imageGenerationRequest) ([]generatedImage, error)
}

type createImageJobRequest struct {
	ID         string                   `json:"id"`
	ProjectID  string                   `json:"projectId,omitempty"`
	Prompt     string                   `json:"prompt"`
	ProviderID string                   `json:"providerId"`
	Model      string                   `json:"model,omitempty"`
	Parameters createImageJobParameters `json:"parameters"`
}

type createImageJobParameters struct {
	Size                  string   `json:"size"`
	Quality               string   `json:"quality,omitempty"`
	Count                 int      `json:"count"`
	Category              string   `json:"category,omitempty"`
	TransparentBackground bool     `json:"transparentBackground,omitempty"`
	ReferenceStorageKeys  []string `json:"referenceStorageKeys,omitempty"`
}

type persistedImageJobParameters struct {
	Executor              string   `json:"executor"`
	RequestHash           string   `json:"requestHash"`
	Size                  string   `json:"size"`
	Quality               string   `json:"quality,omitempty"`
	Count                 int      `json:"count"`
	Category              string   `json:"category,omitempty"`
	TransparentBackground bool     `json:"transparentBackground,omitempty"`
	ReferenceStorageKeys  []string `json:"referenceStorageKeys,omitempty"`
	WorkflowRunID         string   `json:"workflowRunId,omitempty"`
	WorkflowStepID        string   `json:"workflowStepId,omitempty"`
}

type storedImageProvider struct {
	BaseURL  string                 `json:"baseUrl"`
	Model    string                 `json:"model"`
	Protocol string                 `json:"protocol"`
	Template *imageProviderTemplate `json:"template,omitempty"`
}

type storedImageChannel struct {
	ID                string                         `json:"id"`
	BaseURL           string                         `json:"baseUrl"`
	DefaultImageModel string                         `json:"defaultImageModel"`
	DefaultVideoModel string                         `json:"defaultVideoModel"`
	DefaultAudioModel string                         `json:"defaultAudioModel"`
	Providers         map[string]storedImageProvider `json:"providers"`
}

type storedImageConfig struct {
	Channels        []storedImageChannel `json:"channels"`
	ActiveChannelID string               `json:"activeChannelId"`
	SystemPrompt    string               `json:"systemPrompt"`
}

type storedConfigSecrets struct {
	APIKeys                       map[string]map[string]string `json:"apiKeys"`
	ObjectStorageAccessKeyID      string                       `json:"objectStorageAccessKeyId,omitempty"`
	ObjectStorageSecretAccessKey  string                       `json:"objectStorageSecretAccessKey,omitempty"`
	ObjectStorageSessionToken     string                       `json:"objectStorageSessionToken,omitempty"`
}

type generationResultItem struct {
	StorageKey string `json:"storageKey"`
	MIMEType   string `json:"mimeType"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Bytes      int    `json:"bytes"`
}

func (s *Server) createServerImageJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil || s.imageExecutor == nil || s.secrets == nil {
		http.Error(w, "server image generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationJobBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input createImageJobRequest
	if err := decoder.Decode(&input); err != nil || ensureJSONEOF(decoder) != nil || !validCreateImageJob(input) {
		http.Error(w, "invalid image generation job", http.StatusBadRequest)
		return
	}
	input.Parameters.Category = strings.TrimSpace(input.Parameters.Category)

	tenantID := tenantIDFrom(r)
	var referenceBytes int
	for _, storageKey := range input.Parameters.ReferenceStorageKeys {
		reference, err := s.readTenantImageBlobContext(r.Context(), tenantID, storageKey)
		if err != nil {
			http.Error(w, "server image references must be valid PNG or JPEG blobs", http.StatusBadRequest)
			return
		}
		referenceBytes += len(reference.Data)
		if referenceBytes > maxGeneratedTotalBytes {
			http.Error(w, "server image references exceed size limit", http.StatusBadRequest)
			return
		}
	}
	requestHash, err := hashImageJobRequest(input)
	if err != nil {
		http.Error(w, "invalid image generation job", http.StatusBadRequest)
		return
	}

	parameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash,
		Size: input.Parameters.Size, Quality: input.Parameters.Quality, Count: input.Parameters.Count,
		Category:              input.Parameters.Category,
		TransparentBackground: input.Parameters.TransparentBackground,
		ReferenceStorageKeys:  append([]string(nil), input.Parameters.ReferenceStorageKeys...),
	})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := store.GenerationJob{
		ID: input.ID, ProjectID: input.ProjectID, Kind: "image", Status: "queued",
		Prompt: strings.TrimSpace(input.Prompt), ProviderID: input.ProviderID, Model: input.Model,
		Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now,
	}
	meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": job.Kind, "executor": serverExecutorMarker})
	if err := s.store.CreateServerGenerationJob(r.Context(), tenantID, userIDFrom(r), job, input.Parameters.Count, meta); errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, input.ID)
		if getErr == nil && isMatchingServerImageJob(existing, requestHash) {
			w.WriteHeader(http.StatusOK)
			writeJSON(w, existing)
			return
		}
		http.Error(w, "generation job id already belongs to another request", http.StatusConflict)
		return
	} else if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "generation quota exceeded", http.StatusTooManyRequests)
		return
	} else if errors.Is(err, store.ErrInsufficientCredits) {
		http.Error(w, "insufficient credits", http.StatusPaymentRequired)
		return
	} else if errors.Is(err, store.ErrBanned) {
		http.Error(w, "account banned", http.StatusForbidden)
		return
	} else if err != nil {
		http.Error(w, "failed to store generation job", http.StatusInternalServerError)
		return
	}

	s.notifyGenerationWorkers()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, job)
}

func validCreateImageJob(input createImageJobRequest) bool {
	if !validProjectID(input.ID) || (input.ProjectID != "" && !validProjectID(input.ProjectID)) ||
		!validProjectID(input.ProviderID) || len(input.Model) > 500 {
		return false
	}
	prompt := strings.TrimSpace(input.Prompt)
	if prompt == "" || len(prompt) > 100_000 || !imageSizePattern.MatchString(input.Parameters.Size) ||
		len(input.Parameters.Quality) > 50 || input.Parameters.Count < 1 || input.Parameters.Count > 8 ||
		len(strings.TrimSpace(input.Parameters.Category)) > 100 || len(input.Parameters.ReferenceStorageKeys) > 16 {
		return false
	}
	for _, key := range input.Parameters.ReferenceStorageKeys {
		if _, ok := blobFilename(key); !ok {
			return false
		}
	}
	return true
}

func hashImageJobRequest(input createImageJobRequest) (string, error) {
	canonical := struct {
		ProjectID  string                   `json:"projectId,omitempty"`
		Prompt     string                   `json:"prompt"`
		ProviderID string                   `json:"providerId"`
		Model      string                   `json:"model,omitempty"`
		Parameters createImageJobParameters `json:"parameters"`
	}{input.ProjectID, strings.TrimSpace(input.Prompt), input.ProviderID, input.Model, input.Parameters}
	value, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:]), nil
}

func isMatchingServerImageJob(job store.GenerationJob, requestHash string) bool {
	var parameters persistedImageJobParameters
	return job.Kind == "image" && json.Unmarshal(job.Parameters, &parameters) == nil &&
		parameters.Executor == serverExecutorMarker && parameters.RequestHash == requestHash
}

func isServerGenerationJob(job store.GenerationJob) bool {
	var parameters struct {
		Executor string `json:"executor"`
	}
	if json.Unmarshal(job.Parameters, &parameters) != nil {
		return false
	}
	return ((job.Kind == "image" || job.Kind == "video" || job.Kind == "audio") && parameters.Executor == serverExecutorMarker) ||
		(job.Kind == "workflow" && parameters.Executor == "workflow")
}

func (s *Server) startGenerationWorkers(count int) {
	if s.store == nil || count < 1 {
		return
	}
	s.generationWorkersOnce.Do(func() {
		for range count {
			s.generationWorkerWG.Add(1)
			go s.generationWorkerLoop()
		}
		s.notifyGenerationWorkers()
	})
}

func (s *Server) notifyGenerationWorkers() {
	select {
	case s.generationWake <- struct{}{}:
	default:
	}
}

func (s *Server) generationWorkerLoop() {
	defer s.generationWorkerWG.Done()
	for {
		now := time.Now().UTC()
		attempt := randomGenerationOwner()
		claimed, err := s.store.ClaimServerGenerationJob(s.generationRoot,
			store.GenerationClaim{Kind: "image", Executor: serverExecutorMarker},
			attempt, now, now.Add(generationLeaseDuration))
		if err == nil {
			s.generationWG.Add(1)
			s.executeClaimedImageJob(claimed)
			s.generationWG.Done()
			continue
		}
		if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, context.Canceled) {
			// A later polling pass retries transient database failures.
		}
		select {
		case <-s.generationRoot.Done():
			return
		case <-s.generationWake:
		case <-time.After(time.Second):
		}
	}
}

func (s *Server) executeClaimedImageJob(claimed store.TenantGenerationJob) {
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
		_, err := s.store.CompleteServerGenerationJob(finishCtx, tenantID, job.ID,
			job.LeaseOwner, status, result, message, time.Now().UTC())
		durationMs := time.Since(startedAt).Milliseconds()
		s.recordAICallLog(finishCtx, tenantID, job, status, durationMs, message, auditRequest, result)
		return err == nil
	}

	request, err := s.resolveImageGenerationRequest(ctx, tenantID, job)
	if err != nil {
		log.Printf("server image job %s/%s configuration failed: %v", tenantID, job.ID, err)
		finish("failed", nil, "图片生成配置不可用，请检查渠道和密钥")
		return
	}
	auditRequest = imageRequestAuditPayload(request)
	images, err := s.imageExecutor.Generate(ctx, request)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			finish("cancelled", nil, "已取消")
			return
		}
		log.Printf("server image job %s/%s provider failed: %v", tenantID, job.ID, err)
		finish("failed", nil, "图片生成失败，请检查模型服务配置后重试")
		return
	}
	items, keys, err := s.persistGeneratedImages(ctx, tenantID, "", job.ID, job.LeaseOwner, images)
	if err != nil {
		log.Printf("server image job %s/%s result persistence failed: %v", tenantID, job.ID, err)
		for _, storageKey := range keys {
			_ = s.deleteTenantBlob(context.Background(), tenantID, "", storageKey)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			finish("cancelled", nil, "已取消")
		} else {
			finish("failed", nil, "生成结果无效或保存失败")
		}
		return
	}
	result, _ := json.Marshal(map[string]any{"items": items})
	if !finish("succeeded", result, "") {
		for _, storageKey := range keys {
			_ = s.deleteTenantBlob(context.Background(), tenantID, "", storageKey)
		}
	}
}

func (s *Server) watchGenerationCancellation(ctx context.Context, cancel context.CancelFunc, done <-chan struct{}, tenantID, id, owner string) {
	statusTicker := time.NewTicker(time.Second)
	renewTicker := time.NewTicker(generationLeaseRenewal)
	defer statusTicker.Stop()
	defer renewTicker.Stop()
	lastRenewed := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-statusTicker.C:
			job, err := s.store.GetGenerationJob(ctx, tenantID, id)
			if err == nil && (job.Status != "running" || job.LeaseOwner != owner) {
				cancel()
				return
			}
		case now := <-renewTicker.C:
			err := s.store.RenewServerGenerationJobLease(ctx, tenantID, id, owner, now.UTC(), now.UTC().Add(generationLeaseDuration))
			if err == nil {
				lastRenewed = now
				continue
			}
			if errors.Is(err, store.ErrConflict) || now.Sub(lastRenewed) >= generationLeaseDuration/2 {
				cancel()
				return
			}
		}
	}
}

func (s *Server) cancelServerGenerationJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid generation job id", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	key := tenantID + "\x00" + id
	job, err := s.store.CancelServerGenerationJob(r.Context(), tenantID, id, time.Now().UTC())
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			http.Error(w, "generation job is browser-owned", http.StatusConflict)
		} else {
			http.Error(w, "failed to cancel generation job", http.StatusInternalServerError)
		}
		return
	}
	s.generationMu.Lock()
	cancel := s.generationCancels[key]
	s.generationMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if job.Kind == "workflow" {
		for _, childID := range workflowChildJobIDs(job.Result) {
			_, _ = s.store.CancelServerGenerationJob(r.Context(), tenantID, childID, time.Now().UTC())
		}
	}
	writeJSON(w, job)
}

func (s *Server) authorizeServerGeneration(w http.ResponseWriter, r *http.Request) bool {
	if authMode() == "off" {
		if s.processToken == "" {
			http.Error(w, "server generation requires an access token when authentication is disabled", http.StatusServiceUnavailable)
			return false
		}
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return false
		}
	} else if _, ok := authUserFrom(r.Context()); !ok {
		http.Error(w, "login required", http.StatusUnauthorized)
		return false
	}
	allowed, err := s.cloudChannelAllowed(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return false
	}
	if !allowed {
		http.Error(w, cloudChannelDisabledMessage, http.StatusForbidden)
		return false
	}
	return true
}

func (s *Server) resolveImageGenerationRequest(ctx context.Context, tenantID string, job store.GenerationJob) (imageGenerationRequest, error) {
	configValue, err := s.store.GetState(ctx, tenantID, "config")
	if err != nil {
		return imageGenerationRequest{}, err
	}
	if len(configValue) > 1<<20 {
		return imageGenerationRequest{}, errors.New("image provider configuration exceeds limits")
	}
	var config storedImageConfig
	if json.Unmarshal(configValue, &config) != nil || len(config.Channels) > 100 {
		return imageGenerationRequest{}, errors.New("invalid config")
	}
	secretValue, err := s.decryptSecrets(ctx, tenantID)
	if err != nil {
		return imageGenerationRequest{}, err
	}
	var secrets storedConfigSecrets
	if json.Unmarshal(secretValue, &secrets) != nil {
		return imageGenerationRequest{}, errors.New("invalid secrets")
	}
	var channel *storedImageChannel
	for index := range config.Channels {
		if config.Channels[index].ID == job.ProviderID {
			channel = &config.Channels[index]
			break
		}
	}
	if channel == nil {
		return imageGenerationRequest{}, errors.New("channel not found")
	}
	provider, ok := channel.Providers["image"]
	if !ok {
		provider = storedImageProvider{BaseURL: channel.BaseURL, Model: channel.DefaultImageModel, Protocol: "openai"}
	}
	if provider.Protocol == "" {
		provider.Protocol = "openai"
	}
	if (provider.Protocol != "openai" && provider.Protocol != "gemini" && provider.Protocol != "template") || strings.TrimSpace(provider.BaseURL) == "" {
		return imageGenerationRequest{}, errors.New("unsupported image provider")
	}
	if provider.Protocol == "template" {
		if err := validateImageProviderTemplate(provider.Template); err != nil {
			return imageGenerationRequest{}, err
		}
	}
	if len(provider.BaseURL) > 8*1024 || len(provider.Model) > 500 || len(config.SystemPrompt) > 20_000 {
		return imageGenerationRequest{}, errors.New("image provider configuration exceeds limits")
	}
	apiKey := secrets.APIKeys[job.ProviderID]["image"]
	if apiKey == "" || len(apiKey) > 64*1024 {
		return imageGenerationRequest{}, errors.New("missing image api key")
	}
	var parameters persistedImageJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Executor != serverExecutorMarker {
		return imageGenerationRequest{}, errors.New("invalid server job parameters")
	}
	references := make([]generatedImage, 0, len(parameters.ReferenceStorageKeys))
	var referenceBytes int
	for _, storageKey := range parameters.ReferenceStorageKeys {
		imageValue, err := s.readTenantImageBlobContext(ctx, tenantID, storageKey)
		if err != nil {
			return imageGenerationRequest{}, err
		}
		referenceBytes += len(imageValue.Data)
		if referenceBytes > maxGeneratedTotalBytes {
			return imageGenerationRequest{}, errors.New("reference images exceed size limit")
		}
		references = append(references, imageValue)
	}
	prompt := strings.TrimSpace(job.Prompt)
	if systemPrompt := strings.TrimSpace(config.SystemPrompt); systemPrompt != "" {
		prompt = systemPrompt + "\n\n" + prompt
	}
	if len(prompt) > 100_000 {
		return imageGenerationRequest{}, errors.New("effective image prompt exceeds limit")
	}
	model := strings.TrimSpace(job.Model)
	if model == "" || len(model) > 500 {
		model = provider.Model
	}
	if model == "" {
		return imageGenerationRequest{}, errors.New("missing image model")
	}
	return imageGenerationRequest{
		Protocol: provider.Protocol, BaseURL: provider.BaseURL, APIKey: apiKey, Model: model, Prompt: prompt,
		Size: parameters.Size, Quality: parameters.Quality, Count: parameters.Count,
		TransparentBackground: parameters.TransparentBackground, References: references, Template: provider.Template,
	}, nil
}

func (s *Server) persistGeneratedImages(ctx context.Context, tenantID, userID, jobID, attemptID string, images []generatedImage) ([]generationResultItem, []string, error) {
	if len(images) < 1 || len(images) > 8 {
		return nil, nil, errors.New("invalid generated image count")
	}
	items := make([]generationResultItem, 0, len(images))
	keys := make([]string, 0, len(images))
	totalBytes := 0
	for index, value := range images {
		if err := ctx.Err(); err != nil {
			return nil, keys, err
		}
		mimeType, width, height, err := validateGeneratedImage(value)
		if err != nil {
			return nil, keys, err
		}
		totalBytes += len(value.Data)
		if totalBytes > maxGeneratedTotalBytes {
			return nil, keys, errors.New("generated images exceed total size limit")
		}
		sum := sha256.Sum256(append([]byte(fmt.Sprintf("%s:%s:%d:", jobID, attemptID, index)), value.Data...))
		storageKey := "image:generated:" + jobID + ":" + hex.EncodeToString(sum[:12])
		if err := s.storeTenantBlob(ctx, tenantID, userID, storageKey, mimeType, value.Data); err != nil {
			return nil, keys, err
		}
		keys = append(keys, storageKey)
		items = append(items, generationResultItem{
			StorageKey: storageKey, MIMEType: mimeType, Width: width, Height: height, Bytes: len(value.Data),
		})
	}
	return items, keys, nil
}

func validateGeneratedImage(value generatedImage) (string, int, int, error) {
	if len(value.Data) == 0 || len(value.Data) > maxGeneratedImageBytes {
		return "", 0, 0, errors.New("generated image exceeds size limit")
	}
	detected := sniffGeneratedImageMIME(value.Data)
	if detected == "" {
		return "", 0, 0, errors.New("unsupported generated image type")
	}
	if value.MIMEType != "" && value.MIMEType != detected {
		return "", 0, 0, errors.New("generated image content type mismatch")
	}
	generatedImageDecodeSlot <- struct{}{}
	width, height, err := generatedImageDimensions(detected, value.Data)
	<-generatedImageDecodeSlot
	if err != nil || width < 1 || height < 1 || int64(width)*int64(height) > maxGeneratedPixels {
		return "", 0, 0, errors.New("invalid generated image dimensions")
	}
	return detected, width, height, nil
}

func sniffGeneratedImageMIME(data []byte) string {
	detected := http.DetectContentType(data)
	if detected == "image/png" || detected == "image/jpeg" {
		return detected
	}
	return ""
}

func generatedImageDimensions(mimeType string, data []byte) (int, int, error) {
	if mimeType == "image/png" || mimeType == "image/jpeg" {
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > maxGeneratedPixels {
			return 0, 0, errors.New("invalid or oversized image")
		}
		if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
			return 0, 0, err
		}
		return config.Width, config.Height, nil
	}
	return 0, 0, errors.New("unsupported image type")
}
