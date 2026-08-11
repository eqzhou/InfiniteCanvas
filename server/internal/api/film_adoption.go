package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type filmAdoptionRequest struct {
	TargetType       string `json:"targetType"`
	TargetID         string `json:"targetId"`
	TargetField      string `json:"targetField"`
	ExpectedRevision int    `json:"expectedRevision"`
	SourceNodeID     string `json:"sourceNodeId"`
	StorageKey       string `json:"storageKey"`
	GenerationJobID  string `json:"generationJobId,omitempty"`
}

func filmAdoptionExpectedMIME(targetType, field string) string {
	if targetType == "asset" && field == "media" {
		return ""
	}
	if targetType != "shot" {
		return "invalid"
	}
	switch field {
	case "image":
		return "image/"
	case "first_frame", "last_frame":
		return "image/"
	case "video":
		return "video/"
	case "audio":
		return "audio/"
	default:
		return "invalid"
	}
}

func generationJobContainsStorageKey(job store.GenerationJob, storageKey string) bool {
	var result struct {
		Items []mediaGenerationItem `json:"items"`
	}
	if json.Unmarshal(job.Result, &result) != nil {
		return false
	}
	for _, item := range result.Items {
		if item.StorageKey == storageKey {
			return true
		}
	}
	return false
}

func (s *Server) adoptFilmCanvasMedia(w http.ResponseWriter, r *http.Request) {
	var input filmAdoptionRequest
	if err := decodeFilmRequest(w, r, 32<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	expectedMIME := filmAdoptionExpectedMIME(input.TargetType, input.TargetField)
	if expectedMIME == "invalid" || input.ExpectedRevision < 1 || !validProjectID(input.TargetID) ||
		!validProjectID(input.SourceNodeID) || input.StorageKey == "" || len(input.StorageKey) > 512 ||
		(input.GenerationJobID != "" && !validProjectID(input.GenerationJobID)) {
		writeFilmError(w, http.StatusUnprocessableEntity, "adoption_invalid", "canvas media adoption is invalid")
		return
	}
	tenantID := tenantIDFrom(r)
	value, err := s.readTenantBlob(r.Context(), tenantID, input.StorageKey, maxUploadBytes)
	if err != nil || !filmMIMEType.MatchString(value.Metadata.ContentType) ||
		(expectedMIME != "" && !strings.HasPrefix(value.Metadata.ContentType, expectedMIME)) {
		writeFilmError(w, http.StatusUnprocessableEntity, "adoption_media_invalid", "canvas media is unavailable or has the wrong type")
		return
	}
	var job store.GenerationJob
	if input.GenerationJobID != "" {
		job, err = s.store.GetGenerationJob(r.Context(), tenantID, input.GenerationJobID)
		if err != nil || job.ProjectID != chi.URLParam(r, "projectId") || job.Status != "succeeded" || !generationJobContainsStorageKey(job, input.StorageKey) {
			writeFilmError(w, http.StatusUnprocessableEntity, "adoption_job_invalid", "generation provenance does not authorize this media")
			return
		}
	}
	digest, version := sha256Hex(value.Data), blobIdentityVersion(value)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		next := cloneFilmDocument(document)
		if len(next.Versions) >= 1_000 {
			return filmDocument{}, errors.New("film entity version limit reached")
		}
		adoption := filmMediaAdoption{
			ID:       stableFilmID("adoption", document.ProjectID, input.TargetType, input.TargetID, input.TargetField, input.ExpectedRevision, input.SourceNodeID),
			Revision: 1, TargetType: input.TargetType, TargetID: input.TargetID, TargetField: input.TargetField,
			TargetRevision: input.ExpectedRevision + 1, SourceNodeID: input.SourceNodeID, StorageKey: input.StorageKey,
			MIMEType: value.Metadata.ContentType, SHA256: digest, ObjectVersion: version, GenerationJobID: input.GenerationJobID,
			Prompt: job.Prompt, ProviderID: job.ProviderID, Model: job.Model, AdoptedAt: now,
		}
		found := false
		if input.TargetType == "shot" {
			for index, shot := range next.Shots {
				if shot.ID != input.TargetID {
					continue
				}
				if shot.Revision != input.ExpectedRevision {
					return filmDocument{}, errors.New("adoption revision conflict")
				}
				snapshot, snapshotErr := json.Marshal(shot)
				if snapshotErr != nil {
					return filmDocument{}, snapshotErr
				}
				next.Versions = append(next.Versions, filmEntityVersion{ID: stableFilmID("version", "shot", shot.ID, shot.Revision, "canvas", input.SourceNodeID), EntityType: "shot", EntityID: shot.ID, Revision: shot.Revision, Snapshot: snapshot, Reason: "canvas:" + input.SourceNodeID, CreatedAt: now})
				switch input.TargetField {
				case "image":
					shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID = input.StorageKey, digest, version, input.GenerationJobID
				case "first_frame":
					shot.FirstFrameStorageKey, shot.FirstFrameSHA256, shot.FirstFrameObjectVersion, shot.FirstFrameGenerationJobID = input.StorageKey, digest, version, input.GenerationJobID
				case "last_frame":
					shot.LastFrameStorageKey, shot.LastFrameSHA256, shot.LastFrameObjectVersion, shot.LastFrameGenerationJobID = input.StorageKey, digest, version, input.GenerationJobID
				case "video":
					shot.VideoStorageKey, shot.VideoSHA256, shot.VideoObjectVersion, shot.VideoGenerationJobID = input.StorageKey, digest, version, input.GenerationJobID
				case "audio":
					shot.AudioStorageKey, shot.AudioSHA256, shot.AudioObjectVersion, shot.AudioGenerationJobID = input.StorageKey, digest, version, input.GenerationJobID
				}
				shot.MediaMIMEType, shot.MediaProvenance, shot.Status = value.Metadata.ContentType, "canvas:"+input.SourceNodeID, filmStatusNeedsReview
				shot.Revision++
				next.Shots[index], found = shot, true
				break
			}
		} else {
			for index, asset := range next.Assets {
				if asset.ID != input.TargetID {
					continue
				}
				if asset.Revision != input.ExpectedRevision {
					return filmDocument{}, errors.New("adoption revision conflict")
				}
				snapshot, snapshotErr := json.Marshal(asset)
				if snapshotErr != nil {
					return filmDocument{}, snapshotErr
				}
				next.Versions = append(next.Versions, filmEntityVersion{ID: stableFilmID("version", "asset", asset.ID, asset.Revision, "canvas", input.SourceNodeID), EntityType: "asset", EntityID: asset.ID, Revision: asset.Revision, Snapshot: snapshot, Reason: "canvas:" + input.SourceNodeID, CreatedAt: now})
				asset.MediaStorageKey, asset.MediaMIMEType, asset.MediaSHA256, asset.MediaObjectVersion = input.StorageKey, value.Metadata.ContentType, digest, version
				asset.MediaProvenance, asset.Status, asset.Revision = "canvas:"+input.SourceNodeID, filmStatusNeedsReview, asset.Revision+1
				next.Assets[index], found = asset, true
				break
			}
		}
		if !found {
			return filmDocument{}, errors.New("adoption target not found")
		}
		if len(next.Adoptions) >= 1_000 {
			return filmDocument{}, errors.New("film adoption history limit reached")
		}
		next.Adoptions = append(next.Adoptions, adoption)
		changedStage := filmAssetInvalidationStage("")
		if input.TargetType == "shot" {
			changedStage = map[string]string{"image": "storyboard", "first_frame": "first_frame", "last_frame": "first_frame", "video": "video", "audio": "audio"}[input.TargetField]
		} else {
			for _, asset := range next.Assets {
				if asset.ID == input.TargetID {
					changedStage = filmAssetInvalidationStage(asset.Kind)
					break
				}
			}
		}
		next = invalidateFilmStages(next, changedStage, now)
		next.Revision++
		next.UpdatedAt = now
		return next, nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
