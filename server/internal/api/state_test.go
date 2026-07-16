package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type memoryStore struct {
	projects map[string][]byte
	state    map[string][]byte
}

func newMemoryStore() *memoryStore {
	return &memoryStore{projects: map[string][]byte{}, state: map[string][]byte{}}
}

func (*memoryStore) Close()                     {}
func (*memoryStore) Ping(context.Context) error { return nil }
func (m *memoryStore) ListProjects(context.Context) ([]store.ProjectSummary, error) {
	out := make([]store.ProjectSummary, 0, len(m.projects))
	for id := range m.projects {
		out = append(out, store.ProjectSummary{ID: id})
	}
	return out, nil
}
func (m *memoryStore) GetProject(_ context.Context, id string) ([]byte, error) {
	value, ok := m.projects[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return append([]byte(nil), value...), nil
}
func (m *memoryStore) PutProject(_ context.Context, id string, value []byte) error {
	m.projects[id] = append([]byte(nil), value...)
	return nil
}
func (m *memoryStore) DeleteProject(_ context.Context, id string) error {
	delete(m.projects, id)
	return nil
}
func (m *memoryStore) GetState(_ context.Context, key string) ([]byte, error) {
	value, ok := m.state[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	return append([]byte(nil), value...), nil
}
func (m *memoryStore) PutState(_ context.Context, key string, value []byte) error {
	if !json.Valid(value) {
		return errors.New("invalid json")
	}
	m.state[key] = append([]byte(nil), value...)
	return nil
}

func persistentHandler(t *testing.T) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	MountServer(r, NewServerWithStore(t.TempDir(), newMemoryStore()))
	return r
}

func TestPersistentProjectAndStateLifecycle(t *testing.T) {
	handler := persistentHandler(t)
	project := []byte(`{"id":"board-1","title":"First","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", project); got.Code != http.StatusNoContent {
		t.Fatalf("put project: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/projects/board-1", nil); got.Code != http.StatusOK {
		t.Fatalf("get project: %d", got.Code)
	}
	if got := request(t, handler, http.MethodPut, "/api/state/assets", []byte(`[]`)); got.Code != http.StatusNoContent {
		t.Fatalf("put state: %d", got.Code)
	}
	if got := request(t, handler, http.MethodGet, "/api/state/assets", nil); got.Code != http.StatusOK || got.Body.String() != "[]" {
		t.Fatalf("get state: %d %q", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPut, "/api/state/unknown", []byte(`{}`)); got.Code != http.StatusNotFound {
		t.Fatalf("unknown state: %d", got.Code)
	}
}

func TestPersistentBlobLifecycle(t *testing.T) {
	handler := persistentHandler(t)
	if got := request(t, handler, http.MethodPut, "/api/blobs/image%3Aone", []byte("png")); got.Code != http.StatusNoContent {
		t.Fatalf("put blob: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/blobs/image%3Aone", nil); got.Code != http.StatusOK || got.Body.String() != "png" {
		t.Fatalf("get blob: %d %q", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/blobs/image%3Aone", nil); got.Code != http.StatusNoContent {
		t.Fatalf("delete blob: %d", got.Code)
	}
}

func TestBlobContentTypeBoundary(t *testing.T) {
	handler := persistentHandler(t)
	unsafe := httptest.NewRequest(http.MethodPut, "/api/blobs/unsafe", bytes.NewReader([]byte("<script>alert(1)</script>")))
	unsafe.Header.Set("Content-Type", "text/html")
	unsafeResult := httptest.NewRecorder()
	handler.ServeHTTP(unsafeResult, unsafe)
	if unsafeResult.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsafe content type status = %d", unsafeResult.Code)
	}

	safe := httptest.NewRequest(http.MethodPut, "/api/blobs/safe", bytes.NewReader([]byte("png")))
	safe.Header.Set("Content-Type", "image/png")
	safeResult := httptest.NewRecorder()
	handler.ServeHTTP(safeResult, safe)
	if safeResult.Code != http.StatusNoContent {
		t.Fatalf("safe content type status = %d", safeResult.Code)
	}
	got := request(t, handler, http.MethodGet, "/api/blobs/safe", nil)
	if got.Header().Get("X-Content-Type-Options") != "nosniff" || got.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("blob response headers = %#v", got.Header())
	}
}

func TestEncryptedSecretLifecycle(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	MountServer(r, server)
	plain := []byte(`{"apiKeys":{"channel":{"text":"sk-secret"}},"webdavPass":"dav-secret"}`)
	if got := request(t, r, http.MethodPut, "/api/secrets/config", plain); got.Code != http.StatusNoContent {
		t.Fatalf("put secrets: %d %s", got.Code, got.Body.String())
	}
	stored := backend.state[secretStateKey]
	if bytes.Contains(stored, []byte("sk-secret")) || bytes.Contains(stored, []byte("dav-secret")) {
		t.Fatal("plaintext secret persisted")
	}
	got := request(t, r, http.MethodGet, "/api/secrets/config", nil)
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), plain) {
		t.Fatalf("get secrets: %d %s", got.Code, got.Body.String())
	}
	if got.Header().Get("Cache-Control") != "no-store" || got.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("secret cache headers = %#v", got.Header())
	}
}
