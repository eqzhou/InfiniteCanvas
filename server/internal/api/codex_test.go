package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"net/http"
	"net/http/httptest"
)

func TestCodexEventsRejectClosedSession(t *testing.T) {
	server := NewServer(t.TempDir())
	session := &codexSession{
		id: "codex-closed", profile: "default", closed: true,
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	server.codex.sessions[session.id] = session
	request := httptest.NewRequest(http.MethodGet, "/api/codex/events?sessionId="+session.id, nil)
	response := httptest.NewRecorder()
	server.codexEvents(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("closed session events status=%d body=%s", response.Code, response.Body.String())
	}
}

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
	server := NewServer(t.TempDir())
	server.codex.sessions[session.id] = session
	request := httptest.NewRequest(http.MethodPost, "/api/codex/approval", strings.NewReader(
		`{"sessionId":"`+session.id+`","id":"approval-1","approve":true}`,
	))
	response := httptest.NewRecorder()
	server.respondCodexApproval(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("approval status=%d body=%s", response.Code, response.Body.String())
	}
	deadline = time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.Method == "openboard/approval_resolved" && string(event.ID) == `"approval-1"` {
				return
			}
		case <-deadline:
			t.Fatal("approval resolution was not published")
		}
	}
}

func TestCodexStartupHonorsDeadlineWithoutBindingSessionLifetime(t *testing.T) {
	dir := t.TempDir()
	stalled := filepath.Join(dir, "stalled-codex.sh")
	if err := os.WriteFile(stalled, []byte("#!/bin/sh\nwhile IFS= read -r line; do sleep 10; done\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_BIN", stalled)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if session, err := startCodexSession(ctx, dir); err == nil {
		session.close()
		t.Fatal("stalled app-server unexpectedly started")
	}
	if time.Since(started) > time.Second {
		t.Fatal("stalled app-server ignored startup deadline")
	}

	t.Setenv("OPENBOARD_CODEX_BIN", fakeCodexBinary(t))
	parent, stopStartup := context.WithCancel(context.Background())
	session, err := startCodexSession(parent, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()
	stopStartup()
	time.Sleep(25 * time.Millisecond)
	if session.isClosed() {
		t.Fatal("completed startup remained bound to the request context")
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
			if count != 129 {
				t.Fatalf("replayed event count = %d, want 129", count)
			}
			return
		}
	}
}

func TestCodexSubscriberDoesNotDropCompletionAfterFullHistoryReplay(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one", turnID: "turn-one",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	for i := 0; i < codexHistoryLimit; i++ {
		session.publish(codexEvent{Type: "notification", Method: "item/completed"})
	}
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	session.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-one"}}`))
	session.publish(codexEvent{Type: "notification", Method: "turn/completed"})
	session.publishState()

	foundCompletion := false
	foundIdleState := false
	for i := 0; i < codexHistoryLimit+3; i++ {
		select {
		case event := <-events:
			foundCompletion = foundCompletion || event.Method == "turn/completed"
			if event.Method == "openboard/session_state" {
				encoded, _ := json.Marshal(event.Data)
				foundIdleState = foundIdleState || strings.Contains(string(encoded), `"running":false`)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for completion replay")
		}
	}
	if !foundCompletion || !foundIdleState {
		t.Fatalf("completion=%v idle state=%v", foundCompletion, foundIdleState)
	}
}

func TestCodexSlowSubscriberIsDisconnectedInsteadOfSilentlyDroppingEvents(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	for i := 0; i < codexSubscriberBuffer+2; i++ {
		session.publish(codexEvent{Type: "notification", Method: "agent_message_delta"})
	}
	session.mu.Lock()
	_, stillSubscribed := session.subs[events]
	session.mu.Unlock()
	if stillSubscribed {
		t.Fatal("full subscriber remained registered and silently dropped events")
	}
	for range events {
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
	session.reserveTurnAttachments([]codexAttachment{{ID: "image-1", Path: path}})
	session.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-fast"}}`))
	if !session.activateTurn(map[string]any{"turn": map[string]any{"id": "turn-fast"}}) {
		t.Fatal("completed turn response was rejected")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("early-completed attachment still exists: %v", err)
	}
	if session.turnID != "" || len(session.activeAttachments) != 0 {
		t.Fatal("early-completed turn was reactivated")
	}
}

func TestCodexActivationRequiresResponseOrNotificationTurnID(t *testing.T) {
	session := &codexSession{
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
		turnStarting: true,
	}
	if session.activateTurn(map[string]any{}) {
		t.Fatal("empty turn response was accepted")
	}
	session.turnStarting = true
	session.trackTurnNotification("turn/started", json.RawMessage(`{"turn":{"id":"turn-notified"}}`))
	if !session.activateTurn(map[string]any{}) || session.turnID != "turn-notified" {
		t.Fatal("a valid earlier turn/started notification was discarded")
	}

	mismatched := &codexSession{
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
		turnStarting: true,
	}
	mismatched.trackTurnNotification("turn/completed", json.RawMessage(`{"turn":{"id":"turn-completed"}}`))
	if mismatched.activateTurn(map[string]any{"turn": map[string]any{"id": "turn-response"}}) {
		t.Fatal("a mismatched completed notification and RPC response were accepted")
	}
}

func TestCodexSessionSnapshotTracksRunningTurnAndRuntimeOwner(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one",
		turnID: "turn-one", runtimeClientID: "browser-one",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	snapshot := session.snapshot(false)
	if snapshot.ID != "codex-one" || snapshot.ThreadID != "thread-one" || !snapshot.Running || snapshot.RuntimeClientID != "browser-one" {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestCodexSubscriberReceivesCurrentSessionStateAfterHistory(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one", turnStarting: true,
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	session.publish(codexEvent{Type: "notification", Method: "item/completed"})
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	<-events
	state := <-events
	if state.Method != "openboard/session_state" {
		t.Fatalf("last replay event = %q", state.Method)
	}
	encoded, _ := json.Marshal(state.Data)
	if !strings.Contains(string(encoded), `"running":true`) {
		t.Fatalf("state did not include running status: %s", encoded)
	}
}

func TestCodexSubscriberResumesAfterSequenceAndRejectsExpiredHistory(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	for i := 0; i < codexHistoryLimit+10; i++ {
		session.publish(codexEvent{Type: "notification", Method: "agent_message_delta"})
	}

	events, unsubscribe, err := session.subscribeAfter(session.eventSequence - 1)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	if event := <-events; event.Sequence != session.eventSequence {
		t.Fatalf("resumed sequence=%d want=%d", event.Sequence, session.eventSequence)
	}
	if state := <-events; state.Method != "openboard/session_state" {
		t.Fatalf("resumed state method=%q", state.Method)
	}

	if _, _, err := session.subscribeAfter(1); !errors.Is(err, errCodexHistoryGap) {
		t.Fatalf("expired replay error=%v", err)
	}
}

func TestCodexManagerAllowsOnlyOneBoundTurnAcrossProfiles(t *testing.T) {
	manager := newCodexManager()
	if !manager.claimTurn("session-one") {
		t.Fatal("first turn was rejected")
	}
	if manager.claimTurn("session-two") {
		t.Fatal("concurrent turn from another profile was accepted")
	}
	manager.releaseTurn("session-one")
	if !manager.claimTurn("session-two") {
		t.Fatal("next turn remained blocked after release")
	}
}

func TestCodexUserMessagesAreReplayedToNewTabs(t *testing.T) {
	session := &codexSession{
		id: "codex-one", profile: "default", threadID: "thread-one",
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	session.publish(codexEvent{
		Type: "notification", Method: "openboard/user_message",
		Data: map[string]any{"id": "message-one", "text": "hello from another tab"},
	})
	events, unsubscribe := session.subscribe()
	defer unsubscribe()
	message := <-events
	if message.Method != "openboard/user_message" {
		t.Fatalf("replayed method = %q", message.Method)
	}
	encoded, _ := json.Marshal(message.Data)
	if !strings.Contains(string(encoded), "hello from another tab") {
		t.Fatalf("replayed user message = %s", encoded)
	}
}
