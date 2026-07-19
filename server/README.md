# OpenBoard local server (Go)

Optional companion process for OpenBoard.

## Run

```bash
go run ./cmd/server
```

Listens on `127.0.0.1:8790` by default. The local Vite origins are allowed for
cross-origin requests; additional origins must be explicit:

```bash
OPENBOARD_ADDR=127.0.0.1:8790 \
OPENBOARD_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
go run ./cmd/server
```

Non-loopback binding is refused. For remote access, keep the service on
loopback and place an authenticated TLS reverse proxy on the same host.
`OPENBOARD_TOKEN` can additionally protect loopback clients with
`Authorization: Bearer <token>`. The service also applies project/file size
limits, upload concurrency and disk quotas, and cross-process write locking.

## Endpoints

- `GET /api/health`
- `GET /api/version`
- `GET /api/agent/status` — local board tools and bridge status
- `POST /api/runtime/ticket`, `GET /api/runtime/ws` — ticketed browser runtime
- `POST /api/runtime/command` — execute an identified command in the bound tab
- `GET /api/codex/session?profile=...` — inspect the shared session and running state
- `POST /api/codex/session` — start a local `codex app-server --stdio` session
- `POST /api/codex/message` — start a streamed turn (`sessionId`, `text`)
- `POST /api/codex/interrupt` — stop the active turn
- `POST /api/codex/attachments` — upload bounded owner-only images
- `DELETE /api/codex/attachments/{id}?sessionId=...` — cancel a pending image attachment
- `POST /api/codex/approval` — explicitly approve or deny a server request
- `GET /api/codex/events?sessionId=...` — SSE notifications and approval requests
- `DELETE /api/codex/session/{id}` — close a Codex session
- `POST /api/files` — multipart upload
- `GET /api/files/{name}`
- `GET|PUT|DELETE /api/projects...` — optional server-side project mirror
- `GET|POST|PUT|DELETE /api/generation-jobs...` — paginated workbench history

The interactive infinite canvas remains in the web app. Go owns local services,
file persistence helpers, and the optional local Codex bridge. Codex startup is
opt-in at runtime and requires the `codex` executable (or `OPENBOARD_CODEX_BIN`)
to be available on the host.

## Agent tools

`POST /api/agent/execute` accepts a tool name and validated arguments. The web
Agent panel synchronizes newer browser/server project revisions every two
seconds while open.

Live browser tools include state, selection, PNG snapshot, atomic operations,
text/image flows, asset/prompt search and insertion, navigation, and
`generation_get_status`. The six persisted compatibility tools remain:
`board.list_nodes`, `board.add_node`, `board.update_node`,
`board.delete_nodes`, `board.connect`, and `board.export_json`.

## MCP stdio

Run the same tools through the standard MCP stdio transport:

```bash
OPENBOARD_DATA=/absolute/path/to/openboard-data go run ./cmd/mcp
```

Example client configuration after building `./bin/openboard-mcp`:

```json
{
  "mcpServers": {
    "openboard": {
      "command": "/absolute/path/to/openboard-mcp",
      "env": { "OPENBOARD_DATA": "/absolute/path/to/openboard-data" }
    }
  }
}
```
