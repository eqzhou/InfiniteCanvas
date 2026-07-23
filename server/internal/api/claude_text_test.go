package api

import "testing"

func TestExtractClaudeTextAndDelta(t *testing.T) {
	text := extractClaudeText(map[string]any{
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "hello "},
				map[string]any{"type": "text", "text": "world"},
			},
		},
	})
	if text != "hello world" {
		t.Fatalf("extractClaudeText=%q", text)
	}
	delta := extractClaudeDelta(map[string]any{
		"event": map[string]any{
			"delta": map[string]any{"text": "partial"},
		},
	})
	if delta != "partial" {
		t.Fatalf("extractClaudeDelta=%q", delta)
	}
}
