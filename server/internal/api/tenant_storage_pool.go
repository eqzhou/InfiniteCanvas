package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	tenantStoragePoolStateKey        = "__tenant_storage_pool_v1"
	tenantStoragePoolSecretsStateKey = "__encrypted_tenant_storage_pool_secrets_v1"
)

type tenantStoragePoolProvider struct {
	ID                    string `json:"id"`
	Endpoint              string `json:"endpoint"`
	Bucket                string `json:"bucket"`
	Region                string `json:"region"`
	Prefix                string `json:"prefix"`
	Weight                uint32 `json:"weight"`
	Healthy               bool   `json:"healthy"`
	AllowInsecureLoopback bool   `json:"allowInsecureLoopback,omitempty"`
	Deleted               bool   `json:"deleted,omitempty"`
	SecretBindingID       string `json:"secretBindingId"`
	SecretConfigured      bool   `json:"secretConfigured,omitempty"`
}

type tenantStoragePoolCredential struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken,omitempty"`
}

type tenantStoragePoolSecretsEnvelope struct {
	Version int                       `json:"version"`
	Entries map[string]secretEnvelope `json:"entries"`
}

func normalizeTenantStoragePoolProvider(raw tenantStoragePoolProvider) (tenantStoragePoolProvider, error) {
	raw.ID = strings.TrimSpace(raw.ID)
	raw.Endpoint = strings.TrimRight(strings.TrimSpace(raw.Endpoint), "/")
	raw.Bucket = strings.ToLower(strings.TrimSpace(raw.Bucket))
	raw.Region = strings.TrimSpace(raw.Region)
	if raw.Region == "" {
		raw.Region = "auto"
	}
	raw.Prefix = strings.Trim(strings.TrimSpace(raw.Prefix), "/")
	if raw.Prefix == "" {
		raw.Prefix = "openboard"
	}
	raw.SecretConfigured = false
	if !blobStorageProviderIDPattern.MatchString(raw.ID) || raw.Weight > maxBlobStorageProviderWeight {
		return tenantStoragePoolProvider{}, errInvalidBlobObjectConfig
	}
	// Validate every non-secret field through the hardened S3 constructor. Dummy
	// credentials are never persisted or used for a request.
	if _, err := newS3BlobObjectStore(S3BlobStorageConfig{
		Endpoint: raw.Endpoint, Bucket: raw.Bucket, Region: raw.Region, Prefix: raw.Prefix,
		AccessKeyID: "validation-only", SecretAccessKey: "validation-only",
		AllowInsecureLoopback: raw.AllowInsecureLoopback,
	}); err != nil {
		return tenantStoragePoolProvider{}, errInvalidBlobObjectConfig
	}
	return raw, nil
}

func tenantStoragePoolAAD(tenantID string, provider tenantStoragePoolProvider) []byte {
	return []byte(strings.Join([]string{"tenant-storage-pool-v1", tenantID, provider.ID, provider.SecretBindingID, provider.Endpoint, provider.Bucket, provider.Region, provider.Prefix, boolString(provider.AllowInsecureLoopback)}, "\x00"))
}

func (s *Server) processBlobProviderIDExists(id string) bool {
	s.tenantBlobStoreMu.Lock()
	process := s.blobObjects
	s.tenantBlobStoreMu.Unlock()
	if id == "process-fallback" && process != nil {
		return true
	}
	pool, ok := process.(*blobStoragePoolStore)
	if !ok {
		return false
	}
	pool.mu.RLock()
	defer pool.mu.RUnlock()
	_, exists := pool.providers[id]
	return exists
}

func (s *Server) loadTenantStoragePool(ctx context.Context, tenantID string) ([]tenantStoragePoolProvider, error) {
	raw, err := s.store.GetState(ctx, tenantID, tenantStoragePoolStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return []tenantStoragePoolProvider{}, nil
	}
	if err != nil || len(raw) > 1<<20 {
		return nil, errors.New("tenant storage pool unavailable")
	}
	return decodeTenantStoragePool(raw)
}

func decodeTenantStoragePool(raw []byte) ([]tenantStoragePoolProvider, error) {
	var providers []tenantStoragePoolProvider
	if json.Unmarshal(raw, &providers) != nil || len(providers) > maxBlobStorageProviders {
		return nil, errors.New("invalid tenant storage pool")
	}
	seen := make(map[string]struct{}, len(providers))
	for index := range providers {
		provider, normalizeErr := normalizeTenantStoragePoolProvider(providers[index])
		if normalizeErr != nil || provider.SecretBindingID == "" {
			return nil, errors.New("invalid tenant storage pool")
		}
		if _, exists := seen[provider.ID]; exists {
			return nil, errors.New("invalid tenant storage pool")
		}
		seen[provider.ID] = struct{}{}
		providers[index] = provider
	}
	return providers, nil
}

func (s *Server) decryptTenantStoragePoolSecretsRaw(tenantID string, providers []tenantStoragePoolProvider, raw []byte) (map[string]tenantStoragePoolCredential, error) {
	if len(raw) == 0 {
		return map[string]tenantStoragePoolCredential{}, nil
	}
	if s.secrets == nil {
		return nil, errors.New("encrypted secret storage unavailable")
	}
	var envelope tenantStoragePoolSecretsEnvelope
	if json.Unmarshal(raw, &envelope) != nil || envelope.Version != 1 || len(envelope.Entries) > maxBlobStorageProviders {
		return nil, errors.New("invalid tenant storage pool secrets")
	}
	byID := make(map[string]tenantStoragePoolProvider, len(providers))
	for _, provider := range providers {
		byID[provider.ID] = provider
	}
	result := make(map[string]tenantStoragePoolCredential, len(envelope.Entries))
	for id, entry := range envelope.Entries {
		provider, ok := byID[id]
		if !ok {
			continue
		}
		nonce, nonceErr := base64.RawStdEncoding.DecodeString(entry.Nonce)
		ciphertext, cipherErr := base64.RawStdEncoding.DecodeString(entry.Ciphertext)
		if nonceErr != nil || cipherErr != nil || len(nonce) != s.secrets.NonceSize() {
			continue
		}
		plain, openErr := s.secrets.Open(nil, nonce, ciphertext, tenantStoragePoolAAD(tenantID, provider))
		var credential tenantStoragePoolCredential
		if openErr != nil || len(plain) > maxObjectStorageSecret*3 || json.Unmarshal(plain, &credential) != nil || strings.TrimSpace(credential.AccessKeyID) == "" || strings.TrimSpace(credential.SecretAccessKey) == "" {
			continue
		}
		result[id] = credential
	}
	return result, nil
}

func (s *Server) loadTenantStoragePoolSecrets(ctx context.Context, tenantID string, providers []tenantStoragePoolProvider) (map[string]tenantStoragePoolCredential, []byte, error) {
	raw, err := s.store.GetState(ctx, tenantID, tenantStoragePoolSecretsStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return map[string]tenantStoragePoolCredential{}, nil, nil
	}
	if err != nil || len(raw) > 1<<20 {
		return nil, nil, errors.New("tenant storage pool secrets unavailable")
	}
	values, err := s.decryptTenantStoragePoolSecretsRaw(tenantID, providers, raw)
	return values, raw, err
}

func (s *Server) encryptTenantStoragePoolSecrets(tenantID string, providers []tenantStoragePoolProvider, values map[string]tenantStoragePoolCredential) ([]byte, error) {
	if s.secrets == nil {
		return nil, errors.New("encrypted secret storage unavailable")
	}
	byID := make(map[string]tenantStoragePoolProvider, len(providers))
	for _, provider := range providers {
		byID[provider.ID] = provider
	}
	entries := make(map[string]secretEnvelope, len(values))
	for id, credential := range values {
		provider, ok := byID[id]
		if !ok {
			continue
		}
		plain, _ := json.Marshal(credential)
		nonce := make([]byte, s.secrets.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return nil, err
		}
		entries[id] = secretEnvelope{Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, plain, tenantStoragePoolAAD(tenantID, provider)))}
	}
	return json.Marshal(tenantStoragePoolSecretsEnvelope{Version: 1, Entries: entries})
}

func (s *Server) tenantStoragePool(ctx context.Context, tenantID string) (blobObjectStore, error) {
	providers, err := s.loadTenantStoragePool(ctx, tenantID)
	if err != nil || len(providers) == 0 {
		return nil, err
	}
	secrets, _, err := s.loadTenantStoragePoolSecrets(ctx, tenantID, providers)
	if err != nil {
		return nil, err
	}
	configs := make([]blobStorageProviderConfig, 0, len(providers))
	fingerprintParts := make([]string, 0, len(providers))
	tenantSelectable := false
	for _, provider := range providers {
		credential, configured := secrets[provider.ID]
		if !configured {
			continue
		}
		storage := S3BlobStorageConfig{Endpoint: provider.Endpoint, Bucket: provider.Bucket, Region: provider.Region, Prefix: provider.Prefix, AccessKeyID: credential.AccessKeyID, SecretAccessKey: credential.SecretAccessKey, SessionToken: credential.SessionToken, AllowInsecureLoopback: provider.AllowInsecureLoopback}
		objects, buildErr := newS3BlobObjectStore(storage)
		if buildErr != nil {
			return nil, buildErr
		}
		health := blobStorageProviderUnhealthy
		if provider.Healthy && !provider.Deleted {
			health = blobStorageProviderHealthy
			if provider.Weight > 0 {
				tenantSelectable = true
			}
		}
		configs = append(configs, blobStorageProviderConfig{ID: provider.ID, Destination: s3BlobStorageDestination(objects), Weight: provider.Weight, Health: health, Store: objects})
		fingerprintParts = append(fingerprintParts, strings.Join([]string{provider.ID, objectStorageFingerprint(storage), boolString(provider.Healthy), boolString(provider.Deleted)}, "\x1e"))
	}
	// Keep process routes in the same resolver so pre-existing process-pool
	// placements remain readable after a tenant pool is enabled. They become
	// selectable only when the tenant has no healthy weighted destination.
	s.tenantBlobStoreMu.Lock()
	process := s.blobObjects
	s.tenantBlobStoreMu.Unlock()
	if processPool, ok := process.(*blobStoragePoolStore); ok {
		processPool.mu.RLock()
		processConfigs := append([]blobStorageProviderConfig(nil), processPool.router.ordered...)
		processPool.mu.RUnlock()
		for _, config := range processConfigs {
			if tenantSelectable {
				config.Health, config.Weight = blobStorageProviderUnhealthy, 0
			}
			configs = append(configs, config)
			fingerprintParts = append(fingerprintParts, strings.Join([]string{"process", config.ID, config.Destination, string(config.Health), strconv.FormatUint(uint64(config.Weight), 10)}, "\x1e"))
		}
	} else if process != nil {
		health, weight := blobStorageProviderHealthy, uint32(1)
		if tenantSelectable {
			health, weight = blobStorageProviderUnhealthy, 0
		}
		configs = append(configs, blobStorageProviderConfig{ID: "process-fallback", Destination: "process:" + process.Kind(), Weight: weight, Health: health, Store: process})
		fingerprintParts = append(fingerprintParts, "process-fallback\x1e"+process.Kind()+"\x1e"+string(health))
	}
	if len(configs) == 0 {
		return nil, nil
	}
	sort.Strings(fingerprintParts)
	fingerprint := "pool\x00" + strings.Join(fingerprintParts, "\x1f")
	if cached := s.lookupTenantBlobStore(tenantID, fingerprint); cached != nil {
		return cached, nil
	}
	pool, err := newBlobStoragePoolStore(configs, newTenantStateBlobPlacementStore(s.store))
	if err != nil {
		return nil, err
	}
	s.cacheTenantBlobStore(tenantID, fingerprint, pool)
	return pool, nil
}
