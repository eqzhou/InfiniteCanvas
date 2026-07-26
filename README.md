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
- Persistent image/video/audio generation jobs, history, retry, cancel, and canvas insertion; the image workbench adds side/bottom layouts, concurrent runs, persistent categories and filtering, reference/result previews with byte sizes, reusable assets, and a draggable workflow entrance; formal OpenAI/Gemini/restricted-Template image, OpenAI/Ark/restricted-Template video, OpenAI audio, and multi-step image workflows execute in the Go service and continue across browser reloads, including indexed canvas image batches
- Public/personal image workflow templates with typed variables, DAG references, AI-assisted draft creation, durable step checkpoints, image-history children, and atomic canvas insertion
- WebDAV project and full-workspace backup/restore for projects, assets, prompts, workflow templates, history, and deduplicated media

### Phase 3 — Independent plugins
- Manifest v2 permissions, registry install/enable/disable/upgrade/rollback/uninstall
- Host-mediated node, asset, panel, and AI APIs without key exposure
- Plugin SDK plus sticky-note, Markdown, HTML, SVG, and Three.js panorama examples
- Prompt tags, multiple refreshable remote sources, cover/result galleries, and canvas insertion

### Phase 4 — Browser and Codex agent runtime
- Multi-tab ticketed WebSocket with live state, atomic operations, snapshots, assets, prompts, and navigation
- MCP stdio and owner-only remote connection file with compatibility tools
- Client-scoped `generation_get_status` for canvas and workbench tasks
- Continuous shared Codex threads, cross-tab running state, safe Markdown, structured logs, stop, attachments, and approvals
- Per-node camera prompt controls for image/video/config generation, with structured camera/lens/focal-length/aperture persistence and retry-safe prompt assembly
- Native director scene v4 with visual catalogs for eight procedural character looks and twenty poses, actor/extra staging, six primitive geometries, bounded instanced crowd arrays, named multi-camera shots, independent director/camera views, composition guides, bounded browser-local GLB import/relink, interactive move/rotate/scale controls, and a screenshot tray that uses protected cross-device storage in formal mode while retaining offline IndexedDB compatibility
- Native panorama nodes with strict 2:1 upload/reuse, ordinary managed image references, fixed 2048x1024 AI generation, controlled quality and 1–8 result batches, 360° viewing, durable atomic commit, and director environment handoff
- Codex user bubbles, open assistant replies, auto-scroll, jump-to-bottom, and attachment-to-canvas image/config flow
- Independent OpenBoard Codex plugin installer and standard Claude MCP instructions

### Optional product features
- Optional Google Analytics 4 / Baidu analytics via `VITE_ANALYTICS_GA4_ID` / `VITE_ANALYTICS_BAIDU_ID` or `window.__RUNTIME_CONFIG__` (default off)
- Top-bar version badge opens a local CHANGELOG release modal
- Canvas sidebar asset tab can upload image/video assets

### Public Unreleased prompt-source delta
- Add/edit/disable/remove remote prompt sources with scheduled refresh
- Built-in catalogs load Image Prompts unified JSON (including Banana Prompt Quicker)
- Source cards show item count, sync status, and last success time
- Independent source cache keeps last success when refresh fails
- Prompt center 「我的提示词」: local manage, save from public library, canvas use
- Canvas prompt library cross-source search and title-preserving insert

The detailed evidence matrix is [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md).

## Verification

```bash
bun run test                         # TypeScript unit tests + Go API tests
bun run build                        # production web build
bun run benchmark:indexes:assert     # 1k/10k spatial-index performance gate
bun run audit:vulnerabilities        # fail-closed OSV scan for installed npm and Go modules
cd web && bun run test:e2e            # Chromium, Firefox, WebKit, mobile Chromium
cd web && bun run test:e2e:production # production-build SPA + isolated Go data dir
bun run test:e2e:formal               # temporary PostgreSQL + Redis DB 14 + media
cd server && go test -race ./... && go vet ./...
```

GitHub Actions runs the web tests, typecheck, production build, performance
assertion, OSV dependency audit, cross-browser and production Playwright suites, Go race
detector/vet/build, and container build plus a hardened runtime smoke test on
pull requests. The current Bun coverage report reaches 81.94% lines and 86.00% functions for covered
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
is a disposable cache, and protected media uses the OpenBoard data volume by
default. Set the optional `OPENBOARD_BLOB_BACKEND=s3` variables documented in
[`server/README.md`](server/README.md) to use AWS S3, Cloudflare R2, or a
compatible private object store instead.

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
- **Server:** Go 1.26.5+, chi router, pgx/PostgreSQL, go-redis, protected filesystem or S3/R2 media storage

### Product boundary: local deployment with optional accounts

OpenBoard remains a self-hosted/local product. Authentication can be disabled
for a token-protected single-user installation, or enabled in optional/required
mode for email login, Linux.do OAuth, tenant-scoped users, roles, projects,
application state, generation jobs, blobs and usage quotas. Site administrators
can control registration, custom channels and use of backend/cloud channels.

PostgreSQL stores authoritative application data, Redis is a disposable cache,
and media stays in protected service storage or a configured private S3/R2
backend. Provider and object-storage secrets are encrypted with AES-GCM using
`OPENBOARD_MASTER_KEY`; PostgreSQL stores only nonce/ciphertext envelopes, and
WebDAV backups never contain those keys.

This is not a hosted SaaS marketplace: there is no external payment processor,
organization-wide enterprise SSO or managed public hosting control plane.

## Clean-room notes

See [docs/CLEANROOM.md](docs/CLEANROOM.md) and [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md).

## Disclaimer

OpenBoard is not affiliated with, endorsed by, or derived from any specific
third-party canvas product. Product names mentioned in research notes are for
interoperability comparison only.
