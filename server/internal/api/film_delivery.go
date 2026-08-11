package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func filmManifest(document filmDocument) ([]byte, error) {
	return json.MarshalIndent(map[string]any{
		"version": 2, "projectId": document.ProjectID, "revision": document.Revision,
		"episodes": document.Episodes, "scenes": document.Scenes, "shots": document.Shots,
		"dialogues": document.Dialogues, "assets": document.Assets, "tasks": document.Tasks,
		"adoptions": document.Adoptions, "versions": document.Versions, "timeline": document.Timeline,
	}, "", "  ")
}

func filmShotsCSV(document filmDocument) ([]byte, error) {
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	_ = writer.Write([]string{"shot_id", "scene_id", "order", "title", "description", "duration_seconds", "image", "video", "audio", "subtitle"})
	for _, shot := range document.Shots {
		_ = writer.Write([]string{filmCSVCell(shot.ID), filmCSVCell(shot.SceneID), fmt.Sprint(shot.Order), filmCSVCell(shot.Title), filmCSVCell(shot.Description), filmFloat(shot.DurationSeconds), filmCSVCell(shot.ImageStorageKey), filmCSVCell(shot.VideoStorageKey), filmCSVCell(shot.AudioStorageKey), filmCSVCell(shot.Subtitle)})
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func filmCSVCell(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}

func filmMediaExtension(mimeType string) string {
	switch mimeType {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "audio/mpeg":
		return ".mp3"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/ogg":
		return ".ogg"
	default:
		return ".bin"
	}
}

func (s *Server) authorizedFilmMedia(ctx context.Context, tenantID string, document filmDocument) (map[string]blobObject, error) {
	type mediaBinding struct {
		shot  filmShot
		stage string
		key   string
	}
	bindings := make([]mediaBinding, 0, len(document.Shots)*3)
	for _, shot := range document.Shots {
		for _, binding := range []mediaBinding{
			{shot: shot, stage: "storyboard", key: shot.ImageStorageKey},
			{shot: shot, stage: "first_frame", key: shot.FirstFrameStorageKey},
			{shot: shot, stage: "last_frame", key: shot.LastFrameStorageKey},
			{shot: shot, stage: "video", key: shot.VideoStorageKey},
			{shot: shot, stage: "audio", key: shot.AudioStorageKey},
		} {
			if binding.key != "" {
				bindings = append(bindings, binding)
			}
		}
	}
	if len(bindings) > maxFilmTimelineClips {
		return nil, errors.New("film media inventory exceeds its limit")
	}
	result := map[string]blobObject{}
	var total int64
	for _, binding := range bindings {
		if _, exists := result[binding.key]; exists {
			continue
		}
		value, err := s.readVerifiedFilmShotMedia(ctx, tenantID, document, binding.shot, binding.stage, maxFilmRenderBytes-total)
		if err != nil {
			return nil, err
		}
		total += int64(len(value.Data))
		if total > maxFilmRenderBytes {
			return nil, errors.New("film media bytes exceed the delivery limit")
		}
		result[binding.key] = value
	}
	for _, asset := range document.Assets {
		if asset.MediaStorageKey == "" {
			continue
		}
		if _, exists := result[asset.MediaStorageKey]; exists {
			continue
		}
		value, err := s.readTenantBlob(ctx, tenantID, asset.MediaStorageKey, maxFilmRenderBytes-total)
		if err != nil || verifyFilmBlob(value, "", asset.MediaMIMEType, asset.MediaSHA256, asset.MediaObjectVersion, 0) != nil {
			return nil, errors.New("film asset media is unavailable or failed integrity verification")
		}
		total += int64(len(value.Data))
		if total > maxFilmRenderBytes {
			return nil, errors.New("film media bytes exceed the delivery limit")
		}
		result[asset.MediaStorageKey] = value
	}
	return result, nil
}

func addFilmZipEntry(writer *zip.Writer, name string, data []byte) error {
	if !safeFilmZipName(name) || strings.HasSuffix(name, "/") {
		return errors.New("unsafe asset bundle path")
	}
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(0o600)
	header.Modified = time.Unix(0, 0).UTC()
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

func (s *Server) buildFilmAssetBundle(ctx context.Context, tenantID string, document filmDocument) ([]byte, error) {
	manifest, err := filmManifest(document)
	if err != nil {
		return nil, err
	}
	shots, err := filmShotsCSV(document)
	if err != nil {
		return nil, err
	}
	media, err := s.authorizedFilmMedia(ctx, tenantID, document)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(media))
	for key := range media {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	inventory := make([]map[string]any, 0, len(keys))
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	entries := []struct {
		name string
		data []byte
	}{
		{"script/manuscript.txt", []byte(document.Source.Text)},
		{"tables/shots.csv", shots},
		{"manifest.json", manifest},
	}
	for _, entry := range entries {
		if err := addFilmZipEntry(writer, entry.name, entry.data); err != nil {
			_ = writer.Close()
			return nil, err
		}
	}
	for index, key := range keys {
		value := media[key]
		name := fmt.Sprintf("media/media-%04d%s", index+1, filmMediaExtension(value.Metadata.ContentType))
		if err := addFilmZipEntry(writer, name, value.Data); err != nil {
			_ = writer.Close()
			return nil, err
		}
		inventory = append(inventory, map[string]any{"storageKey": key, "path": name, "mimeType": value.Metadata.ContentType, "bytes": len(value.Data)})
	}
	inventoryBytes, _ := json.MarshalIndent(map[string]any{"version": 1, "items": inventory}, "", "  ")
	if err := addFilmZipEntry(writer, "media/inventory.json", inventoryBytes); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if output.Len() == 0 || int64(output.Len()) > maxFilmRenderBytes {
		return nil, errors.New("asset bundle exceeds its limit")
	}
	return output.Bytes(), nil
}

func filmClipStorageKey(document filmDocument, trackKind string, clip filmTimelineClip) string {
	if strings.HasPrefix(clip.Source, "dialogue:") && trackKind == "dialogue" {
		id := strings.TrimPrefix(clip.Source, "dialogue:")
		for _, dialogue := range document.Dialogues {
			if dialogue.ID == id {
				return dialogue.AudioStorageKey
			}
		}
	}
	if strings.HasPrefix(clip.Source, "shot:") {
		id := strings.TrimPrefix(clip.Source, "shot:")
		for _, shot := range document.Shots {
			if shot.ID != id {
				continue
			}
			if trackKind == "video" {
				return shot.VideoStorageKey
			}
			return shot.AudioStorageKey
		}
	}
	return clip.Source
}

func (s *Server) renderFilmMP4(ctx context.Context, tenantID string, document filmDocument, ffmpegPath string) ([]byte, error) {
	release, err := s.acquireFilmRender(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer release()
	media, err := s.authorizedFilmMedia(ctx, tenantID, document)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(s.dataDir, "film-render")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, errFilmFFmpegFailed
	}
	temporary, err := os.MkdirTemp(root, "timeline-")
	if err != nil {
		return nil, errFilmFFmpegFailed
	}
	defer os.RemoveAll(temporary)
	timeline := document.Timeline
	probePath := resolveFilmFFprobePath(ffmpegPath)
	if !validFilmExecutable(probePath) {
		return nil, errFilmFFmpegUnavailable
	}
	inputNumber := 0
	for trackIndex := range timeline.Tracks {
		track := &timeline.Tracks[trackIndex]
		if track.Kind == "subtitle" {
			continue
		}
		for clipIndex := range track.Clips {
			clip := &track.Clips[clipIndex]
			key := filmClipStorageKey(document, track.Kind, *clip)
			value, ok := media[key]
			if !ok {
				return nil, errors.New("timeline media is not authorized by a successful tenant generation job")
			}
			expected := "audio/"
			if track.Kind == "video" {
				expected = "video/"
			}
			if !strings.HasPrefix(value.Metadata.ContentType, expected) {
				return nil, errors.New("timeline media type does not match its track")
			}
			path := filepath.Join(temporary, fmt.Sprintf("input-%04d%s", inputNumber, filmMediaExtension(value.Metadata.ContentType)))
			if err := os.WriteFile(path, value.Data, 0o600); err != nil {
				return nil, errFilmFFmpegFailed
			}
			kind := "audio"
			if track.Kind == "video" {
				kind = "video"
			}
			probeDuration := clip.TrimIn + (clip.End - clip.Start - clip.TrimOut)
			if err := s.probeFilmInput(ctx, probePath, path, kind, probeDuration); err != nil {
				return nil, err
			}
			clip.Source = path
			inputNumber++
		}
	}
	subtitlePath := ""
	if content := buildFilmSRT(timeline); content != "" {
		subtitlePath = filepath.Join(temporary, "subtitles.srt")
		if err := os.WriteFile(subtitlePath, []byte(content), 0o600); err != nil {
			return nil, errFilmFFmpegFailed
		}
	}
	output := filepath.Join(temporary, "output.mp4")
	args, err := buildFilmFFmpegArgumentsWithSubtitle(timeline, output, subtitlePath)
	if err != nil {
		return nil, err
	}
	commandCtx, cancel := context.WithTimeout(ctx, filmRenderTimeout())
	defer cancel()
	if err := s.filmCommandRunner.Run(commandCtx, ffmpegPath, args); err != nil {
		if commandCtx.Err() != nil {
			return nil, commandCtx.Err()
		}
		return nil, errFilmFFmpegFailed
	}
	file, err := os.Open(output)
	if err != nil {
		return nil, errFilmFFmpegFailed
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxFilmRenderBytes+1))
	if err != nil || len(data) == 0 || int64(len(data)) > maxFilmRenderBytes {
		return nil, errFilmFFmpegFailed
	}
	return data, nil
}

func filmDeliverableSpec(kind string) (string, string, string, bool) {
	switch kind {
	case "manifest":
		return "Production manifest", "application/json", ".json", true
	case "srt":
		return "Subtitles", "application/x-subrip", ".srt", true
	case "asset_bundle":
		return "Asset bundle", "application/zip", ".zip", true
	case "mp4":
		return "Timeline master", "video/mp4", ".mp4", true
	default:
		return "", "", "", false
	}
}

func (s *Server) exportFilmBytes(ctx context.Context, tenantID string, document filmDocument, kind string) ([]byte, error) {
	switch kind {
	case "manifest":
		return filmManifest(document)
	case "srt":
		value := buildFilmSRT(document.Timeline)
		if value == "" {
			return nil, errors.New("timeline has no subtitle clips")
		}
		return []byte(value), nil
	case "asset_bundle":
		return s.buildFilmAssetBundle(ctx, tenantID, document)
	case "mp4":
		path, available, _ := s.filmFFmpegCapability(ctx)
		if !available {
			return nil, errFilmFFmpegUnavailable
		}
		return s.renderFilmMP4(ctx, tenantID, document, path)
	default:
		return nil, errors.New("export kind is unsupported")
	}
}

func (s *Server) createStoredFilmDeliverable(w http.ResponseWriter, r *http.Request, input filmExportRequest) {
	backend, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	requestHash, _ := hashGenerationInput(input)
	if s.reconcileMissingFilmExportJobs(r.Context(), tenantIDFrom(r), document) {
		refreshed, refreshErr := backend.GetFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID)
		if refreshErr != nil {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be reloaded")
			return
		}
		document, refreshErr = decodeFilmDocument(refreshed.Document)
		if refreshErr != nil {
			writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production is invalid")
			return
		}
		record = refreshed
	}
	for _, deliverable := range document.Deliverables {
		if deliverable.IdempotencyKey != input.IdempotencyKey {
			continue
		}
		if deliverable.RequestHash != requestHash {
			writeFilmError(w, http.StatusConflict, "idempotency_conflict", "idempotency key belongs to a different export request")
			return
		}
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
		return
	}
	if input.Revision != document.Revision {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "export revision conflict")
		return
	}
	if len(document.Deliverables) >= 100 {
		writeFilmError(w, http.StatusUnprocessableEntity, "deliverable_limit", "film deliverable retention limit reached")
		return
	}
	title, mimeType, _, supported := filmDeliverableSpec(input.Kind)
	if !supported {
		writeFilmError(w, http.StatusUnprocessableEntity, "export_kind_invalid", "Export kind must be mp4, srt, manifest, or asset_bundle")
		return
	}
	if input.Kind == "mp4" {
		if _, available, _ := s.filmFFmpegCapability(r.Context()); !available {
			writeFilmError(w, http.StatusServiceUnavailable, "ffmpeg_unavailable", errFilmFFmpegUnavailable.Error())
			return
		}
	}
	deliverableID := stableFilmID("deliverable", document.ProjectID, input.IdempotencyKey)
	jobID := stableFilmID("export-job", document.ProjectID, input.IdempotencyKey)
	snapshot, err := json.Marshal(document)
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_export_snapshot_error", "Film export snapshot could not be created")
		return
	}
	parameters, err := json.Marshal(filmExportJobParameters{
		Executor: filmExportExecutorMarker, ProjectID: document.ProjectID, Kind: input.Kind,
		IdempotencyKey: input.IdempotencyKey, RequestHash: requestHash, UserID: userIDFrom(r), Snapshot: snapshot,
	})
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_export_snapshot_error", "Film export snapshot could not be created")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	deliverable := filmDeliverable{ID: deliverableID, Revision: 1, Kind: input.Kind, Status: filmStatusRunning, Title: title, MIMEType: mimeType, CreatedAt: now, IdempotencyKey: input.IdempotencyKey, RequestHash: requestHash, GenerationJobID: jobID, Provenance: "generation-job:" + jobID}
	next := cloneFilmDocument(document)
	next.Deliverables = append(next.Deliverables, deliverable)
	next.Revision++
	next.UpdatedAt = now
	if err := validateFilmAggregateLimits(next); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, _ := json.Marshal(next)
	updated, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw)
	if errors.Is(err, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; retry with the same idempotency key")
		return
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be saved")
		return
	}
	job := store.GenerationJob{ID: jobID, ProjectID: document.ProjectID, Kind: "export", Status: "queued", Prompt: "film export " + input.Kind, Parameters: parameters, Result: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now}
	usageMeta, _ := json.Marshal(map[string]any{"jobId": jobID, "kind": "export", "executor": filmExportExecutorMarker, "filmProjectId": document.ProjectID, "exportKind": input.Kind})
	if err := s.store.CreateServerGenerationJob(r.Context(), tenantIDFrom(r), userIDFrom(r), job, 0, usageMeta); err != nil {
		s.updateFilmExportDeliverable(r.Context(), tenantIDFrom(r), document.ProjectID, deliverableID, jobID, func(item filmDeliverable) filmDeliverable {
			item.Status, item.Diagnostic, item.Revision = filmStatusFailed, "导出任务无法入队", item.Revision+1
			return item
		})
		writeFilmError(w, http.StatusInternalServerError, "film_export_queue_error", "Film export task could not be queued")
		return
	}
	s.notifyFilmExportWorkers()
	s.writeFilmDocument(w, r, http.StatusCreated, updated, next)
}

func (s *Server) downloadStoredFilmDeliverable(w http.ResponseWriter, r *http.Request, deliverable filmDeliverable) bool {
	if deliverable.StorageKey == "" {
		return false
	}
	value, err := s.readTenantBlob(r.Context(), tenantIDFrom(r), deliverable.StorageKey, maxFilmRenderBytes)
	if err != nil || verifyFilmBlob(value, "", deliverable.MIMEType, deliverable.SHA256, deliverable.ObjectVersion, deliverable.Bytes) != nil || !strings.HasPrefix(deliverable.StorageKey, "film:deliverable:") {
		return false
	}
	_, _, extension, _ := filmDeliverableSpec(deliverable.Kind)
	w.Header().Set("Content-Type", deliverable.MIMEType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+deliverable.ID+extension+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(value.Data)
	return true
}
