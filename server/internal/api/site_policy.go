package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	// sitePolicyStateKey is the legacy mixed-scope document. It is read as a
	// migration fallback, but new writes use the explicit keys below.
	sitePolicyStateKey     = "sitePolicy"
	tenantPolicyStateKey   = "tenantPolicy"
	platformPolicyStateKey = "platformPolicy"
	policySaveMaxAttempts  = 8
)

type PlatformPolicy struct {
	AllowRegister  bool `json:"allowRegister"`
	LinuxDoEnabled bool `json:"linuxDoEnabled"`
}

type TenantPolicy struct {
	AllowCustomChannel bool     `json:"allowCustomChannel"`
	AllowCloudChannel  bool     `json:"allowCloudChannel"`
	AvailableModels    []string `json:"availableModels,omitempty"`
	DefaultModel       string   `json:"defaultModel,omitempty"`
	DefaultTextModel   string   `json:"defaultTextModel,omitempty"`
	DefaultImageModel  string   `json:"defaultImageModel,omitempty"`
	DefaultVideoModel  string   `json:"defaultVideoModel,omitempty"`
	DefaultAudioModel  string   `json:"defaultAudioModel,omitempty"`
}

// SitePolicy is the public compatibility projection. It combines one
// platform-owned field with tenant-owned generation policy and is read-only for
// ordinary clients. Mixed writes require both independent capabilities.
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

func defaultPlatformPolicy() PlatformPolicy {
	return PlatformPolicy{AllowRegister: true}
}

func defaultTenantPolicy() TenantPolicy {
	return TenantPolicy{AllowCustomChannel: true, AllowCloudChannel: true}
}

func tenantPolicyFromSite(policy SitePolicy) TenantPolicy {
	return TenantPolicy{
		AllowCustomChannel: policy.AllowCustomChannel,
		AllowCloudChannel:  policy.AllowCloudChannel,
		AvailableModels:    policy.AvailableModels,
		DefaultModel:       policy.DefaultModel,
		DefaultTextModel:   policy.DefaultTextModel,
		DefaultImageModel:  policy.DefaultImageModel,
		DefaultVideoModel:  policy.DefaultVideoModel,
		DefaultAudioModel:  policy.DefaultAudioModel,
	}
}

func sitePolicyFromScopes(platform PlatformPolicy, tenant TenantPolicy) SitePolicy {
	return SitePolicy{
		AllowRegister:      platform.AllowRegister,
		AllowCustomChannel: tenant.AllowCustomChannel,
		AllowCloudChannel:  tenant.AllowCloudChannel,
		LinuxDoEnabled:     platform.LinuxDoEnabled,
		AvailableModels:    tenant.AvailableModels,
		DefaultModel:       tenant.DefaultModel,
		DefaultTextModel:   tenant.DefaultTextModel,
		DefaultImageModel:  tenant.DefaultImageModel,
		DefaultVideoModel:  tenant.DefaultVideoModel,
		DefaultAudioModel:  tenant.DefaultAudioModel,
	}
}

func normalizeTenantPolicy(policy TenantPolicy) TenantPolicy {
	policy.AvailableModels = cleanSitePolicyModels(policy.AvailableModels)
	policy.DefaultModel = strings.TrimSpace(policy.DefaultModel)
	policy.DefaultTextModel = strings.TrimSpace(policy.DefaultTextModel)
	policy.DefaultImageModel = strings.TrimSpace(policy.DefaultImageModel)
	policy.DefaultVideoModel = strings.TrimSpace(policy.DefaultVideoModel)
	policy.DefaultAudioModel = strings.TrimSpace(policy.DefaultAudioModel)
	return policy
}

func normalizeSitePolicy(policy SitePolicy) SitePolicy {
	tenant := normalizeTenantPolicy(tenantPolicyFromSite(policy))
	return sitePolicyFromScopes(PlatformPolicy{AllowRegister: policy.AllowRegister}, tenant)
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
func validateTenantPolicyModels(policy TenantPolicy) error {
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

func validateSitePolicyModels(policy SitePolicy) error {
	return validateTenantPolicyModels(tenantPolicyFromSite(policy))
}

func (s *Server) loadSitePolicy(ctx context.Context, tenantID string) (SitePolicy, error) {
	platform, err := s.loadPlatformPolicy(ctx)
	if err != nil {
		return defaultSitePolicy(), err
	}
	tenant, err := s.loadTenantPolicy(ctx, tenantID)
	if err != nil {
		return defaultSitePolicy(), err
	}
	return sitePolicyFromScopes(platform, tenant), nil
}

func (s *Server) saveSitePolicy(ctx context.Context, tenantID string, policy SitePolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	policy = normalizeSitePolicy(policy)
	if tenantID != store.DefaultTenantID {
		// Historical behavior scoped the mixed endpoint's tenant fields to the
		// caller and changed registration only from the default tenant.
		return s.saveTenantPolicy(ctx, tenantID, tenantPolicyFromSite(policy))
	}
	tenant := normalizeTenantPolicy(tenantPolicyFromSite(policy))
	platform := PlatformPolicy{AllowRegister: policy.AllowRegister}
	tenantRaw, err := json.Marshal(tenant)
	if err != nil {
		return err
	}
	platformRaw, err := json.Marshal(platform)
	if err != nil {
		return err
	}
	legacyRaw, err := json.Marshal(sitePolicyFromScopes(platform, tenant))
	if err != nil {
		return err
	}
	keys := []string{tenantPolicyStateKey, platformPolicyStateKey, sitePolicyStateKey}
	for range policySaveMaxAttempts {
		current, err := s.store.GetStates(ctx, tenantID, keys)
		if err != nil {
			return err
		}
		err = s.store.CompareAndSwapStates(ctx, tenantID, []store.StateMutation{
			{Key: tenantPolicyStateKey, Expected: current[tenantPolicyStateKey], Value: tenantRaw},
			{Key: platformPolicyStateKey, Expected: current[platformPolicyStateKey], Value: platformRaw},
			{Key: sitePolicyStateKey, Expected: current[sitePolicyStateKey], Value: legacyRaw},
		})
		if !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return store.ErrConflict
}

func tenantPolicyFromState(scopedRaw, legacyRaw []byte) (TenantPolicy, error) {
	policy := defaultTenantPolicy()
	if len(scopedRaw) != 0 {
		if err := json.Unmarshal(scopedRaw, &policy); err != nil {
			return defaultTenantPolicy(), err
		}
		return normalizeTenantPolicy(policy), nil
	}
	if len(legacyRaw) == 0 {
		return policy, nil
	}
	var legacy SitePolicy
	if json.Unmarshal(legacyRaw, &legacy) != nil {
		return policy, nil
	}
	return normalizeTenantPolicy(tenantPolicyFromSite(legacy)), nil
}

func (s *Server) loadTenantPolicy(ctx context.Context, tenantID string) (TenantPolicy, error) {
	policy := defaultTenantPolicy()
	if s == nil || s.store == nil {
		return policy, nil
	}
	values, err := s.store.GetStates(ctx, tenantID, []string{tenantPolicyStateKey, sitePolicyStateKey})
	if err != nil {
		return policy, err
	}
	return tenantPolicyFromState(values[tenantPolicyStateKey], values[sitePolicyStateKey])
}

func (s *Server) saveTenantPolicy(ctx context.Context, tenantID string, policy TenantPolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	policy = normalizeTenantPolicy(policy)
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	keys := []string{tenantPolicyStateKey, sitePolicyStateKey}
	if tenantID == store.DefaultTenantID {
		keys = append(keys, platformPolicyStateKey)
	}
	for range policySaveMaxAttempts {
		current, err := s.store.GetStates(ctx, tenantID, keys)
		if err != nil {
			return err
		}
		var platform PlatformPolicy
		if tenantID == store.DefaultTenantID {
			platform, err = platformPolicyFromState(current[platformPolicyStateKey], current[sitePolicyStateKey])
		} else {
			platform, err = s.loadPlatformPolicy(ctx)
		}
		if err != nil {
			return err
		}
		legacyRaw, err := json.Marshal(sitePolicyFromScopes(platform, policy))
		if err != nil {
			return err
		}
		err = s.store.CompareAndSwapStates(ctx, tenantID, []store.StateMutation{
			{Key: tenantPolicyStateKey, Expected: current[tenantPolicyStateKey], Value: raw},
			{Key: sitePolicyStateKey, Expected: current[sitePolicyStateKey], Value: legacyRaw},
		})
		if !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return store.ErrConflict
}

func platformPolicyFromState(scopedRaw, legacyRaw []byte) (PlatformPolicy, error) {
	policy := defaultPlatformPolicy()
	if len(scopedRaw) != 0 {
		if err := json.Unmarshal(scopedRaw, &policy); err != nil {
			return defaultPlatformPolicy(), err
		}
		policy.LinuxDoEnabled = false
		return policy, nil
	}
	if len(legacyRaw) == 0 {
		return policy, nil
	}
	var legacy SitePolicy
	if json.Unmarshal(legacyRaw, &legacy) != nil {
		return policy, nil
	}
	policy.AllowRegister = legacy.AllowRegister
	return policy, nil
}

func (s *Server) loadPlatformPolicy(ctx context.Context) (PlatformPolicy, error) {
	policy := defaultPlatformPolicy()
	if s == nil || s.store == nil {
		return policy, nil
	}
	values, err := s.store.GetStates(ctx, store.DefaultTenantID, []string{platformPolicyStateKey, sitePolicyStateKey})
	if err != nil {
		return policy, err
	}
	return platformPolicyFromState(values[platformPolicyStateKey], values[sitePolicyStateKey])
}

func (s *Server) savePlatformPolicy(ctx context.Context, policy PlatformPolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	policy.LinuxDoEnabled = false
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	keys := []string{platformPolicyStateKey, tenantPolicyStateKey, sitePolicyStateKey}
	for range policySaveMaxAttempts {
		current, err := s.store.GetStates(ctx, store.DefaultTenantID, keys)
		if err != nil {
			return err
		}
		tenant, err := tenantPolicyFromState(current[tenantPolicyStateKey], current[sitePolicyStateKey])
		if err != nil {
			return err
		}
		legacyRaw, err := json.Marshal(sitePolicyFromScopes(policy, tenant))
		if err != nil {
			return err
		}
		err = s.store.CompareAndSwapStates(ctx, store.DefaultTenantID, []store.StateMutation{
			{Key: platformPolicyStateKey, Expected: current[platformPolicyStateKey], Value: raw},
			{Key: sitePolicyStateKey, Expected: current[sitePolicyStateKey], Value: legacyRaw},
		})
		if !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return store.ErrConflict
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
	// The legacy payload mixes platform and tenant fields. It is writable only by
	// an actor holding both capabilities; all normal UI uses the scoped routes.
	if !s.requireTenantOwner(w, r, "site policy unavailable") || !s.requirePlatformAdmin(w, r) {
		return
	}
	var body SitePolicy
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	// Decode stops at the first value, so a second document riding along would
	// otherwise be accepted and silently ignored.
	if err := dec.Decode(&body); err != nil || ensureJSONEOF(dec) != nil {
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

func (s *Server) getTenantPolicy(w http.ResponseWriter, r *http.Request) {
	policy, err := s.loadTenantPolicy(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load tenant policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, policy)
}

func (s *Server) putTenantPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant policy unavailable") {
		return
	}
	var body TenantPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	body = normalizeTenantPolicy(body)
	if err := validateTenantPolicyModels(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.saveTenantPolicy(r.Context(), tenantIDFrom(r), body); err != nil {
		http.Error(w, "failed to save tenant policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, body)
}

func (s *Server) getPlatformPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	policy, err := s.loadPlatformPolicy(r.Context())
	if err != nil {
		http.Error(w, "failed to load platform policy", http.StatusInternalServerError)
		return
	}
	policy.LinuxDoEnabled = linuxDoOAuthConfigured()
	writeJSON(w, policy)
}

func (s *Server) putPlatformPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	var body PlatformPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.savePlatformPolicy(r.Context(), body); err != nil {
		http.Error(w, "failed to save platform policy", http.StatusInternalServerError)
		return
	}
	body.LinuxDoEnabled = linuxDoOAuthConfigured()
	writeJSON(w, body)
}

// registrationAllowed reports whether open registration is currently permitted.
func (s *Server) registrationAllowed(ctx context.Context, _ string) (bool, error) {
	if authMode() == "off" {
		return false, nil
	}
	policy, err := s.loadPlatformPolicy(ctx)
	if err != nil {
		return false, err
	}
	return policy.AllowRegister, nil
}

// cloudChannelAllowed reports whether backend/cloud generation proxy is permitted.
func (s *Server) cloudChannelAllowed(ctx context.Context, tenantID string) (bool, error) {
	policy, err := s.loadTenantPolicy(ctx, tenantID)
	if err != nil {
		return false, err
	}
	return policy.AllowCloudChannel, nil
}

func sitePolicyTenantForRegister(r *http.Request) string {
	// Registration is pre-auth; use default tenant catalog policy.
	return store.DefaultTenantID
}

// ensure register path can cite a stable forbidden message
const registrationDisabledMessage = "registration disabled by admin"
const cloudChannelDisabledMessage = "cloud channel generation disabled by admin"
const modelNotAllowedMessage = "model is not in the tenant allow list"

// modelAllowedByPolicy reports whether a requested model may be generated with.
// An empty allow list means "no restriction", so a tenant that never configured
// a catalog is never stranded. The check is deliberately tenant-wide rather
// than user-role dependent: the catalog is the governance boundary, and a
// client-side picker alone can be bypassed by posting the job directly.
func (s *Server) modelAllowedByPolicy(ctx context.Context, tenantID, model string) (bool, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		// No explicit model means the channel default applies, which the admin
		// configured; there is nothing the user chose to police here.
		return true, nil
	}
	policy, err := s.loadTenantPolicy(ctx, tenantID)
	if err != nil {
		return false, err
	}
	if len(policy.AvailableModels) == 0 {
		return true, nil
	}
	for _, allowed := range policy.AvailableModels {
		if allowed == model {
			return true, nil
		}
	}
	return false, nil
}

// requireAllowedModel writes the refusal itself so every generation entry point
// enforces the catalog identically.
func (s *Server) requireAllowedModel(w http.ResponseWriter, r *http.Request, model string) bool {
	allowed, err := s.modelAllowedByPolicy(r.Context(), tenantIDFrom(r), model)
	if err != nil {
		http.Error(w, "failed to load site policy", http.StatusInternalServerError)
		return false
	}
	if !allowed {
		http.Error(w, modelNotAllowedMessage, http.StatusForbidden)
		return false
	}
	return true
}
