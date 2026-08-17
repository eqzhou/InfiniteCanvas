package api

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const adminChannelsStateKey = "adminChannels"
const adminBillingStateKey = "adminBilling"
const adminRevisionHeader = "X-OpenBoard-Revision"

func adminConfigRevision(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum[:])
}

// adminChannelPublic is a tenant-shared channel template without secrets.
type adminMediaCapability struct {
	Model         string   `json:"model"`
	Kind          string   `json:"kind"`
	Modes         []string `json:"modes"`
	Sizes         []string `json:"sizes,omitempty"`
	Durations     []int    `json:"durations,omitempty"`
	MaxReferences int      `json:"maxReferences"`
}

type adminChannelPublic struct {
	Source         string `json:"-"`
	ID             string `json:"id"`
	Name           string `json:"name"`
	BaseURL        string `json:"baseUrl"`
	Protocol       string `json:"protocol"`
	Enabled        bool   `json:"enabled"`
	AllowUserUse   bool   `json:"allowUserUse"`
	Weight         int    `json:"weight"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	// Models is the optional per-channel allow list used by shared-auto routing.
	// Empty means "no model restriction" and only protocol capability applies.
	Models            []string               `json:"models,omitempty"`
	DefaultTextModel  string                 `json:"defaultTextModel"`
	DefaultImageModel string                 `json:"defaultImageModel"`
	DefaultVideoModel string                 `json:"defaultVideoModel"`
	DefaultAudioModel string                 `json:"defaultAudioModel,omitempty"`
	MediaCapabilities []adminMediaCapability `json:"mediaCapabilities,omitempty"`
	SecretConfigured  bool                   `json:"secretConfigured"`
	SecretBindingID   string                 `json:"secretBindingId,omitempty"`
}

var adminIdempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$`)

const maxAdminCreditValue = 1_000_000_000

type adminTenantQuota struct {
	GenerationThisMonth    int64 `json:"generationThisMonth"`
	GenerationQuotaMonthly int64 `json:"generationQuotaMonthly"`
}

func (s *Server) getAdminTenantQuota(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant quota unavailable") {
		return
	}
	usage, err := s.store.GetUsage(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load tenant quota", http.StatusInternalServerError)
		return
	}
	writeJSON(w, adminTenantQuota{
		GenerationThisMonth:    usage.GenerationThisMonth,
		GenerationQuotaMonthly: usage.GenerationQuotaMonthly,
	})
}

func (s *Server) putAdminTenantQuota(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		GenerationQuotaMonthly int64 `json:"generationQuotaMonthly"`
	}
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.GenerationQuotaMonthly < 0 || input.GenerationQuotaMonthly > maxAdminCreditValue {
		http.Error(w, "invalid tenant quota", http.StatusBadRequest)
		return
	}
	tenant, err := s.store.UpdateTenantGenerationQuota(r.Context(), tenantIDFrom(r), input.GenerationQuotaMonthly)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to update tenant quota", http.StatusInternalServerError)
		return
	}
	usage, err := s.store.GetUsage(r.Context(), tenant.ID)
	if err != nil {
		http.Error(w, "failed to load tenant quota", http.StatusInternalServerError)
		return
	}
	writeJSON(w, adminTenantQuota{
		GenerationThisMonth:    usage.GenerationThisMonth,
		GenerationQuotaMonthly: tenant.GenerationQuotaMonthly,
	})
}

func (s *Server) getAdminChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
		return
	}
	if s.store == nil {
		w.Header().Set(adminRevisionHeader, adminConfigRevision([]adminChannelPublic{}))
		writeJSON(w, []adminChannelPublic{})
		return
	}
	raw, err := s.store.GetState(r.Context(), tenantIDFrom(r), adminChannelsStateKey)
	if errors.Is(err, store.ErrNotFound) {
		w.Header().Set(adminRevisionHeader, adminConfigRevision([]adminChannelPublic{}))
		writeJSON(w, []adminChannelPublic{})
		return
	}
	if err != nil {
		http.Error(w, "failed to load admin channels", http.StatusInternalServerError)
		return
	}
	if len(raw) == 0 {
		w.Header().Set(adminRevisionHeader, adminConfigRevision([]adminChannelPublic{}))
		writeJSON(w, []adminChannelPublic{})
		return
	}
	var channels []adminChannelPublic
	if err := json.Unmarshal(raw, &channels); err != nil {
		http.Error(w, "invalid shared channel configuration", http.StatusInternalServerError)
		return
	}
	if channels == nil {
		channels = []adminChannelPublic{}
	}
	w.Header().Set(adminRevisionHeader, adminConfigRevision(channels))
	configured, err := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load admin channels", http.StatusInternalServerError)
		return
	}
	for index := range channels {
		channels[index].SecretConfigured = configured[channels[index].ID]
	}
	writeJSON(w, channels)
}

func (s *Server) putAdminChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body []adminChannelPublic
	if err := decoder.Decode(&body); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body == nil {
		body = []adminChannelPublic{}
	}
	if len(body) > 100 {
		http.Error(w, "too many channels", http.StatusBadRequest)
		return
	}
	clean := make([]adminChannelPublic, 0, len(body))
	seen := map[string]struct{}{}
	for _, item := range body {
		item, message := normalizeAdminChannel(item)
		if message != "" {
			http.Error(w, message, http.StatusBadRequest)
			return
		}
		if err := validateAccountManagedChannelURL(item.BaseURL); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := item.ID
		if _, ok := seen[id]; ok {
			http.Error(w, "duplicate channel id", http.StatusBadRequest)
			return
		}
		seen[id] = struct{}{}
		clean = append(clean, item)
	}
	clean, err := s.replaceAdminChannels(r.Context(), tenantIDFrom(r), r.Header.Get(adminRevisionHeader), clean)
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to save admin channels", http.StatusInternalServerError)
		return
	}
	revision := adminConfigRevision(clean)
	configured, _ := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	for index := range clean {
		clean[index].SecretConfigured = configured[clean[index].ID]
	}
	w.Header().Set(adminRevisionHeader, revision)
	writeJSON(w, clean)
}

func upsertAdminChannelList(current []adminChannelPublic, next adminChannelPublic) []adminChannelPublic {
	out := append([]adminChannelPublic(nil), current...)
	for index, item := range out {
		if item.ID == next.ID {
			out[index] = next
			return out
		}
	}
	return append(out, next)
}

func (s *Server) putAdminChannel(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant channels unavailable") {
		return
	}
	id := chi.URLParam(r, "id")
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var item adminChannelPublic
	if err := decoder.Decode(&item); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	item, message := normalizeAdminChannel(item)
	if message != "" {
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	if item.ID != id {
		http.Error(w, "channel id mismatch", http.StatusBadRequest)
		return
	}
	if err := validateAccountManagedChannelURL(item.BaseURL); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	current, err := s.loadAdminChannels(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load admin channels", http.StatusInternalServerError)
		return
	}
	if len(current) >= 100 {
		found := false
		for _, existing := range current {
			if existing.ID == item.ID {
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "too many channels", http.StatusBadRequest)
			return
		}
	}
	clean, err := s.replaceAdminChannels(r.Context(), tenantIDFrom(r), r.Header.Get(adminRevisionHeader), upsertAdminChannelList(current, item))
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to save admin channel", http.StatusInternalServerError)
		return
	}
	revision := adminConfigRevision(clean)
	configured, _ := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	for index := range clean {
		clean[index].SecretConfigured = configured[clean[index].ID]
	}
	w.Header().Set(adminRevisionHeader, revision)
	writeJSON(w, clean)
}

func (s *Server) getAdminModels(w http.ResponseWriter, r *http.Request) {
	// Public price list for billing estimate UI; no secrets.
	if s.store == nil {
		config := store.ModelCreditConfig{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 1}
		writeJSON(w, adminModelCreditConfig{ModelCreditConfig: config, Revision: adminConfigRevision(config)})
		return
	}
	raw, err := getOptionalState(r.Context(), s.store, store.DefaultTenantID, adminBillingStateKey)
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	cfg, err := decodeModelCreditConfig(raw)
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, adminModelCreditConfig{ModelCreditConfig: cfg, Revision: adminConfigRevision(cfg)})
}

func (s *Server) getPlatformModelCosts(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	s.getAdminModels(w, r)
}

type adminModelCreditConfig struct {
	store.ModelCreditConfig
	Revision string `json:"revision,omitempty"`
}

func decodeModelCreditConfig(raw []byte) (store.ModelCreditConfig, error) {
	cfg := store.ModelCreditConfig{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 1}
	if len(raw) == 0 {
		return cfg, nil
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return store.ModelCreditConfig{}, errors.New("invalid model costs")
	}
	if cfg.ModelCosts == nil {
		cfg.ModelCosts = []store.ModelCreditCost{}
	}
	if cfg.DefaultCredits < 1 {
		cfg.DefaultCredits = 1
	}
	for index := range cfg.ModelCosts {
		if cfg.ModelCosts[index].Credits < 1 {
			cfg.ModelCosts[index].Credits = 1
		}
	}
	return cfg, nil
}

func normalizeModelCreditConfig(input store.ModelCreditConfig) (store.ModelCreditConfig, string) {
	if input.DefaultCredits < 1 || input.DefaultCredits > maxAdminCreditValue || len(input.ModelCosts) > 500 {
		return store.ModelCreditConfig{}, "invalid model cost"
	}
	seen := make(map[string]struct{}, len(input.ModelCosts))
	clean := make([]store.ModelCreditCost, 0, len(input.ModelCosts))
	for _, item := range input.ModelCosts {
		model := strings.TrimSpace(item.Model)
		if model == "" || len(model) > 500 || item.Credits < 1 || item.Credits > maxAdminCreditValue {
			return store.ModelCreditConfig{}, "invalid model cost"
		}
		key := strings.ToLower(model)
		if _, exists := seen[key]; exists {
			return store.ModelCreditConfig{}, "duplicate model"
		}
		seen[key] = struct{}{}
		clean = append(clean, store.ModelCreditCost{Model: model, Credits: item.Credits})
	}
	return store.ModelCreditConfig{ModelCosts: clean, DefaultCredits: input.DefaultCredits}, ""
}

func (s *Server) putAdminModels(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input adminModelCreditConfig
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	config, message := normalizeModelCreditConfig(input.ModelCreditConfig)
	if message != "" {
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	raw, err := getOptionalState(r.Context(), s.store, store.DefaultTenantID, adminBillingStateKey)
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	current, err := decodeModelCreditConfig(raw)
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	if input.Revision == "" || input.Revision != adminConfigRevision(current) {
		http.Error(w, "model costs changed concurrently", http.StatusConflict)
		return
	}
	next, err := json.Marshal(config)
	if err != nil {
		http.Error(w, "failed to save model costs", http.StatusInternalServerError)
		return
	}
	if err := s.store.CompareAndSwapState(r.Context(), store.DefaultTenantID, adminBillingStateKey, raw, next); errors.Is(err, store.ErrConflict) {
		http.Error(w, "model costs changed concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to save model costs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, adminModelCreditConfig{ModelCreditConfig: config, Revision: adminConfigRevision(config)})
}

func (s *Server) listAdminCreditLogs(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant credit logs unavailable") {
		return
	}
	query := store.CreditLogQuery{
		UserID: strings.TrimSpace(r.URL.Query().Get("userId")),
		Reason: strings.TrimSpace(r.URL.Query().Get("reason")),
		Model:  strings.TrimSpace(r.URL.Query().Get("model")),
	}
	if len(query.UserID) > 128 || len(query.Reason) > 500 || len(query.Model) > 500 {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	if value, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil {
		query.Page = value
	}
	if value, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil {
		query.PageSize = value
	}
	result, err := s.store.ListCreditLogs(r.Context(), tenantIDFrom(r), query)
	if err != nil {
		http.Error(w, "failed to list credit logs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

type adminCreditAdjustmentInput struct {
	Delta          int64  `json:"delta"`
	Reason         string `json:"reason"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (s *Server) createAdminCreditAdjustment(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	userID := strings.TrimSpace(chi.URLParam(r, "id"))
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input adminCreditAdjustmentInput
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if userID == "" || len(userID) > 128 || input.Delta == 0 || input.Delta < -maxAdminCreditValue || input.Delta > maxAdminCreditValue ||
		input.Reason == "" || len(input.Reason) > 500 || !adminIdempotencyKeyPattern.MatchString(input.IdempotencyKey) {
		http.Error(w, "invalid credit adjustment", http.StatusBadRequest)
		return
	}
	actor, _ := authUserFrom(r.Context())
	actorID := actor.ID
	if actorID == "" {
		actorID = "local-admin"
	}
	user, logEntry, replayed, err := s.store.AdjustCreditsIdempotent(r.Context(), tenantIDFrom(r), userID, actorID, input.IdempotencyKey, input.Delta, input.Reason, json.RawMessage(`{}`))
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "idempotency key conflict", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, store.ErrInsufficientCredits) {
		http.Error(w, "insufficient credits", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to adjust credits", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"user": user, "log": logEntry, "replayed": replayed})
}

func (s *Server) listAdminUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant members unavailable") {
		return
	}
	q := store.UserQuery{Q: strings.TrimSpace(r.URL.Query().Get("q"))}
	if page, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil {
		q.Page = page
	}
	if pageSize, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil {
		q.PageSize = pageSize
	}
	result, err := s.store.ListUsers(r.Context(), tenantIDFrom(r), q)
	if err != nil {
		http.Error(w, "failed to list users", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

func (s *Server) patchAdminUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant members unavailable") {
		return
	}
	userID := strings.TrimSpace(chi.URLParam(r, "id"))
	if userID == "" {
		http.Error(w, "missing user id", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if err := decoder.Decode(&input); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if input.Role == nil && input.Status == nil {
		http.Error(w, "empty patch", http.StatusBadRequest)
		return
	}
	patch := store.UserPatch{Role: input.Role, Status: input.Status, ActorRole: "owner"}
	if patch.Role != nil {
		role := strings.ToLower(strings.TrimSpace(*patch.Role))
		if role == "user" {
			role = "member"
		}
		if role != "owner" && role != "member" {
			http.Error(w, "invalid role", http.StatusBadRequest)
			return
		}
		*patch.Role = role
	}
	if patch.Status != nil {
		target, err := s.store.GetUser(r.Context(), tenantIDFrom(r), userID)
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to update user", http.StatusInternalServerError)
			return
		}
		if target.PlatformAdmin || store.IsConfiguredPlatformAdminUserID(target.ID) {
			http.Error(w, "platform account status is managed by a platform administrator", http.StatusForbidden)
			return
		}
		status := strings.ToLower(strings.TrimSpace(*patch.Status))
		if status != "active" && status != "ban" {
			http.Error(w, "invalid status", http.StatusBadRequest)
			return
		}
		*patch.Status = status
	}
	updated, err := s.store.UpdateUser(r.Context(), tenantIDFrom(r), userID, patch)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, store.ErrLastOwner) {
		http.Error(w, "last active owner must be preserved", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrUnauthorized) {
		http.Error(w, "only an owner can modify an owner", http.StatusForbidden)
		return
	}
	if errors.Is(err, store.ErrInvalidInput) {
		http.Error(w, "invalid user update", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, "failed to update user", http.StatusInternalServerError)
		return
	}
	writeJSON(w, updated)
}
