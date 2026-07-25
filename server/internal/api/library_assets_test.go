package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestLibraryAssetLifecycle(t *testing.T) {
	handler := persistentHandler(t)

	createBody := []byte(`{"kind":"image","title":"Sunset ref","tags":["env","hdr"],"coverUrl":"https://example.com/sunset.jpg","source":"seed","notes":"server library"}`)
	created := request(t, handler, http.MethodPost, "/api/library-assets", createBody)
	if created.Code != http.StatusCreated {
		t.Fatalf("POST status = %d body=%s", created.Code, created.Body.String())
	}
	var asset map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &asset); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	id, _ := asset["id"].(string)
	if id == "" {
		t.Fatalf("missing id in create response: %s", created.Body.String())
	}
	if asset["title"] != "Sunset ref" || asset["kind"] != "image" {
		t.Fatalf("unexpected create payload: %s", created.Body.String())
	}

	listed := request(t, handler, http.MethodGet, "/api/library-assets?q=sunset&kind=image", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("LIST status = %d body=%s", listed.Code, listed.Body.String())
	}
	var page map[string]any
	if err := json.Unmarshal(listed.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	items, _ := page["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %v", listed.Body.String())
	}

	got := request(t, handler, http.MethodGet, "/api/library-assets/"+id, nil)
	if got.Code != http.StatusOK {
		t.Fatalf("GET status = %d body=%s", got.Code, got.Body.String())
	}

	updateBody := []byte(`{"kind":"image","title":"Sunset updated","tags":["env"],"coverUrl":"https://example.com/sunset2.jpg","source":"seed","notes":"updated"}`)
	updated := request(t, handler, http.MethodPut, "/api/library-assets/"+id, updateBody)
	if updated.Code != http.StatusOK {
		t.Fatalf("PUT status = %d body=%s", updated.Code, updated.Body.String())
	}
	var after map[string]any
	if err := json.Unmarshal(updated.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	if after["title"] != "Sunset updated" {
		t.Fatalf("title not updated: %s", updated.Body.String())
	}

	deleted := request(t, handler, http.MethodDelete, "/api/library-assets/"+id, nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d body=%s", deleted.Code, deleted.Body.String())
	}
	missing := request(t, handler, http.MethodGet, "/api/library-assets/"+id, nil)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("GET deleted status = %d body=%s", missing.Code, missing.Body.String())
	}
}

func TestLibraryAssetRejectsInvalidWrite(t *testing.T) {
	handler := persistentHandler(t)
	bad := request(t, handler, http.MethodPost, "/api/library-assets", []byte(`{"kind":"image","title":"","coverUrl":"https://example.com/a.jpg"}`))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty title, got %d body=%s", bad.Code, bad.Body.String())
	}
	badKind := request(t, handler, http.MethodPost, "/api/library-assets", []byte(`{"kind":"pdf","title":"Doc","coverUrl":"https://example.com/a.pdf"}`))
	if badKind.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad kind, got %d body=%s", badKind.Code, badKind.Body.String())
	}
}
