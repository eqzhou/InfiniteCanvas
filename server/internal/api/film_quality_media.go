package api

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	maxFilmQualityMediaItems = 1_024
	maxFilmQualityMediaBytes = int64(256 << 20)
)

func (s *Server) validateFilmDocumentWithMedia(ctx context.Context, tenantID string, document filmDocument) (filmQualityReport, error) {
	report, err := validateFilmDocument(document)
	if err != nil {
		return filmQualityReport{}, err
	}
	release, err := s.acquireFilmQualityCheck(ctx, tenantID)
	if err != nil {
		return filmQualityReport{}, err
	}
	defer release()
	seen := map[string]struct{}{}
	mediaCache := map[string]blobObject{}
	mediaErrors := map[string]error{}
	probePath := ""
	if ffmpegPath, available, _ := s.filmFFmpegCapability(ctx); available {
		probePath = resolveFilmFFprobePath(ffmpegPath)
	}
	probeDir := ""
	if probePath != "" {
		probeDir, err = os.MkdirTemp("", "openboard-film-quality-")
		if err != nil {
			return filmQualityReport{}, errFilmQualityMedia
		}
		defer os.RemoveAll(probeDir)
	}
	var totalBytes int64
	for _, issue := range report.Issues {
		seen[issue.ID] = struct{}{}
	}
	appendCorrupt := func(targetType, targetID, message, key, mimePrefix, digest, version, regenerationStage string, repairShot *filmShot) error {
		if key == "" {
			return nil
		}
		value, cached := mediaCache[key]
		readErr, failed := mediaErrors[key]
		if !cached && !failed {
			if len(mediaCache)+len(mediaErrors) >= maxFilmQualityMediaItems {
				return errFilmQualityMedia
			}
			remaining := maxFilmQualityMediaBytes - totalBytes
			if remaining <= 0 {
				return errFilmQualityMedia
			}
			readLimit := min(int64(maxUploadBytes), remaining)
			value, readErr = s.readTenantBlob(ctx, tenantID, key, readLimit)
			if errors.Is(readErr, errBlobObjectTooLarge) {
				return errFilmQualityMedia
			}
			if readErr == nil {
				totalBytes += int64(len(value.Data))
				mediaCache[key] = value
			} else {
				mediaErrors[key] = readErr
			}
		}
		if readErr == nil {
			readErr = verifyFilmBlob(value, mimePrefix, "", digest, version, 0)
		}
		if readErr == nil {
			return nil
		}
		issue := newFilmIssue("media_corrupt", targetType, targetID, message, "error")
		issue.MediaKind = regenerationStage
		if issue.MediaKind == "" {
			issue.MediaKind = strings.TrimSuffix(mimePrefix, "/")
		}
		if _, duplicate := seen[issue.ID]; duplicate {
			return nil
		}
		if len(report.Issues) >= maxFilmQualityIssues {
			return errFilmQualityLimit
		}
		report.Issues = append(report.Issues, issue)
		seen[issue.ID] = struct{}{}
		if repairShot != nil {
			repair, ok := filmShotRepair(issue, *repairShot)
			if !ok {
				return nil
			}
			if len(report.Repairs) >= maxFilmRepairProposals {
				return errFilmRepairLimit
			}
			report.Repairs = append(report.Repairs, repair)
		}
		return nil
	}
	appendProbeIssue := func(code, targetType, targetID, message, mediaKind string, repairShot *filmShot) error {
		issue := newFilmIssue(code, targetType, targetID, message, "error")
		issue.MediaKind = mediaKind
		if _, duplicate := seen[issue.ID]; duplicate {
			return nil
		}
		if len(report.Issues) >= maxFilmQualityIssues {
			return errFilmQualityLimit
		}
		report.Issues = append(report.Issues, issue)
		seen[issue.ID] = struct{}{}
		if repairShot != nil {
			if repair, ok := filmShotRepair(issue, *repairShot); ok {
				if len(report.Repairs) >= maxFilmRepairProposals {
					return errFilmRepairLimit
				}
				report.Repairs = append(report.Repairs, repair)
			}
		}
		return nil
	}
	probeMedia := func(targetType, targetID, key, kind string, expectedDuration float64, repairShot *filmShot) error {
		if probeDir == "" || key == "" || mediaErrors[key] != nil {
			return nil
		}
		value, ok := mediaCache[key]
		if !ok {
			return nil
		}
		extension := filmMediaExtension(value.Metadata.ContentType)
		inputPath := filepath.Join(probeDir, fmt.Sprintf("input-%04d%s", len(mediaCache), extension))
		if err := os.WriteFile(inputPath, value.Data, 0o600); err != nil {
			return errFilmQualityMedia
		}
		metadata, probeErr := s.probeFilmInputMetadata(ctx, probePath, inputPath, kind, expectedDuration)
		if probeErr != nil {
			return appendProbeIssue("media_corrupt", targetType, targetID, "Media stream failed bounded FFprobe validation.", kind, repairShot)
		}
		if kind == "video" && repairShot != nil {
			tolerance := math.Max(0.5, repairShot.DurationSeconds*0.1)
			if math.Abs(metadata.Duration-repairShot.DurationSeconds) > tolerance {
				if err := appendProbeIssue("media_duration_mismatch", targetType, targetID, "Video stream duration does not match the planned shot duration.", kind, repairShot); err != nil {
					return err
				}
			}
			if expectedRatio, ok := filmAspectValue(repairShot.AspectRatio); ok && metadata.Width > 0 && metadata.Height > 0 && math.Abs(float64(metadata.Width)/float64(metadata.Height)-expectedRatio) > 0.03 {
				return appendProbeIssue("media_aspect_mismatch", targetType, targetID, "Video stream dimensions do not match the planned shot aspect ratio.", kind, repairShot)
			}
		}
		return nil
	}
	for _, scene := range document.Scenes {
		if scene.DirectorSource == nil {
			continue
		}
		source := scene.DirectorSource
		if err := appendCorrupt("scene", scene.ID, "Formal Director scene media is unavailable or failed integrity verification.", source.StorageKey, "image/", source.SHA256, source.ObjectVersion, "", nil); err != nil {
			return filmQualityReport{}, err
		}
	}
	for _, shot := range document.Shots {
		for _, media := range []struct{ key, prefix, digest, version, stage string }{
			{shot.ImageStorageKey, "image/", shot.ImageSHA256, shot.ImageObjectVersion, "storyboard"},
			{shot.FirstFrameStorageKey, "image/", shot.FirstFrameSHA256, shot.FirstFrameObjectVersion, "first_frame"},
			{shot.LastFrameStorageKey, "image/", shot.LastFrameSHA256, shot.LastFrameObjectVersion, "last_frame"},
			{shot.AudioStorageKey, "audio/", shot.AudioSHA256, shot.AudioObjectVersion, "audio"},
			{shot.VideoStorageKey, "video/", shot.VideoSHA256, shot.VideoObjectVersion, "video"},
		} {
			if err := appendCorrupt("shot", shot.ID, "Shot media is unavailable or failed integrity verification.", media.key, media.prefix, media.digest, media.version, media.stage, &shot); err != nil {
				return filmQualityReport{}, err
			}
			if (media.stage == "video" || media.stage == "audio") && media.key != "" {
				if err := probeMedia("shot", shot.ID, media.key, media.stage, shot.DurationSeconds, &shot); err != nil {
					return filmQualityReport{}, err
				}
			}
		}
	}
	for _, dialogue := range document.Dialogues {
		if err := appendCorrupt("dialogue", dialogue.ID, "Dialogue audio is unavailable or failed integrity verification.", dialogue.AudioStorageKey, "audio/", dialogue.AudioSHA256, dialogue.AudioObjectVersion, "audio", nil); err != nil {
			return filmQualityReport{}, err
		}
		if dialogue.AudioStorageKey != "" {
			shotDuration := 900.0
			for _, shot := range document.Shots {
				if shot.ID == dialogue.ShotID {
					shotDuration = shot.DurationSeconds
					break
				}
			}
			if err := probeMedia("dialogue", dialogue.ID, dialogue.AudioStorageKey, "audio", shotDuration, nil); err != nil {
				return filmQualityReport{}, err
			}
		}
	}
	return report, nil
}

func filmAspectValue(value string) (float64, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, false
	}
	width, widthErr := strconv.ParseFloat(parts[0], 64)
	height, heightErr := strconv.ParseFloat(parts[1], 64)
	return width / height, widthErr == nil && heightErr == nil && width > 0 && height > 0
}
