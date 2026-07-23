# Browser Claude conversation UI

OpenBoard embeds a **Claude** tab in the Local Agent panel. It does **not** automate claude.ai web pages.

## How it works
1. Backend finds the local `claude` CLI (`PATH` or `OPENBOARD_CLAUDE_BIN`).
2. Each turn runs: `claude -p --output-format stream-json --verbose --include-partial-messages`.
3. Stream events are forwarded over SSE (`/api/claude/events`) to the browser panel.
4. When `openboard-mcp` is installed, a temporary MCP config is passed so Claude can call board tools (with OpenBoard connection file permissions).

## Use
1. Ensure Claude Code is installed and logged in (`claude` works in a terminal).
2. Open OpenBoard → Local Agent → connect to the local server.
3. Open the **Claude** tab → 开始 Claude 会话 → send prompts.

## Notes
- Independent of Codex sessions (separate profiles/managers).
- Clean-room implementation inspired by public canvas-agent docs that describe a Claude CLI stream-JSON path; no upstream source was copied.
