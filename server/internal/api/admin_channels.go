package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"hash/fnv"
	"io"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	adminChannelSecretsStateKey = "__encrypted_admin_channel_secrets"
	sharedChannelAutoID         = "shared-auto"
	maxAdminChannelSecretBytes  = 64 << 10
	maxAdminModelsResponseBytes = 1 << 20
)

type adminChannelSecretInput struct {
	APIKey          string `json:"apiKey"`
	SecretBindingID string `json:"secretBindingId"`
}

type adminChannelModelList struct {
	Models []string `json:"models"`
}

type adminChannelSecretsEnvelope struct {
	Version int                       `json:"version"`
	Entries map[string]secretEnvelope `json:"entries"`
}

type sharedChannelPublic struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Protocol          string `json:"protocol"`
	DefaultImageModel string `json:"defaultImageModel,omitempty"`
	DefaultVideoModel string `json:"defaultVideoModel,omitempty"`
	DefaultAudioModel string `json:"defaultAudioModel,omitempty"`
}

func (s *Server) getSharedChannels(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || s.secrets == nil {
		writeJSON(w, []sharedChannelPublic{})
		return
	}
	channels, err := s.loadAdminChannels(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	presence, err := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	result := make([]sharedChannelPublic, 0, len(channels)+1)
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		if message != "" || !channel.Enabled || !channel.AllowUserUse || !presence[channel.ID] {
			continue
		}
		result = append(result, sharedChannelPublic{
			ID: channel.ID, Name: channel.Name, Protocol: channel.Protocol,
			DefaultImageModel: channel.DefaultImageModel, DefaultVideoModel: channel.DefaultVideoModel,
			DefaultAudioModel: channel.DefaultAudioModel,
		})
	}
	if len(result) > 0 {
		result = append([]sharedChannelPublic{{ID: sharedChannelAutoID, Name: "共享渠道（自动）", Protocol: "openai"}}, result...)
	}
	writeJSON(w, result)
}

const maxAdminChannelModels = 200

func normalizeAdminChannel(item adminChannelPublic) (adminChannelPublic, string) {
	item.ID = strings.TrimSpace(item.ID)
	item.Name = strings.TrimSpace(item.Name)
	item.BaseURL = strings.TrimRight(strings.TrimSpace(item.BaseURL), "/")
	item.Protocol = strings.ToLower(strings.TrimSpace(item.Protocol))
	item.DefaultTextModel = strings.TrimSpace(item.DefaultTextModel)
	item.DefaultImageModel = strings.TrimSpace(item.DefaultImageModel)
	item.DefaultVideoModel = strings.TrimSpace(item.DefaultVideoModel)
	item.DefaultAudioModel = strings.TrimSpace(item.DefaultAudioModel)
	item.SecretBindingID = strings.TrimSpace(item.SecretBindingID)
	item.SecretConfigured = false
	item.Models = cleanAdminChannelModels(item.Models)
	if !projectIDPattern.MatchString(item.ID) {
		return adminChannelPublic{}, "invalid channel id"
	}
	if item.Name == "" {
		item.Name = item.ID
	}
	if len(item.Name) > 200 || len(item.BaseURL) > 8<<10 {
		return adminChannelPublic{}, "invalid channel configuration"
	}
	if _, err := validateGenerationURL(item.BaseURL); err != nil {
		return adminChannelPublic{}, "invalid channel URL"
	}
	switch item.Protocol {
	case "openai", "gemini", "apimart", "kie":
	default:
		return adminChannelPublic{}, "unsupported channel protocol"
	}
	if item.Weight < 1 || item.Weight > 100 || item.TimeoutSeconds < 1 || item.TimeoutSeconds > 600 {
		return adminChannelPublic{}, "invalid channel routing settings"
	}
	if len(item.Models) > maxAdminChannelModels {
		return adminChannelPublic{}, "too many channel models"
	}
	for _, model := range []string{item.DefaultTextModel, item.DefaultImageModel, item.DefaultVideoModel, item.DefaultAudioModel} {
		if len(model) > 500 {
			return adminChannelPublic{}, "invalid channel model"
		}
	}
	for _, model := range item.Models {
		if len(model) > 500 {
			return adminChannelPublic{}, "invalid channel model"
		}
	}
	return item, ""
}

// cleanAdminChannelModels trims blanks and keeps first-seen order so routing and
// the admin UI see a stable list rather than whatever the browser typed.
func cleanAdminChannelModels(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	clean := make([]string, 0, len(values))
	for _, raw := range values {
		model := strings.TrimSpace(raw)
		if model == "" {
			continue
		}
		key := strings.ToLower(model)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		clean = append(clean, model)
	}
	if len(clean) == 0 {
		return nil
	}
	return clean
}

// channelModelsAllow reports whether a requested model is on the channel's
// optional allow list. An empty list means "no restriction".
func channelModelsAllow(models []string, requestedModel string) bool {
	if len(models) == 0 {
		return true
	}
	requested := strings.TrimSpace(requestedModel)
	if requested == "" {
		return false
	}
	for _, model := range models {
		if strings.EqualFold(model, requested) {
			return true
		}
	}
	return false
}

func (s *Server) loadAdminChannels(ctx context.Context, tenantID string) ([]adminChannelPublic, error) {
	raw, err := s.store.GetState(ctx, tenantID, adminChannelsStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return []adminChannelPublic{}, nil
	}
	if err != nil || len(raw) > 1<<20 {
		return nil, errors.New("shared channel configuration unavailable")
	}
	var channels []adminChannelPublic
	if json.Unmarshal(raw, &channels) != nil || len(channels) > 100 {
		return nil, errors.New("invalid shared channel configuration")
	}
	return channels, nil
}

func (s *Server) findAdminChannel(ctx context.Context, tenantID, id string) (adminChannelPublic, error) {
	channels, err := s.loadAdminChannels(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, err
	}
	for _, channel := range channels {
		if channel.ID == id {
			return channel, nil
		}
	}
	return adminChannelPublic{}, store.ErrNotFound
}

func (s *Server) resolveSharedChannel(ctx context.Context, tenantID, id string) (adminChannelPublic, string, error) {
	channel, err := s.findAdminChannel(ctx, tenantID, id)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	channel, message := normalizeAdminChannel(channel)
	if message != "" || !channel.Enabled || !channel.AllowUserUse {
		return adminChannelPublic{}, "", errors.New("shared channel is unavailable")
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	apiKey := secrets[id]
	if strings.TrimSpace(apiKey) == "" || len(apiKey) > maxAdminChannelSecretBytes {
		return adminChannelPublic{}, "", errors.New("shared channel secret is not configured")
	}
	return channel, apiKey, nil
}

func sharedChannelSupports(channel adminChannelPublic, kind, requestedModel string) bool {
	if !channel.Enabled || !channel.AllowUserUse {
		return false
	}
	model := strings.TrimSpace(requestedModel)
	if model == "" {
		switch kind {
		case "image":
			model = channel.DefaultImageModel
		case "video":
			model = channel.DefaultVideoModel
		case "audio":
			model = channel.DefaultAudioModel
		default:
			return false
		}
	}
	if strings.TrimSpace(model) == "" {
		return false
	}
	// Per-channel model lists gate routing so shared-auto never picks a channel
	// that the administrator marked as not offering this model.
	if !channelModelsAllow(channel.Models, model) {
		return false
	}
	switch kind {
	case "image":
		return channel.Protocol == "openai" || channel.Protocol == "gemini" || channel.Protocol == "apimart" || channel.Protocol == "kie"
	case "video":
		return channel.Protocol == "openai" || channel.Protocol == "apimart" || channel.Protocol == "kie"
	case "audio":
		return channel.Protocol == "openai"
	default:
		return false
	}
}

func (s *Server) selectSharedChannel(ctx context.Context, tenantID, kind, routingKey, requestedModel string) (adminChannelPublic, error) {
	channels, err := s.loadAdminChannels(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, err
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, err
	}
	eligible := make([]adminChannelPublic, 0, len(channels))
	totalWeight := uint64(0)
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		if message != "" || !sharedChannelSupports(channel, kind, requestedModel) || strings.TrimSpace(secrets[channel.ID]) == "" {
			continue
		}
		eligible = append(eligible, channel)
		totalWeight += uint64(channel.Weight)
	}
	if len(eligible) == 0 || totalWeight == 0 {
		return adminChannelPublic{}, errors.New("no eligible shared channel")
	}
	// Sorting makes the same job route to the same concrete channel even if an
	// administrator reorders the pool. The selected ID is persisted on creation,
	// so later retries do not rerun routing against a changed pool.
	sort.Slice(eligible, func(i, j int) bool { return eligible[i].ID < eligible[j].ID })
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(tenantID + "\x00" + kind + "\x00" + routingKey))
	ticket := hasher.Sum64() % totalWeight
	for _, channel := range eligible {
		weight := uint64(channel.Weight)
		if ticket < weight {
			return channel, nil
		}
		ticket -= weight
	}
	return adminChannelPublic{}, errors.New("failed to route shared channel")
}

func (s *Server) snapshotSharedProviderID(ctx context.Context, tenantID, kind, jobID, providerID, requestedModel string) (string, error) {
	if providerID != sharedChannelAutoID {
		return providerID, nil
	}
	channel, err := s.selectSharedChannel(ctx, tenantID, kind, jobID, requestedModel)
	if err != nil {
		return "", err
	}
	return channel.ID, nil
}

func sharedChannelStoredValue(channel adminChannelPublic) storedImageChannel {
	providers := map[string]storedImageProvider{}
	for kind, model := range map[string]string{
		"image": channel.DefaultImageModel,
		"video": channel.DefaultVideoModel,
		"audio": channel.DefaultAudioModel,
	} {
		if model != "" {
			providers[kind] = storedImageProvider{BaseURL: channel.BaseURL, Model: model, Protocol: channel.Protocol}
		}
	}
	return storedImageChannel{
		ID: channel.ID, BaseURL: channel.BaseURL,
		DefaultImageModel: channel.DefaultImageModel, DefaultVideoModel: channel.DefaultVideoModel,
		DefaultAudioModel: channel.DefaultAudioModel, Providers: providers,
	}
}

func adminChannelSecretAAD(tenantID string, channel adminChannelPublic) []byte {
	return []byte(strings.Join([]string{
		adminChannelSecretsStateKey,
		tenantID,
		channel.ID,
		channel.Protocol,
		channel.BaseURL,
		channel.SecretBindingID,
	}, "\x00"))
}

func newAdminChannelSecretBindingID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func sameAdminChannelSecretDestination(a, b adminChannelPublic) bool {
	return a.ID == b.ID && a.Protocol == b.Protocol && a.BaseURL == b.BaseURL
}

func (s *Server) encryptAdminChannelSecrets(tenantID string, channels []adminChannelPublic, secrets map[string]string) ([]byte, error) {
	if s.secrets == nil {
		return nil, errors.New("encrypted secret storage unavailable")
	}
	byID := make(map[string]adminChannelPublic, len(channels))
	for _, channel := range channels {
		byID[channel.ID] = channel
	}
	entries := make(map[string]secretEnvelope, len(secrets))
	for id, secret := range secrets {
		channel, ok := byID[id]
		if !ok || channel.SecretBindingID == "" || strings.TrimSpace(secret) == "" {
			continue
		}
		nonce := make([]byte, s.secrets.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return nil, err
		}
		entries[id] = secretEnvelope{
			Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
			Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, []byte(secret), adminChannelSecretAAD(tenantID, channel))),
		}
	}
	return json.Marshal(adminChannelSecretsEnvelope{Version: 2, Entries: entries})
}

func (s *Server) decryptAdminChannelSecretsRaw(tenantID string, channels []adminChannelPublic, raw []byte) (map[string]string, error) {
	if len(raw) == 0 {
		return map[string]string{}, nil
	}
	var envelope adminChannelSecretsEnvelope
	if json.Unmarshal(raw, &envelope) != nil || envelope.Version != 2 || len(envelope.Entries) > 100 {
		// Version 1 was only tenant-bound. It cannot safely survive a channel
		// destination or lifecycle change, so require administrators to re-enter it.
		return map[string]string{}, nil
	}
	if s.secrets == nil {
		return nil, errors.New("encrypted secret storage unavailable")
	}
	byID := make(map[string]adminChannelPublic, len(channels))
	for _, channel := range channels {
		byID[channel.ID] = channel
	}
	values := make(map[string]string, len(envelope.Entries))
	for id, entry := range envelope.Entries {
		channel, ok := byID[id]
		if !ok || channel.SecretBindingID == "" {
			continue
		}
		nonce, nonceErr := base64.RawStdEncoding.DecodeString(entry.Nonce)
		ciphertext, cipherErr := base64.RawStdEncoding.DecodeString(entry.Ciphertext)
		if nonceErr != nil || cipherErr != nil || len(nonce) != s.secrets.NonceSize() {
			continue
		}
		plain, err := s.secrets.Open(nil, nonce, ciphertext, adminChannelSecretAAD(tenantID, channel))
		if err != nil || len(plain) > maxAdminChannelSecretBytes || strings.TrimSpace(string(plain)) == "" {
			continue
		}
		values[id] = string(plain)
	}
	return values, nil
}

func (s *Server) decryptAdminChannelSecrets(ctx context.Context, tenantID string) (map[string]string, error) {
	if s.store == nil || s.secrets == nil {
		return nil, store.ErrNotFound
	}
	channels, err := s.loadAdminChannels(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	raw, err := s.store.GetState(ctx, tenantID, adminChannelSecretsStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return map[string]string{}, nil
	}
	if err != nil || len(raw) > 1<<20 {
		return nil, errors.New("shared channel secrets unavailable")
	}
	values, err := s.decryptAdminChannelSecretsRaw(tenantID, channels, raw)
	if err != nil {
		return nil, errors.New("invalid shared channel secrets")
	}
	return values, nil
}

func (s *Server) adminChannelSecretPresence(ctx context.Context, tenantID string) (map[string]bool, error) {
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return map[string]bool{}, err
	}
	configured := make(map[string]bool, len(secrets))
	for id, secret := range secrets {
		configured[id] = strings.TrimSpace(secret) != ""
	}
	return configured, nil
}

func getOptionalState(ctx context.Context, backend store.Store, tenantID, key string) ([]byte, error) {
	raw, err := backend.GetState(ctx, tenantID, key)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	return raw, err
}

func decodeAdminChannels(raw []byte) ([]adminChannelPublic, error) {
	if len(raw) == 0 {
		return []adminChannelPublic{}, nil
	}
	var channels []adminChannelPublic
	if json.Unmarshal(raw, &channels) != nil || len(channels) > 100 {
		return nil, errors.New("invalid shared channel configuration")
	}
	return channels, nil
}

// replaceAdminChannels invalidates secrets before publishing a destination or
// lifecycle change. CAS prevents a concurrent administrator from silently
// overwriting either state. If the second CAS loses, the safe failure mode is a
// channel that needs its secret entered again, never a secret sent elsewhere.
func (s *Server) replaceAdminChannels(ctx context.Context, tenantID string, requested []adminChannelPublic) ([]adminChannelPublic, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	currentRaw, err := getOptionalState(ctx, s.store, tenantID, adminChannelsStateKey)
	if err != nil {
		return nil, err
	}
	current, err := decodeAdminChannels(currentRaw)
	if err != nil {
		return nil, err
	}
	currentByID := make(map[string]adminChannelPublic, len(current))
	for _, channel := range current {
		currentByID[channel.ID] = channel
	}
	next := append([]adminChannelPublic(nil), requested...)
	for index := range next {
		old, exists := currentByID[next[index].ID]
		if exists && sameAdminChannelSecretDestination(old, next[index]) && old.SecretBindingID != "" {
			next[index].SecretBindingID = old.SecretBindingID
			continue
		}
		next[index].SecretBindingID, err = newAdminChannelSecretBindingID()
		if err != nil {
			return nil, err
		}
	}

	secretRaw, err := getOptionalState(ctx, s.store, tenantID, adminChannelSecretsStateKey)
	if err != nil {
		return nil, err
	}
	secrets, err := s.decryptAdminChannelSecretsRaw(tenantID, current, secretRaw)
	if err != nil {
		return nil, err
	}
	retained := make(map[string]string, len(secrets))
	for _, channel := range next {
		old, exists := currentByID[channel.ID]
		if exists && sameAdminChannelSecretDestination(old, channel) && old.SecretBindingID == channel.SecretBindingID {
			retained[channel.ID] = secrets[channel.ID]
		}
	}
	if secretRaw != nil {
		nextSecretRaw, encryptErr := s.encryptAdminChannelSecrets(tenantID, next, retained)
		if encryptErr != nil {
			return nil, encryptErr
		}
		if err := s.store.CompareAndSwapState(ctx, tenantID, adminChannelSecretsStateKey, secretRaw, nextSecretRaw); err != nil {
			return nil, err
		}
	}
	nextRaw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if err := s.store.CompareAndSwapState(ctx, tenantID, adminChannelsStateKey, currentRaw, nextRaw); err != nil {
		return nil, err
	}
	return next, nil
}

func (s *Server) putAdminChannelSecret(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
		return
	}
	if s.secrets == nil {
		http.Error(w, "encrypted secret storage unavailable", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	r.Body = http.MaxBytesReader(w, r.Body, maxAdminChannelSecretBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input adminChannelSecretInput
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || strings.TrimSpace(input.APIKey) == "" || len(input.APIKey) > maxAdminChannelSecretBytes || strings.TrimSpace(input.SecretBindingID) == "" {
		http.Error(w, "invalid channel secret", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	s.mu.Lock()
	defer s.mu.Unlock()
	channels, err := s.loadAdminChannels(r.Context(), tenantID)
	if err != nil {
		http.Error(w, "failed to load channel", http.StatusInternalServerError)
		return
	}
	var boundChannel *adminChannelPublic
	for index := range channels {
		if channels[index].ID == id {
			boundChannel = &channels[index]
			break
		}
	}
	if boundChannel == nil {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	if boundChannel.SecretBindingID == "" || boundChannel.SecretBindingID != strings.TrimSpace(input.SecretBindingID) {
		http.Error(w, "channel destination changed; reload before saving its secret", http.StatusConflict)
		return
	}
	secretRaw, err := getOptionalState(r.Context(), s.store, tenantID, adminChannelSecretsStateKey)
	if err != nil {
		http.Error(w, "failed to read channel secrets", http.StatusInternalServerError)
		return
	}
	current, err := s.decryptAdminChannelSecretsRaw(tenantID, channels, secretRaw)
	if err != nil {
		http.Error(w, "failed to read channel secrets", http.StatusInternalServerError)
		return
	}
	next := make(map[string]string, len(current)+1)
	for key, value := range current {
		next[key] = value
	}
	next[id] = input.APIKey
	envelope, err := s.encryptAdminChannelSecrets(tenantID, channels, next)
	if err != nil {
		http.Error(w, "failed to save channel secret", http.StatusInternalServerError)
		return
	}
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, adminChannelSecretsStateKey, secretRaw, envelope); errors.Is(err, store.ErrConflict) {
		http.Error(w, "channel secrets changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save channel secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteAdminChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
		return
	}
	tenantID, id := tenantIDFrom(r), chi.URLParam(r, "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	channelRaw, err := getOptionalState(r.Context(), s.store, tenantID, adminChannelsStateKey)
	if err != nil {
		http.Error(w, "failed to load channels", http.StatusInternalServerError)
		return
	}
	channels, err := decodeAdminChannels(channelRaw)
	if err != nil {
		http.Error(w, "failed to load channels", http.StatusInternalServerError)
		return
	}
	next := make([]adminChannelPublic, 0, len(channels))
	found := false
	for _, channel := range channels {
		if channel.ID == id {
			found = true
			continue
		}
		next = append(next, channel)
	}
	if !found {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	secretRaw, err := getOptionalState(r.Context(), s.store, tenantID, adminChannelSecretsStateKey)
	if err != nil {
		http.Error(w, "failed to delete channel", http.StatusInternalServerError)
		return
	}
	if secretRaw != nil {
		values, decryptErr := s.decryptAdminChannelSecretsRaw(tenantID, channels, secretRaw)
		if decryptErr != nil {
			http.Error(w, "failed to delete channel", http.StatusInternalServerError)
			return
		}
		delete(values, id)
		envelope, encryptErr := s.encryptAdminChannelSecrets(tenantID, next, values)
		if encryptErr != nil || s.store.CompareAndSwapState(r.Context(), tenantID, adminChannelSecretsStateKey, secretRaw, envelope) != nil {
			http.Error(w, "failed to delete channel", http.StatusConflict)
			return
		}
	}
	raw, _ := json.Marshal(next)
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, adminChannelsStateKey, channelRaw, raw); errors.Is(err, store.ErrConflict) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to delete channel", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) fetchAdminChannelModels(ctx context.Context, tenantID, id string) ([]string, error) {
	channel, err := s.findAdminChannel(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if !channel.Enabled {
		return nil, errors.New("channel is disabled")
	}
	if channel.Protocol != "openai" && channel.Protocol != "apimart" {
		return nil, errors.New("model discovery is unsupported for this protocol")
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil || strings.TrimSpace(secrets[id]) == "" {
		return nil, errors.New("channel secret is not configured")
	}
	endpoint, err := generationProviderEndpoint(channel.BaseURL, "/models")
	if err != nil {
		return nil, err
	}
	timeout := time.Duration(channel.TimeoutSeconds) * time.Second
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errors.New("failed to create model request")
	}
	request.Header.Set("Authorization", "Bearer "+secrets[id])
	response, err := newOpenAIImageExecutor().client.Do(request)
	if err != nil {
		return nil, errors.New("channel connection failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return nil, errors.New("channel returned an unsuccessful status")
	}
	limited := io.LimitReader(response.Body, maxAdminModelsResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil || len(body) > maxAdminModelsResponseBytes {
		return nil, errors.New("channel model response exceeds limits")
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"models"`
	}
	if json.Unmarshal(body, &payload) != nil || len(payload.Data)+len(payload.Models) > 1000 {
		return nil, errors.New("invalid channel model response")
	}
	seen := map[string]struct{}{}
	models := make([]string, 0, len(payload.Data)+len(payload.Models))
	add := func(value string) {
		value = strings.TrimSpace(strings.TrimPrefix(value, "models/"))
		if value == "" || len(value) > 500 {
			return
		}
		if _, exists := seen[value]; !exists {
			seen[value] = struct{}{}
			models = append(models, value)
		}
	}
	for _, item := range payload.Data {
		add(item.ID)
	}
	for _, item := range payload.Models {
		if item.ID != "" {
			add(item.ID)
		} else {
			add(item.Name)
		}
	}
	sort.Strings(models)
	return models, nil
}

func (s *Server) getAdminChannelModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
		return
	}
	models, err := s.fetchAdminChannelModels(r.Context(), tenantIDFrom(r), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, adminChannelModelList{Models: models})
}

func (s *Server) testAdminChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
		return
	}
	modelCount, err := s.checkAdminChannelConnection(r.Context(), tenantIDFrom(r), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "modelCount": modelCount})
}

func (s *Server) checkAdminChannelConnection(ctx context.Context, tenantID, id string) (int, error) {
	channel, err := s.findAdminChannel(ctx, tenantID, id)
	if err != nil {
		return 0, err
	}
	if channel.Protocol == "openai" || channel.Protocol == "apimart" {
		models, fetchErr := s.fetchAdminChannelModels(ctx, tenantID, id)
		return len(models), fetchErr
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil || strings.TrimSpace(secrets[id]) == "" {
		return 0, errors.New("channel secret is not configured")
	}
	parsed, err := validateGenerationURL(channel.BaseURL)
	if err != nil {
		return 0, err
	}
	endpoint := ""
	if channel.Protocol == "kie" {
		endpoint, err = kieAPIEndpoint(channel.BaseURL, "/jobs/recordInfo?taskId=openboard-connectivity-test")
	} else {
		parsed.Path = path.Clean(strings.TrimRight(parsed.Path, "/") + "/models")
		endpoint = parsed.String()
	}
	if err != nil {
		return 0, errors.New("invalid channel URL")
	}
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(channel.TimeoutSeconds)*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, errors.New("failed to create channel request")
	}
	if channel.Protocol == "gemini" {
		request.Header.Set("x-goog-api-key", secrets[id])
	} else {
		request.Header.Set("Authorization", "Bearer "+secrets[id])
	}
	response, err := newOpenAIImageExecutor().client.Do(request)
	if err != nil {
		return 0, errors.New("channel connection failed")
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxAdminModelsResponseBytes+1))
	if readErr != nil || len(body) > maxAdminModelsResponseBytes {
		return 0, errors.New("channel response exceeds limits")
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden || response.StatusCode >= 500 || response.StatusCode < 200 && response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusNotFound {
		return 0, errors.New("channel returned an unsuccessful status")
	}
	return 0, nil
}
