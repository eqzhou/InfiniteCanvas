package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

// generationChannelSnapshot binds a queued shared-channel job to the exact
// destination, protocol, model and encrypted credential selected at creation.
// This prevents later administrative changes from silently rerouting retries.
type generationChannelSnapshot struct {
	Source         string         `json:"source,omitempty"`
	ProviderID     string         `json:"providerId"`
	BaseURL        string         `json:"baseUrl"`
	Protocol       string         `json:"protocol"`
	Model          string         `json:"model"`
	TimeoutSeconds int            `json:"timeoutSeconds"`
	SystemPrompt   string         `json:"systemPrompt,omitempty"`
	Secret         secretEnvelope `json:"secret"`
}

func generationChannelTimeout(snapshot *generationChannelSnapshot) (time.Duration, error) {
	if snapshot == nil {
		return 0, nil
	}
	if snapshot.TimeoutSeconds < 1 || snapshot.TimeoutSeconds > 600 {
		return 0, errors.New("invalid generation channel timeout")
	}
	return time.Duration(snapshot.TimeoutSeconds) * time.Second, nil
}

func validateGenerationSnapshotDestination(snapshot generationChannelSnapshot) error {
	return validateAccountManagedChannelURL(snapshot.BaseURL)
}

func generationProviderContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		return parent, func() {}
	}
	return context.WithTimeout(parent, timeout)
}

func generationChannelSnapshotAAD(tenantID, jobID, kind, providerID, baseURL, protocol string) []byte {
	return []byte(strings.Join([]string{
		"generation-channel-v1", tenantID, jobID, kind, providerID,
		strings.TrimRight(strings.TrimSpace(baseURL), "/"), strings.ToLower(strings.TrimSpace(protocol)),
	}, "\x00"))
}

func (s *Server) sealGenerationChannelSecret(tenantID, jobID, kind string, channel adminChannelPublic, apiKey string) (secretEnvelope, error) {
	if !adminChannelRequiresSecret(channel) {
		return secretEnvelope{}, nil
	}
	if s.secrets == nil {
		return secretEnvelope{}, errors.New("encrypted secret storage unavailable")
	}
	nonce := make([]byte, s.secrets.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return secretEnvelope{}, err
	}
	aad := generationChannelSnapshotAAD(tenantID, jobID, kind, channel.ID, channel.BaseURL, channel.Protocol)
	return secretEnvelope{
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, []byte(apiKey), aad)),
	}, nil
}

func (s *Server) openGenerationChannelSecret(tenantID, jobID, kind string, snapshot generationChannelSnapshot) (string, error) {
	if snapshot.Protocol == "edge" {
		return "", nil
	}
	nonce, nonceErr := base64.RawStdEncoding.DecodeString(snapshot.Secret.Nonce)
	ciphertext, cipherErr := base64.RawStdEncoding.DecodeString(snapshot.Secret.Ciphertext)
	if s.secrets == nil || nonceErr != nil || cipherErr != nil || len(nonce) != s.secrets.NonceSize() {
		return "", errors.New("invalid generation channel snapshot")
	}
	aad := generationChannelSnapshotAAD(tenantID, jobID, kind, snapshot.ProviderID, snapshot.BaseURL, snapshot.Protocol)
	plain, err := s.secrets.Open(nil, nonce, ciphertext, aad)
	if err != nil || strings.TrimSpace(string(plain)) == "" || len(plain) > maxAdminChannelSecretBytes {
		return "", errors.New("invalid generation channel snapshot")
	}
	return string(plain), nil
}

func generationCredentialStorageKeys(userID string) (string, string, error) {
	if authMode() == "off" {
		return "config", secretStateKey, nil
	}
	userID = strings.TrimSpace(userID)
	if userID == "" || len(userID) > 128 {
		return "", "", store.ErrUnauthorized
	}
	return userConfigStateKeyPrefix + userID, userSecretStateKeyPrefix + userID, nil
}

func generationContextUserID(ctx context.Context) string {
	if user, ok := authUserFrom(ctx); ok {
		return user.ID
	}
	return ""
}

func (s *Server) loadGenerationConfig(ctx context.Context, tenantID, userID string) (storedImageConfig, bool, error) {
	configKey, _, err := generationCredentialStorageKeys(userID)
	if err != nil {
		return storedImageConfig{}, false, err
	}
	raw, err := s.store.GetState(ctx, tenantID, configKey)
	if errors.Is(err, store.ErrNotFound) {
		return storedImageConfig{}, false, nil
	}
	if err != nil {
		return storedImageConfig{}, false, err
	}
	if len(raw) > 1<<20 {
		return storedImageConfig{}, false, errors.New("generation config exceeds limits")
	}
	var config storedImageConfig
	if jsonUnmarshalStrictEnough(raw, &config) != nil || len(config.Channels) > 100 || len(config.SystemPrompt) > 20_000 {
		return storedImageConfig{}, false, errors.New("invalid generation config")
	}
	return config, true, nil
}

func jsonUnmarshalStrictEnough(value []byte, output any) error {
	// Stored app config is versioned client data and may contain newer fields;
	// ordinary json unmarshalling intentionally preserves forward compatibility.
	return json.Unmarshal(value, output)
}

func stripGenerationChannelSecret(parameters json.RawMessage) json.RawMessage {
	var root map[string]json.RawMessage
	if json.Unmarshal(parameters, &root) != nil {
		return append(json.RawMessage(nil), parameters...)
	}
	changed := false
	if _, ok := root["billingUserId"]; ok {
		delete(root, "billingUserId")
		changed = true
	}
	rawSnapshot, ok := root["sharedChannel"]
	if ok {
		var snapshot map[string]json.RawMessage
		if json.Unmarshal(rawSnapshot, &snapshot) == nil {
			if _, hasSecret := snapshot["secret"]; hasSecret {
				delete(snapshot, "secret")
				cleanSnapshot, err := json.Marshal(snapshot)
				if err != nil {
					return append(json.RawMessage(nil), parameters...)
				}
				root["sharedChannel"] = cleanSnapshot
				changed = true
			}
		}
	}
	if !changed {
		return append(json.RawMessage(nil), parameters...)
	}
	cleanParameters, err := json.Marshal(root)
	if err != nil {
		return append(json.RawMessage(nil), parameters...)
	}
	return cleanParameters
}

func publicGenerationJob(job store.GenerationJob) store.GenerationJob {
	rawParameters := append(json.RawMessage(nil), job.Parameters...)
	job.Parameters = stripPublicGenerationParameters(stripGenerationChannelSecret(rawParameters))
	job.Result = stripPublicGenerationResult(rawParameters, job.Result)
	return job
}

func stripPublicGenerationResult(parameters, result json.RawMessage) json.RawMessage {
	var root map[string]json.RawMessage
	if json.Unmarshal(parameters, &root) != nil {
		return append(json.RawMessage(nil), result...)
	}
	var executor string
	if rawExecutor, ok := root["executor"]; !ok || json.Unmarshal(rawExecutor, &executor) != nil || executor != comfyUIExecutorMarker {
		return append(json.RawMessage(nil), result...)
	}
	var private comfyUIJobResult
	if json.Unmarshal(result, &private) != nil {
		return json.RawMessage(`{}`)
	}
	type publicItem struct {
		MIMEType string `json:"mimeType"`
		Bytes    int    `json:"bytes"`
		Width    int    `json:"width,omitempty"`
		Height   int    `json:"height,omitempty"`
	}
	items := make([]publicItem, 0, len(private.Items))
	for _, item := range private.Items {
		items = append(items, publicItem{MIMEType: item.MIMEType, Bytes: item.Bytes, Width: item.Width, Height: item.Height})
	}
	clean, err := json.Marshal(struct {
		Items []publicItem `json:"items,omitempty"`
	}{Items: items})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return clean
}

func stripPublicGenerationParameters(parameters json.RawMessage) json.RawMessage {
	var root map[string]json.RawMessage
	if json.Unmarshal(parameters, &root) != nil {
		return append(json.RawMessage(nil), parameters...)
	}
	var executor string
	if rawExecutor, ok := root["executor"]; ok && json.Unmarshal(rawExecutor, &executor) == nil && (executor == voiceCloneExecutorMarker || executor == comfyUIExecutorMarker) {
		clean, err := json.Marshal(map[string]string{"executor": executor})
		if err == nil {
			return clean
		}
		return json.RawMessage(`{}`)
	}
	return append(json.RawMessage(nil), parameters...)
}

func publicGenerationJobPage(page store.GenerationJobPage) store.GenerationJobPage {
	items := make([]store.GenerationJob, len(page.Items))
	for i, job := range page.Items {
		items[i] = publicGenerationJob(job)
	}
	page.Items = items
	return page
}

func (s *Server) snapshotGenerationChannel(ctx context.Context, tenantID, kind, jobID, providerID, requestedModel string, generationModes ...string) (string, *generationChannelSnapshot, error) {
	config, _, err := s.loadGenerationConfig(ctx, tenantID, generationContextUserID(ctx))
	if err != nil {
		return "", nil, err
	}
	if providerID != sharedChannelAutoID {
		for _, channel := range config.Channels {
			if channel.ID == providerID {
				return providerID, nil, nil
			}
		}
	}
	var channel adminChannelPublic
	var apiKey string
	if providerID == sharedChannelAutoID {
		channel, err = s.selectSharedChannel(ctx, tenantID, kind, jobID, requestedModel, generationModes...)
		if err == nil {
			_, apiKey, err = s.resolveSharedChannel(ctx, tenantID, channel.ID)
		}
	} else {
		channel, apiKey, err = s.resolveSharedChannel(ctx, tenantID, providerID)
		if errors.Is(err, store.ErrNotFound) {
			return providerID, nil, nil
		}
	}
	if err != nil {
		return "", nil, err
	}
	if channel.Source != "platform" {
		if err := validateAccountManagedChannelURL(channel.BaseURL); err != nil {
			return "", nil, err
		}
	}
	model := strings.TrimSpace(requestedModel)
	if model == "" {
		switch kind {
		case "text":
			model = channel.DefaultTextModel
		case "image":
			model = channel.DefaultImageModel
		case "video":
			model = channel.DefaultVideoModel
		case "audio":
			model = channel.DefaultAudioModel
		}
	}
	sealed, err := s.sealGenerationChannelSecret(tenantID, jobID, kind, channel, apiKey)
	if err != nil {
		return "", nil, err
	}
	return channel.ID, &generationChannelSnapshot{
		Source: channel.Source, ProviderID: channel.ID, BaseURL: channel.BaseURL, Protocol: channel.Protocol, Model: model,
		TimeoutSeconds: channel.TimeoutSeconds, SystemPrompt: config.SystemPrompt, Secret: sealed,
	}, nil
}
