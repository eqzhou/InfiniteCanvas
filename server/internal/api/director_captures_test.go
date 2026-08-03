package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func directorCaptureRequest(t *testing.T, handler http.Handler, method, path string, body []byte, tenantID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "image/png")
	}
	if tenantID != "" {
		req.Header.Set("X-Test-Tenant", tenantID)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func tenantCaptureHandler(t *testing.T, memory *memoryStore) http.Handler {
	t.Helper()
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenantID := r.Header.Get("X-Test-Tenant")
			if tenantID != "" {
				user := store.AuthUser{ID: "user-" + tenantID, TenantID: tenantID}
				r = r.WithContext(context.WithValue(r.Context(), authUserKey, user))
			}
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, NewServerWithStore(t.TempDir(), memory))
	return router
}

func captureCreatePath(projectID, directorID, cameraID, cameraName string, width, height int) string {
	values := url.Values{
		"projectId":      {projectID},
		"directorNodeId": {directorID},
		"cameraId":       {cameraID},
		"cameraName":     {cameraName},
		"createdAt":      {"2026-07-25T01:02:03.000Z"},
		"width":          {strconv.Itoa(width)},
		"height":         {strconv.Itoa(height)},
	}
	return "/api/director-captures?" + values.Encode()
}

func TestDirectorCaptureLifecycleUsesProtectedTenantBlob(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	handler := tenantCaptureHandler(t, newMemoryStore())
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var record directorCaptureResponse
	if err := json.Unmarshal(created.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.ID == "" || record.ProjectID != "project-a" || record.URL == "" || record.Bytes != len(png) {
		t.Fatalf("unexpected record: %+v", record)
	}

	listed := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director-a", nil, "tenant-a")
	var records []directorCaptureResponse
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &records) != nil || len(records) != 1 || records[0].ID != record.ID {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	blob := directorCaptureRequest(t, handler, http.MethodGet, record.URL, nil, "tenant-a")
	if blob.Code != http.StatusOK || blob.Header().Get("Content-Type") != "image/png" || string(blob.Body.Bytes()) != string(png) {
		t.Fatalf("blob status=%d type=%q", blob.Code, blob.Header().Get("Content-Type"))
	}

	deleted := directorCaptureRequest(t, handler, http.MethodDelete, "/api/director-captures/"+record.ID, nil, "tenant-a")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	if got := directorCaptureRequest(t, handler, http.MethodGet, record.URL, nil, "tenant-a"); got.Code != http.StatusNotFound {
		t.Fatalf("deleted blob status=%d", got.Code)
	}
}

func TestDirectorCapturePersistsBoundedShotSnapshot(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	shot := json.RawMessage(`{"version":1,"directorNodeId":"director-a","camera":{"id":"camera-main","name":"主摄像机","position":{"x":1,"y":2,"z":3},"target":{"x":0,"y":1,"z":0},"focalLength":50,"aperture":2.8,"aspect":"16:9"},"background":"#111111","environment":{"rotationY":0,"intensity":1,"sourceId":null},"objects":[],"omittedObjectCount":0}`)
	handler := tenantCaptureHandler(t, newMemoryStore())
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	imagePart, err := writer.CreateFormFile("capture", "capture.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := imagePart.Write(png); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("shot", string(shot)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Test-Tenant", "tenant-a")
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, req)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var record directorCaptureResponse
	if err := json.Unmarshal(created.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if !jsonEqual(record.Shot, shot) {
		t.Fatalf("shot mismatch: %s", record.Shot)
	}

	listed := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director-a", nil, "tenant-a")
	var records []directorCaptureResponse
	if err := json.Unmarshal(listed.Body.Bytes(), &records); err != nil || len(records) != 1 || !jsonEqual(records[0].Shot, shot) {
		t.Fatalf("shot did not survive list: %s", listed.Body.String())
	}
}

func TestDirectorCaptureRejectsShotThatFrontendCannotParse(t *testing.T) {
	base := `{"version":1,"directorNodeId":"director-a","camera":{"id":"camera-main","name":"主摄像机","position":{"x":1,"y":2,"z":3},"target":{"x":0,"y":1,"z":0},"focalLength":50,"aperture":2.8,"aspect":"16:9"},"background":"#111111","environment":{"rotationY":0,"intensity":1,"sourceId":null},"objects":%s,"omittedObjectCount":0}`
	cases := []string{
		`[{"id":"model-a","kind":"model","name":"bad model","transform":{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},"modelAsset":{"bogus":1}}]`,
		`[{"id":"prop-a","kind":"prop","name":"bad scale","transform":{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":0,"y":1,"z":1}},"primitive":"box"}]`,
		`[{"id":"light-a","kind":"light","name":"one","transform":{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}},{"id":"light-a","kind":"light","name":"two","transform":{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}}]`,
	}
	for index, objects := range cases {
		raw := json.RawMessage([]byte(fmt.Sprintf(base, objects)))
		if validDirectorShotSnapshot(raw, "director-a", "camera-main", "主摄像机") {
			t.Fatalf("case %d unexpectedly accepted", index)
		}
	}
}

func TestDirectorCaptureAcceptsFrontendBoardIdentifiers(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	handler := tenantCaptureHandler(t, newMemoryStore())
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director:main", "camera:main", "主摄像机", 1, 1), png, "tenant-a")
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	listed := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director%3Amain", nil, "tenant-a")
	var records []directorCaptureResponse
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &records) != nil || len(records) != 1 || records[0].DirectorNodeID != "director:main" {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
}

func TestDirectorCaptureRejectsMissingOrNullRequiredShotFields(t *testing.T) {
	valid := `{"version":1,"directorNodeId":"director-a","camera":{"id":"camera-main","name":"主摄像机","position":{"x":1,"y":2,"z":3},"target":{"x":0,"y":1,"z":0},"focalLength":50,"aperture":2.8,"aspect":"16:9"},"background":"#111111","environment":{"rotationY":0,"intensity":1,"sourceId":null},"objects":[],"omittedObjectCount":0}`
	cases := map[string]string{
		"missing objects":           strings.Replace(valid, `,"objects":[]`, "", 1),
		"missing omitted count":     strings.Replace(valid, `,"omittedObjectCount":0`, "", 1),
		"null environment":          strings.Replace(valid, `"environment":{"rotationY":0,"intensity":1,"sourceId":null}`, `"environment":null`, 1),
		"null camera position":      strings.Replace(valid, `"position":{"x":1,"y":2,"z":3}`, `"position":null`, 1),
		"null object optional data": strings.Replace(valid, `"objects":[]`, `"objects":[{"id":"light-a","kind":"light","name":"light","transform":{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},"character":null}]`, 1),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if validDirectorShotSnapshot(json.RawMessage(raw), "director-a", "camera-main", "主摄像机") {
				t.Fatalf("invalid snapshot unexpectedly accepted: %s", raw)
			}
		})
	}
}

func jsonEqual(left, right []byte) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
}

func TestDirectorCapturesValidatePixelsAndIsolateTenants(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	handler := tenantCaptureHandler(t, newMemoryStore())
	if got := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 2, 1), png, "tenant-a"); got.Code != http.StatusBadRequest {
		t.Fatalf("dimension mismatch status=%d body=%s", got.Code, got.Body.String())
	}
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	var record directorCaptureResponse
	_ = json.Unmarshal(created.Body.Bytes(), &record)
	if got := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director-a", nil, "tenant-b"); got.Code != http.StatusOK || got.Body.String() != "[]\n" {
		t.Fatalf("cross-tenant list status=%d body=%s", got.Code, got.Body.String())
	}
	if got := directorCaptureRequest(t, handler, http.MethodDelete, "/api/director-captures/"+record.ID, nil, "tenant-b"); got.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant delete status=%d", got.Code)
	}
}

func TestDirectorCaptureCreateCompensatesBlobWhenMetadataCASFails(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	memory := newMemoryStore()
	memory.compareAndSwapStateErr = errors.New("metadata unavailable")
	handler := tenantCaptureHandler(t, memory)
	got := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	if got.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
	}
	if memory.storageUsage != 0 {
		t.Fatalf("storage usage leaked: %d", memory.storageUsage)
	}
}

func TestDirectorCapturePruneDeletesRemovedProjectsAndMedia(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	memory := newMemoryStore()
	handler := tenantCaptureHandler(t, memory)
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	var record directorCaptureResponse
	_ = json.Unmarshal(created.Body.Bytes(), &record)
	req := httptest.NewRequest(http.MethodPut, "/api/director-captures/prune", bytes.NewBufferString(`{"projects":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Tenant", "tenant-a")
	pruned := httptest.NewRecorder()
	handler.ServeHTTP(pruned, req)
	if pruned.Code != http.StatusNoContent {
		t.Fatalf("prune status=%d body=%s", pruned.Code, pruned.Body.String())
	}
	listed := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director-a", nil, "tenant-a")
	if listed.Code != http.StatusOK || listed.Body.String() != "[]\n" {
		t.Fatalf("list after prune status=%d body=%s", listed.Code, listed.Body.String())
	}
	if got := directorCaptureRequest(t, handler, http.MethodGet, record.URL, nil, "tenant-a"); got.Code != http.StatusNotFound {
		t.Fatalf("pruned blob status=%d", got.Code)
	}
}

func TestDirectorCaptureDeleteKeepsBlobWhenMetadataCASFails(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	memory := newMemoryStore()
	handler := tenantCaptureHandler(t, memory)
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	var record directorCaptureResponse
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &record) != nil {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	usageBefore := memory.storageUsage
	memory.compareAndSwapStateErr = errors.New("metadata unavailable")
	deleted := directorCaptureRequest(t, handler, http.MethodDelete, "/api/director-captures/"+record.ID, nil, "tenant-a")
	if deleted.Code != http.StatusInternalServerError {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	if memory.storageUsage != usageBefore {
		t.Fatalf("blob reclaimed despite metadata CAS failure: before=%d after=%d", usageBefore, memory.storageUsage)
	}
	memory.compareAndSwapStateErr = nil
	listed := directorCaptureRequest(t, handler, http.MethodGet,
		"/api/director-captures?projectId=project-a&directorNodeId=director-a", nil, "tenant-a")
	var records []directorCaptureResponse
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &records) != nil || len(records) != 1 || records[0].ID != record.ID {
		t.Fatalf("capture disappeared after failed delete: %d %s", listed.Code, listed.Body.String())
	}
	if got := directorCaptureRequest(t, handler, http.MethodGet, record.URL, nil, "tenant-a"); got.Code != http.StatusOK {
		t.Fatalf("blob missing after failed delete: %d", got.Code)
	}
}

func TestDirectorCapturePruneKeepsBlobWhenMetadataCASFails(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	memory := newMemoryStore()
	handler := tenantCaptureHandler(t, memory)
	created := directorCaptureRequest(t, handler, http.MethodPost,
		captureCreatePath("project-a", "director-a", "camera-main", "主摄像机", 1, 1), png, "tenant-a")
	var record directorCaptureResponse
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &record) != nil {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	usageBefore := memory.storageUsage
	memory.compareAndSwapStateErr = errors.New("metadata unavailable")
	req := httptest.NewRequest(http.MethodPut, "/api/director-captures/prune", bytes.NewBufferString(`{"projects":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Tenant", "tenant-a")
	pruned := httptest.NewRecorder()
	handler.ServeHTTP(pruned, req)
	if pruned.Code != http.StatusInternalServerError {
		t.Fatalf("prune status=%d body=%s", pruned.Code, pruned.Body.String())
	}
	if memory.storageUsage != usageBefore {
		t.Fatalf("blob reclaimed despite prune CAS failure: before=%d after=%d", usageBefore, memory.storageUsage)
	}
	memory.compareAndSwapStateErr = nil
	if got := directorCaptureRequest(t, handler, http.MethodGet, record.URL, nil, "tenant-a"); got.Code != http.StatusOK {
		t.Fatalf("blob missing after failed prune: %d", got.Code)
	}
}
func TestProjectValidatorAcceptsPersistedDirectorCaptureOwnerNode(t *testing.T) {
	node := map[string]any{
		"id": "director-a", "type": "director", "title": "3D 导演台",
		"position": map[string]any{"x": float64(0), "y": float64(0)},
		"width":    float64(360), "height": float64(240), "metadata": map[string]any{},
	}
	if err := validateNode(node); err != nil {
		t.Fatalf("director node rejected: %v", err)
	}
	node["type"] = "panorama"
	if err := validateNode(node); err != nil {
		t.Fatalf("panorama node rejected: %v", err)
	}
	node["type"] = "plugin"
	if err := validateNode(node); err != nil {
		t.Fatalf("plugin node rejected: %v", err)
	}
}
