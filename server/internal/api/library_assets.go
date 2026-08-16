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

func (s *Server) requireLibraryAdmin(w http.ResponseWriter, r *http.Request) bool {
	return s.requireTenantOwner(w, r, "tenant library unavailable")
}

func (s *Server) listLibraryAssets(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "library unavailable", http.StatusServiceUnavailable)
		return
	}
	q := store.LibraryAssetQuery{
		Q:    strings.TrimSpace(r.URL.Query().Get("q")),
		Kind: strings.TrimSpace(r.URL.Query().Get("kind")),
		Tag:  strings.TrimSpace(r.URL.Query().Get("tag")),
	}
	if page, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil {
		q.Page = page
	}
	if pageSize, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil {
		q.PageSize = pageSize
	}
	result, err := s.store.ListLibraryAssets(r.Context(), tenantIDFrom(r), q)
	if err != nil {
		http.Error(w, "failed to list library assets", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

func (s *Server) getLibraryAsset(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "library unavailable", http.StatusServiceUnavailable)
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	asset, err := s.store.GetLibraryAsset(r.Context(), tenantIDFrom(r), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to load library asset", http.StatusInternalServerError)
		return
	}
	writeJSON(w, asset)
}

func decodeLibraryAssetBody(w http.ResponseWriter, r *http.Request) (store.LibraryAsset, error) {
	var asset store.LibraryAsset
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&asset); err != nil {
		return store.LibraryAsset{}, err
	}
	return asset, nil
}

func (s *Server) createLibraryAsset(w http.ResponseWriter, r *http.Request) {
	if !s.requireLibraryAdmin(w, r) {
		return
	}
	asset, err := decodeLibraryAssetBody(w, r)
	if err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	created, err := s.store.CreateLibraryAsset(r.Context(), tenantIDFrom(r), asset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, created)
}

func (s *Server) updateLibraryAsset(w http.ResponseWriter, r *http.Request) {
	if !s.requireLibraryAdmin(w, r) {
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	asset, err := decodeLibraryAssetBody(w, r)
	if err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	asset.ID = id
	updated, err := s.store.UpdateLibraryAsset(r.Context(), tenantIDFrom(r), asset)
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

func (s *Server) deleteLibraryAsset(w http.ResponseWriter, r *http.Request) {
	if !s.requireLibraryAdmin(w, r) {
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	err := s.store.DeleteLibraryAsset(r.Context(), tenantIDFrom(r), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to delete library asset", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
