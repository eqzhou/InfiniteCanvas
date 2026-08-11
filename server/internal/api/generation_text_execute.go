package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type persistedTextJobParameters struct {
	Executor         string                       `json:"executor"`
	RequestHash      string                       `json:"requestHash"`
	Operation        string                       `json:"operation"`
	PromptVersion    string                       `json:"promptVersion"`
	OutputSchema     string                       `json:"outputSchema"`
	ScriptMode       string                       `json:"scriptMode,omitempty"`
	SystemPrompt     string                       `json:"systemPrompt"`
	SourceRevision   int                          `json:"sourceRevision"`
	SourceSHA256     string                       `json:"sourceSha256"`
	FilmRevision     int                          `json:"filmRevision"`
	TargetEntityID   string                       `json:"targetEntityId,omitempty"`
	TargetRevision   int                          `json:"targetRevision,omitempty"`
	TargetSHA256     string                       `json:"targetSha256,omitempty"`
	EstimatedCredits int                          `json:"estimatedCredits,omitempty"`
	SharedChannel    *generationChannelSnapshot   `json:"sharedChannel,omitempty"`
	Film             *filmGenerationBinding       `json:"film,omitempty"`
	Style            *filmStyleExtractionSnapshot `json:"style,omitempty"`
}

type textExecutor interface {
	Generate(context.Context, providerModelConnection, providerTextRequest) (string, error)
}

type providerTextExecutor struct{}

func allowServerTextProviderLoopback(tenantID string) bool {
	databaseURL, err := url.Parse(strings.TrimSpace(os.Getenv("OPENBOARD_DATABASE_URL")))
	if err != nil || databaseURL.Scheme == "" || !strings.HasPrefix(path.Base(databaseURL.Path), "openboard_e2e_") {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv("OPENBOARD_AUTH_MODE")), "off") &&
		len(strings.TrimSpace(os.Getenv("OPENBOARD_E2E_TENANT_TOKEN"))) >= 32 &&
		e2eTenantIDPattern.MatchString(strings.TrimSpace(tenantID))
}

func (providerTextExecutor) Generate(
	ctx context.Context,
	connection providerModelConnection,
	request providerTextRequest,
) (string, error) {
	return fetchProviderTextWithClient(ctx, connection, &request, providerTextHTTPClient, request.AllowLoopback)
}

func validatePersistedTextJob(job store.GenerationJob, parameters persistedTextJobParameters) error {
	if job.Kind != "text" || parameters.Executor != serverExecutorMarker ||
		strings.TrimSpace(parameters.RequestHash) == "" || len(parameters.RequestHash) > 128 ||
		len(parameters.Operation) > 100 || len(parameters.PromptVersion) > 100 || len(parameters.OutputSchema) > 100 ||
		len(parameters.SystemPrompt) > maxProviderTextSystemRunes {
		return errors.New("invalid server text job parameters")
	}
	if parameters.Operation != "film_decompose" && parameters.Operation != "film_script" && parameters.Operation != "film_style_extraction" {
		return errors.New("unsupported server text operation")
	}
	if parameters.SourceRevision < 0 || (parameters.SourceRevision > 0 && !validFilmRequestHash(parameters.SourceSHA256)) || parameters.FilmRevision < 0 {
		return errors.New("invalid server text source snapshot")
	}
	if parameters.Operation == "film_script" && (!validProjectID(parameters.TargetEntityID) || parameters.TargetRevision < 1 || !validFilmRequestHash(parameters.TargetSHA256)) {
		return errors.New("invalid server text target snapshot")
	}
	if parameters.Operation == "film_script" && parameters.ScriptMode != "" && !validFilmScriptMode(parameters.ScriptMode) {
		return errors.New("invalid server text script mode")
	}
	if parameters.Operation == "film_style_extraction" {
		if parameters.Style == nil || parameters.Film == nil || parameters.Film.Stage != "style_extraction" ||
			parameters.Style.SourceAsset.Revision < 1 || parameters.Style.SourceAsset.MediaStorageKey == "" ||
			!strings.HasPrefix(parameters.Style.SourceAsset.MediaMIMEType, "image/") ||
			!validSHA256Hex(parameters.Style.SourceAsset.MediaSHA256) || parameters.Style.SourceAsset.MediaObjectVersion == "" ||
			parameters.Style.PromptVersion != parameters.PromptVersion || parameters.Style.OutputSchema != parameters.OutputSchema ||
			!validFilmStyleParameters(parameters.Style.Parameters) {
			return errors.New("invalid server style extraction snapshot")
		}
	} else if parameters.Style != nil {
		return errors.New("unexpected server style extraction snapshot")
	}
	return nil
}

func (s *Server) resolveTextGenerationRequest(
	ctx context.Context,
	tenantID string,
	job store.GenerationJob,
) (providerModelConnection, providerTextRequest, error) {
	var parameters persistedTextJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil {
		return providerModelConnection{}, providerTextRequest{}, errors.New("invalid server text job parameters")
	}
	if err := validatePersistedTextJob(job, parameters); err != nil {
		return providerModelConnection{}, providerTextRequest{}, err
	}
	request := providerTextRequest{ChannelID: job.ProviderID, Model: job.Model, Prompt: job.Prompt}
	var connection providerModelConnection
	if snapshot := parameters.SharedChannel; snapshot != nil {
		if snapshot.ProviderID != job.ProviderID || snapshot.Model != job.Model {
			return providerModelConnection{}, providerTextRequest{}, errors.New("invalid generation channel snapshot")
		}
		apiKey, err := s.openGenerationChannelSecret(tenantID, job.ID, job.Kind, *snapshot)
		if err != nil {
			return providerModelConnection{}, providerTextRequest{}, err
		}
		timeout, err := generationChannelTimeout(snapshot)
		if err != nil {
			return providerModelConnection{}, providerTextRequest{}, err
		}
		connection = providerModelConnection{
			BaseURL: snapshot.BaseURL, APIKey: apiKey, Protocol: snapshot.Protocol,
			SystemPrompt: snapshot.SystemPrompt, Timeout: timeout,
		}
		request.SystemPrompt = snapshot.SystemPrompt
	} else {
		configValue, err := s.store.GetState(ctx, tenantID, "config")
		if err != nil || len(configValue) > 1<<20 {
			return providerModelConnection{}, providerTextRequest{}, errors.New("provider configuration is unavailable")
		}
		var config storedImageConfig
		if json.Unmarshal(configValue, &config) != nil || len(config.Channels) > 100 {
			return providerModelConnection{}, providerTextRequest{}, errors.New("invalid provider configuration")
		}
		var selected *storedImageChannel
		for index := range config.Channels {
			if config.Channels[index].ID == job.ProviderID {
				selected = &config.Channels[index]
				break
			}
		}
		if selected == nil {
			return providerModelConnection{}, providerTextRequest{}, errors.New("channel not found")
		}
		provider, ok := selected.Providers["text"]
		if !ok {
			provider = storedImageProvider{BaseURL: selected.BaseURL, Model: selected.DefaultTextModel, Protocol: "openai"}
		}
		secretValue, err := s.decryptSecrets(ctx, tenantID)
		if err != nil {
			return providerModelConnection{}, providerTextRequest{}, errors.New("provider API key is unavailable")
		}
		var secrets storedConfigSecrets
		if json.Unmarshal(secretValue, &secrets) != nil {
			return providerModelConnection{}, providerTextRequest{}, errors.New("invalid provider credentials")
		}
		timeout, err := personalChannelTimeout(selected.TimeoutSeconds)
		if err != nil {
			return providerModelConnection{}, providerTextRequest{}, err
		}
		connection = providerModelConnection{
			BaseURL: provider.BaseURL, APIKey: secrets.APIKeys[job.ProviderID]["text"],
			Protocol: provider.Protocol, SystemPrompt: config.SystemPrompt, Timeout: timeout,
		}
		request.SystemPrompt = config.SystemPrompt
	}
	if strings.TrimSpace(parameters.SystemPrompt) != "" {
		request.SystemPrompt = parameters.SystemPrompt
	}
	if parameters.Operation == "film_style_extraction" {
		asset := parameters.Style.SourceAsset
		value, err := s.readTenantBlob(ctx, tenantID, asset.MediaStorageKey, maxProviderTextImageBytes)
		if err != nil || verifyFilmBlob(value, "image/", asset.MediaMIMEType, asset.MediaSHA256, asset.MediaObjectVersion, 0) != nil {
			return providerModelConnection{}, providerTextRequest{}, errors.New("frozen style source image is unavailable or changed")
		}
		request.Images = []string{styleDataURL(asset, value)}
	}
	if err := validateProviderTextRequest(request); err != nil {
		return providerModelConnection{}, providerTextRequest{}, err
	}
	return connection, request, nil
}

func (s *Server) executeClaimedTextJob(claimed store.TenantGenerationJob) {
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

	finish := func(status string, result json.RawMessage, message string, auditRequest any) {
		// Process shutdown must leave the lease untouched so another instance can
		// reclaim the job after it expires. A user cancellation is persisted by
		// the cancellation endpoint before it cancels this worker context.
		if s.generationRoot.Err() != nil {
			return
		}
		if result == nil {
			result = json.RawMessage(`{}`)
		}
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer finishCancel()
		completed, err := s.store.CompleteServerGenerationJob(
			finishCtx, tenantID, job.ID, job.LeaseOwner, status, result, message, time.Now().UTC(),
		)
		if err != nil {
			return
		}
		s.recordAICallLog(finishCtx, tenantID, job, status, time.Since(startedAt).Milliseconds(), message, auditRequest, result)
		if status == "succeeded" {
			if err := s.syncFilmTextJobCandidate(finishCtx, tenantID, completed); err != nil {
				log.Printf("server text job %s/%s candidate sync failed: %v", tenantID, job.ID, err)
			}
		}
	}

	connection, request, err := s.resolveTextGenerationRequest(ctx, tenantID, job)
	if err != nil {
		log.Printf("server text job %s/%s configuration failed: %v", tenantID, job.ID, err)
		finish("failed", nil, "文本生成配置不可用，请检查渠道和模型", nil)
		return
	}
	request.AllowLoopback = allowServerTextProviderLoopback(tenantID)
	text, err := s.textExecutor.Generate(ctx, connection, request)
	if err != nil {
		finish("failed", nil, "文本生成失败，请稍后重试", providerTextAuditPayload(request, connection.Protocol))
		return
	}
	var parameters persistedTextJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil {
		finish("failed", nil, "文本生成任务快照无效", providerTextAuditPayload(request, connection.Protocol))
		return
	}
	if parameters.Operation == "film_decompose" {
		if _, err := parseFilmAIDecompositionCandidate([]byte(text)); err != nil {
			finish("failed", nil, "文本生成结果不符合影视拆解合同", providerTextAuditPayload(request, connection.Protocol))
			return
		}
	} else if parameters.Operation == "film_script" {
		if _, err := parseFilmAIScriptCandidate([]byte(text)); err != nil {
			finish("failed", nil, "文本生成结果不符合分集剧本合同", providerTextAuditPayload(request, connection.Protocol))
			return
		}
	} else if parameters.Operation == "film_style_extraction" {
		if _, err := parseFilmStyleBible([]byte(text)); err != nil {
			finish("failed", nil, "风格提取结果不符合风格圣经合同", providerTextAuditPayload(request, connection.Protocol))
			return
		}
	}
	result, err := json.Marshal(providerTextResult{Text: text})
	if err != nil || len(result) > maxProviderTextResponseBytes {
		finish("failed", nil, "文本生成结果超过限制", providerTextAuditPayload(request, connection.Protocol))
		return
	}
	finish("succeeded", result, "", providerTextAuditPayload(request, connection.Protocol))
}
