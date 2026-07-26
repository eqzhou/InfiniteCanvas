package api

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"regexp"
	"strings"
)

const (
	maxBlobStorageProviders                                = 64
	maxBlobStorageProviderWeight                           = uint32(10_000)
	blobStorageProviderHealthy   blobStorageProviderHealth = "healthy"
	blobStorageProviderUnhealthy blobStorageProviderHealth = "unhealthy"
)

var (
	blobStorageProviderIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	errNoHealthyBlobStorage      = errors.New("no healthy blob storage provider is available")
)

type blobStorageProviderHealth string

// blobStorageProviderConfig binds a stable placement ID to a runtime object
// store. IDs identify physical storage destinations and must not be reused for
// a different destination while placements still reference them.
type blobStorageProviderConfig struct {
	ID          string
	Destination string
	Weight      uint32
	Health      blobStorageProviderHealth
	Store       blobObjectStore
}

type blobStorageRoute struct {
	ID          string
	Destination string
	Store       blobObjectStore
}

// blobStorageRouter is an immutable routing snapshot. Health only affects new
// placement; unhealthy providers remain resolvable for existing objects.
type blobStorageRouter struct {
	providers map[string]blobStorageProviderConfig
	ordered   []blobStorageProviderConfig
	eligible  []blobStorageProviderConfig
	total     uint64
}

func newBlobStorageRouter(input []blobStorageProviderConfig) (*blobStorageRouter, error) {
	if len(input) == 0 || len(input) > maxBlobStorageProviders {
		return nil, errors.New("invalid blob storage provider count")
	}
	providers := make(map[string]blobStorageProviderConfig, len(input))
	eligible := make([]blobStorageProviderConfig, 0, len(input))
	var total uint64
	for _, raw := range input {
		config := raw
		if !blobStorageProviderIDPattern.MatchString(config.ID) || strings.TrimSpace(config.Destination) == "" || len(config.Destination) > 128 || config.Store == nil ||
			(config.Health != blobStorageProviderHealthy && config.Health != blobStorageProviderUnhealthy) ||
			config.Weight > maxBlobStorageProviderWeight {
			return nil, errors.New("invalid blob storage provider configuration")
		}
		if _, exists := providers[config.ID]; exists {
			return nil, errors.New("duplicate blob storage provider id")
		}
		providers[config.ID] = config
		if config.Health == blobStorageProviderHealthy && config.Weight > 0 {
			eligible = append(eligible, config)
			total += uint64(config.Weight)
		}
	}
	ordered := append([]blobStorageProviderConfig(nil), input...)
	return &blobStorageRouter{providers: providers, ordered: ordered, eligible: eligible, total: total}, nil
}

func (r *blobStorageRouter) Select(key string) (blobStorageRoute, error) {
	candidates, err := r.Candidates(key)
	if err != nil {
		return blobStorageRoute{}, err
	}
	return candidates[0], nil
}

// Candidates returns a deterministic failover order. The first candidate uses
// weighted selection; remaining healthy providers follow stable ring order.
func (r *blobStorageRouter) Candidates(key string) ([]blobStorageRoute, error) {
	if r == nil || r.total == 0 || len(r.eligible) == 0 {
		return nil, errNoHealthyBlobStorage
	}
	digest := sha256.Sum256([]byte(key))
	needle := binary.BigEndian.Uint64(digest[:8]) % r.total
	var cursor uint64
	selected := -1
	for index, config := range r.eligible {
		cursor += uint64(config.Weight)
		if needle < cursor {
			selected = index
			break
		}
	}
	if selected < 0 {
		return nil, errNoHealthyBlobStorage
	}
	candidates := make([]blobStorageRoute, 0, len(r.eligible))
	for offset := range len(r.eligible) {
		config := r.eligible[(selected+offset)%len(r.eligible)]
		candidates = append(candidates, blobStorageRoute{ID: config.ID, Destination: config.Destination, Store: config.Store})
	}
	return candidates, nil
}

func (r *blobStorageRouter) Resolve(providerID string) (blobStorageRoute, error) {
	if r == nil {
		return blobStorageRoute{}, errNoHealthyBlobStorage
	}
	config, ok := r.providers[providerID]
	if !ok {
		return blobStorageRoute{}, errors.New("blob storage placement provider is unavailable")
	}
	return blobStorageRoute{ID: config.ID, Destination: config.Destination, Store: config.Store}, nil
}

func (r *blobStorageRouter) all() []blobStorageRoute {
	if r == nil {
		return nil
	}
	routes := make([]blobStorageRoute, 0, len(r.ordered))
	for _, config := range r.ordered {
		routes = append(routes, blobStorageRoute{ID: config.ID, Destination: config.Destination, Store: config.Store})
	}
	return routes
}
