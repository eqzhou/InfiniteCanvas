package api

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

const maxRuntimeMessageBytes = 32 << 20

type runtimeEnvelope struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	OK     bool            `json:"ok,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type runtimeTransport interface {
	Write(context.Context, []byte) error
	Close() error
}

type runtimeClient struct {
	id        string
	transport runtimeTransport
}

type runtimeResult struct {
	data json.RawMessage
	err  error
}

type runtimeHub struct {
	mu      sync.Mutex
	client  *runtimeClient
	stateV  json.RawMessage
	pending map[string]chan runtimeResult
	tickets map[string]time.Time
}

func newRuntimeHub() *runtimeHub {
	return &runtimeHub{
		pending: make(map[string]chan runtimeResult),
		tickets: make(map[string]time.Time),
	}
}

func (h *runtimeHub) issueTicket(ttl time.Duration) string {
	now := time.Now()
	ticket := randomID("runtime")
	h.mu.Lock()
	for value, expires := range h.tickets {
		if !expires.After(now) {
			delete(h.tickets, value)
		}
	}
	h.tickets[ticket] = now.Add(ttl)
	h.mu.Unlock()
	return ticket
}

func (h *runtimeHub) consumeTicket(ticket string) bool {
	if ticket == "" {
		return false
	}
	now := time.Now()
	h.mu.Lock()
	expires, ok := h.tickets[ticket]
	delete(h.tickets, ticket)
	h.mu.Unlock()
	return ok && expires.After(now)
}

func (h *runtimeHub) attach(transport runtimeTransport) *runtimeClient {
	client := &runtimeClient{id: randomID("browser"), transport: transport}
	h.mu.Lock()
	previous := h.client
	h.client = client
	h.stateV = nil
	waiters := h.pending
	h.pending = make(map[string]chan runtimeResult)
	h.mu.Unlock()
	if previous != nil {
		_ = previous.transport.Close()
	}
	for _, waiter := range waiters {
		waiter <- runtimeResult{err: errors.New("browser runtime replaced")}
	}
	return client
}

func (h *runtimeHub) detach(client *runtimeClient, cause error) {
	if cause == nil {
		cause = errors.New("browser disconnected")
	}
	h.mu.Lock()
	if h.client != client {
		h.mu.Unlock()
		return
	}
	h.client = nil
	h.stateV = nil
	waiters := h.pending
	h.pending = make(map[string]chan runtimeResult)
	h.mu.Unlock()
	_ = client.transport.Close()
	for _, waiter := range waiters {
		waiter <- runtimeResult{err: cause}
	}
}

func (h *runtimeHub) connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.client != nil
}

func (h *runtimeHub) state() json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append(json.RawMessage(nil), h.stateV...)
}

func (h *runtimeHub) receive(client *runtimeClient, message runtimeEnvelope) error {
	switch message.Type {
	case "state":
		if len(message.Data) == 0 || !json.Valid(message.Data) {
			return errors.New("runtime state is invalid")
		}
		h.mu.Lock()
		if h.client == client {
			h.stateV = append(json.RawMessage(nil), message.Data...)
		}
		h.mu.Unlock()
		return nil
	case "result":
		if message.ID == "" {
			return errors.New("runtime result id is required")
		}
		h.mu.Lock()
		waiter := h.pending[message.ID]
		delete(h.pending, message.ID)
		h.mu.Unlock()
		if waiter == nil {
			return nil
		}
		if !message.OK {
			if message.Error == "" {
				message.Error = "browser command failed"
			}
			waiter <- runtimeResult{err: errors.New(message.Error)}
			return nil
		}
		if len(message.Data) == 0 {
			message.Data = json.RawMessage(`{}`)
		}
		if !json.Valid(message.Data) {
			waiter <- runtimeResult{err: errors.New("browser result is invalid")}
			return nil
		}
		waiter <- runtimeResult{data: append(json.RawMessage(nil), message.Data...)}
		return nil
	default:
		return errors.New("runtime message type is unsupported")
	}
}

func (h *runtimeHub) command(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	if method == "" {
		return nil, errors.New("runtime command method is required")
	}
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	if !json.Valid(params) {
		return nil, errors.New("runtime command params are invalid")
	}
	id := randomID("command")
	waiter := make(chan runtimeResult, 1)
	h.mu.Lock()
	client := h.client
	if client != nil {
		h.pending[id] = waiter
	}
	h.mu.Unlock()
	if client == nil {
		return nil, errors.New("browser runtime is not connected")
	}
	message, err := json.Marshal(runtimeEnvelope{Type: "command", ID: id, Method: method, Data: params})
	if err != nil {
		h.removePending(id)
		return nil, err
	}
	if err := client.transport.Write(ctx, message); err != nil {
		h.removePending(id)
		return nil, err
	}
	select {
	case result := <-waiter:
		return result.data, result.err
	case <-ctx.Done():
		h.removePending(id)
		return nil, ctx.Err()
	}
}

func (h *runtimeHub) removePending(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}
