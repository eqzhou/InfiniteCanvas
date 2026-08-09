package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestDeleteFilmProjectRecordsAndRetriesReferenceAwareProtectedMediaCleanup(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	payload := []byte("delete-cleanup-media")
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:delete-cleanup", payload, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:delete-cleanup"
	document.Shots[0].ImageSHA256 = sha256Hex(payload)
	document.Shots[0].MediaMIMEType = "image/png"
	body, _ := json.Marshal(filmRestoreRequest{Revision: 1, Document: document})
	restored := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if restored.Code != http.StatusOK {
		t.Fatal(restored.Body.String())
	}
	protectedKey := decodeFilmResponse(t, restored).Shots[0].ImageStorageKey
	usageWithProtected := backend.storageUsage
	reference := []byte(`{"id":"canvas-reference","title":"Reference","updatedAt":"2026-08-08T00:00:00Z","externalMedia":"` + protectedKey + `"}`)
	if err := backend.PutProject(t.Context(), store.DefaultTenantID, "canvas-reference", reference); err != nil {
		t.Fatal(err)
	}

	deleted := request(t, handler, http.MethodDelete, "/api/projects/film-api", nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete with shared reference: %d %s", deleted.Code, deleted.Body.String())
	}
	if blob := request(t, handler, http.MethodGet, "/api/blobs/"+protectedKey, nil); blob.Code != http.StatusOK {
		t.Fatalf("cleanup deleted a non-film referenced object: %d", blob.Code)
	}
	generations, err := backend.ListFilmCleanupGenerations(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil || len(generations) == 0 {
		t.Fatalf("cleanup inventory was not durably recorded: %v %#v", err, generations)
	}
	manifest, err := cleanupManifestFromGeneration(generations[0])
	manifestJSON, _ := json.Marshal(manifest)
	if err != nil || !strings.Contains(string(manifestJSON), protectedKey) {
		t.Fatalf("cleanup inventory omitted protected media: %v %#v", err, manifest)
	}

	if err := backend.DeleteProject(t.Context(), store.DefaultTenantID, "canvas-reference"); err != nil {
		t.Fatal(err)
	}
	retried := request(t, handler, http.MethodDelete, "/api/projects/film-api", nil)
	if retried.Code != http.StatusNoContent {
		t.Fatalf("retry cleanup: %d %s", retried.Code, retried.Body.String())
	}
	if blob := request(t, handler, http.MethodGet, "/api/blobs/"+protectedKey, nil); blob.Code != http.StatusNotFound {
		t.Fatalf("unreferenced protected object survived retry: %d", blob.Code)
	}
	if backend.storageUsage >= usageWithProtected {
		t.Fatalf("protected media quota was not released: before=%d after=%d", usageWithProtected, backend.storageUsage)
	}
}

func TestFilmCleanupDoesNotDeleteMediaReferencedByResurrectedSameProjectID(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	payload := []byte("same-id-resurrection")
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/upload:same-id-resurrection", payload, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	document, err := decomposeFilmSource(newFilmDocument("film-api"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	document.Shots[0].ImageStorageKey = "upload:same-id-resurrection"
	document.Shots[0].ImageSHA256 = sha256Hex(payload)
	document.Shots[0].MediaMIMEType = "image/png"
	body, _ := json.Marshal(filmRestoreRequest{Revision: 1, Document: document})
	restored := request(t, handler, http.MethodPut, "/api/film/projects/film-api/restore", body)
	if restored.Code != http.StatusOK {
		t.Fatal(restored.Body.String())
	}
	protectedKey := decodeFilmResponse(t, restored).Shots[0].ImageStorageKey
	hold := []byte(`{"id":"cleanup-hold","title":"Cleanup hold","updatedAt":"2026-08-08T00:00:00Z","externalMedia":"` + protectedKey + `"}`)
	if err := backend.PutProject(t.Context(), store.DefaultTenantID, "cleanup-hold", hold); err != nil {
		t.Fatal(err)
	}
	if response := request(t, handler, http.MethodDelete, "/api/projects/film-api", nil); response.Code != http.StatusNoContent {
		t.Fatalf("delete Film project = %d %s", response.Code, response.Body.String())
	}

	resurrected := []byte(`{"id":"film-api","title":"Resurrected","updatedAt":"2026-08-09T00:00:00Z","externalMedia":"` + protectedKey + `"}`)
	if err := backend.PutProject(t.Context(), store.DefaultTenantID, "film-api", resurrected); err != nil {
		t.Fatal(err)
	}
	if err := backend.DeleteProject(t.Context(), store.DefaultTenantID, "cleanup-hold"); err != nil {
		t.Fatal(err)
	}
	retried := request(t, handler, http.MethodPost, "/api/film/projects/film-api/cleanup", nil)
	if retried.Code != http.StatusOK || !strings.Contains(retried.Body.String(), `"pending": true`) {
		t.Fatalf("same-id referenced cleanup retry = %d %s", retried.Code, retried.Body.String())
	}
	if blob := request(t, handler, http.MethodGet, "/api/blobs/"+protectedKey, nil); blob.Code != http.StatusOK {
		t.Fatalf("old cleanup deleted media referenced by resurrected same ID: %d", blob.Code)
	}
}
