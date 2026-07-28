package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type fakeRuntimeTransport struct {
	mu       sync.Mutex
	messages [][]byte
	notify   chan struct{}
}

func TestRuntimeHTTPWebSocketRoundTrip(t *testing.T) {
	testContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server := NewServer(t.TempDir())
	router := chi.NewRouter()
	wantScope := agentScope{tenantID: "tenant-runtime", userID: "user-runtime"}
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor := store.AuthUser{ID: wantScope.userID, TenantID: wantScope.tenantID}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authUserKey, actor)))
		})
	})
	MountServer(router, server)
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()
	server.SetRuntimeOrigins(map[string]struct{}{httpServer.URL: {}})

	ticketResponse, err := http.Post(httpServer.URL+"/api/runtime/ticket", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ticketResponse.Body.Close()
	var ticket struct {
		Value string `json:"ticket"`
	}
	if json.NewDecoder(ticketResponse.Body).Decode(&ticket) != nil || ticket.Value == "" {
		t.Fatal("ticket response was invalid")
	}
	websocketURL := strings.Replace(httpServer.URL, "http://", "ws://", 1) + "/api/runtime/ws?ticket=" + ticket.Value
	connection, response, err := websocket.Dial(testContext, websocketURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{httpServer.URL}},
	})
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial failed with %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "test complete")

	_, readyData, err := connection.Read(testContext)
	if err != nil {
		t.Fatal(err)
	}
	var ready runtimeEnvelope
	if json.Unmarshal(readyData, &ready) != nil || ready.Type != "ready" {
		t.Fatalf("invalid runtime ready message: %s", readyData)
	}
	var readyState struct {
		ClientID string `json:"clientId"`
	}
	if json.Unmarshal(ready.Data, &readyState) != nil || readyState.ClientID == "" {
		t.Fatalf("invalid runtime client identity: %s", ready.Data)
	}
	server.runtime.mu.Lock()
	attachedScope := server.runtime.clients[readyState.ClientID].scope
	server.runtime.mu.Unlock()
	if attachedScope != wantScope {
		t.Fatalf("websocket client scope = %+v, want ticket scope %+v", attachedScope, wantScope)
	}
	commandDone := make(chan struct {
		status int
		body   string
	}, 1)
	go func() {
		body := bytes.NewBufferString(`{"method":"board.get_state","params":{},"timeoutMs":1000}`)
		response, requestErr := http.Post(httpServer.URL+"/api/runtime/command", "application/json", body)
		if requestErr != nil {
			commandDone <- struct {
				status int
				body   string
			}{0, requestErr.Error()}
			return
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		commandDone <- struct {
			status int
			body   string
		}{response.StatusCode, string(data)}
	}()
	_, data, err := connection.Read(testContext)
	if err != nil {
		t.Fatal(err)
	}
	var command runtimeEnvelope
	if json.Unmarshal(data, &command) != nil || command.ID == "" || command.Method != "board.get_state" {
		t.Fatalf("invalid browser command: %s", data)
	}
	result, _ := json.Marshal(runtimeEnvelope{
		Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{"projectId":"board-1"}`),
	})
	if err := connection.Write(testContext, websocket.MessageText, result); err != nil {
		t.Fatal(err)
	}
	completed := <-commandDone
	if completed.status != http.StatusOK || completed.body != `{"projectId":"board-1"}` {
		t.Fatalf("unexpected command response: %d %s", completed.status, completed.body)
	}

	second, reused, err := websocket.Dial(testContext, websocketURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{httpServer.URL}},
	})
	if second != nil {
		_ = second.Close(websocket.StatusNormalClosure, "unexpected")
	}
	if err == nil || reused == nil || reused.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused ticket was not rejected: response=%v err=%v", reused, err)
	}
}

func newFakeRuntimeTransport() *fakeRuntimeTransport {
	return &fakeRuntimeTransport{notify: make(chan struct{}, 16)}
}

func testLocalAgentScope() agentScope {
	return agentScope{tenantID: "tenant-local", userID: "user-local"}
}

func (f *fakeRuntimeTransport) Write(_ context.Context, message []byte) error {
	f.mu.Lock()
	f.messages = append(f.messages, append([]byte(nil), message...))
	f.mu.Unlock()
	f.notify <- struct{}{}
	return nil
}

func (f *fakeRuntimeTransport) Close() error { return nil }

func (f *fakeRuntimeTransport) last(t *testing.T) runtimeEnvelope {
	t.Helper()
	select {
	case <-f.notify:
	case <-time.After(time.Second):
		t.Fatal("runtime command was not written")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var message runtimeEnvelope
	if err := json.Unmarshal(f.messages[len(f.messages)-1], &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestRuntimeTicketsAreSingleUse(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	ticket := hub.issueTicket(scope, time.Minute)
	consumed, ok := hub.consumeTicket(ticket)
	if !ok || consumed != scope {
		t.Fatal("fresh ticket was rejected")
	}
	if _, ok := hub.consumeTicket(ticket); ok {
		t.Fatal("ticket was accepted twice")
	}
	expired := hub.issueTicket(scope, -time.Second)
	if _, ok := hub.consumeTicket(expired); ok {
		t.Fatal("expired ticket was accepted")
	}
}

func TestRuntimeTicketReturnsIssuingScope(t *testing.T) {
	hub := newRuntimeHub()
	want := agentScope{tenantID: "tenant-a", userID: "user-a"}
	ticket := hub.issueTicket(want, time.Minute)
	got, ok := hub.consumeTicket(ticket)
	if !ok || got != want {
		t.Fatalf("consumed scope = %+v ok=%v, want %+v", got, ok, want)
	}
}

func TestRuntimeCommandsResolveAndStateIsCopied(t *testing.T) {
	hub := newRuntimeHub()
	transport := newFakeRuntimeTransport()
	scope := testLocalAgentScope()
	client := hub.attach(scope, transport)
	defer hub.detach(client, errors.New("test complete"))

	state := json.RawMessage(`{"route":"/","projectId":"board-1"}`)
	if err := hub.receive(client, runtimeEnvelope{Type: "state", Data: state}); err != nil {
		t.Fatal(err)
	}
	state[2] = 'X'
	if got := string(hub.stateFor(scope)); got != `{"route":"/","projectId":"board-1"}` {
		t.Fatalf("state was not copied: %s", got)
	}

	result := make(chan json.RawMessage, 1)
	errCh := make(chan error, 1)
	go func() {
		value, err := hub.command(context.Background(), scope, "board.get_selection", json.RawMessage(`{}`))
		result <- value
		errCh <- err
	}()
	command := transport.last(t)
	if command.Type != "command" || command.ID == "" || command.Method != "board.get_selection" {
		t.Fatalf("unexpected command: %+v", command)
	}
	if err := hub.receive(client, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{"ids":["node-1"]}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if got := string(<-result); got != `{"ids":["node-1"]}` {
		t.Fatalf("unexpected result: %s", got)
	}
}

func TestRuntimeTimeoutAndDisconnectDoNotReplayCommands(t *testing.T) {
	hub := newRuntimeHub()
	transport := newFakeRuntimeTransport()
	scope := testLocalAgentScope()
	client := hub.attach(scope, transport)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(ctx, scope, "site.navigate", json.RawMessage(`{"path":"/assets"}`))
		done <- err
	}()
	command := transport.last(t)
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if err := hub.receive(client, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}

	waiting := make(chan error, 1)
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		waiting <- err
	}()
	_ = transport.last(t)
	hub.detach(client, errors.New("browser disconnected"))
	if err := <-waiting; err == nil || err.Error() != "browser disconnected" {
		t.Fatalf("unexpected disconnect result: %v", err)
	}
	if hub.connected() {
		t.Fatal("detached runtime still reports connected")
	}
}

func TestRuntimeKeepsMultipleBrowserTabsAndRoutesToMostRecent(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	firstTransport := newFakeRuntimeTransport()
	secondTransport := newFakeRuntimeTransport()
	first := hub.attach(scope, firstTransport)
	second := hub.attach(scope, secondTransport)
	defer hub.detach(first, errors.New("test complete"))
	defer hub.detach(second, errors.New("test complete"))

	if !hub.connected() {
		t.Fatal("multiple attached browser tabs were not connected")
	}
	if err := hub.receive(first, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"route":"/assets"}`)}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command := firstTransport.last(t)
	if err := hub.receive(first, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	hub.detach(first, errors.New("first tab closed"))
	if !hub.connected() {
		t.Fatal("closing one tab disconnected the remaining browser runtime")
	}
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command = secondTransport.last(t)
	if err := hub.receive(second, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRuntimePinsCommandsToInitiatingTabAndFallsBackAfterDisconnect(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	firstTransport := newFakeRuntimeTransport()
	secondTransport := newFakeRuntimeTransport()
	first := hub.attach(scope, firstTransport)
	second := hub.attach(scope, secondTransport)
	defer hub.detach(second, errors.New("test complete"))
	if err := hub.receive(first, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"projectId":"board-one","focused":true}`)}); err != nil {
		t.Fatal(err)
	}
	if err := hub.receive(second, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"projectId":"board-one","focused":false}`)}); err != nil {
		t.Fatal(err)
	}

	if claimed, ok := hub.claimClient(scope, first.id); !ok || claimed != first.id {
		t.Fatalf("claimed client = %q ok=%v, want %q", claimed, ok, first.id)
	}
	hub.pin(scope, "codex-turn", first.id)
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command := firstTransport.last(t)
	if err := hub.receive(first, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	hub.detach(first, errors.New("initiating tab closed"))
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command = secondTransport.last(t)
	if err := hub.receive(second, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	hub.unpin(scope, "codex-turn")
}

func TestRuntimeRejectsUnknownExplicitClientAndFallsBackOnlyWithinPinnedProject(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	firstTransport := newFakeRuntimeTransport()
	sameProjectTransport := newFakeRuntimeTransport()
	otherProjectTransport := newFakeRuntimeTransport()
	first := hub.attach(scope, firstTransport)
	sameProject := hub.attach(scope, sameProjectTransport)
	otherProject := hub.attach(scope, otherProjectTransport)
	defer hub.detach(sameProject, errors.New("test complete"))
	defer hub.detach(otherProject, errors.New("test complete"))

	if _, ok := hub.claimClient(scope, "missing-client"); ok {
		t.Fatal("unknown explicit client was silently rebound")
	}
	for client, state := range map[*runtimeClient]string{
		first:        `{"projectId":"board-one","focused":true}`,
		sameProject:  `{"projectId":"board-one","focused":false}`,
		otherProject: `{"projectId":"board-two","focused":true}`,
	} {
		if err := hub.receive(client, runtimeEnvelope{Type: "state", Data: json.RawMessage(state)}); err != nil {
			t.Fatal(err)
		}
	}
	hub.pin(scope, "codex-turn", first.id)
	hub.detach(first, errors.New("initiating tab closed"))

	done := make(chan error, 1)
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command := sameProjectTransport.last(t)
	if err := hub.receive(sameProject, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(otherProjectTransport.messages) != 0 {
		t.Fatal("pinned command was routed to another project")
	}
}

func TestRuntimeUnfocusedStateDoesNotStealRecentFocusedRouting(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	firstTransport := newFakeRuntimeTransport()
	secondTransport := newFakeRuntimeTransport()
	first := hub.attach(scope, firstTransport)
	second := hub.attach(scope, secondTransport)
	defer hub.detach(first, errors.New("test complete"))
	defer hub.detach(second, errors.New("test complete"))

	if err := hub.receive(first, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"route":"/","focused":true}`)}); err != nil {
		t.Fatal(err)
	}
	if err := hub.receive(second, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"route":"/prompts","focused":false}`)}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(context.Background(), scope, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command := firstTransport.last(t)
	if err := hub.receive(first, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeUsesHistoricalFocusWhenEveryTabIsBlurred(t *testing.T) {
	hub := newRuntimeHub()
	scope := testLocalAgentScope()
	first := hub.attach(scope, newFakeRuntimeTransport())
	second := hub.attach(scope, newFakeRuntimeTransport())
	defer hub.detach(first, errors.New("test complete"))
	defer hub.detach(second, errors.New("test complete"))

	states := []struct {
		client *runtimeClient
		data   string
	}{
		{second, `{"projectId":"board-one","focused":true}`},
		{second, `{"projectId":"board-one","focused":false}`},
		{first, `{"projectId":"board-one","focused":true}`},
		{first, `{"projectId":"board-one","focused":false}`},
	}
	for _, state := range states {
		if err := hub.receive(state.client, runtimeEnvelope{Type: "state", Data: json.RawMessage(state.data)}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 10; i++ {
		if err := hub.receive(second, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"projectId":"board-one","focused":false}`)}); err != nil {
			t.Fatal(err)
		}
	}
	claimed, ok := hub.claimClient(scope, "")
	if !ok || claimed != first.id {
		t.Fatalf("claimed=%q ok=%v, want most recently focused %q", claimed, ok, first.id)
	}
}

func TestRuntimeClientClaimCommandAndFallbackStayWithinOwner(t *testing.T) {
	hub := newRuntimeHub()
	owner := agentScope{tenantID: "tenant-a", userID: "user-a"}
	otherUser := agentScope{tenantID: "tenant-a", userID: "user-b"}
	otherTenant := agentScope{tenantID: "tenant-b", userID: "user-c"}
	ownerTransport := newFakeRuntimeTransport()
	otherUserTransport := newFakeRuntimeTransport()
	otherTenantTransport := newFakeRuntimeTransport()
	ownerClient := hub.attach(owner, ownerTransport)
	otherUserClient := hub.attach(otherUser, otherUserTransport)
	otherTenantClient := hub.attach(otherTenant, otherTenantTransport)
	defer hub.detach(otherUserClient, errors.New("test complete"))
	defer hub.detach(otherTenantClient, errors.New("test complete"))

	for client, state := range map[*runtimeClient]string{
		ownerClient:       `{"projectId":"shared-board","focused":false}`,
		otherUserClient:   `{"projectId":"shared-board","focused":true}`,
		otherTenantClient: `{"projectId":"shared-board","focused":true}`,
	} {
		if err := hub.receive(client, runtimeEnvelope{Type: "state", Data: json.RawMessage(state)}); err != nil {
			t.Fatal(err)
		}
	}

	if _, ok := hub.claimClient(owner, otherUserClient.id); ok {
		t.Fatal("owner claimed another user's runtime client")
	}
	if _, ok := hub.claimClient(owner, otherTenantClient.id); ok {
		t.Fatal("owner claimed another tenant's runtime client")
	}
	if claimed, ok := hub.claimClient(owner, ""); !ok || claimed != ownerClient.id {
		t.Fatalf("automatic owner claim = %q ok=%v, want %q", claimed, ok, ownerClient.id)
	}

	commandContext, cancelCommand := context.WithTimeout(context.Background(), time.Second)
	defer cancelCommand()
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(commandContext, owner, "board.get_state", json.RawMessage(`{}`))
		done <- err
	}()
	command := ownerTransport.last(t)
	if err := hub.receive(ownerClient, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(otherUserTransport.messages) != 0 || len(otherTenantTransport.messages) != 0 {
		t.Fatal("owner command was written to a foreign runtime client")
	}

	hub.pin(owner, "owner-turn", ownerClient.id)
	hub.detach(ownerClient, errors.New("owner browser disconnected"))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := hub.command(ctx, owner, "board.get_state", json.RawMessage(`{}`)); err == nil || err.Error() != "browser runtime is not connected" {
		t.Fatalf("foreign client was used as owner fallback: %v", err)
	}
	if len(otherUserTransport.messages) != 0 || len(otherTenantTransport.messages) != 0 {
		t.Fatal("owner disconnect fell back to a foreign runtime client")
	}
}

func TestRuntimePinsAndUnpinsAreScoped(t *testing.T) {
	hub := newRuntimeHub()
	owner := agentScope{tenantID: "tenant-a", userID: "user-a"}
	foreign := agentScope{tenantID: "tenant-b", userID: "user-b"}
	ownerPinnedTransport := newFakeRuntimeTransport()
	ownerActiveTransport := newFakeRuntimeTransport()
	foreignTransport := newFakeRuntimeTransport()
	ownerPinned := hub.attach(owner, ownerPinnedTransport)
	ownerActive := hub.attach(owner, ownerActiveTransport)
	foreignClient := hub.attach(foreign, foreignTransport)
	defer hub.detach(ownerPinned, errors.New("test complete"))
	defer hub.detach(ownerActive, errors.New("test complete"))
	defer hub.detach(foreignClient, errors.New("test complete"))

	if err := hub.receive(ownerActive, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"projectId":"board-a","focused":true}`)}); err != nil {
		t.Fatal(err)
	}
	if err := hub.receive(foreignClient, runtimeEnvelope{Type: "state", Data: json.RawMessage(`{"projectId":"board-b","focused":true}`)}); err != nil {
		t.Fatal(err)
	}
	hub.pin(owner, "shared-turn", ownerPinned.id)
	hub.pin(foreign, "shared-turn", foreignClient.id)
	hub.unpin(foreign, "shared-turn")

	runRuntimeCommand := func(scope agentScope, transport *fakeRuntimeTransport, client *runtimeClient) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := hub.command(ctx, scope, "board.get_state", json.RawMessage(`{}`))
			done <- err
		}()
		command := transport.last(t)
		if err := hub.receive(client, runtimeEnvelope{Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{}`)}); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}

	runRuntimeCommand(owner, ownerPinnedTransport, ownerPinned)
	if len(ownerActiveTransport.messages) != 0 {
		t.Fatal("foreign-scope pin or unpin displaced the owner's pin")
	}
	runRuntimeCommand(foreign, foreignTransport, foreignClient)
}

func TestExecuteToolRoutesLiveToolsWithoutHoldingProjectLock(t *testing.T) {
	server := NewServer(t.TempDir())
	transport := newFakeRuntimeTransport()
	client := server.runtime.attach(agentScope{}, transport)
	defer server.runtime.detach(client, errors.New("test complete"))

	result := make(chan any, 1)
	errCh := make(chan error, 1)
	go func() {
		value, err := server.ExecuteTool("board.get_state", json.RawMessage(`{}`))
		result <- value
		errCh <- err
	}()
	command := transport.last(t)
	if command.Method != "board.get_state" {
		t.Fatalf("tool was not routed to browser: %+v", command)
	}
	if err := server.runtime.receive(client, runtimeEnvelope{
		Type: "result", ID: command.ID, OK: true, Data: json.RawMessage(`{"projectId":"board-1"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	value := <-result
	encoded, _ := json.Marshal(value)
	if string(encoded) != `{"projectId":"board-1"}` {
		t.Fatalf("unexpected tool result: %s", encoded)
	}
}
