package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
)

type mediaModelCapability struct {
	ChannelID     string   `json:"channelId"`
	ChannelName   string   `json:"channelName"`
	Protocol      string   `json:"protocol"`
	Model         string   `json:"model"`
	Kind          string   `json:"kind"`
	Modes         []string `json:"modes"`
	Sizes         []string `json:"sizes,omitempty"`
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
	capability := mediaModelCapability{ChannelID: channel.ID, ChannelName: channel.Name, Protocol: channel.Protocol, Model: model, Kind: kind}
	switch kind {
	case "image":
		capability.Modes, capability.MaxReferences = []string{"text_to_image", "image_to_image"}, 16
		if channel.Protocol == "openai" {
			capability.Sizes = []string{"1024x1024", "1536x1024", "1024x1536"}
		}
	case "video":
		capability.Modes, capability.MaxReferences = []string{"text_to_video", "image_to_video"}, 8
	case "audio":
		capability.Modes, capability.MaxReferences = []string{"text_to_audio"}, 0
	}
	return capability
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
	models := make([]mediaModelCapability, 0, len(channels)*3)
	for _, raw := range channels {
		channel, message := normalizeAdminChannel(raw)
		if message != "" || !channel.Enabled || !channel.AllowUserUse || (adminChannelRequiresSecret(channel) && !presence[channel.ID]) {
			continue
		}
		defaults := []struct{ kind, model string }{{"image", channel.DefaultImageModel}, {"video", channel.DefaultVideoModel}, {"audio", channel.DefaultAudioModel}}
		for _, item := range defaults {
			if item.model != "" && channelModelsAllow(channel.Models, item.model) {
				models = append(models, capabilityForChannelDefault(channel, item.kind, item.model))
			}
		}
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
