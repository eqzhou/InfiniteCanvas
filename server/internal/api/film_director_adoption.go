package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type filmDirectorAdoptionRequest struct {
	ShotID           string `json:"shotId"`
	ExpectedRevision int    `json:"expectedRevision"`
	CaptureID        string `json:"captureId"`
	TargetField      string `json:"targetField"`
}

func projectContainsDirectorNode(raw []byte, nodeID string) bool {
	var project struct {
		Nodes []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"nodes"`
	}
	if json.Unmarshal(raw, &project) != nil || len(project.Nodes) > maxFilmEntities {
		return false
	}
	for _, node := range project.Nodes {
		if node.ID == nodeID && node.Type == "director" {
			return true
		}
	}
	return false
}

func (s *Server) adoptFilmDirectorCapture(w http.ResponseWriter, r *http.Request) {
	var input filmDirectorAdoptionRequest
	if err := decodeFilmRequest(w, r, 16<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !validProjectID(input.ShotID) || input.ExpectedRevision < 1 || !validProjectID(input.CaptureID) ||
		(input.TargetField != "storyboard" && input.TargetField != "first_frame") {
		writeFilmError(w, http.StatusUnprocessableEntity, "director_adoption_invalid", "Director adoption request is invalid")
		return
	}
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	shotIndex := -1
	for index, shot := range document.Shots {
		if shot.ID == input.ShotID {
			shotIndex = index
			if shot.Revision != input.ExpectedRevision {
				writeFilmError(w, http.StatusConflict, "revision_conflict", "film shot revision conflict")
				return
			}
			break
		}
	}
	if shotIndex < 0 {
		writeFilmError(w, http.StatusNotFound, "shot_not_found", "film shot is unavailable")
		return
	}
	_, captures, err := s.readDirectorCaptureDocument(r)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "director_capture_unavailable", "Director capture catalog is unavailable")
		return
	}
	var capture directorCaptureRecord
	for _, candidate := range captures.Items {
		if candidate.ID == input.CaptureID && candidate.ProjectID == document.ProjectID && candidate.OrphanedAt == "" {
			capture = candidate
			break
		}
	}
	if capture.ID == "" || len(capture.Shot) == 0 {
		writeFilmError(w, http.StatusNotFound, "director_capture_not_found", "Director capture is unavailable for this Film project")
		return
	}
	project, err := s.store.GetProject(r.Context(), tenantIDFrom(r), document.ProjectID)
	if err != nil || !projectContainsDirectorNode(project, capture.DirectorNodeID) {
		writeFilmError(w, http.StatusUnprocessableEntity, "director_source_invalid", "Director source node is unavailable in this Film project")
		return
	}
	source, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), capture.StorageKey, maxDirectorCaptureBytes)
	if err != nil || source.Metadata.ContentType != "image/png" || len(source.Data) != capture.Bytes || validateDirectorCapturePNG(source.Data, capture.Width, capture.Height) != nil {
		writeFilmError(w, http.StatusUnprocessableEntity, "director_media_invalid", "Director capture media is unavailable or invalid")
		return
	}
	digest := sha256Hex(source.Data)
	storageKey := "film:media:director:" + stableFilmID(document.ProjectID, input.ShotID, input.TargetField, input.CaptureID, input.ExpectedRevision, digest)
	created := false
	if err := s.storeTenantBlobConditional(r.Context(), tenantIDFrom(r), userIDFrom(r), storageKey, "image/png", source.Data, blobVersionAbsent); err == nil {
		created = true
	} else if !errors.Is(err, store.ErrConflict) {
		writeFilmOperationError(w, err)
		return
	}
	committed := false
	defer func() {
		if created && !committed {
			s.cleanupUnreferencedFilmBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), document.ProjectID, storageKey)
		}
	}()
	stable, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), storageKey, maxDirectorCaptureBytes)
	if err != nil || stable.Metadata.ContentType != "image/png" || sha256Hex(stable.Data) != digest {
		writeFilmError(w, http.StatusInternalServerError, "director_copy_invalid", "Stable Film Director media could not be verified")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	next := cloneFilmDocument(document)
	shot := next.Shots[shotIndex]
	shotSnapshot, _ := json.Marshal(shot)
	next.Versions = append(next.Versions, filmEntityVersion{ID: stableFilmID("version", "shot", shot.ID, shot.Revision, input.CaptureID), EntityType: "shot", EntityID: shot.ID, Revision: shot.Revision, Snapshot: shotSnapshot, Reason: "director:" + input.CaptureID, CreatedAt: now})
	version := blobIdentityVersion(stable)
	if input.TargetField == "storyboard" {
		shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID = storageKey, digest, version, ""
	} else {
		shot.FirstFrameStorageKey, shot.FirstFrameSHA256, shot.FirstFrameObjectVersion, shot.FirstFrameGenerationJobID = storageKey, digest, version, ""
	}
	shot.DirectorSource = &filmDirectorSource{Revision: 1, TargetField: input.TargetField, CaptureID: capture.ID, DirectorNodeID: capture.DirectorNodeID, CameraID: capture.CameraID, CameraName: capture.CameraName, Width: capture.Width, Height: capture.Height, StorageKey: storageKey, SHA256: digest, ObjectVersion: version, Snapshot: append(json.RawMessage(nil), capture.Shot...), AdoptedAt: now}
	shot.MediaMIMEType, shot.MediaProvenance, shot.Status = "image/png", "director:"+capture.ID, filmStatusNeedsReview
	shot.Revision++
	next.Shots[shotIndex] = shot
	next = invalidateFilmStages(next, "storyboard", now)
	next.Revision++
	next.UpdatedAt = now
	if _, _, _, _, err := validateFilmEntities(next); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	if err := validateFilmAggregateLimits(next); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, err := json.Marshal(next)
	if err != nil || len(raw) > maxProjectBytes {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	updated, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		} else {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film Director adoption could not be saved")
		}
		return
	}
	committed = true
	s.writeFilmDocument(w, r, http.StatusOK, updated, next)
}
