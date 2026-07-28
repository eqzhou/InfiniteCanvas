package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestRuntimeFilesAreIsolatedByTenant(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_TOKEN", "")
	dataDir := t.TempDir()
	backend := newMemoryStore()
	server := NewServerWithStore(dataDir, backend)
	t.Cleanup(server.Close)

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenantID := r.Header.Get("X-Test-Tenant")
			if tenantID != "" {
				actor := store.AuthUser{
					ID: "user-" + tenantID, TenantID: tenantID, Role: "member", Status: "active",
				}
				r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			}
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, server)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "snapshot.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("tenant-a-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	upload := httptest.NewRequest(http.MethodPost, "/api/files", &body)
	upload.Header.Set("Content-Type", writer.FormDataContentType())
	upload.Header.Set("X-Test-Tenant", "tenant-a")
	uploaded := httptest.NewRecorder()
	router.ServeHTTP(uploaded, upload)
	if uploaded.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	var response struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(uploaded.Body.Bytes(), &response); err != nil || response.Name == "" || response.URL == "" {
		t.Fatalf("upload response=%s err=%v", uploaded.Body.String(), err)
	}

	stored := filepath.Join(dataDir, "files", "tenant-a", response.Name)
	if _, err := os.Stat(stored); err != nil {
		t.Fatalf("tenant-a file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "files", response.Name)); !os.IsNotExist(err) {
		t.Fatalf("unscoped legacy file path should not exist, err=%v", err)
	}

	sameTenant := httptest.NewRequest(http.MethodGet, response.URL, nil)
	sameTenant.Header.Set("X-Test-Tenant", "tenant-a")
	same := httptest.NewRecorder()
	router.ServeHTTP(same, sameTenant)
	if same.Code != http.StatusOK || same.Body.String() != "tenant-a-bytes" {
		t.Fatalf("same-tenant read status=%d body=%s", same.Code, same.Body.String())
	}

	crossTenant := httptest.NewRequest(http.MethodGet, response.URL, nil)
	crossTenant.Header.Set("X-Test-Tenant", "tenant-b")
	cross := httptest.NewRecorder()
	router.ServeHTTP(cross, crossTenant)
	if cross.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant read status=%d body=%s, want 404", cross.Code, cross.Body.String())
	}
}
