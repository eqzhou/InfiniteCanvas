package api

import "testing"

func newStreamTestSession() *claudeSession {
	return &claudeSession{id: "claude-stream-test", subs: make(map[*claudeSub]struct{})}
}

func agentMessageTexts(session *claudeSession) []string {
	texts := make([]string, 0, len(session.history))
	for _, event := range session.history {
		if event.Method != "agent/message" {
			continue
		}
		params, ok := event.Params.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := params["text"].(string); ok {
			texts = append(texts, text)
		}
	}
	return texts
}

// The terminal "result" object repeats the full answer. Replaying it after the
// assistant text already streamed would show the user the same reply twice, so
// the fallback must fire only when nothing was emitted during the turn.
func TestClaudeResultFallbackSuppressedAfterAssistantText(t *testing.T) {
	session := newStreamTestSession()
	sawAssistantText := false
	session.handleStreamObject(map[string]any{
		"type":    "assistant",
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "已完成"}}},
	}, &sawAssistantText)
	if !sawAssistantText {
		t.Fatal("assistant text was not recorded")
	}
	session.handleStreamObject(map[string]any{
		"type": "result", "result": "已完成",
	}, &sawAssistantText)

	if got := agentMessageTexts(session); len(got) != 1 || got[0] != "已完成" {
		t.Fatalf("agent/message texts = %v, want exactly one streamed copy", got)
	}
}

// A streamed delta counts as emitted text just as a whole assistant block does.
func TestClaudeResultFallbackSuppressedAfterStreamedDelta(t *testing.T) {
	session := newStreamTestSession()
	sawAssistantText := false
	session.handleStreamObject(map[string]any{
		"type":  "content_block_delta",
		"delta": map[string]any{"type": "text_delta", "text": "部分"},
	}, &sawAssistantText)
	if !sawAssistantText {
		t.Fatal("streamed delta was not recorded as assistant text")
	}
	session.handleStreamObject(map[string]any{
		"type": "result", "result": "部分结果",
	}, &sawAssistantText)

	if got := agentMessageTexts(session); len(got) != 0 {
		t.Fatalf("agent/message texts = %v, want none (delta uses agent/message_delta)", got)
	}
}

// When the provider streams nothing, the result text is the only answer the user
// would ever see, so the fallback must still fire.
func TestClaudeResultFallbackFiresWhenNoAssistantTextStreamed(t *testing.T) {
	session := newStreamTestSession()
	sawAssistantText := false
	session.handleStreamObject(map[string]any{
		"type": "result", "result": "仅有结果",
	}, &sawAssistantText)

	if got := agentMessageTexts(session); len(got) != 1 || got[0] != "仅有结果" {
		t.Fatalf("agent/message texts = %v, want the result fallback", got)
	}
}
