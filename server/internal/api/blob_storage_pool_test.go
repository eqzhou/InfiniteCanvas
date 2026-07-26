package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type failingPutBlobStore struct {
	*memoryBlobObjectStore
}

type ambiguousPutBlobStore struct{ *memoryBlobObjectStore }

type singleAcceptListener struct {
	net.Listener
	once sync.Once
}

func (l *singleAcceptListener) Accept() (net.Conn, error) {
	connection, err := l.Listener.Accept()
	if err == nil {
		l.once.Do(func() { _ = l.Listener.Close() })
	}
	return connection, err
}

func (a *ambiguousPutBlobStore) Put(context.Context, string, string, blobObject, string) (string, error) {
	return "", errors.New("response lost after request may have committed")
}

func (f *failingPutBlobStore) Put(context.Context, string, string, blobObject, string) (string, error) {
	return "", errBlobStorageProviderUnavailable
}

type observableBlobStore struct {
	*memoryBlobObjectStore
	pingError     error
	capacity      blobStorageCapacity
	capacityError error
}

func (o *observableBlobStore) Ping(context.Context) error { return o.pingError }
func (o *observableBlobStore) Capacity(context.Context) (blobStorageCapacity, error) {
	return o.capacity, o.capacityError
}

func TestBlobStorageRouterIsDeterministicWeightedAndFiltersUnhealthyProviders(t *testing.T) {
	configs := []blobStorageProviderConfig{
		{ID: "primary", Destination: "primary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()},
		{ID: "bulk", Destination: "bulk-v1", Weight: 4, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()},
		{ID: "offline", Destination: "offline-v1", Weight: 100, Health: blobStorageProviderUnhealthy, Store: newMemoryBlobObjectStore()},
	}
	router, err := newBlobStorageRouter(configs)
	if err != nil {
		t.Fatal(err)
	}

	// The router owns an immutable snapshot of the caller's configuration.
	configs[0].Weight = 10_000
	configs[1].Health = blobStorageProviderUnhealthy

	counts := map[string]int{}
	for index := range 1_000 {
		key := fmt.Sprintf("tenant-a/blob-%d", index)
		first, err := router.Select(key)
		if err != nil {
			t.Fatal(err)
		}
		second, err := router.Select(key)
		if err != nil || first.ID != second.ID {
			t.Fatalf("selection for %q is not deterministic: %#v %#v %v", key, first, second, err)
		}
		counts[first.ID]++
	}
	if counts["offline"] != 0 {
		t.Fatalf("unhealthy provider selected %d times", counts["offline"])
	}
	if counts["primary"] == 0 || counts["bulk"] <= counts["primary"]*2 {
		t.Fatalf("weighted distribution = %#v", counts)
	}
	if _, err := router.Resolve("offline"); err != nil {
		t.Fatalf("unhealthy provider must remain resolvable for placed objects: %v", err)
	}
}

func TestBlobStorageRouterRejectsUnsafeOrAmbiguousConfiguration(t *testing.T) {
	validStore := newMemoryBlobObjectStore()
	tests := map[string][]blobStorageProviderConfig{
		"empty id":       {{Destination: "one", Weight: 1, Health: blobStorageProviderHealthy, Store: validStore}},
		"empty target":   {{ID: "empty", Weight: 1, Health: blobStorageProviderHealthy, Store: validStore}},
		"unsafe id":      {{ID: "../bucket", Destination: "one", Weight: 1, Health: blobStorageProviderHealthy, Store: validStore}},
		"duplicate id":   {{ID: "same", Destination: "one", Weight: 1, Health: blobStorageProviderHealthy, Store: validStore}, {ID: "same", Destination: "one", Weight: 2, Health: blobStorageProviderHealthy, Store: validStore}},
		"missing store":  {{ID: "missing", Destination: "one", Weight: 1, Health: blobStorageProviderHealthy}},
		"invalid health": {{ID: "bad", Destination: "one", Weight: 1, Health: "unknown", Store: validStore}},
		"excess weight":  {{ID: "heavy", Destination: "one", Weight: maxBlobStorageProviderWeight + 1, Health: blobStorageProviderHealthy, Store: validStore}},
	}
	for name, configs := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := newBlobStorageRouter(configs); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestBlobStoragePoolPlacementSurvivesRoutingChangesForReadOverwriteAndDelete(t *testing.T) {
	backend := newMemoryStore()
	placements := newTenantStateBlobPlacementStore(backend)
	primary := newMemoryBlobObjectStore()
	secondary := newMemoryBlobObjectStore()
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "primary", Destination: "primary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: primary},
	}, placements)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithStore(t.TempDir(), backend)
	server.setBlobObjectStore(pool)
	ctx := context.Background()

	if err := server.storeTenantBlob(ctx, "tenant", "user", "old", "image/png", []byte("first")); err != nil {
		t.Fatal(err)
	}
	name, _ := blobFilename("old")
	placement, err := placements.Get(ctx, "tenant", name)
	if err != nil || placement.ProviderID != "primary" {
		t.Fatalf("placement = %#v, %v", placement, err)
	}

	// Unhealthy providers are excluded from new writes but remain addressable for
	// objects already placed on them.
	if err := pool.Update([]blobStorageProviderConfig{
		{ID: "primary", Destination: "primary-v1", Weight: 1, Health: blobStorageProviderUnhealthy, Store: primary},
		{ID: "secondary", Destination: "secondary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: secondary},
	}); err != nil {
		t.Fatal(err)
	}
	if got, err := server.readTenantBlob(ctx, "tenant", "old", maxUploadBytes); err != nil || string(got.Data) != "first" {
		t.Fatalf("read old placement = %#v, %v", got, err)
	}
	if err := server.storeTenantBlob(ctx, "tenant", "user", "old", "image/png", []byte("replaced")); err != nil {
		t.Fatal(err)
	}
	if len(secondary.objects) != 0 {
		t.Fatal("overwrite moved a placed object to the newly selected provider")
	}
	if err := server.storeTenantBlob(ctx, "tenant", "user", "new", "image/png", []byte("second")); err != nil {
		t.Fatal(err)
	}
	if len(secondary.objects) == 0 {
		t.Fatal("new object did not use healthy provider")
	}
	if err := server.deleteTenantBlob(ctx, "tenant", "user", "old"); err != nil {
		t.Fatal(err)
	}
	if len(primary.objects) != 0 {
		t.Fatalf("old provider retains deleted object: %#v", primary.objects)
	}
	if _, err := placements.Get(ctx, "tenant", name); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("placement after delete = %v", err)
	}
}

func TestBlobStoragePoolRejectsProviderRebindAndRemoval(t *testing.T) {
	backend := newMemoryStore()
	primary := newMemoryBlobObjectStore()
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "primary", Destination: "bucket-a", Weight: 1, Health: blobStorageProviderHealthy, Store: primary},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Update([]blobStorageProviderConfig{
		{ID: "primary", Destination: "bucket-b", Weight: 1, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()},
	}); err == nil {
		t.Fatal("provider id was rebound to another physical destination")
	}
	if err := pool.Update([]blobStorageProviderConfig{
		{ID: "secondary", Destination: "bucket-b", Weight: 1, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()},
	}); err == nil {
		t.Fatal("provider was removed while durable placements may reference it")
	}
}

func TestBlobProviderRegistryRejectsRebindAndRemovalAfterRestart(t *testing.T) {
	backend := newMemoryStore()
	primary := blobStorageProviderConfig{ID: "primary", Destination: "bucket-a", Weight: 1, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()}
	if err := persistBlobProviderRegistry(context.Background(), backend, []blobStorageProviderConfig{primary}); err != nil {
		t.Fatal(err)
	}
	rebound := primary
	rebound.Destination = "bucket-b"
	if err := persistBlobProviderRegistry(context.Background(), backend, []blobStorageProviderConfig{rebound}); err == nil {
		t.Fatal("durable registry allowed provider rebind")
	}
	secondary := blobStorageProviderConfig{ID: "secondary", Destination: "bucket-b", Weight: 1, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()}
	if err := persistBlobProviderRegistry(context.Background(), backend, []blobStorageProviderConfig{secondary}); err == nil {
		t.Fatal("durable registry allowed provider removal")
	}
	if err := persistBlobProviderRegistry(context.Background(), backend, []blobStorageProviderConfig{primary, secondary}); err != nil {
		t.Fatalf("durable registry rejected additive update: %v", err)
	}
}

func TestBlobStoragePoolUpgradesLegacyV1Placement(t *testing.T) {
	backend := newMemoryStore()
	objects := newMemoryBlobObjectStore()
	name := "legacy-name"
	if _, err := objects.Put(context.Background(), "tenant", name, blobObject{Data: []byte("legacy")}, blobVersionAbsent); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutState(context.Background(), "tenant", blobPlacementStateKey(name), []byte(`{"version":1,"providerId":"primary"}`)); err != nil {
		t.Fatal(err)
	}
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "primary", Destination: "bucket-a", Weight: 1, Health: blobStorageProviderHealthy, Store: objects},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	value, err := pool.Get(context.Background(), "tenant", name, maxUploadBytes)
	if err != nil || string(value.Data) != "legacy" {
		t.Fatalf("legacy placement read = %#v, %v", value, err)
	}
	placement, err := pool.placements.Get(context.Background(), "tenant", name)
	if err != nil || placement.Version != blobPlacementVersion || placement.Destination != "bucket-a" {
		t.Fatalf("upgraded placement = %#v, %v", placement, err)
	}
}

func TestBlobPlacementClaimRollbackIsAttemptScoped(t *testing.T) {
	backend := newMemoryStore()
	first := newTenantStateBlobPlacementStore(backend)
	second := newTenantStateBlobPlacementStore(backend)
	placement := blobPlacement{ProviderID: "primary", Destination: "bucket-a"}
	if err := first.Claim(context.Background(), "tenant", "name", placement, "attempt-one", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := second.Claim(context.Background(), "tenant", "name", placement, "attempt-two", time.Now().Add(time.Minute)); !errors.Is(err, errBlobPlacementConflict) {
		t.Fatalf("second claim = %v", err)
	}
	if err := second.Abort(context.Background(), "tenant", "name", "attempt-two"); !errors.Is(err, errBlobPlacementConflict) {
		t.Fatalf("foreign rollback = %v", err)
	}
	if err := first.Commit(context.Background(), "tenant", "name", "attempt-one"); err != nil {
		t.Fatal(err)
	}
	committed, err := first.Get(context.Background(), "tenant", "name")
	if err != nil || committed.Status != blobPlacementCommitted {
		t.Fatalf("committed placement = %#v, %v", committed, err)
	}
}

func TestBlobStoragePoolRecoversExpiredClaimAfterObjectCommitted(t *testing.T) {
	backend := newMemoryStore()
	objects := newMemoryBlobObjectStore()
	if _, err := objects.Put(context.Background(), "tenant", "name", blobObject{Data: []byte("committed")}, blobVersionAbsent); err != nil {
		t.Fatal(err)
	}
	pending, _ := json.Marshal(blobPlacement{
		Version: blobPlacementVersion, ProviderID: "primary", Destination: "bucket-a",
		Status: blobPlacementPending, ClaimID: "crashed", LeaseUntil: time.Now().Add(-time.Minute).Format(time.RFC3339Nano),
	})
	if err := backend.PutState(context.Background(), "tenant", blobPlacementStateKey("name"), pending); err != nil {
		t.Fatal(err)
	}
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "primary", Destination: "bucket-a", Weight: 1, Health: blobStorageProviderHealthy, Store: objects},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	value, err := pool.Get(context.Background(), "tenant", "name", maxUploadBytes)
	if err != nil || string(value.Data) != "committed" {
		t.Fatalf("expired claim recovery = %#v, %v", value, err)
	}
	placement, err := pool.placements.Get(context.Background(), "tenant", "name")
	if err != nil || placement.Status != blobPlacementCommitted {
		t.Fatalf("recovered placement = %#v, %v", placement, err)
	}
}

func TestBlobStoragePoolFailedInitialPutReleasesPlacementClaim(t *testing.T) {
	backend := newMemoryStore()
	placements := newTenantStateBlobPlacementStore(backend)
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "broken", Destination: "broken-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: &failingPutBlobStore{newMemoryBlobObjectStore()}},
	}, placements)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Put(context.Background(), "tenant", "new-object", blobObject{Data: []byte("x")}, blobVersionAbsent); err == nil {
		t.Fatal("failing provider put succeeded")
	}
	if _, err := placements.Get(context.Background(), "tenant", "new-object"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("failed write retained placement: %v", err)
	}
}

func TestBlobStoragePoolFirstWriteFailsOverButPlacedOverwriteDoesNotMove(t *testing.T) {
	backend := newMemoryStore()
	placements := newTenantStateBlobPlacementStore(backend)
	broken := &failingPutBlobStore{newMemoryBlobObjectStore()}
	secondary := newMemoryBlobObjectStore()
	configs := []blobStorageProviderConfig{
		{ID: "broken", Destination: "broken-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: broken},
		{ID: "secondary", Destination: "secondary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: secondary},
	}
	pool, err := newBlobStoragePoolStore(configs, placements)
	if err != nil {
		t.Fatal(err)
	}
	var name string
	for index := range 1_000 {
		candidate := fmt.Sprintf("candidate-%d", index)
		route, selectErr := pool.router.Select("tenant/" + candidate)
		if selectErr == nil && route.ID == "broken" {
			name = candidate
			break
		}
	}
	if name == "" {
		t.Fatal("failed to find key routed to failing provider")
	}
	if _, err := pool.Put(context.Background(), "tenant", name, blobObject{Data: []byte("new")}, blobVersionAbsent); err != nil {
		t.Fatalf("first-write failover: %v", err)
	}
	placement, err := placements.Get(context.Background(), "tenant", name)
	if err != nil || placement.ProviderID != "secondary" {
		t.Fatalf("failover placement = %#v, %v", placement, err)
	}

	// Existing placement errors are returned; failover must never move an object.
	if err := pool.Update([]blobStorageProviderConfig{
		{ID: "broken", Destination: "broken-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: broken},
		{ID: "secondary", Destination: "secondary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: &failingPutBlobStore{secondary}},
	}); err != nil {
		t.Fatal(err)
	}
	current, _ := secondary.Get(context.Background(), "tenant", name, maxUploadBytes)
	if _, err := pool.Put(context.Background(), "tenant", name, blobObject{Data: []byte("overwrite")}, current.Version); err == nil {
		t.Fatal("placed overwrite unexpectedly failed over")
	}
	if placementAfter, _ := placements.Get(context.Background(), "tenant", name); placementAfter.ProviderID != "secondary" {
		t.Fatalf("placed object moved after failure: %#v", placementAfter)
	}
}

func TestBlobStoragePoolDoesNotFailOverAmbiguousWriteError(t *testing.T) {
	backend := newMemoryStore()
	ambiguous := &ambiguousPutBlobStore{newMemoryBlobObjectStore()}
	secondary := newMemoryBlobObjectStore()
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "ambiguous", Destination: "ambiguous-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: ambiguous},
		{ID: "secondary", Destination: "secondary-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: secondary},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	var name string
	for index := range 1_000 {
		candidate := fmt.Sprintf("ambiguous-%d", index)
		if route, _ := pool.router.Select("tenant/" + candidate); route.ID == "ambiguous" {
			name = candidate
			break
		}
	}
	if _, err := pool.Put(context.Background(), "tenant", name, blobObject{Data: []byte("new")}, blobVersionAbsent); err == nil {
		t.Fatal("ambiguous write error was hidden by unsafe failover")
	}
	if len(secondary.objects) != 0 {
		t.Fatal("ambiguous write was duplicated to fallback provider")
	}
	placement, err := pool.placements.Get(context.Background(), "tenant", name)
	if err != nil || placement.ProviderID != "ambiguous" || placement.Status != blobPlacementCommitted {
		t.Fatalf("ambiguous write placement = %#v, %v", placement, err)
	}
}

func TestS3BlobStoragePoolFailsOverOnlyWhenDialFailsBeforeWrite(t *testing.T) {
	var fallbackWrites atomic.Int32
	fallbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fallbackWrites.Add(1)
		if _, err := io.ReadAll(r.Body); err != nil {
			t.Errorf("read fallback body: %v", err)
		}
		w.Header().Set("ETag", `"fallback"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer fallbackServer.Close()

	brokenServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusNotFound)
	}))
	brokenServer.Listener = &singleAcceptListener{Listener: brokenServer.Listener}
	brokenServer.Start()
	defer brokenServer.Close()
	broken, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: brokenServer.URL, Bucket: "bucket", Region: "auto",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: fallbackServer.URL, Bucket: "bucket", Region: "auto",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	placements := newTenantStateBlobPlacementStore(newMemoryStore())
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "broken-s3", Destination: s3BlobStorageDestination(broken), Weight: 1, Health: blobStorageProviderHealthy, Store: broken},
		{ID: "fallback-s3", Destination: s3BlobStorageDestination(fallback), Weight: 1, Health: blobStorageProviderHealthy, Store: fallback},
	}, placements)
	if err != nil {
		t.Fatal(err)
	}
	name := blobNameRoutedTo(t, pool, "tenant", "broken-s3", "dial-failover")
	version, err := pool.Put(context.Background(), "tenant", name, blobObject{Data: []byte("payload")}, blobVersionAbsent)
	if err != nil || version != `"fallback"` {
		t.Fatalf("S3 failover put = %q, %v", version, err)
	}
	if fallbackWrites.Load() != 1 {
		t.Fatalf("fallback writes = %d", fallbackWrites.Load())
	}
	placement, err := placements.Get(context.Background(), "tenant", name)
	if err != nil || placement.ProviderID != "fallback-s3" || placement.Status != blobPlacementCommitted {
		t.Fatalf("failover placement = %#v, %v", placement, err)
	}
}

func TestS3BlobStoragePoolRetainsPlacementAfterRequestWasWritten(t *testing.T) {
	var primaryWrites atomic.Int32
	primaryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		primaryWrites.Add(1)
		if _, err := io.ReadAll(r.Body); err != nil {
			t.Errorf("read primary body: %v", err)
		}
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack primary response: %v", err)
			return
		}
		_ = connection.Close()
	}))
	defer primaryServer.Close()
	var fallbackWrites atomic.Int32
	fallbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fallbackWrites.Add(1)
		w.Header().Set("ETag", `"fallback"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer fallbackServer.Close()

	primary, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: primaryServer.URL, Bucket: "bucket", Region: "auto",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: fallbackServer.URL, Bucket: "bucket", Region: "auto",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	placements := newTenantStateBlobPlacementStore(newMemoryStore())
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "primary-s3", Destination: s3BlobStorageDestination(primary), Weight: 1, Health: blobStorageProviderHealthy, Store: primary},
		{ID: "fallback-s3", Destination: s3BlobStorageDestination(fallback), Weight: 1, Health: blobStorageProviderHealthy, Store: fallback},
	}, placements)
	if err != nil {
		t.Fatal(err)
	}
	name := blobNameRoutedTo(t, pool, "tenant", "primary-s3", "ambiguous-s3")
	if _, err := pool.Put(context.Background(), "tenant", name, blobObject{Data: []byte("payload")}, blobVersionAbsent); err == nil || errors.Is(err, errBlobStorageProviderUnavailable) {
		t.Fatalf("ambiguous S3 put error = %v", err)
	}
	if primaryWrites.Load() != 1 || fallbackWrites.Load() != 0 {
		t.Fatalf("writes primary=%d fallback=%d", primaryWrites.Load(), fallbackWrites.Load())
	}
	placement, err := placements.Get(context.Background(), "tenant", name)
	if err != nil || placement.ProviderID != "primary-s3" || placement.Status != blobPlacementCommitted {
		t.Fatalf("ambiguous S3 placement = %#v, %v", placement, err)
	}
}

func blobNameRoutedTo(t *testing.T, pool *blobStoragePoolStore, tenantID, providerID, prefix string) string {
	t.Helper()
	for index := range 1_000 {
		name := fmt.Sprintf("%s-%d", prefix, index)
		route, err := pool.router.Select(tenantID + "/" + name)
		if err == nil && route.ID == providerID {
			return name
		}
	}
	t.Fatalf("failed to find a name routed to %s", providerID)
	return ""
}

func TestBlobStoragePoolStatusIsBoundedAndReportsUnknownCapacity(t *testing.T) {
	backend := newMemoryStore()
	known := &observableBlobStore{
		memoryBlobObjectStore: newMemoryBlobObjectStore(),
		capacity:              blobStorageCapacity{TotalBytes: 1_000, AvailableBytes: 400},
	}
	unknown := &observableBlobStore{
		memoryBlobObjectStore: newMemoryBlobObjectStore(),
		pingError:             errors.New("offline"), capacityError: errBlobStorageCapacityUnknown,
	}
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "known", Destination: "known-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: known},
		{ID: "unknown", Destination: "unknown-v1", Weight: 1, Health: blobStorageProviderUnhealthy, Store: unknown},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	statuses := pool.Status(ctx)
	if len(statuses) != 2 {
		t.Fatalf("statuses = %#v", statuses)
	}
	byID := map[string]BlobStoragePoolProviderStatus{}
	for _, status := range statuses {
		byID[status.ID] = status
	}
	if status := byID["known"]; !status.ConfiguredSelectable || !status.ProbeKnown || !status.ProbeHealthy || !status.CapacityKnown || status.AvailableBytes != 400 {
		t.Fatalf("known status = %#v", status)
	}
	if status := byID["unknown"]; status.ConfiguredSelectable || !status.ProbeKnown || status.ProbeHealthy || status.CapacityKnown || status.Error == "" {
		t.Fatalf("unknown status = %#v", status)
	}
}

func TestS3PoolStatusReportsUnknownWithoutBroaderBucketProbe(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer upstream.Close()
	objects, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: upstream.URL, Bucket: "private-bucket", Region: "auto", Prefix: "openboard",
		AccessKeyID: "access", SecretAccessKey: "secret", AllowInsecureLoopback: true,
		HTTPClient: upstream.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "s3", Destination: "s3-v1", Weight: 1, Health: blobStorageProviderHealthy, Store: objects},
	}, newTenantStateBlobPlacementStore(newMemoryStore()))
	if err != nil {
		t.Fatal(err)
	}
	statuses := pool.Status(context.Background())
	if len(statuses) != 1 || statuses[0].ProbeKnown || statuses[0].ProbeHealthy || statuses[0].CapacityKnown || statuses[0].Error != "" {
		t.Fatalf("S3 status = %#v", statuses)
	}
	if requests != 0 {
		t.Fatalf("status required broader S3 permissions with %d request(s)", requests)
	}
}

func TestAdminStoragePoolStatusRouteOmitsDestinationsAndCredentials(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	pool, err := newBlobStoragePoolStore([]blobStorageProviderConfig{
		{ID: "safe-id", Destination: "secret-destination-fingerprint", Weight: 3, Health: blobStorageProviderHealthy, Store: newMemoryBlobObjectStore()},
	}, newTenantStateBlobPlacementStore(backend))
	if err != nil {
		t.Fatal(err)
	}
	server.setBlobObjectStore(pool)
	router := chi.NewRouter()
	MountServer(router, server)
	response := request(t, router, http.MethodGet, "/api/admin/storage-pool", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status route = %d %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"safe-id"`) || !strings.Contains(body, `"weight": 3`) {
		t.Fatalf("status body = %s", body)
	}
	if strings.Contains(body, "secret-destination") || strings.Contains(strings.ToLower(body), "credential") || strings.Contains(strings.ToLower(body), "endpoint") {
		t.Fatalf("status leaked private configuration: %s", body)
	}
}

func TestBlobPlacementIsImmutableAndTenantIsolated(t *testing.T) {
	backend := newMemoryStore()
	placements := newTenantStateBlobPlacementStore(backend)
	ctx := context.Background()
	if err := placements.Put(ctx, "tenant-a", "same-name", blobPlacement{ProviderID: "one", Destination: "one-v1"}); err != nil {
		t.Fatal(err)
	}
	if err := placements.Put(ctx, "tenant-a", "same-name", blobPlacement{ProviderID: "one", Destination: "one-v1"}); err != nil {
		t.Fatalf("idempotent placement: %v", err)
	}
	if err := placements.Put(ctx, "tenant-a", "same-name", blobPlacement{ProviderID: "two", Destination: "two-v1"}); !errors.Is(err, errBlobPlacementConflict) {
		t.Fatalf("changed placement = %v", err)
	}
	if _, err := placements.Get(ctx, "tenant-b", "same-name"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant placement visible: %v", err)
	}
	if err := placements.Delete(ctx, "tenant-a", "same-name"); err != nil {
		t.Fatal(err)
	}
	if err := placements.Put(ctx, "tenant-a", "same-name", blobPlacement{ProviderID: "two", Destination: "two-v1"}); err != nil {
		t.Fatalf("recreate after placement tombstone: %v", err)
	}
}

func TestBlobPlacementConcurrentWritersCannotMoveObject(t *testing.T) {
	backend := newMemoryStore()
	placements := newTenantStateBlobPlacementStore(backend)
	ctx := context.Background()
	start := make(chan struct{})
	errorsByProvider := make(chan error, 2)
	for _, providerID := range []string{"one", "two"} {
		go func() {
			<-start
			errorsByProvider <- placements.Put(ctx, "tenant", "same", blobPlacement{ProviderID: providerID, Destination: providerID + "-v1"})
		}()
	}
	close(start)
	first, second := <-errorsByProvider, <-errorsByProvider
	if (first == nil) == (second == nil) {
		t.Fatalf("concurrent placement results = %v, %v", first, second)
	}
	failed := first
	if failed == nil {
		failed = second
	}
	if !errors.Is(failed, errBlobPlacementConflict) {
		t.Fatalf("losing placement error = %v", failed)
	}
}
