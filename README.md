# OpenBoard — Clean-room Infinite Canvas Workbench

OpenBoard is intended to be an **independent, clean-room implementation** of an
AI-oriented infinite canvas workbench. Its behavior is specified from public
product documentation and black-box observation, with a separate name, visual
system, data model, and implementation.

The current tree implements the frozen v0.8.2 engineering behavior baseline
plus the later public deltas recorded in `docs/BEHAVIOR_SPEC.md` and the Tiger
v0.4.5 convergence recorded in `docs/TIGER_GAP_PLAN_4.md`. It is not a legal
certification or a claim of identical protected expression. Before commercial distribution, audit
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

## Current feature delivery

### Phase 1 — Versioned canvas core
- Multi-project list create/rename/delete/import/export
- Infinite pan/zoom, zoom slider, reset view
- Background modes: dots / lines / blank
- Light/dark theme
- Nodes: text / image / config / video / audio / panorama / director / plugin, plus group containers
- Connections, marquee select, multi-select, copy/paste
- Undo/redo for nodes, edges, viewport, background
- Minimap
- Schema v2 migration, title editing, blank-canvas chooser, drag-in/out groups
- Node font/model/prompt overrides and immediate text-to-image flow
- Database-backed server persistence in every runtime

### Phase 2 — AI creation and workbenches
- Independent text/image/video/audio endpoints and encrypted credentials
- OpenAI-compatible, Ark/Seedance, Gemini, APIMart, KIE, and restricted Template protocols
- Exact APIMart contracts for Seedream 5.0 Pro, Gemini 3.1 Flash Lite Image / Nano Banana 2 Lite, HappyHorse 1.1, Kling 3.0 Turbo, Kling 2.6/v3, and Seedance 2.0 variants; undocumented names such as Agnes fail closed
- Transparent images, reverse prompting, adjustable split guides, and lineage
- Reproducible image retries with reference protection and expandable result batches
- Direct text/image-to-video creation with smart duration and provider preflight validation
- Local Codex Agent Skills management: editable drafts from the current canvas, enable/disable/delete, bounded local/guest-only storage, and explicit invocation through the existing session permission and approval boundary
- Persistent image/video/audio generation jobs, history, retry, cancel, soft-delete tombstones, and canvas insertion; stale restore/update paths cannot resurrect deleted jobs. The image workbench adds side/bottom layouts, concurrent runs, persistent categories and filtering, reference/result previews with byte sizes, reusable assets, a draggable workflow entrance, common aspect-ratio presets, and per-channel/per-kind model preferences. Formal OpenAI/Gemini/APIMart/KIE/restricted-Template image, OpenAI/Ark/APIMart/KIE/restricted-Template video, OpenAI audio, and multi-step image workflows execute in the Go service and continue across browser reloads, including indexed canvas image batches
- Public/personal image workflow templates with typed variables, DAG references, AI-assisted draft creation, durable step checkpoints, image-history children, and atomic canvas insertion
- WebDAV project and full-workspace backup/restore for projects, assets, prompts, workflow templates, history, and deduplicated media
- Local Film Production Mode: text/DOCX/text-layer PDF intake, review-gated decomposition, script → storyboard → first frame → parallel audio/video → compose → delivery stages, versioned character identities/dialogue, real canvas projection/adoption, multitrack timeline, quality/repair history, scoped provider jobs, and persistent cancellable manifest/SRT/asset-bundle/MP4 exports; MP4 assembly is an optional FFmpeg/FFprobe capability

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
- Native director scene v4 with visual catalogs for eight procedural character looks and twenty poses, actor/extra staging, six primitive geometries, bounded instanced crowd arrays, named multi-camera shots, independent director/camera views, composition guides, protected server-backed GLB import/relink, interactive move/rotate/scale controls, and a protected cross-device screenshot tray
- Native panorama nodes with strict 2:1 upload/reuse, ordinary managed image references, fixed 2048x1024 AI generation, controlled quality and 1–8 result batches, 360° viewing, durable atomic commit, and director environment handoff
- Codex user bubbles, open assistant replies, auto-scroll, jump-to-bottom, and attachment-to-canvas image/config flow
- Independent OpenBoard Codex plugin installer and standard Claude MCP instructions

### Optional product features
- Optional Google Analytics 4 / Baidu analytics via `VITE_ANALYTICS_GA4_ID` / `VITE_ANALYTICS_BAIDU_ID` or `window.__RUNTIME_CONFIG__` (default off)
- Top-bar version badge opens a local CHANGELOG release modal
- Canvas sidebar asset tab can upload image/video assets
- `/help` user guide in desktop and mobile navigation
- Safe GFM rendering in prompt details without raw HTML, executable URL schemes, or remote body-image loading
- Admin channel model reconciliation that previews added/existing/removed models before confirmation

### Public Unreleased prompt-source delta
- Add/edit/disable/remove remote prompt sources with scheduled refresh
- Built-in catalogs load the Image Prompts unified JSON set (including Banana Prompt Quicker) plus the Tiger Xianyu GPT Image 2 structured Markdown catalog
- Image prompt sources accept nested Markdown categories, fenced or numbered prompt blocks, stable IDs, and administrator JSON/Markdown synchronization
- Source cards show item count, sync status, and last success time
- Independent source cache keeps last success when refresh fails
- Prompt center 「我的提示词」: local manage, save from public library, canvas use
- Canvas prompt library cross-source search and title-preserving insert

The current evidence matrix is [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md),
the latest dual-upstream review is [`docs/UPSTREAM_GAP_PLAN_7.md`](docs/UPSTREAM_GAP_PLAN_7.md),
the latest Tiger-specific review is [`docs/TIGER_GAP_PLAN_4.md`](docs/TIGER_GAP_PLAN_4.md),
and the active three-reference increment blueprint is
[`plans/openboard-three-upstream-increment-v0151-v052-v132.md`](plans/openboard-three-upstream-increment-v0151-v052-v132.md).
`TIGER_GAP_PLAN.md`, `_2`, and `_3` are retained only as historical audit records.
For day-to-day use, see the [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) guide for
Agent Skills setup, manual `SKILL.md` examples, local Agent connection, and video
ratio/resolution/size behavior.

## Verification

```bash
bun run test                         # web unit/integration tests + all Go packages
bun run --cwd web test:coverage      # fail unless aggregate function/line coverage is >=80%
bun run build                        # production web build
bun run benchmark:indexes:assert     # 1k/10k spatial-index performance gate
bun run audit:vulnerabilities        # fail-closed OSV scan for installed npm and Go modules
cd web && bun run test:e2e            # Chromium, Firefox, WebKit, mobile Chromium
cd web && bun run test:e2e:production # production-build SPA + isolated Go data dir
bun run test:e2e:formal               # temporary PostgreSQL + Redis DB 14 + media
cd server && go test -race ./... && go vet ./...
```

GitHub Actions runs the web tests, the aggregate 80% function/line coverage gate,
typecheck, production build, performance assertion, OSV/deployment/license/clean-room
audits, an explicit credential-free Film Chromium flow, cross-browser and production
Playwright suites, Go race detector/vet/build, and container build plus a hardened
runtime/media-capability smoke test on pull requests. The dated count and coverage snapshot lives only in
`docs/FEATURE_PARITY.md`; use `bun run test` and the CI result as the live source
of truth. Browser-only UI and persistence paths are validated by Playwright.

## Quick start

### Web

```bash
cd web
bun install
bun run dev
```

Open http://localhost:5173

`5173` is the Vite development server. Every runtime persists projects,
application metadata, generation history, workflow templates, and protected
media through Go into PostgreSQL-backed server storage. Redis provides
short-lived project caching, and media bytes live in the protected Go data
directory. The browser does not keep a second workspace database or run a
login-time data migration.

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
settings; probes FFmpeg and FFprobe; builds the SPA with server storage enabled; starts the Go service; and
serves the production build at http://localhost:5173. Projects and application
state are stored in PostgreSQL, Redis is used only as a disposable cache, and
media is stored under the user-scoped OpenBoard data directory. A missing or invalid
media executable prints a diagnostic and clears both media paths so only MP4 export
is disabled; it does not block the server, UI, imports, other film exports, or other
services. `bun run dev`
is the frontend development mode and must not be used as the formal local data
entry point.

For the persistent PM2 deployment used by this workspace:

```bash
bun run pm2:build
bun run pm2:start
pm2 describe openboard-api
pm2 describe openboard-web
```

PM2 serves the web UI at `http://127.0.0.1:5173` and the loopback API at
`http://127.0.0.1:8790`. `pm2:start` reloads both processes with `.env`, then
saves the process list. PM2 accepts only its explicit OpenBoard deployment-variable
allowlist. `.env` outranks inherited shell values, and FFmpeg/FFprobe symlinks are
resolved to executable real paths before they reach the Go capability probe.

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
the Go API bound only to loopback inside the container, and Alpine's signed
`ffmpeg=8.0.1-r1` package from the digest-pinned Alpine 3.23 base. That one package
provides `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`; no standalone binary is downloaded.
Nginx serves the app
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
Compose bounds `/tmp` at 512 MiB. Render work directories live under the persistent
`/data/film-render` boundary, are deleted after each bounded render, and stale
server-named render directories are removed at container startup. Capacity-plan
`/data` for source media, protected deliverables, and at least one render intermediate.
Terminate TLS at a trusted reverse proxy for internet-facing deployments and
set `OPENBOARD_ORIGINS` to the exact public origin. Do not publish the internal
Go port. When `OPENBOARD_TOKEN` is set, the bundled reverse proxy injects it
server-side for `/api/` and `/healthz`; the token is never shipped in the SPA.

To build and run without Compose:

```bash
docker build -t openboard:local .
export OPENBOARD_TOKEN="$(openssl rand -hex 32)"
docker run --rm --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,size=512m \
  -p 127.0.0.1:8080:8080 \
  -v openboard-data:/data \
  -e OPENBOARD_TOKEN \
  -e OPENBOARD_ORIGINS=http://127.0.0.1:8080 \
  openboard:local
```

### Deployment runbook: capability, backup, restore, and rollback

#### PostgreSQL 17 → 18 volume migration

PostgreSQL 18's official image changed both `PGDATA` and the declared volume:
the data directory is `/var/lib/postgresql/18/docker`, and the Compose mount
must target its parent `/var/lib/postgresql`. The Compose file therefore uses a
new `openboard-postgres18` named volume. The old `openboard-postgres` PG17
volume is intentionally left untouched until the restored database is verified.
Do not point the PG18 container at the old `/var/lib/postgresql/data` mount.

The supported migration is a logical dump/restore. It keeps the source volume
recoverable and does not rely on copying PG17 files into a PG18 data directory:

Media-reference tokens are SHA-256 digests at rest. Releases before the marker
column was introduced may contain both verified plaintext legacy rows and
already-hashed rows; a 64-character token cannot reliably identify which form
is stored. The schema migration therefore treats unmarked rows as hashed and
fails closed, so a database digest can never become a bearer token. Existing
legacy plaintext references that must remain usable require an operator with a
verified plaintext-token inventory to mark only those exact rows
`token_hashed=false`; the first successful read atomically re-hashes the row.
Never mass-mark rows based on token length or hexadecimal format. Unknown legacy
plaintext references must be re-issued.

```bash
set -Eeuo pipefail

# 1. Stop OpenBoard without deleting named volumes.
docker compose down

# 2. Resolve the existing Compose volume by its actual Docker name. Compose
#    commonly prefixes the logical name with the project name. Require exactly
#    one existing volume; do not guess or allow Docker to create an empty one.
OPENBOARD_PG17_VOLUMES="$(docker volume ls --quiet --filter label=com.docker.compose.volume=openboard-postgres)"
if [ "$(printf '%s\n' "$OPENBOARD_PG17_VOLUMES" | awk 'NF { count++ } END { print count + 0 }')" -ne 1 ]; then
  echo "expected exactly one existing PG17 volume" >&2
  exit 1
fi
OPENBOARD_PG17_VOLUME="$OPENBOARD_PG17_VOLUMES"
docker volume inspect "$OPENBOARD_PG17_VOLUME" >/dev/null
export OPENBOARD_PG17_VOLUME
: "${OPENBOARD_POSTGRES_PASSWORD:?export OPENBOARD_POSTGRES_PASSWORD from the deployment .env}"

# Keep the database password out of Docker's argv/process list. The temporary
# file is removed by the EXIT trap after both success and failure.
OPENBOARD_MIGRATION_ENV_FILE="$(mktemp)"
chmod 600 "$OPENBOARD_MIGRATION_ENV_FILE"
trap 'rm -f -- "$OPENBOARD_MIGRATION_ENV_FILE"; docker rm -f openboard-postgres17-migration >/dev/null 2>&1 || true' EXIT
{
  printf 'POSTGRES_DB=openboard_local\n'
  printf 'POSTGRES_USER=openboard_local\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$OPENBOARD_POSTGRES_PASSWORD"
} >"$OPENBOARD_MIGRATION_ENV_FILE"

# 3. Start a temporary PG17 server against the existing named volume.
docker run -d --rm --name openboard-postgres17-migration \
  --env-file "$OPENBOARD_MIGRATION_ENV_FILE" \
  -v "$OPENBOARD_PG17_VOLUME":/var/lib/postgresql/data \
  postgres:17-alpine
until docker exec openboard-postgres17-migration pg_isready -U openboard_local -d openboard_local; do sleep 2; done
mkdir -p backup
chmod 700 backup
docker exec openboard-postgres17-migration pg_dump -U openboard_local -d openboard_local --format=custom \
  > backup/openboard-pg17.dump
test -s backup/openboard-pg17.dump
docker run --rm -i postgres:18-alpine pg_restore --list - \
  < backup/openboard-pg17.dump >/dev/null
docker stop openboard-postgres17-migration

# 4. Start PG18. This creates a fresh parent-mounted volume.
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U openboard_local -d openboard_local; do sleep 2; done

# 5. Restore the dump into the fresh PG18 database, then start the app.
docker compose exec -T postgres dropdb -U openboard_local --if-exists openboard_local
docker compose exec -T postgres createdb -U openboard_local openboard_local
docker compose exec -T postgres pg_restore --exit-on-error --single-transaction \
  -U openboard_local -d openboard_local --no-owner --no-privileges \
  < backup/openboard-pg17.dump
docker compose up -d openboard
```

Verify `/healthz`, a representative project, generation history, and media
before removing `openboard-postgres`. Keep `backup/openboard-pg17.dump` and the
old volume until that verification and a rollback window have passed. If the
restore fails, stop the deployment and inspect/restore the dump; the old PG17
volume remains available. Never run `docker compose down --volumes` during this
migration because it removes both the source and destination volumes.

After every start or upgrade, check the base service and the optional Film media
capability separately:

```bash
bun run diagnose:media
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/api/film/capabilities
docker compose exec -T openboard sh -c \
  '"$OPENBOARD_FFMPEG_PATH" -hide_banner -version && "$OPENBOARD_FFPROBE_PATH" -hide_banner -version'
```

`available`/`import` describe Film Mode, while `mp4Export` and `mp4Diagnostic`
describe local assembly. Provider generation is reported per stage and depends on
configured active-channel models/credentials; health and deployment smoke tests do
not require real Provider credentials.

For a consistent Compose backup, stop application writes, then back up all three
authoritative pieces. Redis is a disposable cache and is not restored:

```bash
mkdir -p backup
chmod 700 backup
docker compose stop openboard
docker compose exec -T postgres pg_dump -U openboard_local -d openboard_local \
  --format=custom > backup/openboard.dump
docker compose run --rm --no-deps -T openboard tar -C /data -cf - . \
  > backup/openboard-data.tar
install -m 600 .env backup/openboard.env
docker compose start openboard
```

If `OPENBOARD_BLOB_BACKEND=s3`, back up/version the configured bucket instead of
treating `/data` as the complete media copy. Preserve the exact
`OPENBOARD_MASTER_KEY`; without it, restored Provider/object-store credentials cannot
be decrypted. WebDAV workspace exports are useful user-level archives but intentionally
omit Provider credentials and do not replace a deployment backup.

Restore only into a stopped deployment from one matched database/media/key snapshot:

```bash
docker compose stop openboard
docker compose exec -T postgres dropdb -U openboard_local --if-exists openboard_local
docker compose exec -T postgres createdb -U openboard_local openboard_local
docker compose exec -T postgres pg_restore -U openboard_local -d openboard_local \
  --no-owner --no-privileges < backup/openboard.dump
docker compose run --rm --no-deps -T openboard tar -C /data -xf - \
  < backup/openboard-data.tar
docker compose start openboard
```

Before an upgrade, record `git rev-parse HEAD`, keep the prior `openboard:local`
image under a release-specific local tag, and take the matched snapshot above. To
roll back, stop OpenBoard, restore the prior database/media/key snapshot, retag the
prior image as `openboard:local`, and run `docker compose up -d --no-build`. Do not
run an older binary against a database already migrated by a newer build unless that
release explicitly documents backward schema compatibility. For PM2, use the same
database/media/key rule and preserve a release directory containing the matching
`server/bin/openboard-server` and `web/dist-local`; reload that directory only after
restore, then repeat health and capability checks.

## Tech stack

- **Web:** Vite, React 19, TypeScript, Zustand, Tailwind
- **Server:** Go 1.26.5+, chi router, pgx/PostgreSQL, go-redis, protected filesystem or S3/R2 media storage

### Product boundary: local deployment with optional accounts

OpenBoard remains a self-hosted/local product. Authentication can be disabled
for a token-protected single-user installation, or enabled in optional/required
mode for email login, Linux.do OAuth, tenant-scoped users, roles, projects,
application state, generation jobs, blobs and usage quotas. Site administrators
can control registration, custom channels and use of backend/cloud channels.
In `optional` mode, zero-user bootstrap can initialize the local workspace, but
once the first account exists every protected data-plane route requires a real
session; the process token never impersonates a user. `required` enforces the
same session boundary from the start. See [`docs/MULTI_TENANT.md`](docs/MULTI_TENANT.md).

PostgreSQL stores authoritative application data, Redis is a disposable cache,
and media stays in protected service storage or a configured private S3/R2
backend. Provider and object-storage secrets are encrypted with AES-GCM using
`OPENBOARD_MASTER_KEY`; PostgreSQL stores only nonce/ciphertext envelopes, and
WebDAV backups never contain those keys.

This is not a hosted SaaS marketplace: there is no external payment processor,
organization-wide enterprise SSO or managed public hosting control plane.

## Clean-room notes

See [docs/CLEANROOM.md](docs/CLEANROOM.md) and [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md).

## Documentation maintenance

Keep current product documentation tied to these code-owned sources of truth:

| Subject | Authoritative code/config | Current documentation |
|---|---|---|
| SPA routes and navigation | `web/src/App.tsx`, `web/src/components/layout/TopNav.tsx` | this README and the in-product `/help` page |
| Node/config/provider types | `web/src/types/board.ts`, frontend/server provider capability tables | this README and `docs/FEATURE_PARITY.md` |
| HTTP routes and authentication | `server/internal/api/api.go`, `server/internal/api/auth.go` | `server/README.md`, `.env.example`, `docs/MULTI_TENANT.md` |
| Agent Skills and video generation usage | `server/internal/api/codex_skills.go`, `web/src/components/agent/CodexSkillsPanel.tsx`, `web/src/lib/video-generation-options.ts` | `docs/USER_GUIDE.md` and the in-product `/help` page |
| Test/build/deploy commands | root/web `package.json`, `ecosystem.config.cjs` | this README and `docs/RELEASE_AUDIT.md` |
| Current Tiger comparison | verified public release metadata plus local tests | `docs/TIGER_GAP_PLAN_4.md`; rounds 1–3 are historical only |

When a change affects any row above, update its current documentation in the
same commit. Do not copy test counts or coverage percentages into multiple
files; `package.json`, CI output, and the dated verification block in
`docs/FEATURE_PARITY.md` are the live evidence. Historical audit records should
be marked superseded instead of silently rewritten.

## Disclaimer

OpenBoard is not affiliated with, endorsed by, or derived from any specific
third-party canvas product. Product names mentioned in research notes are for
interoperability comparison only.
