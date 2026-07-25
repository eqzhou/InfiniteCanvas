package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const adminChannelsStateKey = "adminChannels"
const adminBillingStateKey = "adminBilling"

// adminChannelPublic is a tenant-shared channel template without secrets.
type adminChannelPublic struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	BaseURL           string `json:"baseUrl"`
	DefaultTextModel  string `json:"defaultTextModel"`
	DefaultImageModel string `json:"defaultImageModel"`
	DefaultVideoModel string `json:"defaultVideoModel"`
	DefaultAudioModel string `json:"defaultAudioModel,omitempty"`
}

type adminBillingPublic struct {
	ModelCosts     []store.ModelCreditCost `json:"modelCosts"`
	DefaultCredits int                     `json:"defaultCredits"`
}

// requireTenantAdmin gates tenant-admin mutations.
// - auth off: allow (local single-user process)
// - authenticated admin/owner: allow
// - optional with zero registered users: allow bootstrap
// - otherwise require login as admin
func (s *Server) requireTenantAdmin(w http.ResponseWriter, r *http.Request, unavailable string) bool {
	if s.store == nil {
		http.Error(w, unavailable, http.StatusServiceUnavailable)
		return false
	}
	if authMode() == "off" {
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
		id := strings.TrimSpace(item.ID)
		if id == "" || len(id) > 128 {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}
		if _, ok := seen[id]; ok {
			http.Error(w, "duplicate channel id", http.StatusBadRequest)
			return
		}
		seen[id] = struct{}{}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = id
		}
		if len(name) > 200 {
			name = name[:200]
		}
		clean = append(clean, adminChannelPublic{
			ID:                id,
			Name:              name,
			BaseURL:           strings.TrimSpace(item.BaseURL),
			DefaultTextModel:  strings.TrimSpace(item.DefaultTextModel),
			DefaultImageModel: strings.TrimSpace(item.DefaultImageModel),
			DefaultVideoModel: strings.TrimSpace(item.DefaultVideoModel),
			DefaultAudioModel: strings.TrimSpace(item.DefaultAudioModel),
		})
	}
	raw, err := json.Marshal(clean)
	if err != nil {
		http.Error(w, "failed to encode channels", http.StatusInternalServerError)
		return
	}
	if err := s.store.PutState(r.Context(), tenantIDFrom(r), adminChannelsStateKey, raw); err != nil {
		http.Error(w, "failed to save admin channels", http.StatusInternalServerError)
		return
	}
	writeJSON(w, clean)
}

func (s *Server) getAdminModels(w http.ResponseWriter, r *http.Request) {
	// Public price list for billing estimate UI; no secrets.
	if s.store == nil {
		writeJSON(w, adminBillingPublic{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 0})
		return
	}
	raw, err := s.store.GetState(r.Context(), tenantIDFrom(r), adminBillingStateKey)
	if errors.Is(err, store.ErrNotFound) || len(raw) == 0 {
		writeJSON(w, adminBillingPublic{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 0})
		return
	}
	if err != nil {
		http.Error(w, "failed to load model costs", http.StatusInternalServerError)
		return
	}
	var cfg adminBillingPublic
	if err := json.Unmarshal(raw, &cfg); err != nil {
		writeJSON(w, adminBillingPublic{ModelCosts: []store.ModelCreditCost{}, DefaultCredits: 0})
		return
	}
	if cfg.ModelCosts == nil {
		cfg.ModelCosts = []store.ModelCreditCost{}
	}
	writeJSON(w, cfg)
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
	// Prevent non-owner admins from promoting to owner or demoting owners silently:
	// store.UpdateUser enforces last-owner protection; reject owner role changes unless actor is owner.
	if actor, ok := authUserFrom(r.Context()); ok && patch.Role != nil {
		role := strings.ToLower(strings.TrimSpace(*patch.Role))
		if role == "owner" && !strings.EqualFold(actor.Role, "owner") {
			http.Error(w, "only an owner can assign the owner role", http.StatusForbidden)
			return
		}
	}
	updated, err := s.store.UpdateUser(r.Context(), tenantIDFrom(r), userID, patch)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, updated)
}
