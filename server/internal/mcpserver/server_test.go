package mcpserver

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitializeAndListTools(t *testing.T) {
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
	}, "\n") + "\n"
	var output bytes.Buffer

	if err := New(t.TempDir()).Run(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("responses = %d: %s", len(lines), output.String())
	}
	if !strings.Contains(lines[0], `"protocolVersion":"2025-11-25"`) || !strings.Contains(lines[0], `"tools"`) {
		t.Fatalf("initialize response = %s", lines[0])
	}
	if !strings.Contains(lines[1], `"board.list_nodes"`) || !strings.Contains(lines[1], `"inputSchema"`) {
		t.Fatalf("tools response = %s", lines[1])
	}
	for _, name := range []string{"board.get_state", "board.apply_ops", "board.export_snapshot", "asset.search", "prompt.insert", "site.navigate", "generation_get_status"} {
		if !strings.Contains(lines[1], `"`+name+`"`) {
			t.Fatalf("tools response does not contain %s: %s", name, lines[1])
		}
	}
	for _, name := range []string{"film.status", "film.list", "film.check", "film.proposals", "film.validate", "film.run_stage", "film.next_steps", "film.approve_stage", "film.apply_repair", "film.export"} {
		if !strings.Contains(lines[1], `"`+name+`"`) {
			t.Fatalf("tools response does not contain %s: %s", name, lines[1])
		}
	}
	for _, field := range []string{`"providerId"`, `"model"`, `"config"`, `"idempotencyKey"`} {
		if !strings.Contains(lines[1], field) {
			t.Fatalf("film.run_stage schema does not expose generation input %s: %s", field, lines[1])
		}
	}
	if !strings.Contains(lines[1], `"destructiveHint":true`) || !strings.Contains(lines[1], `"openWorldHint":true`) {
		t.Fatalf("privileged Film tools do not declare confirmation-relevant annotations: %s", lines[1])
	}
}

func TestCallToolUsesBoardStore(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	project := `{"id":"board-1","title":"Board","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z","nodes":[{"id":"node-1","type":"text","title":"One","position":{"x":0,"y":0},"width":200,"height":100,"metadata":{}}],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`
	if err := os.WriteFile(filepath.Join(dataDir, "projects", "board-1.json"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"board.list_nodes","arguments":{"projectId":"board-1"}}}`,
	}, "\n") + "\n"
	var output bytes.Buffer

	if err := New(dataDir).Run(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"node-1"`) || !strings.Contains(output.String(), `"isError":false`) {
		t.Fatalf("tool response = %s", output.String())
	}
}

func TestRejectsToolsBeforeInitialization(t *testing.T) {
	input := `{"jsonrpc":"2.0","id":7,"method":"tools/list"}` + "\n"
	var output bytes.Buffer
	if err := New(t.TempDir()).Run(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"code":-32002`) {
		t.Fatalf("response = %s", output.String())
	}
}
