package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxMediaReferenceKeys    = 20
	defaultMediaReferenceTTL = 15 * time.Minute
	maxMediaReferenceTTL     = 24 * time.Hour
	minMediaReferenceTTL     = time.Minute
)

// providerFetchesReferenceMedia reports whether a protocol pulls reference
// media from its own network. Only those protocols read
// `generatedMedia.PublicURL`, so minting a token for any other one would
// publish tenant media to an anonymous URL that nothing ever requests.
func providerFetchesReferenceMedia(protocol string) bool {
	return protocol == "ark"
}

// referenceMediaTTL bounds how long a provider-facing token stays valid. The
// token only has to outlive the provider call, so it tracks the provider
// timeout with a floor for clock skew and retries instead of using the 24h
// ceiling that admin-minted references may request.
func referenceMediaTTL(providerTimeout time.Duration) time.Duration {
	ttl := providerTimeout * 2
	if ttl < defaultMediaReferenceTTL {
		ttl = defaultMediaReferenceTTL
	}
	if ttl > maxMediaReferenceTTL {
		ttl = maxMediaReferenceTTL
	}
	return ttl
}

// publicMediaReferenceURL mints a short-lived public URL for a tenant blob so a
// provider that fetches media itself can reach it. It returns an empty string
// when the deployment has no publicly reachable base URL, letting the caller
// fail closed instead of sending an address the provider cannot resolve.
func (s *Server) publicMediaReferenceURL(ctx context.Context, tenantID, storageKey string, ttl time.Duration) string {
	base := publicBaseURL()
	if base == "" || s == nil || s.store == nil {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || isExplicitLoopbackHost(parsed.Hostname()) {
		// A loopback or non-HTTPS base URL is not reachable by a third party.
		return ""
	}
	if ttl <= 0 {
		ttl = defaultMediaReferenceTTL
	}
	ref, err := s.store.CreateMediaReference(ctx, tenantID, storageKey, time.Now().UTC().Add(ttl))
	if err != nil {
		log.Printf("media reference minting failed for tenant %s: %v", tenantID, err)
		return ""
	}
	return base + "/api/media/references/" + url.PathEscape(ref.Token)
}

// sweepExpiredMediaReferences removes reference rows whose lifetime has passed.
// Reads already ignore expired tokens, but a token nobody fetches would
// otherwise stay in the table forever.
func (s *Server) sweepExpiredMediaReferences(ctx context.Context, now time.Time) int64 {
	if s == nil || s.store == nil {
		return 0
	}
	deleted, err := s.store.DeleteExpiredMediaReferences(ctx, now.UTC())
	if err != nil {
		log.Printf("expired media reference sweep failed: %v", err)
		return 0
	}
	return deleted
}

// sweepExpiredTombstones drops deleted-project and deleted-job markers once they
// have outlived any plausible stale client cache. Without this the markers,
// which exist to block resurrection writes, would accumulate forever.
func (s *Server) sweepExpiredTombstones(ctx context.Context, now time.Time) int64 {
	if s == nil || s.store == nil {
		return 0
	}
	purged, err := s.store.PurgeExpiredTombstones(ctx, now.UTC())
	if err != nil {
		log.Printf("expired tombstone purge failed: %v", err)
		return 0
	}
	return purged
}

type createMediaReferencesBody struct {
	StorageKeys []string `json:"storageKeys"`
	// TTLSeconds is optional; clamped to [60, 86400], default 900.
	TTLSeconds int `json:"ttlSeconds,omitempty"`
}

// createMediaReferences mints short-lived tokens that resolve to tenant blobs
// without exposing long-lived storage keys to third parties.
func (s *Server) createMediaReferences(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "media references unavailable", http.StatusServiceUnavailable)
		return
	}
	// Creating references always requires a session when auth is on.
	if authMode() != "off" {
		if _, ok := authUserFrom(r.Context()); !ok {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body createMediaReferencesBody
	if err := decoder.Decode(&body); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if len(body.StorageKeys) == 0 || len(body.StorageKeys) > maxMediaReferenceKeys {
		http.Error(w, "storageKeys must contain 1-20 keys", http.StatusBadRequest)
		return
	}
	ttl := defaultMediaReferenceTTL
	if body.TTLSeconds > 0 {
		ttl = time.Duration(body.TTLSeconds) * time.Second
		if ttl < minMediaReferenceTTL {
			ttl = minMediaReferenceTTL
		}
		if ttl > maxMediaReferenceTTL {
			ttl = maxMediaReferenceTTL
		}
	}
	expires := time.Now().UTC().Add(ttl)
	tenantID := tenantIDFrom(r)
	out := make([]store.MediaReference, 0, len(body.StorageKeys))
	seen := map[string]struct{}{}
	for _, key := range body.StorageKeys {
		key = strings.TrimSpace(key)
		if key == "" {
			http.Error(w, "empty storage key", http.StatusBadRequest)
			return
		}
		if _, ok := blobFilename(key); !ok {
			http.Error(w, "invalid storage key", http.StatusBadRequest)
			return
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		// Ensure the blob exists for this tenant before minting a token.
		if _, err := s.readTenantBlob(r.Context(), tenantID, key, maxUploadBytes); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, "storage key not found: "+key, http.StatusNotFound)
				return
			}
			http.Error(w, "failed to verify storage key", http.StatusInternalServerError)
			return
		}
		ref, err := s.store.CreateMediaReference(r.Context(), tenantID, key, expires)
		if err != nil {
			http.Error(w, "failed to create media reference", http.StatusInternalServerError)
			return
		}
		out = append(out, ref)
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, map[string]any{"items": out, "expiresAt": expires.Format(time.RFC3339Nano)})
}

// getMediaReference resolves a token to blob bytes (public GET, token is the secret).
func (s *Server) getMediaReference(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "media references unavailable", http.StatusServiceUnavailable)
		return
	}
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" || len(token) > 256 {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	ref, err := s.store.GetMediaReference(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load media reference", http.StatusInternalServerError)
		return
	}
	// Use the tenant embedded in the token, not the caller's session tenant.
	value, err := s.readTenantBlob(r.Context(), ref.TenantID, ref.StorageKey, maxUploadBytes)
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
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(value.Data)
}
