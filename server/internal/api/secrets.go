package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	// secretStateKey is the legacy/local tenant-wide encrypted bag used by
	// server-side generation/object-storage and auth-off deployments.
	secretStateKey = "__encrypted_config_secrets"
	// userSecretStateKeyPrefix scopes each user's direct-connect keys and
	// personal object-storage credentials so they can sync across devices
	// without reading or overwriting the tenant bag.
	userSecretStateKeyPrefix = "__encrypted_user_config_secrets_v1:"
)

type secretEnvelope struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// secretStorageKey returns the encrypted-bag key for this request.
// Every authenticated account, including a tenant Owner or platform admin,
// receives a private bag. Only auth-off/bootstrap paths use the tenant bag.
func secretStorageKey(r *http.Request) (key string, tenantWide bool) {
	if user, ok := authUserFrom(r.Context()); ok && authMode() != "off" {
		id := strings.TrimSpace(user.ID)
		if id != "" && len(id) <= 128 {
			return userSecretStateKeyPrefix + id, false
		}
	}
	return secretStateKey, true
}

func (s *Server) SetSecretKey(encoded string) error {
	key, err := hex.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return errors.New("OPENBOARD_MASTER_KEY must be exactly 64 hexadecimal characters")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	s.secrets, err = cipher.NewGCM(block)
	if err == nil && s.store != nil && (authMode() != "off" || s.processToken != "") {
		s.startGenerationWorkers(2)
		s.startWorkflowWorkers(1)
		s.startVideoWorkers(1)
		s.startAudioWorkers(2)
	}
	return err
}

func (s *Server) putSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	if s.store == nil || s.secrets == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	expectedVersion, createOnly, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	if createOnly {
		http.Error(w, "secrets require an existing config version", http.StatusPreconditionFailed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	plain, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(plain) {
		http.Error(w, "invalid secrets json", http.StatusBadRequest)
		return
	}
	envelope, err := s.encryptSecrets(plain)
	if err != nil {
		http.Error(w, "failed to encrypt secrets", 500)
		return
	}
	tenantID := tenantIDFrom(r)
	storageKey, tenantWide := secretStorageKey(r)
	_, configKey, _, _, config, configExpected, currentSecrets, err := s.currentConfigBundle(r)
	if err != nil {
		http.Error(w, "failed to read config bundle", http.StatusInternalServerError)
		return
	}
	if config == nil || configStateVersion(config, currentSecrets) != expectedVersion {
		http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		return
	}
	if !tenantWide {
		if err := s.enforceMemberCustomChannelPolicy(
			r.Context(), r, config, config, currentSecrets, plain,
		); err != nil {
			writeCustomChannelPolicyError(w, err)
			return
		}
	}
	mutations := []store.StateMutation{
		{Key: configKey, Expected: configExpected, Value: bytes.Clone(config)},
		{Key: storageKey, Expected: bytes.Clone(currentSecrets), Value: envelope},
	}
	if err := s.store.CompareAndSwapStates(r.Context(), tenantID, mutations); err != nil {
		if errors.Is(err, store.ErrConflict) {
			http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		} else {
			http.Error(w, "failed to store secrets", http.StatusInternalServerError)
		}
		return
	}
	// Only tenant-wide credentials affect the shared object-storage client.
	if tenantWide {
		s.InvalidateTenantBlobStore(tenantID)
	}
	setContentETag(w, configStateVersion(config, envelope))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) encryptSecrets(plain []byte) ([]byte, error) {
	nonce := make([]byte, s.secrets.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return json.Marshal(secretEnvelope{
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, plain, nil)),
	})
}

func (s *Server) getSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	if s.store == nil || s.secrets == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	storageKey, _ := secretStorageKey(r)
	plain, err := s.decryptSecretsKey(r.Context(), tenantIDFrom(r), storageKey)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read secrets", 500)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(plain)
}

// decryptSecrets reads the tenant-wide encrypted bag used by server-side
// generation and tenant object storage.
func (s *Server) decryptSecrets(ctx context.Context, tenantID string) ([]byte, error) {
	return s.decryptSecretsKey(ctx, tenantID, secretStateKey)
}

func (s *Server) decryptSecretsKey(ctx context.Context, tenantID, key string) ([]byte, error) {
	if s.store == nil || s.secrets == nil {
		return nil, store.ErrNotFound
	}
	value, err := s.store.GetState(ctx, tenantID, key)
	if err != nil {
		return nil, err
	}
	return s.decryptSecretEnvelope(value)
}

func (s *Server) decryptSecretEnvelope(value []byte) ([]byte, error) {
	if s.secrets == nil {
		return nil, store.ErrNotFound
	}
	var envelope secretEnvelope
	if json.Unmarshal(value, &envelope) != nil {
		return nil, errors.New("invalid encrypted secrets")
	}
	nonce, nonceErr := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	ciphertext, cipherErr := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if nonceErr != nil || cipherErr != nil || len(nonce) != s.secrets.NonceSize() {
		return nil, errors.New("invalid encrypted secrets")
	}
	plain, err := s.secrets.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("failed to decrypt secrets")
	}
	return plain, nil
}
