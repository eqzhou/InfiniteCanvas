package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteMCPUsesProtectedConnectionFile(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/execute" || r.Header.Get("Authorization") != "Bearer local-secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var request struct {
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Tool != "board.get_state" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"projectId":"board-1"}}`))
	}))
	defer local.Close()

	path := filepath.Join(t.TempDir(), "connection.json")
	data, _ := json.Marshal(map[string]string{"baseUrl": local.URL, "token": "local-secret"})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	server, err := NewRemote(path)
	if err != nil {
		t.Fatal(err)
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"board.get_state","arguments":{}}}`,
	}, "\n") + "\n"
	var output bytes.Buffer
	if err := server.Run(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"projectId":"board-1"`) || !strings.Contains(output.String(), `"isError":false`) {
		t.Fatalf("remote MCP response = %s", output.String())
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRemote(path); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("wide connection permissions were accepted: %v", err)
	}
}
