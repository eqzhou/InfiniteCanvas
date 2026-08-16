package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
)

type mediaModelCapability struct {
	ChannelID     string   `json:"channelId"`
	ChannelName   string   `json:"channelName"`
	Protocol      string   `json:"protocol"`
	Model         string   `json:"model"`
	Kind          string   `json:"kind"`
	Modes         []string `json:"modes"`
	Sizes         []string `json:"sizes,omitempty"`
	Ratios        []string `json:"ratios,omitempty"`
	Resolutions   []string `json:"resolutions,omitempty"`
	Durations     []int    `json:"durations,omitempty"`
	MaxReferences int      `json:"maxReferences"`
}

type mediaCapabilityCatalog struct {
	Version string                 `json:"version"`
	Models  []mediaModelCapability `json:"models"`
}

func validFilmGenerationMode(mode string) bool {
	switch mode {
	case "text_to_image", "image_to_image", "text_to_video", "image_to_video", "text_to_audio":
		return true
	default:
		return false
	}
}

func capabilityForChannelDefault(channel adminChannelPublic, kind, model string) mediaModelCapability {
	registered, registeredOK := resolveProviderModelCapability(channel.Protocol, kind, model)
	if !registeredOK {
		return mediaModelCapability{}
	}
	capability := mediaModelCapability{
		ChannelID: channel.ID, ChannelName: channel.Name, Protocol: channel.Protocol,
		Model: model, Kind: kind, MaxReferences: registered.MaxImageReferences,
		Sizes: append([]string(nil), registered.Sizes...), Ratios: append([]string(nil), registered.Ratios...),
		Resolutions: append([]string(nil), registered.Resolutions...),
	}
	switch kind {
	case "image":
		capability.Modes = []string{"text_to_image"}
		if registered.MaxImageReferences > 0 {
			capability.Modes = append(capability.Modes, "image_to_image")
		}
	case "video":
		capability.Modes = []string{"text_to_video"}
		if registered.MaxImageReferences > 0 {
			capability.Modes = append(capability.Modes, "image_to_video")
		}
	case "audio":
		capability.Modes = []string{"text_to_audio"}
	}
	if registered.MinDuration > 0 && registered.MaxDuration >= registered.MinDuration {
		capability.Durations = make([]int, 0, registered.MaxDuration-registered.MinDuration+1)
		for duration := registered.MinDuration; duration <= registered.MaxDuration; duration++ {
			capability.Durations = append(capability.Durations, duration)
		}
	}
	return capability
}

func capabilityForExplicitChannelModel(channel adminChannelPublic, configured adminMediaCapability) mediaModelCapability {
	return mediaModelCapability{
		ChannelID: channel.ID, ChannelName: channel.Name, Protocol: channel.Protocol,
		Model: configured.Model, Kind: configured.Kind,
		Modes: append([]string(nil), configured.Modes...), Sizes: append([]string(nil), configured.Sizes...),
		Durations: append([]int(nil), configured.Durations...), MaxReferences: configured.MaxReferences,
	}
}

func (s *Server) buildMediaCapabilityCatalog(ctx context.Context, tenantID string) (mediaCapabilityCatalog, error) {
	channels, err := s.loadAdminChannels(ctx, tenantID)
	if err != nil {
		return mediaCapabilityCatalog{}, err
	}
	presence, err := s.adminChannelSecretPresence(ctx, tenantID)
	if err != nil {
		return mediaCapabilityCatalog{}, err
	}
	platformChannels, err := s.loadPlatformChannels(ctx)
	if err != nil {
		return mediaCapabilityCatalog{}, err
	}
	platformPresence, err := s.platformChannelSecretPresence(ctx)
	if err != nil {
		return mediaCapabilityCatalog{}, err
	}
	models := make([]mediaModelCapability, 0, len(channels)*3)
	seen := make(map[string]struct{}, len(channels)+len(platformChannels))
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		if message != "" {
			continue
		}
		seen[channel.ID] = struct{}{}
		if validateAccountManagedChannelURL(channel.BaseURL) != nil || !channel.Enabled || !channel.AllowUserUse || (adminChannelRequiresSecret(channel) && !presence[channel.ID]) {
			continue
		}
		models = appendMediaCapabilityModels(models, channel)
	}
	for _, raw := range platformChannels {
		_, duplicate := seen[raw.ID]
		if !platformChannelVisibleToTenant(raw, tenantID) || duplicate {
			continue
		}
		channel, message := normalizeAdminChannel(raw.adminChannel())
		if message != "" || !channel.Enabled || !channel.AllowUserUse || (adminChannelRequiresSecret(channel) && !platformPresence[channel.ID]) {
			continue
		}
		seen[channel.ID] = struct{}{}
		models = appendMediaCapabilityModels(models, channel)
	}
	sort.Slice(models, func(i, j int) bool {
		if models[i].ChannelID != models[j].ChannelID {
			return models[i].ChannelID < models[j].ChannelID
		}
		if models[i].Kind != models[j].Kind {
			return models[i].Kind < models[j].Kind
		}
		return models[i].Model < models[j].Model
	})
	return mediaCapabilityCatalog{Version: adminConfigRevision(models), Models: models}, nil
}

func appendMediaCapabilityModels(models []mediaModelCapability, channel adminChannelPublic) []mediaModelCapability {
	explicit := make(map[string]struct{}, len(channel.MediaCapabilities))
	for _, configured := range channel.MediaCapabilities {
		explicit[configured.Kind+"\x00"+strings.ToLower(configured.Model)] = struct{}{}
		models = append(models, capabilityForExplicitChannelModel(channel, configured))
	}
	defaults := []struct{ kind, model string }{{"image", channel.DefaultImageModel}, {"video", channel.DefaultVideoModel}, {"audio", channel.DefaultAudioModel}}
	for _, item := range defaults {
		if item.model == "" || !channelModelsAllow(channel.Models, item.model) {
			continue
		}
		if _, configured := explicit[item.kind+"\x00"+strings.ToLower(item.model)]; configured {
			continue
		}
		if _, registered := resolveProviderModelCapability(channel.Protocol, item.kind, item.model); registered {
			models = append(models, capabilityForChannelDefault(channel, item.kind, item.model))
		}
	}
	return models
}

func (s *Server) verifySharedMediaCapability(ctx context.Context, tenantID, channelID, kind, model, mode string) (string, error) {
	if !validFilmGenerationMode(mode) {
		return "", errors.New("invalid media generation mode")
	}
	catalog, err := s.buildMediaCapabilityCatalog(ctx, tenantID)
	if err != nil {
		return "", err
	}
	for _, capability := range catalog.Models {
		if capability.ChannelID != channelID || capability.Kind != kind || capability.Model != model {
			continue
		}
		for _, supported := range capability.Modes {
			if supported == mode {
				return catalog.Version, nil
			}
		}
	}
	return "", errors.New("shared media capability is not listed")
}

func validateMediaCapabilityRequest(capability mediaModelCapability, mode string, config filmGenerationConfig) error {
	if !containsFilmMode(capability.Modes, mode) {
		return errors.New("media generation mode is not supported")
	}
	if len(config.ReferenceStorageKeys) > capability.MaxReferences {
		return errors.New("media reference count exceeds channel capability")
	}
	requestedSize := strings.TrimSpace(config.Size)
	if requestedSize != "" && len(capability.Sizes) > 0 && !containsFilmStorageKey(capability.Sizes, requestedSize) {
		return errors.New("media size is not supported by channel capability")
	}
	requestedRatio := strings.TrimSpace(config.Ratio)
	allowedRatios := capability.Ratios
	if len(allowedRatios) == 0 {
		allowedRatios = capability.Sizes
	}
	if requestedRatio != "" && len(allowedRatios) > 0 && !containsFilmStorageKey(allowedRatios, requestedRatio) {
		return errors.New("media ratio is not supported by channel capability")
	}
	requestedResolution := strings.TrimSpace(config.Resolution)
	allowedResolutions := capability.Resolutions
	if len(allowedResolutions) == 0 {
		allowedResolutions = capability.Sizes
	}
	if requestedResolution != "" && len(allowedResolutions) > 0 && !containsFilmStorageKey(allowedResolutions, requestedResolution) {
		return errors.New("media resolution is not supported by channel capability")
	}
	if config.Seconds > 0 && len(capability.Durations) > 0 {
		allowed := false
		for _, duration := range capability.Durations {
			allowed = allowed || duration == config.Seconds
		}
		if !allowed {
			return errors.New("media duration is not supported by channel capability")
		}
	}
	return nil
}

func (s *Server) getMediaCapabilities(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || s.secrets == nil {
		writeJSON(w, mediaCapabilityCatalog{Version: adminConfigRevision([]mediaModelCapability{}), Models: []mediaModelCapability{}})
		return
	}
	catalog, err := s.buildMediaCapabilityCatalog(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "media capabilities unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, catalog)
}
