package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

var errCustomChannelsDisabled = errors.New("custom channels disabled by tenant policy")

func validateAccountManagedChannelURL(rawURL string) error {
	parsed, err := validateGenerationURL(rawURL)
	if err != nil {
		return err
	}
	if authMode() != "off" && (parsed.Scheme != "https" || isExplicitLoopbackHost(parsed.Hostname())) {
		return errors.New("account-managed provider URL must use public HTTPS")
	}
	return nil
}

func validatePersonalChannelDestinations(document []byte) error {
	if authMode() == "off" {
		return nil
	}
	var config storedImageConfig
	if json.Unmarshal(document, &config) != nil || len(config.Channels) > 100 {
		return errors.New("invalid personal channel configuration")
	}
	for _, channel := range config.Channels {
		if baseURL := strings.TrimSpace(channel.BaseURL); baseURL != "" {
			if err := validateAccountManagedChannelURL(baseURL); err != nil {
				return err
			}
		}
		for _, provider := range channel.Providers {
			if baseURL := strings.TrimSpace(provider.BaseURL); baseURL != "" {
				if err := validateAccountManagedChannelURL(baseURL); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func canonicalJSONObjectField(document []byte, field string, missing []byte) ([]byte, error) {
	var object map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("invalid json object")
	}
	raw, ok := object[field]
	if !ok {
		return bytes.Clone(missing), nil
	}
	var value any
	valueDecoder := json.NewDecoder(bytes.NewReader(raw))
	valueDecoder.UseNumber()
	if err := valueDecoder.Decode(&value); err != nil || valueDecoder.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("invalid json field")
	}
	return json.Marshal(value)
}

func sameJSONObjectField(first, second []byte, field string) (bool, error) {
	return sameJSONObjectFieldWithMissing(first, second, field, []byte("null"))
}

func sameJSONObjectFieldWithMissing(first, second []byte, field string, missing []byte) (bool, error) {
	firstValue, err := canonicalJSONObjectField(first, field, missing)
	if err != nil {
		return false, err
	}
	secondValue, err := canonicalJSONObjectField(second, field, missing)
	if err != nil {
		return false, err
	}
	return bytes.Equal(firstValue, secondValue), nil
}

func (s *Server) memberCustomChannelsLocked(ctx context.Context, r *http.Request) (bool, error) {
	user, ok := authUserFrom(r.Context())
	if !ok || isTenantOwner(user) {
		return false, nil
	}
	policy, err := s.loadTenantPolicy(ctx, tenantIDFrom(r))
	if err != nil {
		return false, err
	}
	return !policy.AllowCustomChannel, nil
}

// enforceMemberCustomChannelPolicy prevents an ordinary user from changing
// personal channel definitions or API keys while the tenant policy disables
// custom channels. Other preferences and unrelated secret fields remain
// writable. Owner and auth-off process-token flows intentionally bypass it.
func (s *Server) enforceMemberCustomChannelPolicy(
	ctx context.Context,
	r *http.Request,
	currentConfig, nextConfig, currentSecretsEnvelope, nextSecrets []byte,
) error {
	locked, err := s.memberCustomChannelsLocked(ctx, r)
	if err != nil || !locked {
		return err
	}
	if len(currentConfig) == 0 {
		currentConfig = []byte(`{}`)
	}
	channelsUnchanged, err := sameJSONObjectField(currentConfig, nextConfig, "channels")
	if err != nil {
		return err
	}
	if !channelsUnchanged {
		return errCustomChannelsDisabled
	}
	if nextSecrets == nil {
		return nil
	}
	currentSecrets := []byte(`{}`)
	if len(currentSecretsEnvelope) > 0 {
		currentSecrets, err = s.decryptSecretEnvelope(currentSecretsEnvelope)
		if err != nil {
			return err
		}
	}
	keysUnchanged, err := sameJSONObjectFieldWithMissing(
		currentSecrets, nextSecrets, "apiKeys", []byte(`{}`),
	)
	if err != nil {
		return err
	}
	if !keysUnchanged {
		return errCustomChannelsDisabled
	}
	return nil
}

func writeCustomChannelPolicyError(w http.ResponseWriter, err error) {
	if errors.Is(err, errCustomChannelsDisabled) {
		http.Error(w, errCustomChannelsDisabled.Error(), http.StatusForbidden)
		return
	}
	http.Error(w, "failed to enforce site policy", http.StatusInternalServerError)
}

func (s *Server) authorizePersonalChannelRuntime(w http.ResponseWriter, r *http.Request) bool {
	locked, err := s.memberCustomChannelsLocked(r.Context(), r)
	if err != nil {
		http.Error(w, "failed to enforce tenant channel policy", http.StatusInternalServerError)
		return false
	}
	if locked {
		http.Error(w, errCustomChannelsDisabled.Error(), http.StatusForbidden)
		return false
	}
	return true
}
