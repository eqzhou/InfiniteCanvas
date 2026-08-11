package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const maxVoiceCloneProviderResponseBytes = 1 << 20

type voiceCloneProviderRequest struct {
	BaseURL string
	APIKey  string
	Model   string
	Name    string
	Samples []generatedMedia
}

type voiceCloneExecutor interface {
	Clone(context.Context, voiceCloneProviderRequest) (string, error)
}

type httpVoiceCloneExecutor struct {
	client *http.Client
}

func newHTTPVoiceCloneExecutor() *httpVoiceCloneExecutor {
	return &httpVoiceCloneExecutor{client: newOpenAIImageExecutor().client}
}

func (e *httpVoiceCloneExecutor) Clone(ctx context.Context, input voiceCloneProviderRequest) (string, error) {
	if e == nil || e.client == nil || strings.TrimSpace(input.APIKey) == "" || strings.TrimSpace(input.Model) == "" || len(input.Samples) == 0 || len(input.Samples) > maxVoiceCloneSamples {
		return "", errors.New("invalid voice clone provider request")
	}
	endpoint, err := generationProviderEndpoint(input.BaseURL, "/audio/voice-clones")
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", input.Model); err != nil {
		return "", err
	}
	if err := writer.WriteField("name", input.Name); err != nil {
		return "", err
	}
	for index, sample := range input.Samples {
		if len(sample.Data) == 0 || len(sample.Data) > maxVoiceSampleBytes || !strings.HasPrefix(strings.ToLower(sample.MIMEType), "audio/") {
			return "", errors.New("invalid voice clone sample")
		}
		if detected := sniffGeneratedMediaMIME("audio", sample.Data); detected == "" || normalizeMediaMIME(sample.MIMEType) != detected {
			return "", errors.New("voice clone sample content type mismatch")
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="samples"; filename="sample-%d"`, index+1))
		header.Set("Content-Type", sample.MIMEType)
		part, err := writer.CreatePart(header)
		if err != nil {
			return "", err
		}
		if _, err := part.Write(sample.Data); err != nil {
			return "", err
		}
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+input.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := e.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return "", fmt.Errorf("voice clone provider returned HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxVoiceCloneProviderResponseBytes+1))
	if err != nil || len(payload) > maxVoiceCloneProviderResponseBytes {
		return "", errors.New("voice clone provider response exceeds size limit")
	}
	var decoded map[string]any
	if json.Unmarshal(payload, &decoded) != nil {
		return "", errors.New("voice clone provider returned invalid JSON")
	}
	providerVoiceID := mediaString(decoded, "id", "voice_id", "voiceId")
	if providerVoiceID == "" {
		providerVoiceID = mediaString(mediaMap(decoded["data"]), "id", "voice_id", "voiceId")
	}
	providerVoiceID = strings.TrimSpace(providerVoiceID)
	if providerVoiceID == "" || len(providerVoiceID) > 1000 || strings.ContainsAny(providerVoiceID, "\r\n\x00") {
		return "", errors.New("voice clone provider returned an invalid voice id")
	}
	return providerVoiceID, nil
}

func (s *Server) notifyVoiceCloneWorkers() {
	s.notifyAudioWorkers()
}

func (s *Server) executeClaimedVoiceCloneJob(claimed store.TenantGenerationJob) {
	tenantID, job := claimed.TenantID, claimed.Job
	backend, ok := s.store.(store.VoiceIdentityStore)
	if !ok || s.voiceCloneExecutor == nil {
		_, _ = s.store.CompleteServerGenerationJob(context.Background(), tenantID, job.ID, job.LeaseOwner, "failed", json.RawMessage(`{}`), "Voice clone execution is unavailable", time.Now().UTC())
		return
	}
	var parameters voiceCloneJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Executor != voiceCloneExecutorMarker || parameters.ProjectID != job.ProjectID || !validProjectID(parameters.VersionID) || !validProjectID(parameters.VoiceIdentityID) {
		_, _ = s.store.CompleteServerGenerationJob(context.Background(), tenantID, job.ID, job.LeaseOwner, "failed", json.RawMessage(`{}`), "Voice clone job is invalid", time.Now().UTC())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = backend.CompleteVoiceIdentityVersion(context.Background(), tenantID, job.ProjectID, parameters.VersionID, job.ID, "running", "", "", now)
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
	request, timeout, err := s.resolveVoiceCloneProviderRequest(ctx, tenantID, job, parameters)
	if err == nil {
		var providerCancel context.CancelFunc
		ctx, providerCancel = generationProviderContext(ctx, timeout)
		defer providerCancel()
	}
	providerVoiceID := ""
	if err == nil {
		providerVoiceID, err = s.voiceCloneExecutor.Clone(ctx, request)
	}
	status, versionStatus, message := "succeeded", "ready", ""
	result := json.RawMessage(`{}`)
	if err != nil {
		status, versionStatus, message = "failed", "failed", "Voice clone provider failed"
		if errors.Is(ctx.Err(), context.Canceled) {
			status, versionStatus, message = "cancelled", "canceled", "Voice clone was canceled"
		}
	} else {
		result, _ = json.Marshal(map[string]string{"voiceId": providerVoiceID})
	}
	completed, completeErr := s.store.CompleteServerGenerationJob(context.Background(), tenantID, job.ID, job.LeaseOwner, status, result, message, time.Now().UTC())
	if completeErr != nil {
		return
	}
	_, _ = backend.CompleteVoiceIdentityVersion(context.Background(), tenantID, job.ProjectID, parameters.VersionID, completed.ID, versionStatus, providerVoiceID, message, completed.UpdatedAt)
}

func (s *Server) resolveVoiceCloneProviderRequest(ctx context.Context, tenantID string, job store.GenerationJob, parameters voiceCloneJobParameters) (voiceCloneProviderRequest, time.Duration, error) {
	configValue, err := s.store.GetState(ctx, tenantID, "config")
	if err != nil || len(configValue) > 1<<20 {
		return voiceCloneProviderRequest{}, 0, errors.New("generation config unavailable")
	}
	var config storedImageConfig
	if json.Unmarshal(configValue, &config) != nil || len(config.Channels) > 100 {
		return voiceCloneProviderRequest{}, 0, errors.New("invalid generation config")
	}
	var channel *storedImageChannel
	for index := range config.Channels {
		if config.Channels[index].ID == job.ProviderID {
			channel = &config.Channels[index]
			break
		}
	}
	apiKey := ""
	if channel == nil {
		shared, sharedSecret, sharedErr := s.resolveSharedChannel(ctx, tenantID, job.ProviderID)
		if sharedErr != nil {
			return voiceCloneProviderRequest{}, 0, errors.New("channel not found")
		}
		value := sharedChannelStoredValue(shared)
		channel, apiKey = &value, sharedSecret
	} else {
		secretValue, secretErr := s.decryptSecrets(ctx, tenantID)
		if secretErr != nil {
			return voiceCloneProviderRequest{}, 0, secretErr
		}
		var secrets storedConfigSecrets
		if json.Unmarshal(secretValue, &secrets) != nil {
			return voiceCloneProviderRequest{}, 0, errors.New("invalid secrets")
		}
		apiKey = secrets.APIKeys[job.ProviderID]["audio"]
	}
	provider, exists := channel.Providers["audio"]
	if !exists {
		provider = storedImageProvider{BaseURL: channel.BaseURL, Model: channel.DefaultAudioModel, Protocol: "openai"}
	}
	if protocol := strings.TrimSpace(provider.Protocol); protocol != "" && protocol != "openai" {
		return voiceCloneProviderRequest{}, 0, errors.New("voice cloning requires an OpenAI-compatible audio provider")
	}
	if _, err := validateGenerationURL(provider.BaseURL); err != nil || strings.TrimSpace(apiKey) == "" {
		return voiceCloneProviderRequest{}, 0, errors.New("voice clone provider is unavailable")
	}
	timeout, err := personalChannelTimeout(channel.TimeoutSeconds)
	if err != nil {
		return voiceCloneProviderRequest{}, 0, err
	}
	request := voiceCloneProviderRequest{BaseURL: provider.BaseURL, APIKey: apiKey, Model: job.Model, Name: job.Prompt}
	total := 0
	for _, snapshot := range parameters.Samples {
		value, readErr := s.readTenantBlob(ctx, tenantID, snapshot.StorageKey, maxVoiceSampleBytes)
		if readErr != nil || value.Metadata.ContentType != snapshot.MIMEType || sha256Hex(value.Data) != snapshot.SHA256 || blobIdentityVersion(value) != snapshot.ObjectVersion {
			return voiceCloneProviderRequest{}, 0, errors.New("voice clone sample changed")
		}
		total += len(value.Data)
		if total > maxMediaReferenceBytes {
			return voiceCloneProviderRequest{}, 0, errors.New("voice clone samples exceed total size limit")
		}
		request.Samples = append(request.Samples, generatedMedia{Data: value.Data, MIMEType: value.Metadata.ContentType})
	}
	return request, timeout, nil
}
