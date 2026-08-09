package api

import (
	"context"
	"time"
)

const maxFilmQualityChecksPerTenantMinute = 10

func (s *Server) acquireFilmQualityCheck(ctx context.Context, tenantID string) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case s.filmQualityGlobal <- struct{}{}:
	default:
		return nil, errFilmQualityBusy
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	s.filmQualityMu.Lock()
	starts := s.filmQualityStarts[tenantID]
	kept := starts[:0]
	for _, started := range starts {
		if started.After(cutoff) {
			kept = append(kept, started)
		}
	}
	if s.filmTenantQuality[tenantID] >= 1 || len(kept) >= maxFilmQualityChecksPerTenantMinute {
		s.filmQualityStarts[tenantID] = kept
		s.filmQualityMu.Unlock()
		<-s.filmQualityGlobal
		return nil, errFilmQualityBusy
	}
	s.filmTenantQuality[tenantID]++
	s.filmQualityStarts[tenantID] = append(kept, now)
	s.filmQualityMu.Unlock()
	return func() {
		s.filmQualityMu.Lock()
		if s.filmTenantQuality[tenantID] <= 1 {
			delete(s.filmTenantQuality, tenantID)
		} else {
			s.filmTenantQuality[tenantID]--
		}
		s.filmQualityMu.Unlock()
		<-s.filmQualityGlobal
	}, nil
}
