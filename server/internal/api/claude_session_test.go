package api

import (
	"sync"
	"testing"
	"time"
)

func TestClaudeSubscribeUnsubscribeDoesNotDoubleClose(t *testing.T) {
	session := &claudeSession{
		id:   "claude-test",
		subs: make(map[*claudeSub]struct{}),
	}
	ch, unsubscribe := session.subscribeAfter(0)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		unsubscribe()
	}()
	go func() {
		defer wg.Done()
		session.close()
	}()
	wg.Wait()

	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("expected channel closed after teardown")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for closed channel")
	}

	// Calling both paths again must stay panic-free.
	unsubscribe()
	session.close()
}

func TestClaudePermissionModeEnv(t *testing.T) {
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "")
	if got := claudePermissionMode(); got != "acceptEdits" {
		t.Fatalf("default=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "plan")
	if got := claudePermissionMode(); got != "plan" {
		t.Fatalf("plan=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "nope")
	if got := claudePermissionMode(); got != "acceptEdits" {
		t.Fatalf("invalid fallback=%q", got)
	}
}
