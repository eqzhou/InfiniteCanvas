package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexSessionWithFakeAppServer(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-codex.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' ;;
    thread/start) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-test"}}}' ;;
    turn/start) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'; printf '%s\n' '{"jsonrpc":"2.0","method":"agent_message_delta","params":{"delta":"hello"}}'; printf '%s\n' '{"jsonrpc":"2.0","id":"approval-1","method":"item/tool/call","params":{"tool":"board.add_node"}}' ;;
  esac
done
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_BIN", bin)
	session, err := startCodexSession(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()

	if session.threadID != "thread-test" {
		t.Fatalf("thread id = %q", session.threadID)
	}
	if err := session.client.Call(context.Background(), "turn/start", map[string]any{"threadId": session.threadID}, nil); err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	deadline := time.After(2 * time.Second)
	var gotNotification, gotRequest bool
	for !(gotNotification && gotRequest) {
		select {
		case event := <-events:
			gotNotification = gotNotification || (event.Type == "notification" && event.Method == "agent_message_delta")
			gotRequest = gotRequest || (event.Type == "approval" && event.Method == "item/tool/call" && string(event.ID) == `"approval-1"`)
		case <-deadline:
			t.Fatal("timed out waiting for fake app-server events")
		}
	}
	if err := session.client.Respond(context.Background(), json.RawMessage(`"approval-1"`), map[string]any{"decision": "approve"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestCodexSessionReplaysBoundedHistoryToNewSubscribers(t *testing.T) {

	session := &codexSession{subs: make(map[chan codexEvent]struct{})}
	for i := 0; i < 140; i++ {
		session.publish(codexEvent{Type: "notification", Method: "event", Params: json.RawMessage(`{"n":1}`)})
	}
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	count := 0
	for {
		select {
		case <-events:
			count++
		default:
			if count != 128 {
				t.Fatalf("replayed event count = %d, want 128", count)
			}
			return
		}
	}
}

func TestCodexTurnCompletionCleansActiveAttachments(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "image.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	session := &codexSession{
		subs:               make(map[chan codexEvent]struct{}),
		pendingAttachments: make(map[string]codexAttachment),
		activeAttachments:  []codexAttachment{{ID: "image-1", Path: path}},
		turnID:             "turn-1",
	}
	session.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-1"}}`))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("completed attachment still exists: %v", err)
	}
	if session.turnID != "" || len(session.activeAttachments) != 0 {
		t.Fatal("completed turn state was not cleared")
	}
}

func TestCodexDelayedCompletionDoesNotClearNewTurn(t *testing.T) {
	session := &codexSession{
		subs:               make(map[chan codexEvent]struct{}),
		pendingAttachments: make(map[string]codexAttachment),
		turnID:             "turn-new",
	}
	session.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-old"}}`))
	if session.turnID != "turn-new" {
		t.Fatal("a delayed completion cleared the active turn")
	}
}

func TestCodexCompletionBeforeActivationCleansAttachments(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "image.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	session := &codexSession{
		subs:               make(map[chan codexEvent]struct{}),
		pendingAttachments: make(map[string]codexAttachment),
		turnStarting:       true,
	}
	session.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-fast"}}`))
	session.activateTurn(map[string]any{"turn": map[string]any{"id": "turn-fast"}}, []codexAttachment{{ID: "image-1", Path: path}})
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("early-completed attachment still exists: %v", err)
	}
	if session.turnID != "" || len(session.activeAttachments) != 0 {
		t.Fatal("early-completed turn was reactivated")
	}
}
