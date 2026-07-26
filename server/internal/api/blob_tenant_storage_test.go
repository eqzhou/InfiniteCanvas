package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

func TestUserObjectStorageRoutesProtectedBlobs(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")

	var (
		mu      sync.Mutex
		objects = map[string][]byte{}
		meta    = map[string]string{}
		etag    = map[string]string{}
		puts    int
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenantHash := sha256.Sum256([]byte(store.DefaultTenantID))
		expectedPrefix := "/user-bucket/user-prefix/tenants/" + hex.EncodeToString(tenantHash[:]) + "/"
		if !strings.HasPrefix(r.URL.Path, expectedPrefix) {
			t.Errorf("path = %q", r.URL.Path)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=user-access/") {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		key := path.Base(r.URL.Path)
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			puts++
			body, _ := io.ReadAll(r.Body)
			objects[key] = append([]byte(nil), body...)
			meta[key] = r.Header.Get(s3BlobMetadataHeader)
			etag[key] = `"user-` + key[:8] + `"`
			w.Header().Set("ETag", etag[key])
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			body, ok := objects[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set(s3BlobMetadataHeader, meta[key])
			w.Header().Set("ETag", etag[key])
			_, _ = w.Write(body)
		case http.MethodDelete:
			delete(objects, key)
			delete(meta, key)
			delete(etag, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer upstream.Close()

	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	// Process-level object storage must lose to the tenant preference.
	processStore := newMemoryBlobObjectStore()
	server.setBlobObjectStore(processStore)

	config, _ := json.Marshal(map[string]any{
		"objectStorage": map[string]any{
			"enabled":               true,
			"endpoint":              upstream.URL,
			"bucket":                "user-bucket",
			"region":                "auto",
			"prefix":                "user-prefix",
			"allowInsecureLoopback": true,
		},
	})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	secrets, _ := json.Marshal(storedConfigSecrets{
		APIKeys:                      map[string]map[string]string{},
		ObjectStorageAccessKeyID:     "user-access",
		ObjectStorageSecretAccessKey: "user-secret",
	})
	r := chi.NewRouter()
	MountServer(r, server)
	if got := request(t, r, http.MethodPut, "/api/secrets/config", secrets); got.Code != http.StatusNoContent {
		t.Fatalf("put secrets: %d %s", got.Code, got.Body.String())
	}

	ctx := context.Background()
	if err := server.storeTenantBlob(ctx, store.DefaultTenantID, "user-1", "user-media", "image/png", []byte("tenant-png")); err != nil {
		t.Fatalf("store: %v", err)
	}
	mu.Lock()
	if puts == 0 || len(objects) == 0 {
		mu.Unlock()
		t.Fatal("user object storage was not used")
	}
	mu.Unlock()
	if len(processStore.objects) != 0 {
		t.Fatalf("process-level store used: %#v", processStore.objects)
	}
	got, err := server.readTenantBlob(ctx, store.DefaultTenantID, "user-media", maxUploadBytes)
	if err != nil || !bytes.Equal(got.Data, []byte("tenant-png")) || got.Metadata.ContentType != "image/png" {
		t.Fatalf("read = %#v, %v", got, err)
	}
	if err := server.deleteTenantBlob(ctx, store.DefaultTenantID, "user-1", "user-media"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	mu.Lock()
	remaining := len(objects)
	mu.Unlock()
	if remaining != 0 {
		t.Fatalf("user object storage still has %d objects", remaining)
	}
	if _, err := server.readTenantBlob(ctx, store.DefaultTenantID, "user-media", maxUploadBytes); err == nil {
		t.Fatal("deleted blob still readable")
	}
}

func TestUserObjectStorageRejectsInvalidCredentialsAndFallsBackWhenDisabled(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")

	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	processStore := newMemoryBlobObjectStore()
	server.setBlobObjectStore(processStore)

	config, _ := json.Marshal(map[string]any{
		"objectStorage": map[string]any{
			"enabled":  true,
			"endpoint": "https://example.r2.cloudflarestorage.com",
			"bucket":   "user-bucket",
			"region":   "auto",
			"prefix":   "user-prefix",
		},
	})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", config); err != nil {
		t.Fatal(err)
	}
	// Missing credentials must fail closed instead of silently writing to process storage.
	if err := server.storeTenantBlob(context.Background(), store.DefaultTenantID, "user-1", "missing-creds", "image/png", []byte("x")); err == nil {
		t.Fatal("enabled user storage without credentials accepted")
	}
	if len(processStore.objects) != 0 {
		t.Fatalf("process store used after invalid user config: %#v", processStore.objects)
	}

	disabled, _ := json.Marshal(map[string]any{
		"objectStorage": map[string]any{
			"enabled":  false,
			"endpoint": "https://example.r2.cloudflarestorage.com",
			"bucket":   "user-bucket",
			"region":   "auto",
			"prefix":   "user-prefix",
		},
	})
	if err := backend.PutState(context.Background(), store.DefaultTenantID, "config", disabled); err != nil {
		t.Fatal(err)
	}
	server.InvalidateTenantBlobStore(store.DefaultTenantID)
	if err := server.storeTenantBlob(context.Background(), store.DefaultTenantID, "user-1", "fallback", "image/png", []byte("fallback-png")); err != nil {
		t.Fatalf("disabled user storage should fall back: %v", err)
	}
	if len(processStore.objects) == 0 {
		t.Fatal("process-level store was not used after user storage disabled")
	}
}

func TestObjectStorageConfigFromTenantRejectsUnsafeValues(t *testing.T) {
	validConfig := storedObjectStorageConfig{
		Enabled:  true,
		Endpoint: "https://example.r2.cloudflarestorage.com",
		Bucket:   "user-bucket",
		Region:   "auto",
		Prefix:   "openboard",
	}
	validSecrets := storedConfigSecrets{
		ObjectStorageAccessKeyID:     "access",
		ObjectStorageSecretAccessKey: "secret",
	}
	if _, err := objectStorageConfigFromTenant(validConfig, validSecrets); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for name, mutate := range map[string]func(*storedObjectStorageConfig, *storedConfigSecrets){
		"http remote": func(c *storedObjectStorageConfig, _ *storedConfigSecrets) { c.Endpoint = "http://example.com" },
		"endpoint credentials": func(c *storedObjectStorageConfig, _ *storedConfigSecrets) {
			c.Endpoint = "https://user:pass@example.com"
		},
		"bad bucket":     func(c *storedObjectStorageConfig, _ *storedConfigSecrets) { c.Bucket = "../bucket" },
		"bad prefix":     func(c *storedObjectStorageConfig, _ *storedConfigSecrets) { c.Prefix = "../openboard" },
		"missing secret": func(_ *storedObjectStorageConfig, s *storedConfigSecrets) { s.ObjectStorageSecretAccessKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			config := validConfig
			secrets := validSecrets
			mutate(&config, &secrets)
			if _, err := objectStorageConfigFromTenant(config, secrets); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
}

func TestTenantObjectStorageDestinationCannotBeReboundOrDisabled(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	current := []byte(`{"objectStorage":{"enabled":true,"endpoint":"https://storage.example.com","bucket":"user-bucket","region":"auto","prefix":"openboard"},"theme":"light"}`)
	if err := backend.PutState(t.Context(), "tenant-a", "config", current); err != nil {
		t.Fatal(err)
	}
	sameDestination := []byte(`{"objectStorage":{"enabled":true,"endpoint":"https://storage.example.com/","bucket":"user-bucket","region":"auto","prefix":"openboard"},"theme":"dark"}`)
	if err := server.preventTenantObjectStorageRebind(t.Context(), "tenant-a", sameDestination); err != nil {
		t.Fatalf("same destination rejected: %v", err)
	}
	for name, next := range map[string][]byte{
		"rebind":  []byte(`{"objectStorage":{"enabled":true,"endpoint":"https://storage.example.com","bucket":"other-bucket","region":"auto","prefix":"openboard"}}`),
		"disable": []byte(`{"objectStorage":{"enabled":false,"endpoint":"https://storage.example.com","bucket":"user-bucket","region":"auto","prefix":"openboard"}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := server.preventTenantObjectStorageRebind(t.Context(), "tenant-a", next); !errors.Is(err, errTenantObjectStorageRebind) {
				t.Fatalf("destination change error = %v", err)
			}
		})
	}
}
