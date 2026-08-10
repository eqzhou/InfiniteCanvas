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
	"net/url"
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
	maxReferenceImagePixels = 100_000_000
	serverExecutorMarker    = "server"
	generationLeaseDuration = 2 * time.Minute
	generationLeaseRenewal  = 10 * time.Second
)

var imageSizePattern = regexp.MustCompile(`^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$`)
var geminiImageModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$`)
var networkURLPattern = regexp.MustCompile(`(?i)https?://[^\s"]+`)
var networkHostnamePattern = regexp.MustCompile(`(?i)(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:[0-9]{1,3}\.){3}[0-9]{1,3}`)
var networkSecretPattern = regexp.MustCompile(`(?i)\b(?:sk|key|token|secret)[-_][a-z0-9._-]+\b`)
var generatedImageDecodeSlot = make(chan struct{}, 1)

func imageProviderStatusCode(err error) (int, bool) {
	var imageErr *imageProviderHTTPError
	if errors.As(err, &imageErr) {
		return imageErr.StatusCode, true
	}
	var apimartErr *apimartHTTPError
	if errors.As(err, &apimartErr) {
		return apimartErr.StatusCode, true
	}
	var kieErr *kieHTTPError
	if errors.As(err, &kieErr) {
		return kieErr.StatusCode, true
	}
	return 0, false
}

func imageGenerationFailureMessage(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "图片生成请求超时，请稍后重试或增大渠道超时时间"
	}
	var networkErr *url.Error
	if errors.As(err, &networkErr) {
		if imageProviderNetworkTimeout(networkErr) {
			return "连接模型服务超时，请检查网络或增大渠道超时时间"
		}
		if imageProviderConnectionInterrupted(networkErr) {
			return "模型服务在生成过程中中断了连接，请稍后重试或检查上游网关"
		}
		return "连接模型服务失败，请检查服务 URL 和网络"
	}
	statusCode, ok := imageProviderStatusCode(err)
	if !ok {
		return "图片生成失败，请检查模型服务配置后重试"
	}
	switch statusCode {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusUnprocessableEntity:
		return fmt.Sprintf("模型服务拒绝了图片请求（HTTP %d），请检查模型、尺寸和参数", statusCode)
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Sprintf("模型服务鉴权失败（HTTP %d），请检查 API Key", statusCode)
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return fmt.Sprintf("图片生成请求超时（HTTP %d），请稍后重试或增大渠道超时时间", statusCode)
	case http.StatusRequestEntityTooLarge:
		return "图片请求或参考素材过大（HTTP 413），请减小素材后重试"
	case http.StatusTooManyRequests:
		return "模型服务请求过于频繁（HTTP 429），请稍后重试"
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable:
		return fmt.Sprintf("模型服务暂时不可用（HTTP %d），请稍后重试", statusCode)
	default:
		return fmt.Sprintf("图片生成失败（模型服务 HTTP %d）", statusCode)
	}
}

func imageProviderConnectionInterrupted(err *url.Error) bool {
	if err == nil || err.Err == nil {
		return false
	}
	message := strings.ToLower(err.Err.Error())
	return strings.Contains(message, "unexpected eof") ||
		strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "connection closed")
}

func imageGenerationFailureLogDetail(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline exceeded"
	}
	var networkErr *url.Error
	if errors.As(err, &networkErr) {
		category := "network error"
		if imageProviderNetworkTimeout(networkErr) {
			category = "network timeout"
		}
		return fmt.Sprintf("%s (%T): %s", category, innermostError(networkErr.Err), sanitizedNetworkError(networkErr.Err))
	}
	if statusCode, ok := imageProviderStatusCode(err); ok {
		return fmt.Sprintf("HTTP %d", statusCode)
	}
	return fmt.Sprintf("error type %T", err)
}

// imageProviderNetworkTimeout covers transport implementations that report a
// response-header timeout as a plain error string instead of implementing
// net.Error. Go's HTTP/2 transport uses this form, so relying solely on
// url.Error.Timeout() would misclassify an upstream timeout as a generic
// URL/network failure.
func imageProviderNetworkTimeout(err *url.Error) bool {
	if err == nil {
		return false
	}
	if err.Timeout() {
		return true
	}
	if errors.Is(err.Err, context.DeadlineExceeded) {
		return true
	}
	if err.Err == nil {
		return false
	}
	message := strings.ToLower(err.Err.Error())
	return strings.Contains(message, "timeout awaiting response headers") || message == "context deadline exceeded"
}

func sanitizedNetworkError(err error) string {
	if err == nil {
		return "unknown transport error"
	}
	message := networkURLPattern.ReplaceAllString(strings.TrimSpace(err.Error()), "<provider-url>")
	message = networkHostnamePattern.ReplaceAllString(message, "<provider-host>")
	message = networkSecretPattern.ReplaceAllString(message, "<redacted>")
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 256 {
		// This detail is appended to the audit log's error text column, so the
		// cut has to land on a rune boundary or the INSERT fails.
		message = truncateUTF8Bytes(message, 256) + "…"
	}
	if message == "" {
		return "unknown transport error"
	}
	return message
}

func innermostError(err error) error {
	if next := errors.Unwrap(err); next != nil {
		return innermostError(next)
	}
	return err
}

type imageGenerationRequest struct {
	Protocol              string
	BaseURL               string
	APIKey                string
	Model                 string
	RequestID             string
	Prompt                string
	Size                  string
	Quality               string
	Count                 int
	TransparentBackground bool
	References            []generatedImage
	// ReferenceStorageKeys is kept separately from References so audit logs can
	// identify the source images without ever persisting their binary contents.
	ReferenceStorageKeys []string
	Source               *imageGenerationSource
	Template             *imageProviderTemplate
	ProviderTimeout      time.Duration
}

func providerRequestID(jobID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(jobID)))
	digest[6] = (digest[6] & 0x0f) | 0x40
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", digest[0:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}

type generatedImage struct {
	Data     []byte
	MIMEType string
}

type imageExecutor interface {
	Generate(context.Context, imageGenerationRequest) ([]generatedImage, error)
}

type resumableImageExecutor interface {
	GenerateResumable(context.Context, imageGenerationRequest, *videoProviderCheckpoint, func(videoProviderCheckpoint) error) ([]generatedImage, error)
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
	Size                  string                 `json:"size"`
	Quality               string                 `json:"quality,omitempty"`
	Count                 int                    `json:"count"`
	Category              string                 `json:"category,omitempty"`
	TransparentBackground bool                   `json:"transparentBackground,omitempty"`
	ReferenceStorageKeys  []string               `json:"referenceStorageKeys,omitempty"`
	Source                *imageGenerationSource `json:"source,omitempty"`
}

type imageGenerationSource struct {
	Kind           string `json:"kind"`
	DirectorNodeID string `json:"directorNodeId"`
	CaptureID      string `json:"captureId"`
	CameraID       string `json:"cameraId"`
	ConfigNodeID   string `json:"configNodeId"`
}

type persistedImageJobParameters struct {
	Executor              string                     `json:"executor"`
	RequestHash           string                     `json:"requestHash"`
	Size                  string                     `json:"size"`
	Quality               string                     `json:"quality,omitempty"`
	Count                 int                        `json:"count"`
	Category              string                     `json:"category,omitempty"`
	TransparentBackground bool                       `json:"transparentBackground,omitempty"`
	ReferenceStorageKeys  []string                   `json:"referenceStorageKeys,omitempty"`
	Source                *imageGenerationSource     `json:"source,omitempty"`
	WorkflowRunID         string                     `json:"workflowRunId,omitempty"`
	WorkflowStepID        string                     `json:"workflowStepId,omitempty"`
	SharedChannel         *generationChannelSnapshot `json:"sharedChannel,omitempty"`
	Film                  *filmGenerationBinding     `json:"film,omitempty"`
}

type storedImageProvider struct {
	BaseURL  string                 `json:"baseUrl"`
	Model    string                 `json:"model"`
	Protocol string                 `json:"protocol"`
	Template *imageProviderTemplate `json:"template,omitempty"`
}

type storedImageChannel struct {
	ID                string                         `json:"id"`
	TimeoutSeconds    int                            `json:"timeoutSeconds"`
	BaseURL           string                         `json:"baseUrl"`
	DefaultTextModel  string                         `json:"defaultTextModel"`
	DefaultImageModel string                         `json:"defaultImageModel"`
	DefaultVideoModel string                         `json:"defaultVideoModel"`
	DefaultAudioModel string                         `json:"defaultAudioModel"`
	Providers         map[string]storedImageProvider `json:"providers"`
}

func personalChannelTimeout(seconds int) (time.Duration, error) {
	if seconds == 0 {
		return 60 * time.Second, nil
	}
	if seconds < 1 || seconds > 600 {
		return 0, errors.New("invalid personal channel timeout")
	}
	return time.Duration(seconds) * time.Second, nil
}

type storedImageConfig struct {
	Channels                  []storedImageChannel `json:"channels"`
	ActiveChannelID           string               `json:"activeChannelId"`
	SystemPrompt              string               `json:"systemPrompt"`
	WorkflowAgentSystemPrompt string               `json:"workflowAgentSystemPrompt"`
}

type storedConfigSecrets struct {
	APIKeys                      map[string]map[string]string `json:"apiKeys"`
	ObjectStorageAccessKeyID     string                       `json:"objectStorageAccessKeyId,omitempty"`
	ObjectStorageSecretAccessKey string                       `json:"objectStorageSecretAccessKey,omitempty"`
	ObjectStorageSessionToken    string                       `json:"objectStorageSessionToken,omitempty"`
}

type generationResultItem struct {
	StorageKey    string `json:"storageKey"`
	MIMEType      string `json:"mimeType"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	Bytes         int    `json:"bytes"`
	SHA256        string `json:"sha256,omitempty"`
	ObjectVersion string `json:"objectVersion,omitempty"`
}

type serverImageJobResult struct {
	UpstreamTask *videoProviderCheckpoint `json:"upstreamTask,omitempty"`
	Items        []generationResultItem   `json:"items,omitempty"`
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
	if input.Parameters.Source != nil && !s.validDirectorImageSource(r, input) {
		http.Error(w, "invalid director image source", http.StatusBadRequest)
		return
	}
	// The tenant model allow list is a governance rule, so it must hold here
	// and not only in the picker the client renders.
	if !s.requireAllowedModel(w, r, input.Model) {
		return
	}
	input.Parameters.Category = strings.TrimSpace(input.Parameters.Category)

	tenantID := tenantIDFrom(r)
	requestHash, err := hashImageJobRequest(input)
	if err != nil {
		http.Error(w, "invalid image generation job", http.StatusBadRequest)
		return
	}
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, input.ID); getErr == nil && isMatchingServerImageJob(existing, requestHash) {
		writeJSON(w, publicGenerationJob(existing))
		return
	}
	selectedProviderID, sharedSnapshot, err := s.snapshotGenerationChannel(r.Context(), tenantID, "image", input.ID, input.ProviderID, input.Model)
	if err != nil {
		http.Error(w, "no eligible shared image channel", http.StatusUnprocessableEntity)
		return
	}
	input.ProviderID = selectedProviderID
	if sharedSnapshot != nil {
		input.Model = sharedSnapshot.Model
	}
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
	parameters, _ := json.Marshal(persistedImageJobParameters{
		Executor: serverExecutorMarker, RequestHash: requestHash,
		Size: input.Parameters.Size, Quality: input.Parameters.Quality, Count: input.Parameters.Count,
		Category:              input.Parameters.Category,
		TransparentBackground: input.Parameters.TransparentBackground,
		ReferenceStorageKeys:  append([]string(nil), input.Parameters.ReferenceStorageKeys...),
		Source:                input.Parameters.Source,
		SharedChannel:         sharedSnapshot,
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
			writeJSON(w, publicGenerationJob(existing))
			return
		}
		http.Error(w, "generation job id already belongs to another request", http.StatusConflict)
		return
	} else if errors.Is(err, store.ErrGone) {
		http.Error(w, "generation job was deleted", http.StatusGone)
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
	writeJSON(w, publicGenerationJob(job))
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
	if input.Parameters.Source != nil {
		source := input.Parameters.Source
		if input.ProjectID == "" || source.Kind != "director" || !boardIDPattern.MatchString(source.DirectorNodeID) ||
			!projectIDPattern.MatchString(source.CaptureID) || !boardIDPattern.MatchString(source.CameraID) ||
			!boardIDPattern.MatchString(source.ConfigNodeID) {
			return false
		}
	}
	return true
}

func (s *Server) validDirectorImageSource(r *http.Request, input createImageJobRequest) bool {
	source := input.Parameters.Source
	if source == nil {
		return true
	}
	_, captures, err := s.readDirectorCaptureDocument(r)
	if err != nil {
		return false
	}
	for _, capture := range captures.Items {
		if capture.ID != source.CaptureID {
			continue
		}
		if capture.ProjectID != input.ProjectID || capture.DirectorNodeID != source.DirectorNodeID ||
			capture.CameraID != source.CameraID || len(capture.Shot) == 0 {
			return false
		}
		break
	}
	rawProject, err := s.store.GetProject(r.Context(), tenantIDFrom(r), input.ProjectID)
	if err != nil {
		return false
	}
	var project struct {
		Nodes []struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			Metadata struct {
				StorageKey           string   `json:"storageKey"`
				ReferenceStorageKeys []string `json:"referenceStorageKeys"`
				DirectorShot         *struct {
					Role           string               `json:"role"`
					DirectorNodeID string               `json:"directorNodeId"`
					CaptureID      string               `json:"captureId"`
					Snapshot       directorShotSnapshot `json:"snapshot"`
				} `json:"directorShot"`
			} `json:"metadata"`
		} `json:"nodes"`
		Edges []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"edges"`
	}
	if json.Unmarshal(rawProject, &project) != nil {
		return false
	}
	foundDirector, foundConfig, foundDurableCapture := false, false, false
	durableCaptureNodeID := ""
	for _, node := range project.Nodes {
		if node.ID == source.DirectorNodeID && node.Type == "director" {
			foundDirector = true
		}
		if node.ID == source.ConfigNodeID && node.Type == "config" && node.Metadata.DirectorShot != nil {
			shot := node.Metadata.DirectorShot
			foundConfig = shot.Role == "config" && shot.DirectorNodeID == source.DirectorNodeID &&
				shot.CaptureID == source.CaptureID && shot.Snapshot.DirectorNodeID == source.DirectorNodeID &&
				shot.Snapshot.Camera.ID == source.CameraID && len(node.Metadata.ReferenceStorageKeys) > 0 &&
				sameStringSlice(node.Metadata.ReferenceStorageKeys, input.Parameters.ReferenceStorageKeys)
		}
		if node.Type == "image" && node.Metadata.DirectorShot != nil {
			shot := node.Metadata.DirectorShot
			if shot.Role == "capture" && shot.DirectorNodeID == source.DirectorNodeID && shot.CaptureID == source.CaptureID &&
				shot.Snapshot.DirectorNodeID == source.DirectorNodeID && shot.Snapshot.Camera.ID == source.CameraID &&
				stringSliceContains(input.Parameters.ReferenceStorageKeys, node.Metadata.StorageKey) {
				foundDurableCapture = true
				durableCaptureNodeID = node.ID
			}
		}
	}
	if !foundDirector || !foundConfig {
		return false
	}
	if !foundDurableCapture {
		// The editable config and tenant-owned reference remain valid if the
		// user deliberately removed the visual capture node from the canvas.
		return true
	}
	foundDirectorEdge, foundConfigEdge := false, false
	for _, edge := range project.Edges {
		foundDirectorEdge = foundDirectorEdge || edge.From == source.DirectorNodeID && edge.To == durableCaptureNodeID
		foundConfigEdge = foundConfigEdge || edge.From == durableCaptureNodeID && edge.To == source.ConfigNodeID
	}
	// A tray record may be deleted after the durable copy has been committed.
	// In that case the persisted project chain remains the provenance authority.
	return foundDirectorEdge && foundConfigEdge
}

func stringSliceContains(values []string, target string) bool {
	if target == "" {
		return false
	}
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sameStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
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
	return ((job.Kind == "text" || job.Kind == "image" || job.Kind == "video" || job.Kind == "audio") && parameters.Executor == serverExecutorMarker) ||
		(job.Kind == "workflow" && parameters.Executor == "workflow") ||
		(job.Kind == "export" && parameters.Executor == filmExportExecutorMarker)
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
	kinds := []string{"text", "image"}
	nextKind := 0
	for {
		claimedWork := false
		for offset := range kinds {
			kindIndex := (nextKind + offset) % len(kinds)
			now := time.Now().UTC()
			attempt := randomGenerationOwner()
			claimed, err := s.store.ClaimServerGenerationJob(s.generationRoot,
				store.GenerationClaim{Kind: kinds[kindIndex], Executor: serverExecutorMarker},
				attempt, now, now.Add(generationLeaseDuration))
			if err == nil {
				nextKind = (kindIndex + 1) % len(kinds)
				s.generationWG.Add(1)
				if claimed.Job.Kind == "text" {
					s.executeClaimedTextJob(claimed)
				} else {
					s.executeClaimedImageJob(claimed)
				}
				s.generationWG.Done()
				claimedWork = true
				break
			}
			if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, context.Canceled) {
				// A later polling pass retries transient database failures.
			}
		}
		if claimedWork {
			continue
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
	auditError := ""
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
		auditMessage := strings.TrimSpace(message)
		if detail := strings.TrimSpace(auditError); detail != "" {
			if auditMessage == "" {
				auditMessage = detail
			} else {
				auditMessage += " [" + detail + "]"
			}
		}
		s.recordAICallLog(finishCtx, tenantID, job, status, durationMs, auditMessage, auditRequest, result)
		return err == nil
	}

	request, err := s.resolveImageGenerationRequest(ctx, tenantID, job)
	if err != nil {
		log.Printf("server image job %s/%s configuration failed: %v", tenantID, job.ID, err)
		finish("failed", nil, "图片生成配置不可用，请检查渠道和密钥")
		return
	}
	auditRequest = imageRequestAuditPayload(request)
	providerCtx, providerCancel := generationProviderContext(ctx, request.ProviderTimeout)
	defer providerCancel()
	var checkpoint *videoProviderCheckpoint
	if (request.Protocol == "apimart" || request.Protocol == "kie") && len(job.Result) > 0 && string(job.Result) != "{}" {
		var previous serverImageJobResult
		if json.Unmarshal(job.Result, &previous) != nil || previous.UpstreamTask == nil ||
			!validVideoCheckpoint(*previous.UpstreamTask) || previous.UpstreamTask.Protocol != request.Protocol {
			finish("failed", nil, "图片生成检查点无效")
			return
		}
		checkpoint = previous.UpstreamTask
	}
	images, err := func() ([]generatedImage, error) {
		resumable, ok := s.imageExecutor.(resumableImageExecutor)
		if (request.Protocol != "apimart" && request.Protocol != "kie") || !ok {
			return s.imageExecutor.Generate(providerCtx, request)
		}
		return resumable.GenerateResumable(providerCtx, request, checkpoint, func(value videoProviderCheckpoint) error {
			if !validVideoCheckpoint(value) || value.Protocol != request.Protocol {
				return errors.New("invalid image provider checkpoint")
			}
			result, _ := json.Marshal(serverImageJobResult{UpstreamTask: &value})
			_, err := s.store.CheckpointServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, result, time.Now().UTC())
			return err
		})
	}()
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			finish("cancelled", nil, "已取消")
			return
		}
		auditError = imageGenerationFailureLogDetail(err)
		log.Printf("server image job %s/%s provider failed: %s", tenantID, job.ID, auditError)
		finish("failed", nil, imageGenerationFailureMessage(err))
		return
	}
	filmBinding, _ := filmJobBinding(job)
	items, keys, err := s.persistGeneratedImagesScoped(ctx, tenantID, "", job.ID, job.LeaseOwner, images, filmBinding != nil)
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
	result, _ := json.Marshal(serverImageJobResult{Items: items})
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
			// NotFound covers hard-deleted project history; non-running covers cancel/refund.
			if errors.Is(err, store.ErrNotFound) || (err == nil && (job.Status != "running" || job.LeaseOwner != owner)) {
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

func (s *Server) cancelLocalGeneration(tenantID, id string) {
	key := tenantID + "\x00" + id
	s.generationMu.Lock()
	cancel := s.generationCancels[key]
	s.generationMu.Unlock()
	if cancel != nil {
		cancel()
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
	s.cancelLocalGeneration(tenantID, id)
	if job.Kind == "workflow" {
		for _, childID := range workflowChildJobIDs(job.Result) {
			_, _ = s.store.CancelServerGenerationJob(r.Context(), tenantID, childID, time.Now().UTC())
			s.cancelLocalGeneration(tenantID, childID)
		}
	}
	if job.Kind == "export" && job.Status == "cancelled" {
		if parameters, _, decodeErr := decodeFilmExportJob(job); decodeErr == nil {
			deliverableID := stableFilmID("deliverable", parameters.ProjectID, parameters.IdempotencyKey)
			s.cancelFilmExportDeliverable(r.Context(), tenantID, parameters.ProjectID, deliverableID, job.ID)
		}
	}
	writeJSON(w, publicGenerationJob(job))
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
	var parameters persistedImageJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Executor != serverExecutorMarker {
		return imageGenerationRequest{}, errors.New("invalid server job parameters")
	}
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
	if parameters.SharedChannel != nil {
		snapshot := parameters.SharedChannel
		if snapshot.ProviderID != job.ProviderID {
			return imageGenerationRequest{}, errors.New("invalid generation channel snapshot")
		}
		apiKey, err = s.openGenerationChannelSecret(tenantID, job.ID, job.Kind, *snapshot)
		if err != nil {
			return imageGenerationRequest{}, err
		}
		providerTimeout, err = generationChannelTimeout(snapshot)
		if err != nil {
			return imageGenerationRequest{}, err
		}
		channel = &storedImageChannel{
			ID: snapshot.ProviderID, BaseURL: snapshot.BaseURL, DefaultImageModel: snapshot.Model,
			Providers: map[string]storedImageProvider{"image": {BaseURL: snapshot.BaseURL, Model: snapshot.Model, Protocol: snapshot.Protocol}},
		}
		systemPrompt = snapshot.SystemPrompt
	} else if channel == nil {
		shared, sharedSecret, sharedErr := s.resolveSharedChannel(ctx, tenantID, job.ProviderID)
		if sharedErr != nil {
			return imageGenerationRequest{}, errors.New("channel not found")
		}
		providerTimeout, err = personalChannelTimeout(shared.TimeoutSeconds)
		if err != nil {
			return imageGenerationRequest{}, err
		}
		value := sharedChannelStoredValue(shared)
		channel, apiKey = &value, sharedSecret
	} else {
		secretValue, secretErr := s.decryptSecrets(ctx, tenantID)
		if secretErr != nil {
			return imageGenerationRequest{}, secretErr
		}
		var secrets storedConfigSecrets
		if json.Unmarshal(secretValue, &secrets) != nil {
			return imageGenerationRequest{}, errors.New("invalid secrets")
		}
		apiKey = secrets.APIKeys[job.ProviderID]["image"]
		// See resolveMediaGenerationRequest: this must be read before a
		// snapshot job can replace channel with a timeout-less synthetic value.
		providerTimeout, err = personalChannelTimeout(channel.TimeoutSeconds)
		if err != nil {
			return imageGenerationRequest{}, err
		}
	}
	provider, ok := channel.Providers["image"]
	if !ok {
		provider = storedImageProvider{BaseURL: channel.BaseURL, Model: channel.DefaultImageModel, Protocol: "openai"}
	}
	if provider.Protocol == "" {
		provider.Protocol = "openai"
	}
	if (provider.Protocol != "openai" && provider.Protocol != "gemini" && provider.Protocol != "template" && provider.Protocol != "apimart" && provider.Protocol != "kie") || strings.TrimSpace(provider.BaseURL) == "" {
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
	if apiKey == "" || len(apiKey) > 64*1024 {
		return imageGenerationRequest{}, errors.New("missing image api key")
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
	if systemPrompt = strings.TrimSpace(systemPrompt); systemPrompt != "" {
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
		RequestID: providerRequestID(job.ID),
		Size:      parameters.Size, Quality: parameters.Quality, Count: parameters.Count,
		TransparentBackground: parameters.TransparentBackground, References: references,
		ReferenceStorageKeys: append([]string(nil), parameters.ReferenceStorageKeys...), Template: provider.Template,
		Source:          parameters.Source,
		ProviderTimeout: providerTimeout,
	}, nil
}

func (s *Server) persistGeneratedImages(ctx context.Context, tenantID, userID, jobID, attemptID string, images []generatedImage) ([]generationResultItem, []string, error) {
	return s.persistGeneratedImagesScoped(ctx, tenantID, userID, jobID, attemptID, images, false)
}

func (s *Server) persistGeneratedImagesScoped(ctx context.Context, tenantID, userID, jobID, attemptID string, images []generatedImage, protected bool) ([]generationResultItem, []string, error) {
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
		if protected {
			storageKey = "film:media:image:" + jobID + ":" + hex.EncodeToString(sum[:12])
		}
		if err := s.storeTenantBlob(ctx, tenantID, userID, storageKey, mimeType, value.Data); err != nil {
			return nil, keys, err
		}
		stored, err := s.readTenantBlob(ctx, tenantID, storageKey, int64(len(value.Data)))
		if err != nil {
			return nil, keys, err
		}
		keys = append(keys, storageKey)
		items = append(items, generationResultItem{
			StorageKey: storageKey, MIMEType: mimeType, Width: width, Height: height, Bytes: len(value.Data), SHA256: sha256Hex(value.Data), ObjectVersion: blobIdentityVersion(stored),
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

// Input references retain their original camera resolution. DecodeConfig
// validates the supported image header and dimensions without allocating a
// full uncompressed bitmap; providers perform their own final input decode.
func validateReferenceImage(value generatedImage) (string, int, int, error) {
	if len(value.Data) == 0 || len(value.Data) > maxGeneratedImageBytes {
		return "", 0, 0, errors.New("reference image exceeds size limit")
	}
	detected := sniffGeneratedImageMIME(value.Data)
	if detected == "" {
		return "", 0, 0, errors.New("unsupported reference image type")
	}
	if value.MIMEType != "" && value.MIMEType != detected {
		return "", 0, 0, errors.New("reference image content type mismatch")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(value.Data))
	if err != nil || config.Width < 1 || config.Height < 1 ||
		int64(config.Width)*int64(config.Height) > maxReferenceImagePixels {
		return "", 0, 0, errors.New("invalid reference image dimensions")
	}
	return detected, config.Width, config.Height, nil
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
