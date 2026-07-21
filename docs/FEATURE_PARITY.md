# OpenBoard v0.8.2 core, v0.9.0, and public Unreleased parity

This inventory freezes the engineering core to the publicly documented and
black-box-observed behavior of `basketikun/infinite-canvas v0.8.2`, plus the
explicit public interface delta listed for `v0.9.0` and the four public
Unreleased behaviors recorded on 2026-07-19. It does not
claim source, visual-expression, trademark, or legal equivalence. OpenBoard is
an independent implementation with its own architecture, data model, UI,
plugins, SDK, fixtures, and assets.

Status: `verified` means the behavior is implemented and has repeatable unit,
integration, E2E, or formal-storage evidence in this repository. Provider
smoke tests that require real paid credentials remain opt-in.

## Public baseline traceability

The frozen public inputs are the immutable v0.8.2 documents and hashes, plus
the v0.9.0 release metadata, listed
in `docs/BEHAVIOR_SPEC.md`. This table maps their named behaviors to local
implementation and verification surfaces; it does not use upstream source as
implementation evidence.

| Public behavior | Local evidence |
|---|---|
| Multi-project create/rename/delete/batch delete and JSON/media import/export | project lifecycle E2E, `board-document.test.ts`, `project-bundle.test.ts`, formal storage E2E |
| Pan, wheel/pinch/slider zoom, reset, fit, minimap, backgrounds and themes | canvas editing/touch/viewport E2E, `gesture.test.ts`, `geometry.test.ts` |
| Marquee/additive/all selection, delete, copy/paste with edges, undo/redo and shortcuts | canvas editing E2E, `history.test.ts`, `keyboard.test.ts` |
| Selected-node upstream/downstream node and edge highlighting | canvas editing E2E asserts related node and active edge rendering |
| Text/image/config/video/audio nodes, drag, resize, ports, metadata and preview | canvas/image/local-media E2E plus group drag E2E |
| Image proportional/free resizing, replacement, download and asset insertion | image lifecycle and asset-library E2E |
| Text editing, explicit toolbar edit, node model/prompt selection, empty-node fill and connected rewrite | node title/font/model and node prompt E2E |
| Connected media `@` menu, thumbnail chips, atomic deletion and deterministic request references | `PromptChipInput.tsx`, `prompt-references.test.ts`, prompt-chip E2E |
| Text-to-image creates and immediately runs a connected config node | `text-to-image creates a connected config` E2E |
| Config nodes aggregate ordered text/image/video/audio inputs | `BoardNodeView.tsx` input preview, `NodeActions.tsx` ordered upstream resolver, and Ark request-order E2E |
| Config image batches and config text batches of 1-8 results | `image-generation.test.ts`, `text-batch.test.ts`, config text-batch E2E |
| Image upload/drag, crop, rotate/multi-angle, mask, upscale, split and lineage | image lifecycle, split controls and upscale E2E plus image-transform unit tests |
| Image retry protects missing references; multi-result batches expand and select a primary image | `image-generation.test.ts`, `BatchGroupControls.tsx`, canvas E2E |
| Independent text/image/video/audio provider URL, key, protocol, model and model listing | `SettingsModal.tsx`, `ai-client.test.ts`, formal storage E2E |
| Global system prompt across text, image generation, and image editing entry points | `ai-client.test.ts`, text-batch and text-to-image E2E |
| OpenAI text/image/video/audio and Ark/Seedance video contracts | `ai-client.test.ts`, `video-generation.test.ts`, image-to-video E2E |
| Seedance 9 image/3 video/3 audio references, ratios, 480p/720p/1080p and smart/4-15s duration | `NodeActions.tsx`, `BoardNodeView.tsx`, `CreativeWorkbench.tsx`, `video-generation.test.ts` |
| Assistant selected/upstream context, text/image generation, sessions, retry, insert and single/batch deletion | full assistant generation E2E and `assistant-sessions.test.ts` |
| Prompt search/source/tag filters, detail, cover/result gallery, copy, asset/canvas insert and declaratively mapped remote sources | prompt detail/library E2E, prompt-source manager E2E, formal storage E2E, and `prompt-sources.test.ts` |
| Asset text/image create, metadata edit, search/type filter, pagination, copy/download and canvas insert | full asset-library E2E and formal-storage E2E |
| WebDAV project and full-workspace backup/restore with deduplicated media and no exported credentials | `SettingsModal.tsx`, `project-bundle.test.ts`, `workspace-bundle.test.ts` |
| Loopback New API query auto-configuration and remote-safe fragment configuration | `url-credentials.test.ts` and loopback-link E2E |
| Plugin install/enable/update/rollback/uninstall, sandbox, permissions, SDK and five examples | plugin unit tests plus registry/SVG/panorama E2E |
| Image/video workbenches and persistent generation history | `CreativeWorkbench.tsx`, generation-job tests, cancellation/retry E2E, and formal E2E |
| Multi-tab browser runtime, MCP tools, snapshots, Codex continuity, attachments, stop and approvals | Go runtime/MCP/Codex tests plus browser/Codex E2E |
| Public Unreleased unified generation status query across canvas/image/video workbench | `generation_get_status` MCP schema, unified activity tests, workbench/Agent E2E, and formal reload/orphan-recovery E2E |
| Public Unreleased client-scoped operations and focused-tab fallback | runtime pin/ownership Go tests and two-tab generation ownership E2E |
| Public Unreleased shared Codex session/running state, approvals and exact turn completion | Codex replay/state/approval Go tests, `codex-events.test.ts`, and two-tab Codex E2E |
| Public Unreleased addable custom prompt sources | JSON/HTML/Markdown mappings plus local transform scripts, migration tests, manager E2E, and PostgreSQL reload E2E |
| Community prompt catalog one-click install | `prompt-source-presets.ts`, structured markdown/JSON parsers, prompt library E2E |
| Public Unreleased canvas prompt-library tab grouped by source | `CanvasPromptsPanel.tsx`, grouping unit tests, canvas prompt-panel E2E |
| Public Unreleased keep node prompt after generation | `NodePromptBar.tsx` retains draft text after successful generate |
| Public Unreleased Codex user bubbles and open assistant replies | `CodexPanel.tsx` right-biased user bubbles and unlabeled assistant markdown |
| Public Unreleased Codex transcript stick-to-bottom and jump control | transcript auto-scroll plus `回到底部` when browsing history |
| Public Unreleased Codex image attachments create canvas image/config flow | `insertAttachmentImageNodes` + Codex attachment E2E |
| PostgreSQL authority, Redis cache, encrypted secrets and isolated formal testing | store/API tests, formal E2E, container smoke |
| Resizable/collapsible canvas panel with project, element, asset and prompt tabs | panel persistence, element selection/location/export and asset/prompt-panel E2E |
| Local prompt CRUD/copy/direct insertion and hover-revealed node names | prompt library and node-title E2E |
| Image/video/audio asset upload, preview, insertion, deletion and archive restore | asset E2E and `workspace-bundle.test.ts` |
| Active-canvas archive from the top bar and bounded multi-element ZIP export | project lifecycle and element panel E2E plus `node-export.test.ts` |

## Intentional differences

- OpenBoard formal local mode uses PostgreSQL, Redis and protected media files;
  the reference v0.8.2 documentation describes browser-local data. IndexedDB
  remains only the development/offline compatibility implementation.
- Provider keys are encrypted by the local Go service. Remote deployments use
  `#connect?...` credentials so secrets do not enter HTTP logs; legacy query
  links are accepted only on loopback for v0.8.2 New API compatibility.
- Prompt samples, remote-source defaults, plugin examples, visuals, copy,
  assets, schemas and product identity are independently authored. The remote
  source mechanism is compatible, but upstream catalogs and content are not
  copied or bundled.
- Prompt sources support declarative JSON/HTML/Markdown mappings and optional
  local transform scripts. Scripts may be async and call fetchText/fetchJson.
  Public media/image URLs remain HTTPS-first; personal local deployments may use
  loopback/LAN http(s) prompt-source URLs. Credential query parameters and
  redirects remain rejected.
- OpenBoard adds audio nodes, workbenches, plugin isolation, the browser
  runtime, expanded MCP tools and a production-shaped local backend. These are
  additive and do not redefine the frozen reference requirements.
- Hosted accounts, tenants, billing and multi-user authorization are outside
  both the personal/local target and this core-plus-public-delta parity claim.

## Verification summary

- [verified] 242 Bun unit/integration tests; 84.26% line and 86.20% function coverage
- [verified] Go `test -race`, `vet`, API/WebSocket/MCP integration tests, and two binary builds
- [verified] 136 passed and 8 intentional environment skips across Chromium, Firefox, WebKit, and mobile Chromium in CI run `29621823209`
- [verified] 64/64 desktop Chromium tests against the production Vite build and isolated Go data directory
- [verified] 52 passed and 12 intentional desktop-only skips in production mobile Chromium
- [verified] Formal PostgreSQL/Redis/media E2E with a unique temporary database, Redis DB 14, and zero residue after cleanup
- [verified] Docker Compose build and hardened PostgreSQL/Redis runtime smoke in CI
- [verified] Clean-room identifier scan, strict direct-license audit, SPDX SBOM, and dependency vulnerability audit

## Data and canvas

- [verified] Schema v2 documents; v1/no-version read compatibility plus save-time upgrade and reload E2E
- [verified] Project create, rename, delete, batch delete, JSON and media-bundle import/export
- [verified] PostgreSQL authoritative persistence, Redis disposable cache, protected filesystem media, and empty-server IndexedDB migration
- [verified] Pan, wheel/pinch zoom, slider, reset, fit, minimap, backgrounds, themes, culling, and 1k/10k indexes
- [verified] Marquee/multi-select, copy/paste/duplicate, align/distribute, drag/click connections, edge deletion, undo/redo, and shortcuts
- [verified] Text/image/config/video/audio/plugin nodes; ports, drag, resize, preview, metadata inspection, and prompt bars
- [verified] Titles above nodes with bounded inline edit; blank-canvas double-click node chooser
- [verified] Same-frame group drag-in/out, 16px exit threshold, hover feedback, exact 24px automatic bounds, grouped movement, undo/redo, and reload
- [verified] Text font size 10-72px, prompt selection, node model override, and provider-default inheritance
- [verified] Immediate text-to-image flow with retained failed config node and retry path

## AI and creative tools

- [verified] Independent text/image/video/audio URL, key, protocol, and model settings
- [verified] Bounded global system prompt applied to all text, image generation, and image editing requests
- [verified] OpenAI, Ark/Seedance, Gemini, and restricted declarative Template adapters
- [verified] Authentication, redirect, timeout, cancellation, rate/error, task polling, malformed response, and bounded-download behavior
- [verified] AES-GCM provider secrets; exported projects and WebDAV backups omit keys
- [verified] Transparent image background capability checks and provider mapping
- [verified] Image reverse prompting into a connected text node
- [verified] Reproducible image request metadata, missing-reference preflight failure, and expandable multi-result batches
- [verified] Draggable image split guides with normalized coordinates and lineage
- [verified] Crop, rotate, multi-angle, mask/inpaint, upscale, replacement, download, grouping, and cascade behavior
- [verified] Image and video workbenches with provider/model/refs/parameters, generate/cancel/retry/history, download/delete/regenerate, and canvas insertion; retry rejects missing references, reload reconciles interrupted owned jobs, and history deletion preserves shared board/job media while reclaiming orphans
- [verified] PostgreSQL generation-job migration, paginated CRUD and timestamp-preserving atomic bulk restore; IndexedDB compatibility in development mode
- [verified] WebDAV full-workspace bundles include projects, assets, prompts, generation history and deduplicated media while preserving local credentials

## Plugins

- [verified] Independent HTTPS registry with bounded MIME/size/redirect policy
- [verified] Manifest v2 and lossless v1 normalization
- [verified] Eight node/asset/AI/panel permissions with install-time consent
- [verified] Install, enable/disable with preserved node state, semantic-version update, upgrade notice, persistence rollback, and uninstall
- [verified] Opaque iframe isolation, CSP, message validation, quota, and state persistence
- [verified] Host-mediated node/asset/panel/AI calls without provider-key disclosure
- [verified] Publishable `packages/plugin-sdk` types, protocol, and example
- [verified] Original sticky-note, Markdown, HTML, SVG, and Three.js panorama examples
- [verified] Panorama desktop/mobile canvas pixels and interactive 2D fallback without WebGL

## Prompt, video, and assistant workflows

- [verified] Prompt search plus independent source/tag filters, multiple saved HTTPS sources, per-source/all refresh, and source removal
- [verified] One-click community catalog presets for Image Prompts unified JSON registry (including Banana Prompt Quicker)
- [verified] Built-in Image Prompts catalogs are always present after hydrate and preserve enablement/status on merge
- [verified] Prompt-source cards show count, sync status, and last success time; failed refresh keeps last success cache
- [verified] Prompt center 「我的提示词」 tab for local manage / save-from-public / canvas use
- [verified] Canvas prompt library supports cross-source search and inserts with title preserved
- [verified] Local transform scripts can convert non-standard fetched catalogs into prompt arrays with parseJson/queryAll helpers
- [verified] Custom prompt-source scripts may async fetchText/fetchJson additional URLs (local-friendly source URL policy for loopback/LAN)
- [verified] Prompt source URLs accept personal local http(s) hosts (127.0.0.1/localhost/private LAN) while public media stays HTTPS-first
- [verified] Canvas left-panel tab underline slides between projects/elements/assets/prompts
- [verified] Structured community Markdown parsing for labeled/fenced prompt blocks with section tags and image galleries
- [verified] Add/edit/disable/delete source manager, legacy URL migration, active-tab scheduling with authoritative persisted merges, nested JSON field paths, bounded HTML selectors, preview, and PostgreSQL reload persistence
- [verified] Executable source formats, prototype paths, unsafe selectors, credential-bearing URLs, redirects, explicit private hosts, oversized responses, and excessive entries are rejected
- [verified] Prompt cover and bounded result-image galleries with detail preview and canvas insertion
- [verified] Canvas left panel prompt-library tab groups prompts by source with collapse and insert/copy actions
- [verified] Node prompt bar keeps the last prompt text after a successful generation so users can refine and resubmit
- [verified] Text/image nodes create connected video nodes; image-to-video includes the source image reference
- [verified] Smart Seedance duration and Ark fast-model `1080p` preflight rejection
- [verified] Config nodes preview ordered text, image, video, and audio inputs; reordering changes the actual Ark reference request order
- [verified] Assistant pasted-image preview, removal, direct insertion, and later message-image reinsertion

## Agent and MCP

- [verified] Ticket-authenticated browser WebSocket with origin allowlist, state reporting, command IDs, results, timeout, disconnect failure, and no replay
- [verified] Live state/selection/snapshot/atomic ops/text flow/image flow/asset/prompt/navigation tools
- [verified] Six persisted `board.*` compatibility tools remain available
- [verified] Browser-rendered PNG snapshots upload to protected Go file storage
- [verified] MCP stdio lifecycle and remote execution through an owner-only `0600` connection file
- [verified] Profile-level Codex thread continuity and explicit new session
- [verified] `generation_get_status` queries canvas `nodeIds` and workbench `taskId` with client ownership validation
- [verified] Codex turns pin all tools to the initiating browser ID; disconnect falls back only to the most recently focused same-project tab and foreign results are ignored
- [verified] Shared Codex session, user-message history, approval resolution and running state synchronize across tabs; sequenced SSE reconnects without replay duplicates, events are thread-filtered, and only exact turn completion unlocks input
- [verified] Turn interrupt, concurrent-start prevention, turn-ID race handling, and structured logs
- [verified] Up to ten image attachments/30MB, MIME validation, `0600` files, explicit pending-upload cancellation, completion/failure/close cleanup, and orphan purge on restart
- [verified] Safe Markdown/GFM output, raw-HTML suppression, remote-image suppression, previews, stop, and approvals
- [verified] Codex user messages render as right-biased accent bubbles; assistant replies stay open left Markdown without role labels
- [verified] Codex transcript sticks to the latest message and exposes a jump-to-bottom control when the user scrolls up
- [verified] Codex image attachments become canvas image nodes connected into an image-generation config flow before the agent turn starts
- [verified] Independent `plugins/openboard` installer and Claude standard-MCP instructions

## Product boundary

- [verified] Personal local single-user product with loopback binding and token-protected formal runtime
- [not targeted] Hosted registration, tenant membership, billing, and multi-user authorization
- [not targeted] Browser-hosted Claude conversation UI; standard MCP setup is documented
- [external] Real-provider paid smoke depends on user-supplied credentials and is never a CI fixture
- [external] Commercial clean-room, trademark/trade-dress, patent, contributor-rights, and market-specific legal sign-off
