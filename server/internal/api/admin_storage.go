package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const webDAVMediaEnabledHeader = "X-OpenBoard-WebDAV-Media-Enabled"

func decodeAdminStorageJSON(body io.Reader, target any, limit int64) error {
	decoder := json.NewDecoder(io.LimitReader(body, limit+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

type adminStoragePoolProvider struct {
	ID                    string `json:"id"`
	Endpoint              string `json:"endpoint"`
	Bucket                string `json:"bucket"`
	Region                string `json:"region"`
	Prefix                string `json:"prefix"`
	Weight                uint32 `json:"weight"`
	Healthy               bool   `json:"healthy"`
	AllowInsecureLoopback bool   `json:"allowInsecureLoopback,omitempty"`
	AllowPrivate          bool   `json:"allowPrivate,omitempty"`
	SecretConfigured      bool   `json:"secretConfigured"`
	Kind                  string `json:"kind"`
	ConfiguredSelectable  bool   `json:"configuredSelectable"`
	ProbeKnown            bool   `json:"probeKnown"`
	ProbeHealthy          bool   `json:"probeHealthy"`
	CapacityKnown         bool   `json:"capacityKnown"`
	TotalBytes            int64  `json:"totalBytes,omitempty"`
	AvailableBytes        int64  `json:"availableBytes,omitempty"`
	Error                 string `json:"error,omitempty"`
}

func sameStoragePoolProviderConfiguration(left, right tenantStoragePoolProvider) bool {
	return left.ID == right.ID && left.Kind == right.Kind && left.Endpoint == right.Endpoint &&
		left.Bucket == right.Bucket && left.Region == right.Region && left.Prefix == right.Prefix &&
		left.Weight == right.Weight && left.Healthy == right.Healthy && left.Deleted == right.Deleted &&
		left.AllowInsecureLoopback == right.AllowInsecureLoopback && left.AllowPrivate == right.AllowPrivate
}

func (s *Server) getAdminStoragePool(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant storage pool unavailable") {
		return
	}
	webDAVEnabled := "false"
	if incrementFeatureEnabled(webDAVMediaFeatureEnv) {
		webDAVEnabled = "true"
	}
	w.Header().Set(webDAVMediaEnabledHeader, webDAVEnabled)
	configRaw, rawErr := getOptionalState(r.Context(), s.store, tenantIDFrom(r), tenantStoragePoolStateKey)
	if rawErr != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	providers := []tenantStoragePoolProvider{}
	var err error
	if len(configRaw) > 0 {
		providers, err = decodeTenantStoragePool(configRaw)
	}
	if err != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(providers))
	secrets, _, err := s.loadTenantStoragePoolSecrets(r.Context(), tenantIDFrom(r), providers)
	if err != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	if len(providers) == 0 {
		statuses, statusErr := s.BlobStoragePoolStatus(r.Context())
		if statusErr != nil {
			writeJSON(w, []adminStoragePoolProvider{})
			return
		}
		writeJSON(w, statuses)
		return
	}
	statuses := map[string]BlobStoragePoolProviderStatus{}
	if pool, poolErr := s.tenantStoragePool(r.Context(), tenantIDFrom(r)); poolErr == nil && pool != nil {
		if concrete, ok := pool.(*blobStoragePoolStore); ok {
			for _, status := range concrete.Status(r.Context()) {
				statuses[status.ID] = status
			}
		}
	}
	result := make([]adminStoragePoolProvider, 0, len(providers))
	for _, provider := range providers {
		if provider.Deleted {
			continue
		}
		status := statuses[provider.ID]
		result = append(result, adminStoragePoolProvider{
			ID: provider.ID, Endpoint: provider.Endpoint, Bucket: provider.Bucket, Region: provider.Region, Prefix: provider.Prefix,
			Weight: provider.Weight, Healthy: provider.Healthy, AllowInsecureLoopback: provider.AllowInsecureLoopback, AllowPrivate: provider.AllowPrivate,
			SecretConfigured: validTenantStorageCredential(provider, secrets[provider.ID]), Kind: provider.Kind, ConfiguredSelectable: status.ConfiguredSelectable,
			ProbeKnown: status.ProbeKnown, ProbeHealthy: status.ProbeHealthy, CapacityKnown: status.CapacityKnown,
			TotalBytes: status.TotalBytes, AvailableBytes: status.AvailableBytes, Error: status.Error,
		})
	}
	writeJSON(w, result)
}

func (s *Server) putAdminStoragePool(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant storage pool unavailable") {
		return
	}
	var input []tenantStoragePoolProvider
	if err := decodeAdminStorageJSON(r.Body, &input, 1<<20); err != nil || len(input) > maxBlobStorageProviders {
		http.Error(w, "invalid storage pool", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	currentRaw, getErr := s.store.GetState(r.Context(), tenantID, tenantStoragePoolStateKey)
	if errors.Is(getErr, store.ErrNotFound) {
		currentRaw = nil
	} else if getErr != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	current := []tenantStoragePoolProvider{}
	var err error
	if len(currentRaw) > 0 {
		current, err = decodeTenantStoragePool(currentRaw)
	}
	if err != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	if revision := r.Header.Get(adminRevisionHeader); revision == "" || revision != adminConfigRevision(current) {
		http.Error(w, "storage pool changed concurrently", http.StatusConflict)
		return
	}
	currentByID := make(map[string]tenantStoragePoolProvider, len(current))
	for _, provider := range current {
		currentByID[provider.ID] = provider
	}
	next := make([]tenantStoragePoolProvider, 0, len(current)+len(input))
	seen := make(map[string]struct{}, len(input))
	webDAVEnabled := incrementFeatureEnabled(webDAVMediaFeatureEnv)
	for _, raw := range input {
		provider, normalizeErr := normalizeTenantStoragePoolProvider(raw)
		if normalizeErr != nil {
			http.Error(w, "invalid storage provider", http.StatusBadRequest)
			return
		}
		if _, duplicate := seen[provider.ID]; duplicate {
			http.Error(w, "duplicate storage provider id", http.StatusBadRequest)
			return
		}
		seen[provider.ID] = struct{}{}
		if previous, exists := currentByID[provider.ID]; exists {
			if previous.Deleted {
				http.Error(w, "deleted storage provider id is permanently reserved; create a new id", http.StatusConflict)
				return
			}
			if provider.Kind == "webdav" && !webDAVEnabled && !sameStoragePoolProviderConfiguration(previous, provider) {
				http.Error(w, "WebDAV media storage is disabled", http.StatusNotFound)
				return
			}
			if previous.Kind != provider.Kind || previous.Endpoint != provider.Endpoint || previous.Bucket != provider.Bucket || previous.Prefix != provider.Prefix || previous.Region != provider.Region || previous.AllowInsecureLoopback != provider.AllowInsecureLoopback || previous.AllowPrivate != provider.AllowPrivate {
				http.Error(w, "storage provider id cannot be rebound; create a new id", http.StatusConflict)
				return
			}
			provider.SecretBindingID = previous.SecretBindingID
		} else {
			// A platform administrator approves the server-side private-network
			// destination once. The tenant Owner may later adjust operational
			// fields without needing a standing platform grant, while endpoint and
			// private-network flags remain immutable for this provider ID.
			if provider.AllowPrivate && !s.requirePlatformAdmin(w, r) {
				return
			}
			if provider.Kind == "webdav" && !webDAVEnabled {
				http.Error(w, "WebDAV media storage is disabled", http.StatusNotFound)
				return
			}
			if s.processBlobProviderIDExists(provider.ID) {
				http.Error(w, "storage provider id conflicts with process storage", http.StatusConflict)
				return
			}
			provider.SecretBindingID = randomGenerationOwner()
		}
		provider.Deleted = false
		next = append(next, provider)
	}
	// Omitted providers are tombstoned instead of physically removed so old
	// placement records and their encrypted credentials remain resolvable.
	for _, previous := range current {
		if _, retained := seen[previous.ID]; !retained {
			if previous.Kind == "webdav" && !webDAVEnabled && !previous.Deleted {
				next = append(next, previous)
				continue
			}
			previous.Deleted, previous.Healthy, previous.Weight = true, false, 0
			next = append(next, previous)
		}
	}
	raw, _ := json.Marshal(next)
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, tenantStoragePoolStateKey, currentRaw, raw); errors.Is(err, store.ErrConflict) {
		http.Error(w, "storage pool changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save storage pool", http.StatusInternalServerError)
		return
	}
	s.InvalidateTenantBlobStore(tenantID)
	s.getAdminStoragePool(w, r)
}

func (s *Server) putAdminStoragePoolSecret(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant storage pool unavailable") {
		return
	}
	var input tenantStoragePoolCredential
	if err := decodeAdminStorageJSON(r.Body, &input, maxObjectStorageSecret*3); err != nil || len(input.AccessKeyID) > 256 || len(input.SecretAccessKey) > maxObjectStorageSecret || len(input.SessionToken) > maxObjectStorageSecret || len(input.Username) > 256 || len(input.Password) > maxObjectStorageSecret {
		http.Error(w, "invalid storage credentials", http.StatusBadRequest)
		return
	}
	tenantID, id := tenantIDFrom(r), chi.URLParam(r, "id")
	configRaw, err := s.store.GetState(r.Context(), tenantID, tenantStoragePoolStateKey)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "storage provider not found", http.StatusNotFound)
		return
	}
	providers, err := decodeTenantStoragePool(configRaw)
	if err != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	found := false
	var selected tenantStoragePoolProvider
	for _, provider := range providers {
		if provider.ID == id && !provider.Deleted {
			found, selected = true, provider
			break
		}
	}
	if !found {
		http.Error(w, "storage provider not found", http.StatusNotFound)
		return
	}
	if !validTenantStorageCredential(selected, input) {
		http.Error(w, "invalid storage credentials", http.StatusBadRequest)
		return
	}
	values, secretRaw, err := s.loadTenantStoragePoolSecrets(r.Context(), tenantID, providers)
	if err != nil {
		http.Error(w, "failed to load storage credentials", http.StatusInternalServerError)
		return
	}
	next := make(map[string]tenantStoragePoolCredential, len(values)+1)
	for key, value := range values {
		next[key] = value
	}
	next[id] = input
	envelope, err := s.encryptTenantStoragePoolSecrets(tenantID, providers, next)
	if err != nil {
		http.Error(w, "encrypted secret storage unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, tenantStoragePoolSecretsStateKey, secretRaw, envelope); errors.Is(err, store.ErrConflict) {
		http.Error(w, "storage credentials changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save storage credentials", http.StatusInternalServerError)
		return
	}
	s.InvalidateTenantBlobStore(tenantID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteAdminStoragePoolProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant storage pool unavailable") {
		return
	}
	tenantID, id := tenantIDFrom(r), chi.URLParam(r, "id")
	currentRaw, err := s.store.GetState(r.Context(), tenantID, tenantStoragePoolStateKey)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "storage provider not found", http.StatusNotFound)
		return
	}
	providers, err := decodeTenantStoragePool(currentRaw)
	if err != nil {
		http.Error(w, "failed to load storage pool", http.StatusInternalServerError)
		return
	}
	if revision := r.Header.Get(adminRevisionHeader); revision == "" || revision != adminConfigRevision(providers) {
		http.Error(w, "storage pool changed concurrently", http.StatusConflict)
		return
	}
	found := false
	for index := range providers {
		if providers[index].ID == id && !providers[index].Deleted {
			providers[index].Deleted, providers[index].Healthy, providers[index].Weight, found = true, false, 0, true
		}
	}
	if !found {
		http.Error(w, "storage provider not found", http.StatusNotFound)
		return
	}
	raw, _ := json.Marshal(providers)
	if err := s.store.CompareAndSwapState(r.Context(), tenantID, tenantStoragePoolStateKey, currentRaw, raw); errors.Is(err, store.ErrConflict) {
		http.Error(w, "storage pool changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save storage pool", http.StatusInternalServerError)
		return
	}
	s.InvalidateTenantBlobStore(tenantID)
	w.Header().Set(adminRevisionHeader, adminConfigRevision(providers))
	w.WriteHeader(http.StatusNoContent)
}
