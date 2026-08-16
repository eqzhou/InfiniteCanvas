package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	adminPromptCatalogStateKey  = "adminPromptCatalogV1"
	maxAdminPromptBodyBytes     = 2 << 20
	maxAdminPromptEntries       = 2_000
	maxAdminPromptCASAttempts   = 8
	promptScheduleLeaseDuration = 20 * time.Minute
)

type adminPromptCategory struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
}

type adminPromptEntry struct {
	ID         string   `json:"id"`
	CategoryID string   `json:"categoryId,omitempty"`
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Tags       []string `json:"tags"`
	SourceID   string   `json:"sourceId,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
}

type adminPromptSource struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	URL                string `json:"url"`
	Format             string `json:"format"`
	Enabled            bool   `json:"enabled"`
	LastSyncAt         string `json:"lastSyncAt,omitempty"`
	LastSuccessAt      string `json:"lastSuccessAt,omitempty"`
	LastError          string `json:"lastError,omitempty"`
	ItemCount          int    `json:"itemCount,omitempty"`
	ScheduleEnabled    bool   `json:"scheduleEnabled,omitempty"`
	IntervalMinutes    int    `json:"intervalMinutes,omitempty"`
	NextRunAt          string `json:"nextRunAt,omitempty"`
	ScheduleStatus     string `json:"scheduleStatus,omitempty"`
	Revision           int64  `json:"revision"`
	ActiveRunID        string `json:"activeRunId,omitempty"`
	ScheduleLeaseID    string `json:"scheduleLeaseId,omitempty"`
	ScheduleLeaseUntil string `json:"scheduleLeaseUntil,omitempty"`
}

type adminPromptSyncRun struct {
	ID             string `json:"id"`
	SourceID       string `json:"sourceId"`
	SourceURL      string `json:"sourceUrl"`
	Status         string `json:"status"`
	StartedAt      string `json:"startedAt"`
	CompletedAt    string `json:"completedAt,omitempty"`
	ItemCount      int    `json:"itemCount"`
	Error          string `json:"error,omitempty"`
	SourceRevision int64  `json:"sourceRevision"`
}

type adminPromptCatalog struct {
	Version    int                   `json:"version"`
	Revision   int64                 `json:"revision"`
	Categories []adminPromptCategory `json:"categories"`
	Prompts    []adminPromptEntry    `json:"prompts"`
	Sources    []adminPromptSource   `json:"sources"`
	SyncRuns   []adminPromptSyncRun  `json:"syncRuns"`
}

type promptCatalogFetchFunc func(context.Context, adminPromptSource) ([]adminPromptEntry, error)

func emptyAdminPromptCatalog() adminPromptCatalog {
	return adminPromptCatalog{Version: 1, Categories: []adminPromptCategory{}, Prompts: []adminPromptEntry{}, Sources: []adminPromptSource{}, SyncRuns: []adminPromptSyncRun{}}
}

func decodeAdminPromptCatalog(raw []byte) (adminPromptCatalog, error) {
	if len(raw) == 0 {
		return emptyAdminPromptCatalog(), nil
	}
	var catalog adminPromptCatalog
	if json.Unmarshal(raw, &catalog) != nil || catalog.Version != 1 || catalog.Revision < 0 ||
		len(catalog.Categories) > 500 || len(catalog.Prompts) > 20_000 || len(catalog.Sources) > 100 || len(catalog.SyncRuns) > 1_000 {
		return adminPromptCatalog{}, store.ErrInvalidInput
	}
	if catalog.Categories == nil {
		catalog.Categories = []adminPromptCategory{}
	}
	if catalog.Prompts == nil {
		catalog.Prompts = []adminPromptEntry{}
	}
	if catalog.Sources == nil {
		catalog.Sources = []adminPromptSource{}
	}
	if catalog.SyncRuns == nil {
		catalog.SyncRuns = []adminPromptSyncRun{}
	}
	// Sources created before the format field was introduced were JSON
	// catalogs. Preserve those records instead of making a reload permanently
	// unsyncable after the Markdown-capable schema change.
	for index, source := range catalog.Sources {
		if strings.TrimSpace(source.Format) == "" {
			catalog.Sources[index].Format = "json"
		}
	}
	return catalog, nil
}

func (s *Server) loadAdminPromptCatalog(ctx context.Context, tenantID string) (adminPromptCatalog, []byte, error) {
	raw, err := s.store.GetState(ctx, tenantID, adminPromptCatalogStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return emptyAdminPromptCatalog(), nil, nil
	}
	if err != nil {
		return adminPromptCatalog{}, nil, err
	}
	catalog, err := decodeAdminPromptCatalog(raw)
	return catalog, raw, err
}

func (s *Server) updateAdminPromptCatalog(ctx context.Context, tenantID string, mutate func(*adminPromptCatalog) error) (adminPromptCatalog, error) {
	for range maxAdminPromptCASAttempts {
		catalog, expected, err := s.loadAdminPromptCatalog(ctx, tenantID)
		if err != nil {
			return adminPromptCatalog{}, err
		}
		if err := mutate(&catalog); err != nil {
			return adminPromptCatalog{}, err
		}
		catalog.Revision++
		raw, err := json.Marshal(catalog)
		if err != nil {
			return adminPromptCatalog{}, err
		}
		if len(raw) > maxStateBytes {
			return adminPromptCatalog{}, store.ErrInvalidInput
		}
		if _, err := decodeAdminPromptCatalog(raw); err != nil {
			return adminPromptCatalog{}, err
		}
		err = s.store.CompareAndSwapState(ctx, tenantID, adminPromptCatalogStateKey, expected, raw)
		if errors.Is(err, store.ErrConflict) {
			continue
		}
		if err != nil {
			return adminPromptCatalog{}, err
		}
		return catalog, nil
	}
	return adminPromptCatalog{}, store.ErrConflict
}

func cleanPromptID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !projectIDPattern.MatchString(value) {
		return "", store.ErrInvalidInput
	}
	return value, nil
}

func normalizePromptCategory(input adminPromptCategory) (adminPromptCategory, error) {
	id, err := cleanPromptID(input.ID)
	name := strings.TrimSpace(input.Name)
	if err != nil || name == "" || len(name) > 200 || input.Order < -100_000 || input.Order > 100_000 {
		return adminPromptCategory{}, store.ErrInvalidInput
	}
	return adminPromptCategory{ID: id, Name: name, Order: input.Order}, nil
}

func normalizePromptEntry(input adminPromptEntry) (adminPromptEntry, error) {
	id, err := cleanPromptID(input.ID)
	categoryID := strings.TrimSpace(input.CategoryID)
	if categoryID != "" {
		if _, categoryErr := cleanPromptID(categoryID); categoryErr != nil {
			return adminPromptEntry{}, store.ErrInvalidInput
		}
	}
	title, body := strings.TrimSpace(input.Title), strings.TrimSpace(input.Body)
	if err != nil || title == "" || len(title) > 500 || body == "" || len(body) > 100_000 || len(input.Tags) > 64 {
		return adminPromptEntry{}, store.ErrInvalidInput
	}
	tags := make([]string, 0, len(input.Tags))
	seen := map[string]struct{}{}
	for _, raw := range input.Tags {
		tag := strings.TrimSpace(raw)
		if tag == "" || len(tag) > 100 {
			return adminPromptEntry{}, store.ErrInvalidInput
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	return adminPromptEntry{ID: id, CategoryID: categoryID, Title: title, Body: body, Tags: tags}, nil
}

func normalizePromptSource(input adminPromptSource) (adminPromptSource, error) {
	id, err := cleanPromptID(input.ID)
	name := strings.TrimSpace(input.Name)
	format := strings.ToLower(strings.TrimSpace(input.Format))
	if err != nil || name == "" || len(name) > 200 || (format != "json" && format != "markdown") ||
		input.IntervalMinutes < 0 || input.IntervalMinutes > 7*24*60 || (input.ScheduleEnabled && input.IntervalMinutes < 5) {
		return adminPromptSource{}, store.ErrInvalidInput
	}
	parsed, err := validateAdminPromptSourceURL(input.URL)
	if err != nil {
		return adminPromptSource{}, store.ErrInvalidInput
	}
	return adminPromptSource{ID: id, Name: name, URL: parsed.String(), Format: format, Enabled: input.Enabled,
		ScheduleEnabled: input.ScheduleEnabled, IntervalMinutes: input.IntervalMinutes}, nil
}

func hasPromptCategory(catalog *adminPromptCatalog, id string) bool {
	if id == "" {
		return true
	}
	for _, item := range catalog.Categories {
		if item.ID == id {
			return true
		}
	}
	return false
}

func decodeAdminJSON(w http.ResponseWriter, r *http.Request, output any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(output) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return false
	}
	return true
}

func writePromptMutationError(w http.ResponseWriter, err error, failure string) {
	switch {
	case errors.Is(err, store.ErrInvalidInput):
		http.Error(w, "invalid prompt catalog input", http.StatusBadRequest)
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, store.ErrConflict):
		http.Error(w, "prompt catalog conflict", http.StatusConflict)
	default:
		http.Error(w, failure, http.StatusInternalServerError)
	}
}

func (s *Server) getPublicPromptCatalog(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, map[string]any{"version": 1, "revision": 0, "categories": []adminPromptCategory{}, "prompts": []adminPromptEntry{}})
		return
	}
	catalog, _, err := s.loadAdminPromptCatalog(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load prompt catalog", http.StatusInternalServerError)
		return
	}
	etag := fmt.Sprintf("\"prompt-catalog-%d\"", catalog.Revision)
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, map[string]any{"version": catalog.Version, "revision": catalog.Revision, "categories": catalog.Categories, "prompts": catalog.Prompts})
}

func (s *Server) getAdminPromptCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	catalog, _, err := s.loadAdminPromptCatalog(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load prompt catalog", http.StatusInternalServerError)
		return
	}
	writeJSON(w, catalog)
}

func (s *Server) createAdminPromptCategory(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	var input adminPromptCategory
	if !decodeAdminJSON(w, r, &input) {
		return
	}
	item, err := normalizePromptCategory(input)
	if err != nil {
		writePromptMutationError(w, err, "failed to create prompt category")
		return
	}
	catalog, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		for _, existing := range c.Categories {
			if existing.ID == item.ID {
				return store.ErrConflict
			}
		}
		c.Categories = append(c.Categories, item)
		sort.SliceStable(c.Categories, func(i, j int) bool { return c.Categories[i].Order < c.Categories[j].Order })
		return nil
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to create prompt category")
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, catalog)
}

func (s *Server) putAdminPromptCategory(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	var input adminPromptCategory
	if !decodeAdminJSON(w, r, &input) {
		return
	}
	input.ID = chi.URLParam(r, "id")
	item, err := normalizePromptCategory(input)
	if err != nil {
		writePromptMutationError(w, err, "failed to update prompt category")
		return
	}
	catalog, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		for i := range c.Categories {
			if c.Categories[i].ID == item.ID {
				c.Categories[i] = item
				return nil
			}
		}
		return store.ErrNotFound
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to update prompt category")
		return
	}
	writeJSON(w, catalog)
}

func (s *Server) deleteAdminPromptCategory(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	id := chi.URLParam(r, "id")
	_, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		for _, prompt := range c.Prompts {
			if prompt.CategoryID == id {
				return store.ErrConflict
			}
		}
		for i, item := range c.Categories {
			if item.ID == id {
				c.Categories = append(c.Categories[:i:i], c.Categories[i+1:]...)
				return nil
			}
		}
		return store.ErrNotFound
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to delete prompt category")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createAdminPrompt(w http.ResponseWriter, r *http.Request) {
	s.upsertAdminPrompt(w, r, true)
}
func (s *Server) putAdminPrompt(w http.ResponseWriter, r *http.Request) {
	s.upsertAdminPrompt(w, r, false)
}
func (s *Server) upsertAdminPrompt(w http.ResponseWriter, r *http.Request, create bool) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	var input adminPromptEntry
	if !decodeAdminJSON(w, r, &input) {
		return
	}
	if !create {
		input.ID = chi.URLParam(r, "id")
	}
	item, err := normalizePromptEntry(input)
	if err != nil {
		writePromptMutationError(w, err, "failed to save prompt")
		return
	}
	item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	catalog, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		if !hasPromptCategory(c, item.CategoryID) {
			return store.ErrInvalidInput
		}
		for i, existing := range c.Prompts {
			if existing.ID == item.ID {
				if create {
					return store.ErrConflict
				}
				if existing.SourceID != "" {
					return store.ErrConflict
				}
				c.Prompts[i] = item
				return nil
			}
		}
		if !create {
			return store.ErrNotFound
		}
		c.Prompts = append(c.Prompts, item)
		return nil
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to save prompt")
		return
	}
	if create {
		w.WriteHeader(http.StatusCreated)
	}
	writeJSON(w, catalog)
}

func (s *Server) bulkDeleteAdminPrompts(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt catalog unavailable") {
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	if len(body.IDs) == 0 || len(body.IDs) > 500 {
		http.Error(w, "invalid prompt ids", 400)
		return
	}
	ids := map[string]struct{}{}
	for _, raw := range body.IDs {
		id, err := cleanPromptID(raw)
		if err != nil {
			http.Error(w, "invalid prompt ids", 400)
			return
		}
		ids[id] = struct{}{}
	}
	catalog, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		next := make([]adminPromptEntry, 0, len(c.Prompts))
		for _, item := range c.Prompts {
			if _, ok := ids[item.ID]; !ok {
				next = append(next, item)
			}
		}
		c.Prompts = next
		return nil
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to delete prompts")
		return
	}
	writeJSON(w, catalog)
}

func (s *Server) createAdminPromptSource(w http.ResponseWriter, r *http.Request) {
	s.upsertAdminPromptSource(w, r, true)
}
func (s *Server) putAdminPromptSource(w http.ResponseWriter, r *http.Request) {
	s.upsertAdminPromptSource(w, r, false)
}
func (s *Server) upsertAdminPromptSource(w http.ResponseWriter, r *http.Request, create bool) {
	if !s.requireTenantOwner(w, r, "tenant prompt sources unavailable") {
		return
	}
	var input adminPromptSource
	if !decodeAdminJSON(w, r, &input) {
		return
	}
	if !create {
		input.ID = chi.URLParam(r, "id")
	}
	item, err := normalizePromptSource(input)
	if err != nil {
		writePromptMutationError(w, err, "failed to save prompt source")
		return
	}
	scheduleNow := time.Now().UTC()
	catalog, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		for i, existing := range c.Sources {
			if existing.ID == item.ID {
				if create {
					return store.ErrConflict
				}
				if hasActivePromptScheduleLease(existing, scheduleNow) {
					return store.ErrConflict
				}
				item.LastSyncAt = existing.LastSyncAt
				item.LastSuccessAt = existing.LastSuccessAt
				item.LastError = existing.LastError
				item.ItemCount = existing.ItemCount
				item.Revision = existing.Revision + 1
				if item.ScheduleEnabled {
					if existing.ScheduleEnabled && existing.IntervalMinutes == item.IntervalMinutes && existing.NextRunAt != "" {
						item.NextRunAt = existing.NextRunAt
					} else {
						item.NextRunAt = scheduleNow.Add(time.Duration(item.IntervalMinutes) * time.Minute).Format(time.RFC3339Nano)
					}
					item.ScheduleStatus = existing.ScheduleStatus
					if item.ScheduleStatus == "" {
						item.ScheduleStatus = "scheduled"
					}
				} else {
					item.NextRunAt = ""
					item.ScheduleStatus = "disabled"
				}
				c.Sources[i] = item
				return nil
			}
		}
		if !create {
			return store.ErrNotFound
		}
		if item.ScheduleEnabled {
			item.NextRunAt = scheduleNow.Add(time.Duration(item.IntervalMinutes) * time.Minute).Format(time.RFC3339Nano)
			item.ScheduleStatus = "scheduled"
		} else {
			item.ScheduleStatus = "disabled"
		}
		item.Revision = 1
		c.Sources = append(c.Sources, item)
		return nil
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to save prompt source")
		return
	}
	if create {
		w.WriteHeader(http.StatusCreated)
	}
	writeJSON(w, catalog)
}

func (s *Server) deleteAdminPromptSource(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt sources unavailable") {
		return
	}
	id := chi.URLParam(r, "id")
	now := time.Now().UTC()
	_, err := s.updateAdminPromptCatalog(r.Context(), tenantIDFrom(r), func(c *adminPromptCatalog) error {
		for i, item := range c.Sources {
			if item.ID == id {
				if hasActivePromptScheduleLease(item, now) {
					return store.ErrConflict
				}
				c.Sources = append(c.Sources[:i:i], c.Sources[i+1:]...)
				next := make([]adminPromptEntry, 0, len(c.Prompts))
				for _, prompt := range c.Prompts {
					if prompt.SourceID != id {
						next = append(next, prompt)
					}
				}
				c.Prompts = next
				return nil
			}
		}
		return store.ErrNotFound
	})
	if err != nil {
		writePromptMutationError(w, err, "failed to delete prompt source")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) syncAdminPromptSource(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt sync unavailable") {
		return
	}
	run, err := s.runAdminPromptSourceSync(r.Context(), tenantIDFrom(r), chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "not found", 404)
		} else {
			http.Error(w, "prompt source sync failed", http.StatusBadGateway)
		}
		return
	}
	writeJSON(w, run)
}

func (s *Server) syncAllAdminPromptSources(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt sync unavailable") {
		return
	}
	catalog, _, err := s.loadAdminPromptCatalog(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load prompt sources", http.StatusInternalServerError)
		return
	}
	runs := make([]adminPromptSyncRun, 0, len(catalog.Sources))
	failed := false
	for _, source := range catalog.Sources {
		if !source.Enabled {
			continue
		}
		run, syncErr := s.runAdminPromptSourceSync(r.Context(), tenantIDFrom(r), source.ID)
		if run.ID != "" {
			runs = append(runs, run)
		}
		if syncErr != nil {
			failed = true
		}
	}
	if failed {
		w.WriteHeader(http.StatusMultiStatus)
	}
	writeJSON(w, runs)
}

func (s *Server) runDueAdminPromptSources(w http.ResponseWriter, r *http.Request) {
	if !s.requireTenantOwner(w, r, "tenant prompt scheduler unavailable") {
		return
	}
	runs, err := s.runDuePromptSources(r.Context(), tenantIDFrom(r), time.Now().UTC())
	if err != nil {
		http.Error(w, "failed to run due prompt sources", http.StatusInternalServerError)
		return
	}
	writeJSON(w, runs)
}

func (s *Server) runDuePromptSources(ctx context.Context, tenantID string, now time.Time) ([]adminPromptSyncRun, error) {
	type claimedSource struct {
		source  adminPromptSource
		leaseID string
	}
	due := make([]claimedSource, 0)
	_, err := s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
		due = due[:0]
		for _, source := range c.Sources {
			if !source.Enabled || !source.ScheduleEnabled || source.IntervalMinutes < 5 {
				continue
			}
			leaseUntil, leaseErr := time.Parse(time.RFC3339Nano, source.ScheduleLeaseUntil)
			if source.ScheduleLeaseID != "" && leaseErr == nil && leaseUntil.After(now) {
				continue
			}
			next, parseErr := time.Parse(time.RFC3339Nano, source.NextRunAt)
			if source.NextRunAt == "" || parseErr != nil || !next.After(now) {
				due = append(due, claimedSource{source: source, leaseID: randomGenerationOwner()})
			}
		}
		sort.Slice(due, func(i, j int) bool { return due[i].source.ID < due[j].source.ID })
		if len(due) > 20 {
			due = due[:20]
		}
		claimed := make(map[string]string, len(due))
		for _, item := range due {
			claimed[item.source.ID] = item.leaseID
		}
		// Lease expiry is a wall-clock concept: it exists so another instance can
		// reclaim a source after this process dies, and every other lease check
		// (HTTP mutations, the sync runner) compares against time.Now(). Deriving
		// it from the injected schedule clock would mark a freshly claimed lease
		// as already expired and silently drop every scheduled sync.
		leaseUntil := time.Now().UTC().Add(promptScheduleLeaseDuration).Format(time.RFC3339Nano)
		for i := range c.Sources {
			leaseID, ok := claimed[c.Sources[i].ID]
			if !ok {
				continue
			}
			c.Sources[i].ScheduleStatus = "running"
			c.Sources[i].ScheduleLeaseID = leaseID
			c.Sources[i].ScheduleLeaseUntil = leaseUntil
			c.Sources[i].NextRunAt = now.Add(time.Duration(c.Sources[i].IntervalMinutes) * time.Minute).Format(time.RFC3339Nano)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	runs := make([]adminPromptSyncRun, 0, len(due))
	for _, claimed := range due {
		run, syncErr := s.runClaimedAdminPromptSourceSync(ctx, tenantID, claimed.source, claimed.leaseID)
		if run.ID != "" {
			runs = append(runs, run)
		}
		status := "succeeded"
		if syncErr != nil {
			status = "failed"
		}
		_, updateErr := s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
			for i := range c.Sources {
				if c.Sources[i].ID == claimed.source.ID && c.Sources[i].ScheduleLeaseID == claimed.leaseID {
					c.Sources[i].ScheduleStatus = status
					c.Sources[i].ScheduleLeaseID = ""
					c.Sources[i].ScheduleLeaseUntil = ""
					return nil
				}
			}
			return nil
		})
		if updateErr != nil {
			return runs, updateErr
		}
	}
	return runs, nil
}

func (s *Server) runAdminPromptSourceSync(ctx context.Context, tenantID, sourceID string) (adminPromptSyncRun, error) {
	catalog, _, err := s.loadAdminPromptCatalog(ctx, tenantID)
	if err != nil {
		return adminPromptSyncRun{}, err
	}
	var source adminPromptSource
	found := false
	for _, item := range catalog.Sources {
		if item.ID == sourceID {
			source = item
			found = true
			break
		}
	}
	if !found {
		return adminPromptSyncRun{}, store.ErrNotFound
	}
	if !source.Enabled {
		return adminPromptSyncRun{}, store.ErrInvalidInput
	}
	return s.runClaimedAdminPromptSourceSync(ctx, tenantID, source, "")
}

func hasActivePromptScheduleLease(source adminPromptSource, now time.Time) bool {
	if source.ScheduleLeaseID == "" {
		return false
	}
	leaseUntil, err := time.Parse(time.RFC3339Nano, source.ScheduleLeaseUntil)
	return err == nil && leaseUntil.After(now)
}

func (s *Server) runClaimedAdminPromptSourceSync(ctx context.Context, tenantID string, source adminPromptSource, scheduleLeaseID string) (adminPromptSyncRun, error) {
	now := time.Now().UTC()
	run := adminPromptSyncRun{ID: randomGenerationOwner(), SourceID: source.ID, SourceURL: source.URL, SourceRevision: source.Revision, Status: "running", StartedAt: now.Format(time.RFC3339Nano)}
	_, err := s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
		sourceIndex := -1
		for i := range c.Sources {
			if c.Sources[i].ID == source.ID {
				sourceIndex = i
				break
			}
		}
		if sourceIndex < 0 || c.Sources[sourceIndex].Revision != source.Revision || c.Sources[sourceIndex].URL != source.URL || !c.Sources[sourceIndex].Enabled {
			return store.ErrConflict
		}
		current := c.Sources[sourceIndex]
		if scheduleLeaseID != "" {
			if current.ScheduleLeaseID != scheduleLeaseID || !hasActivePromptScheduleLease(current, now) {
				return store.ErrConflict
			}
		} else if hasActivePromptScheduleLease(current, now) {
			return store.ErrConflict
		}
		if active := c.Sources[sourceIndex].ActiveRunID; active != "" {
			for i := range c.SyncRuns {
				if c.SyncRuns[i].ID != active || c.SyncRuns[i].Status != "running" {
					continue
				}
				started, parseErr := time.Parse(time.RFC3339Nano, c.SyncRuns[i].StartedAt)
				if parseErr == nil && started.After(now.Add(-15*time.Minute)) {
					return store.ErrConflict
				}
				c.SyncRuns[i].Status = "failed"
				c.SyncRuns[i].CompletedAt = now.Format(time.RFC3339Nano)
				c.SyncRuns[i].Error = "prompt source sync lease expired"
			}
		}
		c.Sources[sourceIndex].ActiveRunID = run.ID
		c.SyncRuns = append(c.SyncRuns, run)
		if len(c.SyncRuns) > 1000 {
			c.SyncRuns = append([]adminPromptSyncRun(nil), c.SyncRuns[len(c.SyncRuns)-1000:]...)
		}
		return nil
	})
	if err != nil {
		return adminPromptSyncRun{}, err
	}
	fetcher := s.promptCatalogFetcher
	if fetcher == nil {
		fetcher = fetchAdminPromptCatalog
	}
	items, fetchErr := fetcher(ctx, source)
	completed := time.Now().UTC().Format(time.RFC3339Nano)
	if fetchErr != nil {
		message := "prompt source request failed"
		updated, updateErr := s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
			for i := range c.SyncRuns {
				if c.SyncRuns[i].ID == run.ID {
					c.SyncRuns[i].Status = "failed"
					c.SyncRuns[i].CompletedAt = completed
					c.SyncRuns[i].Error = message
					run = c.SyncRuns[i]
				}
			}
			for i := range c.Sources {
				if c.Sources[i].ID == source.ID && c.Sources[i].Revision == source.Revision && c.Sources[i].ActiveRunID == run.ID {
					c.Sources[i].LastSyncAt = completed
					c.Sources[i].LastError = message
					c.Sources[i].ActiveRunID = ""
				}
			}
			return nil
		})
		_ = updated
		if updateErr != nil {
			return adminPromptSyncRun{}, updateErr
		}
		return run, fetchErr
	}
	normalized := make([]adminPromptEntry, 0, len(items))
	seen := map[string]struct{}{}
	for _, input := range items {
		item, normalizeErr := normalizePromptEntry(input)
		if normalizeErr != nil {
			return s.failAdminPromptRun(ctx, tenantID, source, run, completed, "prompt source returned invalid items", normalizeErr)
		}
		remoteID := item.ID
		if _, ok := seen[remoteID]; ok {
			return s.failAdminPromptRun(ctx, tenantID, source, run, completed, "prompt source returned duplicate ids", store.ErrInvalidInput)
		}
		seen[remoteID] = struct{}{}
		hash := sha256.Sum256([]byte(source.ID + "\x00" + remoteID))
		item.ID = fmt.Sprintf("sync_%x", hash[:16])
		item.SourceID = source.ID
		item.UpdatedAt = completed
		normalized = append(normalized, item)
	}
	_, err = s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
		sourceIndex := -1
		for i, current := range c.Sources {
			if current.ID == source.ID {
				sourceIndex = i
				break
			}
		}
		if sourceIndex < 0 || c.Sources[sourceIndex].Revision != source.Revision || c.Sources[sourceIndex].ActiveRunID != run.ID || c.Sources[sourceIndex].URL != source.URL || !c.Sources[sourceIndex].Enabled {
			return store.ErrConflict
		}
		for _, item := range normalized {
			if !hasPromptCategory(c, item.CategoryID) {
				return store.ErrInvalidInput
			}
		}
		next := make([]adminPromptEntry, 0, len(c.Prompts)+len(normalized))
		for _, item := range c.Prompts {
			if item.SourceID != source.ID {
				next = append(next, item)
			}
		}
		c.Prompts = append(next, normalized...)
		c.Sources[sourceIndex].LastSyncAt = completed
		c.Sources[sourceIndex].LastSuccessAt = completed
		c.Sources[sourceIndex].LastError = ""
		c.Sources[sourceIndex].ItemCount = len(normalized)
		c.Sources[sourceIndex].ActiveRunID = ""
		for i := range c.SyncRuns {
			if c.SyncRuns[i].ID == run.ID {
				c.SyncRuns[i].Status = "succeeded"
				c.SyncRuns[i].CompletedAt = completed
				c.SyncRuns[i].ItemCount = len(normalized)
				run = c.SyncRuns[i]
			}
		}
		return nil
	})
	if err != nil {
		return s.failAdminPromptRun(ctx, tenantID, source, run, completed, "prompt source publish failed", err)
	}
	return run, nil
}

func (s *Server) failAdminPromptRun(ctx context.Context, tenantID string, source adminPromptSource, run adminPromptSyncRun, completed, message string, cause error) (adminPromptSyncRun, error) {
	_, updateErr := s.updateAdminPromptCatalog(ctx, tenantID, func(c *adminPromptCatalog) error {
		for i := range c.SyncRuns {
			if c.SyncRuns[i].ID == run.ID {
				c.SyncRuns[i].Status = "failed"
				c.SyncRuns[i].CompletedAt = completed
				c.SyncRuns[i].Error = message
				run = c.SyncRuns[i]
			}
		}
		for i := range c.Sources {
			if c.Sources[i].ID == source.ID && c.Sources[i].Revision == source.Revision && c.Sources[i].ActiveRunID == run.ID {
				c.Sources[i].LastSyncAt = completed
				c.Sources[i].LastError = message
				c.Sources[i].ActiveRunID = ""
			}
		}
		return nil
	})
	if updateErr != nil {
		return adminPromptSyncRun{}, updateErr
	}
	return run, cause
}
