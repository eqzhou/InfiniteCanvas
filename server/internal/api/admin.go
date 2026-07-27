package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const adminChannelsStateKey = "adminChannels"

// adminChannelPublic is a tenant-shared channel template without secrets.
type adminChannelPublic struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	BaseURL           string   `json:"baseUrl"`
	Protocol          string   `json:"protocol"`
	Enabled           bool     `json:"enabled"`
	AllowUserUse      bool     `json:"allowUserUse"`
	Weight            int      `json:"weight"`
	TimeoutSeconds    int      `json:"timeoutSeconds"`
	// Models is the optional per-channel allow list used by shared-auto routing.
	// Empty means "no model restriction" and only protocol capability applies.
	Models            []string `json:"models,omitempty"`
	DefaultTextModel  string   `json:"defaultTextModel"`
	DefaultImageModel string   `json:"defaultImageModel"`
	DefaultVideoModel string   `json:"defaultVideoModel"`
	DefaultAudioModel string   `json:"defaultAudioModel,omitempty"`
	SecretConfigured  bool     `json:"secretConfigured"`
	SecretBindingID   string   `json:"secretBindingId,omitempty"`
}

var adminIdempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$`)

const maxAdminCreditValue = 1_000_000_000

// requireTenantAdmin gates tenant-admin mutations.
// - auth off: require the local process token
// - authenticated admin/owner: allow
// - optional with zero registered users: allow bootstrap
// - otherwise require login as admin
func (s *Server) requireTenantAdmin(w http.ResponseWriter, r *http.Request, unavailable string) bool {
	if s.store == nil {
		http.Error(w, unavailable, http.StatusServiceUnavailable)
		return false
	}
	if authMode() == "off" {
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return false
		}
		return true
	}
	if user, ok := authUserFrom(r.Context()); ok {
		if !isTenantAdmin(user) {
			http.Error(w, "admin required", http.StatusForbidden)
			return false
		}
		return true
	}
	if authMode() == "required" {
		http.Error(w, "login required", http.StatusUnauthorized)
		return false
	}
	// optional, no session: bootstrap only while the catalog has no users
	count, err := s.store.CountUsers(r.Context())
	if err != nil {
		http.Error(w, "failed to verify admin access", http.StatusServiceUnavailable)
		return false
	}
	if count == 0 {
		return true
	}
	http.Error(w, "login required", http.StatusUnauthorized)
	return false
}

func (s *Server) getAdminChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
		return
	}
	if s.store == nil {
		writeJSON(w, []adminChannelPublic{})
		return
	}
	raw, err := s.store.GetState(r.Context(), tenantIDFrom(r), adminChannelsStateKey)
	if errors.Is(err, store.ErrNotFound) || len(raw) == 0 {
		writeJSON(w, []adminChannelPublic{})
		return
	}
	if err != nil {
		http.Error(w, "failed to load admin channels", http.StatusInternalServerError)
		return
	}
	var channels []adminChannelPublic
	if err := json.Unmarshal(raw, &channels); err != nil {
		// Tolerate legacy shapes by returning empty rather than 500.
		writeJSON(w, []adminChannelPublic{})
		return
	}
	if channels == nil {
		channels = []adminChannelPublic{}
	}
	configured, _ := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	for index := range channels {
		channels[index].SecretConfigured = configured[channels[index].ID]
	}
	writeJSON(w, channels)
}

func (s *Server) putAdminChannels(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin channels unavailable") {
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
		id := item.ID
		if _, ok := seen[id]; ok {
			http.Error(w, "duplicate channel id", http.StatusBadRequest)
			return
		}
		seen[id] = struct{}{}
		clean = append(clean, item)
	}
	clean, err := s.replaceAdminChannels(r.Context(), tenantIDFrom(r), clean)
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "channels changed concurrently", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to save admin channels", http.StatusInternalServerError)
		return
	}
	configured, _ := s.adminChannelSecretPresence(r.Context(), tenantIDFrom(r))
	for index := range clean {
		clean[index].SecretConfigured = configured[clean[index].ID]
	}
	writeJSON(w, clean)
}

func (s *Server) getAdminModels(w http.ResponseWriter, r *http.Request) {
	// Public price list for billing estimate UI; no secrets.
	if s.store == nil {
		writeJSON(w, store.ModelCreditConfig{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 0})
		return
	}
	cfg, err := s.store.GetModelCreditConfig(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, cfg)
}

func normalizeModelCreditConfig(input store.ModelCreditConfig) (store.ModelCreditConfig, string) {
	if input.DefaultCredits < 0 || input.DefaultCredits > maxAdminCreditValue || len(input.ModelCosts) > 500 {
		return store.ModelCreditConfig{}, "invalid model cost"
	}
	seen := make(map[string]struct{}, len(input.ModelCosts))
	clean := make([]store.ModelCreditCost, 0, len(input.ModelCosts))
	for _, item := range input.ModelCosts {
		model := strings.TrimSpace(item.Model)
		if model == "" || len(model) > 500 || item.Credits < 0 || item.Credits > maxAdminCreditValue {
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
	if !s.requireTenantAdmin(w, r, "admin model costs unavailable") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input store.ModelCreditConfig
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	config, message := normalizeModelCreditConfig(input)
	if message != "" {
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	if err := s.store.PutModelCreditConfig(r.Context(), tenantIDFrom(r), config); err != nil {
		http.Error(w, "failed to save model costs", http.StatusInternalServerError)
		return
	}
	writeJSON(w, config)
}

func (s *Server) listAdminCreditLogs(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantAdmin(w, r, "admin credit logs unavailable") {
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
	if !s.requireTenantAdmin(w, r, "admin credit adjustments unavailable") {
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
	if !s.requireTenantAdmin(w, r, "admin users unavailable") {
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
	if !s.requireTenantAdmin(w, r, "admin users unavailable") {
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
	var patch store.UserPatch
	if err := decoder.Decode(&patch); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if patch.Role == nil && patch.Status == nil && patch.DisplayName == nil && patch.CreditsDelta == nil {
		http.Error(w, "empty patch", http.StatusBadRequest)
		return
	}
	if patch.CreditsDelta != nil {
		http.Error(w, "use credit adjustments endpoint", http.StatusBadRequest)
		return
	}
	if patch.Role != nil {
		role := strings.ToLower(strings.TrimSpace(*patch.Role))
		if role != "owner" && role != "admin" && role != "member" {
			http.Error(w, "invalid role", http.StatusBadRequest)
			return
		}
		*patch.Role = role
	}
	if patch.Status != nil {
		status := strings.ToLower(strings.TrimSpace(*patch.Status))
		if status != "active" && status != "ban" {
			http.Error(w, "invalid status", http.StatusBadRequest)
			return
		}
		*patch.Status = status
	}
	patch.ActorRole = "owner"
	if actor, ok := authUserFrom(r.Context()); ok {
		patch.ActorRole = actor.Role
	}
	// Prevent non-owner admins from promoting to owner or demoting owners silently:
	// store.UpdateUser enforces last-owner protection; reject owner role changes unless actor is owner.
	if actor, ok := authUserFrom(r.Context()); ok && (patch.Role != nil || patch.Status != nil) {
		if patch.Role != nil && strings.EqualFold(*patch.Role, "owner") && !strings.EqualFold(actor.Role, "owner") {
			http.Error(w, "only an owner can assign the owner role", http.StatusForbidden)
			return
		}
		if !strings.EqualFold(actor.Role, "owner") {
			target, err := s.store.GetUser(r.Context(), tenantIDFrom(r), userID)
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "failed to update user", http.StatusInternalServerError)
				return
			}
			if strings.EqualFold(target.Role, "owner") {
				http.Error(w, "only an owner can modify an owner", http.StatusForbidden)
				return
			}
		}
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
