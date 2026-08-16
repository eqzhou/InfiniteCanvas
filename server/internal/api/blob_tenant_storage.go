package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxObjectStorageField   = 8 * 1024
	maxObjectStorageSecret  = 64 * 1024
	tenantBlobStoreCacheTTL = 30 * time.Second
)

var (
	objectStorageBucketPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	objectStoragePrefixSegment   = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	errTenantObjectStorageRebind = errors.New("tenant object storage destination cannot be rebound")
)

func tenantObjectStorageBinding(raw []byte) (string, bool, error) {
	var config storedAppConfigObjectStorage
	if json.Unmarshal(raw, &config) != nil {
		return "", false, store.ErrInvalidInput
	}
	if config.ObjectStorage == nil || !config.ObjectStorage.Enabled {
		return "", false, nil
	}
	storageConfig, err := objectStorageConfigFromTenant(*config.ObjectStorage, storedConfigSecrets{
		ObjectStorageAccessKeyID:     "binding-check",
		ObjectStorageSecretAccessKey: "binding-check",
	})
	if err != nil {
		return "", false, err
	}
	objects, err := newS3BlobObjectStore(storageConfig)
	if err != nil {
		return "", false, err
	}
	return s3BlobStorageDestination(objects), true, nil
}

func (s *Server) preventTenantObjectStorageRebind(ctx context.Context, tenantID string, next []byte) error {
	current, err := s.store.GetState(ctx, tenantID, "config")
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	currentBinding, currentEnabled, currentErr := tenantObjectStorageBinding(current)
	if currentErr != nil || !currentEnabled {
		return nil
	}
	nextBinding, nextEnabled, nextErr := tenantObjectStorageBinding(next)
	if nextErr != nil {
		return nextErr
	}
	if !nextEnabled || nextBinding != currentBinding {
		return errTenantObjectStorageRebind
	}
	return nil
}

// storedObjectStorageConfig is the non-secret object-storage preference that
// clients persist under state/config. Credentials live only in encrypted secrets.
type storedObjectStorageConfig struct {
	Enabled               bool   `json:"enabled"`
	Endpoint              string `json:"endpoint"`
	Bucket                string `json:"bucket"`
	Region                string `json:"region"`
	Prefix                string `json:"prefix"`
	AllowInsecureLoopback bool   `json:"allowInsecureLoopback"`
}

type storedAppConfigObjectStorage struct {
	ObjectStorage *storedObjectStorageConfig `json:"objectStorage"`
}

type tenantBlobStoreCacheEntry struct {
	store       blobObjectStore
	fingerprint string
	expiresAt   time.Time
}

// resolveBlobObjectStore chooses the protected media backend for a tenant.
// Precedence matches the public Tiger behavior: a valid, enabled user S3/R2
// preference wins; otherwise the tenant owner's weighted pool is used;
// otherwise the process-level OPENBOARD_S3_* backend or shared filesystem is used.
func (s *Server) resolveBlobObjectStore(ctx context.Context, tenantID string) (blobObjectStore, error) {
	if s.store != nil && s.secrets != nil {
		userStore, err := s.tenantObjectStorage(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		if userStore != nil {
			return userStore, nil
		}
		tenantPool, err := s.tenantStoragePool(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		if tenantPool != nil {
			return tenantPool, nil
		}
	}
	s.tenantBlobStoreMu.Lock()
	objects := s.blobObjects
	s.tenantBlobStoreMu.Unlock()
	return objects, nil
}

func (s *Server) tenantObjectStorage(ctx context.Context, tenantID string) (blobObjectStore, error) {
	if tenantID == "" || s.store == nil || s.secrets == nil {
		return nil, nil
	}
	configValue, err := s.store.GetState(ctx, tenantID, "config")
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(configValue) > 1<<20 {
		return nil, errors.New("object storage configuration exceeds limits")
	}
	var config storedAppConfigObjectStorage
	if json.Unmarshal(configValue, &config) != nil {
		return nil, errors.New("invalid object storage configuration")
	}
	if config.ObjectStorage == nil || !config.ObjectStorage.Enabled {
		return nil, nil
	}
	secretValue, err := s.decryptSecrets(ctx, tenantID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, errors.New("object storage credentials are missing")
		}
		return nil, err
	}
	if len(secretValue) > 1<<20 {
		return nil, errors.New("object storage credentials exceed limits")
	}
	var secrets storedConfigSecrets
	if json.Unmarshal(secretValue, &secrets) != nil {
		return nil, errors.New("invalid object storage credentials")
	}
	storageConfig, err := objectStorageConfigFromTenant(*config.ObjectStorage, secrets)
	if err != nil {
		return nil, err
	}
	fingerprint := objectStorageFingerprint(storageConfig)
	if cached := s.lookupTenantBlobStore(tenantID, fingerprint); cached != nil {
		return cached, nil
	}
	objects, err := newS3BlobObjectStore(storageConfig)
	if err != nil {
		s.InvalidateTenantBlobStore(tenantID)
		return nil, err
	}
	s.cacheTenantBlobStore(tenantID, fingerprint, objects)
	return objects, nil
}

func objectStorageConfigFromTenant(config storedObjectStorageConfig, secrets storedConfigSecrets) (S3BlobStorageConfig, error) {
	endpoint := strings.TrimSpace(config.Endpoint)
	bucket := strings.ToLower(strings.TrimSpace(config.Bucket))
	region := strings.TrimSpace(config.Region)
	if region == "" {
		region = "auto"
	}
	prefix := strings.Trim(strings.TrimSpace(config.Prefix), "/")
	if prefix == "" {
		prefix = "openboard"
	}
	accessKeyID := strings.TrimSpace(secrets.ObjectStorageAccessKeyID)
	secretAccessKey := secrets.ObjectStorageSecretAccessKey
	sessionToken := secrets.ObjectStorageSessionToken
	if len(endpoint) > maxObjectStorageField || len(bucket) > 63 || len(region) > 64 ||
		len(prefix) > 256 || len(accessKeyID) > 256 || len(secretAccessKey) > maxObjectStorageSecret ||
		len(sessionToken) > maxObjectStorageSecret {
		return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
	}
	if endpoint == "" || accessKeyID == "" || strings.TrimSpace(secretAccessKey) == "" {
		return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
	}
	if parsed.Scheme == "http" {
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if !config.AllowInsecureLoopback || !(strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())) {
			return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
		}
	}
	if !objectStorageBucketPattern.MatchString(bucket) || strings.Contains(bucket, "..") {
		return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
	}
	for _, segment := range strings.Split(prefix, "/") {
		if segment == "" || segment == "." || segment == ".." || !objectStoragePrefixSegment.MatchString(segment) {
			return S3BlobStorageConfig{}, errInvalidBlobObjectConfig
		}
	}
	return S3BlobStorageConfig{
		Endpoint:              endpoint,
		Bucket:                bucket,
		Region:                region,
		Prefix:                prefix,
		AccessKeyID:           accessKeyID,
		SecretAccessKey:       secretAccessKey,
		SessionToken:          sessionToken,
		AllowInsecureLoopback: config.AllowInsecureLoopback,
	}, nil
}

func objectStorageFingerprint(config S3BlobStorageConfig) string {
	return strings.Join([]string{
		config.Endpoint,
		config.Bucket,
		config.Region,
		config.Prefix,
		config.AccessKeyID,
		config.SecretAccessKey,
		config.SessionToken,
		boolString(config.AllowInsecureLoopback),
	}, string([]byte{0x1f}))
}

func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func (s *Server) lookupTenantBlobStore(tenantID, fingerprint string) blobObjectStore {
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	if s.tenantBlobStores == nil {
		return nil
	}
	entry, ok := s.tenantBlobStores[tenantID]
	if !ok || entry.fingerprint != fingerprint || time.Now().After(entry.expiresAt) {
		return nil
	}
	return entry.store
}

func (s *Server) cacheTenantBlobStore(tenantID, fingerprint string, objects blobObjectStore) {
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	if s.tenantBlobStores == nil {
		s.tenantBlobStores = make(map[string]tenantBlobStoreCacheEntry)
	}
	if objects == nil {
		delete(s.tenantBlobStores, tenantID)
		return
	}
	s.tenantBlobStores[tenantID] = tenantBlobStoreCacheEntry{
		store:       objects,
		fingerprint: fingerprint,
		expiresAt:   time.Now().Add(tenantBlobStoreCacheTTL),
	}
}

// InvalidateTenantBlobStore drops a cached user object-storage client so the
// next media operation reloads preferences and credentials.
func (s *Server) InvalidateTenantBlobStore(tenantID string) {
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	delete(s.tenantBlobStores, tenantID)
}
