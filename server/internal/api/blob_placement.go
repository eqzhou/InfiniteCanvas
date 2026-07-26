package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	blobPlacementVersion   = 2
	blobPlacementPending   = "pending"
	blobPlacementCommitted = "committed"
)

var (
	errBlobPlacementConflict = errors.New("blob placement is immutable")
	errBlobPlacementPending  = errors.New("blob placement is pending")
)

type blobPlacement struct {
	Version     int    `json:"version"`
	ProviderID  string `json:"providerId,omitempty"`
	Destination string `json:"destination,omitempty"`
	Status      string `json:"status,omitempty"`
	ClaimID     string `json:"claimId,omitempty"`
	LeaseUntil  string `json:"leaseUntil,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
}

type blobPlacementStore interface {
	Get(context.Context, string, string) (blobPlacement, error)
	Put(context.Context, string, string, blobPlacement) error
	Claim(context.Context, string, string, blobPlacement, string, time.Time) error
	Commit(context.Context, string, string, string) error
	Abort(context.Context, string, string, string) error
	Delete(context.Context, string, string) error
}

type tenantStateBlobPlacementStore struct{ state store.Store }

func newTenantStateBlobPlacementStore(state store.Store) *tenantStateBlobPlacementStore {
	return &tenantStateBlobPlacementStore{state: state}
}

func blobPlacementStateKey(name string) string { return "__blob_placement_v1:" + name }

func normalizeBlobPlacement(value blobPlacement) (blobPlacement, error) {
	if value.Version == 0 {
		value.Version = blobPlacementVersion
	}
	if value.Status == "" {
		value.Status = blobPlacementCommitted
	}
	if value.Version != blobPlacementVersion || !blobStorageProviderIDPattern.MatchString(value.ProviderID) ||
		strings.TrimSpace(value.Destination) == "" || len(value.Destination) > 128 || value.Status != blobPlacementCommitted {
		return blobPlacement{}, errors.New("invalid blob placement")
	}
	value.ClaimID, value.LeaseUntil = "", ""
	return value, nil
}

func decodeStoredBlobPlacement(raw []byte) (blobPlacement, error) {
	var value blobPlacement
	if json.Unmarshal(raw, &value) != nil {
		return blobPlacement{}, errors.New("invalid stored blob placement")
	}
	if value.Deleted {
		return value, nil
	}
	// Version 1 placements predate destination fingerprints and are upgraded
	// only after the pool resolves their stable provider ID.
	if value.Version == 1 && blobStorageProviderIDPattern.MatchString(value.ProviderID) && value.Destination == "" {
		value.Status = blobPlacementCommitted
		return value, nil
	}
	if value.Version != blobPlacementVersion || !blobStorageProviderIDPattern.MatchString(value.ProviderID) ||
		strings.TrimSpace(value.Destination) == "" || len(value.Destination) > 128 ||
		(value.Status != blobPlacementCommitted && value.Status != blobPlacementPending) {
		return blobPlacement{}, errors.New("invalid stored blob placement")
	}
	if value.Status == blobPlacementPending {
		if value.ClaimID == "" {
			return blobPlacement{}, errors.New("invalid stored blob placement")
		}
		if _, err := time.Parse(time.RFC3339Nano, value.LeaseUntil); err != nil {
			return blobPlacement{}, errors.New("invalid stored blob placement")
		}
	}
	return value, nil
}

func (p *tenantStateBlobPlacementStore) Get(ctx context.Context, tenantID, name string) (blobPlacement, error) {
	if p == nil || p.state == nil {
		return blobPlacement{}, store.ErrNotFound
	}
	raw, err := p.state.GetState(ctx, tenantID, blobPlacementStateKey(name))
	if err != nil {
		return blobPlacement{}, err
	}
	value, err := decodeStoredBlobPlacement(raw)
	if err != nil {
		return blobPlacement{}, err
	}
	if value.Deleted {
		return blobPlacement{}, store.ErrNotFound
	}
	return value, nil
}

func (p *tenantStateBlobPlacementStore) Put(ctx context.Context, tenantID, name string, placement blobPlacement) error {
	placement, err := normalizeBlobPlacement(placement)
	if err != nil {
		return err
	}
	key := blobPlacementStateKey(name)
	next, _ := json.Marshal(placement)
	for range 4 {
		currentRaw, readErr := p.state.GetState(ctx, tenantID, key)
		if errors.Is(readErr, store.ErrNotFound) {
			if err := p.state.CompareAndSwapState(ctx, tenantID, key, nil, next); errors.Is(err, store.ErrConflict) {
				continue
			} else {
				return err
			}
		}
		if readErr != nil {
			return readErr
		}
		current, err := decodeStoredBlobPlacement(currentRaw)
		if err != nil {
			return err
		}
		if current.Deleted || (current.Version == 1 && current.ProviderID == placement.ProviderID) {
			if err := p.state.CompareAndSwapState(ctx, tenantID, key, currentRaw, next); errors.Is(err, store.ErrConflict) {
				continue
			} else {
				return err
			}
		}
		if current.Status == blobPlacementPending {
			expires, _ := time.Parse(time.RFC3339Nano, current.LeaseUntil)
			if time.Now().After(expires) && current.ProviderID == placement.ProviderID && current.Destination == placement.Destination {
				if err := p.state.CompareAndSwapState(ctx, tenantID, key, currentRaw, next); errors.Is(err, store.ErrConflict) {
					continue
				} else {
					return err
				}
			}
			return errBlobPlacementPending
		}
		if current.ProviderID == placement.ProviderID && current.Destination == placement.Destination {
			return nil
		}
		return errBlobPlacementConflict
	}
	return errBlobPlacementConflict
}

func (p *tenantStateBlobPlacementStore) Claim(ctx context.Context, tenantID, name string, placement blobPlacement, claimID string, leaseUntil time.Time) error {
	placement, err := normalizeBlobPlacement(placement)
	if err != nil || claimID == "" || !leaseUntil.After(time.Now()) {
		return errors.New("invalid blob placement claim")
	}
	placement.Status, placement.ClaimID = blobPlacementPending, claimID
	placement.LeaseUntil = leaseUntil.UTC().Format(time.RFC3339Nano)
	next, _ := json.Marshal(placement)
	key := blobPlacementStateKey(name)
	for range 4 {
		currentRaw, readErr := p.state.GetState(ctx, tenantID, key)
		if errors.Is(readErr, store.ErrNotFound) {
			if err := p.state.CompareAndSwapState(ctx, tenantID, key, nil, next); errors.Is(err, store.ErrConflict) {
				continue
			} else {
				return err
			}
		}
		if readErr != nil {
			return readErr
		}
		current, err := decodeStoredBlobPlacement(currentRaw)
		if err != nil {
			return err
		}
		claimable := current.Deleted
		if current.Status == blobPlacementPending {
			expires, _ := time.Parse(time.RFC3339Nano, current.LeaseUntil)
			claimable = time.Now().After(expires)
		}
		if !claimable {
			return errBlobPlacementConflict
		}
		if err := p.state.CompareAndSwapState(ctx, tenantID, key, currentRaw, next); errors.Is(err, store.ErrConflict) {
			continue
		} else {
			return err
		}
	}
	return errBlobPlacementConflict
}

func (p *tenantStateBlobPlacementStore) Commit(ctx context.Context, tenantID, name, claimID string) error {
	return p.finishClaim(ctx, tenantID, name, claimID, false)
}

func (p *tenantStateBlobPlacementStore) Abort(ctx context.Context, tenantID, name, claimID string) error {
	return p.finishClaim(ctx, tenantID, name, claimID, true)
}

func (p *tenantStateBlobPlacementStore) finishClaim(ctx context.Context, tenantID, name, claimID string, abort bool) error {
	key := blobPlacementStateKey(name)
	currentRaw, err := p.state.GetState(ctx, tenantID, key)
	if err != nil {
		return err
	}
	current, err := decodeStoredBlobPlacement(currentRaw)
	if err != nil {
		return err
	}
	if current.Status != blobPlacementPending || current.ClaimID != claimID {
		return errBlobPlacementConflict
	}
	var next []byte
	if abort {
		next, _ = json.Marshal(blobPlacement{Version: blobPlacementVersion, Deleted: true})
	} else {
		current.Status, current.ClaimID, current.LeaseUntil = blobPlacementCommitted, "", ""
		next, _ = json.Marshal(current)
	}
	if err := p.state.CompareAndSwapState(ctx, tenantID, key, currentRaw, next); errors.Is(err, store.ErrConflict) {
		return errBlobPlacementConflict
	} else {
		return err
	}
}

func (p *tenantStateBlobPlacementStore) Delete(ctx context.Context, tenantID, name string) error {
	if p == nil || p.state == nil {
		return nil
	}
	key := blobPlacementStateKey(name)
	raw, err := p.state.GetState(ctx, tenantID, key)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	current, err := decodeStoredBlobPlacement(raw)
	if err != nil {
		return err
	}
	if current.Deleted {
		return nil
	}
	if current.Status == blobPlacementPending {
		return errBlobPlacementPending
	}
	tombstone, _ := json.Marshal(blobPlacement{Version: blobPlacementVersion, Deleted: true})
	if err := p.state.CompareAndSwapState(ctx, tenantID, key, raw, tombstone); errors.Is(err, store.ErrConflict) {
		return errBlobPlacementConflict
	} else {
		return err
	}
}
