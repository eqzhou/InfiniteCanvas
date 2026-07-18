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
	state     json.RawMessage
	sequence  uint64
}

type runtimeResult struct {
	data json.RawMessage
	err  error
}

type pendingRuntimeCommand struct {
	client *runtimeClient
	waiter chan runtimeResult
}

type runtimeHub struct {
	mu       sync.Mutex
	clients  map[string]*runtimeClient
	active   *runtimeClient
	sequence uint64
	pending  map[string]pendingRuntimeCommand
	tickets  map[string]time.Time
}

func newRuntimeHub() *runtimeHub {
	return &runtimeHub{
		clients: make(map[string]*runtimeClient),
		pending: make(map[string]pendingRuntimeCommand),
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
	h.mu.Lock()
	h.sequence++
	client := &runtimeClient{id: randomID("browser"), transport: transport, sequence: h.sequence}
	h.clients[client.id] = client
	if h.active == nil {
		h.active = client
	}
	h.mu.Unlock()
	return client
}

func (h *runtimeHub) detach(client *runtimeClient, cause error) {
	if cause == nil {
		cause = errors.New("browser disconnected")
	}
	h.mu.Lock()
	if h.clients[client.id] != client {
		h.mu.Unlock()
		return
	}
	delete(h.clients, client.id)
	waiters := make([]chan runtimeResult, 0)
	for id, pending := range h.pending {
		if pending.client == client {
			waiters = append(waiters, pending.waiter)
			delete(h.pending, id)
		}
	}
	if h.active == client {
		h.active = nil
		for _, candidate := range h.clients {
			if h.active == nil || candidate.sequence > h.active.sequence {
				h.active = candidate
			}
		}
	}
	h.mu.Unlock()
	_ = client.transport.Close()
	for _, waiter := range waiters {
		waiter <- runtimeResult{err: cause}
	}
}

func (h *runtimeHub) connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients) > 0
}

func (h *runtimeHub) state() json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active == nil {
		return nil
	}
	return append(json.RawMessage(nil), h.active.state...)
}

func (h *runtimeHub) receive(client *runtimeClient, message runtimeEnvelope) error {
	switch message.Type {
	case "state":
		if len(message.Data) == 0 || !json.Valid(message.Data) {
			return errors.New("runtime state is invalid")
		}
		h.mu.Lock()
		if h.clients[client.id] == client {
			h.sequence++
			client.sequence = h.sequence
			client.state = append(json.RawMessage(nil), message.Data...)
			h.active = client
		}
		h.mu.Unlock()
		return nil
	case "result":
		if message.ID == "" {
			return errors.New("runtime result id is required")
		}
		h.mu.Lock()
		pending, exists := h.pending[message.ID]
		if exists && pending.client == client {
			delete(h.pending, message.ID)
		} else {
			exists = false
		}
		h.mu.Unlock()
		if !exists {
			return nil
		}
		if !message.OK {
			if message.Error == "" {
				message.Error = "browser command failed"
			}
			pending.waiter <- runtimeResult{err: errors.New(message.Error)}
			return nil
		}
		if len(message.Data) == 0 {
			message.Data = json.RawMessage(`{}`)
		}
		if !json.Valid(message.Data) {
			pending.waiter <- runtimeResult{err: errors.New("browser result is invalid")}
			return nil
		}
		pending.waiter <- runtimeResult{data: append(json.RawMessage(nil), message.Data...)}
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
	client := h.active
	if client != nil {
		h.pending[id] = pendingRuntimeCommand{client: client, waiter: waiter}
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
