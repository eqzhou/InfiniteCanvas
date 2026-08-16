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

func platformStore(s *Server, w http.ResponseWriter) (store.PlatformAdminStore, bool) {
	backend, ok := s.store.(store.PlatformAdminStore)
	if !ok {
		http.Error(w, "platform administration storage unavailable", http.StatusServiceUnavailable)
		return nil, false
	}
	return backend, true
}

func platformPageParams(r *http.Request) (int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	return page, pageSize
}

func (s *Server) listPlatformTenants(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	backend, ok := platformStore(s, w)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 200 {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	page, pageSize := platformPageParams(r)
	result, err := backend.ListTenants(r.Context(), store.TenantQuery{Q: q, Page: page, PageSize: pageSize})
	if err != nil {
		http.Error(w, "failed to list tenants", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

func (s *Server) listPlatformUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	backend, ok := platformStore(s, w)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId"))
	if len(q) > 200 || len(tenantID) > 128 {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	page, pageSize := platformPageParams(r)
	result, err := backend.ListPlatformUsers(r.Context(), store.PlatformUserQuery{TenantID: tenantID, Q: q, Page: page, PageSize: pageSize})
	if err != nil {
		http.Error(w, "failed to list users", http.StatusInternalServerError)
		return
	}
	for index := range result.Items {
		// Linux.do identifiers are not needed for quota/user administration.
		result.Items[index].LinuxDoID = ""
	}
	writeJSON(w, result)
}

func (s *Server) updatePlatformTenantQuota(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	tenantID := strings.TrimSpace(chi.URLParam(r, "tenantId"))
	if tenantID == "" || len(tenantID) > 128 {
		http.Error(w, "invalid tenant id", http.StatusBadRequest)
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
	tenant, err := s.store.UpdateTenantGenerationQuota(r.Context(), tenantID, input.GenerationQuotaMonthly)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to update tenant quota", http.StatusInternalServerError)
		return
	}
	writeJSON(w, tenant)
}

func (s *Server) patchPlatformUser(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	backend, ok := platformStore(s, w)
	if !ok {
		return
	}
	userID := strings.TrimSpace(chi.URLParam(r, "userId"))
	if userID == "" || len(userID) > 128 {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}
	target, err := backend.GetUserAnyTenant(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load user", http.StatusInternalServerError)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		Status *string `json:"status"`
	}
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.Status == nil {
		http.Error(w, "invalid user update", http.StatusBadRequest)
		return
	}
	patch := store.UserPatch{Status: input.Status, ActorRole: "owner"}
	if input.Status != nil {
		status := strings.ToLower(strings.TrimSpace(*input.Status))
		if status != "active" && status != "ban" {
			http.Error(w, "invalid status", http.StatusBadRequest)
			return
		}
		*input.Status = status
		if status == "ban" && (target.PlatformAdmin || store.IsConfiguredPlatformAdminUserID(target.ID)) {
			http.Error(w, "platform administrator must be removed from deployment allowlist before disabling", http.StatusConflict)
			return
		}
	}
	updated, err := s.store.UpdateUser(r.Context(), target.TenantID, target.ID, patch)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, store.ErrLastOwner) {
		http.Error(w, "last active owner must be preserved", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "failed to update user", http.StatusInternalServerError)
		return
	}
	writeJSON(w, updated)
}

func (s *Server) adjustPlatformUserCredits(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformAdmin(w, r) {
		return
	}
	backend, ok := platformStore(s, w)
	if !ok {
		return
	}
	userID := strings.TrimSpace(chi.URLParam(r, "userId"))
	if userID == "" || len(userID) > 128 {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}
	target, err := backend.GetUserAnyTenant(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load user", http.StatusInternalServerError)
		return
	}
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
	if input.Delta == 0 || input.Delta < -maxAdminCreditValue || input.Delta > maxAdminCreditValue || input.Reason == "" || len(input.Reason) > 500 || !adminIdempotencyKeyPattern.MatchString(input.IdempotencyKey) {
		http.Error(w, "invalid credit adjustment", http.StatusBadRequest)
		return
	}
	actor, _ := authUserFrom(r.Context())
	actorID := actor.ID
	if actorID == "" {
		actorID = "local-admin"
	}
	meta := json.RawMessage(`{"scope":"platform"}`)
	user, logEntry, replayed, err := s.store.AdjustCreditsIdempotent(r.Context(), target.TenantID, target.ID, actorID, input.IdempotencyKey, input.Delta, input.Reason, meta)
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
