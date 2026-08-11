package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestTenantAdminStoragePoolIsEncryptedPreferredAndKeepsDeletedPlacements(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	var mu sync.Mutex
	objects := map[string][]byte{}
	metadata := map[string]string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=tenant-access/") {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		key := path.Base(r.URL.Path)
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[key] = body
			metadata[key] = r.Header.Get(s3BlobMetadataHeader)
			w.Header().Set("ETag", `"tenant-version"`)
		case http.MethodGet:
			body, ok := objects[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("ETag", `"tenant-version"`)
			w.Header().Set(s3BlobMetadataHeader, metadata[key])
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer upstream.Close()

	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	processStore := newMemoryBlobObjectStore()
	server.setBlobObjectStore(processStore)
	router := chi.NewRouter()
	MountServer(router, server)

	config := []byte(`[{"id":"tenant-main","endpoint":"` + upstream.URL + `","bucket":"tenant-bucket","region":"auto","prefix":"tenant-prefix","weight":7,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", config); got.Code != http.StatusOK {
		t.Fatalf("put pool = %d %s", got.Code, got.Body.String())
	}
	secret := []byte(`{"accessKeyId":"tenant-access","secretAccessKey":"tenant-secret","sessionToken":"tenant-session"}`)
	if got := request(t, router, http.MethodPut, "/api/admin/storage-pool/tenant-main/secret", secret); got.Code != http.StatusNoContent {
		t.Fatalf("put secret = %d %s", got.Code, got.Body.String())
	}
	stored := backend.state[tenantKey(store.DefaultTenantID, tenantStoragePoolSecretsStateKey)]
	if bytes.Contains(stored, []byte("tenant-access")) || bytes.Contains(stored, []byte("tenant-secret")) || len(stored) == 0 {
		t.Fatalf("credentials not encrypted: %s", stored)
	}
	listed := request(t, router, http.MethodGet, "/api/admin/storage-pool", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"secretConfigured": true`)) || bytes.Contains(listed.Body.Bytes(), []byte("tenant-secret")) {
		t.Fatalf("unsafe list = %d %s", listed.Code, listed.Body.String())
	}

	if err := server.storeTenantBlob(context.Background(), store.DefaultTenantID, "user", "pool-object", "image/png", []byte("tenant-value")); err != nil {
		t.Fatal(err)
	}
	if len(processStore.objects) != 0 {
		t.Fatal("process fallback won over tenant pool")
	}
	if len(objects) == 0 {
		t.Fatalf("tenant pool did not receive object: %#v", objects)
	}

	// Deletion is an admin-facing tombstone: it disables future selection but
	// retains the provider and credential for immutable old placements.
	if got := deleteAdminConfigForTest(t, router, "/api/admin/storage-pool", "/api/admin/storage-pool/tenant-main"); got.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", got.Code, got.Body.String())
	}
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", config); got.Code != http.StatusConflict {
		t.Fatalf("reusing tombstoned id = %d %s", got.Code, got.Body.String())
	}
	value, err := server.readTenantBlob(context.Background(), store.DefaultTenantID, "pool-object", maxUploadBytes)
	if err != nil || !bytes.Equal(value.Data, []byte("tenant-value")) {
		t.Fatalf("read deleted placement = %#v, %v", value, err)
	}
	if err := server.storeTenantBlob(context.Background(), store.DefaultTenantID, "user", "post-delete-object", "image/png", []byte("process-value")); err != nil {
		t.Fatal(err)
	}
	if len(processStore.objects) != 1 {
		t.Fatalf("tombstoned provider became selectable again: process objects = %#v", processStore.objects)
	}
}

func TestTenantStoragePoolRejectsStableIDRebinding(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	first := []byte(`[{"id":"stable","endpoint":"http://127.0.0.1:9000","bucket":"bucket-one","region":"auto","prefix":"openboard","weight":1,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", first); got.Code != http.StatusOK {
		t.Fatalf("first = %d %s", got.Code, got.Body.String())
	}
	rebound := []byte(`[{"id":"stable","endpoint":"http://127.0.0.1:9000","bucket":"bucket-two","region":"auto","prefix":"openboard","weight":1,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", rebound); got.Code != http.StatusConflict {
		t.Fatalf("rebind = %d %s", got.Code, got.Body.String())
	}
}

func TestTenantStoragePoolAdminRoutesRejectMembersAndStayTenantScoped(t *testing.T) {
	backend := newMemoryStore()
	member := store.AuthUser{ID: "member", TenantID: "tenant-a", Role: "member", Status: "active"}
	seedAdminUser(backend, member)
	memberHandler := tenantAdminHandler(t, backend, member)
	for _, item := range []struct {
		method, path string
		body         []byte
	}{
		{http.MethodGet, "/api/admin/storage-pool", nil},
		{http.MethodPut, "/api/admin/storage-pool", []byte(`[]`)},
		{http.MethodPut, "/api/admin/storage-pool/provider/secret", []byte(`{"accessKeyId":"a","secretAccessKey":"b"}`)},
		{http.MethodDelete, "/api/admin/storage-pool/provider", nil},
	} {
		if got := request(t, memberHandler, item.method, item.path, item.body); got.Code != http.StatusForbidden {
			t.Fatalf("member %s %s = %d", item.method, item.path, got.Code)
		}
	}

	owner := store.AuthUser{ID: "owner", TenantID: "tenant-b", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	ownerHandler := tenantAdminHandler(t, backend, owner)
	config := []byte(`[{"id":"isolated","endpoint":"http://127.0.0.1:9000","bucket":"tenant-bucket","region":"auto","prefix":"openboard","weight":1,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, ownerHandler, "/api/admin/storage-pool", config); got.Code != http.StatusOK {
		t.Fatalf("owner put = %d %s", got.Code, got.Body.String())
	}
	if len(backend.state[tenantKey("tenant-a", tenantStoragePoolStateKey)]) != 0 || len(backend.state[tenantKey("tenant-b", tenantStoragePoolStateKey)]) == 0 {
		t.Fatal("storage pool state crossed tenant boundary")
	}
}

func TestTenantWebDAVStoragePoolIsFeatureGatedEncryptedAndSelectable(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	t.Setenv(webDAVMediaFeatureEnv, "true")
	var mu sync.Mutex
	objects := map[string][]byte{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "dav-user" || password != "dav-secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodHead:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = body
			w.Header().Set("ETag", `"dav-v1"`)
			w.WriteHeader(http.StatusCreated)
		case http.MethodGet:
			body, exists := objects[r.URL.Path]
			if !exists {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("ETag", `"dav-v1"`)
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer upstream.Close()

	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	config := []byte(`[{"id":"tenant-dav","kind":"webdav","endpoint":"` + upstream.URL + `/dav","prefix":"media","weight":1,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", config); got.Code != http.StatusOK {
		t.Fatalf("put WebDAV = %d %s", got.Code, got.Body.String())
	}
	secret := []byte(`{"username":"dav-user","password":"dav-secret"}`)
	if got := request(t, router, http.MethodPut, "/api/admin/storage-pool/tenant-dav/secret", secret); got.Code != http.StatusNoContent {
		t.Fatalf("secret = %d %s", got.Code, got.Body.String())
	}
	stored := backend.state[tenantKey(store.DefaultTenantID, tenantStoragePoolSecretsStateKey)]
	if bytes.Contains(stored, []byte("dav-secret")) || bytes.Contains(stored, []byte("dav-user")) {
		t.Fatalf("WebDAV secret leaked: %s", stored)
	}
	if err := server.storeTenantBlob(t.Context(), store.DefaultTenantID, "user", "webdav-image", "image/png", []byte("dav-image")); err != nil {
		t.Fatal(err)
	}
	if len(objects) != 1 {
		t.Fatalf("WebDAV did not receive media: %#v", objects)
	}
	loaded, err := server.readTenantBlob(t.Context(), store.DefaultTenantID, "webdav-image", maxUploadBytes)
	if err != nil || string(loaded.Data) != "dav-image" {
		t.Fatalf("read=%#v err=%v", loaded, err)
	}
	listed := request(t, router, http.MethodGet, "/api/admin/storage-pool", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"kind":"webdav"`)) || bytes.Contains(listed.Body.Bytes(), []byte("dav-user")) {
		t.Fatalf("list=%d %s", listed.Code, listed.Body.String())
	}
}

func TestTenantWebDAVStoragePoolFailsClosedWhenFeatureDisabled(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	t.Setenv(webDAVMediaFeatureEnv, "false")
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.SetProcessToken("test-token")
	router := chi.NewRouter()
	MountServer(router, server)
	config := []byte(`[{"id":"tenant-dav","kind":"webdav","endpoint":"http://127.0.0.1:8080/dav","prefix":"media","weight":1,"healthy":true,"allowInsecureLoopback":true}]`)
	if got := putAdminConfigForTest(t, router, "/api/admin/storage-pool", config); got.Code != http.StatusNotFound {
		t.Fatalf("disabled WebDAV = %d %s", got.Code, got.Body.String())
	}
}
