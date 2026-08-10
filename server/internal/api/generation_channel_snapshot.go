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

func (s *Server) personalChannelExists(ctx context.Context, tenantID, providerID string) bool {
	raw, err := s.store.GetState(ctx, tenantID, "config")
	if err != nil || len(raw) > 1<<20 {
		return false
	}
	var config storedImageConfig
	if unmarshalErr := jsonUnmarshalStrictEnough(raw, &config); unmarshalErr != nil {
		return false
	}
	for _, channel := range config.Channels {
		if channel.ID == providerID {
			return true
		}
	}
	return false
}

func (s *Server) generationSystemPrompt(ctx context.Context, tenantID string) string {
	raw, err := s.store.GetState(ctx, tenantID, "config")
	if err != nil || len(raw) > 1<<20 {
		return ""
	}
	var config storedImageConfig
	if json.Unmarshal(raw, &config) != nil || len(config.SystemPrompt) > 20_000 {
		return ""
	}
	return config.SystemPrompt
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
	job.Parameters = stripGenerationChannelSecret(job.Parameters)
	return job
}

func publicGenerationJobPage(page store.GenerationJobPage) store.GenerationJobPage {
	items := make([]store.GenerationJob, len(page.Items))
	for i, job := range page.Items {
		items[i] = publicGenerationJob(job)
	}
	page.Items = items
	return page
}

func (s *Server) snapshotGenerationChannel(ctx context.Context, tenantID, kind, jobID, providerID, requestedModel string) (string, *generationChannelSnapshot, error) {
	if providerID != sharedChannelAutoID && s.personalChannelExists(ctx, tenantID, providerID) {
		return providerID, nil, nil
	}
	var channel adminChannelPublic
	var apiKey string
	var err error
	if providerID == sharedChannelAutoID {
		channel, err = s.selectSharedChannel(ctx, tenantID, kind, jobID, requestedModel)
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
		ProviderID: channel.ID, BaseURL: channel.BaseURL, Protocol: channel.Protocol, Model: model,
		TimeoutSeconds: channel.TimeoutSeconds, SystemPrompt: s.generationSystemPrompt(ctx, tenantID), Secret: sealed,
	}, nil
}
