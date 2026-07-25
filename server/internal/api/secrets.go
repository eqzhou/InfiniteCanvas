package api

import (
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

	"github.com/openboard/openboard/server/internal/store"
)

const secretStateKey = "__encrypted_config_secrets"

type secretEnvelope struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	plain, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(plain) {
		http.Error(w, "invalid secrets json", http.StatusBadRequest)
		return
	}
	nonce := make([]byte, s.secrets.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		http.Error(w, "failed to encrypt secrets", 500)
		return
	}
	envelope, _ := json.Marshal(secretEnvelope{
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(s.secrets.Seal(nil, nonce, plain, nil)),
	})
	tenantID := tenantIDFrom(r)
	if err := s.store.PutState(r.Context(), tenantID, secretStateKey, envelope); err != nil {
		http.Error(w, "failed to store secrets", 500)
		return
	}
	s.InvalidateTenantBlobStore(tenantID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	if s.store == nil || s.secrets == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	plain, err := s.decryptSecrets(r.Context(), tenantIDFrom(r))
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

func (s *Server) decryptSecrets(ctx context.Context, tenantID string) ([]byte, error) {
	if s.store == nil || s.secrets == nil {
		return nil, store.ErrNotFound
	}
	value, err := s.store.GetState(ctx, tenantID, secretStateKey)
	if err != nil {
		return nil, err
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
