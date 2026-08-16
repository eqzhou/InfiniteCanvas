package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	platformChannelsStateKey       = "platformChannels"
	platformChannelSecretsStateKey = "__encrypted_platform_channel_secrets"
	// Platform secrets are kept in the same state tenant for storage
	// compatibility, but use a distinct AEAD scope so they cannot be opened as
	// a tenant channel secret.
	platformChannelSecretScope = "__platform__"
	maxPlatformChannelTenants  = 500
)

// platformChannelPublic is the public channel definition owned by the
// platform. Audience fields are deliberately separate from the provider
// definition: changing who can use a channel must not rebind its secret.
type platformChannelPublic struct {
	ID                string                 `json:"id"`
	Name              string                 `json:"name"`
	BaseURL           string                 `json:"baseUrl"`
	Protocol          string                 `json:"protocol"`
	Enabled           bool                   `json:"enabled"`
	AllowUserUse      bool                   `json:"allowUserUse"`
	Weight            int                    `json:"weight"`
	TimeoutSeconds    int                    `json:"timeoutSeconds"`
	Models            []string               `json:"models,omitempty"`
	DefaultTextModel  string                 `json:"defaultTextModel"`
	DefaultImageModel string                 `json:"defaultImageModel"`
	DefaultVideoModel string                 `json:"defaultVideoModel"`
	DefaultAudioModel string                 `json:"defaultAudioModel,omitempty"`
	MediaCapabilities []adminMediaCapability `json:"mediaCapabilities,omitempty"`
	SecretConfigured  bool                   `json:"secretConfigured"`
	SecretBindingID   string                 `json:"secretBindingId,omitempty"`
	PublishToAll      bool                   `json:"publishToAll"`
	TenantIDs         []string               `json:"tenantIds,omitempty"`
}

func (item platformChannelPublic) adminChannel() adminChannelPublic {
	return adminChannelPublic{
		ID: item.ID, Name: item.Name, BaseURL: item.BaseURL, Protocol: item.Protocol,
		Enabled: item.Enabled, AllowUserUse: item.AllowUserUse, Weight: item.Weight,
		TimeoutSeconds: item.TimeoutSeconds, Models: append([]string(nil), item.Models...),
		DefaultTextModel: item.DefaultTextModel, DefaultImageModel: item.DefaultImageModel,
		DefaultVideoModel: item.DefaultVideoModel, DefaultAudioModel: item.DefaultAudioModel,
		MediaCapabilities: append([]adminMediaCapability(nil), item.MediaCapabilities...),
		SecretConfigured:  item.SecretConfigured, SecretBindingID: item.SecretBindingID,
	}
}

func newPlatformChannelPublic(channel adminChannelPublic, publishToAll bool, tenantIDs []string) platformChannelPublic {
	return platformChannelPublic{
		ID: channel.ID, Name: channel.Name, BaseURL: channel.BaseURL, Protocol: channel.Protocol,
		Enabled: channel.Enabled, AllowUserUse: channel.AllowUserUse, Weight: channel.Weight,
		TimeoutSeconds: channel.TimeoutSeconds, Models: append([]string(nil), channel.Models...),
		DefaultTextModel: channel.DefaultTextModel, DefaultImageModel: channel.DefaultImageModel,
		DefaultVideoModel: channel.DefaultVideoModel, DefaultAudioModel: channel.DefaultAudioModel,
		MediaCapabilities: append([]adminMediaCapability(nil), channel.MediaCapabilities...),
		SecretConfigured:  channel.SecretConfigured, SecretBindingID: channel.SecretBindingID,
		PublishToAll: publishToAll, TenantIDs: append([]string(nil), tenantIDs...),
	}
}

func normalizePlatformTenantIDs(values []string) ([]string, string) {
	if len(values) > maxPlatformChannelTenants {
		return nil, "too many platform channel tenants"
	}
	seen := make(map[string]struct{}, len(values))
	clean := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || len(value) > 128 || !projectIDPattern.MatchString(value) {
			return nil, "invalid platform channel tenant"
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		clean = append(clean, value)
	}
	return clean, ""
}

func normalizePlatformChannel(item platformChannelPublic) (platformChannelPublic, string) {
	channel, message := normalizeAdminChannel(item.adminChannel())
	if message != "" {
		return platformChannelPublic{}, message
	}
	if err := validateAccountManagedChannelURL(channel.BaseURL); err != nil {
		return platformChannelPublic{}, err.Error()
	}
	tenantIDs, message := normalizePlatformTenantIDs(item.TenantIDs)
	if message != "" {
		return platformChannelPublic{}, message
	}
	if !item.PublishToAll && len(tenantIDs) == 0 {
		return platformChannelPublic{}, "platform channel audience is required"
	}
	if item.PublishToAll {
		tenantIDs = nil
	}
	return newPlatformChannelPublic(channel, item.PublishToAll, tenantIDs), ""
}

func decodePlatformChannels(raw []byte) ([]platformChannelPublic, error) {
	if len(raw) == 0 {
		return []platformChannelPublic{}, nil
	}
	var channels []platformChannelPublic
	if json.Unmarshal(raw, &channels) != nil || len(channels) > 100 {
		return nil, errors.New("invalid platform channel configuration")
	}
	clean := make([]platformChannelPublic, 0, len(channels))
	for _, item := range channels {
		normalized, message := normalizePlatformChannel(item)
		if message != "" {
			return nil, errors.New(message)
		}
		clean = append(clean, normalized)
	}
	return clean, nil
}

func platformChannelVisibleToTenant(channel platformChannelPublic, tenantID string) bool {
	if channel.PublishToAll {
		return true
	}
	tenantID = strings.TrimSpace(tenantID)
	for _, allowed := range channel.TenantIDs {
		if strings.TrimSpace(allowed) == tenantID {
			return true
		}
	}
	return false
}

func platformChannelBases(channels []platformChannelPublic) []adminChannelPublic {
	bases := make([]adminChannelPublic, 0, len(channels))
	for _, channel := range channels {
		bases = append(bases, channel.adminChannel())
	}
	return bases
}

func (s *Server) loadPlatformChannels(ctx context.Context) ([]platformChannelPublic, error) {
	raw, err := getOptionalState(ctx, s.store, store.DefaultTenantID, platformChannelsStateKey)
	if err != nil {
		return nil, err
	}
	return decodePlatformChannels(raw)
}

func (s *Server) validatePlatformAudience(ctx context.Context, tenantIDs []string) error {
	for _, tenantID := range tenantIDs {
		if _, err := s.store.GetTenant(ctx, tenantID); errors.Is(err, store.ErrNotFound) {
			return store.ErrInvalidInput
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) decryptPlatformChannelSecrets(ctx context.Context) (map[string]string, error) {
	if s.store == nil || s.secrets == nil {
		return nil, store.ErrNotFound
	}
	channels, err := s.loadPlatformChannels(ctx)
	if err != nil {
		return nil, err
	}
	raw, err := getOptionalState(ctx, s.store, store.DefaultTenantID, platformChannelSecretsStateKey)
	if err != nil {
		return nil, err
	}
	values, err := s.decryptAdminChannelSecretsRaw(platformChannelSecretScope, platformChannelBases(channels), raw)
	if err != nil {
		return nil, errors.New("invalid platform channel secrets")
	}
	return values, nil
}

func (s *Server) platformChannelSecretPresence(ctx context.Context) (map[string]bool, error) {
	secrets, err := s.decryptPlatformChannelSecrets(ctx)
	if err != nil {
		return map[string]bool{}, err
	}
	configured := make(map[string]bool, len(secrets))
	for id, value := range secrets {
		configured[id] = strings.TrimSpace(value) != ""
	}
	return configured, nil
}

func (s *Server) findPlatformChannel(ctx context.Context, tenantID, id string) (adminChannelPublic, error) {
	channels, err := s.loadPlatformChannels(ctx)
	if err != nil {
		return adminChannelPublic{}, err
	}
	for _, item := range channels {
		if item.ID == id && platformChannelVisibleToTenant(item, tenantID) {
			return item.adminChannel(), nil
		}
	}
	return adminChannelPublic{}, store.ErrNotFound
}

func (s *Server) findPlatformChannelForAdmin(ctx context.Context, id string) (platformChannelPublic, error) {
	channels, err := s.loadPlatformChannels(ctx)
	if err != nil {
		return platformChannelPublic{}, err
	}
	for _, item := range channels {
		if item.ID == id {
			return item, nil
		}
	}
	return platformChannelPublic{}, store.ErrNotFound
}

func (s *Server) replacePlatformChannels(ctx context.Context, expectedRevision string, requested []platformChannelPublic) ([]platformChannelPublic, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	stateTenantID := store.DefaultTenantID
	currentRaw, err := getOptionalState(ctx, s.store, stateTenantID, platformChannelsStateKey)
	if err != nil {
		return nil, err
	}
	current, err := decodePlatformChannels(currentRaw)
	if err != nil {
		return nil, err
	}
	if expectedRevision == "" || expectedRevision != adminConfigRevision(current) {
		return nil, store.ErrConflict
	}
	currentByID := make(map[string]platformChannelPublic, len(current))
	for _, channel := range current {
		currentByID[channel.ID] = channel
	}
	next := append([]platformChannelPublic(nil), requested...)
	for index := range next {
		old, exists := currentByID[next[index].ID]
		oldBase, nextBase := old.adminChannel(), next[index].adminChannel()
		if exists && sameAdminChannelSecretDestination(oldBase, nextBase) && old.SecretBindingID != "" {
			next[index].SecretBindingID = old.SecretBindingID
			continue
		}
		next[index].SecretBindingID, err = newAdminChannelSecretBindingID()
		if err != nil {
			return nil, err
		}
	}

	secretRaw, err := getOptionalState(ctx, s.store, stateTenantID, platformChannelSecretsStateKey)
	if err != nil {
		return nil, err
	}
	secrets, err := s.decryptAdminChannelSecretsRaw(platformChannelSecretScope, platformChannelBases(current), secretRaw)
	if err != nil {
		return nil, err
	}
	retained := make(map[string]string, len(secrets))
	for _, channel := range next {
		old, exists := currentByID[channel.ID]
		if exists && sameAdminChannelSecretDestination(old.adminChannel(), channel.adminChannel()) && old.SecretBindingID == channel.SecretBindingID {
			retained[channel.ID] = secrets[channel.ID]
		}
	}
	nextSecretRaw, err := s.encryptAdminChannelSecrets(platformChannelSecretScope, platformChannelBases(next), retained)
	if err != nil {
		return nil, err
	}
	nextRaw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if err := s.store.CompareAndSwapStates(ctx, stateTenantID, []store.StateMutation{
		{Key: platformChannelsStateKey, Expected: currentRaw, Value: nextRaw},
		{Key: platformChannelSecretsStateKey, Expected: secretRaw, Value: nextSecretRaw},
	}); err != nil {
		return nil, err
	}
	return next, nil
}

type platformChannelMigrationInput struct {
	SourceTenantID string   `json:"sourceTenantId"`
	ChannelIDs     []string `json:"channelIds"`
	PublishToAll   bool     `json:"publishToAll"`
	TenantIDs      []string `json:"tenantIds"`
}

// migrateTenantChannelsToPlatform copies selected tenant-shared channels into
// the platform catalog without deleting the source. The operation is safe to
// retry and keeps the source available as the rollback path until an operator
// explicitly removes it after verification.
func (s *Server) migrateTenantChannelsToPlatform(ctx context.Context, input platformChannelMigrationInput) ([]platformChannelPublic, error) {
	sourceTenantID := strings.TrimSpace(input.SourceTenantID)
	if sourceTenantID == "" {
		sourceTenantID = store.DefaultTenantID
	}
	if sourceTenantID != store.DefaultTenantID || len(input.ChannelIDs) == 0 || len(input.ChannelIDs) > 100 {
		return nil, store.ErrInvalidInput
	}
	tenantIDs, message := normalizePlatformTenantIDs(input.TenantIDs)
	if message != "" {
		return nil, store.ErrInvalidInput
	}
	if input.PublishToAll {
		// Canonicalize an all-tenant publication so stale or redundant tenant
		// IDs cannot affect the persisted revision or audience display.
		tenantIDs = nil
	} else if len(tenantIDs) == 0 {
		return nil, store.ErrInvalidInput
	}
	if err := s.validatePlatformAudience(ctx, tenantIDs); err != nil {
		return nil, err
	}
	selectedIDs := make(map[string]struct{}, len(input.ChannelIDs))
	for _, rawID := range input.ChannelIDs {
		id := strings.TrimSpace(rawID)
		if !projectIDPattern.MatchString(id) {
			return nil, store.ErrInvalidInput
		}
		selectedIDs[id] = struct{}{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	sourceChannels, err := s.loadAdminChannels(ctx, sourceTenantID)
	if err != nil {
		return nil, err
	}
	sourceSecrets, err := s.decryptAdminChannelSecrets(ctx, sourceTenantID)
	if err != nil {
		return nil, err
	}
	bySourceID := make(map[string]adminChannelPublic, len(sourceChannels))
	for _, raw := range sourceChannels {
		channel, normalizeMessage := normalizeAdminChannel(raw)
		if normalizeMessage == "" {
			bySourceID[channel.ID] = channel
		}
	}
	selected := make([]adminChannelPublic, 0, len(selectedIDs))
	for id := range selectedIDs {
		channel, exists := bySourceID[id]
		if !exists {
			return nil, store.ErrNotFound
		}
		if adminChannelRequiresSecret(channel) && strings.TrimSpace(sourceSecrets[id]) == "" {
			return nil, errors.New("source channel secret is not configured")
		}
		selected = append(selected, channel)
	}
	// Stable ordering makes retries produce the same revision and keeps the
	// platform editor deterministic.
	sort.Slice(selected, func(i, j int) bool { return selected[i].ID < selected[j].ID })

	stateTenantID := store.DefaultTenantID
	platformRaw, err := getOptionalState(ctx, s.store, stateTenantID, platformChannelsStateKey)
	if err != nil {
		return nil, err
	}
	current, err := decodePlatformChannels(platformRaw)
	if err != nil {
		return nil, err
	}
	secretRaw, err := getOptionalState(ctx, s.store, stateTenantID, platformChannelSecretsStateKey)
	if err != nil {
		return nil, err
	}
	currentSecrets, err := s.decryptAdminChannelSecretsRaw(platformChannelSecretScope, platformChannelBases(current), secretRaw)
	if err != nil {
		return nil, err
	}
	byPlatformID := make(map[string]platformChannelPublic, len(current))
	for _, channel := range current {
		byPlatformID[channel.ID] = channel
	}
	for _, channel := range selected {
		next := newPlatformChannelPublic(channel, input.PublishToAll, tenantIDs)
		if old, exists := byPlatformID[channel.ID]; exists && sameAdminChannelSecretDestination(old.adminChannel(), channel) && old.SecretBindingID != "" {
			next.SecretBindingID = old.SecretBindingID
		} else {
			// The source tenant and platform catalog have distinct secret scopes;
			// never reuse the source binding identity for a new platform binding.
			next.SecretBindingID = ""
		}
		if next.SecretBindingID == "" {
			next.SecretBindingID, err = newAdminChannelSecretBindingID()
			if err != nil {
				return nil, err
			}
		}
		byPlatformID[channel.ID] = next
	}
	next := make([]platformChannelPublic, 0, len(byPlatformID))
	for _, channel := range byPlatformID {
		next = append(next, channel)
	}
	sort.Slice(next, func(i, j int) bool { return next[i].ID < next[j].ID })
	nextSecrets := make(map[string]string, len(currentSecrets)+len(selected))
	for id, value := range currentSecrets {
		nextSecrets[id] = value
	}
	for _, channel := range selected {
		nextSecrets[channel.ID] = sourceSecrets[channel.ID]
	}
	nextSecretRaw, err := s.encryptAdminChannelSecrets(platformChannelSecretScope, platformChannelBases(next), nextSecrets)
	if err != nil {
		return nil, err
	}
	nextRaw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if err := s.store.CompareAndSwapStates(ctx, stateTenantID, []store.StateMutation{
		{Key: platformChannelsStateKey, Expected: platformRaw, Value: nextRaw},
		{Key: platformChannelSecretsStateKey, Expected: secretRaw, Value: nextSecretRaw},
	}); err != nil {
		return nil, err
	}
	return next, nil
}

func (s *Server) migrateLocalChannelsToPlatform(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input platformChannelMigrationInput
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if actor, authenticated := authUserFrom(r.Context()); authenticated {
		sourceTenantID := strings.TrimSpace(input.SourceTenantID)
		if sourceTenantID == "" {
			sourceTenantID = store.DefaultTenantID
		}
		if !isTenantOwner(actor) || actor.TenantID != sourceTenantID {
			http.Error(w, "source tenant owner permission required", http.StatusForbidden)
			return
		}
	}
	channels, err := s.migrateTenantChannelsToPlatform(r.Context(), input)
	if errors.Is(err, store.ErrInvalidInput) {
		http.Error(w, "invalid platform channel migration", http.StatusBadRequest)
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "source channel not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to migrate platform channel", http.StatusInternalServerError)
		return
	}
	configured, _ := s.platformChannelSecretPresence(r.Context())
	for index := range channels {
		channels[index].SecretConfigured = configured[channels[index].ID]
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(channels))
	w.Header().Set("Cache-Control", "no-store")
	writeJSONStatus(w, http.StatusOK, channels)
}

func (s *Server) getPlatformChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	channels, err := s.loadPlatformChannels(r.Context())
	if err != nil {
		http.Error(w, "failed to load platform channels", http.StatusInternalServerError)
		return
	}
	configured, err := s.platformChannelSecretPresence(r.Context())
	if err != nil {
		http.Error(w, "failed to load platform channels", http.StatusInternalServerError)
		return
	}
	for index := range channels {
		channels[index].SecretConfigured = configured[channels[index].ID]
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(channels))
	writeJSON(w, channels)
}

func (s *Server) putPlatformChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body []platformChannelPublic
	if err := decoder.Decode(&body); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body == nil {
		body = []platformChannelPublic{}
	}
	if len(body) > 100 {
		http.Error(w, "too many platform channels", http.StatusBadRequest)
		return
	}
	clean := make([]platformChannelPublic, 0, len(body))
	seen := make(map[string]struct{}, len(body))
	for _, item := range body {
		normalized, message := normalizePlatformChannel(item)
		if message != "" {
			http.Error(w, message, http.StatusBadRequest)
			return
		}
		if _, exists := seen[normalized.ID]; exists {
			http.Error(w, "duplicate channel id", http.StatusBadRequest)
			return
		}
		seen[normalized.ID] = struct{}{}
		clean = append(clean, normalized)
	}
	audience := make([]string, 0)
	seenAudience := make(map[string]struct{})
	for _, item := range clean {
		if item.PublishToAll {
			continue
		}
		for _, tenantID := range item.TenantIDs {
			if _, exists := seenAudience[tenantID]; exists {
				continue
			}
			seenAudience[tenantID] = struct{}{}
			audience = append(audience, tenantID)
		}
	}
	if err := s.validatePlatformAudience(r.Context(), audience); errors.Is(err, store.ErrInvalidInput) {
		http.Error(w, "invalid platform channel tenant", http.StatusBadRequest)
		return
	} else if err != nil {
		http.Error(w, "failed to validate platform channel tenant", http.StatusInternalServerError)
		return
	}
	next, err := s.replacePlatformChannels(r.Context(), r.Header.Get(adminRevisionHeader), clean)
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "platform channels changed concurrently", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to save platform channels", http.StatusInternalServerError)
		return
	}
	configured, _ := s.platformChannelSecretPresence(r.Context())
	for index := range next {
		next[index].SecretConfigured = configured[next[index].ID]
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(next))
	writeJSON(w, next)
}

func (s *Server) putPlatformChannelSecret(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	stateTenantID := store.DefaultTenantID
	channelRaw, err := getOptionalState(r.Context(), s.store, stateTenantID, platformChannelsStateKey)
	if err != nil {
		http.Error(w, "failed to load platform channel", http.StatusInternalServerError)
		return
	}
	channels, err := decodePlatformChannels(channelRaw)
	if err != nil {
		http.Error(w, "failed to load platform channel", http.StatusInternalServerError)
		return
	}
	var bound *platformChannelPublic
	for index := range channels {
		if channels[index].ID == id {
			bound = &channels[index]
			break
		}
	}
	if bound == nil {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	if bound.SecretBindingID == "" || bound.SecretBindingID != strings.TrimSpace(input.SecretBindingID) {
		http.Error(w, "channel destination changed; reload before saving its secret", http.StatusConflict)
		return
	}
	secretRaw, err := getOptionalState(r.Context(), s.store, stateTenantID, platformChannelSecretsStateKey)
	if err != nil {
		http.Error(w, "failed to read platform channel secrets", http.StatusInternalServerError)
		return
	}
	current, err := s.decryptAdminChannelSecretsRaw(platformChannelSecretScope, platformChannelBases(channels), secretRaw)
	if err != nil {
		http.Error(w, "failed to read platform channel secrets", http.StatusInternalServerError)
		return
	}
	next := make(map[string]string, len(current)+1)
	for key, value := range current {
		next[key] = value
	}
	next[id] = input.APIKey
	envelope, err := s.encryptAdminChannelSecrets(platformChannelSecretScope, platformChannelBases(channels), next)
	if err != nil {
		http.Error(w, "failed to save platform channel secret", http.StatusInternalServerError)
		return
	}
	if err := s.store.CompareAndSwapStates(r.Context(), stateTenantID, []store.StateMutation{
		{Key: platformChannelsStateKey, Expected: channelRaw, Value: channelRaw},
		{Key: platformChannelSecretsStateKey, Expected: secretRaw, Value: envelope},
	}); errors.Is(err, store.ErrConflict) {
		http.Error(w, "platform channel or secrets changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save platform channel secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deletePlatformChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	stateTenantID := store.DefaultTenantID
	channelRaw, err := getOptionalState(r.Context(), s.store, stateTenantID, platformChannelsStateKey)
	if err != nil {
		http.Error(w, "failed to load platform channels", http.StatusInternalServerError)
		return
	}
	channels, err := decodePlatformChannels(channelRaw)
	if err != nil {
		http.Error(w, "failed to load platform channels", http.StatusInternalServerError)
		return
	}
	if revision := r.Header.Get(adminRevisionHeader); revision == "" || revision != adminConfigRevision(channels) {
		http.Error(w, "platform channels changed concurrently", http.StatusConflict)
		return
	}
	next := make([]platformChannelPublic, 0, len(channels))
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
	secretRaw, err := getOptionalState(r.Context(), s.store, stateTenantID, platformChannelSecretsStateKey)
	if err != nil {
		http.Error(w, "failed to delete platform channel", http.StatusInternalServerError)
		return
	}
	values, err := s.decryptAdminChannelSecretsRaw(platformChannelSecretScope, platformChannelBases(channels), secretRaw)
	if err != nil {
		http.Error(w, "failed to delete platform channel", http.StatusInternalServerError)
		return
	}
	delete(values, id)
	nextSecretRaw, err := s.encryptAdminChannelSecrets(platformChannelSecretScope, platformChannelBases(next), values)
	if err != nil {
		http.Error(w, "failed to delete platform channel", http.StatusConflict)
		return
	}
	nextRaw, _ := json.Marshal(next)
	if err := s.store.CompareAndSwapStates(r.Context(), stateTenantID, []store.StateMutation{
		{Key: platformChannelsStateKey, Expected: channelRaw, Value: nextRaw},
		{Key: platformChannelSecretsStateKey, Expected: secretRaw, Value: nextSecretRaw},
	}); errors.Is(err, store.ErrConflict) {
		http.Error(w, "platform channels changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to delete platform channel", http.StatusInternalServerError)
		return
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(next))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) fetchPlatformChannelModels(ctx context.Context, id string) ([]string, error) {
	item, err := s.findPlatformChannelForAdmin(ctx, id)
	if err != nil {
		return nil, err
	}
	channel := item.adminChannel()
	secrets, err := s.decryptPlatformChannelSecrets(ctx)
	if err != nil || strings.TrimSpace(secrets[id]) == "" {
		return nil, errors.New("channel secret is not configured")
	}
	return s.fetchChannelModels(ctx, channel, secrets[id])
}

func (s *Server) getPlatformChannelModels(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	models, err := s.fetchPlatformChannelModels(r.Context(), chi.URLParam(r, "id"))
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

func (s *Server) testPlatformChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	item, err := s.findPlatformChannelForAdmin(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load platform channel", http.StatusInternalServerError)
		return
	}
	secrets, err := s.decryptPlatformChannelSecrets(r.Context())
	if err != nil {
		http.Error(w, "channel secret is unavailable", http.StatusUnprocessableEntity)
		return
	}
	modelCount, err := s.checkChannelConnection(r.Context(), item.adminChannel(), secrets[item.ID])
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "modelCount": modelCount})
}

func (s *Server) platformChannelForSharedUse(ctx context.Context, tenantID, id string) (adminChannelPublic, string, error) {
	channel, err := s.findPlatformChannel(ctx, tenantID, id)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	channel, message := normalizeAdminChannel(channel)
	if message != "" || !channel.Enabled || !channel.AllowUserUse {
		return adminChannelPublic{}, "", errors.New("shared channel is unavailable")
	}
	secrets, err := s.decryptPlatformChannelSecrets(ctx)
	if err != nil {
		return adminChannelPublic{}, "", err
	}
	return channel, secrets[id], nil
}
