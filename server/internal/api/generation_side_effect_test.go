package api

import (
	"testing"
	"time"
)

func TestGenerationExternalSideEffectLockSerializesWaiters(t *testing.T) {
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	t.Cleanup(server.Close)
	releaseFirst := server.acquireGenerationExternalSideEffectLock("tenant-a", "job-a")
	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		releaseSecond := server.acquireGenerationExternalSideEffectLock("tenant-a", "job-a")
		close(started)
		releaseSecond()
		close(done)
	}()
	select {
	case <-started:
		t.Fatal("external side effect lock allowed a concurrent entrant")
	case <-time.After(25 * time.Millisecond):
	}
	releaseFirst()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("external side effect lock waiter did not resume")
	}
}
