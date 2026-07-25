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
- `POST /api/generation-jobs/image` — enqueue a server-owned OpenAI-compatible, Gemini, or restricted declarative-Template image generation/edit job
- `POST /api/generation-jobs/video` — enqueue an OpenAI or Ark/Seedance task with a durable upstream-task checkpoint, or a synchronous restricted declarative-Template video job
- `POST /api/generation-jobs/audio` — enqueue an OpenAI-compatible speech job
- `POST /api/generation-jobs/workflow` — enqueue a durable typed image workflow whose deterministic child jobs use the image worker pool
- `POST /api/generation-jobs/{id}/cancel` — idempotently cancel a server-owned queued/running job
- `GET|PUT /api/workflow-templates` and `PUT|DELETE /api/workflow-templates/{id}` — tenant-isolated personal workflow template storage and atomic replacement
- `GET|POST|DELETE /api/director-captures...` — tenant-isolated director screenshot metadata backed by protected PNG blobs; `PUT /api/director-captures/prune` reclaims deleted-project and expired orphan media

Server-owned image, video, audio, and workflow generation requires a valid user session unless
`OPENBOARD_AUTH_MODE=off`; single-user `off` mode additionally requires a
valid `OPENBOARD_TOKEN` Bearer credential so stored provider credentials cannot
be read or spent by an anonymous caller. Generation workers use renewable,
attempt-scoped PostgreSQL leases. The default filesystem backend requires
every API/worker instance to mount the same `OPENBOARD_DATA` blob volume. An
S3-compatible backend removes that shared-volume requirement while keeping all
media behind the authenticated `/api/blobs/*` endpoints. Video and audio use
independent worker claim domains; a recovered video lease resumes its persisted
provider task instead of creating a second upstream task. OpenAI-compatible and
Gemini and restricted-Template canvas image/config/prompt actions can create indexed durable batches;
OpenAI, Ark/Seedance, and restricted-Template video actions use the same durable placeholder recovery,
as do OpenAI audio actions. Their protected results reconcile after a browser reload.
Template execution accepts only bounded JSON objects, exact known placeholders,
safe relative paths, POST/PUT, and Bearer or `x-api-key` authentication. It does
not execute user scripts, follow redirects, or permit provider credentials in URLs;
expanded request bodies are size-accounted before JSON marshaling.

### S3 / Cloudflare R2 media

In formal mode, authenticated tenants may also enable S3/R2 under Settings. Non-secret fields persist in `state/config`; credentials stay in encrypted `/api/secrets/config`. When enabled and valid, that tenant's protected media uses the user backend ahead of process-level `OPENBOARD_S3_*`. Invalid enabled credentials fail closed; disabling falls back to process/filesystem storage.

Set these server-only variables to store protected canvas, asset, workbench,
panorama, director-capture, and workflow media in an S3-compatible bucket:

```bash
OPENBOARD_BLOB_BACKEND=s3
OPENBOARD_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
OPENBOARD_S3_BUCKET=openboard-media
OPENBOARD_S3_REGION=auto
OPENBOARD_S3_PREFIX=openboard
OPENBOARD_S3_ACCESS_KEY_ID=...
OPENBOARD_S3_SECRET_ACCESS_KEY=...
```

`OPENBOARD_S3_SESSION_TOKEN` is optional. The endpoint must use HTTPS;
`OPENBOARD_S3_ALLOW_INSECURE_LOOPBACK=true` permits HTTP only for loopback
MinIO development. Objects use tenant-hashed private keys, SigV4 requests,
conditional writes, and deletion tombstones so concurrent overwrite/delete
does not cross tenants or leak quota reservations. Bucket credentials are
never returned to the web app and no public bucket URL is required.

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
