package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const maxStateBytes = 32 << 20

var stateKeys = map[string]struct{}{
	"config": {}, "assets": {}, "prompts": {},
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if _, ok := stateKeys[key]; !ok || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	value, err := s.store.GetState(r.Context(), tenantIDFrom(r), key)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read state", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(value)
}

func (s *Server) putState(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if _, ok := stateKeys[key]; !ok || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxStateBytes)
	value, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(value) {
		http.Error(w, "invalid state json", http.StatusBadRequest)
		return
	}
	if err := s.store.PutState(r.Context(), tenantIDFrom(r), key, value); err != nil {
		http.Error(w, "failed to store state", http.StatusInternalServerError)
		return
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

func (s *Server) putBlob(w http.ResponseWriter, r *http.Request) {
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	name, ok := blobFilename(chi.URLParam(r, "key"))
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
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
	dir := filepath.Join(s.dataDir, "blobs", tenantID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "failed to prepare blob store", 500)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	storedBytes, err := directoryBytes(dir)
	if err != nil {
		http.Error(w, "failed to inspect blob storage", http.StatusInternalServerError)
		return
	}
	var replacedBytes int64
	for _, existing := range []string{filepath.Join(dir, name), filepath.Join(dir, name+".json")} {
		if info, statErr := os.Stat(existing); statErr == nil {
			storedBytes -= info.Size()
			replacedBytes += info.Size()
		}
	}
	if storedBytes+int64(len(data))+int64(len(mediaType))+128 > maxStoredFiles {
		http.Error(w, "blob storage quota exceeded", http.StatusInsufficientStorage)
		return
	}
	additional := int64(len(data)) + int64(len(mediaType)) + 128 - replacedBytes
	if additional < 0 {
		additional = 0
	}
	if s.store != nil {
		if err := s.store.CheckStorageQuota(r.Context(), tenantID, additional); errors.Is(err, store.ErrQuotaExceeded) {
			http.Error(w, "blob storage quota exceeded", http.StatusInsufficientStorage)
			return
		} else if err != nil {
			http.Error(w, "failed to check storage quota", http.StatusInternalServerError)
			return
		}
	}
	if err := atomicWriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		http.Error(w, "failed to store blob", 500)
		return
	}
	meta, _ := json.Marshal(map[string]string{"contentType": mediaType})
	if err := atomicWriteFile(filepath.Join(dir, name+".json"), meta, 0o600); err != nil {
		_ = os.Remove(filepath.Join(dir, name))
		http.Error(w, "failed to store blob metadata", 500)
		return
	}
	if s.store != nil && additional > 0 {
		usageMeta, _ := json.Marshal(map[string]any{"blobKey": chi.URLParam(r, "key")})
		units := int(additional)
		if int64(units) != additional {
			units = int(^uint(0) >> 1)
		}
		_ = s.store.RecordUsage(r.Context(), tenantID, userIDFrom(r), "storage_bytes", units, usageMeta)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getBlob(w http.ResponseWriter, r *http.Request) {
	name, ok := blobFilename(chi.URLParam(r, "key"))
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	dir := filepath.Join(s.dataDir, "blobs", tenantID)
	// Pre-multi-tenant installs stored blobs flat under dataDir/blobs. For the
	// default local tenant only, fall back so existing media remains readable.
	filePath := filepath.Join(dir, name)
	metaPath := filepath.Join(dir, name+".json")
	if _, err := os.Stat(filePath); err != nil && tenantID == store.DefaultTenantID {
		legacy := filepath.Join(s.dataDir, "blobs", name)
		if _, legacyErr := os.Stat(legacy); legacyErr == nil {
			filePath = legacy
			metaPath = filepath.Join(s.dataDir, "blobs", name+".json")
		}
	}
	meta := struct {
		ContentType string `json:"contentType"`
	}{}
	if value, err := os.ReadFile(metaPath); err == nil {
		_ = json.Unmarshal(value, &meta)
	}
	if meta.ContentType != "" {
		w.Header().Set("Content-Type", meta.ContentType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if meta.ContentType == "application/octet-stream" {
		w.Header().Set("Content-Disposition", "attachment")
	}
	http.ServeFile(w, r, filePath)
}

func allowedBlobMediaType(value string) bool {
	if value == "application/octet-stream" {
		return true
	}
	if value == "image/avif" || value == "image/gif" || value == "image/jpeg" ||
		value == "image/png" || value == "image/webp" {
		return true
	}
	return strings.HasPrefix(value, "audio/") || strings.HasPrefix(value, "video/")
}

func (s *Server) deleteBlob(w http.ResponseWriter, r *http.Request) {
	name, ok := blobFilename(chi.URLParam(r, "key"))
	if !ok {
		http.Error(w, "invalid blob key", http.StatusBadRequest)
		return
	}
	dir := filepath.Join(s.dataDir, "blobs", tenantIDFrom(r))
	_ = os.Remove(filepath.Join(dir, name))
	_ = os.Remove(filepath.Join(dir, name+".json"))
	w.WriteHeader(http.StatusNoContent)
}
