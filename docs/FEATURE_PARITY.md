# Feature parity checklist

This is an implementation inventory, not proof of equivalence. Checked items
have a code path in this repository; only items listed under **Automated
verification** have repeatable tests. Target behavior must come from public
documentation or recorded black-box observation, never upstream source.

Status: `implemented` | `partial` | `planned`

## Automated verification
- [x] Camera coordinate transforms and fit-to-nodes bounds
- [x] Undo/redo ordering, redo invalidation, and history limits
- [x] Imported board validation (geometry, IDs, node types, edge integrity)
- [x] Go project CRUD, invalid input rejection, and origin allowlist
- [x] Browser E2E for critical canvas gestures and persistence (full suite: 65 passed, 3 environment-specific skips across configured browser projects)
- [partial] Cross-browser desktop/mobile visual regression (Playwright behavior suite: 65 passed, 3 environment-specific skips; pixel-baseline review remains separate)
- [x] 80%+ covered-module unit/integration coverage report (86.02% lines / 88.13% functions; UI-heavy modules remain outside Bun coverage)

## Board projects
- [x] Multiple projects
- [x] Rename / delete / multi-select batch delete
- [x] Export / import JSON
- [x] Formal local PostgreSQL persistence + Redis cache + server media rehydrate
- [x] Empty-server migration from legacy IndexedDB with post-success browser cleanup
- [x] Auto-create first project on empty state

## Infinite canvas
- [x] Pan, wheel zoom, slider, reset, fit-to-nodes
- [x] Minimap
- [x] Background: dots / lines / blank
- [x] Light / dark theme
- [x] Marquee + multi-select + select all
- [x] Copy / paste / duplicate (Cmd+D)
- [x] Align + distribute (context menu, multi-select)
- [x] Undo / redo (nodes, edges, viewport, background, assistant)
- [x] Edge highlight / select / delete
- [x] Context menu (blank + node)
- [x] Keyboard shortcuts help

## Nodes
- [x] Image / text / config / video / audio
- [x] Drag, resize, free vs aspect lock
- [x] Ports + connections
- [x] JSON inspect
- [x] Node prompt bar
- [x] Image crop / rotate / multi-angle / mask / upscale / split
- [x] Image replace + download
- [x] Batch image group stack/expand/primary + delete cascade
- [x] Config upstream order + video params (ratio/res/duration/audio/watermark)
- [x] Group node create/ungroup/grouped movement/copy/delete cleanup/undo
- [x] Sandboxed remote node/plugin runtime (opaque iframe, manifest validation, consent, quota, persistence)

## AI
- [x] Browser-direct OpenAI-compatible client
- [x] Text + image generate/edit + models list
- [x] Video OpenAI-style + Ark/Seedance poll + multi-ref best-effort
- [x] Speech TTS (`/audio/speech`) for audio nodes
- [partial] Seedance/Ark vendor matrix (nested IDs/statuses, camelCase aliases, video lists, terminal states, auth/rate/error behavior covered; undocumented vendor-specific fields remain partial)

## Assistant
- [x] Ask / image modes
- [x] Selected + upstream refs
- [x] Insert results
- [x] Session history / retry / delete / paste image

## Prompts & assets
- [x] Asset library CRUD + search + pagination + download + complete field edit + image replacement
- [x] Canvas asset picker
- [x] Remote prompt URL fetch + cache
- [x] Search / tags

## Sync / settings
- [x] Multi channel config with independent text/image/video/audio URL, key, and model settings
- [x] WebDAV backup put/get
- [x] WebDAV current-canvas bundle includes media and refuses non-HTTPS remotes
- [partial] Credential deep link via one-time `#connect?apiKey=&baseUrl=` fragment; legacy query parameters are scrubbed but never consumed
- [x] JSON structure export/import + ZIP STORE project bundle with media manifest

## Local agent (Go)
- [x] Health / version / files / projects API
- [x] Agent status + live tool list UI panel
- [x] Validated HTTP board tools + bidirectional browser project synchronization
- [x] PostgreSQL-backed project/state repository shared by browser, HTTP tools, and MCP; Redis read cache
- [x] MCP stdio initialize/tools-list/tools-call lifecycle
- [partial] Codex app-server JSON-RPC transport, HTTP session/message/approval/SSE endpoints, message/item summaries, and approval queue; advanced app-server methods and rich turn rendering remain

## Remaining non-goals / planned
- [planned] Hosted multi-user mode with registration/login, project memberships, tenant isolation, Redis job queues, and server-side encrypted provider secrets
- [x] Plugin catalog install/upgrade/uninstall with HTTPS, size, MIME, redirect, permission-consent boundaries
- [x] Cloud AI upscale/inpaint provider adapter with bounded multipart, cancellation, progress, fallback policy, and lineage
- [partial] Mobile canvas-first layout, drawers, single-touch drag and pinch zoom
- [x] Pinch zoom, touch state machine, pointer cancellation
- [x] Viewport culling + spatial node index + geometry-aware edge index + rAF input batching
- [x] Spatial index and reproducible 1k/10k-node performance benchmarks
- [partial] Mobile asset/prompt/assistant management and automated device E2E (responsive actions, project drawer, assistant open/close, and overflow flows pass on mobile Chromium; advanced drawer ergonomics remain)
