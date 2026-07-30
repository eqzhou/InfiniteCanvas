package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/openboard/openboard/server/internal/store"
)

const blobObjectCASAttempts = 6

func (s *Server) storeTenantObjectBlob(ctx context.Context, tenantID, userID, key, name, mediaType string, data []byte, objects blobObjectStore, expectedContentVersion string) error {
	if objects == nil {
		return errors.New("object storage is unavailable")
	}
	for range blobObjectCASAttempts {
		current, err := objects.Get(ctx, tenantID, name, maxUploadBytes)
		expectedVersion := blobVersionAbsent
		if err == nil {
			expectedVersion = current.Version
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if expectedContentVersion == blobVersionAbsent && err == nil {
			return errBlobObjectConflict
		}
		if expectedContentVersion != "" && expectedContentVersion != blobVersionAbsent {
			if err != nil || blobContentVersion(current.Metadata.ContentType, current.Data) != expectedContentVersion {
				return errBlobObjectConflict
			}
		}

		superseded := append([]blobReservation(nil), current.Metadata.Superseded...)
		if current.Metadata.Reservation.ID != "" && current.Metadata.Reservation.Bytes > 0 {
			superseded = append(superseded, current.Metadata.Reservation)
		}
		reservation := blobReservation{ID: randomGenerationOwner(), Bytes: int64(len(data))}
		compact := blobMetadata{ContentType: mediaType, Reservation: reservation}
		pending := compact
		pending.Superseded = superseded
		usageMeta, _ := json.Marshal(map[string]any{"blobKey": key, "reservationId": reservation.ID, "backend": objects.Kind()})
		if s.store != nil {
			if err := s.store.ReserveStorageUsage(ctx, tenantID, userID, reservation.Bytes, usageMeta); err != nil {
				return err
			}
		}

		version, err := objects.Put(ctx, tenantID, name, blobObject{Data: data, Metadata: pending}, expectedVersion)
		if errors.Is(err, errBlobObjectConflict) {
			_ = s.releaseBlobReservation(context.Background(), tenantID, userID, reservation, key)
			if expectedContentVersion != "" {
				return errBlobObjectConflict
			}
			continue
		}
		if err != nil {
			_ = s.releaseBlobReservation(context.Background(), tenantID, userID, reservation, key)
			return err
		}

		for _, previous := range superseded {
			if err := s.releaseBlobReservation(ctx, tenantID, userID, previous, key); err != nil {
				// The pending metadata remains attached to the visible object so a
				// later overwrite/delete can retry the idempotent releases.
				return err
			}
		}
		if current.Metadata.Reservation.ID == "" && len(current.Data) > 0 && s.store != nil {
			meta, _ := json.Marshal(map[string]any{"blobKey": key, "operation": "replace-object-legacy"})
			if err := s.store.ReleaseStorageUsage(ctx, tenantID, userID, int64(len(current.Data)), meta); err != nil {
				return err
			}
		}
		// Compaction is best-effort. A concurrent writer has already copied
		// the pending releases forward; a transport failure leaves enough
		// metadata for the next lifecycle operation to finish cleanup.
		_, _ = objects.Put(ctx, tenantID, name, blobObject{Data: data, Metadata: compact}, version)
		return nil
	}
	return errBlobObjectConflict
}

func (s *Server) deleteTenantObjectBlob(ctx context.Context, tenantID, userID, key, name string, objects blobObjectStore) error {
	if objects == nil {
		return errors.New("object storage is unavailable")
	}
	for range blobObjectCASAttempts {
		current, err := objects.Get(ctx, tenantID, name, maxUploadBytes)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		current.Metadata.Deleted = true
		version, err := objects.Put(ctx, tenantID, name, blobObject{Metadata: current.Metadata}, current.Version)
		if errors.Is(err, errBlobObjectConflict) {
			continue
		}
		if err != nil {
			return err
		}
		reservations := append([]blobReservation{current.Metadata.Reservation}, current.Metadata.Superseded...)
		for _, reservation := range reservations {
			if err := s.releaseBlobReservation(ctx, tenantID, userID, reservation, key); err != nil {
				return err
			}
		}
		if current.Metadata.Reservation.ID == "" && len(current.Data) > 0 && s.store != nil {
			meta, _ := json.Marshal(map[string]any{"blobKey": key, "operation": "delete-object-legacy"})
			if err := s.store.ReleaseStorageUsage(ctx, tenantID, userID, int64(len(current.Data)), meta); err != nil {
				return err
			}
		}
		if err := objects.Delete(ctx, tenantID, name, version); errors.Is(err, errBlobObjectConflict) {
			return nil
		} else {
			return err
		}
	}
	return errBlobObjectConflict
}
