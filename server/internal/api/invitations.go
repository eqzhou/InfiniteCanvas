package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func invitationStore(s *Server, w http.ResponseWriter) (store.InvitationStore, bool) {
	backend, ok := s.store.(store.InvitationStore)
	if !ok {
		http.Error(w, "invitation storage unavailable", http.StatusServiceUnavailable)
		return nil, false
	}
	return backend, true
}

func (s *Server) createTenantInvitation(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant invitations unavailable") {
		return
	}
	backend, ok := invitationStore(s, w)
	if !ok {
		return
	}
	actor, _ := authUserFrom(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		Email          string `json:"email"`
		Role           string `json:"role"`
		ExpiresInHours int    `json:"expiresInHours"`
	}
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	role := strings.ToLower(strings.TrimSpace(input.Role))
	if role == "user" {
		role = "member"
	}
	if normalized, valid := store.NormalizeEmail(email); !valid || normalized != email || role != "member" {
		http.Error(w, "invalid invitation", http.StatusBadRequest)
		return
	}
	hours := input.ExpiresInHours
	if hours == 0 {
		hours = 168
	}
	if hours < 1 || hours > 720 {
		http.Error(w, "invalid invitation expiry", http.StatusBadRequest)
		return
	}
	created, err := backend.CreateTenantInvitation(r.Context(), store.TenantInvitationInput{
		TenantID: tenantIDFrom(r), CreatedBy: actor.ID, Email: email, Role: role,
		ExpiresAt: time.Now().UTC().Add(time.Duration(hours) * time.Hour),
	})
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "an active invitation already exists for this email", http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrUnauthorized) {
		http.Error(w, "invitation creator is not a member of this tenant", http.StatusForbidden)
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "tenant not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, store.ErrInvalidInput) {
		http.Error(w, "invalid invitation", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, "failed to create invitation", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSONStatus(w, http.StatusCreated, created)
}

func (s *Server) listTenantInvitations(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant invitations unavailable") {
		return
	}
	backend, ok := invitationStore(s, w)
	if !ok {
		return
	}
	items, err := backend.ListTenantInvitations(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to list invitations", http.StatusInternalServerError)
		return
	}
	writeJSON(w, items)
}

func (s *Server) revokeTenantInvitation(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant invitations unavailable") {
		return
	}
	backend, ok := invitationStore(s, w)
	if !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" || len(id) > 128 {
		http.Error(w, "invalid invitation id", http.StatusBadRequest)
		return
	}
	err := backend.RevokeTenantInvitation(r.Context(), tenantIDFrom(r), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to revoke invitation", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
