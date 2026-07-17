# OpenBoard v0.8.2 behavior parity

This inventory freezes the engineering target to the publicly documented and
black-box-observed behavior of `basketikun/infinite-canvas v0.8.2`. It does not
claim source, visual-expression, trademark, or legal equivalence. OpenBoard is
an independent implementation with its own architecture, data model, UI,
plugins, SDK, fixtures, and assets.

Status: `verified` means the behavior is implemented and has repeatable unit,
integration, E2E, or formal-storage evidence in this repository. Provider
smoke tests that require real paid credentials remain opt-in.

## Verification summary

- [verified] 171 Bun unit/integration tests; 83.34% lines and 85.26% functions
- [verified] Go `test -race`, `vet`, API/WebSocket/MCP integration tests, and two binary builds
- [verified] 105 passed and 6 intentional environment skips across Chromium, Firefox, WebKit, and mobile Chromium in CI
- [verified] 28/28 Chromium tests against the production Vite build and isolated Go data directory
- [verified] Formal PostgreSQL/Redis/media E2E with a unique temporary database, Redis DB 14, and zero residue after cleanup
- [verified] Docker Compose build and hardened PostgreSQL/Redis runtime smoke in CI
- [verified] Clean-room identifier scan, strict direct-license audit, SPDX SBOM, and dependency vulnerability audit

## Data and canvas

- [verified] Schema v2 documents; v1/no-version read compatibility and save-time upgrade
- [verified] Project create, rename, delete, batch delete, JSON and media-bundle import/export
- [verified] PostgreSQL authoritative persistence, Redis disposable cache, protected filesystem media, and empty-server IndexedDB migration
- [verified] Pan, wheel/pinch zoom, slider, reset, fit, minimap, backgrounds, themes, culling, and 1k/10k indexes
- [verified] Marquee/multi-select, copy/paste/duplicate, align/distribute, connections, edge deletion, undo/redo, and shortcuts
- [verified] Text/image/config/video/audio/plugin nodes; ports, drag, resize, preview, metadata inspection, and prompt bars
- [verified] Titles above nodes with bounded inline edit; blank-canvas double-click node chooser
- [verified] Group drag-in/out thresholds, hover feedback, 24px automatic bounds, grouped movement, and history
- [verified] Text font size 10-72px, prompt selection, node model override, and provider-default inheritance
- [verified] Immediate text-to-image flow with retained failed config node and retry path

## AI and creative tools

- [verified] Independent text/image/video/audio URL, key, protocol, and model settings
- [verified] OpenAI, Ark/Seedance, Gemini, and restricted declarative Template adapters
- [verified] Authentication, redirect, timeout, cancellation, rate/error, task polling, malformed response, and bounded-download behavior
- [verified] AES-GCM provider secrets; exported projects and WebDAV backups omit keys
- [verified] Transparent image background capability checks and provider mapping
- [verified] Image reverse prompting into a connected text node
- [verified] Draggable image split guides with normalized coordinates and lineage
- [verified] Crop, rotate, multi-angle, mask/inpaint, upscale, replacement, download, grouping, and cascade behavior
- [verified] Image and video workbenches with provider/model/refs/parameters, generate/cancel/retry/history, download/delete/regenerate, and canvas insertion
- [verified] PostgreSQL generation-job migration and paginated CRUD; IndexedDB compatibility in development mode

## Plugins

- [verified] Independent HTTPS registry with bounded MIME/size/redirect policy
- [verified] Manifest v2 and lossless v1 normalization
- [verified] Eight node/asset/AI/panel permissions with install-time consent
- [verified] Install, semantic-version update, upgrade notice, persistence rollback, and uninstall
- [verified] Opaque iframe isolation, CSP, message validation, quota, and state persistence
- [verified] Host-mediated node/asset/panel/AI calls without provider-key disclosure
- [verified] Publishable `packages/plugin-sdk` types, protocol, and example
- [verified] Original sticky-note, Markdown, HTML, SVG, and Three.js panorama examples
- [verified] Panorama desktop/mobile canvas pixels and interactive 2D fallback without WebGL

## Agent and MCP

- [verified] Ticket-authenticated browser WebSocket with origin allowlist, state reporting, command IDs, results, timeout, disconnect failure, and no replay
- [verified] Live state/selection/snapshot/atomic ops/text flow/image flow/asset/prompt/navigation tools
- [verified] Six persisted `board.*` compatibility tools remain available
- [verified] Browser-rendered PNG snapshots upload to protected Go file storage
- [verified] MCP stdio lifecycle and remote execution through an owner-only `0600` connection file
- [verified] Profile-level Codex thread continuity and explicit new session
- [verified] Turn interrupt, concurrent-start prevention, turn-ID race handling, and structured logs
- [verified] Up to ten image attachments/30MB, MIME validation, `0600` files, and completion/failure/close cleanup
- [verified] Safe Markdown/GFM output, raw-HTML suppression, remote-image suppression, previews, stop, and approvals
- [verified] Independent `plugins/openboard` installer and Claude standard-MCP instructions

## Product boundary

- [verified] Personal local single-user product with loopback binding and token-protected formal runtime
- [not targeted] Hosted registration, tenant membership, billing, and multi-user authorization
- [not targeted] Browser-hosted Claude conversation UI; standard MCP setup is documented
- [external] Real-provider paid smoke depends on user-supplied credentials and is never a CI fixture
- [external] Commercial clean-room, trademark/trade-dress, patent, contributor-rights, and market-specific legal sign-off
