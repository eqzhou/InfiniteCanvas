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

func TestCodexMessageForwardsModelAndEffort(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-codex-models.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"id":%s,"result":{}}\n' "$id" ;;
    thread/start) printf '{"id":%s,"result":{"thread":{"id":"thread-model-test"}}}\n' "$id" ;;
    model/list) printf '{"id":%s,"result":{"data":[{"id":"gpt-5.6-terra","model":"gpt-5.6-terra","displayName":"GPT-5.6-Terra","description":"Balanced","defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high","description":"Deep"}],"isDefault":true},{"id":"gpt-5.6-sol","model":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","description":"Fast","defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast"}],"isDefault":false}]}}\n' "$id" ;;
    turn/start)
      case "$line" in *'"model":"gpt-5.6-terra"'*) ;; *) printf '{"id":%s,"error":{"code":-1,"message":"missing model"}}\n' "$id"; continue ;; esac
      case "$line" in *'"effort":"high"'*) ;; *) printf '{"id":%s,"error":{"code":-1,"message":"missing effort"}}\n' "$id"; continue ;; esac
      printf '{"id":%s,"result":{"turn":{"id":"turn-model-test"}}}\n' "$id" ;;
  esac
done
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_BIN", bin)
	handler := testHandler(t)
	created := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{}`))
	var session codexSessionSnapshot
	if json.Unmarshal(created.Body.Bytes(), &session) != nil || session.ID == "" {
		t.Fatalf("session=%s", created.Body.String())
	}
	invalid := request(t, handler, http.MethodPost, "/api/codex/message", []byte(
		`{"sessionId":"`+session.ID+`","text":"hello","model":"bad model","effort":"high"}`))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid model status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	missingAttachment := request(t, handler, http.MethodPost, "/api/codex/message", []byte(
		`{"sessionId":"`+session.ID+`","text":"hello","model":"gpt-5.6-terra","effort":"high","attachmentIds":["missing-attachment"]}`))
	if missingAttachment.Code != http.StatusBadRequest {
		t.Fatalf("missing attachment status=%d body=%s", missingAttachment.Code, missingAttachment.Body.String())
	}
	unchanged := request(t, handler, http.MethodGet, "/api/codex/session?profile=default", nil)
	var unchangedSelection codexSessionSnapshot
	if json.Unmarshal(unchanged.Body.Bytes(), &unchangedSelection) != nil || unchangedSelection.Model != "" || unchangedSelection.Effort != "" {
		t.Fatalf("failed message changed selection=%s", unchanged.Body.String())
	}
	message := request(t, handler, http.MethodPost, "/api/codex/message", []byte(
		`{"sessionId":"`+session.ID+`","text":"hello","model":"gpt-5.6-terra","effort":"high"}`))
	if message.Code != http.StatusOK {
		t.Fatalf("message status=%d body=%s", message.Code, message.Body.String())
	}
	conflict := request(t, handler, http.MethodPost, "/api/codex/message", []byte(
		`{"sessionId":"`+session.ID+`","text":"second","model":"gpt-5.6-sol","effort":"low"}`))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("concurrent message status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	status := request(t, handler, http.MethodGet, "/api/codex/session?profile=default", nil)
	var selected codexSessionSnapshot
	if json.Unmarshal(status.Body.Bytes(), &selected) != nil || selected.Model != "gpt-5.6-terra" || selected.Effort != "high" {
		t.Fatalf("selection=%s", status.Body.String())
	}
}

func TestCodexMessageDoesNotOverwriteNewerPreference(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-codex-preference-race.sh")
	started := filepath.Join(dir, "turn-started")
	release := filepath.Join(dir, "release-turn")
	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"id":%s,"result":{}}\n' "$id" ;;
    thread/start) printf '{"id":%s,"result":{"thread":{"id":"thread-preference-race"}}}\n' "$id" ;;
    model/list) printf '{"id":%s,"result":{"data":[{"id":"model-one","model":"model-one","displayName":"Model One","description":"First","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Balanced"}],"isDefault":true},{"id":"model-two","model":"model-two","displayName":"Model Two","description":"Second","defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high","description":"Deep"}],"isDefault":false}]}}\n' "$id" ;;
    turn/start)
      : > "` + started + `"
      while [ ! -f "` + release + `" ]; do sleep 0.01; done
      printf '{"id":%s,"result":{"turn":{"id":"turn-preference-race"}}}\n' "$id" ;;
  esac
done
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_BIN", bin)
	handler := testHandler(t)
	created := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{}`))
	var session codexSessionSnapshot
	if json.Unmarshal(created.Body.Bytes(), &session) != nil || session.ID == "" {
		t.Fatalf("session=%s", created.Body.String())
	}

	messageDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/api/codex/message", strings.NewReader(
			`{"sessionId":"`+session.ID+`","text":"hello","model":"model-one","effort":"medium"}`,
		))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		messageDone <- response
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		select {
		case response := <-messageDone:
			t.Fatalf("message finished before blocked turn/start: status=%d body=%s", response.Code, response.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("turn/start did not block")
		}
		time.Sleep(10 * time.Millisecond)
	}
	preference := request(t, handler, http.MethodPost, "/api/codex/preferences", []byte(
		`{"sessionId":"`+session.ID+`","model":"model-two","effort":"high"}`))
	if preference.Code != http.StatusOK {
		t.Fatalf("preference status=%d body=%s", preference.Code, preference.Body.String())
	}
	if err := os.WriteFile(release, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-messageDone:
		if response.Code != http.StatusOK {
			t.Fatalf("message status=%d body=%s", response.Code, response.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("message did not finish")
	}
	status := request(t, handler, http.MethodGet, "/api/codex/session?profile=default", nil)
	var selected codexSessionSnapshot
	if json.Unmarshal(status.Body.Bytes(), &selected) != nil || selected.Model != "model-two" || selected.Effort != "high" {
		t.Fatalf("newer preference was overwritten: %s", status.Body.String())
	}
}

func TestValidateCodexModelListBounds(t *testing.T) {
	valid := codexModelListResponse{Data: []codexModelOption{{
		ID: "gpt-5.6-terra", Model: "gpt-5.6-terra", DisplayName: "GPT-5.6-Terra",
		Description: "Balanced", DefaultReasoningEffort: "medium", IsDefault: true,
		SupportedReasoningEfforts: []codexReasoningEffort{{ReasoningEffort: "medium", Description: "Balanced"}},
	}}}
	if err := validateCodexModelList(valid); err != nil {
		t.Fatal(err)
	}
	duplicate := codexModelListResponse{Data: append(append([]codexModelOption{}, valid.Data...), valid.Data[0])}
	if err := validateCodexModelList(duplicate); err == nil {
		t.Fatal("duplicate model catalog was accepted")
	}
	invalidDefault := valid
	invalidDefault.Data = append([]codexModelOption{}, valid.Data...)
	invalidDefault.Data[0].DefaultReasoningEffort = "xhigh"
	if err := validateCodexModelList(invalidDefault); err == nil {
		t.Fatal("unavailable default effort was accepted")
	}
	duplicateModelName := valid
	duplicateModelName.Data = append(append([]codexModelOption{}, valid.Data...), valid.Data[0])
	duplicateModelName.Data[1].ID = "gpt-5.6-terra-alias"
	if err := validateCodexModelList(duplicateModelName); err == nil {
		t.Fatal("duplicate model name was accepted")
	}
	duplicateEffort := valid
	duplicateEffort.Data = append([]codexModelOption{}, valid.Data...)
	duplicateEffort.Data[0].SupportedReasoningEfforts = append(
		append([]codexReasoningEffort{}, valid.Data[0].SupportedReasoningEfforts...),
		valid.Data[0].SupportedReasoningEfforts[0],
	)
	if err := validateCodexModelList(duplicateEffort); err == nil {
		t.Fatal("duplicate reasoning effort was accepted")
	}
	custom := valid
	custom.Data = append([]codexModelOption{}, valid.Data...)
	custom.Data[0].ID = "provider/model+preview"
	custom.Data[0].Model = "provider/model+preview"
	if err := validateCodexModelList(custom); err != nil {
		t.Fatalf("safe custom model was rejected: %v", err)
	}
}

func TestCodexModelListFollowsPagination(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-codex-paginated-models.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"id":%s,"result":{}}\n' "$id" ;;
    thread/start) printf '{"id":%s,"result":{"thread":{"id":"thread-pagination-test"}}}\n' "$id" ;;
    model/list)
      case "$line" in
        *'"cursor":"page-2"'*) printf '{"id":%s,"result":{"data":[{"id":"model-two","model":"model-two","displayName":"Model Two","description":"Second","defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high","description":"Deep"}],"isDefault":false}],"nextCursor":null}}\n' "$id" ;;
        *) printf '{"id":%s,"result":{"data":[{"id":"model-one","model":"model-one","displayName":"Model One","description":"First","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Balanced"}],"isDefault":true}],"nextCursor":"page-2"}}\n' "$id" ;;
      esac ;;
  esac
done
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_BIN", bin)
	handler := testHandler(t)
	created := request(t, handler, http.MethodPost, "/api/codex/session", []byte(`{}`))
	var session codexSessionSnapshot
	if json.Unmarshal(created.Body.Bytes(), &session) != nil || session.ID == "" {
		t.Fatalf("session=%s", created.Body.String())
	}
	models := request(t, handler, http.MethodGet, "/api/codex/models?sessionId="+session.ID, nil)
	var catalog codexModelListResponse
	if models.Code != http.StatusOK || json.Unmarshal(models.Body.Bytes(), &catalog) != nil || len(catalog.Data) != 2 {
		t.Fatalf("models status=%d body=%s", models.Code, models.Body.String())
	}
}

func TestCodexPreferencesPersistPerAgentScope(t *testing.T) {
	fixture := newAgentIsolationFixture(t, agentIsolationActors())
	ownerSessionID := decodeAgentSessionID(t, fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{}`)))
	trailing := fixture.request(t, "owner", http.MethodPost, "/api/codex/preferences", []byte(
		`{"sessionId":"`+ownerSessionID+`","model":"gpt-5.6-terra","effort":"medium"}{}`))
	if trailing.Code != http.StatusBadRequest {
		t.Fatalf("trailing preference status=%d body=%s", trailing.Code, trailing.Body.String())
	}
	updated := fixture.request(t, "owner", http.MethodPost, "/api/codex/preferences", []byte(
		`{"sessionId":"`+ownerSessionID+`","model":"gpt-5.6-terra","effort":"medium"}`))
	if updated.Code != http.StatusOK {
		t.Fatalf("preference status=%d body=%s", updated.Code, updated.Body.String())
	}
	closed := fixture.request(t, "owner", http.MethodDelete, "/api/codex/session/"+ownerSessionID, nil)
	if closed.Code != http.StatusNoContent {
		t.Fatalf("close status=%d body=%s", closed.Code, closed.Body.String())
	}
	recreated := fixture.request(t, "owner", http.MethodPost, "/api/codex/session", []byte(`{"fresh":true}`))
	var owner codexSessionSnapshot
	if json.Unmarshal(recreated.Body.Bytes(), &owner) != nil || owner.Model != "gpt-5.6-terra" || owner.Effort != "medium" {
		t.Fatalf("owner preference was not restored: %s", recreated.Body.String())
	}
	peer := fixture.request(t, "same-tenant", http.MethodPost, "/api/codex/session", []byte(`{}`))
	var peerSnapshot codexSessionSnapshot
	if json.Unmarshal(peer.Body.Bytes(), &peerSnapshot) != nil || peerSnapshot.Model != "" || peerSnapshot.Effort != "" {
		t.Fatalf("owner preference leaked to peer: %s", peer.Body.String())
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
	scope := agentScope{tenantID: "tenant-a", userID: "user-a"}
	if !manager.claimTurn(scope, "session-one") {
		t.Fatal("first turn was rejected")
	}
	if manager.claimTurn(scope, "session-two") {
		t.Fatal("concurrent turn from another profile was accepted")
	}
	manager.releaseTurn(scope, "session-one")
	if !manager.claimTurn(scope, "session-two") {
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

func TestCodexTurnPermissionParams(t *testing.T) {
	tests := []struct {
		mode           string
		approvalPolicy string
		sandboxType    string
	}{
		{mode: "", approvalPolicy: "never", sandboxType: "workspaceWrite"},
		{mode: "read-only", approvalPolicy: "on-request", sandboxType: "readOnly"},
		{mode: "workspace-auto", approvalPolicy: "never", sandboxType: "workspaceWrite"},
		{mode: "full-access", approvalPolicy: "never", sandboxType: "dangerFullAccess"},
	}
	for _, test := range tests {
		params, err := codexTurnPermissionParams(test.mode)
		if err != nil {
			t.Fatalf("mode %q: %v", test.mode, err)
		}
		if params["approvalPolicy"] != test.approvalPolicy {
			t.Fatalf("mode %q approvalPolicy=%v", test.mode, params["approvalPolicy"])
		}
		sandbox, ok := params["sandboxPolicy"].(map[string]any)
		if !ok || sandbox["type"] != test.sandboxType {
			t.Fatalf("mode %q sandboxPolicy=%#v", test.mode, params["sandboxPolicy"])
		}
		if test.mode == "workspace-auto" && sandbox["networkAccess"] != false {
			t.Fatalf("workspace-auto unexpectedly enabled network access: %#v", sandbox)
		}
	}
	if _, err := codexTurnPermissionParams("unknown"); err == nil {
		t.Fatal("unknown permission mode was accepted")
	}
}
