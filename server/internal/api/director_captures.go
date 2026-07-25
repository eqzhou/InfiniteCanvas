package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	directorCaptureStateKey       = "director-captures-v1"
	maxDirectorCaptureBytes       = 32 << 20
	maxDirectorCapturePixels      = 4096 * 4096
	maxDirectorCaptureTotalPixels = 40_000_000
	maxDirectorCapturesPerScene   = 100
	maxDirectorCapturesPerTenant  = 300
	directorCaptureOrphanGrace    = 24 * time.Hour
)

var errDirectorCaptureLimit = errors.New("director capture storage limit reached")

type directorCaptureRecord struct {
	ID             string `json:"id"`
	ProjectID      string `json:"projectId"`
	DirectorNodeID string `json:"directorNodeId"`
	CameraID       string `json:"cameraId"`
	CameraName     string `json:"cameraName"`
	CreatedAt      string `json:"createdAt"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	Bytes          int    `json:"bytes"`
	MIMEType       string `json:"mimeType"`
	StorageKey     string `json:"storageKey"`
	OrphanedAt     string `json:"orphanedAt,omitempty"`
}

type directorCaptureResponse struct {
	ID             string `json:"id"`
	ProjectID      string `json:"projectId"`
	DirectorNodeID string `json:"directorNodeId"`
	CameraID       string `json:"cameraId"`
	CameraName     string `json:"cameraName"`
	CreatedAt      string `json:"createdAt"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	Bytes          int    `json:"bytes"`
	MIMEType       string `json:"mimeType"`
	URL            string `json:"url"`
}

type directorCaptureDocument struct {
	Version int                     `json:"version"`
	Items   []directorCaptureRecord `json:"items"`
}

func captureResponse(value directorCaptureRecord) directorCaptureResponse {
	return directorCaptureResponse{
		ID: value.ID, ProjectID: value.ProjectID, DirectorNodeID: value.DirectorNodeID,
		CameraID: value.CameraID, CameraName: value.CameraName, CreatedAt: value.CreatedAt,
		Width: value.Width, Height: value.Height, Bytes: value.Bytes, MIMEType: value.MIMEType,
		URL: "/api/blobs/" + url.PathEscape(value.StorageKey),
	}
}

func parseDirectorCaptureDocument(value []byte) (directorCaptureDocument, error) {
	if value == nil {
		return directorCaptureDocument{Version: 1, Items: []directorCaptureRecord{}}, nil
	}
	var document directorCaptureDocument
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || document.Version != 1 || len(document.Items) > maxDirectorCapturesPerTenant {
		return directorCaptureDocument{}, errors.New("invalid director capture metadata")
	}
	seen := make(map[string]struct{}, len(document.Items))
	for _, item := range document.Items {
		if !validDirectorCaptureRecord(item) {
			return directorCaptureDocument{}, errors.New("invalid director capture metadata")
		}
		if _, exists := seen[item.ID]; exists {
			return directorCaptureDocument{}, errors.New("duplicate director capture")
		}
		seen[item.ID] = struct{}{}
	}
	return document, nil
}

func validDirectorCaptureRecord(value directorCaptureRecord) bool {
	createdAt, err := time.Parse(time.RFC3339Nano, value.CreatedAt)
	orphanValid := value.OrphanedAt == ""
	if value.OrphanedAt != "" {
		_, orphanErr := time.Parse(time.RFC3339Nano, value.OrphanedAt)
		orphanValid = orphanErr == nil
	}
	return err == nil && orphanValid && !createdAt.IsZero() && projectIDPattern.MatchString(value.ID) &&
		projectIDPattern.MatchString(value.ProjectID) && projectIDPattern.MatchString(value.DirectorNodeID) &&
		projectIDPattern.MatchString(value.CameraID) && strings.TrimSpace(value.CameraName) == value.CameraName &&
		len(value.CameraName) >= 1 && len(value.CameraName) <= 100 && value.Width >= 1 && value.Width <= 4096 &&
		value.Height >= 1 && value.Height <= 4096 && value.Bytes >= 1 && value.Bytes <= maxDirectorCaptureBytes &&
		value.MIMEType == "image/png" && value.StorageKey == "director-capture:"+value.ID
}

func (s *Server) readDirectorCaptureDocument(r *http.Request) ([]byte, directorCaptureDocument, error) {
	if s.store == nil {
		return nil, directorCaptureDocument{}, errors.New("persistent store unavailable")
	}
	raw, err := s.store.GetState(r.Context(), tenantIDFrom(r), directorCaptureStateKey)
	if errors.Is(err, store.ErrNotFound) {
		raw = nil
	} else if err != nil {
		return nil, directorCaptureDocument{}, err
	}
	document, err := parseDirectorCaptureDocument(raw)
	return raw, document, err
}

func (s *Server) mutateDirectorCaptures(r *http.Request, mutate func(directorCaptureDocument) (directorCaptureDocument, error)) error {
	for range 8 {
		raw, current, err := s.readDirectorCaptureDocument(r)
		if err != nil {
			return err
		}
		next, err := mutate(current)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return err
		}
		err = s.store.CompareAndSwapState(r.Context(), tenantIDFrom(r), directorCaptureStateKey, raw, encoded)
		if errors.Is(err, store.ErrConflict) {
			continue
		}
		return err
	}
	return store.ErrConflict
}

func parseCaptureQuery(r *http.Request) (directorCaptureRecord, error) {
	query := r.URL.Query()
	width, widthErr := strconv.Atoi(query.Get("width"))
	height, heightErr := strconv.Atoi(query.Get("height"))
	createdAt, timeErr := time.Parse(time.RFC3339Nano, query.Get("createdAt"))
	value := directorCaptureRecord{
		ProjectID: query.Get("projectId"), DirectorNodeID: query.Get("directorNodeId"),
		CameraID: query.Get("cameraId"), CameraName: strings.TrimSpace(query.Get("cameraName")),
		CreatedAt: createdAt.UTC().Format(time.RFC3339Nano), Width: width, Height: height,
		MIMEType: "image/png",
	}
	if widthErr != nil || heightErr != nil || timeErr != nil || !projectIDPattern.MatchString(value.ProjectID) ||
		!projectIDPattern.MatchString(value.DirectorNodeID) || !projectIDPattern.MatchString(value.CameraID) ||
		len(value.CameraName) < 1 || len(value.CameraName) > 100 || width < 1 || width > 4096 || height < 1 || height > 4096 {
		return directorCaptureRecord{}, errors.New("invalid director capture metadata")
	}
	return value, nil
}

func validateDirectorCapturePNG(data []byte, expectedWidth, expectedHeight int) error {
	if len(data) < 1 || len(data) > maxDirectorCaptureBytes || http.DetectContentType(data) != "image/png" {
		return errors.New("capture must be a valid PNG")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "png" || config.Width != expectedWidth || config.Height != expectedHeight ||
		config.Width < 1 || config.Height < 1 || config.Width*config.Height > maxDirectorCapturePixels {
		return errors.New("capture dimensions do not match")
	}
	if _, format, err := image.Decode(bytes.NewReader(data)); err != nil || format != "png" {
		return errors.New("capture PNG is corrupt")
	}
	return nil
}

func (s *Server) listDirectorCaptures(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	directorID := r.URL.Query().Get("directorNodeId")
	if (projectID == "") != (directorID == "") ||
		(projectID != "" && (!projectIDPattern.MatchString(projectID) || !projectIDPattern.MatchString(directorID))) {
		http.Error(w, "invalid capture scope", http.StatusBadRequest)
		return
	}
	_, document, err := s.readDirectorCaptureDocument(r)
	if err != nil {
		http.Error(w, "failed to read director captures", http.StatusInternalServerError)
		return
	}
	items := make([]directorCaptureResponse, 0)
	for _, item := range document.Items {
		if projectID == "" || (item.ProjectID == projectID && item.DirectorNodeID == directorID) {
			items = append(items, captureResponse(item))
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	writeJSON(w, items)
}

func (s *Server) createDirectorCapture(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "persistent store unavailable", http.StatusServiceUnavailable)
		return
	}
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		http.Error(w, "too many concurrent capture uploads", http.StatusTooManyRequests)
		return
	}
	if mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]); mediaType != "image/png" {
		http.Error(w, "capture must be image/png", http.StatusUnsupportedMediaType)
		return
	}
	value, err := parseCaptureQuery(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxDirectorCaptureBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil || validateDirectorCapturePNG(data, value.Width, value.Height) != nil {
		http.Error(w, "invalid capture PNG", http.StatusBadRequest)
		return
	}
	value.ID = randomID("capture")
	value.Bytes = len(data)
	value.StorageKey = "director-capture:" + value.ID
	tenantID := tenantIDFrom(r)
	userID := userIDFrom(r)
	if err := s.storeTenantBlob(r.Context(), tenantID, userID, value.StorageKey, "image/png", data); err != nil {
		if errors.Is(err, store.ErrQuotaExceeded) {
			http.Error(w, "capture storage quota exceeded", http.StatusInsufficientStorage)
		} else {
			http.Error(w, "failed to store capture", http.StatusInternalServerError)
		}
		return
	}
	err = s.mutateDirectorCaptures(r, func(document directorCaptureDocument) (directorCaptureDocument, error) {
		if len(document.Items) >= maxDirectorCapturesPerTenant {
			return directorCaptureDocument{}, errDirectorCaptureLimit
		}
		perScene := 0
		totalPixels := value.Width * value.Height
		for _, item := range document.Items {
			if item.ID == value.ID {
				return directorCaptureDocument{}, store.ErrConflict
			}
			if item.ProjectID == value.ProjectID && item.DirectorNodeID == value.DirectorNodeID {
				perScene++
			}
			totalPixels += item.Width * item.Height
		}
		if perScene >= maxDirectorCapturesPerScene || totalPixels > maxDirectorCaptureTotalPixels {
			return directorCaptureDocument{}, errDirectorCaptureLimit
		}
		document.Items = append(append([]directorCaptureRecord(nil), document.Items...), value)
		return document, nil
	})
	if err != nil {
		_ = s.deleteTenantBlob(r.Context(), tenantID, userID, value.StorageKey)
		if errors.Is(err, errDirectorCaptureLimit) {
			http.Error(w, "director capture storage limit reached", http.StatusInsufficientStorage)
		} else {
			http.Error(w, "failed to save capture metadata", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(captureResponse(value))
}

func (s *Server) deleteDirectorCapture(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !projectIDPattern.MatchString(id) {
		http.Error(w, "invalid capture id", http.StatusBadRequest)
		return
	}
	_, document, err := s.readDirectorCaptureDocument(r)
	if err != nil {
		http.Error(w, "failed to read director captures", http.StatusInternalServerError)
		return
	}
	var found *directorCaptureRecord
	for index := range document.Items {
		if document.Items[index].ID == id {
			copy := document.Items[index]
			found = &copy
			break
		}
	}
	if found == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err := s.deleteTenantBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), found.StorageKey); err != nil {
		http.Error(w, "failed to delete capture media", http.StatusInternalServerError)
		return
	}
	err = s.mutateDirectorCaptures(r, func(current directorCaptureDocument) (directorCaptureDocument, error) {
		next := make([]directorCaptureRecord, 0, len(current.Items))
		for _, item := range current.Items {
			if item.ID != id {
				next = append(next, item)
			}
		}
		current.Items = next
		return current, nil
	})
	if err != nil {
		http.Error(w, "failed to delete capture metadata", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) pruneDirectorCaptures(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "persistent store unavailable", http.StatusServiceUnavailable)
		return
	}
	var input struct {
		Projects map[string][]string `json:"projects"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.Projects == nil || len(input.Projects) > maxProjectCount {
		http.Error(w, "invalid director capture directory", http.StatusBadRequest)
		return
	}
	allowed := make(map[string]map[string]struct{}, len(input.Projects))
	for projectID, directorIDs := range input.Projects {
		if !projectIDPattern.MatchString(projectID) || len(directorIDs) > 10_000 {
			http.Error(w, "invalid director capture directory", http.StatusBadRequest)
			return
		}
		directors := make(map[string]struct{}, len(directorIDs))
		for _, directorID := range directorIDs {
			if !projectIDPattern.MatchString(directorID) {
				http.Error(w, "invalid director capture directory", http.StatusBadRequest)
				return
			}
			directors[directorID] = struct{}{}
		}
		allowed[projectID] = directors
	}
	now := time.Now().UTC()
	for range 8 {
		raw, current, err := s.readDirectorCaptureDocument(r)
		if err != nil {
			http.Error(w, "failed to read director captures", http.StatusInternalServerError)
			return
		}
		next := make([]directorCaptureRecord, 0, len(current.Items))
		remove := make([]directorCaptureRecord, 0)
		for _, item := range current.Items {
			directors, projectExists := allowed[item.ProjectID]
			_, directorExists := directors[item.DirectorNodeID]
			switch {
			case !projectExists:
				remove = append(remove, item)
			case directorExists:
				item.OrphanedAt = ""
				next = append(next, item)
			case item.OrphanedAt == "":
				item.OrphanedAt = now.Format(time.RFC3339Nano)
				next = append(next, item)
			default:
				orphanedAt, _ := time.Parse(time.RFC3339Nano, item.OrphanedAt)
				if orphanedAt.After(now.Add(-directorCaptureOrphanGrace)) {
					next = append(next, item)
				} else {
					remove = append(remove, item)
				}
			}
		}
		for _, item := range remove {
			if err := s.deleteTenantBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), item.StorageKey); err != nil {
				http.Error(w, "failed to prune capture media", http.StatusInternalServerError)
				return
			}
		}
		current.Items = next
		encoded, _ := json.Marshal(current)
		err = s.store.CompareAndSwapState(r.Context(), tenantIDFrom(r), directorCaptureStateKey, raw, encoded)
		if errors.Is(err, store.ErrConflict) {
			continue
		}
		if err != nil {
			http.Error(w, "failed to prune capture metadata", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "capture metadata changed concurrently", http.StatusConflict)
}
