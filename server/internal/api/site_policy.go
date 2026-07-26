package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

const sitePolicyStateKey = "sitePolicy"

// SitePolicy is the tenant admin-controlled policy surface from Tiger public docs:
// registration, custom model channels, and cloud-channel generation.
type SitePolicy struct {
	AllowRegister      bool `json:"allowRegister"`
	AllowCustomChannel bool `json:"allowCustomChannel"`
	AllowCloudChannel  bool `json:"allowCloudChannel"`
	LinuxDoEnabled     bool `json:"linuxDoEnabled"`
}

func defaultSitePolicy() SitePolicy {
	return SitePolicy{
		AllowRegister:      true,
		AllowCustomChannel: true,
		AllowCloudChannel:  true,
	}
}

func normalizeSitePolicy(policy SitePolicy) SitePolicy {
	// linuxDoEnabled is derived from process env and is not persisted.
	policy.LinuxDoEnabled = false
	return policy
}

func (s *Server) loadSitePolicy(ctx context.Context, tenantID string) (SitePolicy, error) {
	policy := defaultSitePolicy()
	if s == nil || s.store == nil {
		return policy, nil
	}
	raw, err := s.store.GetState(ctx, tenantID, sitePolicyStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return policy, nil
	}
	if err != nil {
		return policy, err
	}
	if len(raw) == 0 {
		return policy, nil
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return defaultSitePolicy(), err
	}
	return normalizeSitePolicy(policy), nil
}

func (s *Server) saveSitePolicy(ctx context.Context, tenantID string, policy SitePolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	policy = normalizeSitePolicy(policy)
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return s.store.PutState(ctx, tenantID, sitePolicyStateKey, raw)
}

func (s *Server) requireSitePolicyAdmin(w http.ResponseWriter, r *http.Request) bool {
	return s.requireTenantAdmin(w, r, "site policy unavailable")
}

func (s *Server) getSitePolicy(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		// Auth-off / no-store local mode still exposes defaults so the UI can render.
		policy := defaultSitePolicy()
		policy.LinuxDoEnabled = linuxDoOAuthConfigured()
		writeJSON(w, policy)
		return
	}
	policy, err := s.loadSitePolicy(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return
	}
	policy.LinuxDoEnabled = linuxDoOAuthConfigured()
	writeJSON(w, policy)
}

func (s *Server) putSitePolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireSitePolicyAdmin(w, r) {
		return
	}
	var body SitePolicy
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	body = normalizeSitePolicy(body)
	if err := s.saveSitePolicy(r.Context(), tenantIDFrom(r), body); err != nil {
		http.Error(w, "failed to save site policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, body)
}

// registrationAllowed reports whether open registration is currently permitted.
func (s *Server) registrationAllowed(ctx context.Context, tenantID string) (bool, error) {
	if authMode() == "off" {
		return false, nil
	}
	policy, err := s.loadSitePolicy(ctx, tenantID)
	if err != nil {
		return false, err
	}
	return policy.AllowRegister, nil
}

// cloudChannelAllowed reports whether backend/cloud generation proxy is permitted.
func (s *Server) cloudChannelAllowed(ctx context.Context, tenantID string) (bool, error) {
	policy, err := s.loadSitePolicy(ctx, tenantID)
	if err != nil {
		return false, err
	}
	return policy.AllowCloudChannel, nil
}

func sitePolicyTenantForRegister(r *http.Request) string {
	// Registration is pre-auth; use default tenant catalog policy.
	return store.DefaultTenantID
}

func boolPtrTrue(v bool) *bool { return &v }

// ensure register path can cite a stable forbidden message
const registrationDisabledMessage = "registration disabled by admin"
const cloudChannelDisabledMessage = "cloud channel generation disabled by admin"
const customChannelDisabledMessage = "custom model channels disabled by admin"

func stringsEqualFoldTrim(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}
