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

	// Model governance. AvailableModels narrows what ordinary users may pick; an
	// empty list means "no restriction". The per-kind defaults must name a model
	// inside that list when the list is non-empty. None of these fields are
	// secret, so the catalog is readable by ordinary users.
	AvailableModels   []string `json:"availableModels,omitempty"`
	DefaultModel      string   `json:"defaultModel,omitempty"`
	DefaultTextModel  string   `json:"defaultTextModel,omitempty"`
	DefaultImageModel string   `json:"defaultImageModel,omitempty"`
	DefaultVideoModel string   `json:"defaultVideoModel,omitempty"`
	DefaultAudioModel string   `json:"defaultAudioModel,omitempty"`
}

const (
	maxSitePolicyModels     = 200
	maxSitePolicyModelBytes = 128
)

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
	policy.AvailableModels = cleanSitePolicyModels(policy.AvailableModels)
	policy.DefaultModel = strings.TrimSpace(policy.DefaultModel)
	policy.DefaultTextModel = strings.TrimSpace(policy.DefaultTextModel)
	policy.DefaultImageModel = strings.TrimSpace(policy.DefaultImageModel)
	policy.DefaultVideoModel = strings.TrimSpace(policy.DefaultVideoModel)
	policy.DefaultAudioModel = strings.TrimSpace(policy.DefaultAudioModel)
	return policy
}

// cleanSitePolicyModels trims, drops blanks and keeps first-seen order.
func cleanSitePolicyModels(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		model := strings.TrimSpace(value)
		if model == "" {
			continue
		}
		if _, duplicate := seen[model]; duplicate {
			continue
		}
		seen[model] = struct{}{}
		cleaned = append(cleaned, model)
	}
	if len(cleaned) == 0 {
		return nil
	}
	return cleaned
}

// validateSitePolicyModels rejects oversized catalogs and defaults that name a
// model outside a non-empty allow list, so the stored catalog is always usable.
func validateSitePolicyModels(policy SitePolicy) error {
	if len(policy.AvailableModels) > maxSitePolicyModels {
		return errors.New("too many models")
	}
	for _, model := range policy.AvailableModels {
		if len(model) > maxSitePolicyModelBytes {
			return errors.New("model name too long")
		}
	}
	if len(policy.AvailableModels) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(policy.AvailableModels))
	for _, model := range policy.AvailableModels {
		allowed[model] = struct{}{}
	}
	for _, value := range []string{
		policy.DefaultModel, policy.DefaultTextModel, policy.DefaultImageModel,
		policy.DefaultVideoModel, policy.DefaultAudioModel,
	} {
		if value == "" {
			continue
		}
		if _, ok := allowed[value]; !ok {
			return errors.New("default model is not in the available model list")
		}
	}
	return nil
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
	if err := validateSitePolicyModels(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
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
