package api

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/openboard/openboard/server/internal/store"
)

const blobProviderRegistryStateKey = "__blob_provider_registry_v1"

type blobProviderRegistry struct {
	Version   int
	Providers []blobProviderRegistryItem
}

type blobProviderRegistryItem struct {
	ID          string
	Destination string
}

// persistBlobProviderRegistry prevents provider IDs from being rebound or
// removed across process restarts. Retired providers remain configured with
// zero weight/unhealthy until their placements are explicitly migrated.
func persistBlobProviderRegistry(ctx context.Context, backend store.Store, configs []blobStorageProviderConfig) error {
	if backend == nil {
		return errors.New("blob provider registry requires persistent storage")
	}
	next := blobProviderRegistry{Version: 1, Providers: make([]blobProviderRegistryItem, 0, len(configs))}
	for _, config := range configs {
		next.Providers = append(next.Providers, blobProviderRegistryItem{ID: config.ID, Destination: config.Destination})
	}
	sort.Slice(next.Providers, func(i, j int) bool { return next.Providers[i].ID < next.Providers[j].ID })
	nextRaw, _ := json.Marshal(next)
	for range 4 {
		currentRaw, err := backend.GetState(ctx, store.DefaultTenantID, blobProviderRegistryStateKey)
		if errors.Is(err, store.ErrNotFound) {
			if err := backend.CompareAndSwapState(ctx, store.DefaultTenantID, blobProviderRegistryStateKey, nil, nextRaw); errors.Is(err, store.ErrConflict) {
				continue
			} else {
				return err
			}
		}
		if err != nil {
			return err
		}
		var current blobProviderRegistry
		if json.Unmarshal(currentRaw, &current) != nil || current.Version != 1 {
			return errors.New("invalid blob provider registry")
		}
		nextByID := make(map[string]string, len(next.Providers))
		for _, item := range next.Providers {
			nextByID[item.ID] = item.Destination
		}
		for _, item := range current.Providers {
			destination, retained := nextByID[item.ID]
			if !retained {
				return errors.New("blob storage provider cannot be removed while placements may reference it")
			}
			if destination != item.Destination {
				return errors.New("blob storage provider id cannot be rebound to another destination")
			}
		}
		if string(currentRaw) == string(nextRaw) {
			return nil
		}
		if err := backend.CompareAndSwapState(ctx, store.DefaultTenantID, blobProviderRegistryStateKey, currentRaw, nextRaw); errors.Is(err, store.ErrConflict) {
			continue
		} else {
			return err
		}
	}
	return store.ErrConflict
}
