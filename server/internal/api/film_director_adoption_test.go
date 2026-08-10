package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func createFilmDirectorCapture(t *testing.T, handler http.Handler) directorCaptureResponse {
	t.Helper()
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	shot := `{"version":1,"directorNodeId":"director-main","camera":{"id":"camera-main","name":"Main camera","position":{"x":1,"y":2,"z":3},"target":{"x":0,"y":1,"z":0},"focalLength":50,"aperture":2.8,"aspect":"16:9"},"background":"#111111","environment":{"rotationY":0,"intensity":1,"sourceId":null},"objects":[],"omittedObjectCount":0}`
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("capture", "capture.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(png)
	_ = writer.WriteField("shot", shot)
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, captureCreatePath("film-api", "director-main", "camera-main", "Main camera", 1, 1), &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create capture: %d %s", recorder.Code, recorder.Body.String())
	}
	var capture directorCaptureResponse
	if json.Unmarshal(recorder.Body.Bytes(), &capture) != nil {
		t.Fatal("decode capture")
	}
	return capture
}

func TestFilmAdoptsVerifiedDirectorCaptureIntoStableMedia(t *testing.T) {
	_, handler := filmAPIHandler(t)
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"film-api","title":"Film API","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[{"id":"director-main","type":"director","title":"Director","position":{"x":0,"y":0},"width":640,"height":480,"metadata":{}}],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/film-api", project); response.Code != http.StatusNoContent {
		t.Fatalf("seed director node: %d %s", response.Code, response.Body.String())
	}
	document := decodeFilmResponse(t, request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nA performer enters."}`)))
	capture := createFilmDirectorCapture(t, handler)
	body, _ := json.Marshal(map[string]any{"shotId": document.Shots[0].ID, "expectedRevision": document.Shots[0].Revision, "captureId": capture.ID, "targetField": "storyboard"})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/director/adopt", body)
	if response.Code != http.StatusOK {
		t.Fatalf("adopt director capture: %d %s", response.Code, response.Body.String())
	}
	adopted := decodeFilmResponse(t, response).Shots[0]
	if adopted.DirectorSource == nil || adopted.DirectorSource.CaptureID != capture.ID || adopted.DirectorSource.DirectorNodeID != "director-main" ||
		adopted.ImageStorageKey == "" || adopted.ImageStorageKey == "director-capture:"+capture.ID || adopted.ImageSHA256 == "" || adopted.ImageObjectVersion == "" {
		t.Fatalf("director provenance was not frozen into Film: %#v", adopted)
	}
	if deleted := request(t, handler, http.MethodDelete, "/api/director-captures/"+capture.ID, nil); deleted.Code != http.StatusNoContent {
		t.Fatalf("delete source capture: %d %s", deleted.Code, deleted.Body.String())
	}
	if stable := request(t, handler, http.MethodGet, "/api/blobs/"+adopted.ImageStorageKey, nil); stable.Code != http.StatusOK {
		t.Fatalf("stable Film copy disappeared with source capture: %d %s", stable.Code, stable.Body.String())
	}
}

func TestFilmDirectorAdoptionRejectsUnknownCapture(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nAction."}`)))
	body, _ := json.Marshal(map[string]any{"shotId": document.Shots[0].ID, "expectedRevision": document.Shots[0].Revision, "captureId": "capture-missing", "targetField": "storyboard"})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/director/adopt", body)
	if response.Code != http.StatusNotFound && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown Director capture accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmGenerationSnapshotFreezesDirectorSource(t *testing.T) {
	document := newFilmDocument("film-director-snapshot")
	storyboard := &filmDirectorSource{
		Revision: 1, TargetField: "storyboard", CaptureID: "capture-main", DirectorNodeID: "director-main",
		CameraID: "camera-main", CameraName: "Main", Width: 1920, Height: 1080,
		StorageKey: "film:media:director:stable", SHA256: strings.Repeat("a", 64), ObjectVersion: "version-1",
		Snapshot: json.RawMessage(`{"version":1}`), AdoptedAt: document.CreatedAt,
	}
	firstFrame := *storyboard
	firstFrame.TargetField, firstFrame.CaptureID, firstFrame.StorageKey = "first_frame", "capture-first", "film:media:director:first"
	shot := filmShot{ID: "shot-main", Revision: 2, Description: "Frame", StoryboardDirectorSource: storyboard, FirstFrameDirectorSource: &firstFrame}
	snapshot := buildFilmGenerationSnapshot(document, shot, "provider", "model", filmGenerationConfig{}, document.CreatedAt)
	if snapshot.StoryboardDirectorSource == nil || snapshot.StoryboardDirectorSource.CaptureID != "capture-main" ||
		snapshot.FirstFrameDirectorSource == nil || snapshot.FirstFrameDirectorSource.CaptureID != "capture-first" {
		t.Fatalf("Director source was not frozen into generation snapshot: %#v", snapshot)
	}
	shot.StoryboardDirectorSource.CameraName = "Changed"
	shot.FirstFrameDirectorSource.CameraName = "Changed first"
	if snapshot.StoryboardDirectorSource.CameraName != "Main" || snapshot.FirstFrameDirectorSource.CameraName != "Main" {
		t.Fatal("generation snapshot retained a mutable Director source pointer")
	}
}
