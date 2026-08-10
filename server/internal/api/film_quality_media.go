package api

import (
	"context"
	"errors"
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
	var totalBytes int64
	for _, issue := range report.Issues {
		seen[issue.ID] = struct{}{}
	}
	appendCorrupt := func(targetType, targetID, message, key, mimePrefix, digest, version string, repairShot *filmShot) error {
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
	for _, scene := range document.Scenes {
		if scene.DirectorSource == nil {
			continue
		}
		source := scene.DirectorSource
		if err := appendCorrupt("scene", scene.ID, "Formal Director scene media is unavailable or failed integrity verification.", source.StorageKey, "image/", source.SHA256, source.ObjectVersion, nil); err != nil {
			return filmQualityReport{}, err
		}
	}
	for _, shot := range document.Shots {
		for _, media := range []struct{ key, prefix, digest, version string }{
			{shot.ImageStorageKey, "image/", shot.ImageSHA256, shot.ImageObjectVersion},
			{shot.FirstFrameStorageKey, "image/", shot.FirstFrameSHA256, shot.FirstFrameObjectVersion},
			{shot.AudioStorageKey, "audio/", shot.AudioSHA256, shot.AudioObjectVersion},
			{shot.VideoStorageKey, "video/", shot.VideoSHA256, shot.VideoObjectVersion},
		} {
			if err := appendCorrupt("shot", shot.ID, "Shot media is unavailable or failed integrity verification.", media.key, media.prefix, media.digest, media.version, &shot); err != nil {
				return filmQualityReport{}, err
			}
		}
	}
	return report, nil
}
