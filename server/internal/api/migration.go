package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxMigrationResources    = 100
	maxMigrationVersionBytes = int64(256 << 20)
)

type migrationResourceRequest struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type migrationResourceVersion struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Exists  bool   `json:"exists"`
	Version string `json:"version,omitempty"`
}

// migrationCapabilities is the server's authoritative statement about what the
// caller may migrate. The client must not derive secret migration rights from
// its own role copy; write endpoints enforce the same rule independently.
type migrationCapabilities struct {
	AllowSecrets bool `json:"allowSecrets"`
}

func (s *Server) migrationCapabilities(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	writeJSON(w, migrationCapabilities{AllowSecrets: s.migrationSecretsAllowed(r)})
}

func (s *Server) migrationSecretsAllowed(r *http.Request) bool {
	if s.store == nil || s.secrets == nil {
		return false
	}
	if authMode() == "off" {
		return s.processToken != "" && s.authorizeProcessToken(r)
	}
	user, ok := authUserFrom(r.Context())
	return ok && isTenantAdmin(user)
}

func migrationVersion(value []byte) string {
	sum := sha256.Sum256(value)
	return "m1-" + hex.EncodeToString(sum[:])
}

func migrationBlobVersion(contentType string, value []byte) string {
	return migrationVersion(append(append([]byte(contentType), 0), value...))
}

func setMigrationETag(w http.ResponseWriter, version string) {
	w.Header().Set("ETag", `"`+version+`"`)
}

func migrationExpectedVersion(w http.ResponseWriter, r *http.Request) (string, bool, bool) {
	if strings.TrimSpace(r.Header.Get("If-None-Match")) == "*" {
		return "", true, true
	}
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	if len(value) >= 3 && value[0] == '"' && value[len(value)-1] == '"' {
		value = value[1 : len(value)-1]
		if strings.HasPrefix(value, "m1-") && len(value) == 67 {
			return value, false, true
		}
	}
	http.Error(w, "migration precondition required", http.StatusPreconditionRequired)
	return "", false, false
}

func (s *Server) migrationVersions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	if s.store == nil {
		http.Error(w, "migration requires server storage", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct {
		Resources []migrationResourceRequest `json:"resources"`
	}
	if decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil || len(body.Resources) > maxMigrationResources {
		http.Error(w, "invalid migration resources", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	result := make([]migrationResourceVersion, 0, len(body.Resources))
	seen := make(map[string]struct{}, len(body.Resources))
	remainingBytes := maxMigrationVersionBytes
	for _, resource := range body.Resources {
		identity := resource.Kind + "\x00" + resource.ID
		if _, duplicate := seen[identity]; duplicate {
			http.Error(w, "duplicate migration resource", http.StatusBadRequest)
			return
		}
		seen[identity] = struct{}{}
		item := migrationResourceVersion{Kind: resource.Kind, ID: resource.ID}
		var value []byte
		var err error
		switch resource.Kind {
		case "project":
			if !validProjectID(resource.ID) {
				http.Error(w, "invalid migration resource", http.StatusBadRequest)
				return
			}
			value, err = s.store.GetProject(r.Context(), tenantID, resource.ID)
		case "state":
			if _, ok := stateKeys[resource.ID]; !ok {
				http.Error(w, "invalid migration resource", http.StatusBadRequest)
				return
			}
			storageKey, _ := requestStateStorageKey(r, resource.ID)
			value, err = s.store.GetState(r.Context(), tenantID, storageKey)
		case "secret":
			if resource.ID != "config" {
				http.Error(w, "invalid migration resource", http.StatusBadRequest)
				return
			}
			if !s.authorizeSecrets(w, r) {
				return
			}
			value, err = s.decryptSecrets(r.Context(), tenantID)
		case "blob":
			if _, ok := blobFilename(resource.ID); !ok {
				http.Error(w, "invalid migration resource", http.StatusBadRequest)
				return
			}
			blob, blobErr := s.readTenantBlob(r.Context(), tenantID, resource.ID, remainingBytes)
			err = blobErr
			if blobErr == nil {
				remainingBytes -= int64(len(blob.Data))
				item.Exists = true
				item.Version = migrationBlobVersion(blob.Metadata.ContentType, blob.Data)
				result = append(result, item)
				continue
			}
		case "generation-history":
			if resource.ID != "all" {
				http.Error(w, "invalid migration resource", http.StatusBadRequest)
				return
			} else {
				jobs, listErr := s.allGenerationJobs(r.Context(), tenantID)
				err = listErr
				if listErr == nil {
					item.Exists = len(jobs) > 0
					if item.Exists {
						item.Version = store.GenerationJobsVersion(jobs)
					}
					result = append(result, item)
					continue
				}
			}
		default:
			http.Error(w, "invalid migration resource", http.StatusBadRequest)
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			result = append(result, item)
			continue
		}
		if err != nil {
			if errors.Is(err, errBlobObjectTooLarge) {
				http.Error(w, "migration version payload too large", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "failed to read migration resource", http.StatusInternalServerError)
			}
			return
		}
		item.Exists = true
		item.Version = migrationVersion(value)
		result = append(result, item)
	}
	writeJSON(w, map[string]any{"resources": result})
}

func (s *Server) migrationPutProject(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	expectedVersion, absent, ok := migrationExpectedVersion(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if !validProjectID(id) || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxProjectBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid project", http.StatusBadRequest)
		return
	}
	var project map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	if decoder.Decode(&project) != nil || ensureJSONEOF(decoder) != nil || project["id"] != id || validateProjectDocument(project) != nil {
		http.Error(w, "invalid project", http.StatusBadRequest)
		return
	}
	var expected []byte
	if !absent {
		expected, err = s.store.GetProject(r.Context(), tenantIDFrom(r), id)
		if err != nil || migrationVersion(expected) != expectedVersion {
			http.Error(w, "migration precondition failed", http.StatusPreconditionFailed)
			return
		}
	}
	if err := s.store.CompareAndSwapProject(r.Context(), tenantIDFrom(r), id, expected, body); errors.Is(err, store.ErrConflict) {
		http.Error(w, "migration precondition failed", http.StatusPreconditionFailed)
		return
	} else if err != nil {
		http.Error(w, "failed to store project", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) migrationPutState(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	expectedVersion, absent, ok := migrationExpectedVersion(w, r)
	if !ok {
		return
	}
	key := chi.URLParam(r, "key")
	if _, allowed := stateKeys[key]; !allowed || s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	storageKey, tenantWide := requestStateStorageKey(r, key)
	if key == "config" && tenantWide && !s.requireTenantAdmin(w, r, "state unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxStateBytes)
	value, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(value) {
		http.Error(w, "invalid state json", 400)
		return
	}
	if key == "config" && tenantWide {
		if err := s.preventTenantObjectStorageRebind(r.Context(), tenantIDFrom(r), value); errors.Is(err, errTenantObjectStorageRebind) {
			http.Error(w, "object storage destination requires an explicit migration", http.StatusConflict)
			return
		} else if err != nil {
			http.Error(w, "invalid object storage configuration", http.StatusBadRequest)
			return
		}
	}
	var expected []byte
	if !absent {
		expected, err = s.store.GetState(r.Context(), tenantIDFrom(r), storageKey)
		if err != nil || migrationVersion(expected) != expectedVersion {
			http.Error(w, "migration precondition failed", 412)
			return
		}
	}
	if err := s.store.CompareAndSwapState(r.Context(), tenantIDFrom(r), storageKey, expected, value); errors.Is(err, store.ErrConflict) {
		http.Error(w, "migration precondition failed", 412)
		return
	} else if err != nil {
		http.Error(w, "failed to store state", 500)
		return
	}
	if key == "config" && tenantWide {
		s.InvalidateTenantBlobStore(tenantIDFrom(r))
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) migrationPutSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) || !s.authorizeSecrets(w, r) || s.store == nil || s.secrets == nil {
		return
	}
	expectedVersion, absent, ok := migrationExpectedVersion(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	plain, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(plain) {
		http.Error(w, "invalid secrets json", 400)
		return
	}
	var expectedEnvelope []byte
	if !absent {
		expectedEnvelope, err = s.store.GetState(r.Context(), tenantIDFrom(r), secretStateKey)
		if err != nil {
			http.Error(w, "migration precondition failed", 412)
			return
		}
		current, readErr := s.decryptSecretEnvelope(expectedEnvelope)
		if readErr != nil || migrationVersion(current) != expectedVersion {
			http.Error(w, "migration precondition failed", 412)
			return
		}
	}
	nonce := make([]byte, s.secrets.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		http.Error(w, "failed to encrypt secrets", 500)
		return
	}
	envelope, _ := json.Marshal(secretEnvelope{Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, plain, nil))})
	if err := s.store.CompareAndSwapState(r.Context(), tenantIDFrom(r), secretStateKey, expectedEnvelope, envelope); errors.Is(err, store.ErrConflict) {
		http.Error(w, "migration precondition failed", 412)
		return
	} else if err != nil {
		http.Error(w, "failed to store secrets", 500)
		return
	}
	s.InvalidateTenantBlobStore(tenantIDFrom(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) allGenerationJobs(ctx context.Context, tenantID string) ([]store.GenerationJob, error) {
	jobs := make([]store.GenerationJob, 0)
	for page := 1; ; page++ {
		result, err := s.store.ListGenerationJobs(ctx, tenantID, store.GenerationJobQuery{Page: page, PageSize: 100, IncludeDeleted: true})
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, result.Items...)
		if len(jobs) >= result.Total {
			return jobs, nil
		}
		if len(jobs) > maxGenerationRestoreItems {
			return nil, errors.New("generation history too large")
		}
	}
}

func (s *Server) migrationPutGenerationHistory(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	expectedVersion, absent, ok := migrationExpectedVersion(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationRestoreBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var jobs []store.GenerationJob
	if decoder.Decode(&jobs) != nil || ensureJSONEOF(decoder) != nil || jobs == nil || len(jobs) > maxGenerationRestoreItems {
		http.Error(w, "invalid generation history", 400)
		return
	}
	ids := make(map[string]struct{}, len(jobs))
	for _, job := range jobs {
		if !validGenerationJob(job) {
			http.Error(w, "invalid generation history", 400)
			return
		}
		if isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
			http.Error(w, "active server generation jobs cannot be migrated", http.StatusBadRequest)
			return
		}
		if _, duplicate := ids[job.ID]; duplicate {
			http.Error(w, "duplicate generation history id", http.StatusBadRequest)
			return
		}
		ids[job.ID] = struct{}{}
	}
	current, err := s.allGenerationJobs(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to read generation history", 500)
		return
	}
	currentVersion := store.GenerationJobsVersion(current)
	if (absent && len(current) > 0) || (!absent && currentVersion != expectedVersion) {
		http.Error(w, "migration precondition failed", 412)
		return
	}
	if err := s.store.CompareAndSwapGenerationJobs(r.Context(), tenantIDFrom(r), currentVersion, jobs); errors.Is(err, store.ErrConflict) {
		http.Error(w, "migration precondition failed", 412)
		return
	} else if err != nil {
		http.Error(w, "failed to replace generation history", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) migrationPutBlob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigration(w, r) {
		return
	}
	expectedVersion, absent, ok := migrationExpectedVersion(w, r)
	if !ok {
		return
	}
	key, valid := migrationBlobKeyFromRequest(r)
	if !valid {
		http.Error(w, "invalid blob key", 400)
		return
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !allowedBlobMediaType(contentType) {
		http.Error(w, "unsupported blob content type", 415)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid blob", 400)
		return
	}
	expected := expectedVersion
	if absent {
		expected = blobVersionAbsent
	}
	if err := s.storeTenantBlobConditional(r.Context(), tenantIDFrom(r), userIDFrom(r), key, contentType, data, expected); errors.Is(err, errBlobObjectConflict) {
		http.Error(w, "migration precondition failed", 412)
		return
	} else if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "blob storage quota exceeded", http.StatusInsufficientStorage)
		return
	} else if err != nil {
		http.Error(w, "failed to store blob", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func migrationBlobKeyFromRequest(r *http.Request) (string, bool) {
	path := r.URL.EscapedPath()
	marker := "/api/migration/blobs/"
	index := strings.Index(path, marker)
	if index < 0 {
		return "", false
	}
	escaped := path[index+len(marker):]
	if escaped == "" || strings.Contains(escaped, "/") {
		return "", false
	}
	key, err := url.PathUnescape(escaped)
	if err != nil {
		return "", false
	}
	if _, ok := blobFilename(key); !ok {
		return "", false
	}
	return key, true
}
