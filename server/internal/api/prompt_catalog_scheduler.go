package api

import (
	"context"
	"sort"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type promptCatalogTenantLister interface {
	ListStateTenants(context.Context, string) ([]string, error)
}

func (s *Server) startPromptCatalogScheduler() {
	if s.store == nil {
		return
	}
	s.promptSchedulerOnce.Do(func() {
		interval := s.promptSchedulerInterval
		if interval <= 0 {
			interval = time.Minute
		}
		s.promptSchedulerWG.Add(1)
		go func() {
			defer s.promptSchedulerWG.Done()
			s.scanDuePromptCatalogs(s.promptSchedulerRoot, time.Now().UTC())
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-s.promptSchedulerRoot.Done():
					return
				case now := <-ticker.C:
					s.scanDuePromptCatalogs(s.promptSchedulerRoot, now.UTC())
				}
			}
		}()
	})
}

func (s *Server) scanDuePromptCatalogs(ctx context.Context, now time.Time) {
	tenantIDs := []string{store.DefaultTenantID}
	if lister, ok := s.store.(promptCatalogTenantLister); ok {
		listed, err := lister.ListStateTenants(ctx, adminPromptCatalogStateKey)
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
		_, _ = s.runDuePromptSources(ctx, tenantID, now)
	}
}
