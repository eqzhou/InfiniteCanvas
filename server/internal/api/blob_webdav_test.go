package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestWebDAVBlobObjectStoreCRUDAndCAS(t *testing.T) {
	type entry struct {
		body    []byte
		version int
	}
	var mu sync.Mutex
	objects := map[string]entry{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "dav-user" || pass != "dav-pass" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		current, exists := objects[r.URL.Path]
		switch r.Method {
		case http.MethodHead:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			if !exists {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("ETag", fmt.Sprintf(`"v%d"`, current.version))
			_, _ = w.Write(current.body)
		case http.MethodPut:
			if r.Header.Get("If-None-Match") == "*" && exists {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			if match := r.Header.Get("If-Match"); match != "" && match != fmt.Sprintf(`"v%d"`, current.version) {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			body, _ := io.ReadAll(r.Body)
			current = entry{body: body, version: current.version + 1}
			objects[r.URL.Path] = current
			w.Header().Set("ETag", fmt.Sprintf(`"v%d"`, current.version))
			w.WriteHeader(http.StatusCreated)
		case http.MethodDelete:
			if !exists {
				http.NotFound(w, r)
				return
			}
			if match := r.Header.Get("If-Match"); match != "" && match != fmt.Sprintf(`"v%d"`, current.version) {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			delete(objects, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer upstream.Close()

	objectsStore, err := newWebDAVBlobObjectStore(WebDAVBlobStorageConfig{
		Endpoint: upstream.URL + "/dav", Username: "dav-user", Password: "dav-pass",
		Prefix: "openboard", AllowInsecureLoopback: true, HTTPClient: upstream.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := objectsStore.Ping(t.Context()); err != nil {
		t.Fatal(err)
	}
	value := blobObject{Data: []byte("pixels"), Metadata: blobMetadata{ContentType: "image/png"}}
	version, err := objectsStore.Put(t.Context(), "tenant-a", "image:test", value, blobVersionAbsent)
	if err != nil || version != `"v1"` {
		t.Fatalf("put version=%q err=%v", version, err)
	}
	if _, err := objectsStore.Put(t.Context(), "tenant-a", "image:test", value, blobVersionAbsent); !errorsIs(err, errBlobObjectConflict) {
		t.Fatalf("create conflict=%v", err)
	}
	loaded, err := objectsStore.Get(t.Context(), "tenant-a", "image:test", 1024)
	if err != nil || string(loaded.Data) != "pixels" || loaded.Metadata.ContentType != "image/png" || loaded.Version != version {
		t.Fatalf("get=%#v err=%v", loaded, err)
	}
	if _, err := objectsStore.Get(t.Context(), "tenant-a", "image:test", 2); !errorsIs(err, errBlobObjectTooLarge) {
		t.Fatalf("size error=%v", err)
	}
	if err := objectsStore.Delete(t.Context(), "tenant-a", "image:test", `"stale"`); !errorsIs(err, errBlobObjectConflict) {
		t.Fatalf("delete conflict=%v", err)
	}
	if err := objectsStore.Delete(t.Context(), "tenant-a", "image:test", version); err != nil {
		t.Fatal(err)
	}
	if _, err := objectsStore.Get(t.Context(), "tenant-a", "image:test", 1024); !errorsIs(err, store.ErrNotFound) {
		t.Fatalf("missing=%v", err)
	}
	for path := range objects {
		if strings.Contains(path, "tenant-a") || strings.Contains(path, "dav-pass") {
			t.Fatalf("path leaked tenant or secret: %s", path)
		}
	}
}

func TestWebDAVBlobObjectStoreCreatesParentCollectionsBeforePut(t *testing.T) {
	type entry struct {
		body    []byte
		version int
	}
	var mu sync.Mutex
	collections := map[string]bool{"/dav": true}
	objects := map[string]entry{}
	mkcolCalls := make(map[string]int)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "dav-user" || pass != "dav-pass" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case "MKCOL":
			mkcolCalls[r.URL.Path]++
			if r.ContentLength > 0 {
				http.Error(w, "MKCOL body is not allowed", http.StatusUnsupportedMediaType)
				return
			}
			if collections[r.URL.Path] {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if !collections[path.Dir(r.URL.Path)] {
				http.Error(w, "parent collection missing", http.StatusConflict)
				return
			}
			collections[r.URL.Path] = true
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			if !collections[path.Dir(r.URL.Path)] {
				http.Error(w, "parent collection missing", http.StatusConflict)
				return
			}
			body, _ := io.ReadAll(r.Body)
			current := objects[r.URL.Path]
			current.body, current.version = body, current.version+1
			objects[r.URL.Path] = current
			w.Header().Set("ETag", fmt.Sprintf(`"v%d"`, current.version))
			w.WriteHeader(http.StatusCreated)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer upstream.Close()

	objectStore, err := newWebDAVBlobObjectStore(WebDAVBlobStorageConfig{
		Endpoint: upstream.URL + "/dav", Username: "dav-user", Password: "dav-pass",
		Prefix: "openboard/media", AllowInsecureLoopback: true, HTTPClient: upstream.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	value := blobObject{Data: []byte("pixels"), Metadata: blobMetadata{ContentType: "image/png"}}
	for _, name := range []string{"nested/first", "nested/second"} {
		if _, err := objectStore.Put(t.Context(), "tenant-a", name, value, blobVersionAbsent); err != nil {
			t.Fatalf("put %s: %v", name, err)
		}
	}

	objectURL, err := objectStore.objectURL("tenant-a", "nested/first")
	if err != nil {
		t.Fatal(err)
	}
	for collection := path.Dir(objectURL.Path); collection != "/dav"; collection = path.Dir(collection) {
		if !collections[collection] || mkcolCalls[collection] == 0 {
			t.Fatalf("parent collection was not created: %s (collections=%v calls=%v)", collection, collections, mkcolCalls)
		}
	}
	if len(objects) != 2 {
		t.Fatalf("stored objects = %d, want 2", len(objects))
	}
}

func TestWebDAVBlobObjectStoreCreatesCollectionsFromRootEndpoint(t *testing.T) {
	collections := map[string]bool{"/": true}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "MKCOL":
			if !collections[path.Dir(r.URL.Path)] {
				http.Error(w, "parent collection missing", http.StatusConflict)
				return
			}
			if collections[r.URL.Path] {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			collections[r.URL.Path] = true
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			if !collections[path.Dir(r.URL.Path)] {
				http.Error(w, "parent collection missing", http.StatusConflict)
				return
			}
			w.Header().Set("ETag", `"v1"`)
			w.WriteHeader(http.StatusCreated)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer upstream.Close()

	objectStore, err := newWebDAVBlobObjectStore(WebDAVBlobStorageConfig{
		Endpoint: upstream.URL, Username: "dav-user", Password: "dav-pass",
		Prefix: "openboard", AllowInsecureLoopback: true, HTTPClient: upstream.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	value := blobObject{Data: []byte("pixels"), Metadata: blobMetadata{ContentType: "image/png"}}
	if _, err := objectStore.Put(t.Context(), "tenant-a", "nested/image", value, blobVersionAbsent); err != nil {
		t.Fatalf("put from root endpoint: %v", err)
	}
}

func TestWebDAVBlobObjectStoreRejectsUnsafeEndpoints(t *testing.T) {
	tests := []WebDAVBlobStorageConfig{
		{Endpoint: "http://dav.example.com/root", Username: "u", Password: "p"},
		{Endpoint: "https://127.0.0.1/root", Username: "u", Password: "p"},
		{Endpoint: "https://169.254.169.254/root", Username: "u", Password: "p", AllowPrivate: true},
		{Endpoint: "https://user:pass@dav.example.com/root", Username: "u", Password: "p"},
		{Endpoint: "https://dav.example.com/root?token=secret", Username: "u", Password: "p"},
	}
	for _, config := range tests {
		if _, err := newWebDAVBlobObjectStore(config); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", config.Endpoint)
		}
	}
}

func TestSafeWebDAVDialRejectsDNSRebinding(t *testing.T) {
	dial := safeWebDAVDialContext(false, false, func(context.Context, string, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("203.0.113.10"), net.ParseIP("127.0.0.1")}, nil
	}, func(context.Context, string, string) (net.Conn, error) { return nil, nil })
	if _, err := dial(t.Context(), "tcp", "dav.example:443"); err == nil {
		t.Fatal("mixed DNS answer accepted")
	}
}

func errorsIs(err, target error) bool { return errors.Is(err, target) }
