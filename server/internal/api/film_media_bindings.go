package api

import (
	"context"
	"errors"
	"strings"
)

func (s *Server) verifiedFilmShotMedia(ctx context.Context, tenantID string, document filmDocument, shotID, stage, storageKey string, maxBytes int64) (blobObject, error) {
	if storageKey == "" || filmStageGenerationKind(stage) == "" {
		return blobObject{}, errors.New("film media storage key is not verified")
	}
	for _, task := range document.Tasks {
		if task.Stage != stage || task.ShotID != shotID || task.GenerationJobID == "" || task.RequestHash == "" {
			continue
		}
		job, err := s.store.GetGenerationJob(ctx, tenantID, task.GenerationJobID)
		if err != nil || job.Status != "succeeded" {
			continue
		}
		binding := filmGenerationBinding{ProjectID: document.ProjectID, Stage: stage, ShotID: shotID, TaskID: task.ID, RequestHash: task.RequestHash}
		if !matchingFilmGenerationJob(job, binding) {
			continue
		}
		item, err := validFilmGenerationResult(ctx, s, tenantID, stage, job)
		if err != nil || item.StorageKey != storageKey {
			continue
		}
		value, err := s.readTenantBlob(ctx, tenantID, storageKey, maxBytes)
		if err == nil && value.Metadata.ContentType == item.MIMEType && len(value.Data) == item.Bytes {
			return value, nil
		}
	}
	return blobObject{}, errors.New("film media storage key is not verified by a successful tenant generation job")
}

func filmShotMediaIdentity(shot filmShot, stage string) (key, digest, version, jobID, mimePrefix string) {
	switch stage {
	case "storyboard":
		return shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID, "image/"
	case "audio":
		return shot.AudioStorageKey, shot.AudioSHA256, shot.AudioObjectVersion, shot.AudioGenerationJobID, "audio/"
	case "video":
		return shot.VideoStorageKey, shot.VideoSHA256, shot.VideoObjectVersion, shot.VideoGenerationJobID, "video/"
	default:
		return "", "", "", "", ""
	}
}

func (s *Server) readVerifiedFilmShotMedia(ctx context.Context, tenantID string, document filmDocument, shot filmShot, stage string, maxBytes int64) (blobObject, error) {
	key, digest, version, jobID, mimePrefix := filmShotMediaIdentity(shot, stage)
	if key == "" {
		return blobObject{}, errors.New("film media storage key is missing")
	}
	value, err := s.readTenantBlob(ctx, tenantID, key, maxBytes)
	if err != nil {
		return blobObject{}, errors.New("film media is not a verified tenant object")
	}
	if err := verifyFilmBlob(value, mimePrefix, "", digest, version, 0); err != nil {
		return blobObject{}, err
	}
	if protectedFilmBlobKey(key) {
		if shot.MediaProvenance == "restore" && strings.HasPrefix(key, "film:media:"+document.ProjectID+":") {
			return value, nil
		}
		if jobID == "" {
			return blobObject{}, errors.New("protected film media is missing its generation job binding")
		}
		verified, err := s.verifiedFilmShotMedia(ctx, tenantID, document, shot.ID, stage, key, maxBytes)
		if err != nil || sha256Hex(verified.Data) != digest {
			return blobObject{}, errors.New("protected film media is not verified by its successful generation job")
		}
	}
	return value, nil
}

func (s *Server) validateRestoredFilmMediaBindings(ctx context.Context, tenantID string, document filmDocument) error {
	for _, asset := range document.Assets {
		if asset.MediaStorageKey == "" {
			continue
		}
		if protectedFilmBlobKey(asset.MediaStorageKey) {
			return errors.New("restored asset media cannot claim a protected generation namespace")
		}
		value, err := s.readTenantBlob(ctx, tenantID, asset.MediaStorageKey, maxFilmRenderBytes)
		validMIME := strings.HasPrefix(asset.MediaMIMEType, "image/") || strings.HasPrefix(asset.MediaMIMEType, "audio/") || strings.HasPrefix(asset.MediaMIMEType, "video/")
		if err != nil || !validMIME || verifyFilmBlob(value, "", asset.MediaMIMEType, asset.MediaSHA256, asset.MediaObjectVersion, 0) != nil {
			return errors.New("restored asset media is not a verified tenant object")
		}
	}
	for _, shot := range document.Shots {
		for _, stage := range []string{"storyboard", "audio", "video"} {
			key, _, _, _, _ := filmShotMediaIdentity(shot, stage)
			if key == "" {
				continue
			}
			if _, err := s.readVerifiedFilmShotMedia(ctx, tenantID, document, shot, stage, maxFilmRenderBytes); err != nil {
				return err
			}
		}
	}
	for _, deliverable := range document.Deliverables {
		if deliverable.StorageKey == "" {
			continue
		}
		if !strings.HasPrefix(deliverable.StorageKey, "film:deliverable:"+document.ProjectID+":") {
			return errors.New("restored deliverable storage key is not bound to this project")
		}
		value, err := s.readTenantBlob(ctx, tenantID, deliverable.StorageKey, maxFilmRenderBytes)
		if err != nil || verifyFilmBlob(value, "", deliverable.MIMEType, deliverable.SHA256, deliverable.ObjectVersion, deliverable.Bytes) != nil {
			return errors.New("restored deliverable is not a verified tenant object")
		}
	}
	return nil
}
