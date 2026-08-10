package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/openboard/openboard/server/internal/store"
)

const maxConfigBundleBytes = maxStateBytes + (1 << 20)

func configStateVersion(config, encryptedSecrets []byte) string {
	canonical := func(value []byte) []byte {
		if value == nil {
			return nil
		}
		var decoded any
		decoder := json.NewDecoder(bytes.NewReader(value))
		decoder.UseNumber()
		if decoder.Decode(&decoded) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			return value
		}
		encoded, err := json.Marshal(decoded)
		if err != nil {
			return value
		}
		return encoded
	}
	config = canonical(config)
	encryptedSecrets = canonical(encryptedSecrets)
	value := make([]byte, 0, len(config)+len(encryptedSecrets)+1)
	value = append(value, config...)
	value = append(value, 0)
	value = append(value, encryptedSecrets...)
	return contentVersion(value)
}

func (s *Server) currentConfigBundle(
	r *http.Request,
) (tenantID, configKey, secretsKey string, tenantWide bool, config, configExpected, secrets []byte, err error) {
	tenantID = tenantIDFrom(r)
	configKey, tenantWide = requestStateStorageKey(r, "config")
	secretsKey, _ = secretStorageKey(r)
	keys := []string{configKey, secretsKey}
	if !tenantWide {
		keys = append(keys, "config")
	}
	values, readErr := s.store.GetStates(r.Context(), tenantID, keys)
	if readErr != nil {
		err = readErr
		return
	}
	config = values[configKey]
	if config != nil {
		configExpected = bytes.Clone(config)
	} else if !tenantWide {
		config = values["config"]
	}
	secrets = values[secretsKey]
	return
}

func (s *Server) getConfigBundle(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) {
		return
	}
	if s.store == nil || s.secrets == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	_, _, secretsKey, _, config, _, encryptedSecrets, err := s.currentConfigBundle(r)
	if err != nil {
		http.Error(w, "failed to read config bundle", http.StatusInternalServerError)
		return
	}
	if config == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	secrets := []byte(`{"apiKeys":{},"webdavPass":""}`)
	if encryptedSecrets != nil {
		secrets, err = s.decryptSecretsKey(r.Context(), tenantIDFrom(r), secretsKey)
		if err != nil {
			http.Error(w, "failed to read config secrets", http.StatusInternalServerError)
			return
		}
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"config": config, "secrets": secrets})
	if err != nil {
		http.Error(w, "failed to encode config bundle", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	setContentETag(w, configStateVersion(config, encryptedSecrets))
	_, _ = w.Write(payload)
}

func (s *Server) putConfigBundle(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSecrets(w, r) || s.store == nil || s.secrets == nil {
		return
	}
	expectedVersion, createOnly, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxConfigBundleBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct {
		Config  json.RawMessage `json:"config"`
		Secrets json.RawMessage `json:"secrets"`
	}
	if decoder.Decode(&body) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!json.Valid(body.Config) || !json.Valid(body.Secrets) {
		http.Error(w, "invalid config bundle", http.StatusBadRequest)
		return
	}
	tenantID, configKey, secretsKey, tenantWide, currentConfig, configExpected, currentSecrets, err :=
		s.currentConfigBundle(r)
	if err != nil {
		http.Error(w, "failed to read config bundle", http.StatusInternalServerError)
		return
	}
	if tenantWide && !s.requireTenantAdmin(w, r, "state unavailable") {
		return
	}
	if createOnly {
		if currentConfig != nil {
			http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
			return
		}
	} else if currentConfig == nil || configStateVersion(currentConfig, currentSecrets) != expectedVersion {
		http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		return
	}
	if !tenantWide {
		if err := s.enforceMemberCustomChannelPolicy(
			r.Context(), r, currentConfig, body.Config, currentSecrets, body.Secrets,
		); err != nil {
			writeCustomChannelPolicyError(w, err)
			return
		}
	}
	if tenantWide {
		if err := s.preventTenantObjectStorageRebind(r.Context(), tenantID, body.Config); err != nil {
			http.Error(w, "invalid object storage configuration", http.StatusConflict)
			return
		}
	}
	envelope, err := s.encryptSecrets(body.Secrets)
	if err != nil {
		http.Error(w, "failed to encrypt secrets", http.StatusInternalServerError)
		return
	}
	mutations := []store.StateMutation{
		{Key: configKey, Expected: configExpected, Value: bytes.Clone(body.Config)},
		{Key: secretsKey, Expected: bytes.Clone(currentSecrets), Value: envelope},
	}
	if err := s.store.CompareAndSwapStates(r.Context(), tenantID, mutations); err != nil {
		if errors.Is(err, store.ErrConflict) {
			http.Error(w, "config precondition failed", http.StatusPreconditionFailed)
		} else {
			http.Error(w, "failed to store config bundle", http.StatusInternalServerError)
		}
		return
	}
	if tenantWide {
		s.InvalidateTenantBlobStore(tenantID)
	}
	setContentETag(w, configStateVersion(body.Config, envelope))
	w.WriteHeader(http.StatusNoContent)
}
