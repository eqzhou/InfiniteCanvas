package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	runtimeTicketTTL      = 30 * time.Second
	runtimeTicketProtocol = "openboard."
)

func RuntimeSocketTicket(r *http.Request) string {
	if ticket := strings.TrimSpace(r.URL.Query().Get("ticket")); ticket != "" {
		return ticket
	}
	for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if token, ok := strings.CutPrefix(protocol, runtimeTicketProtocol); ok {
			if token = strings.TrimSpace(token); token != "" {
				return token
			}
		}
	}
	return ""
}

type websocketRuntimeTransport struct {
	connection *websocket.Conn
	mu         sync.Mutex
}

func (t *websocketRuntimeTransport) Write(ctx context.Context, message []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.connection.Write(ctx, websocket.MessageText, message)
}

func (t *websocketRuntimeTransport) Close() error {
	return t.connection.Close(websocket.StatusNormalClosure, "runtime closed")
}

func (s *Server) runtimeTicket(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > 0 {
		http.Error(w, "runtime ticket request must be empty", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{
		"ticket":      s.runtime.issueTicket(requestAgentScope(r), runtimeTicketTTL),
		"expiresInMs": runtimeTicketTTL.Milliseconds(),
	})
}

func (s *Server) runtimeSocket(w http.ResponseWriter, r *http.Request) {
	ticket := RuntimeSocketTicket(r)
	scope, ok := s.runtime.consumeTicket(ticket)
	if !ok {
		http.Error(w, "runtime ticket is invalid or expired", http.StatusUnauthorized)
		return
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		if !isLoopbackRemote(r.RemoteAddr) {
			http.Error(w, "runtime origin is not allowed", http.StatusForbidden)
			return
		}
	} else if _, allowed := s.runtimeOrigins[origin]; !allowed {
		http.Error(w, "runtime origin is not allowed", http.StatusForbidden)
		return
	}
	accept := &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Origin was checked against the server allowlist above.
	}
	if strings.HasPrefix(r.Header.Get("Sec-WebSocket-Protocol"), runtimeTicketProtocol) {
		accept.Subprotocols = []string{runtimeTicketProtocol + ticket}
	}
	connection, err := websocket.Accept(w, r, accept)
	if err != nil {
		return
	}
	connection.SetReadLimit(maxRuntimeMessageBytes)
	transport := &websocketRuntimeTransport{connection: connection}
	client := s.runtime.attach(scope, transport)
	defer s.runtime.detach(client, errors.New("browser disconnected"))
	ready, _ := json.Marshal(runtimeEnvelope{
		Type: "ready",
		Data: json.RawMessage(fmt.Sprintf(`{"clientId":%q}`, client.id)),
	})
	if err := transport.Write(r.Context(), ready); err != nil {
		return
	}
	for {
		kind, data, err := connection.Read(r.Context())
		if err != nil {
			return
		}
		if kind != websocket.MessageText || len(data) > maxRuntimeMessageBytes {
			_ = connection.Close(websocket.StatusUnsupportedData, "text messages only")
			return
		}
		var message runtimeEnvelope
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&message) != nil || ensureJSONEOF(decoder) != nil {
			_ = connection.Close(websocket.StatusPolicyViolation, "invalid runtime message")
			return
		}
		if err := s.runtime.receive(client, message); err != nil {
			_ = connection.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
	}
}

func (s *Server) runtimeCommand(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAgentRequestBytes)
	var request struct {
		Method    string          `json:"method"`
		Params    json.RawMessage `json:"params"`
		TimeoutMS int             `json:"timeoutMs"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || ensureJSONEOF(decoder) != nil || request.Method == "" {
		http.Error(w, "invalid runtime command", http.StatusBadRequest)
		return
	}
	if request.TimeoutMS == 0 {
		request.TimeoutMS = 10_000
	}
	if request.TimeoutMS < 100 || request.TimeoutMS > 30_000 {
		http.Error(w, "runtime timeout must be between 100 and 30000ms", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(request.TimeoutMS)*time.Millisecond)
	defer cancel()
	result, err := s.runtime.command(ctx, requestAgentScope(r), request.Method, request.Params)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result)
}
