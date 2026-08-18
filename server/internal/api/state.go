package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func (s *Server) readTenantBlob(ctx context.Context, tenantID, key string, limit int64) (blobObject, error) {
	name, ok := blobFilename(key)
	if !ok {
		return blobObject{}, errors.New("invalid blob key")
	}
	objects, err := s.resolveBlobObjectStore(ctx, tenantID)
	if err != nil {
		return blobObject{}, err
	}
	if objects != nil {
		value, err := objects.Get(ctx, tenantID, name, limit)
		if err != nil {
			return blobObject{}, err
		}
		if value.Metadata.Deleted {
			return blobObject{}, store.ErrNotFound
		}
		if !allowedBlobMediaType(value.Metadata.ContentType) {
			return blobObject{}, errors.New("invalid blob metadata")
		}
		return value, nil
	}
	dir := filepath.Join(s.dataDir, "blobs", tenantID)
	filePath := filepath.Join(dir, name)
	metaPath := filepath.Join(dir, name+".json")
	if _, err := os.Stat(filePath); err != nil && tenantID == store.DefaultTenantID {
		legacy := filepath.Join(s.dataDir, "blobs", name)
		if _, legacyErr := os.Stat(legacy); legacyErr == nil {
			filePath = legacy
			metaPath = filepath.Join(s.dataDir, "blobs", name+".json")
		}
	}
	file, err := os.Open(filePath)
	if err != nil {
		return blobObject{}, store.ErrNotFound
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return blobObject{}, err
	}
	if int64(len(data)) > limit {
		return blobObject{}, errBlobObjectTooLarge
	}
	metadata := readBlobMetadata(metaPath)
	if metadata.ContentType == "" {
		metadata.ContentType = "application/octet-stream"
	}
	return blobObject{Data: data, Metadata: metadata}, nil
}

const maxStateBytes = 32 << 20

const userConfigStateKeyPrefix = "__user_config_v1:"

type blobReservation struct {
	ID    string `json:"id"`
	Bytes int64  `json:"bytes"`
}

type blobMetadata struct {
	ContentType string            `json:"contentType"`
	Reservation blobReservation   `json:"storageReservation,omitempty"`
	Superseded  []blobReservation `json:"supersededStorageReservations,omitempty"`
	Deleted     bool              `json:"deleted,omitempty"`
}

var stateKeys = map[string]struct{}{
	"config": {}, "assets": {}, "prompts": {},
}

func requestStateStorageKey(r *http.Request, key string) (string, bool) {
	if key == "config" && authMode() != "off" {
		if user, ok := authUserFrom(r.Context()); ok {
			id := strings.TrimSpace(user.ID)
			if id != "" && len(id) <= 128 {
				return userConfigStateKeyPrefix + id, false
			}
		}
	}
	return key, true
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if _, ok := stateKeys[key]; !ok || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	storageKey, tenantWide := requestStateStorageKey(r, key)
	value, err := s.store.GetState(r.Context(), tenantIDFrom(r), storageKey)
	if errors.Is(err, store.ErrNotFound) && key == "config" && !tenantWide {
		value, err = s.store.GetState(r.Context(), tenantIDFrom(r), key)
	}
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read state", http.StatusInternalServerError)
		return
	}
	if key == "config" {
		secretsKey, _ := secretStorageKey(r)
		secrets, secretErr := s.store.GetState(r.Context(), tenantIDFrom(r), secretsKey)
		if secretErr != nil && !errors.Is(secretErr, store.ErrNotFound) {
			http.Error(w, "failed to read config version", http.StatusInternalServerError)
			return
		}
		if errors.Is(secretErr, store.ErrNotFound) {
			secrets = nil
		}
		setContentETag(w, configStateVersion(value, secrets))
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(value)
}

func (s *Server) compareAndSwapConfigState(
	w http.ResponseWriter,
	r *http.Request,
	tenantID string,
	storageKey string,
	tenantWide bool,
	value []byte,
) bool {
	expectedVersion, createOnly, ok := parseExpectedVersion(w, r)
	if !ok {
		return false
	}
	current, err := s.store.GetState(r.Context(), tenantID, storageKey)
	secretsKey, _ := secretStorageKey(r)
	currentSecrets, secretsErr := s.store.GetState(r.Context(), tenantID, secretsKey)
	if secretsErr == nil || !errors.Is(secretsErr, store.ErrNotFound) {
		if secretsErr != nil {
			http.Error(w, "failed to read config secrets", http.StatusInternalServerError)
		} else {
			http.Error(w, "config and secrets must be saved together", http.StatusConflict)
		}
		return false
	}
	matchedFallback := false
	if errors.Is(err, store.ErrNotFound) && !tenantWide && !createOnly {
		current, err = s.store.GetState(r.Context(), tenantID, "config")
		if err == nil && configStateVersion(current, currentSecrets) == expectedVersion {
			current = nil
			matchedFallback = true
		}
	}
	if createOnly {
		if err == nil {
			http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
			return false
		}
		if !errors.Is(err, store.ErrNotFound) {
			http.Error(w, "failed to read config state", http.StatusInternalServerError)
			return false
		}
		current = nil
	} else if !matchedFallback && (err != nil || configStateVersion(current, currentSecrets) != expectedVersion) {
		http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		return false
	}
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, storageKey, current, value); err != nil {
		if errors.Is(err, store.ErrConflict) {
			http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		} else {
			http.Error(w, "failed to store state", http.StatusInternalServerError)
		}
		return false
	}
	stored, err := s.store.GetState(r.Context(), tenantID, storageKey)
	if err != nil {
		http.Error(w, "failed to read stored config state", http.StatusInternalServerError)
		return false
	}
	setContentETag(w, configStateVersion(stored, nil))
	return true
}

func (s *Server) putState(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if _, ok := stateKeys[key]; !ok || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Account-backed config is always personal, including for tenant Owners.
	// Tenant provider destinations and credentials live behind the explicit
	// /api/tenant/channels control plane instead of being inferred from a role.
	storageKey, tenantWide := requestStateStorageKey(r, key)
	if key == "config" && tenantWide && !s.requireTenantOwner(w, r, "tenant state unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxStateBytes)
	value, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(value) {
		http.Error(w, "invalid state json", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	if key == "config" && !tenantWide {
		if err := validatePersonalChannelDestinations(value); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _, _, _, currentConfig, _, _, readErr := s.currentConfigBundle(r)
		if readErr != nil {
			http.Error(w, "failed to read config bundle", http.StatusInternalServerError)
			return
		}
		if err := s.enforceMemberCustomChannelPolicy(
			r.Context(), r, currentConfig, value, nil, nil,
		); err != nil {
			writeCustomChannelPolicyError(w, err)
			return
		}
	}
	if key == "config" && tenantWide {
		if err := s.preventTenantObjectStorageRebind(r.Context(), tenantID, value); errors.Is(err, errTenantObjectStorageRebind) {
			http.Error(w, "object storage destination cannot be changed while data exists", http.StatusConflict)
			return
		} else if err != nil {
			http.Error(w, "invalid object storage configuration", http.StatusBadRequest)
			return
		}
	}
	if key == "config" {
		if !s.compareAndSwapConfigState(w, r, tenantID, storageKey, tenantWide, value) {
			return
		}
	} else {
		if err := s.store.PutState(r.Context(), tenantID, storageKey, value); err != nil {
			http.Error(w, "failed to store state", http.StatusInternalServerError)
			return
		}
	}
	if key == "config" && tenantWide {
		s.InvalidateTenantBlobStore(tenantID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func blobFilename(key string) (string, bool) {
	if len(key) < 1 || len(key) > 512 {
		return "", false
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:]), true
}

func blobKeyFromRequest(r *http.Request) (string, bool) {
	escapedPath := r.URL.EscapedPath()
	const marker = "/api/blobs/"
	index := strings.Index(escapedPath, marker)
	if index < 0 {
		return "", false
	}
	escapedKey := escapedPath[index+len(marker):]
	if escapedKey == "" || strings.Contains(escapedKey, "/") {
		return "", false
	}
	key, err := url.PathUnescape(escapedKey)
	if err != nil {
		return "", false
	}
	if _, ok := blobFilename(key); !ok {
		return "", false
	}
	return key, true
}

func (s *Server) putBlob(w http.ResponseWriter, r *http.Request) {
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	key, ok := blobKeyFromRequest(r)
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
		return
	}
	if publicBlobAPIProtectedKey(key) {
		http.Error(w, "protected blobs cannot be written through the public blob API", http.StatusForbidden)
		return
	}
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || !allowedBlobMediaType(mediaType) {
		http.Error(w, "unsupported blob content type", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid or oversized blob", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	if err := s.storeTenantBlob(r.Context(), tenantID, userIDFrom(r), key, mediaType, data); err != nil {
		switch {
		case errors.Is(err, store.ErrQuotaExceeded):
			http.Error(w, "blob storage quota exceeded", http.StatusInsufficientStorage)
		default:
			http.Error(w, "failed to store blob", http.StatusInternalServerError)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) storeTenantBlob(ctx context.Context, tenantID, userID, key, mediaType string, data []byte) error {
	return s.storeTenantBlobConditional(ctx, tenantID, userID, key, mediaType, data, "")
}

func (s *Server) storeTenantBlobConditional(ctx context.Context, tenantID, userID, key, mediaType string, data []byte, expectedContentVersion string) error {
	name, ok := blobFilename(key)
	if !ok || !allowedBlobMediaType(mediaType) || len(data) > maxUploadBytes {
		return errors.New("invalid blob")
	}
	objects, err := s.resolveBlobObjectStore(ctx, tenantID)
	if err != nil {
		return err
	}
	if objects != nil {
		return s.storeTenantObjectBlob(ctx, tenantID, userID, key, name, mediaType, data, objects, expectedContentVersion)
	}
	dir := filepath.Join(s.dataDir, "blobs", tenantID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	unlockBlob, err := lockTenantBlob(s.dataDir, tenantID, name)
	if err != nil {
		return err
	}
	defer unlockBlob()
	s.mu.Lock()
	defer s.mu.Unlock()
	currentData, currentErr := os.ReadFile(filepath.Join(dir, name))
	currentExists := currentErr == nil
	if currentErr != nil && !errors.Is(currentErr, os.ErrNotExist) {
		return currentErr
	}
	if expectedContentVersion == blobVersionAbsent && currentExists {
		return errBlobObjectConflict
	}
	if expectedContentVersion != "" && expectedContentVersion != blobVersionAbsent {
		if !currentExists {
			return errBlobObjectConflict
		}
		currentMetadata := readBlobMetadata(filepath.Join(dir, name+".json"))
		currentType := currentMetadata.ContentType
		if currentType == "" {
			currentType = "application/octet-stream"
		}
		if blobContentVersion(currentType, currentData) != expectedContentVersion {
			return errBlobObjectConflict
		}
	}
	storedBytes, err := directoryBytes(dir)
	if err != nil {
		return err
	}
	var replacedBytes int64
	for _, existing := range []string{filepath.Join(dir, name), filepath.Join(dir, name+".json")} {
		if info, statErr := os.Stat(existing); statErr == nil {
			storedBytes -= info.Size()
			replacedBytes += info.Size()
		}
	}
	oldMetadata := blobMetadata{}
	if value, readErr := os.ReadFile(filepath.Join(dir, name+".json")); readErr == nil {
		_ = json.Unmarshal(value, &oldMetadata)
	}
	superseded := append([]blobReservation(nil), oldMetadata.Superseded...)
	if oldMetadata.Reservation.ID != "" && oldMetadata.Reservation.Bytes > 0 {
		superseded = append(superseded, oldMetadata.Reservation)
	}
	compactMetadata := blobMetadata{
		ContentType: mediaType,
		Reservation: blobReservation{ID: randomGenerationOwner()},
	}
	var compactMeta []byte
	for range 3 {
		compactMeta, _ = json.Marshal(compactMetadata)
		accounted := int64(len(data) + len(compactMeta))
		if compactMetadata.Reservation.Bytes == accounted {
			break
		}
		compactMetadata.Reservation.Bytes = accounted
	}
	compactMeta, _ = json.Marshal(compactMetadata)
	pendingMetadata := compactMetadata
	pendingMetadata.Superseded = superseded
	pendingMeta, _ := json.Marshal(pendingMetadata)
	newBytes := compactMetadata.Reservation.Bytes
	if storedBytes+int64(len(data)+len(pendingMeta)) > maxStoredFiles {
		return store.ErrQuotaExceeded
	}
	usageMeta, _ := json.Marshal(map[string]any{"blobKey": key, "reservationId": compactMetadata.Reservation.ID})
	reserved := false
	if s.store != nil {
		if err := s.store.ReserveStorageUsage(ctx, tenantID, userID, newBytes, usageMeta); err != nil {
			return err
		}
		reserved = true
	}
	if err := atomicWriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		if reserved {
			_ = s.releaseBlobReservation(context.Background(), tenantID, userID, compactMetadata.Reservation, key)
		}
		return err
	}
	if err := atomicWriteFile(filepath.Join(dir, name+".json"), pendingMeta, 0o600); err != nil {
		_ = os.Remove(filepath.Join(dir, name))
		if reserved {
			_ = s.releaseBlobReservation(context.Background(), tenantID, userID, compactMetadata.Reservation, key)
		}
		return err
	}
	if s.store != nil {
		for _, reservation := range superseded {
			if err := s.releaseBlobReservation(ctx, tenantID, userID, reservation, key); err != nil {
				return err
			}
		}
		if oldMetadata.Reservation.ID == "" && replacedBytes > 0 {
			legacyMeta, _ := json.Marshal(map[string]any{"blobKey": key, "operation": "replace-legacy"})
			if err := s.store.ReleaseStorageUsage(ctx, tenantID, userID, replacedBytes, legacyMeta); err != nil {
				return err
			}
		}
	}
	if err := atomicWriteFile(filepath.Join(dir, name+".json"), compactMeta, 0o600); err != nil {
		return err
	}
	return nil
}

func (s *Server) releaseBlobReservation(ctx context.Context, tenantID, userID string, reservation blobReservation, key string) error {
	if s.store == nil || reservation.ID == "" || reservation.Bytes <= 0 {
		return nil
	}
	meta, _ := json.Marshal(map[string]any{"blobKey": key, "releaseOf": reservation.ID})
	return s.store.ReleaseStorageUsage(ctx, tenantID, userID, reservation.Bytes, meta)
}

func readBlobMetadata(path string) blobMetadata {
	value, err := os.ReadFile(path)
	if err != nil {
		return blobMetadata{}
	}
	metadata := blobMetadata{}
	if json.Unmarshal(value, &metadata) != nil {
		return blobMetadata{}
	}
	return metadata
}

func (s *Server) deleteTenantBlob(ctx context.Context, tenantID, userID, key string) error {
	name, ok := blobFilename(key)
	if !ok {
		return errors.New("invalid blob key")
	}
	objects, err := s.resolveBlobObjectStore(ctx, tenantID)
	if err != nil {
		return err
	}
	if objects != nil {
		return s.deleteTenantObjectBlob(ctx, tenantID, userID, key, name, objects)
	}
	unlockBlob, err := lockTenantBlob(s.dataDir, tenantID, name)
	if err != nil {
		return err
	}
	defer unlockBlob()
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dataDir, "blobs", tenantID)
	metaPath := filepath.Join(dir, name+".json")
	metadata := readBlobMetadata(metaPath)
	var removedBytes int64
	for _, path := range []string{filepath.Join(dir, name), metaPath} {
		if info, err := os.Stat(path); err == nil {
			removedBytes += info.Size()
		}
	}
	if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	reservations := append([]blobReservation{metadata.Reservation}, metadata.Superseded...)
	for _, reservation := range reservations {
		if err := s.releaseBlobReservation(ctx, tenantID, userID, reservation, key); err != nil {
			return err
		}
	}
	if s.store != nil && metadata.Reservation.ID == "" && removedBytes > 0 {
		meta, _ := json.Marshal(map[string]any{"blobKey": key, "operation": "delete"})
		if err := s.store.ReleaseStorageUsage(ctx, tenantID, userID, removedBytes, meta); err != nil {
			return err
		}
	}
	if err := os.Remove(metaPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *Server) readTenantImageBlob(tenantID, key string) (generatedImage, error) {
	return s.readTenantImageBlobContext(context.Background(), tenantID, key)
}

func (s *Server) readTenantImageBlobContext(ctx context.Context, tenantID, key string) (generatedImage, error) {
	value, err := s.readTenantBlob(ctx, tenantID, key, maxGeneratedImageBytes)
	if err != nil {
		return generatedImage{}, err
	}
	if len(value.Data) > maxGeneratedImageBytes {
		return generatedImage{}, errors.New("invalid or oversized image blob")
	}
	imageValue := generatedImage{Data: value.Data, MIMEType: value.Metadata.ContentType}
	if _, _, _, err := validateReferenceImage(imageValue); err != nil {
		return generatedImage{}, err
	}
	return imageValue, nil
}

func (s *Server) getBlob(w http.ResponseWriter, r *http.Request) {
	key, ok := blobKeyFromRequest(r)
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	value, err := s.readTenantBlob(r.Context(), tenantID, key, maxUploadBytes)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read blob", http.StatusInternalServerError)
		return
	}
	if value.Metadata.ContentType != "" {
		w.Header().Set("Content-Type", value.Metadata.ContentType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if value.Metadata.ContentType == "application/octet-stream" {
		w.Header().Set("Content-Disposition", "attachment")
	}
	http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(value.Data))
}

func allowedBlobMediaType(value string) bool {
	if value == "application/octet-stream" || value == "application/json" || value == "application/zip" || value == "application/x-subrip" {
		return true
	}
	if value == "image/avif" || value == "image/gif" || value == "image/jpeg" ||
		value == "image/png" || value == "image/webp" {
		return true
	}
	return strings.HasPrefix(value, "audio/") || strings.HasPrefix(value, "video/")
}

func (s *Server) deleteBlob(w http.ResponseWriter, r *http.Request) {
	key, ok := blobKeyFromRequest(r)
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
		return
	}
	if publicBlobAPIProtectedKey(key) {
		http.Error(w, "protected blobs cannot be deleted through the public blob API", http.StatusForbidden)
		return
	}
	if err := s.deleteTenantBlob(r.Context(), tenantIDFrom(r), userIDFrom(r), key); err != nil {
		http.Error(w, "failed to delete blob", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
