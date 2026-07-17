# OpenBoard — Clean-room Infinite Canvas Workbench

OpenBoard is intended to be an **independent, clean-room implementation** of an
AI-oriented infinite canvas workbench. Its behavior is specified from public
product documentation and black-box observation, with a separate name, visual
system, data model, and implementation.

The current tree implements the frozen v0.8.2 engineering behavior baseline,
but it is not a legal certification or a claim of identical protected
expression. Before commercial distribution, audit
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

## v0.8.2 feature delivery

### Phase 1 — Versioned canvas core
- Multi-project list create/rename/delete/import/export
- Infinite pan/zoom, zoom slider, reset view
- Background modes: dots / lines / blank
- Light/dark theme
- Nodes: text / image / config / video
- Connections, marquee select, multi-select, copy/paste
- Undo/redo for nodes, edges, viewport, background
- Minimap
- Schema v2 migration, title editing, blank-canvas chooser, drag-in/out groups
- Node font/model/prompt overrides and immediate text-to-image flow
- Server persistence in the formal local runtime; IndexedDB is a development/offline compatibility mode

### Phase 2 — AI creation and workbenches
- Independent text/image/video/audio endpoints and encrypted credentials
- OpenAI, Ark/Seedance, Gemini, and restricted Template protocols
- Transparent images, reverse prompting, adjustable split guides, and lineage
- Reproducible image retries with reference protection and expandable result batches
- Direct text/image-to-video creation with smart duration and provider preflight validation
- Persistent image/video generation jobs, history, retry, cancel, and canvas insertion

### Phase 3 — Independent plugins
- Manifest v2 permissions, registry install/enable/disable/upgrade/rollback/uninstall
- Host-mediated node, asset, panel, and AI APIs without key exposure
- Plugin SDK plus sticky-note, Markdown, HTML, SVG, and Three.js panorama examples
- Prompt tags, multiple refreshable remote sources, cover/result galleries, and canvas insertion

### Phase 4 — Browser and Codex agent runtime
- Ticketed WebSocket with live state, atomic operations, snapshots, assets, prompts, and navigation
- MCP stdio and owner-only remote connection file with compatibility tools
- Continuous Codex threads, safe Markdown, structured logs, stop, attachments, and approvals
- Independent OpenBoard Codex plugin installer and standard Claude MCP instructions

The detailed evidence matrix is [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md).

## Verification

```bash
bun run test                         # TypeScript unit tests + Go API tests
bun run build                        # production web build
bun run benchmark:indexes:assert     # 1k/10k spatial-index performance gate
cd web && bun run test:e2e            # Chromium, Firefox, WebKit, mobile Chromium
cd web && bun run test:e2e:production # production-build SPA + isolated Go data dir
bun run test:e2e:formal               # temporary PostgreSQL + Redis DB 14 + media
cd server && go test -race ./... && go vet ./...
```

GitHub Actions runs the web tests, typecheck, production build, performance
assertion, cross-browser and production Playwright suites, Go race
detector/vet/build, and container build plus a hardened runtime smoke test on
pull requests. The Bun coverage report reaches 84.60% lines and 86.50% functions for covered
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
session-only connect token. Browser project synchronization, live runtime
commands, protected snapshots, MCP, continuous Codex threads, safe Markdown,
image attachments, stop, structured logs, and approvals are covered by Go and
browser integration tests.

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

The database-backed end-to-end test uses one uniquely named
`openboard_e2e_*` database, Redis database 14, and a temporary media directory.
Cleanup is scoped to that exact run; the test verifies zero residue afterward
without enumerating or modifying unrelated databases:

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
