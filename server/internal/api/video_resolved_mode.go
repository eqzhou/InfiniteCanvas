package api

import "errors"

const (
	videoModeText       = "text_to_video"
	videoModeFirstFrame = "first_frame_to_video"
	videoModeFirstLast  = "first_last_frame_to_video"
	videoModeReferences = "reference_to_video"
)

func resolveVideoGenerationMode(frameMode string, referenceCount, elementCount int) (string, error) {
	if referenceCount < 0 || elementCount < 0 {
		return "", errors.New("video reference count is invalid")
	}
	if normalizeVideoFrameMode(frameMode) == "first-last" {
		if elementCount != 0 || referenceCount < 1 || referenceCount > 2 {
			return "", errors.New("first-last video mode requires one or two ordered frame references")
		}
		if referenceCount == 1 {
			return videoModeFirstFrame, nil
		}
		return videoModeFirstLast, nil
	}
	if referenceCount > 0 || elementCount > 0 {
		return videoModeReferences, nil
	}
	return videoModeText, nil
}

func videoCapabilityMode(resolvedMode string) string {
	switch resolvedMode {
	case videoModeText:
		return "text_to_video"
	case videoModeFirstFrame, videoModeFirstLast, videoModeReferences:
		return "image_to_video"
	default:
		return ""
	}
}

func validateFrozenVideoMode(frozen, frameMode string, referenceCount, elementCount int) (string, error) {
	resolved, err := resolveVideoGenerationMode(frameMode, referenceCount, elementCount)
	if err != nil {
		return "", err
	}
	if frozen != "" && frozen != resolved {
		return "", errors.New("video generation mode no longer matches its frozen task snapshot")
	}
	return resolved, nil
}

func resolveFilmVideoConfig(shot filmShot, config filmGenerationConfig) (filmGenerationConfig, string, error) {
	hasExplicitReferences := len(config.ReferenceStorageKeys) > 0
	next := config
	next.ReferenceStorageKeys = orderedFilmVideoReferences(shot, config.ReferenceStorageKeys)
	if next.FrameMode == "" {
		if !hasExplicitReferences && shot.FirstFrameStorageKey != "" {
			next.FrameMode = "first-last"
		} else {
			next.FrameMode = "references"
		}
	}
	resolved, err := resolveVideoGenerationMode(next.FrameMode, len(next.ReferenceStorageKeys), 0)
	return next, resolved, err
}
