package api

import (
	"context"
	"time"
)

const maxFilmImportsPerTenantMinute = 10

func (s *Server) acquireFilmImport(ctx context.Context, tenantID string) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case s.filmImportGlobal <- struct{}{}:
	default:
		return nil, errFilmImportBusy
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	s.filmImportMu.Lock()
	starts := s.filmImportStarts[tenantID]
	kept := starts[:0]
	for _, started := range starts {
		if started.After(cutoff) {
			kept = append(kept, started)
		}
	}
	if s.filmTenantImports[tenantID] >= 1 || len(kept) >= maxFilmImportsPerTenantMinute {
		s.filmImportStarts[tenantID] = kept
		s.filmImportMu.Unlock()
		<-s.filmImportGlobal
		return nil, errFilmImportBusy
	}
	s.filmTenantImports[tenantID]++
	s.filmImportStarts[tenantID] = append(kept, now)
	s.filmImportMu.Unlock()
	return func() {
		s.filmImportMu.Lock()
		if s.filmTenantImports[tenantID] <= 1 {
			delete(s.filmTenantImports, tenantID)
		} else {
			s.filmTenantImports[tenantID]--
		}
		s.filmImportMu.Unlock()
		<-s.filmImportGlobal
	}, nil
}
