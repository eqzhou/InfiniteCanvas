package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
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
	ID             string          `json:"id"`
	ProjectID      string          `json:"projectId"`
	DirectorNodeID string          `json:"directorNodeId"`
	CameraID       string          `json:"cameraId"`
	CameraName     string          `json:"cameraName"`
	CreatedAt      string          `json:"createdAt"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	Bytes          int             `json:"bytes"`
	MIMEType       string          `json:"mimeType"`
	StorageKey     string          `json:"storageKey"`
	OrphanedAt     string          `json:"orphanedAt,omitempty"`
	Shot           json.RawMessage `json:"shot,omitempty"`
}

type directorCaptureResponse struct {
	ID             string          `json:"id"`
	ProjectID      string          `json:"projectId"`
	DirectorNodeID string          `json:"directorNodeId"`
	CameraID       string          `json:"cameraId"`
	CameraName     string          `json:"cameraName"`
	CreatedAt      string          `json:"createdAt"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	Bytes          int             `json:"bytes"`
	MIMEType       string          `json:"mimeType"`
	URL            string          `json:"url"`
	Shot           json.RawMessage `json:"shot,omitempty"`
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
		URL:  "/api/blobs/" + url.PathEscape(value.StorageKey),
		Shot: append(json.RawMessage(nil), value.Shot...),
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
		projectIDPattern.MatchString(value.ProjectID) && boardIDPattern.MatchString(value.DirectorNodeID) &&
		boardIDPattern.MatchString(value.CameraID) && strings.TrimSpace(value.CameraName) == value.CameraName &&
		len(value.CameraName) >= 1 && len(value.CameraName) <= 100 && value.Width >= 1 && value.Width <= 4096 &&
		value.Height >= 1 && value.Height <= 4096 && value.Bytes >= 1 && value.Bytes <= maxDirectorCaptureBytes &&
		value.MIMEType == "image/png" && value.StorageKey == "director-capture:"+value.ID &&
		(len(value.Shot) == 0 || validDirectorShotSnapshot(value.Shot, value.DirectorNodeID, value.CameraID, value.CameraName))
}

type directorShotVector struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}
type directorShotTransform struct {
	Position directorShotVector `json:"position"`
	Rotation directorShotVector `json:"rotation"`
	Scale    directorShotVector `json:"scale"`
}
type directorShotCamera struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Position    directorShotVector `json:"position"`
	Target      directorShotVector `json:"target"`
	FocalLength float64            `json:"focalLength"`
	Aperture    float64            `json:"aperture"`
	Aspect      string             `json:"aspect"`
}
type directorShotEnvironment struct {
	RotationY float64 `json:"rotationY"`
	Intensity float64 `json:"intensity"`
	SourceID  *string `json:"sourceId,omitempty"`
}
type directorShotCharacter struct {
	Preset string `json:"preset"`
	Pose   string `json:"pose"`
	Role   string `json:"role"`
}
type directorShotCrowd struct {
	Preset    string  `json:"preset"`
	Pose      string  `json:"pose"`
	Rows      int     `json:"rows"`
	Columns   int     `json:"columns"`
	SpacingX  float64 `json:"spacingX"`
	SpacingZ  float64 `json:"spacingZ"`
	Variation bool    `json:"variation"`
	Seed      int64   `json:"seed"`
}
type directorShotModelAsset struct {
	AssetID  string `json:"assetId"`
	FileName string `json:"fileName"`
	Bytes    int64  `json:"bytes"`
}
type directorShotObject struct {
	ID         string                  `json:"id"`
	Kind       string                  `json:"kind"`
	Name       string                  `json:"name"`
	Transform  directorShotTransform   `json:"transform"`
	Character  *directorShotCharacter  `json:"character,omitempty"`
	Crowd      *directorShotCrowd      `json:"crowd,omitempty"`
	Primitive  *string                 `json:"primitive,omitempty"`
	ModelAsset *directorShotModelAsset `json:"modelAsset,omitempty"`
}
type directorShotSnapshot struct {
	Version            int                     `json:"version"`
	DirectorNodeID     string                  `json:"directorNodeId"`
	Camera             directorShotCamera      `json:"camera"`
	Background         string                  `json:"background"`
	Environment        directorShotEnvironment `json:"environment"`
	Objects            []directorShotObject    `json:"objects"`
	OmittedObjectCount int                     `json:"omittedObjectCount"`
}

func finiteShotNumber(value float64, limit float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= limit
}
func validShotVector(value directorShotVector) bool {
	return finiteShotNumber(value.X, 100_000) && finiteShotNumber(value.Y, 100_000) && finiteShotNumber(value.Z, 100_000)
}

var directorShotColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
var directorShotModelFilePattern = regexp.MustCompile(`(?i)^[^/\\\x00-\x1f\x7f]{1,160}\.glb$`)

func requiredRawFields(raw json.RawMessage, fields ...string) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, false
	}
	for _, field := range fields {
		value, exists := object[field]
		if !exists || len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, false
		}
	}
	return object, true
}

func validDirectorShotPresence(raw json.RawMessage) bool {
	top, ok := requiredRawFields(raw, "version", "directorNodeId", "camera", "background", "environment", "objects", "omittedObjectCount")
	if !ok {
		return false
	}
	camera, ok := requiredRawFields(top["camera"], "id", "name", "position", "target", "focalLength", "aperture", "aspect")
	if !ok {
		return false
	}
	if _, ok = requiredRawFields(camera["position"], "x", "y", "z"); !ok {
		return false
	}
	if _, ok = requiredRawFields(camera["target"], "x", "y", "z"); !ok {
		return false
	}
	if _, ok = requiredRawFields(top["environment"], "rotationY", "intensity"); !ok {
		return false
	}
	var objects []json.RawMessage
	if json.Unmarshal(top["objects"], &objects) != nil || objects == nil {
		return false
	}
	for _, rawObject := range objects {
		object, valid := requiredRawFields(rawObject, "id", "kind", "name", "transform")
		if !valid {
			return false
		}
		transform, valid := requiredRawFields(object["transform"], "position", "rotation", "scale")
		if !valid {
			return false
		}
		for _, field := range []string{"position", "rotation", "scale"} {
			if _, valid = requiredRawFields(transform[field], "x", "y", "z"); !valid {
				return false
			}
		}
		for _, optional := range []string{"character", "crowd", "primitive", "modelAsset"} {
			if value, exists := object[optional]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return false
			}
		}
		if value, exists := object["character"]; exists {
			if _, valid = requiredRawFields(value, "preset", "pose", "role"); !valid {
				return false
			}
		}
		if value, exists := object["crowd"]; exists {
			if _, valid = requiredRawFields(value, "preset", "pose", "rows", "columns", "spacingX", "spacingZ", "variation", "seed"); !valid {
				return false
			}
		}
		if value, exists := object["modelAsset"]; exists {
			if _, valid = requiredRawFields(value, "assetId", "fileName", "bytes"); !valid {
				return false
			}
		}
	}
	return true
}

func validDirectorShotSnapshot(raw json.RawMessage, directorID, cameraID, cameraName string) bool {
	if len(raw) < 2 || len(raw) > 64<<10 || !validDirectorShotPresence(raw) {
		return false
	}
	var shot directorShotSnapshot
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&shot) != nil || ensureJSONEOF(decoder) != nil || shot.Version != 1 ||
		shot.DirectorNodeID != directorID || shot.Camera.ID != cameraID || shot.Camera.Name != cameraName || !boardIDPattern.MatchString(shot.DirectorNodeID) ||
		!boardIDPattern.MatchString(shot.Camera.ID) || len(strings.TrimSpace(shot.Camera.Name)) < 1 || len(shot.Camera.Name) > 100 ||
		!validShotVector(shot.Camera.Position) || !validShotVector(shot.Camera.Target) ||
		shot.Camera.FocalLength < 1 || shot.Camera.FocalLength > 300 || shot.Camera.Aperture < 0.7 || shot.Camera.Aperture > 64 ||
		!map[string]bool{"16:9": true, "4:3": true, "1:1": true, "3:4": true, "9:16": true}[shot.Camera.Aspect] ||
		!directorShotColorPattern.MatchString(shot.Background) || !finiteShotNumber(shot.Environment.RotationY, 360) ||
		!finiteShotNumber(shot.Environment.Intensity, 2) || shot.Environment.Intensity < 0 ||
		len(shot.Objects) > 64 || shot.OmittedObjectCount < 0 || shot.OmittedObjectCount > 10_000 {
		return false
	}
	if shot.Environment.SourceID != nil && *shot.Environment.SourceID != "" && !boardIDPattern.MatchString(*shot.Environment.SourceID) {
		return false
	}
	allowedKinds := map[string]bool{"character": true, "crowd": true, "prop": true, "light": true, "model": true}
	allowedPrimitives := map[string]bool{"box": true, "sphere": true, "cylinder": true, "cone": true, "torus": true, "plane": true}
	allowedPresets := map[string]bool{"studio": true, "tall": true, "compact": true, "athletic": true, "broad": true, "casual": true, "formal": true, "future": true}
	allowedPoses := map[string]bool{"neutral": true, "contrapposto": true, "arms-crossed": true, "hands-hips": true, "wave-left": true, "wave-right": true, "point-left": true, "point-right": true, "walk-left": true, "walk-right": true, "run": true, "sit": true, "crouch": true, "lean": true, "reach": true, "look-back": true, "guard": true, "celebrate": true, "talk": true, "camera-ready": true}
	seen := make(map[string]struct{}, len(shot.Objects))
	modelCount, crowdCount, population, renderBatches := 0, 0, 0, 0
	for _, object := range shot.Objects {
		_, duplicated := seen[object.ID]
		if !boardIDPattern.MatchString(object.ID) || duplicated || !allowedKinds[object.Kind] || len(object.Name) < 1 || len(object.Name) > 100 ||
			!validShotVector(object.Transform.Position) || !finiteShotNumber(object.Transform.Rotation.X, 360) ||
			!finiteShotNumber(object.Transform.Rotation.Y, 360) || !finiteShotNumber(object.Transform.Rotation.Z, 360) ||
			object.Transform.Scale.X < 0.01 || object.Transform.Scale.X > 1000 || object.Transform.Scale.Y < 0.01 || object.Transform.Scale.Y > 1000 ||
			object.Transform.Scale.Z < 0.01 || object.Transform.Scale.Z > 1000 {
			return false
		}
		seen[object.ID] = struct{}{}
		switch object.Kind {
		case "character":
			if object.Character == nil || object.Crowd != nil || object.Primitive != nil || object.ModelAsset != nil ||
				!allowedPresets[object.Character.Preset] || !allowedPoses[object.Character.Pose] ||
				(object.Character.Role != "actor" && object.Character.Role != "extra") {
				return false
			}
			population++
		case "crowd":
			crowdCount++
			crowd := object.Crowd
			if crowd == nil || object.Character != nil || object.Primitive != nil || object.ModelAsset != nil || crowdCount > 32 ||
				!allowedPresets[crowd.Preset] || !allowedPoses[crowd.Pose] || crowd.Rows < 1 || crowd.Rows > 64 || crowd.Columns < 1 || crowd.Columns > 64 ||
				crowd.Rows*crowd.Columns > 1024 || !finiteShotNumber(crowd.SpacingX, 100) || crowd.SpacingX < 0.1 ||
				!finiteShotNumber(crowd.SpacingZ, 100) || crowd.SpacingZ < 0.1 || crowd.Seed < 0 || crowd.Seed > 0x7fffffff {
				return false
			}
			population += crowd.Rows * crowd.Columns
			if crowd.Variation {
				renderBatches += min(crowd.Rows*crowd.Columns, 41)
			} else {
				renderBatches++
			}
		case "prop":
			if object.Primitive == nil || !allowedPrimitives[*object.Primitive] || object.Character != nil || object.Crowd != nil || object.ModelAsset != nil {
				return false
			}
		case "light":
			if object.Character != nil || object.Crowd != nil || object.Primitive != nil || object.ModelAsset != nil {
				return false
			}
		case "model":
			modelCount++
			asset := object.ModelAsset
			if asset == nil || object.Character != nil || object.Crowd != nil || object.Primitive != nil || modelCount > 32 ||
				!boardIDPattern.MatchString(asset.AssetID) || !directorShotModelFilePattern.MatchString(asset.FileName) || asset.FileName == ".glb" ||
				asset.Bytes < 1 || asset.Bytes > 100<<20 {
				return false
			}
		}
	}
	return population <= 4096 && renderBatches <= 128
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
	if encoded := strings.TrimSpace(r.Header.Get("X-OpenBoard-Director-Shot")); encoded != "" {
		shot, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || !validDirectorShotSnapshot(shot, value.DirectorNodeID, value.CameraID, value.CameraName) {
			return directorCaptureRecord{}, errors.New("invalid director shot metadata")
		}
		value.Shot = append(json.RawMessage(nil), shot...)
	}
	if widthErr != nil || heightErr != nil || timeErr != nil || !projectIDPattern.MatchString(value.ProjectID) ||
		!boardIDPattern.MatchString(value.DirectorNodeID) || !boardIDPattern.MatchString(value.CameraID) ||
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

func readDirectorCapturePayload(w http.ResponseWriter, r *http.Request, value *directorCaptureRecord) ([]byte, error) {
	mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
	if mediaType == "image/png" {
		r.Body = http.MaxBytesReader(w, r.Body, maxDirectorCaptureBytes)
		return io.ReadAll(r.Body)
	}
	if mediaType != "multipart/form-data" {
		return nil, errors.New("capture must be image/png or multipart/form-data")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxDirectorCaptureBytes+(128<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, errors.New("invalid director capture multipart data")
	}
	var data []byte
	for parts := 0; ; parts++ {
		if parts > 3 {
			return nil, errors.New("invalid director capture multipart data")
		}
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, errors.New("invalid director capture multipart data")
		}
		name := part.FormName()
		switch name {
		case "capture":
			if data != nil {
				return nil, errors.New("duplicate director capture image")
			}
			data, err = io.ReadAll(io.LimitReader(part, maxDirectorCaptureBytes+1))
			if err != nil || len(data) > maxDirectorCaptureBytes {
				return nil, errors.New("invalid director capture image")
			}
		case "shot":
			if len(value.Shot) != 0 {
				return nil, errors.New("duplicate director shot metadata")
			}
			shot, readErr := io.ReadAll(io.LimitReader(part, (64<<10)+1))
			if readErr != nil || !validDirectorShotSnapshot(shot, value.DirectorNodeID, value.CameraID, value.CameraName) {
				return nil, errors.New("invalid director shot metadata")
			}
			value.Shot = append(json.RawMessage(nil), shot...)
		default:
			return nil, errors.New("invalid director capture multipart field")
		}
	}
	if data == nil {
		return nil, errors.New("director capture image is missing")
	}
	return data, nil
}

func (s *Server) listDirectorCaptures(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	directorID := r.URL.Query().Get("directorNodeId")
	if (projectID == "") != (directorID == "") ||
		(projectID != "" && (!projectIDPattern.MatchString(projectID) || !boardIDPattern.MatchString(directorID))) {
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
	value, err := parseCaptureQuery(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := readDirectorCapturePayload(w, r, &value)
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
	var removed *directorCaptureRecord
	err := s.mutateDirectorCaptures(r, func(current directorCaptureDocument) (directorCaptureDocument, error) {
		next := make([]directorCaptureRecord, 0, len(current.Items))
		var found *directorCaptureRecord
		for _, item := range current.Items {
			if item.ID == id {
				copy := item
				found = &copy
				continue
			}
			next = append(next, item)
		}
		if found == nil {
			return directorCaptureDocument{}, store.ErrNotFound
		}
		removed = found
		current.Items = next
		return current, nil
	})
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to delete capture metadata", http.StatusInternalServerError)
		return
	}
	// Metadata is authoritative. Drop media after a successful CAS so a failed
	// metadata write cannot leave a listed capture pointing at a missing blob.
	if removed != nil {
		if err := s.deleteTenantBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), removed.StorageKey); err != nil {
			http.Error(w, "failed to delete capture media", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) pruneDirectorCaptures(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant director captures unavailable") {
		return
	}
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
			if !boardIDPattern.MatchString(directorID) {
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
		// Only reclaim blobs after metadata is durable, so a CAS conflict cannot
		// delete media that is still listed on a concurrent writer's snapshot.
		for _, item := range remove {
			if err := s.deleteTenantBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), item.StorageKey); err != nil {
				http.Error(w, "failed to prune capture media", http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "capture metadata changed concurrently", http.StatusConflict)
}
