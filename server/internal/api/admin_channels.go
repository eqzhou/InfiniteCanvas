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
	"regexp"
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

type adminChannelPreviewInput struct {
	ID                string `json:"id"`
	BaseURL           string `json:"baseUrl"`
	Protocol          string `json:"protocol"`
	TimeoutSeconds    int    `json:"timeoutSeconds"`
	DefaultAudioModel string `json:"defaultAudioModel"`
	APIKey            string `json:"apiKey"`
}

type adminChannelModelList struct {
	Models []string `json:"models"`
}

type adminChannelSecretsEnvelope struct {
	Version int                       `json:"version"`
	Entries map[string]secretEnvelope `json:"entries"`
}

type sharedChannelPublic struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Protocol          string   `json:"protocol"`
	Source            string   `json:"source"`
	DefaultTextModel  string   `json:"defaultTextModel,omitempty"`
	DefaultImageModel string   `json:"defaultImageModel,omitempty"`
	DefaultVideoModel string   `json:"defaultVideoModel,omitempty"`
	DefaultAudioModel string   `json:"defaultAudioModel,omitempty"`
	Models            []string `json:"models,omitempty"`
}

func (s *Server) getSharedChannels(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || s.secrets == nil {
		writeJSON(w, []sharedChannelPublic{})
		return
	}
	tenantID := tenantIDFrom(r)
	channels, err := s.loadAdminChannels(r.Context(), tenantID)
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	presence, err := s.adminChannelSecretPresence(r.Context(), tenantID)
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	platformChannels, err := s.loadPlatformChannels(r.Context())
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	platformPresence, err := s.platformChannelSecretPresence(r.Context())
	if err != nil {
		http.Error(w, "failed to load shared channels", http.StatusInternalServerError)
		return
	}
	result := make([]sharedChannelPublic, 0, len(channels)+len(platformChannels)+1)
	seen := make(map[string]struct{}, len(channels)+len(platformChannels))
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		channel.Source = "tenant"
		if message != "" || validateAccountManagedChannelURL(channel.BaseURL) != nil {
			continue
		}
		// A tenant definition intentionally shadows the platform channel with
		// the same ID even when the tenant disabled it. This keeps discovery and
		// execution semantics identical and lets an Owner opt their tenant out.
		seen[channel.ID] = struct{}{}
		if !channel.Enabled || !channel.AllowUserUse ||
			(adminChannelRequiresSecret(channel) && !presence[channel.ID]) {
			continue
		}
		result = append(result, sharedChannelPublic{
			ID: channel.ID, Name: channel.Name, Protocol: channel.Protocol, Source: "tenant",
			DefaultTextModel:  channel.DefaultTextModel,
			DefaultImageModel: channel.DefaultImageModel, DefaultVideoModel: channel.DefaultVideoModel,
			DefaultAudioModel: channel.DefaultAudioModel, Models: append([]string(nil), channel.Models...),
		})
	}
	for _, raw := range platformChannels {
		_, duplicate := seen[raw.ID]
		if !platformChannelVisibleToTenant(raw, tenantID) {
			continue
		}
		channel, message := normalizeAdminChannel(raw.adminChannel())
		channel.Source = "platform"
		if message != "" || !channel.Enabled || !channel.AllowUserUse || duplicate ||
			(adminChannelRequiresSecret(channel) && !platformPresence[channel.ID]) {
			continue
		}
		seen[channel.ID] = struct{}{}
		result = append(result, sharedChannelPublic{
			ID: channel.ID, Name: channel.Name, Protocol: channel.Protocol, Source: "platform",
			DefaultTextModel: channel.DefaultTextModel, DefaultImageModel: channel.DefaultImageModel,
			DefaultVideoModel: channel.DefaultVideoModel, DefaultAudioModel: channel.DefaultAudioModel,
			Models: append([]string(nil), channel.Models...),
		})
	}
	if len(result) > 0 {
		result = append([]sharedChannelPublic{{ID: sharedChannelAutoID, Name: "共享渠道（自动）", Protocol: "openai", Source: "automatic"}}, result...)
	}
	writeJSON(w, result)
}

const (
	maxAdminChannelModels            = 200
	maxAdminMediaCapabilities        = 200
	maxAdminMediaCapabilityValues    = 64
	maxAdminMediaCapabilityValueSize = 100
	maxAdminMediaReferences          = 16
	maxAdminMediaDurationSeconds     = 900
)

var adminMediaSizePattern = regexp.MustCompile(`^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|\d{3,4}p|[1248][kK]|auto|adaptive)$`)

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
	case "openai", "gemini", "apimart", "kie", "azure", "edge":
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
	if item.Enabled && item.AllowUserUse && item.DefaultTextModel == "" && item.DefaultImageModel == "" &&
		item.DefaultVideoModel == "" && item.DefaultAudioModel == "" {
		return adminChannelPublic{}, "shared channel requires a default model"
	}
	for _, model := range item.Models {
		if len(model) > 500 {
			return adminChannelPublic{}, "invalid channel model"
		}
	}
	capabilities, message := normalizeAdminMediaCapabilities(item)
	if message != "" {
		return adminChannelPublic{}, message
	}
	item.MediaCapabilities = capabilities
	return item, ""
}

func normalizeAdminMediaCapabilities(channel adminChannelPublic) ([]adminMediaCapability, string) {
	if len(channel.MediaCapabilities) == 0 {
		return nil, ""
	}
	if len(channel.MediaCapabilities) > maxAdminMediaCapabilities {
		return nil, "too many media capabilities"
	}
	seen := make(map[string]struct{}, len(channel.MediaCapabilities))
	clean := make([]adminMediaCapability, 0, len(channel.MediaCapabilities))
	for _, raw := range channel.MediaCapabilities {
		capability := adminMediaCapability{
			Model:         strings.TrimSpace(raw.Model),
			Kind:          strings.ToLower(strings.TrimSpace(raw.Kind)),
			MaxReferences: raw.MaxReferences,
		}
		if capability.Model == "" || len(capability.Model) > 500 || !adminMediaCapabilityModelAllowed(channel, capability.Model) {
			return nil, "invalid media capability model"
		}
		if capability.Kind != "image" && capability.Kind != "video" && capability.Kind != "audio" {
			return nil, "invalid media capability kind"
		}
		key := capability.Kind + "\x00" + strings.ToLower(capability.Model)
		if _, exists := seen[key]; exists {
			return nil, "duplicate media capability"
		}
		seen[key] = struct{}{}

		var message string
		capability.Modes, message = normalizeAdminMediaModes(raw.Modes, capability.Kind)
		if message != "" {
			return nil, message
		}
		capability.Sizes, message = normalizeAdminMediaStrings(raw.Sizes)
		if message != "" {
			return nil, "invalid media capability sizes"
		}
		capability.Durations, message = normalizeAdminMediaDurations(raw.Durations)
		if message != "" {
			return nil, message
		}
		if capability.MaxReferences < 0 || capability.MaxReferences > maxAdminMediaReferences || (capability.Kind == "audio" && capability.MaxReferences != 0) {
			return nil, "invalid media capability reference limit"
		}
		clean = append(clean, capability)
	}
	return clean, ""
}

func adminMediaCapabilityModelAllowed(channel adminChannelPublic, model string) bool {
	for _, allowed := range channel.Models {
		if strings.EqualFold(allowed, model) {
			return true
		}
	}
	for _, fallback := range []string{channel.DefaultImageModel, channel.DefaultVideoModel, channel.DefaultAudioModel} {
		if fallback != "" && strings.EqualFold(fallback, model) {
			return true
		}
	}
	return false
}

func normalizeAdminMediaModes(values []string, kind string) ([]string, string) {
	if len(values) == 0 || len(values) > maxAdminMediaCapabilityValues {
		return nil, "invalid media capability modes"
	}
	allowed := map[string]string{
		"text_to_image": "image", "image_to_image": "image",
		"text_to_video": "video", "image_to_video": "video",
		"text_to_audio": "audio",
	}
	seen := make(map[string]struct{}, len(values))
	clean := make([]string, 0, len(values))
	for _, raw := range values {
		mode := strings.ToLower(strings.TrimSpace(raw))
		if allowed[mode] != kind {
			return nil, "invalid media capability mode"
		}
		if _, exists := seen[mode]; exists {
			continue
		}
		seen[mode] = struct{}{}
		clean = append(clean, mode)
	}
	return clean, ""
}

func normalizeAdminMediaStrings(values []string) ([]string, string) {
	if len(values) == 0 {
		return nil, ""
	}
	if len(values) > maxAdminMediaCapabilityValues {
		return nil, "too many values"
	}
	seen := make(map[string]struct{}, len(values))
	clean := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		value = strings.ReplaceAll(value, "X", "x")
		if value == "" || len(value) > maxAdminMediaCapabilityValueSize || !adminMediaSizePattern.MatchString(value) {
			return nil, "invalid value"
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		clean = append(clean, value)
	}
	return clean, ""
}

func normalizeAdminMediaDurations(values []int) ([]int, string) {
	if len(values) == 0 {
		return nil, ""
	}
	if len(values) > maxAdminMediaCapabilityValues {
		return nil, "too many media capability durations"
	}
	seen := make(map[int]struct{}, len(values))
	clean := make([]int, 0, len(values))
	for _, value := range values {
		if value < 1 || value > maxAdminMediaDurationSeconds {
			return nil, "invalid media capability duration"
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		clean = append(clean, value)
	}
	return clean, ""
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
			channel.Source = "tenant"
			if err := validateAccountManagedChannelURL(channel.BaseURL); err != nil {
				return adminChannelPublic{}, err
			}
			return channel, nil
		}
	}
	return adminChannelPublic{}, store.ErrNotFound
}

func (s *Server) resolveSharedChannel(ctx context.Context, tenantID, id string) (adminChannelPublic, string, error) {
	channel, err := s.findAdminChannel(ctx, tenantID, id)
	var secrets map[string]string
	if errors.Is(err, store.ErrNotFound) {
		channel, apiKey, platformErr := s.platformChannelForSharedUse(ctx, tenantID, id)
		if platformErr != nil {
			return adminChannelPublic{}, "", platformErr
		}
		channel.Source = "platform"
		return validateResolvedSharedChannel(channel, apiKey)
	}
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	secrets, err = s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	channel, message := normalizeAdminChannel(channel)
	if message != "" || !channel.Enabled || !channel.AllowUserUse {
		return adminChannelPublic{}, "", errors.New("shared channel is unavailable")
	}
	apiKey := secrets[id]
	return validateResolvedSharedChannel(channel, apiKey)
}

func validateResolvedSharedChannel(channel adminChannelPublic, apiKey string) (adminChannelPublic, string, error) {
	if channel.Source != "platform" {
		if err := validateAccountManagedChannelURL(channel.BaseURL); err != nil {
			return adminChannelPublic{}, "", errors.New("shared channel destination is unavailable")
		}
	}
	if adminChannelRequiresSecret(channel) && strings.TrimSpace(apiKey) == "" {
		return adminChannelPublic{}, "", errors.New("shared channel secret is not configured")
	}
	if len(apiKey) > maxAdminChannelSecretBytes {
		return adminChannelPublic{}, "", errors.New("shared channel secret is invalid")
	}
	return channel, apiKey, nil
}

func adminChannelRequiresSecret(channel adminChannelPublic) bool {
	return channel.Protocol != "edge"
}

func sharedChannelSupports(channel adminChannelPublic, kind, requestedModel string) bool {
	if !channel.Enabled || !channel.AllowUserUse {
		return false
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
	case "text":
		return channel.Protocol == "openai" || channel.Protocol == "gemini"
	case "image":
		return channel.Protocol == "openai" || channel.Protocol == "gemini" || channel.Protocol == "apimart" || channel.Protocol == "kie"
	case "video":
		return channel.Protocol == "openai" || channel.Protocol == "apimart" || channel.Protocol == "kie"
	case "audio":
		return channel.Protocol == "openai" || channel.Protocol == "azure" || channel.Protocol == "edge"
	default:
		return false
	}
}

func (s *Server) selectSharedChannel(ctx context.Context, tenantID, kind, routingKey, requestedModel string, generationModes ...string) (adminChannelPublic, error) {
	generationMode := ""
	if len(generationModes) > 0 {
		generationMode = generationModes[0]
	}
	channels, err := s.loadAdminChannels(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, err
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, err
	}
	platformChannels, err := s.loadPlatformChannels(ctx)
	if err != nil {
		return adminChannelPublic{}, err
	}
	platformSecrets, err := s.decryptPlatformChannelSecrets(ctx)
	if err != nil {
		return adminChannelPublic{}, err
	}
	eligible := make([]adminChannelPublic, 0, len(channels)+len(platformChannels))
	seen := make(map[string]struct{}, len(channels)+len(platformChannels))
	totalWeight := uint64(0)
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		channel.Source = "tenant"
		if message != "" {
			continue
		}
		// A tenant definition shadows the platform ID even when disabled or
		// temporarily unusable, matching discovery and direct resolution.
		seen[channel.ID] = struct{}{}
		if validateAccountManagedChannelURL(channel.BaseURL) != nil || !sharedChannelSupports(channel, kind, requestedModel) ||
			!sharedChannelPublishesMediaCapability(channel, kind, requestedModel, generationMode) ||
			(adminChannelRequiresSecret(channel) && strings.TrimSpace(secrets[channel.ID]) == "") {
			continue
		}
		eligible = append(eligible, channel)
		totalWeight += uint64(channel.Weight)
	}
	for _, raw := range platformChannels {
		_, duplicate := seen[raw.ID]
		if !platformChannelVisibleToTenant(raw, tenantID) || duplicate {
			continue
		}
		channel, message := normalizeAdminChannel(raw.adminChannel())
		channel.Source = "platform"
		if message != "" || !sharedChannelSupports(channel, kind, requestedModel) ||
			!sharedChannelPublishesMediaCapability(channel, kind, requestedModel, generationMode) ||
			(adminChannelRequiresSecret(channel) && strings.TrimSpace(platformSecrets[channel.ID]) == "") {
			continue
		}
		eligible = append(eligible, channel)
		seen[channel.ID] = struct{}{}
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
		"text":  channel.DefaultTextModel,
		"image": channel.DefaultImageModel,
		"video": channel.DefaultVideoModel,
		"audio": channel.DefaultAudioModel,
	} {
		if model != "" {
			providers[kind] = storedImageProvider{BaseURL: channel.BaseURL, Model: model, Protocol: channel.Protocol}
		}
	}
	return storedImageChannel{
		ID: channel.ID, BaseURL: channel.BaseURL, TimeoutSeconds: channel.TimeoutSeconds,
		DefaultTextModel:  channel.DefaultTextModel,
		DefaultImageModel: channel.DefaultImageModel, DefaultVideoModel: channel.DefaultVideoModel,
		DefaultAudioModel: channel.DefaultAudioModel, Providers: providers,
	}
}

func adminChannelSecretAAD(tenantID string, channel adminChannelPublic) []byte {
	stateKey := adminChannelSecretsStateKey
	if tenantID == platformChannelSecretScope {
		stateKey = platformChannelSecretsStateKey
	}
	return []byte(strings.Join([]string{
		stateKey,
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
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, errors.New("invalid shared channel secrets")
	}
	if envelope.Version == 1 {
		// Version 1 was only tenant-bound. It cannot safely survive a channel
		// destination or lifecycle change, so require administrators to re-enter it.
		return map[string]string{}, nil
	}
	if envelope.Version != 2 || len(envelope.Entries) > 100 {
		return nil, errors.New("invalid shared channel secrets")
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
// lifecycle change. The client revision rejects stale editors, while one
// multi-state CAS commits channel metadata and encrypted secrets atomically.
func (s *Server) replaceAdminChannels(ctx context.Context, tenantID, expectedRevision string, requested []adminChannelPublic) ([]adminChannelPublic, error) {
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
	if expectedRevision == "" || expectedRevision != adminConfigRevision(current) {
		return nil, store.ErrConflict
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
	nextSecretRaw, err := s.encryptAdminChannelSecrets(tenantID, next, retained)
	if err != nil {
		return nil, err
	}
	nextRaw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	mutations := []store.StateMutation{
		{Key: adminChannelsStateKey, Expected: currentRaw, Value: nextRaw},
		{Key: adminChannelSecretsStateKey, Expected: secretRaw, Value: nextSecretRaw},
	}
	if err := s.store.CompareAndSwapStates(ctx, tenantID, mutations); err != nil {
		return nil, err
	}
	return next, nil
}

func (s *Server) putAdminChannelSecret(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
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
	channelRaw, err := getOptionalState(r.Context(), s.store, tenantID, adminChannelsStateKey)
	if err != nil {
		http.Error(w, "failed to load channel", http.StatusInternalServerError)
		return
	}
	channels, err := decodeAdminChannels(channelRaw)
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
	mutations := []store.StateMutation{
		{Key: adminChannelsStateKey, Expected: channelRaw, Value: channelRaw},
		{Key: adminChannelSecretsStateKey, Expected: secretRaw, Value: envelope},
	}
	if err := s.store.CompareAndSwapStates(r.Context(), tenantID, mutations); errors.Is(err, store.ErrConflict) {
		http.Error(w, "channel or secrets changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save channel secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteAdminChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
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
	if revision := r.Header.Get(adminRevisionHeader); revision == "" || revision != adminConfigRevision(channels) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
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
	values, decryptErr := s.decryptAdminChannelSecretsRaw(tenantID, channels, secretRaw)
	if decryptErr != nil {
		http.Error(w, "failed to delete channel", http.StatusInternalServerError)
		return
	}
	delete(values, id)
	nextSecretRaw, encryptErr := s.encryptAdminChannelSecrets(tenantID, next, values)
	if encryptErr != nil {
		http.Error(w, "failed to delete channel", http.StatusConflict)
		return
	}
	raw, _ := json.Marshal(next)
	mutations := []store.StateMutation{
		{Key: adminChannelsStateKey, Expected: channelRaw, Value: raw},
		{Key: adminChannelSecretsStateKey, Expected: secretRaw, Value: nextSecretRaw},
	}
	if err := s.store.CompareAndSwapStates(r.Context(), tenantID, mutations); errors.Is(err, store.ErrConflict) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to delete channel", http.StatusInternalServerError)
		return
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(next))
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
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(secrets[id]) == "" {
		return nil, errors.New("channel secret is not configured")
	}
	return s.fetchChannelModels(ctx, channel, secrets[id])
}

func (s *Server) fetchChannelModels(ctx context.Context, channel adminChannelPublic, apiKey string) ([]string, error) {
	channel, message := normalizeAdminChannel(channel)
	if message != "" {
		return nil, errors.New(message)
	}
	if !channel.Enabled {
		return nil, errors.New("channel is disabled")
	}
	if channel.Protocol != "openai" && channel.Protocol != "apimart" {
		return nil, errors.New("model discovery is unsupported for this protocol")
	}
	timeout := time.Duration(channel.TimeoutSeconds) * time.Second
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return fetchProviderModelsWithClient(requestCtx, providerModelConnection{
		BaseURL:  channel.BaseURL,
		APIKey:   apiKey,
		Protocol: channel.Protocol,
	}, providerModelHTTPClient, true)
}

func (s *Server) resolveAdminChannelPreview(ctx context.Context, tenantID string, input adminChannelPreviewInput) (adminChannelPublic, string, error) {
	timeout := input.TimeoutSeconds
	if timeout < 1 {
		timeout = 30
	}
	draft := adminChannelPublic{
		ID: "preview", Name: "preview", BaseURL: strings.TrimSpace(input.BaseURL), Protocol: strings.TrimSpace(input.Protocol),
		Enabled: true, AllowUserUse: false, Weight: 1, TimeoutSeconds: timeout,
		DefaultAudioModel: strings.TrimSpace(input.DefaultAudioModel),
	}
	if id := strings.TrimSpace(input.ID); id != "" {
		draft.ID = id
	}
	channel, message := normalizeAdminChannel(draft)
	if message != "" {
		return adminChannelPublic{}, "", errors.New(message)
	}
	if err := validateAccountManagedChannelURL(channel.BaseURL); err != nil {
		return adminChannelPublic{}, "", err
	}
	apiKey := strings.TrimSpace(input.APIKey)
	if apiKey != "" {
		if len(apiKey) > maxAdminChannelSecretBytes {
			return adminChannelPublic{}, "", errors.New("invalid channel secret")
		}
		return channel, apiKey, nil
	}
	if channel.Protocol == "edge" {
		return channel, "", nil
	}
	if channel.ID == "preview" {
		return adminChannelPublic{}, "", errors.New("channel secret is not configured")
	}
	stored, err := s.findAdminChannel(ctx, tenantID, channel.ID)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	if !sameAdminChannelSecretDestination(stored, channel) {
		return adminChannelPublic{}, "", errors.New("channel secret is not configured")
	}
	secrets, err := s.decryptAdminChannelSecrets(ctx, tenantID)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	if strings.TrimSpace(secrets[channel.ID]) == "" {
		return adminChannelPublic{}, "", errors.New("channel secret is not configured")
	}
	return channel, secrets[channel.ID], nil
}

func (s *Server) previewAdminChannelModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAdminChannelSecretBytes+4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input adminChannelPreviewInput
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	channel, apiKey, err := s.resolveAdminChannelPreview(r.Context(), tenantIDFrom(r), input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	models, err := s.fetchChannelModels(r.Context(), channel, apiKey)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, adminChannelModelList{Models: models})
}

func (s *Server) previewAdminChannelTest(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAdminChannelSecretBytes+4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input adminChannelPreviewInput
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	channel, apiKey, err := s.resolveAdminChannelPreview(r.Context(), tenantIDFrom(r), input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	modelCount, err := s.checkChannelConnection(r.Context(), channel, apiKey)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "modelCount": modelCount})
}

func (s *Server) getAdminChannelModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
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
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
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
	if err != nil {
		return 0, errors.New("channel secret is unavailable")
	}
	apiKey := strings.TrimSpace(secrets[id])
	return s.checkChannelConnection(ctx, channel, apiKey)
}

func (s *Server) checkChannelConnection(ctx context.Context, channel adminChannelPublic, apiKey string) (int, error) {
	channel, message := normalizeAdminChannel(channel)
	if message != "" {
		return 0, errors.New(message)
	}
	apiKey = strings.TrimSpace(apiKey)
	if channel.Protocol == "openai" || channel.Protocol == "apimart" {
		models, err := s.fetchChannelModels(ctx, channel, apiKey)
		return len(models), err
	}
	if channel.Protocol == "azure" || channel.Protocol == "edge" {
		if channel.Protocol == "azure" && apiKey == "" {
			return 0, errors.New("channel secret is not configured")
		}
		requestCtx, cancel := context.WithTimeout(ctx, time.Duration(channel.TimeoutSeconds)*time.Second)
		defer cancel()
		_, generateErr := newHTTPAudioExecutor().Generate(requestCtx, audioGenerationRequest{
			Protocol: channel.Protocol,
			BaseURL:  channel.BaseURL,
			APIKey:   apiKey,
			Model:    channel.DefaultAudioModel,
			Prompt:   "OpenBoard 连接测试",
			Voice:    "zh-CN-XiaoxiaoNeural",
			Format:   "mp3",
		})
		if generateErr != nil {
			return 0, errors.New("channel connection failed")
		}
		return 0, nil
	}
	if apiKey == "" {
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
		request.Header.Set("x-goog-api-key", apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
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
	status := response.StatusCode
	ok := (status >= 200 && status < 300) || status == http.StatusBadRequest || status == http.StatusNotFound
	if !ok {
		return 0, errors.New("channel returned an unsuccessful status")
	}
	return 0, nil
}
