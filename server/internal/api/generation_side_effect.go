package api

import (
	"context"
	"sync"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

// generationExternalSideEffectLock closes the local cancellation window around
// provider calls. Cancellation waits for an already-started call; a caller
// that wins first makes the worker observe the canceled job before the call.
type generationExternalSideEffectLock struct {
	mu   sync.Mutex
	refs int
}

func (s *Server) acquireGenerationExternalSideEffectLock(tenantID, jobID string) func() {
	key := tenantID + "\x00" + jobID
	s.externalJobMu.Lock()
	entry := s.externalJobLocks[key]
	if entry == nil {
		entry = &generationExternalSideEffectLock{}
		s.externalJobLocks[key] = entry
	}
	entry.refs++
	s.externalJobMu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		s.externalJobMu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(s.externalJobLocks, key)
		}
		s.externalJobMu.Unlock()
	}
}

func (s *Server) cancelServerGenerationJobWithSideEffectLock(ctx context.Context, tenantID, jobID string, now time.Time) (store.GenerationJob, error) {
	release := s.acquireGenerationExternalSideEffectLock(tenantID, jobID)
	defer release()
	job, err := s.store.CancelServerGenerationJob(ctx, tenantID, jobID, now)
	if err == nil {
		s.cancelLocalGeneration(tenantID, jobID)
	}
	return job, err
}
