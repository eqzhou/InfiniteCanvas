package mcpserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/openboard/openboard/server/internal/api"
)

const latestProtocolVersion = "2025-11-25"

var supportedProtocolVersions = map[string]struct{}{
	"2025-11-25": {},
	"2025-06-18": {},
	"2025-03-26": {},
}

type Server struct {
	tools               toolExecutor
	initializeResponded bool
	ready               bool
}

type toolExecutor interface {
	ExecuteTool(string, json.RawMessage) (any, error)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type initializeParams struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ClientInfo      map[string]any `json:"clientInfo"`
}

type callToolParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func New(dataDir string) *Server {
	return &Server{tools: api.NewServer(dataDir)}
}

func newWithExecutor(executor toolExecutor) *Server {
	return &Server{tools: executor}
}

func (s *Server) Run(ctx context.Context, input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		response := s.handle(scanner.Bytes())
		if response != nil {
			if err := encoder.Encode(response); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read MCP stdio: %w", err)
	}
	return nil
}

func (s *Server) handle(line []byte) *rpcResponse {
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return failure(nil, -32700, "Parse error")
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		return failure(request.ID, -32600, "Invalid Request")
	}

	if request.Method == "notifications/initialized" && len(request.ID) == 0 {
		if s.initializeResponded {
			s.ready = true
		}
		return nil
	}
	if len(request.ID) == 0 {
		return nil
	}
	if request.Method == "ping" {
		return success(request.ID, map[string]any{})
	}
	if request.Method == "initialize" {
		return s.initialize(request)
	}
	if !s.ready {
		return failure(request.ID, -32002, "Server is not initialized")
	}

	switch request.Method {
	case "tools/list":
		return success(request.ID, map[string]any{"tools": boardTools})
	case "tools/call":
		return s.callTool(request)
	default:
		return failure(request.ID, -32601, "Method not found")
	}
}

func (s *Server) initialize(request rpcRequest) *rpcResponse {
	var params initializeParams
	if err := decodeParams(request.Params, &params); err != nil || params.ProtocolVersion == "" {
		return failure(request.ID, -32602, "Invalid initialize parameters")
	}
	version := latestProtocolVersion
	if _, supported := supportedProtocolVersions[params.ProtocolVersion]; supported {
		version = params.ProtocolVersion
	}
	s.initializeResponded = true
	return success(request.ID, map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		"serverInfo": map[string]any{
			"name":    "openboard-local",
			"version": "0.2.0",
		},
		"instructions": "Use the board tools to inspect and edit projects persisted by OpenBoard's local companion.",
	})
}

func (s *Server) callTool(request rpcRequest) *rpcResponse {
	var params callToolParams
	if err := decodeParams(request.Params, &params); err != nil || params.Name == "" {
		return failure(request.ID, -32602, "Invalid tool call parameters")
	}
	if !knownTool(params.Name) {
		return failure(request.ID, -32602, "Unknown tool")
	}
	if len(params.Arguments) == 0 {
		params.Arguments = json.RawMessage(`{}`)
	}
	data, err := s.tools.ExecuteTool(params.Name, params.Arguments)
	if err != nil {
		return success(request.ID, map[string]any{
			"content": []map[string]any{{"type": "text", "text": err.Error()}},
			"isError": true,
		})
	}
	text, err := json.Marshal(data)
	if err != nil {
		return failure(request.ID, -32603, "Failed to encode tool result")
	}
	return success(request.ID, map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(text)}},
		"structuredContent": map[string]any{"data": data},
		"isError":           false,
	})
}

func decodeParams(raw json.RawMessage, destination any) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("multiple parameter values")
	}
	return nil
}

func success(id json.RawMessage, result any) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: normalizeID(id), Result: result}
}

func failure(id json.RawMessage, code int, message string) *rpcResponse {
	return &rpcResponse{
		JSONRPC: "2.0",
		ID:      normalizeID(id),
		Error:   &rpcError{Code: code, Message: message},
	}
}

func normalizeID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}
