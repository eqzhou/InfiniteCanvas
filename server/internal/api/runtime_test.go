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
)

type fakeRuntimeTransport struct {
	mu       sync.Mutex
	messages [][]byte
	notify   chan struct{}
}

func TestRuntimeHTTPWebSocketRoundTrip(t *testing.T) {
	server := NewServer(t.TempDir())
	router := chi.NewRouter()
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
	connection, response, err := websocket.Dial(context.Background(), websocketURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{httpServer.URL}},
	})
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial failed with %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "test complete")

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

	_, data, err := connection.Read(context.Background())
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
	if err := connection.Write(context.Background(), websocket.MessageText, result); err != nil {
		t.Fatal(err)
	}
	completed := <-commandDone
	if completed.status != http.StatusOK || completed.body != `{"projectId":"board-1"}` {
		t.Fatalf("unexpected command response: %d %s", completed.status, completed.body)
	}

	second, reused, err := websocket.Dial(context.Background(), websocketURL, &websocket.DialOptions{
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
	ticket := hub.issueTicket(time.Minute)
	if !hub.consumeTicket(ticket) {
		t.Fatal("fresh ticket was rejected")
	}
	if hub.consumeTicket(ticket) {
		t.Fatal("ticket was accepted twice")
	}
	expired := hub.issueTicket(-time.Second)
	if hub.consumeTicket(expired) {
		t.Fatal("expired ticket was accepted")
	}
}

func TestRuntimeCommandsResolveAndStateIsCopied(t *testing.T) {
	hub := newRuntimeHub()
	transport := newFakeRuntimeTransport()
	client := hub.attach(transport)
	defer hub.detach(client, errors.New("test complete"))

	state := json.RawMessage(`{"route":"/","projectId":"board-1"}`)
	if err := hub.receive(client, runtimeEnvelope{Type: "state", Data: state}); err != nil {
		t.Fatal(err)
	}
	state[2] = 'X'
	if got := string(hub.state()); got != `{"route":"/","projectId":"board-1"}` {
		t.Fatalf("state was not copied: %s", got)
	}

	result := make(chan json.RawMessage, 1)
	errCh := make(chan error, 1)
	go func() {
		value, err := hub.command(context.Background(), "board.get_selection", json.RawMessage(`{}`))
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
	client := hub.attach(transport)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := hub.command(ctx, "site.navigate", json.RawMessage(`{"path":"/assets"}`))
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
		_, err := hub.command(context.Background(), "board.get_state", json.RawMessage(`{}`))
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
	firstTransport := newFakeRuntimeTransport()
	secondTransport := newFakeRuntimeTransport()
	first := hub.attach(firstTransport)
	second := hub.attach(secondTransport)
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
		_, err := hub.command(context.Background(), "board.get_state", json.RawMessage(`{}`))
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
		_, err := hub.command(context.Background(), "board.get_state", json.RawMessage(`{}`))
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

func TestExecuteToolRoutesLiveToolsWithoutHoldingProjectLock(t *testing.T) {
	server := NewServer(t.TempDir())
	transport := newFakeRuntimeTransport()
	client := server.runtime.attach(transport)
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
