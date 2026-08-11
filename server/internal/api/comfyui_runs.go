package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const comfyUIExecutorMarker = "comfyui"

const maxComfyUIExecutorConfigBytes = 1 << 20

var errComfyUIExecutorNotApproved = errors.New("ComfyUI executor is not approved")

type approvedComfyUIExecutor struct {
	ID           string
	BillingModel string
	Exclusive    bool
	Manifest     localWorkflowManifest
}

type comfyUIJobParameters struct {
	Executor      string                `json:"executor"`
	Exclusive     bool                  `json:"exclusiveExecutor,omitempty"`
	BillingUserID string                `json:"billingUserId,omitempty"`
	RequestHash   string                `json:"requestHash"`
	Manifest      localWorkflowManifest `json:"manifest"`
	Values        comfyUIWorkflowValues `json:"values"`
}

type comfyUIResultItem struct {
	StorageKey    string `json:"storageKey"`
	MIMEType      string `json:"mimeType"`
	Bytes         int    `json:"bytes"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
	ObjectVersion string `json:"objectVersion,omitempty"`
}

type comfyUIJobResult struct {
	ExternalPromptID string              `json:"externalPromptId,omitempty"`
	Items            []comfyUIResultItem `json:"items,omitempty"`
}

type createComfyUIJobRequest struct {
	ID         string                `json:"id"`
	ProjectID  string                `json:"projectId,omitempty"`
	ManifestID string                `json:"manifestId"`
	Values     comfyUIWorkflowValues `json:"values"`
}

func loadApprovedComfyUIExecutors() (map[string]approvedComfyUIExecutor, error) {
	raw := strings.TrimSpace(os.Getenv("OPENBOARD_COMFYUI_EXECUTORS"))
	if raw == "" || len(raw) > maxComfyUIExecutorConfigBytes {
		return nil, errors.New("ComfyUI executor configuration is unavailable")
	}
	var document struct {
		Executors []struct {
			ID           string          `json:"id"`
			BillingModel string          `json:"billingModel"`
			Exclusive    bool            `json:"exclusive"`
			Manifest     json.RawMessage `json:"manifest"`
		} `json:"executors"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || len(document.Executors) == 0 || len(document.Executors) > 32 {
		return nil, errors.New("ComfyUI executor configuration is invalid")
	}
	approved := make(map[string]approvedComfyUIExecutor, len(document.Executors))
	for _, candidate := range document.Executors {
		candidate.ID = strings.TrimSpace(candidate.ID)
		candidate.BillingModel = strings.TrimSpace(candidate.BillingModel)
		manifest, err := decodeLocalWorkflowManifest(candidate.Manifest)
		if err != nil || !validProjectID(candidate.ID) || manifest.ID != candidate.ID || candidate.BillingModel == "" || len(candidate.BillingModel) > 500 || strings.ContainsAny(candidate.BillingModel, "\r\n\x00") {
			return nil, errors.New("ComfyUI executor configuration is invalid")
		}
		if _, duplicate := approved[candidate.ID]; duplicate {
			return nil, errors.New("ComfyUI executor ids must be unique")
		}
		approved[candidate.ID] = approvedComfyUIExecutor{ID: candidate.ID, BillingModel: candidate.BillingModel, Exclusive: candidate.Exclusive, Manifest: manifest}
	}
	return approved, nil
}

func resolveApprovedComfyUIExecutor(id string) (approvedComfyUIExecutor, error) {
	approved, err := loadApprovedComfyUIExecutors()
	if err != nil {
		return approvedComfyUIExecutor{}, err
	}
	executor, ok := approved[strings.TrimSpace(id)]
	if !ok {
		return approvedComfyUIExecutor{}, errComfyUIExecutorNotApproved
	}
	return executor, nil
}

func (s *Server) comfyUIBillingCredits(ctx context.Context, tenantID, billingModel string) (int, error) {
	if s == nil || s.store == nil || strings.TrimSpace(billingModel) == "" {
		return 0, errors.New("ComfyUI billing configuration is unavailable")
	}
	credits, err := s.store.GetModelCreditCost(ctx, tenantID, billingModel)
	if err != nil || credits < 1 || credits > 1_000_000_000 {
		return 0, errors.New("ComfyUI billing configuration is invalid")
	}
	return credits, nil
}

func (s *Server) createComfyUIJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil {
		http.Error(w, "ComfyUI generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationJobBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input createComfyUIJobRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || !validProjectID(input.ID) ||
		(input.ProjectID != "" && !validProjectID(input.ProjectID)) {
		http.Error(w, "invalid ComfyUI generation job", http.StatusBadRequest)
		return
	}
	approved, err := resolveApprovedComfyUIExecutor(input.ManifestID)
	if errors.Is(err, errComfyUIExecutorNotApproved) {
		http.Error(w, "ComfyUI executor was not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "ComfyUI generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	manifest := approved.Manifest
	kind, err := localWorkflowOutputKind(manifest)
	if err != nil || validateComfyUIValues(manifest, input.Values) != nil {
		http.Error(w, "invalid ComfyUI workflow values", http.StatusBadRequest)
		return
	}
	if err := s.validateComfyUIReferenceBlobs(r.Context(), tenantIDFrom(r), input.Values); err != nil {
		http.Error(w, "ComfyUI references must be valid tenant PNG or JPEG blobs", http.StatusBadRequest)
		return
	}
	requestHash, err := hashComfyUIRequest(input.ProjectID, manifest, input.Values)
	if err != nil {
		http.Error(w, "invalid ComfyUI generation job", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	if existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, input.ID); getErr == nil {
		if matchingComfyUIRequest(existing, requestHash) {
			writeJSON(w, publicGenerationJob(existing))
			return
		}
		http.Error(w, "generation job id already belongs to another request", http.StatusConflict)
		return
	} else if !errors.Is(getErr, store.ErrNotFound) {
		http.Error(w, "failed to load generation job", http.StatusInternalServerError)
		return
	}
	parameters, _ := json.Marshal(comfyUIJobParameters{
		Executor: comfyUIExecutorMarker, Exclusive: approved.Exclusive, BillingUserID: userIDFrom(r), RequestHash: requestHash,
		Manifest: manifest, Values: cloneComfyUIValues(input.Values),
	})
	result, _ := json.Marshal(comfyUIJobResult{})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := store.GenerationJob{
		ID: input.ID, ProjectID: input.ProjectID, Kind: kind, Status: "queued", Prompt: strings.TrimSpace(input.Values.Prompt),
		ProviderID: approved.ID, Model: approved.BillingModel, Parameters: parameters, Result: result, CreatedAt: now, UpdatedAt: now,
	}
	estimatedCredits, err := s.comfyUIBillingCredits(r.Context(), tenantID, approved.BillingModel)
	if err != nil {
		http.Error(w, "ComfyUI billing configuration is unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.store.CheckGenerationQuota(r.Context(), tenantID); errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "generation quota exceeded", http.StatusTooManyRequests)
		return
	} else if err != nil {
		http.Error(w, "failed to check generation quota", http.StatusInternalServerError)
		return
	}
	meta, _ := json.Marshal(map[string]any{"jobId": job.ID, "kind": kind, "executor": comfyUIExecutorMarker, "manifestId": manifest.ID, "contractHash": manifest.ContractHash})
	if err := s.store.CreateServerGenerationJob(r.Context(), tenantID, userIDFrom(r), job, estimatedCredits, meta); errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, job.ID)
		if getErr == nil && matchingComfyUIRequest(existing, requestHash) {
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
	} else if errors.Is(err, store.ErrUnauthorized) {
		http.Error(w, "login required for billable generation", http.StatusUnauthorized)
		return
	} else if err != nil {
		http.Error(w, "failed to create ComfyUI generation job", http.StatusInternalServerError)
		return
	}
	s.notifyComfyUIWorkers()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, publicGenerationJob(job))
}

func validateComfyUIValues(manifest localWorkflowManifest, values comfyUIWorkflowValues) error {
	if len(values.Prompt) > maxComfyUIPromptBytes || len(values.NegativePrompt) > maxComfyUIPromptBytes ||
		len(values.References) > 8 || values.Width < 0 || values.Height < 0 || values.Duration < 0 ||
		(values.Width > 0 && (values.Width < 64 || values.Width > manifest.Limits.MaxWidth)) ||
		(values.Height > 0 && (values.Height < 64 || values.Height > manifest.Limits.MaxHeight)) ||
		(values.Duration > 0 && values.Duration > manifest.Limits.MaxSeconds) {
		return errors.New("invalid ComfyUI values")
	}
	keys := append([]string(nil), values.References...)
	keys = append(keys, values.FirstFrame, values.LastFrame)
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, ok := blobFilename(key); !ok {
			return errors.New("invalid ComfyUI reference key")
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		if len(seen) > 10 {
			return errors.New("too many ComfyUI references")
		}
	}
	_, err := compileComfyUIPrompt(manifest, values)
	return err
}

func (s *Server) validateComfyUIReferenceBlobs(ctx context.Context, tenantID string, values comfyUIWorkflowValues) error {
	keys := append([]string(nil), values.References...)
	keys = append(keys, values.FirstFrame, values.LastFrame)
	total := 0
	seen := map[string]struct{}{}
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		value, err := s.readTenantImageBlobContext(ctx, tenantID, key)
		if err != nil {
			return err
		}
		total += len(value.Data)
		if total > maxMediaReferenceBytes {
			return errors.New("ComfyUI references exceed size limit")
		}
	}
	return nil
}

func hashComfyUIRequest(projectID string, manifest localWorkflowManifest, values comfyUIWorkflowValues) (string, error) {
	canonical, err := json.Marshal(struct {
		ProjectID string                `json:"projectId,omitempty"`
		Manifest  localWorkflowManifest `json:"manifest"`
		Values    comfyUIWorkflowValues `json:"values"`
	}{ProjectID: projectID, Manifest: manifest, Values: cloneComfyUIValues(values)})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func cloneComfyUIValues(values comfyUIWorkflowValues) comfyUIWorkflowValues {
	values.References = append([]string(nil), values.References...)
	values.ReferenceNames = nil
	values.FirstFrameName = ""
	values.LastFrameName = ""
	return values
}

func matchingComfyUIRequest(job store.GenerationJob, requestHash string) bool {
	parameters, _, err := decodeComfyUIJob(job)
	return err == nil && parameters.RequestHash == requestHash
}

func decodeComfyUIJob(job store.GenerationJob) (comfyUIJobParameters, comfyUIJobResult, error) {
	if job.Kind != "image" && job.Kind != "video" && job.Kind != "audio" {
		return comfyUIJobParameters{}, comfyUIJobResult{}, errors.New("invalid ComfyUI job kind")
	}
	var parameters comfyUIJobParameters
	decoder := json.NewDecoder(bytes.NewReader(job.Parameters))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&parameters) != nil || ensureJSONEOF(decoder) != nil || parameters.Executor != comfyUIExecutorMarker ||
		len(parameters.RequestHash) != 64 || !allLowerHex(parameters.RequestHash) ||
		len(parameters.BillingUserID) > 128 || strings.TrimSpace(parameters.BillingUserID) != parameters.BillingUserID ||
		validateLocalWorkflowManifest(parameters.Manifest) != nil || validateComfyUIValues(parameters.Manifest, parameters.Values) != nil {
		return comfyUIJobParameters{}, comfyUIJobResult{}, errors.New("invalid ComfyUI job parameters")
	}
	kind, err := localWorkflowOutputKind(parameters.Manifest)
	if err != nil || kind != job.Kind {
		return comfyUIJobParameters{}, comfyUIJobResult{}, errors.New("ComfyUI job kind does not match manifest")
	}
	var result comfyUIJobResult
	resultDecoder := json.NewDecoder(bytes.NewReader(job.Result))
	resultDecoder.DisallowUnknownFields()
	if resultDecoder.Decode(&result) != nil || ensureJSONEOF(resultDecoder) != nil || len(result.Items) > 8 ||
		(result.ExternalPromptID != "" && !validComfyUIPromptID(result.ExternalPromptID)) {
		return comfyUIJobParameters{}, comfyUIJobResult{}, errors.New("invalid ComfyUI job result")
	}
	for _, item := range result.Items {
		if _, ok := blobFilename(item.StorageKey); !ok || item.Bytes < 1 || item.Bytes > maxUploadBytes || item.SHA256 == "" || item.ObjectVersion == "" {
			return comfyUIJobParameters{}, comfyUIJobResult{}, errors.New("invalid ComfyUI result item")
		}
	}
	return parameters, result, nil
}

func (s *Server) startComfyUIWorkers(count int) {
	if s.store == nil || count < 1 {
		return
	}
	s.comfyUIWorkersOnce.Do(func() {
		for range count {
			s.comfyUIWorkerWG.Add(1)
			go s.comfyUIWorkerLoop()
		}
		s.notifyComfyUIWorkers()
	})
}

func (s *Server) notifyComfyUIWorkers() {
	select {
	case s.comfyUIWake <- struct{}{}:
	default:
	}
}

func (s *Server) comfyUIWorkerLoop() {
	defer s.comfyUIWorkerWG.Done()
	kinds := []string{"image", "video", "audio"}
	for {
		claimed := false
		for _, kind := range kinds {
			now := time.Now().UTC()
			job, err := s.store.ClaimServerGenerationJob(s.generationRoot, store.GenerationClaim{Kind: kind, Executor: comfyUIExecutorMarker}, randomGenerationOwner(), now, now.Add(generationLeaseDuration))
			if err != nil {
				continue
			}
			claimed = true
			s.comfyUIWG.Add(1)
			s.executeClaimedComfyUIJob(job)
			s.comfyUIWG.Done()
			break
		}
		if claimed {
			continue
		}
		select {
		case <-s.generationRoot.Done():
			return
		case <-s.comfyUIWake:
		case <-time.After(time.Second):
		}
	}
}

func (s *Server) executeClaimedComfyUIJob(claimed store.TenantGenerationJob) {
	tenantID, job := claimed.TenantID, claimed.Job
	parameters, result, err := decodeComfyUIJob(job)
	if err != nil {
		s.completeComfyUIJob(tenantID, job, "failed", result, "ComfyUI 任务文档无效")
		return
	}
	executor, err := newComfyUIExecutor(parameters.Manifest.Endpoint, parameters.Manifest.AllowPrivate)
	if err != nil {
		s.completeComfyUIJob(tenantID, job, "failed", result, "ComfyUI 地址不可用")
		return
	}
	executor.exclusive = parameters.Exclusive
	if s.comfyUIPollInterval > 0 {
		executor.pollInterval = s.comfyUIPollInterval
	}
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

	values, err := s.prepareComfyUIInputs(ctx, tenantID, executor, parameters.Values)
	if err != nil {
		s.completeComfyUIJob(tenantID, job, "failed", result, "ComfyUI 输入素材无效或上传失败")
		return
	}
	var checkpoint *comfyUIExternalCheckpoint
	if result.ExternalPromptID != "" {
		checkpoint = &comfyUIExternalCheckpoint{PromptID: result.ExternalPromptID}
	}
	output, runErr := executor.Run(ctx, comfyUIExecutionRequest{Manifest: parameters.Manifest, Values: values}, checkpoint, func(value comfyUIExternalCheckpoint) error {
		result.ExternalPromptID = value.PromptID
		encoded, _ := json.Marshal(result)
		_, err := s.store.CheckpointServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, encoded, time.Now().UTC())
		return err
	})
	if runErr != nil {
		if ctx.Err() != nil {
			current, getErr := s.store.GetGenerationJob(context.Background(), tenantID, job.ID)
			if getErr == nil && current.Status == "cancelled" && result.ExternalPromptID != "" {
				cancelCtx, cancelRequest := context.WithTimeout(context.Background(), 5*time.Second)
				_ = executor.Cancel(cancelCtx, comfyUIExternalCheckpoint{PromptID: result.ExternalPromptID})
				cancelRequest()
			}
			return
		}
		message := "ComfyUI 执行失败"
		if errors.Is(runErr, context.DeadlineExceeded) {
			message = "ComfyUI 执行超时"
		}
		log.Printf("ComfyUI job %s/%s failed (%s)", tenantID, job.ID, comfyUIFailureClass(runErr))
		s.completeComfyUIJob(tenantID, job, "failed", result, message)
		return
	}
	if len(output.Items) == 0 {
		output.Items = []comfyUIExecutionItem{{Kind: output.Kind, Data: output.Data, MIMEType: output.MIMEType}}
	}
	result.Items, err = s.persistComfyUIOutput(ctx, tenantID, parameters.BillingUserID, job, result.ExternalPromptID, output.Items)
	if err != nil {
		log.Printf("ComfyUI job %s/%s output persistence failed: %v", tenantID, job.ID, err)
		s.completeComfyUIJob(tenantID, job, "failed", result, "ComfyUI 输出无效或保存失败")
		return
	}
	s.completeComfyUIJob(tenantID, job, "succeeded", result, "")
}

func comfyUIFailureClass(err error) string {
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "execution"
}

func (s *Server) prepareComfyUIInputs(ctx context.Context, tenantID string, executor *comfyUIExecutor, values comfyUIWorkflowValues) (comfyUIWorkflowValues, error) {
	prepared := cloneComfyUIValues(values)
	prepared.ReferenceNames = make([]string, 0, len(values.References))
	upload := func(index int, key string) (string, error) {
		image, err := s.readTenantImageBlobContext(ctx, tenantID, key)
		if err != nil {
			return "", err
		}
		digest := sha256.Sum256(image.Data)
		name := comfyUIUploadFilename(index, image.MIMEType, hex.EncodeToString(digest[:8]))
		return executor.UploadImage(ctx, name, image.MIMEType, image.Data)
	}
	for index, key := range values.References {
		name, err := upload(index, key)
		if err != nil {
			return comfyUIWorkflowValues{}, err
		}
		prepared.ReferenceNames = append(prepared.ReferenceNames, name)
	}
	if values.FirstFrame != "" {
		name, err := upload(len(values.References), values.FirstFrame)
		if err != nil {
			return comfyUIWorkflowValues{}, err
		}
		prepared.FirstFrameName = name
	}
	if values.LastFrame != "" {
		name, err := upload(len(values.References)+1, values.LastFrame)
		if err != nil {
			return comfyUIWorkflowValues{}, err
		}
		prepared.LastFrameName = name
	}
	return prepared, nil
}

func (s *Server) persistComfyUIOutput(ctx context.Context, tenantID, userID string, job store.GenerationJob, promptID string, outputs []comfyUIExecutionItem) ([]comfyUIResultItem, error) {
	if len(outputs) < 1 || len(outputs) > 8 {
		return nil, errors.New("invalid ComfyUI output count")
	}
	for _, output := range outputs {
		if output.Kind != job.Kind {
			return nil, errors.New("ComfyUI output kind mismatch")
		}
	}
	attemptID := "comfyui-" + promptID
	if job.Kind == "image" {
		images := make([]generatedImage, len(outputs))
		for index, output := range outputs {
			images[index] = generatedImage{Data: output.Data, MIMEType: normalizeMediaMIME(output.MIMEType)}
		}
		items, _, err := s.persistGeneratedImages(ctx, tenantID, userID, job.ID, attemptID, images)
		if err != nil {
			return nil, err
		}
		result := make([]comfyUIResultItem, len(items))
		for index, item := range items {
			result[index] = comfyUIResultItem{StorageKey: item.StorageKey, MIMEType: item.MIMEType, Bytes: item.Bytes, Width: item.Width, Height: item.Height, SHA256: item.SHA256, ObjectVersion: item.ObjectVersion}
		}
		return result, nil
	}
	result := make([]comfyUIResultItem, 0, len(outputs))
	for _, output := range outputs {
		item, _, err := s.persistGeneratedMedia(ctx, tenantID, userID, job.ID, attemptID, job.Kind, generatedMedia{Data: output.Data, MIMEType: normalizeMediaMIME(output.MIMEType)})
		if err != nil {
			return nil, err
		}
		result = append(result, comfyUIResultItem{StorageKey: item.StorageKey, MIMEType: item.MIMEType, Bytes: item.Bytes, SHA256: item.SHA256, ObjectVersion: item.ObjectVersion})
	}
	return result, nil
}

func (s *Server) completeComfyUIJob(tenantID string, job store.GenerationJob, status string, result comfyUIJobResult, message string) {
	encoded, _ := json.Marshal(result)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := s.store.CompleteServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, status, encoded, message, time.Now().UTC()); err != nil && !errors.Is(err, store.ErrConflict) {
		log.Printf("complete ComfyUI job %s/%s: %v", tenantID, job.ID, err)
	}
}
