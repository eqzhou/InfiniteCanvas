package api

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestClosedClaudeSessionCannotStartDelayedTurn(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	bin := filepath.Join(t.TempDir(), "fake-claude.sh")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ntouch \""+marker+"\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CLAUDE_BIN", bin)
	session := &claudeSession{closed: true, running: true, subs: make(map[*claudeSub]struct{})}
	session.runTurn("must not run")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("closed session started a delayed process: %v", err)
	}
}

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
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "")
	if got := claudePermissionMode(); got != "default" {
		t.Fatalf("default=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "plan")
	if got := claudePermissionMode(); got != "plan" {
		t.Fatalf("plan=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "nope")
	if got := claudePermissionMode(); got != "default" {
		t.Fatalf("invalid fallback=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "bypassPermissions")
	if got := claudePermissionMode(); got != "default" {
		t.Fatalf("bypass fallback=%q", got)
	}
	t.Setenv("OPENBOARD_CLAUDE_PERMISSION_MODE", "acceptEdits")
	if got := claudePermissionMode(); got != "default" {
		t.Fatalf("authenticated acceptEdits=%q", got)
	}
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	if got := claudePermissionMode(); got != "acceptEdits" {
		t.Fatalf("local acceptEdits=%q", got)
	}
}
