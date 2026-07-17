# OpenBoard — Clean-room Infinite Canvas Workbench

OpenBoard is intended to be an **independent, clean-room implementation** of an
AI-oriented infinite canvas workbench. Its behavior is specified from public
product documentation and black-box observation, with a separate name, visual
system, data model, and implementation.

The current tree is a working engineering baseline, not a legal certification
or a claim of complete feature parity. Before commercial distribution, audit
the provenance of every existing file and dependency as described in
[`docs/CLEANROOM.md`](docs/CLEANROOM.md). Use
[`docs/RELEASE_AUDIT.md`](docs/RELEASE_AUDIT.md) before distribution.
The neutral behavior record is maintained in
[`docs/BEHAVIOR_SPEC.md`](docs/BEHAVIOR_SPEC.md).

## Why this exists

- Target behavior parity for creative infinite-canvas workflows.
- Avoid copyright entanglement with AGPL-3.0 upstreams by **not copying code,
  assets, or proprietary design tokens**.
- Prefer a portable stack: browser TypeScript canvas UI + optional Go local
  services.

## Go feasibility

| Layer | Go suitable? | Approach |
|-------|--------------|----------|
| Infinite canvas interaction (pan/zoom, nodes, edges) | No (browser DOM/WebGL) | TypeScript/React canvas engine |
| Project/asset persistence API | Yes | Go HTTP + PostgreSQL + Redis + filesystem media |
| Local agent / MCP bridge | Yes | Go process hosting tools |
| AI proxy (optional) | Yes | Go reverse-compatible OpenAI client |
| Pure-Go desktop (Wails/Fyne) | Possible later | Not required for feature parity |

**Conclusion:** full feature parity needs a web canvas. Go is excellent for the
local agent and optional backend, not as a replacement for the interactive
canvas.

## License strategy (avoid disputes)

1. **MIT** only for code independently authored in this repository.
2. **Clean-room**: implement from public docs / observed UX, never paste upstream
   source.
3. **Different names, schemas, file layout, component architecture**.
4. **No logos, screenshots, or assets** from third-party projects.
5. Treat compatibility behavior and protected expression as separate review
   tracks; changing TypeScript to Go does not make copied expression original.
6. Keep an evidence log for specifications, implementation decisions, assets,
   dependency licenses, and similarity reviews.
7. This is not legal advice; commercial release needs qualified counsel.

## Feature parity (phase map)

### Phase 1 — Canvas core (working baseline)
- Multi-project list create/rename/delete/import/export
- Infinite pan/zoom, zoom slider, reset view
- Background modes: dots / lines / blank
- Light/dark theme
- Nodes: text / image / config / video
- Connections, marquee select, multi-select, copy/paste
- Undo/redo for nodes, edges, viewport, background
- Minimap
- Server persistence in the formal local runtime; IndexedDB is a development/offline compatibility mode

### Phase 2 — AI creation
- Browser-direct OpenAI-compatible Base URL + API Key
- Text / image generation & edits
- Video task create + poll (OpenAI-style + Ark plan path)
- Generation config node with upstream text/image inputs

### Phase 3 — Assistant, assets, prompts
- Side assistant with node references
- Local asset library
- Remote prompt catalog cache

### Phase 4 — Local agent (Go)
- Go HTTP companion with validated board tools and atomic project persistence
- Bidirectional browser synchronization while the Agent panel is open
- MCP stdio server with lifecycle, tool discovery, and tool calls

## Verification

```bash
bun run test                         # TypeScript unit tests + Go API tests
bun run build                        # production web build
bun run benchmark:indexes:assert     # 1k/10k spatial-index performance gate
cd web && bun run test:e2e           # Chromium critical flows
cd web && bun run test:e2e:production # production-build SPA + isolated Go data dir
cd server && go test -race ./... && go vet ./...
```

GitHub Actions runs the web tests, typecheck, production build, performance
assertion, multi-project Playwright E2E suite, Go race detector/vet/build, and
container build plus a hardened runtime smoke test on pull requests. The Bun
coverage report reaches 86.02% lines and 88.13% functions for covered
library/service modules; browser-only UI and persistence paths are validated by
Playwright and are outside that report.

## Quick start

### Web

```bash
cd web
bun install
bun run dev
```

Open http://localhost:5173

`5173` is the Vite development server. The formal local runtime is built with
`VITE_OPENBOARD_STORAGE=server`: projects and application metadata are persisted
through Go into PostgreSQL, Redis provides short-lived project caching, and
media bytes live in the protected Go data directory. IndexedDB remains only for
development/offline compatibility. On the first formal launch, legacy browser
data is migrated only when the server database is completely empty; the browser
stores are cleared after a successful migration.

For the optional Go Agent, the panel supports an explicit Local URL and a
session-only connect token. Browser project synchronization and validated board
tools are covered by the real-Go Chromium E2E flow. Codex app-server transport
and local HTTP session/message/approval/SSE endpoints are available, along with
a basic browser conversation and approval surface. Advanced app-server methods
and rich turn rendering remain under active development.

### Formal local use

After configuring `.env` with the installed PostgreSQL and Redis instances, use:

```bash
bun run start:local
```

This command validates the required database, Redis, token, and encryption-key
settings; builds the SPA with server storage enabled; starts the Go service; and
serves the production build at http://localhost:5173. Projects and application
state are stored in PostgreSQL, Redis is used only as a disposable cache, and
media is stored under the user-scoped OpenBoard data directory. `bun run dev`
is the frontend development mode and must not be used as the formal local data
entry point.

The database-backed end-to-end test uses a temporary `openboard_e2e_*` database,
Redis database 14, and a temporary media directory. It force-cleans all three
before and after the run:

```bash
bun run test:e2e:formal
```

### File-mode Go server

```bash
cd server
go run ./cmd/server
```

Default: http://127.0.0.1:8790
Without `OPENBOARD_DATABASE_URL`, project data is stored in the user-scoped OpenBoard config
directory. Set `OPENBOARD_DATA` explicitly to choose another location; the
container deployment uses its isolated `/data` volume.

### Production container

The production image contains a prebuilt Vite SPA, a non-root Nginx listener,
and the Go API bound only to loopback inside the container. Nginx serves the app
and proxies `/api/`. PostgreSQL is the authoritative project/state store, Redis
is a disposable cache, and media files live in the OpenBoard data volume.

```bash
cp .env.example .env
# Set token, PostgreSQL/Redis passwords, and the AES master key in .env.
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:8080/healthz
```

Open http://localhost:8080. Stop it with `docker compose down`; add `-v` only
when the persisted server data should also be deleted. In the Local Agent panel,
use the page origin (`http://localhost:8080` by default) to connect through the
bundled `/api/` reverse proxy; port `8790` is intentionally not published.

Compose binds the host port to `127.0.0.1` by default, so a personal deployment
is not reachable from the LAN. Set `OPENBOARD_BIND` only when deliberately
placing the service behind an authenticated TLS reverse proxy. `OPENBOARD_TOKEN`
is required by Compose and should be a long random value.

The container runs as an unprivileged user, drops Linux capabilities, uses a
read-only root filesystem, and writes only to `/data` plus its in-memory `/tmp`.
Terminate TLS at a trusted reverse proxy for internet-facing deployments and
set `OPENBOARD_ORIGINS` to the exact public origin. Do not publish the internal
Go port. When `OPENBOARD_TOKEN` is set, the bundled reverse proxy injects it
server-side for `/api/` and `/healthz`; the token is never shipped in the SPA.

To build and run without Compose:

```bash
docker build -t openboard:local .
export OPENBOARD_TOKEN="$(openssl rand -hex 32)"
docker run --rm --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,size=128m \
  -p 127.0.0.1:8080:8080 \
  -v openboard-data:/data \
  -e OPENBOARD_TOKEN \
  -e OPENBOARD_ORIGINS=http://127.0.0.1:8080 \
  openboard:local
```

## Tech stack

- **Web:** Vite, React 19, TypeScript, Zustand, idb-keyval, Tailwind
- **Server:** Go 1.26.5+, chi router, pgx/PostgreSQL, go-redis, filesystem media storage

### Product boundary: local single-user mode

OpenBoard formal local mode is single-user and protected by the local reverse
proxy token. It does not provide registration, login, multi-tenant permissions,
or cross-device accounts. PostgreSQL stores projects and application metadata;
Redis is a cache; media stays in the service-owned file volume. Provider API keys
are encrypted with AES-GCM using `OPENBOARD_MASTER_KEY`; PostgreSQL stores only
the nonce/ciphertext envelope, and WebDAV backups never contain those keys.

This boundary matches the personal/local deployment target. It must not be
described as a hosted multi-user SaaS product until accounts, memberships,
server-side encrypted provider secrets, and tenant isolation are implemented.

## Clean-room notes

See [docs/CLEANROOM.md](docs/CLEANROOM.md) and [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md).

## Disclaimer

OpenBoard is not affiliated with, endorsed by, or derived from any specific
third-party canvas product. Product names mentioned in research notes are for
interoperability comparison only.
