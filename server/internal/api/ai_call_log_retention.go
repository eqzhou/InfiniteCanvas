package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const (
	aiCallLogRetentionStateKey = "aiCallLogRetention"
	maxAICallLogRetentionDays  = 3650
)

// aiCallLogRetentionPolicy controls automatic pruning of the AI call audit log.
// Retention is opt-in: an unset policy keeps every row, so no deployment loses
// audit history by accident.
type aiCallLogRetentionPolicy struct {
	Enabled       bool `json:"enabled"`
	RetentionDays int  `json:"retentionDays"`
}

func (s *Server) loadAICallLogRetention(ctx context.Context, tenantID string) (aiCallLogRetentionPolicy, error) {
	var policy aiCallLogRetentionPolicy
	if s == nil || s.store == nil {
		return policy, nil
	}
	raw, err := s.store.GetState(ctx, tenantID, aiCallLogRetentionStateKey)
	if errors.Is(err, store.ErrNotFound) || len(raw) == 0 {
		return policy, nil
	}
	if err != nil {
		return policy, err
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		// A malformed policy must not enable deletion.
		return aiCallLogRetentionPolicy{}, nil
	}
	return policy, nil
}

func (s *Server) saveAICallLogRetention(ctx context.Context, tenantID string, policy aiCallLogRetentionPolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return s.store.PutState(ctx, tenantID, aiCallLogRetentionStateKey, raw)
}

func (s *Server) getAICallLogRetention(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	policy, err := s.loadAICallLogRetention(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load retention policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, policy)
}

func (s *Server) putAICallLogRetention(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	var body aiCallLogRetentionPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Enabled && (body.RetentionDays < 1 || body.RetentionDays > maxAICallLogRetentionDays) {
		http.Error(w, "retentionDays must be between 1 and 3650", http.StatusBadRequest)
		return
	}
	if !body.Enabled {
		body.RetentionDays = 0
	}
	if err := s.saveAICallLogRetention(r.Context(), tenantIDFrom(r), body); err != nil {
		http.Error(w, "failed to save retention policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, body)
}

// sweepAICallLogRetention deletes rows older than the configured window and
// reports how many were removed. A disabled or malformed policy deletes nothing.
func (s *Server) sweepAICallLogRetention(ctx context.Context, tenantID string, now time.Time) int64 {
	if s == nil || s.store == nil {
		return 0
	}
	policy, err := s.loadAICallLogRetention(ctx, tenantID)
	if err != nil || !policy.Enabled || policy.RetentionDays < 1 || policy.RetentionDays > maxAICallLogRetentionDays {
		return 0
	}
	deleted, err := s.store.DeleteAICallLogsBefore(ctx, tenantID, now.UTC().AddDate(0, 0, -policy.RetentionDays))
	if err != nil {
		log.Printf("ai call log retention sweep failed for tenant %s: %v", tenantID, err)
		return 0
	}
	return deleted
}

// startAICallLogRetentionScheduler reuses the prompt scheduler lifecycle so the
// sweep stops cleanly with the server.

const (
	aiCallLogClientReportStateKey = "aiCallLogClientReport"
)

// aiCallLogClientReportPolicy is the admin switch for browser direct-connect
// audit uploads. Off by default so local key traffic is never logged until an
// administrator opts in.
type aiCallLogClientReportPolicy struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) loadAICallLogClientReport(ctx context.Context, tenantID string) (aiCallLogClientReportPolicy, error) {
	var policy aiCallLogClientReportPolicy
	if s == nil || s.store == nil {
		return policy, nil
	}
	raw, err := s.store.GetState(ctx, tenantID, aiCallLogClientReportStateKey)
	if errors.Is(err, store.ErrNotFound) || len(raw) == 0 {
		return policy, nil
	}
	if err != nil {
		return policy, err
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return aiCallLogClientReportPolicy{}, nil
	}
	return policy, nil
}

func (s *Server) saveAICallLogClientReport(ctx context.Context, tenantID string, policy aiCallLogClientReportPolicy) error {
	if s == nil || s.store == nil {
		return errors.New("store unavailable")
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return s.store.PutState(ctx, tenantID, aiCallLogClientReportStateKey, raw)
}

func (s *Server) getAICallLogClientReport(w http.ResponseWriter, r *http.Request) {
	// Readable by any authenticated caller so the browser knows whether to upload.
	// When auth is off, the process-token bootstrap path still works via authorizeSecrets-like optional access.
	if authMode() != "off" {
		if _, ok := authUserFrom(r.Context()); !ok {
			// Guests/anonymous: treat as disabled without leaking admin config.
			writeJSON(w, aiCallLogClientReportPolicy{Enabled: false})
			return
		}
	}
	policy, err := s.loadAICallLogClientReport(r.Context(), tenantIDFrom(r))
	if err != nil {
		http.Error(w, "failed to load client report policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, policy)
}

func (s *Server) putAICallLogClientReport(w http.ResponseWriter, r *http.Request) {
	if !s.requireAICallLogAdmin(w, r) {
		return
	}
	var body aiCallLogClientReportPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.saveAICallLogClientReport(r.Context(), tenantIDFrom(r), body); err != nil {
		http.Error(w, "failed to save client report policy", http.StatusInternalServerError)
		return
	}
	writeJSON(w, body)
}

func (s *Server) startAICallLogRetentionScheduler() {
	if s.store == nil {
		return
	}
	s.logRetentionOnce.Do(func() {
		interval := s.logRetentionInterval
		if interval <= 0 {
			interval = time.Hour
		}
		s.promptSchedulerWG.Add(1)
		go func() {
			defer s.promptSchedulerWG.Done()
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-s.promptSchedulerRoot.Done():
					return
				case now := <-ticker.C:
					s.sweepAllAICallLogRetention(s.promptSchedulerRoot, now.UTC())
					// Expired provider-facing media tokens are otherwise only
					// dropped lazily when someone happens to read them.
					s.sweepExpiredMediaReferences(s.promptSchedulerRoot, now.UTC())
					// Delete markers guard against resurrection writes, but they
					// only need to outlive stale clients, not live forever.
					s.sweepExpiredTombstones(s.promptSchedulerRoot, now.UTC())
				}
			}
		}()
	})
}

func (s *Server) sweepAllAICallLogRetention(ctx context.Context, now time.Time) {
	tenantIDs := []string{store.DefaultTenantID}
	if lister, ok := s.store.(promptCatalogTenantLister); ok {
		listed, err := lister.ListStateTenants(ctx, aiCallLogRetentionStateKey)
		if err != nil || ctx.Err() != nil {
			return
		}
		tenantIDs = listed
	}
	sort.Strings(tenantIDs)
	for _, tenantID := range tenantIDs {
		if ctx.Err() != nil {
			return
		}
		s.sweepAICallLogRetention(ctx, tenantID, now)
	}
}
