package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type memoryBlobObjectStore struct {
	mu      sync.Mutex
	objects map[string]blobObject
	version int
}

type flakyReleaseStore struct {
	*memoryStore
	muFailures   sync.Mutex
	failReleases int
}

func (f *flakyReleaseStore) ReleaseStorageUsage(ctx context.Context, tenantID, userID string, bytes int64, meta json.RawMessage) error {
	f.muFailures.Lock()
	if f.failReleases > 0 {
		f.failReleases--
		f.muFailures.Unlock()
		return errors.New("temporary quota ledger failure")
	}
	f.muFailures.Unlock()
	return f.memoryStore.ReleaseStorageUsage(ctx, tenantID, userID, bytes, meta)
}

func newMemoryBlobObjectStore() *memoryBlobObjectStore {
	return &memoryBlobObjectStore{objects: make(map[string]blobObject)}
}

func (m *memoryBlobObjectStore) Kind() string { return "memory-s3" }

func (m *memoryBlobObjectStore) Ping(context.Context) error { return nil }

func (m *memoryBlobObjectStore) Get(_ context.Context, tenantID, name string, limit int64) (blobObject, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.objects[tenantKey(tenantID, name)]
	if !ok {
		return blobObject{}, store.ErrNotFound
	}
	if int64(len(value.Data)) > limit {
		return blobObject{}, errBlobObjectTooLarge
	}
	value.Data = append([]byte(nil), value.Data...)
	return value, nil
}

func (m *memoryBlobObjectStore) Put(_ context.Context, tenantID, name string, value blobObject, expectedVersion string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, name)
	current, exists := m.objects[key]
	if expectedVersion == blobVersionAbsent && exists {
		return "", errBlobObjectConflict
	}
	if expectedVersion != "" && expectedVersion != blobVersionAbsent && (!exists || current.Version != expectedVersion) {
		return "", errBlobObjectConflict
	}
	m.version++
	value.Data = append([]byte(nil), value.Data...)
	value.Version = strings.Repeat("v", m.version)
	m.objects[key] = value
	return value.Version, nil
}

func (m *memoryBlobObjectStore) Delete(_ context.Context, tenantID, name, expectedVersion string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, name)
	current, exists := m.objects[key]
	if !exists {
		return nil
	}
	if expectedVersion != "" && current.Version != expectedVersion {
		return errBlobObjectConflict
	}
	delete(m.objects, key)
	return nil
}

func TestObjectBlobLifecycleIsTenantIsolatedAndReleasesQuota(t *testing.T) {
	backend := newMemoryStore()
	objects := newMemoryBlobObjectStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.setBlobObjectStore(objects)

	ctx := context.Background()
	for tenantID, value := range map[string]string{"tenant-a": "first", "tenant-b": "second"} {
		if err := server.storeTenantBlob(ctx, tenantID, "user", "shared", "image/png", []byte(value)); err != nil {
			t.Fatalf("store %s: %v", tenantID, err)
		}
	}
	for tenantID, expected := range map[string]string{"tenant-a": "first", "tenant-b": "second"} {
		object, err := server.readTenantBlob(ctx, tenantID, "shared", maxUploadBytes)
		if err != nil || string(object.Data) != expected || object.Metadata.ContentType != "image/png" {
			t.Fatalf("read %s = %#v, %v", tenantID, object, err)
		}
		if err := server.deleteTenantBlob(ctx, tenantID, "user", "shared"); err != nil {
			t.Fatalf("delete %s: %v", tenantID, err)
		}
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after object deletes = %d", usage)
	}
}

func TestObjectBlobOverwriteKeepsLatestValueAndOneReservation(t *testing.T) {
	backend := newMemoryStore()
	objects := newMemoryBlobObjectStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.setBlobObjectStore(objects)

	ctx := context.Background()
	for _, value := range []string{"first", "second-value"} {
		if err := server.storeTenantBlob(ctx, "tenant", "user", "same", "image/png", []byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := server.readTenantBlob(ctx, "tenant", "same", maxUploadBytes)
	if err != nil || string(got.Data) != "second-value" {
		t.Fatalf("latest object = %#v, %v", got, err)
	}
	if err := server.deleteTenantBlob(ctx, "tenant", "user", "same"); err != nil {
		t.Fatal(err)
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after overwrite/delete = %d", usage)
	}
}

func TestObjectBlobProtectedHTTPAPI(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	objects := newMemoryBlobObjectStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	server.setBlobObjectStore(objects)
	router := chi.NewRouter()
	MountServer(router, server)

	put := httptest.NewRequest(http.MethodPut, "/api/blobs/image%3Aremote", bytes.NewReader([]byte("abcdef")))
	put.Header.Set("Content-Type", "image/png")
	put.Header.Set("Authorization", "Bearer test-token")
	putResult := httptest.NewRecorder()
	router.ServeHTTP(putResult, put)
	if putResult.Code != http.StatusNoContent {
		t.Fatalf("put = %d %s", putResult.Code, putResult.Body.String())
	}
	rangeRequest := httptest.NewRequest(http.MethodGet, "/api/blobs/image%3Aremote", nil)
	rangeRequest.Header.Set("Range", "bytes=1-3")
	rangeRequest.Header.Set("Authorization", "Bearer test-token")
	rangeResult := httptest.NewRecorder()
	router.ServeHTTP(rangeResult, rangeRequest)
	if rangeResult.Code != http.StatusPartialContent || rangeResult.Body.String() != "bcd" || rangeResult.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("range = %d %q %#v", rangeResult.Code, rangeResult.Body.String(), rangeResult.Header())
	}
	if deleted := request(t, router, http.MethodDelete, "/api/blobs/image%3Aremote", nil); deleted.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
	if missing := request(t, router, http.MethodGet, "/api/blobs/image%3Aremote", nil); missing.Code != http.StatusNotFound {
		t.Fatalf("get deleted = %d %s", missing.Code, missing.Body.String())
	}
}

func TestObjectBlobPendingMetadataRecoversQuotaAfterLedgerFailure(t *testing.T) {
	backend := &flakyReleaseStore{memoryStore: newMemoryStore()}
	objects := newMemoryBlobObjectStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.setBlobObjectStore(objects)
	ctx := context.Background()

	if err := server.storeTenantBlob(ctx, "tenant", "user", "same", "image/png", []byte("first")); err != nil {
		t.Fatal(err)
	}
	backend.failReleases = 1
	if err := server.storeTenantBlob(ctx, "tenant", "user", "same", "image/png", []byte("second")); err == nil {
		t.Fatal("ledger failure was not reported")
	}
	visible, err := server.readTenantBlob(ctx, "tenant", "same", maxUploadBytes)
	if err != nil || string(visible.Data) != "second" || len(visible.Metadata.Superseded) == 0 {
		t.Fatalf("pending object = %#v, %v", visible, err)
	}
	if err := server.storeTenantBlob(ctx, "tenant", "user", "same", "image/png", []byte("second")); err != nil {
		t.Fatalf("retry overwrite: %v", err)
	}
	if err := server.deleteTenantBlob(ctx, "tenant", "user", "same"); err != nil {
		t.Fatal(err)
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after recovery = %d", usage)
	}
}

func TestObjectBlobDeleteTombstoneSurvivesLedgerFailure(t *testing.T) {
	backend := &flakyReleaseStore{memoryStore: newMemoryStore()}
	objects := newMemoryBlobObjectStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.setBlobObjectStore(objects)
	ctx := context.Background()

	if err := server.storeTenantBlob(ctx, "tenant", "user", "same", "image/png", []byte("value")); err != nil {
		t.Fatal(err)
	}
	backend.failReleases = 1
	if err := server.deleteTenantBlob(ctx, "tenant", "user", "same"); err == nil {
		t.Fatal("ledger failure was not reported")
	}
	if _, err := server.readTenantBlob(ctx, "tenant", "same", maxUploadBytes); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("tombstone remained visible: %v", err)
	}
	if err := server.deleteTenantBlob(ctx, "tenant", "user", "same"); err != nil {
		t.Fatalf("retry delete: %v", err)
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after tombstone cleanup = %d", usage)
	}
}

func TestS3BlobStoreSignsProtectedPathAndRoundTripsMetadata(t *testing.T) {
	var stored []byte
	var metadata string
	var putCount int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bucket/openboard/tenants/e9da86d351cf9a7642d8c50195c3f466220911a15c177809bd1161a51e8c5f24/blob-name" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=access/") {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.Method {
		case http.MethodPut:
			putCount++
			if putCount == 1 && r.Header.Get("If-None-Match") != "*" {
				t.Errorf("put If-None-Match = %q", r.Header.Get("If-None-Match"))
			}
			stored, _ = io.ReadAll(r.Body)
			metadata = r.Header.Get(s3BlobMetadataHeader)
			w.Header().Set("ETag", `"one"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set(s3BlobMetadataHeader, metadata)
			w.Header().Set("ETag", `"one"`)
			_, _ = w.Write(stored)
		case http.MethodDelete:
			if r.Header.Get("If-Match") != `"one"` {
				t.Errorf("delete If-Match = %q", r.Header.Get("If-Match"))
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer upstream.Close()

	objectStore, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: upstream.URL, Bucket: "bucket", Region: "auto", Prefix: "openboard",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	input := blobObject{Data: []byte("png"), Metadata: blobMetadata{
		ContentType: "image/png", Reservation: blobReservation{ID: "reservation", Bytes: 123},
	}}
	version, err := objectStore.Put(context.Background(), "tenant", "blob-name", input, blobVersionAbsent)
	if err != nil || version != `"one"` {
		t.Fatalf("put = %q, %v", version, err)
	}
	got, err := objectStore.Get(context.Background(), "tenant", "blob-name", 10)
	if err != nil || !bytes.Equal(got.Data, input.Data) || got.Metadata.Reservation != input.Metadata.Reservation {
		t.Fatalf("get = %#v, %v", got, err)
	}
	if err := objectStore.Delete(context.Background(), "tenant", "blob-name", got.Version); err != nil {
		t.Fatal(err)
	}
}

func TestS3SignatureMatchesAWSPublishedGetObjectVector(t *testing.T) {
	objectStore := &s3BlobObjectStore{
		region: "us-east-1", accessKeyID: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		now:             func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) },
	}
	request := httptest.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	request.Header.Set("Range", "bytes=0-9")
	objectStore.sign(request, nil)
	const expected = "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := request.Header.Get("Authorization"); got != expected {
		t.Fatalf("authorization = %q", got)
	}
}

func TestS3BlobStoreRejectsUnsafeOrIncompleteConfiguration(t *testing.T) {
	valid := S3BlobStorageConfig{
		Endpoint: "https://example.r2.cloudflarestorage.com", Bucket: "bucket", Region: "auto",
		AccessKeyID: "access", SecretAccessKey: "secret",
	}
	for name, mutate := range map[string]func(*S3BlobStorageConfig){
		"http remote endpoint": func(value *S3BlobStorageConfig) { value.Endpoint = "http://example.com" },
		"https loopback ip":    func(value *S3BlobStorageConfig) { value.Endpoint = "https://127.0.0.1" },
		"https private ip":     func(value *S3BlobStorageConfig) { value.Endpoint = "https://10.0.0.1" },
		"https link local ip":  func(value *S3BlobStorageConfig) { value.Endpoint = "https://169.254.169.254" },
		"https cgnat ip":       func(value *S3BlobStorageConfig) { value.Endpoint = "https://100.64.0.1" },
		"endpoint credentials": func(value *S3BlobStorageConfig) { value.Endpoint = "https://user:pass@example.com" },
		"missing bucket":       func(value *S3BlobStorageConfig) { value.Bucket = "" },
		"invalid bucket":       func(value *S3BlobStorageConfig) { value.Bucket = "../bucket" },
		"missing access key":   func(value *S3BlobStorageConfig) { value.AccessKeyID = "" },
		"missing secret":       func(value *S3BlobStorageConfig) { value.SecretAccessKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			value := valid
			mutate(&value)
			if _, err := newS3BlobObjectStore(value); err == nil {
				t.Fatal("unsafe S3 configuration accepted")
			}
		})
	}
	loopback := valid
	loopback.Endpoint = "http://127.0.0.1:9000"
	loopback.AllowInsecureLoopback = true
	if _, err := newS3BlobObjectStore(loopback); err != nil {
		t.Fatalf("explicit insecure loopback rejected: %v", err)
	}
	localhost := valid
	localhost.Endpoint = "http://localhost:9000"
	localhost.AllowInsecureLoopback = true
	if _, err := newS3BlobObjectStore(localhost); err != nil {
		t.Fatalf("explicit insecure localhost rejected: %v", err)
	}
	if _, err := newS3BlobObjectStore(valid); err != nil && !errors.Is(err, errInvalidBlobObjectConfig) {
		t.Fatalf("valid configuration: %v", err)
	}
}

func TestS3SafeDialRejectsDNSPrivateAndCGNATAnswers(t *testing.T) {
	for name, answer := range map[string]net.IP{
		"private":    net.ParseIP("10.1.2.3"),
		"loopback":   net.ParseIP("127.0.0.1"),
		"link-local": net.ParseIP("169.254.169.254"),
		"cgnat":      net.ParseIP("100.64.1.2"),
	} {
		t.Run(name, func(t *testing.T) {
			dial := safeS3DialContext(false, func(context.Context, string, string) ([]net.IP, error) {
				return []net.IP{answer}, nil
			}, (&net.Dialer{}).DialContext)
			if _, err := dial(context.Background(), "tcp", "storage.example:443"); err == nil {
				t.Fatal("unsafe DNS answer accepted")
			}
		})
	}
	dial := safeS3DialContext(true, func(context.Context, string, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("8.8.8.8")}, nil
	}, (&net.Dialer{}).DialContext)
	if _, err := dial(context.Background(), "tcp", "localhost:9000"); err == nil {
		t.Fatal("insecure localhost mode accepted a non-loopback DNS answer")
	}
}

func TestS3BlobStoreDisablesRedirects(t *testing.T) {
	targetCalled := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	objectStore, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: redirect.URL, Bucket: "bucket", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := objectStore.Get(context.Background(), "tenant", "image:test", 1024); err == nil || !strings.Contains(err.Error(), "redirects are disabled") {
		t.Fatalf("redirect error = %v", err)
	}
	if targetCalled {
		t.Fatal("S3 client followed redirect")
	}
}
