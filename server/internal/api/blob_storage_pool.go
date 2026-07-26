package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

// blobStoragePoolStore implements the existing object-store boundary while
// persisting the selected provider separately. Router snapshots are immutable;
// Update atomically replaces the selection snapshot. Providers may be marked
// unhealthy or assigned zero weight, but cannot be rebound or removed while
// durable placements may still reference them.
type blobStoragePoolStore struct {
	mu         sync.RWMutex
	writes     [64]sync.Mutex
	router     *blobStorageRouter
	providers  map[string]blobStorageRoute
	placements blobPlacementStore
}

var (
	errBlobStorageCapacityUnknown     = errors.New("blob storage capacity is unknown")
	errBlobStorageProviderUnavailable = errors.New("blob storage provider unavailable before write")
)

type blobStorageHealthState string

const (
	blobStorageHealthHealthy   blobStorageHealthState = "healthy"
	blobStorageHealthUnhealthy blobStorageHealthState = "unhealthy"
	blobStorageHealthUnknown   blobStorageHealthState = "unknown"
)

type blobStorageHealthReader interface {
	Health(context.Context) blobStorageHealthState
}

type blobStorageCapacity struct {
	TotalBytes     int64
	AvailableBytes int64
}

type blobStorageCapacityReader interface {
	Capacity(context.Context) (blobStorageCapacity, error)
}

type BlobStoragePoolProviderStatus struct {
	ID                   string `json:"id"`
	Kind                 string `json:"kind"`
	Weight               uint32 `json:"weight"`
	ConfiguredSelectable bool   `json:"configuredSelectable"`
	ProbeKnown           bool   `json:"probeKnown"`
	ProbeHealthy         bool   `json:"probeHealthy"`
	CapacityKnown        bool   `json:"capacityKnown"`
	TotalBytes           int64  `json:"totalBytes,omitempty"`
	AvailableBytes       int64  `json:"availableBytes,omitempty"`
	Error                string `json:"error,omitempty"`
}

// BlobStoragePoolProviderConfig is the server-facing configuration for one
// S3-compatible destination. ID is persisted in placement metadata, so callers
// must keep it stable for the lifetime of objects stored on that destination.
type BlobStoragePoolProviderConfig struct {
	ID      string
	Weight  uint32
	Healthy bool
	Storage S3BlobStorageConfig
}

// ConfigureBlobStoragePool installs or atomically updates the process-level
// storage pool. Tenant-specific storage retains its existing precedence in
// resolveBlobObjectStore; the pool replaces only the process fallback.
func (s *Server) ConfigureBlobStoragePool(input []BlobStoragePoolProviderConfig) error {
	if s.store == nil {
		return errors.New("blob storage pool requires persistent placement storage")
	}
	configs := make([]blobStorageProviderConfig, 0, len(input))
	for _, item := range input {
		objects, err := newS3BlobObjectStore(item.Storage)
		if err != nil {
			return err
		}
		health := blobStorageProviderUnhealthy
		if item.Healthy {
			health = blobStorageProviderHealthy
		}
		configs = append(configs, blobStorageProviderConfig{
			ID: item.ID, Destination: s3BlobStorageDestination(objects),
			Weight: item.Weight, Health: health, Store: objects,
		})
	}
	if err := persistBlobProviderRegistry(context.Background(), s.store, configs); err != nil {
		return err
	}
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	if current, ok := s.blobObjects.(*blobStoragePoolStore); ok {
		return current.Update(configs)
	}
	pool, err := newBlobStoragePoolStore(configs, newTenantStateBlobPlacementStore(s.store))
	if err != nil {
		return err
	}
	s.blobObjects = pool
	return nil
}

func newBlobStoragePoolStore(configs []blobStorageProviderConfig, placements blobPlacementStore) (*blobStoragePoolStore, error) {
	if placements == nil {
		return nil, errors.New("blob placement store is required")
	}
	router, err := newBlobStorageRouter(configs)
	if err != nil {
		return nil, err
	}
	providers := make(map[string]blobStorageRoute, len(configs))
	for _, config := range configs {
		providers[config.ID] = blobStorageRoute{ID: config.ID, Destination: config.Destination, Store: config.Store}
	}
	return &blobStoragePoolStore{router: router, providers: providers, placements: placements}, nil
}

func (p *blobStoragePoolStore) Kind() string {
	return "pool"
}

func (p *blobStoragePoolStore) Ping(ctx context.Context) error {
	p.mu.RLock()
	router := p.router
	p.mu.RUnlock()
	if router == nil {
		return errNoHealthyBlobStorage
	}
	route, err := router.Select("health")
	if err != nil {
		return err
	}
	return route.Store.Ping(ctx)
}

func (p *blobStoragePoolStore) Update(configs []blobStorageProviderConfig) error {
	router, err := newBlobStorageRouter(configs)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	nextIDs := make(map[string]struct{}, len(configs))
	for _, config := range configs {
		nextIDs[config.ID] = struct{}{}
		if current, ok := p.providers[config.ID]; ok && current.Destination != config.Destination {
			return errors.New("blob storage provider id cannot be rebound to another destination")
		}
	}
	for id := range p.providers {
		if _, retained := nextIDs[id]; !retained {
			return errors.New("blob storage provider cannot be removed while placements may reference it")
		}
	}
	nextProviders := make(map[string]blobStorageRoute, len(configs))
	for _, config := range configs {
		nextProviders[config.ID] = blobStorageRoute{ID: config.ID, Destination: config.Destination, Store: config.Store}
	}
	p.router = router
	p.providers = nextProviders
	return nil
}

func (p *blobStoragePoolStore) Get(ctx context.Context, tenantID, name string, limit int64) (blobObject, error) {
	route, value, err := p.locate(ctx, tenantID, name, limit)
	if err != nil {
		return blobObject{}, err
	}
	if err := p.persistPlacement(ctx, tenantID, name, route); err != nil {
		return blobObject{}, err
	}
	return value, nil
}

func (p *blobStoragePoolStore) Put(ctx context.Context, tenantID, name string, value blobObject, expectedVersion string) (string, error) {
	lock := &p.writes[blobStorageWriteStripe(tenantID, name)]
	lock.Lock()
	defer lock.Unlock()
	if route, err := p.routeFromPlacement(ctx, tenantID, name); err == nil {
		return route.Store.Put(ctx, tenantID, name, value, expectedVersion)
	} else if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}
	// A legacy object is an existing placement even though it predates metadata;
	// never move it after a failed overwrite.
	if route, _, err := p.locate(ctx, tenantID, name, maxUploadBytes); err == nil {
		if err := p.persistPlacement(ctx, tenantID, name, route); err != nil {
			return "", err
		}
		return route.Store.Put(ctx, tenantID, name, value, expectedVersion)
	} else if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}
	p.mu.RLock()
	router := p.router
	p.mu.RUnlock()
	candidates, err := router.Candidates(tenantID + "/" + name)
	if err != nil {
		return "", err
	}
	var lastErr error
	for _, route := range candidates {
		claimID := randomGenerationOwner()
		if err := p.placements.Claim(ctx, tenantID, name, blobPlacement{
			ProviderID: route.ID, Destination: route.Destination,
		}, claimID, time.Now().Add(2*time.Minute)); err != nil {
			return "", err
		}
		version, putErr := route.Store.Put(ctx, tenantID, name, value, expectedVersion)
		if putErr == nil {
			if err := p.placements.Commit(ctx, tenantID, name, claimID); err != nil {
				return "", err
			}
			return version, nil
		}
		lastErr = putErr
		// Only a provider's explicit pre-write-unavailable signal is safe to
		// fail over. Timeouts and generic transport errors may mean the first
		// provider committed the object despite a lost response.
		if !errors.Is(putErr, errBlobStorageProviderUnavailable) {
			// The request may have reached storage. Freeze the placement on this
			// provider so a retry cannot duplicate the object elsewhere.
			if err := p.placements.Commit(context.Background(), tenantID, name, claimID); err != nil {
				return "", errors.Join(putErr, err)
			}
			return "", putErr
		}
		if err := p.placements.Abort(context.Background(), tenantID, name, claimID); err != nil {
			return "", err
		}
		if ctx.Err() != nil {
			return "", putErr
		}
	}
	return "", lastErr
}

func blobStorageWriteStripe(tenantID, name string) int {
	digest := sha256.Sum256([]byte(tenantID + "\x1f" + name))
	return int(digest[0]) % 64
}

// Status probes providers without exposing endpoint or credential material.
// Probe concurrency and duration are bounded; unsupported capacity is explicit.
func (p *blobStoragePoolStore) Status(ctx context.Context) []BlobStoragePoolProviderStatus {
	p.mu.RLock()
	configs := append([]blobStorageProviderConfig(nil), p.router.ordered...)
	p.mu.RUnlock()
	statuses := make([]BlobStoragePoolProviderStatus, len(configs))
	semaphore := make(chan struct{}, 4)
	var wait sync.WaitGroup
	for index, config := range configs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				statuses[index] = BlobStoragePoolProviderStatus{ID: config.ID, Kind: config.Store.Kind(), Weight: config.Weight, Error: "status probe cancelled"}
				return
			}
			probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			status := BlobStoragePoolProviderStatus{
				ID: config.ID, Kind: config.Store.Kind(), Weight: config.Weight,
				ConfiguredSelectable: config.Health == blobStorageProviderHealthy && config.Weight > 0,
			}
			if reader, ok := config.Store.(blobStorageHealthReader); ok {
				switch reader.Health(probeCtx) {
				case blobStorageHealthHealthy:
					status.ProbeKnown, status.ProbeHealthy = true, true
				case blobStorageHealthUnhealthy:
					status.ProbeKnown = true
					status.Error = "health probe failed"
				}
			} else if err := config.Store.Ping(probeCtx); err != nil {
				status.ProbeKnown = true
				status.Error = "health probe failed"
			} else {
				status.ProbeKnown, status.ProbeHealthy = true, true
			}
			if reader, ok := config.Store.(blobStorageCapacityReader); ok {
				capacity, err := reader.Capacity(probeCtx)
				if err == nil && capacity.TotalBytes >= 0 && capacity.AvailableBytes >= 0 && capacity.AvailableBytes <= capacity.TotalBytes {
					status.CapacityKnown = true
					status.TotalBytes = capacity.TotalBytes
					status.AvailableBytes = capacity.AvailableBytes
				} else if err != nil && !errors.Is(err, errBlobStorageCapacityUnknown) && status.Error == "" {
					status.Error = "capacity probe failed"
				}
			}
			statuses[index] = status
		}()
	}
	wait.Wait()
	return statuses
}

func (s *Server) BlobStoragePoolStatus(ctx context.Context) ([]BlobStoragePoolProviderStatus, error) {
	s.tenantBlobStoreMu.Lock()
	pool, ok := s.blobObjects.(*blobStoragePoolStore)
	s.tenantBlobStoreMu.Unlock()
	if !ok {
		return nil, errors.New("blob storage pool is not configured")
	}
	return pool.Status(ctx), nil
}

func (p *blobStoragePoolStore) Delete(ctx context.Context, tenantID, name, expectedVersion string) error {
	lock := &p.writes[blobStorageWriteStripe(tenantID, name)]
	lock.Lock()
	defer lock.Unlock()
	route, err := p.routeFromPlacement(ctx, tenantID, name)
	if errors.Is(err, store.ErrNotFound) {
		route, _, err = p.locate(ctx, tenantID, name, maxUploadBytes)
	}
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := route.Store.Delete(ctx, tenantID, name, expectedVersion); err != nil {
		return err
	}
	return p.placements.Delete(ctx, tenantID, name)
}

func (p *blobStoragePoolStore) routeFromPlacement(ctx context.Context, tenantID, name string) (blobStorageRoute, error) {
	placement, err := p.placements.Get(ctx, tenantID, name)
	if err != nil {
		return blobStorageRoute{}, err
	}
	p.mu.RLock()
	provider := p.providers[placement.ProviderID]
	p.mu.RUnlock()
	if provider.Store == nil {
		return blobStorageRoute{}, errors.New("blob placement provider is unavailable")
	}
	if placement.Status == blobPlacementPending {
		expires, _ := time.Parse(time.RFC3339Nano, placement.LeaseUntil)
		if time.Now().After(expires) {
			return blobStorageRoute{}, store.ErrNotFound
		}
		return blobStorageRoute{}, errBlobPlacementPending
	}
	if placement.Version == 1 && placement.Destination == "" {
		if err := p.placements.Put(ctx, tenantID, name, blobPlacement{
			ProviderID: placement.ProviderID, Destination: provider.Destination,
		}); err != nil {
			return blobStorageRoute{}, err
		}
		placement.Version, placement.Destination = blobPlacementVersion, provider.Destination
	}
	if provider.Destination != placement.Destination {
		return blobStorageRoute{}, errors.New("blob placement destination does not match provider configuration")
	}
	return provider, nil
}

func (p *blobStoragePoolStore) locate(ctx context.Context, tenantID, name string, limit int64) (blobStorageRoute, blobObject, error) {
	if route, err := p.routeFromPlacement(ctx, tenantID, name); err == nil {
		value, getErr := route.Store.Get(ctx, tenantID, name, limit)
		return route, value, getErr
	} else if !errors.Is(err, store.ErrNotFound) {
		return blobStorageRoute{}, blobObject{}, err
	}
	p.mu.RLock()
	router := p.router
	p.mu.RUnlock()
	var firstErr error
	for _, route := range router.all() {
		if value, err := route.Store.Get(ctx, tenantID, name, limit); err == nil {
			return route, value, nil
		} else if !errors.Is(err, store.ErrNotFound) && firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return blobStorageRoute{}, blobObject{}, firstErr
	}
	return blobStorageRoute{}, blobObject{}, store.ErrNotFound
}

func (p *blobStoragePoolStore) persistPlacement(ctx context.Context, tenantID, name string, route blobStorageRoute) error {
	return p.placements.Put(ctx, tenantID, name, blobPlacement{ProviderID: route.ID, Destination: route.Destination})
}

func s3BlobStorageDestination(objects *s3BlobObjectStore) string {
	value := strings.Join([]string{objects.endpoint.String(), objects.bucket, objects.region, objects.prefix}, "\x1f")
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
