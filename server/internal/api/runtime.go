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
	scope     agentScope
	transport runtimeTransport
	state     json.RawMessage
	sequence  uint64
	focusSeq  uint64
	focused   bool
	projectID string
}

type runtimeTicket struct {
	scope     agentScope
	expiresAt time.Time
}

type runtimePin struct {
	owner     string
	clientID  string
	projectID string
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
	active   map[agentScope]*runtimeClient
	sequence uint64
	focusSeq uint64
	pending  map[string]pendingRuntimeCommand
	tickets  map[string]runtimeTicket
	pins     map[agentScope]runtimePin
}

func newRuntimeHub() *runtimeHub {
	return &runtimeHub{
		clients: make(map[string]*runtimeClient),
		active:  make(map[agentScope]*runtimeClient),
		pending: make(map[string]pendingRuntimeCommand),
		tickets: make(map[string]runtimeTicket),
		pins:    make(map[agentScope]runtimePin),
	}
}

func (h *runtimeHub) issueTicket(scope agentScope, ttl time.Duration) string {
	now := time.Now()
	ticket := randomID("runtime")
	h.mu.Lock()
	for value, entry := range h.tickets {
		if !entry.expiresAt.After(now) {
			delete(h.tickets, value)
		}
	}
	h.tickets[ticket] = runtimeTicket{scope: scope, expiresAt: now.Add(ttl)}
	h.mu.Unlock()
	return ticket
}

func (h *runtimeHub) consumeTicket(ticket string) (agentScope, bool) {
	if ticket == "" {
		return agentScope{}, false
	}
	now := time.Now()
	h.mu.Lock()
	entry, ok := h.tickets[ticket]
	delete(h.tickets, ticket)
	h.mu.Unlock()
	return entry.scope, ok && entry.expiresAt.After(now)
}

func (h *runtimeHub) attach(scope agentScope, transport runtimeTransport) *runtimeClient {
	h.mu.Lock()
	h.sequence++
	client := &runtimeClient{id: randomID("browser"), scope: scope, transport: transport, sequence: h.sequence}
	h.clients[client.id] = client
	if h.active[scope] == nil {
		h.active[scope] = client
	}
	h.mu.Unlock()
	return client
}

func (h *runtimeHub) bestClientLocked(scope agentScope) *runtimeClient {
	var bestRecent *runtimeClient
	var bestAny *runtimeClient
	for _, candidate := range h.clients {
		if candidate.scope != scope {
			continue
		}
		if bestAny == nil || candidate.sequence > bestAny.sequence {
			bestAny = candidate
		}
		if candidate.focusSeq > 0 && (bestRecent == nil || candidate.focusSeq > bestRecent.focusSeq) {
			bestRecent = candidate
		}
	}
	if bestRecent != nil {
		return bestRecent
	}
	return bestAny
}

func (h *runtimeHub) bestClientForProjectLocked(scope agentScope, projectID string) *runtimeClient {
	if projectID == "" {
		return nil
	}
	var best *runtimeClient
	for _, candidate := range h.clients {
		if candidate.scope != scope || candidate.projectID != projectID {
			continue
		}
		moreRecent := best == nil || candidate.focusSeq > best.focusSeq ||
			(candidate.focusSeq == best.focusSeq && candidate.sequence > best.sequence)
		if moreRecent {
			best = candidate
		}
	}
	return best
}

func (h *runtimeHub) claimClient(scope agentScope, requested string) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if requested != "" {
		if client := h.clients[requested]; client != nil && client.scope == scope {
			return client.id, true
		}
		return "", false
	}
	client := h.bestClientLocked(scope)
	if client == nil {
		return "", false
	}
	return client.id, true
}

func (h *runtimeHub) pin(scope agentScope, owner, clientID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	client := h.clients[clientID]
	if owner == "" || client == nil || client.scope != scope {
		return
	}
	h.pins[scope] = runtimePin{owner: owner, clientID: clientID, projectID: client.projectID}
}

func (h *runtimeHub) unpin(scope agentScope, owner string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if pin := h.pins[scope]; owner != "" && pin.owner == owner {
		delete(h.pins, scope)
	}
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
	if h.active[client.scope] == client {
		h.active[client.scope] = h.bestClientLocked(client.scope)
		if h.active[client.scope] == nil {
			delete(h.active, client.scope)
		}
	}
	pin := h.pins[client.scope]
	if pin.clientID == client.id {
		fallback := h.bestClientForProjectLocked(client.scope, pin.projectID)
		if fallback == nil {
			pin.clientID = ""
		} else {
			pin.clientID = fallback.id
		}
		h.pins[client.scope] = pin
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

func (h *runtimeHub) connectedFor(scope agentScope) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bestClientLocked(scope) != nil
}

func (h *runtimeHub) closeAll() {
	h.mu.Lock()
	clients := make([]*runtimeClient, 0, len(h.clients))
	for _, client := range h.clients {
		clients = append(clients, client)
	}
	h.mu.Unlock()
	for _, client := range clients {
		h.detach(client, errors.New("server stopped"))
	}
}

func (h *runtimeHub) state() json.RawMessage {
	return h.stateFor(agentScope{})
}

func (h *runtimeHub) stateFor(scope agentScope) json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active[scope] == nil {
		return nil
	}
	return append(json.RawMessage(nil), h.active[scope].state...)
}

func (h *runtimeHub) receive(client *runtimeClient, message runtimeEnvelope) error {
	switch message.Type {
	case "state":
		if len(message.Data) == 0 || !json.Valid(message.Data) {
			return errors.New("runtime state is invalid")
		}
		var state struct {
			Focused   bool   `json:"focused"`
			ProjectID string `json:"projectId"`
		}
		if json.Unmarshal(message.Data, &state) != nil {
			return errors.New("runtime state is invalid")
		}
		if state.ProjectID != "" && !projectIDPattern.MatchString(state.ProjectID) {
			return errors.New("runtime project ID is invalid")
		}
		h.mu.Lock()
		if h.clients[client.id] == client {
			becameFocused := state.Focused && !client.focused
			h.sequence++
			client.sequence = h.sequence
			client.state = append(json.RawMessage(nil), message.Data...)
			client.focused = state.Focused
			client.projectID = state.ProjectID
			if becameFocused {
				h.focusSeq++
				client.focusSeq = h.focusSeq
			}
			if becameFocused || h.active[client.scope] == nil {
				h.active[client.scope] = client
			} else if h.active[client.scope] == client {
				h.active[client.scope] = h.bestClientLocked(client.scope)
			}
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

func (h *runtimeHub) command(ctx context.Context, scope agentScope, method string, params json.RawMessage) (json.RawMessage, error) {
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
	pin := h.pins[scope]
	client := h.clients[pin.clientID]
	if client != nil && client.scope != scope {
		client = nil
	}
	if client == nil && pin.owner == "" {
		client = h.active[scope]
	}
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
