package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxFilmRequestBytes    = 2 << 20
	maxFilmSourceBytes     = 1 << 20
	maxFilmEntities        = 10_000
	maxFilmQualityIssues   = 10_000
	maxFilmRepairProposals = 5_000
)

type filmRevisionRequest struct {
	Revision int `json:"revision"`
}

type filmSourceRequest struct {
	Revision     int    `json:"revision"`
	Text         string `json:"text"`
	Format       string `json:"format,omitempty"`
	OriginalName string `json:"originalName,omitempty"`
}

type filmRepairApplyRequest struct {
	Revision int  `json:"revision"`
	Approved bool `json:"approved"`
}

type filmProjectionCommitRequest struct {
	ProjectionKey    string         `json:"projectionKey"`
	ExpectedRevision int            `json:"expectedRevision"`
	Fields           map[string]any `json:"fields"`
}

type filmRestoreRequest struct {
	Revision int          `json:"revision"`
	Document filmDocument `json:"document"`
}

func mountFilmRoutes(r chi.Router, server *Server) {
	r.Get("/film/capabilities", server.getFilmCapabilities)
	r.Route("/film/projects/{projectId}", func(r chi.Router) {
		r.Get("/status", server.getFilmStatus)
		r.Put("/source/text", server.putFilmSource)
		r.Post("/source/import", server.putFilmSource)
		r.Post("/episodes", server.createFilmEpisode)
		r.Put("/episodes/{entityId}", server.updateFilmEpisode)
		r.Delete("/episodes/{entityId}", server.deleteFilmEpisode)
		r.Post("/scenes", server.createFilmScene)
		r.Put("/scenes/{entityId}", server.updateFilmScene)
		r.Delete("/scenes/{entityId}", server.deleteFilmScene)
		r.Post("/shots", server.createFilmShot)
		r.Put("/shots/{entityId}", server.updateFilmShot)
		r.Delete("/shots/{entityId}", server.deleteFilmShot)
		r.Post("/assets", server.createFilmAsset)
		r.Put("/assets/{entityId}", server.updateFilmAsset)
		r.Delete("/assets/{entityId}", server.deleteFilmAsset)
		r.Post("/stages/{stageId}/run", server.runFilmStage)
		r.Post("/stages/{stageId}/approve", server.approveFilmStage)
		r.Post("/stages/{stageId}/reject", server.rejectFilmStage)
		r.Post("/validate", server.validateFilmProduction)
		r.Post("/repairs/{repairId}/apply", server.applyFilmRepairProposal)
		r.Get("/projection/refresh", server.refreshFilmProjectionPlan)
		r.Post("/projection/commit", server.commitFilmProjectionEntity)
		r.Get("/timeline", server.getFilmTimeline)
		r.Put("/timeline", server.putFilmTimeline)
		r.Post("/exports", server.createFilmExport)
		r.Get("/deliverables", server.listFilmDeliverables)
		r.Get("/deliverables/{deliverableId}/download", server.downloadFilmDeliverable)
		r.Put("/restore", server.restoreFilmProduction)
	})
	r.Get("/film/projects/{projectId}", server.getFilmProduction)
	r.Post("/film/projects/{projectId}", server.createFilmProduction)
}

func (s *Server) getFilmCapabilities(w http.ResponseWriter, _ *http.Request) {
	_, storageAvailable := s.store.(store.FilmStore)
	available := filmModeEnabled() && storageAvailable
	reason := ""
	if !filmModeEnabled() {
		reason = "Film Production Mode is disabled"
	} else if !storageAvailable {
		reason = "Durable film storage is unavailable"
	}
	writeJSON(w, map[string]any{"data": map[string]any{
		"available":     available,
		"reason":        reason,
		"mp4Export":     false,
		"mp4Diagnostic": "MP4 export is disabled until a bounded multitrack renderer is available",
	}})
}

func filmModeEnabled() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("OPENBOARD_FILM_MODE")), "false")
}

func (s *Server) filmStore(w http.ResponseWriter) (store.FilmStore, bool) {
	if !filmModeEnabled() {
		writeFilmError(w, http.StatusServiceUnavailable, "film_mode_disabled", "Film Production Mode is disabled")
		return nil, false
	}
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		writeFilmError(w, http.StatusServiceUnavailable, "film_storage_unavailable", "Durable film storage is unavailable")
		return nil, false
	}
	return backend, true
}

func writeFilmError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(w, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func writeFilmDocument(w http.ResponseWriter, status int, record store.FilmRecord, document filmDocument) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", record.Revision))
	w.WriteHeader(status)
	writeJSON(w, map[string]any{
		"data": document,
		"meta": map[string]any{"recordRevision": record.Revision, "updatedAt": record.UpdatedAt},
	})
}

func decodeFilmRequest(w http.ResponseWriter, r *http.Request, limit int64, destination any) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("request body is invalid or exceeds its limit")
	}
	return nil
}

func (s *Server) requireFilmBoardProject(r *http.Request) error {
	projectID := chi.URLParam(r, "projectId")
	if !validProjectID(projectID) {
		return &toolError{status: http.StatusBadRequest, message: "invalid project id"}
	}
	if s.store == nil {
		return &toolError{status: http.StatusServiceUnavailable, message: "durable project storage is unavailable"}
	}
	raw, err := s.store.GetProject(r.Context(), tenantIDFrom(r), projectID)
	if errors.Is(err, store.ErrNotFound) {
		return &toolError{status: http.StatusNotFound, message: "project not found"}
	}
	if err != nil {
		return err
	}
	var project map[string]any
	if json.Unmarshal(raw, &project) != nil || project["projectKind"] != "film" {
		return &toolError{status: http.StatusConflict, message: "project is not a film project"}
	}
	return nil
}

func (s *Server) loadFilmProduction(w http.ResponseWriter, r *http.Request, create bool) (store.FilmStore, store.FilmRecord, filmDocument, bool) {
	backend, ok := s.filmStore(w)
	if !ok {
		return nil, store.FilmRecord{}, filmDocument{}, false
	}
	if err := s.requireFilmBoardProject(r); err != nil {
		writeFilmOperationError(w, err)
		return nil, store.FilmRecord{}, filmDocument{}, false
	}
	projectID := chi.URLParam(r, "projectId")
	record, err := backend.GetFilmProject(r.Context(), tenantIDFrom(r), projectID)
	if errors.Is(err, store.ErrNotFound) && create {
		document := newFilmDocument(projectID)
		raw, marshalErr := json.Marshal(document)
		if marshalErr != nil {
			writeFilmError(w, http.StatusInternalServerError, "internal_error", "Film document could not be created")
			return nil, store.FilmRecord{}, filmDocument{}, false
		}
		record, err = backend.CreateFilmProject(r.Context(), tenantIDFrom(r), projectID, raw)
		if errors.Is(err, store.ErrConflict) {
			record, err = backend.GetFilmProject(r.Context(), tenantIDFrom(r), projectID)
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "film_not_found", "Film production has not been created")
		return nil, store.FilmRecord{}, filmDocument{}, false
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be loaded")
		return nil, store.FilmRecord{}, filmDocument{}, false
	}
	document, err := decodeFilmDocument(record.Document)
	if err != nil || document.SchemaVersion != 1 || document.ProjectID != projectID {
		writeFilmError(w, http.StatusInternalServerError, "film_document_invalid", "Stored film production is invalid")
		return nil, store.FilmRecord{}, filmDocument{}, false
	}
	return backend, record, document, true
}

func (s *Server) mutateFilmProduction(
	w http.ResponseWriter,
	r *http.Request,
	mutate func(filmDocument) (filmDocument, error),
) (store.FilmRecord, filmDocument, bool) {
	backend, record, document, ok := s.loadFilmProduction(w, r, true)
	if !ok {
		return store.FilmRecord{}, filmDocument{}, false
	}
	next, err := mutate(cloneFilmDocument(document))
	if err != nil {
		writeFilmOperationError(w, err)
		return store.FilmRecord{}, filmDocument{}, false
	}
	next.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if next.Revision <= document.Revision {
		next.Revision = document.Revision + 1
	}
	if err := validateFilmAggregateLimits(next); err != nil {
		writeFilmOperationError(w, err)
		return store.FilmRecord{}, filmDocument{}, false
	}
	raw, err := json.Marshal(next)
	if err != nil || len(raw) > maxProjectBytes {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return store.FilmRecord{}, filmDocument{}, false
	}
	updated, err := backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), record.ProjectID, record.Revision, raw)
	if errors.Is(err, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		return store.FilmRecord{}, filmDocument{}, false
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be saved")
		return store.FilmRecord{}, filmDocument{}, false
	}
	return updated, next, true
}

func writeFilmOperationError(w http.ResponseWriter, err error) {
	var typed *toolError
	if errors.As(err, &typed) {
		writeFilmError(w, typed.status, "film_request_rejected", typed.message)
		return
	}
	message := err.Error()
	status, code := http.StatusUnprocessableEntity, "film_validation_error"
	if strings.Contains(message, "revision conflict") {
		status, code = http.StatusConflict, "revision_conflict"
	} else if strings.Contains(message, "requires ") || strings.Contains(message, "current state") || strings.Contains(message, "review-ready") {
		status, code = http.StatusConflict, "stage_state_conflict"
	}
	writeFilmError(w, status, code, message)
}

func (s *Server) getFilmProduction(w http.ResponseWriter, r *http.Request) {
	_, record, document, ok := s.loadFilmProduction(w, r, false)
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func (s *Server) createFilmProduction(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	_, record, document, ok := s.loadFilmProduction(w, r, true)
	if ok {
		writeFilmDocument(w, http.StatusCreated, record, document)
	}
}

func (s *Server) getFilmStatus(w http.ResponseWriter, r *http.Request) {
	_, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", record.Revision))
	writeJSON(w, map[string]any{
		"data": document,
		"meta": map[string]any{"recordRevision": record.Revision, "updatedAt": record.UpdatedAt},
		"capabilities": map[string]any{
			"plainTextImport": true, "markdownImport": true, "docxImport": false, "pdfImport": false,
			"mp4Export":     false,
			"mp4Diagnostic": "MP4 export is disabled until a bounded multitrack renderer is available",
		},
	})
}

func (s *Server) putFilmSource(w http.ResponseWriter, r *http.Request) {
	var input filmSourceRequest
	if err := decodeFilmRequest(w, r, maxFilmSourceBytes+4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	format := strings.ToLower(strings.TrimSpace(input.Format))
	if format == "" {
		format = "text"
	}
	if format == "md" {
		format = "markdown"
	}
	if format == "docx" || format == "pdf" {
		writeFilmError(w, http.StatusUnsupportedMediaType, "unsupported_import_format", strings.ToUpper(format)+" extraction is not available; import TXT or Markdown")
		return
	}
	if format != "text" && format != "txt" && format != "markdown" {
		writeFilmError(w, http.StatusUnsupportedMediaType, "unsupported_import_format", "Only TXT and Markdown manuscript imports are supported")
		return
	}
	if len(input.Text) == 0 || len(input.Text) > maxFilmSourceBytes || len(input.OriginalName) > 255 {
		writeFilmError(w, http.StatusUnprocessableEntity, "source_invalid", "Manuscript text must contain 1 byte to 1 MiB")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if document.Source.Revision != input.Revision {
			return filmDocument{}, errors.New("source revision conflict")
		}
		document.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		document.Source.Format = format
		document.Source.OriginalName = strings.TrimSpace(input.OriginalName)
		return decomposeFilmSource(document, input.Text)
	})
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func (s *Server) changeFilmStage(w http.ResponseWriter, r *http.Request, action string) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		return updateFilmStage(document, chi.URLParam(r, "stageId"), action, input.Revision, time.Now().UTC().Format(time.RFC3339Nano))
	})
	if ok {
		status := http.StatusOK
		if action == "run" {
			status = http.StatusAccepted
		}
		writeFilmDocument(w, status, record, document)
	}
}

func (s *Server) runFilmStage(w http.ResponseWriter, r *http.Request) { s.changeFilmStage(w, r, "run") }
func (s *Server) approveFilmStage(w http.ResponseWriter, r *http.Request) {
	s.changeFilmStage(w, r, "approve")
}
func (s *Server) rejectFilmStage(w http.ResponseWriter, r *http.Request) {
	s.changeFilmStage(w, r, "reject")
}

func (s *Server) validateFilmProduction(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		report, err := validateFilmDocument(document)
		if err != nil {
			return filmDocument{}, err
		}
		document.QualityReports = append(document.QualityReports, report)
		if len(document.QualityReports) > 20 {
			document.QualityReports = document.QualityReports[len(document.QualityReports)-20:]
		}
		return document, nil
	})
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func (s *Server) applyFilmRepairProposal(w http.ResponseWriter, r *http.Request) {
	var input filmRepairApplyRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !input.Approved {
		writeFilmError(w, http.StatusUnprocessableEntity, "repair_not_approved", "Repair must be explicitly approved")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		repairID := chi.URLParam(r, "repairId")
		for reportIndex := range document.QualityReports {
			for repairIndex := range document.QualityReports[reportIndex].Repairs {
				repair := &document.QualityReports[reportIndex].Repairs[repairIndex]
				if repair.ID == repairID {
					if repair.ExpectedRevision != input.Revision {
						return filmDocument{}, errors.New("repair revision conflict")
					}
					repair.Approved = true
				}
			}
		}
		return applyFilmRepair(document, repairID)
	})
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func filmProjectionTargets(document filmDocument) []map[string]any {
	targets := make([]map[string]any, 0, len(document.Episodes)+len(document.Scenes)+len(document.Shots))
	for _, episode := range document.Episodes {
		targets = append(targets, map[string]any{"projectionKey": "episode:" + episode.ID, "revision": episode.Revision, "type": "group", "title": episode.Title, "content": episode.Synopsis})
	}
	for _, scene := range document.Scenes {
		targets = append(targets, map[string]any{"projectionKey": "scene:" + scene.ID, "revision": scene.Revision, "type": "text", "title": scene.Heading, "content": scene.Synopsis})
	}
	for _, shot := range document.Shots {
		targets = append(targets, map[string]any{"projectionKey": "shot:" + shot.ID, "revision": shot.Revision, "type": "text", "title": shot.Title, "content": shot.Description})
	}
	return targets
}

func (s *Server) refreshFilmProjectionPlan(w http.ResponseWriter, r *http.Request) {
	_, record, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	writeJSON(w, map[string]any{"data": map[string]any{
		"projectId": document.ProjectID, "recordRevision": record.Revision,
		"projectionRevision": document.ProjectionRevision, "targets": filmProjectionTargets(document),
	}})
}

func applyFilmProjectionCommit(document filmDocument, input filmProjectionCommitRequest) (filmDocument, error) {
	kind, id, found := strings.Cut(input.ProjectionKey, ":")
	if !found || !validProjectID(id) || (kind != "episode" && kind != "scene" && kind != "shot") {
		return filmDocument{}, errors.New("invalid projection key")
	}
	if len(input.Fields) == 0 || len(input.Fields) > 2 {
		return filmDocument{}, errors.New("projection fields must contain title and/or content")
	}
	title, hasTitle := input.Fields["title"].(string)
	content, hasContent := input.Fields["content"].(string)
	for field := range input.Fields {
		if field != "title" && field != "content" {
			return filmDocument{}, errors.New("projection field is unsupported")
		}
	}
	if !hasTitle && !hasContent || len(title) > 500 || len(content) > 100_000 {
		return filmDocument{}, errors.New("projection fields are invalid")
	}
	updated := false
	if kind == "episode" {
		for index, entity := range document.Episodes {
			if entity.ID != id {
				continue
			}
			if entity.Revision != input.ExpectedRevision {
				return filmDocument{}, errors.New("projection revision conflict")
			}
			if hasTitle {
				entity.Title = title
			}
			if hasContent {
				entity.Synopsis = content
			}
			entity.Revision++
			document.Episodes[index] = entity
			updated = true
		}
	} else if kind == "scene" {
		for index, entity := range document.Scenes {
			if entity.ID != id {
				continue
			}
			if entity.Revision != input.ExpectedRevision {
				return filmDocument{}, errors.New("projection revision conflict")
			}
			if hasTitle {
				entity.Heading = title
			}
			if hasContent {
				entity.Synopsis = content
			}
			entity.Revision++
			document.Scenes[index] = entity
			updated = true
		}
	} else {
		for index, entity := range document.Shots {
			if entity.ID != id {
				continue
			}
			if entity.Revision != input.ExpectedRevision {
				return filmDocument{}, errors.New("projection revision conflict")
			}
			if hasTitle {
				entity.Title = title
			}
			if hasContent {
				entity.Description = content
			}
			entity.Revision++
			document.Shots[index] = entity
			updated = true
		}
	}
	if !updated {
		return filmDocument{}, errors.New("projection target not found")
	}
	document.ProjectionRevision++
	return invalidateFilmStages(document, "script", document.UpdatedAt), nil
}

func (s *Server) commitFilmProjectionEntity(w http.ResponseWriter, r *http.Request) {
	var input filmProjectionCommitRequest
	if err := decodeFilmRequest(w, r, 128<<10, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		return applyFilmProjectionCommit(document, input)
	})
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func (s *Server) getFilmTimeline(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if ok {
		writeJSON(w, map[string]any{"data": document.Timeline})
	}
}

func (s *Server) putFilmTimeline(w http.ResponseWriter, r *http.Request) {
	var input filmTimeline
	if err := decodeFilmRequest(w, r, maxFilmRequestBytes, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := validateFilmTimeline(input); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if input.Revision != document.Timeline.Revision {
			return filmDocument{}, errors.New("timeline revision conflict")
		}
		input.Revision++
		document.Timeline = input
		return invalidateFilmStages(document, "compose", document.UpdatedAt), nil
	})
	if ok {
		writeFilmDocument(w, http.StatusOK, record, document)
	}
}

func (s *Server) createFilmExport(w http.ResponseWriter, r *http.Request) {
	var input filmExportRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	if input.Kind == "mp4" {
		writeFilmError(w, http.StatusNotImplemented, "mp4_export_disabled", "MP4 export is disabled until a bounded multitrack renderer is available")
		return
	}
	if input.Kind != "manifest" && input.Kind != "srt" {
		writeFilmError(w, http.StatusUnprocessableEntity, "export_kind_invalid", "Export kind must be manifest or srt")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if input.Revision != document.Revision {
			return filmDocument{}, errors.New("export revision conflict")
		}
		createdAt := time.Now().UTC().Format(time.RFC3339Nano)
		deliverable := filmDeliverable{ID: stableFilmID("deliverable", document.ProjectID, input.Kind, document.Revision), Revision: 1, Status: filmStatusApproved, CreatedAt: createdAt}
		switch input.Kind {
		case "manifest":
			raw, err := json.MarshalIndent(map[string]any{"version": 1, "projectId": document.ProjectID, "episodes": document.Episodes, "scenes": document.Scenes, "shots": document.Shots, "assets": document.Assets}, "", "  ")
			if err != nil {
				return filmDocument{}, err
			}
			deliverable.Kind, deliverable.Title, deliverable.MIMEType = "manifest", "Production manifest", "application/json"
			deliverable.Content, deliverable.Bytes = string(raw), int64(len(raw))
		case "srt":
			content := buildFilmSRT(document.Timeline)
			if content == "" {
				return filmDocument{}, errors.New("timeline has no subtitle clips")
			}
			deliverable.Kind, deliverable.Title, deliverable.MIMEType = "srt", "Subtitles", "application/x-subrip"
			deliverable.Content, deliverable.Bytes = content, int64(len(content))
		}
		document.Deliverables = append(document.Deliverables, deliverable)
		if len(document.Deliverables) > 100 {
			document.Deliverables = document.Deliverables[len(document.Deliverables)-100:]
		}
		return invalidateFilmStages(document, "delivery", document.UpdatedAt), nil
	})
	if ok {
		writeFilmDocument(w, http.StatusCreated, record, document)
	}
}

func buildFilmSRT(timeline filmTimeline) string {
	var clips []filmTimelineClip
	for _, track := range timeline.Tracks {
		if track.Kind == "subtitle" {
			clips = append(clips, track.Clips...)
		}
	}
	var output strings.Builder
	for index, clip := range clips {
		if strings.TrimSpace(clip.Text) == "" {
			continue
		}
		fmt.Fprintf(&output, "%d\n%s --> %s\n%s\n\n", index+1, filmSRTTime(clip.Start), filmSRTTime(clip.End), strings.ReplaceAll(strings.TrimSpace(clip.Text), "\x00", ""))
	}
	return output.String()
}

func filmSRTTime(seconds float64) string {
	milliseconds := int64(seconds * 1000)
	hours := milliseconds / 3_600_000
	milliseconds %= 3_600_000
	minutes := milliseconds / 60_000
	milliseconds %= 60_000
	wholeSeconds := milliseconds / 1000
	milliseconds %= 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", hours, minutes, wholeSeconds, milliseconds)
}

func (s *Server) listFilmDeliverables(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if ok {
		writeJSON(w, map[string]any{"data": document.Deliverables})
	}
}

func (s *Server) downloadFilmDeliverable(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	id := chi.URLParam(r, "deliverableId")
	for _, deliverable := range document.Deliverables {
		if deliverable.ID != id {
			continue
		}
		if deliverable.Content == "" || deliverable.Bytes <= 0 || (deliverable.Kind != "manifest" && deliverable.Kind != "srt") {
			writeFilmError(w, http.StatusNotFound, "deliverable_unavailable", "Deliverable bytes are unavailable")
			return
		}
		extension := ".json"
		if deliverable.Kind == "srt" {
			extension = ".srt"
		}
		w.Header().Set("Content-Type", deliverable.MIMEType)
		w.Header().Set("Content-Disposition", `attachment; filename="`+deliverable.ID+extension+`"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write([]byte(deliverable.Content))
		return
	}
	writeFilmError(w, http.StatusNotFound, "deliverable_not_found", "Deliverable not found")
}

func validateFilmRestoreDocument(document filmDocument, projectID string) error {
	return validateFilmAggregate(document, projectID)
}

func (s *Server) restoreFilmProduction(w http.ResponseWriter, r *http.Request) {
	var input filmRestoreRequest
	if err := decodeFilmRequest(w, r, maxProjectBytes+4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Revision < 0 {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_validation_error", "Film restore revision is invalid")
		return
	}
	backend, ok := s.filmStore(w)
	if !ok {
		return
	}
	if err := s.requireFilmBoardProject(r); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	projectID := chi.URLParam(r, "projectId")
	if err := validateFilmRestoreDocument(input.Document, projectID); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, err := json.Marshal(input.Document)
	if err != nil || len(raw) > maxProjectBytes {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	var record store.FilmRecord
	if input.Revision == 0 {
		record, err = backend.CreateFilmProject(r.Context(), tenantIDFrom(r), projectID, raw)
	} else {
		record, err = backend.CompareAndSwapFilmProject(r.Context(), tenantIDFrom(r), projectID, input.Revision, raw)
	}
	if errors.Is(err, store.ErrConflict) {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		writeFilmError(w, http.StatusNotFound, "film_not_found", "Film production has not been created")
		return
	}
	if err != nil {
		writeFilmError(w, http.StatusInternalServerError, "film_storage_error", "Film production could not be restored")
		return
	}
	writeFilmDocument(w, http.StatusOK, record, input.Document)
}

func decodeFilmMap(raw []byte) (map[string]any, error) {
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || ensureJSONEOF(decoder) != nil {
		return nil, errors.New("invalid JSON")
	}
	return value, nil
}

func filmInteger(value any, name string, minimum, maximum int) (int, error) {
	number, ok := value.(float64)
	integer := int(number)
	if !ok || number != float64(integer) || integer < minimum || integer > maximum {
		return 0, fmt.Errorf("%s is invalid", name)
	}
	return integer, nil
}

func filmNumber(value any, name string, minimum, maximum float64) (float64, error) {
	number, ok := value.(float64)
	if !ok || number < minimum || number > maximum {
		return 0, fmt.Errorf("%s is invalid", name)
	}
	return number, nil
}

func filmString(value any, name string, maximum int, required bool) (string, error) {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	if !ok || len(text) > maximum || (required && text == "") {
		return "", fmt.Errorf("%s is invalid", name)
	}
	return text, nil
}

func filmOptionalRevision(r *http.Request) int {
	revision, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("revision")))
	return revision
}
