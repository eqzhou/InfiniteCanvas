package api

import "strings"

type providerModelCapability struct {
	Protocol           string
	Kind               string
	Model              string
	Family             string
	MaxImageReferences int
	MinDuration        int
	MaxDuration        int
	Ratios             []string
	Resolutions        []string
	MaxOutputs         int
	Sizes              []string
	Qualities          []string
}

var providerModelCapabilities = []providerModelCapability{
	{Protocol: "openai", Kind: "image", Model: "gpt-image-1", Family: "gpt-image-1", MaxImageReferences: 16, MaxOutputs: 4,
		Sizes: []string{"1:1", "2:3", "3:2"}, Qualities: []string{"auto", "low", "medium", "high"}},
	{Protocol: "openai", Kind: "image", Model: "gpt-image-1.5", Family: "gpt-image-1.5", MaxImageReferences: 16, MaxOutputs: 4,
		Sizes: []string{"1:1", "2:3", "3:2"}, Qualities: []string{"auto", "low", "medium", "high"}},
	{Protocol: "openai", Kind: "image", Model: "gpt-image-2", Family: "gpt-image-2", MaxImageReferences: 16, MaxOutputs: 4,
		Sizes: []string{"1:1", "2:3", "3:2"}, Qualities: []string{"auto", "low", "medium", "high"}},
	{Protocol: "openai", Kind: "image", Model: "grok-imagine-image", Family: "grok-imagine-image", MaxOutputs: 1,
		Qualities: []string{"low", "medium", "high"}},
	{Protocol: "openai", Kind: "image", Model: "grok-imagine-image-2.0", Family: "grok-imagine-image-2.0", MaxOutputs: 1,
		Qualities: []string{"low", "medium", "high"}},
	{Protocol: "openai", Kind: "image", Model: "grok-imagine-image-quality", Family: "grok-imagine-image-quality", MaxOutputs: 1,
		Qualities: []string{"low", "medium", "high"}},
	{Protocol: "apimart", Kind: "video", Model: "kling-v2-6", Family: "kling-2.6", MaxImageReferences: 2},
	{Protocol: "apimart", Kind: "video", Model: "kling-v3", Family: "kling-3", MaxImageReferences: 2},
	{Protocol: "apimart", Kind: "video", Model: "happyhorse-1.1", Family: "happyhorse-1.1", MaxImageReferences: 9,
		MinDuration: 3, MaxDuration: 15, Ratios: []string{"16:9", "9:16", "1:1", "4:3", "3:4"},
		Resolutions: []string{"720p", "1080p"}},
	{Protocol: "apimart", Kind: "video", Model: "kling-3.0-turbo", Family: "kling-3.0-turbo", MaxImageReferences: 1,
		MinDuration: 3, MaxDuration: 15, Ratios: []string{"16:9", "9:16", "1:1"},
		Resolutions: []string{"720p", "1080p"}},
	{Protocol: "apimart", Kind: "video", Model: "doubao-seedance-2.0", Family: "seedance-2.0", MaxImageReferences: 9,
		MinDuration: 5, MaxDuration: 15, Ratios: []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"},
		Resolutions: []string{"480p", "720p", "1080p", "4k"}},
	{Protocol: "apimart", Kind: "video", Model: "doubao-seedance-2.0-fast", Family: "seedance-2.0", MaxImageReferences: 9,
		MinDuration: 5, MaxDuration: 15, Ratios: []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"},
		Resolutions: []string{"480p", "720p"}},
	{Protocol: "apimart", Kind: "video", Model: "doubao-seedance-2.0-mini", Family: "seedance-2.0", MaxImageReferences: 9,
		MinDuration: 5, MaxDuration: 15, Ratios: []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"},
		Resolutions: []string{"480p", "720p"}},
	{Protocol: "apimart", Kind: "image", Model: "gpt-image-1-official", Family: "gpt-image-1", MaxImageReferences: 15, MaxOutputs: 4, Sizes: []string{"1:1", "2:3", "3:2"}, Qualities: []string{"auto", "low", "medium", "high"}},
	{Protocol: "apimart", Kind: "image", Model: "gpt-image-1.5-official", Family: "gpt-image-1.5", MaxImageReferences: 15, MaxOutputs: 4, Sizes: []string{"1:1", "2:3", "3:2"}, Qualities: []string{"auto", "low", "medium", "high"}},
	{Protocol: "apimart", Kind: "image", Model: "doubao-seedream-5-0-pro", Family: "seedream-5.0-pro", MaxImageReferences: 10, MaxOutputs: 1,
		Sizes: []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "auto"}, Resolutions: []string{"1K", "2K"}},
	{Protocol: "apimart", Kind: "image", Model: "gemini-3.1-flash-lite-image", Family: "gemini-3.1-flash-lite-image", MaxImageReferences: 14, MaxOutputs: 4,
		Sizes: []string{"auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9"}, Resolutions: []string{"1K"}},
	{Protocol: "apimart", Kind: "image", Model: "nano-banana-2-lite", Family: "gemini-3.1-flash-lite-image", MaxImageReferences: 14, MaxOutputs: 4,
		Sizes: []string{"auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9"}, Resolutions: []string{"1K"}},
}

func resolveProviderModelCapability(protocol, kind, model string) (providerModelCapability, bool) {
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	model = strings.ToLower(strings.TrimSpace(model))
	for _, capability := range providerModelCapabilities {
		if capability.Protocol == protocol && capability.Kind == kind && capability.Model == model {
			capability.Ratios = append([]string(nil), capability.Ratios...)
			capability.Resolutions = append([]string(nil), capability.Resolutions...)
			capability.Sizes = append([]string(nil), capability.Sizes...)
			capability.Qualities = append([]string(nil), capability.Qualities...)
			return capability, true
		}
	}
	return providerModelCapability{}, false
}

func normalizeProviderImageQuality(protocol, model, quality string) string {
	quality = strings.TrimSpace(quality)
	capability, ok := resolveProviderModelCapability(protocol, "image", model)
	if !ok || len(capability.Qualities) == 0 {
		return quality
	}
	for _, supported := range capability.Qualities {
		if quality == supported {
			return quality
		}
	}
	if quality != "" && quality != "auto" {
		return quality
	}
	for _, supported := range capability.Qualities {
		if supported == "medium" {
			return supported
		}
	}
	return capability.Qualities[0]
}
