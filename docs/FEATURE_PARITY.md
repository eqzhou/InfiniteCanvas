# OpenBoard public parity inventory

This inventory freezes the engineering core to the publicly documented and
black-box-observed behavior of `basketikun/infinite-canvas v0.8.2`, plus the
explicit public interface deltas through `v0.13.0`, the named public
Unreleased behaviors rechecked on 2026-08-05, and Tiger deltas through
`v0.5.1`. It does not
claim source, visual-expression, trademark, or legal equivalence. OpenBoard is
an independent implementation with its own architecture, data model, UI,
plugins, SDK, fixtures, and assets.

Status: `verified` means the behavior is implemented and has repeatable unit,
integration, E2E, or formal-storage evidence in this repository. Provider
smoke tests that require real paid credentials remain opt-in.

Film Production Mode is a local additive capability, not a behavior-parity
claim about either reference product. Its status and evidence are recorded
separately below so local engineering verification is not presented as legal,
source-origin, visual-similarity, or Provider certification.

The newer Basket `v0.15.1`, Tiger `v0.5.2`, and DramaClaw `v1.3.2` deltas are
tracked in `plans/openboard-three-upstream-increment-v0151-v052-v132.md`.
The shared feature-gate contract, the locale foundation, and frozen four-mode
video resolution now carry passing evidence; page-domain translation and the
remaining storage, voice, provider, style, and Film workflow deltas are still
planned. This inventory must not be read as current full-version parity.

## Tiger v0.4.5 convergence baseline

The broader product goal additionally tracks the publicly documented behavior
of `tigerowo/infinite-canvas v0.5.1`. The detailed v0.4.5 table below is a
historical convergence baseline; current v0.5.0–v0.5.1 deltas are listed in
the additive review section. This is an independent implementation;
Tiger source, bundled director assets, visual expression, and product identity
are not implementation inputs.

| Tiger behavior area | Local status |
|---|---|
| Native 3D director node | [verified] first-class `director` node, bounded v4 scene document with deterministic v1/v2/v3 migration, eight independently-authored procedural character looks, twenty poses, keyboard-accessible SVG visual look/pose catalogs driven by the same geometry definitions as the 3D scene, actor/extra staging, six primitive geometries, compact instanced crowd arrays, locked scene objects, server-backed GLB import/missing-state/versioned relink, interactive move/rotate/scale gizmos, independent director/shot views, up to 32 named cameras, camera position/target/focal length/aperture/aspect, ground grid/rule-of-thirds/safe-frame controls, native panorama/image environment binding/rotation/intensity, tenant-isolated protected screenshot synchronization, preview/delete/clear and atomic batch send-to-canvas, plus an explicit single-capture formal-shot action that freezes bounded scene provenance, creates an editable capture → config → result chain, and reuses durable server image generation/audit/recovery. Persistence, recoverable WebGL failure, and bounded lazy GPU lifecycle are verified |
| Native panorama generation/viewer | [verified] first-class `panorama` nodes support fixed 2048x1024 AI generation from text and up to eight ordinary managed image references, controlled quality and 1–8 result batches, strict JPEG/PNG/WebP signature/dimension/import limits, local upload with 2:1 panorama/ordinary-image choice and reusable 2:1 canvas images, atomic durable commit and cleanup, WebGL plus interactive 2D/keyboard viewing, reload/bundle persistence, and per-result director environment handoff |
| Camera controls on image/video/config generation | [verified] image/video nodes and image/video config modes expose an independently authored camera panel with camera/lens/focal-length/aperture settings; raw prompts and bounded structured settings persist per node, copy with nodes, inherit into image batches/video results, and are assembled exactly once for generation/retry; the fixed portal remains screen-sized across canvas zoom and hides for text config mode |
| Image creation workbench | [verified] image workbench switches between persisted side/bottom layouts, starts independent concurrent jobs with aggregate cancellation, persists bounded categories and filters history, previews local and reusable-asset references, displays result byte sizes, reuses image assets through managed storage, and exposes a pointer-draggable position-persisted workflow entrance; browser-production and formal-storage E2E cover the behavior |
| Durable backend generation | [verified] every runtime executes application-supported provider contracts through the durable server path for persistent media: OpenAI-compatible, Gemini, exact APIMart/KIE and restricted declarative-Template image jobs; OpenAI, Ark/Seedance, exact APIMart/KIE and restricted declarative-Template video jobs; OpenAI-compatible audio; and multi-step image workflows. API keys stay server-side; isolated image/video/audio/workflow claim domains use PostgreSQL leases/CAS checkpoints; tenant blobs are validated and quota-accounted; cancellation cascades; and queued or expired-lease work recovers. Asynchronous provider task IDs are checkpointed before polling so restart resumes instead of recreating upstream work, while synchronous Template requests remain cancellable and restart from their immutable job snapshot after lease expiry. Image/video workbenches plus canvas image/config/prompt/video/audio actions use this path and recover after reload, including indexed multi-image placeholders |
| Creative workflows | [verified] built-in public and persisted personal templates, six typed variable controls, strict DAG validation, single/series image steps, structured image references, AI-assisted draft preview, browser compatibility execution, formal durable execution, child image history, cancel/retry, final-result canvas insertion, and workspace-bundle v2 backup/restore |
| S3/R2 media backend | [verified] optional dependency-free SigV4 S3-compatible backend supports AWS S3, Cloudflare R2 and explicit loopback MinIO; routing is user/tenant preference → tenant-admin weighted pool → process fallback/filesystem. Stable provider IDs, immutable placements, deletion tombstones, safe pre-write failover, encrypted write-only credentials, DNS-rebinding/private-network blocking, tenant-hashed keys, authenticated proxy reads, conditional overwrite and quota compensation are verified |
| KIE/APIMart and exact model contracts | [verified] dedicated KIE/APIMart adapters cover bounded upload/create/poll/result flows, transient KIE polling retries and exact official-host upload trust. Exact capabilities include Kling 2.6/v3, Kling 3.0 Turbo, Seedance 2.0 standard/fast/mini, Seedream 5.0 Pro, Gemini 3.1 Flash Lite Image / Nano Banana 2 Lite, and HappyHorse 1.1; unverified names such as Agnes fail closed |
| Scoped operations consoles | [verified] tenant Owners manage members/invitations, tenant policy, tenant channels and write-only secrets, prompt catalog/scheduling, library and storage pool while quota/credit ledgers are read-only; deployment-granted Platform Admins separately manage registration, tenants/accounts, hard quotas, credit issuance, global model costs and platform channels; personal settings and credentials remain user-scoped |
| Single authoritative workspace store | [verified] projects, settings, generation history and protected media load from and save to the database-backed server; there is no browser workspace database or login-time migration branch |
| Video first/last-frame option | [verified] video workbench, video nodes and video config mode expose 首尾帧; ordered image refs map to Ark/Seedance `first_frame`/`last_frame` on browser and durable server paths; mode persists in node metadata and job parameters through retry/reload |
| Prompt paste newlines and local wheel | [verified] node prompt chip editor preserves multi-line paste including blank lines, serializes Enter/block structure without collapsing newlines, and stops wheel events so scrolling the prompt does not zoom the canvas |
| Left-panel asset drag onto canvas | [verified] canvas assets tab items are draggable with a bounded OpenBoard asset mime payload; dropping on the canvas surface inserts the asset at the drop world point with open-position collision avoidance, while click insert remains available |
| Project/node generation-job cascade cleanup | [verified] deleting a canvas project removes only that project's generation-history rows (and cancels active server/workflow leases); deleting selected image/video/audio nodes removes their linked generationJobId history without touching other projects |
| Multi-tab project catalog isolation | [verified] ordinary formal autosave only upserts the projects present in the current tab; remote projects are deleted only by explicit user delete or full workspace replacement, so another tab cannot wipe projects it has not loaded |
| Workbench history bulk delete | [verified] image/video workbench history supports multi-select and a single bulk-delete action; server path uses bounded POST `/generation-jobs/bulk-delete` (1–100 ids, de-duplicated), rejects active server/workflow jobs with 409 until they are cancelled, and soft-deletes eligible history rows; orphaned media is reclaimed only when no owner remains |
| Generation history soft delete | [verified] workbench history delete/bulk-delete marks rows `deleted`; default listings and ID reads hide tombstones, stale create/update/full-restore/CAS writes return 410, and retention purge requires both `status='deleted'` and an expired `deleted_at`. Project cascade cleanup still hard-deletes project-scoped jobs, while internal media ownership can use explicit `includeDeleted` listings |
| v0.4.5 canvas and prompt-library regressions | [verified] grouping, pointer-release recovery, ordinary-node `@` reference input, retained prompt text, bounded long-model layout and a 1,000-item prompt-catalog selector regression are covered independently |
| Safe prompt-detail Markdown | [verified] prompt bodies render CommonMark/GFM without raw HTML, executable URL schemes, or remote body-image fetches; copy and insert preserve the original prompt body |
| User help entry | [verified] `/help` is reachable from desktop and mobile navigation and documents the local product's routes, authentication modes, generation, prompts, storage, administration and troubleshooting in independent Chinese copy |
| Preferred image models and aspect ratios | [verified] image workbench preferences persist bounded quick-model choices and common aspect ratios while retaining explicit dimensions and provider capability validation |
| Admin shared-channel model reconciliation | [verified] fetched models are previewed as selectable added/existing/removed differences before an administrator confirms the bounded replacement |
| APIMart current exact contracts | [verified] exact adapters remain fail-closed and validate only independently documented model identifiers and limits; undocumented marketing names, including Agnes, remain unsupported |
| Single canvas Agent entry | [verified] the legacy assistant panel and duplicate navigation entry are removed; one dockable `画布 Agent` retains Codex/Claude sessions, approvals, attachments, stop and unified generation-task status |
| Agent Skills management, draft confirmation and explicit invocation | [verified] the local Codex panel lists, creates, edits, enables/disables, deletes and explicitly invokes bounded `SKILL.md` entries; drafts use current canvas node context plus optional user supplement and remain editable until saved. Host-global Skills are intentionally restricted to local/guest execution, with real-directory/file checks, bounded UTF-8 metadata/content, versioned `If-Match` writes and the normal Codex permission/approval path for invocation |

## Tiger v0.5.0–v0.5.1 additive review

The public Tiger `v0.5.0` and `v0.5.1` deltas were rechecked on 2026-08-05
without reading implementation source, styles, fixtures, screenshots, or
bundled assets:

| Public behavior | Local status |
|---|---|
| Agent consolidation and homepage Agent entry | [verified existing] the local canvas already has one dockable `画布 Agent` entry and the Agent is integrated with the current project/canvas runtime |
| Panorama cross-origin loading fix | [verified existing] panorama content is resolved through managed same-origin media rather than upstream raw URLs |
| Aspect-ratio rounding fix | [verified existing] image geometry derives from a single scale factor and frozen aspect presets |
| Video size presets linked to ratio and resolution | [verified] the video workbench and video config nodes derive bounded ratio/resolution options from exact provider capability tables, preserve custom values for unknown providers, avoid assuming 16:9 for unrecognized ratios, preserve explicit node size overrides, and persist a linked pixel/native size preset through browser and durable generation paths |
| WebDAV cloud media storage | [not implemented] WebDAV remains a project/workspace backup transport; protected media uses the filesystem or S3/R2 backends |

## Basket v0.11.0–v0.13.0 additive parity

The public `basketikun/infinite-canvas v0.11.0`, `v0.12.0`, `v0.12.1` and
`v0.13.0` releases and current public CHANGELOG were rechecked on 2026-08-05
without reading implementation source,
styles, fixtures, screenshots, or bundled assets:

| Public behavior | Local status |
|---|---|
| Text-generation reasoning effort | [verified] text and text-config nodes persist low/medium/high effort and forward it through direct and server OpenAI-compatible requests |
| Drag-upload references in image/video workbenches | [verified] both workbenches accept up to ten filtered, de-duplicated dropped files and pass them into the existing reference pipeline |
| Configuration and preference import/export | [verified] versioned bounded JSON export excludes provider, object-storage and WebDAV credentials plus executable extension surfaces; import strictly validates channels, preserves current credentials/plugins/prompt sources, and flushes preferences to the database |
| Ark protocol and multi-file toolbar upload | [verified existing] exact Ark/Seedance mapping and multi-file media imports were already covered before this recheck |
| Three Codex permission levels and in-conversation approval | [verified] the input area selects read-only, workspace auto-execution without network (default), or explicit full access; the server validates the mode and sends matching turn-level approval/sandbox policies to Codex, while approval cards remain available |
| Collapsible task progress, dynamic tool status and process timeline | [verified] item lifecycle events merge by stable item id into bounded Chinese progress rows with running/completed/failed state, failure reason, incremental reasoning/command detail and a collapsible presentation |
| Immediate send/new-conversation feedback and long-wait status | [verified] sending clears the composer and renders an optimistic user message before attachment/network completion; new conversation clears the prior transcript before thread creation; running turns show elapsed time and a stop affordance |
| Turn-only stop, incremental assistant output and copy-safe Agent text | [verified existing] stop calls `turn/interrupt` without ending the service; assistant deltas stream incrementally; canvas shortcuts ignore textarea/input/contenteditable targets |
| Dated debug files, full history manager and file-manager reveal | [verified] `--debug`/`OPENBOARD_DEBUG` writes permission-restricted local-date debug files; Codex history is bounded, tenant/profile-scoped and durable with list/detail/restore/delete/bulk-delete plus transcript and progress replay; changed-file progress can reveal the validated path in the host file manager |
| Current-account Codex model and reasoning selection | [verified] the local bridge follows the official paginated `model/list` catalog, validates bounded model/effort pairs, exposes only advertised choices, sends optional `turn/start` overrides, retains valid choices in a tenant/user/profile-isolated database record, and falls back to Codex defaults when the catalog is unavailable, empty or stale |
| Structured Agent diagnostics and shared follow behavior | [verified] Codex and Claude diagnostics use fixed error/warning/activity filters, an independently scrollable expandable list, consecutive duplicate collapse, upward-scroll pause, and the same centered jump-to-bottom control as conversation history |
| Consecutive command progress collapse | [verified] runs of two or more consecutive command progress items in a turn fold into one count-collapsed `运行命令 · N` group with aggregated running/completed/failed state; verbose per-command previews stay hidden behind a per-group expander while lone commands and non-command items remain inline |
| v0.13.0 Agent initialization and transcript stability | [verified] entering a blank Agent conversation or starting a new one prewarms a reusable Codex/MCP session with concurrent-request deduplication and auth-scoped cache/same-account tab synchronization; Agent controls and Enter are disabled while initialization is pending; fenced Markdown code preserves line breaks; live SSE events and durable history share stable message ownership with replay deduplication and delayed-history merging; the floating node toolbar is withheld during node resize and returns afterward |

## Public baseline traceability

The frozen public inputs are the immutable v0.8.2 documents and hashes, plus
the additive release metadata through v0.13.0, listed
in `docs/BEHAVIOR_SPEC.md`. This table maps their named behaviors to local
implementation and verification surfaces; it does not use upstream source as
implementation evidence.

| Public behavior | Local evidence |
|---|---|
| Multi-project create/rename/delete/batch delete and JSON/media import/export | project lifecycle E2E, `board-document.test.ts`, `project-bundle.test.ts`, formal storage E2E |
| Pan, wheel/pinch/slider zoom, reset, fit, minimap, backgrounds and themes | canvas editing/touch/viewport E2E, `gesture.test.ts`, `geometry.test.ts` |
| Marquee/additive/all selection, delete, copy/paste with edges, undo/redo and shortcuts | canvas editing E2E, `history.test.ts`, `keyboard.test.ts` |
| Selected-node upstream/downstream node and edge highlighting | canvas editing E2E asserts related node and active edge rendering |
| Text/image/config/video/audio/panorama/director nodes, drag, resize, ports, metadata and preview | canvas/image/local-media/director/panorama E2E plus group drag E2E |
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
| Video first/last-frame reference mode for ordered image refs | `video-generation.ts`, Ark role mapping in `ai-client.ts` / server media executor, config/video/workbench UI, unit + Go + workbench E2E |
| Unified canvas Agent, project context, approvals, attachments, stop, Codex/Claude continuity and generation status | Agent runtime/MCP/Codex/Claude integration tests and single-entry canvas E2E |
| v0.12.0 dated Agent diagnostics, history and file-manager reveal | `server/internal/api/debug_log.go`, `codex_history.go`, `file_manager.go`, `server/internal/api/*_test.go`, `web/src/services/codex-history.test.ts`, `local-agent.test.ts`, and the Chromium Codex history-manager E2E; verified with Bun, Go (including `-race`/`vet`) and Playwright |
| v0.13.0 Agent initialization and transcript stability | `web/src/services/codex-transcript.ts`, `codex-transcript.test.ts`, `local-agent.ts` prewarm boundary tests, `agent-markdown.test.tsx`, node-action visibility tests, and the focused Chromium Codex E2E |
| Prompt search/source/tag filters, detail, cover/result gallery, copy, asset/canvas insert and declaratively mapped remote sources | prompt detail/library E2E, prompt-source manager E2E, formal storage E2E, and `prompt-sources.test.ts` |
| Asset text/image create, metadata edit, search/type filter, pagination, copy/download and canvas insert | full asset-library E2E and formal-storage E2E |
| WebDAV project and full-workspace backup/restore with workflow templates, nested workflow media, deduplication and no exported credentials | `SettingsModal.tsx`, `project-bundle.test.ts`, `workspace-bundle.test.ts` |
| Loopback New API query auto-configuration and remote-safe fragment configuration | `url-credentials.test.ts` and loopback-link E2E |
| Plugin install/enable/update/rollback/uninstall, sandbox, permissions, SDK and five examples | plugin unit tests plus registry/SVG/panorama E2E |
| Image/video workbenches and persistent generation history | `CreativeWorkbench.tsx`, `video-generation-options.ts`, workbench helper tests, side/bottom layout and concurrent-category E2E, draggable workflow-entry E2E, reusable-asset/reference-thumbnail E2E, generation-job tests, cancellation/retry E2E, and formal E2E |
| Multi-tab browser runtime, MCP tools, snapshots, Codex continuity, attachments, stop and approvals | Go runtime/MCP/Codex tests plus browser/Codex E2E |
| Public Unreleased unified generation status query across canvas/image/video workbench | `generation_get_status` MCP schema, unified activity tests, workbench/Agent E2E, and formal reload/orphan-recovery E2E |
| Public Unreleased client-scoped operations and focused-tab fallback | runtime pin/ownership Go tests and two-tab generation ownership E2E |
| Public Unreleased shared Codex session/running state, approvals and exact turn completion | Codex replay/state/approval Go tests, `codex-events.test.ts`, and two-tab Codex E2E |
| Public Unreleased addable custom prompt sources | JSON/HTML/Markdown mappings plus local transform scripts, migration tests, manager E2E, and PostgreSQL reload E2E |
| Community prompt catalog one-click install | `prompt-source-presets.ts`, unified JSON registry presets plus the Tiger Xianyu GPT-Image-2 Markdown catalog, fence-aware nested H2/H3/H4/H5 parsing (including numbered supplemental prompts), stable prompt identities, and prompt library E2E |
| Public Unreleased canvas prompt-library tab grouped by source | `CanvasPromptsPanel.tsx`, grouping unit tests, canvas prompt-panel E2E |
| Public Unreleased keep node prompt after generation | `NodePromptBar.tsx` retains draft text after successful generate |
| Node prompt multi-line paste and local wheel scroll | `prompt-chip-editor.ts`, `PromptChipInput.tsx`, unit tests and canvas E2E |
| Public Unreleased Codex user bubbles and open assistant replies | `CodexPanel.tsx` right-biased user bubbles and unlabeled assistant markdown |
| Public Unreleased Codex transcript stick-to-bottom and jump control | transcript auto-scroll plus `回到底部` when browsing history |
| Public Unreleased Codex image attachments create canvas image/config flow | `insertAttachmentImageNodes` + Codex attachment E2E |
| Consecutive command progress collapsed into a count-folded group | `codex-progress-groups.ts` pure grouping, `codex-progress-groups.test.ts`, and `CodexProgressList.tsx` per-group expander that hides verbose command previews by default |
| PostgreSQL authority, Redis cache, encrypted secrets and isolated formal testing | store/API tests, formal E2E, container smoke |
| Resizable/collapsible canvas panel with project, element, asset and prompt tabs | panel persistence, element selection/location/export and asset/prompt-panel E2E |
| Local prompt CRUD/copy/direct insertion and hover-revealed node names | prompt library and node-title E2E |
| Image/video/audio asset upload, preview, insertion, deletion and archive restore | asset E2E and `workspace-bundle.test.ts` |
| Active-canvas archive from the top bar and bounded multi-element ZIP export | project lifecycle and element panel E2E plus `node-export.test.ts` |

## Local Film Production Mode

- [verified] Project chain and dependency state: original text → `decompose` →
  `script` → `storyboard` → `first_frame` → parallel `audio`/`video` → `compose` → `delivery`,
  with revision conflicts, downstream invalidation and explicit review/approval.
- [verified] Bounded text/Markdown, DOCX OOXML and PDF text-layer import. Scanned
  or textless PDFs fail with an OCR-required diagnostic; no server-side OCR or
  arbitrary document execution is implied.
- [verified] Text/Markdown imports use a read-only preflight before deterministic
  adoption. AI decomposition and per-episode scripts execute as persistent text
  GenerationJobs, freeze source/model/prompt revisions, validate bounded JSON and
  remain immutable review candidates until explicitly adopted.
- [verified] Shot/dialogue/asset/task editing, identity age/costume/period/default
  variants, immutable generation-input snapshots, scoped storyboard/first-frame/
  audio/video generation, parent/child job state, failed-shot retry, five-track
  timeline validation, quality reports and restorable repair versions.
- [verified] Managed Film nodes are refreshed into the real canvas with stable
  projection keys; user nodes/layout survive refresh, approved canvas media can
  be adopted with blob integrity, GenerationJob and prompt/model provenance, and
  white-listed edits use entity revisions on commit.
- [verified] Film scenes can create or locate managed Director nodes on demand;
  adopted formal captures are server-validated, copied into stable Film storage
  and preserve scene/camera/capture/object-version provenance through quality,
  manifest and restore paths.
- [verified] A versioned tenant-visible media catalog is derived from enabled
  administrator channels without credentials. Generation, cost estimates and
  task snapshots share its resolved model/mode version and fail closed on unknown
  capabilities.
- [verified] The five-track timeline adds scale, playhead, drag/resize, snapping,
  keyboard adjustment and a horizontally scrollable mobile presentation while
  retaining precise forms, immutable drafts and revision-conflict handling.
- [verified] Manifest, SRT and asset-bundle exports do not depend on FFmpeg or
  real Provider credentials. MP4 is independently capability-gated by probed
  absolute FFmpeg/FFprobe paths and bounded render timeout/storage. All four
  exports use persistent, cancellable, restart-resumable GenerationJobs.
- [verified] Film aggregates are atomically stored for restore while PostgreSQL
  maintains a tenant/project/entity/revision projection in the same transaction.
- [verified] Read-only and confirmed write `film.*` Agent/MCP tools expose status,
  next steps, validation, stage approval, repair application and export without
  bypassing the normal API, authorization or revision checks.
- [verified] `OPENBOARD_FILM_MODE=false` disables Film routes without deleting
  project data. Missing media tools degrade only `mp4Export`; local/PM2 startup,
  other Film work and all non-Film services continue.
- [external] Storyboard/audio/video generation requires operator-supplied model
  configuration, credentials, quota and Provider availability. Paid real-Provider
  smoke is opt-in and is not a required CI fixture.

Evidence surfaces are `server/internal/api/film_*_test.go`,
`web/src/lib/film-*.test.ts`, `web/src/services/film-*.test.ts`, the explicit
credential-free Chromium `web/e2e/film.spec.ts` CI step, media-degradation script
tests, deployment-environment audit, and container capability smoke. These are
engineering tests of this repository; they are not an independent legal review.

## Intentional differences

- OpenBoard uses PostgreSQL, Redis and protected media files in every runtime;
  unlike the reference v0.8.2 browser-local design, it has one authoritative
  database-backed workspace store.
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
- OpenBoard adds audio nodes and durable audio jobs, image/video workbenches, plugin isolation, the browser
  runtime, expanded MCP tools, Film Production Mode and a production-shaped local backend. These are
  additive and do not redefine the frozen reference requirements.
- Hosted marketplace/payment infrastructure and organization-wide enterprise SSO
  remain outside this local multi-tenant product and parity claim.

## Verification summary

- [verified] Scoped policies: platform registration via `/api/platform/policy`; tenant custom/cloud channel and model policy via `/api/tenant/policy`; the legacy mixed `/api/site-policy` write requires both capabilities; AuthPanel registration and backend generation enforce their respective scopes
- [verified] AI call logs: backend proxy audit with request/response summary, duration, model/channel; admin browse/filter/delete/cleanup at `/ai-logs` with secret redaction
- [verified] Server material library: tenant-scoped URL/text catalog with browse/insert for users and admin CRUD (`/library`, `/api/library-assets`)
- [verified] 833 Bun unit/integration tests at the 2026-08-09 local verification baseline; the same run reports 82.24% line and 83.42% function coverage. `bun run --cwd web test:coverage` and CI fail if either aggregate metric is below 80%
- [verified] Go `test -race`, `vet`, API/WebSocket/MCP integration tests, and two binary builds; the v0.12.0 Agent follow-up also passes the focused API race suite
- [verified] 136 passed and 8 intentional environment skips across Chromium, Firefox, WebKit, and mobile Chromium in CI run `29621823209`
- [verified] 99/99 desktop Chromium scenarios passed against the production Vite build and isolated Go data directory in one sequential run (local run 2026-07-26)
- [verified] 52 passed and 12 intentional desktop-only skips in production mobile Chromium
- [verified] 7/7 formal PostgreSQL/Redis/media E2E with an isolated run ID, Redis DB 14, temporary media data, and zero test-database/Redis residue after cleanup
- [verified] Docker Compose build and hardened PostgreSQL/Redis runtime smoke in CI; the current gate also checks the non-root user, exact distro FFmpeg package, FFmpeg/FFprobe paths/probes and Film MP4 capability
- [verified] Clean-room identifier scan, deployment environment/script tests, strict direct-license audit, SPDX SBOM, and dependency vulnerability audit; container/base-image and FFmpeg redistribution review remain explicitly open release-audit items


### Public CHANGELOG Unreleased recheck (2026-07-24)

Public CHANGELOG still lists only these Unreleased names (no new release tag after v0.9.0):

| Public Unreleased name | Local status |
|---|---|
| Banana Prompt Quicker source | [verified] community preset `banana-prompt-quicker` → yukkcat/image-prompts dist JSON |
| Custom standard JSON sources | [verified] declarative JSON/HTML/Markdown + optional local transform scripts |
| My prompts (local manage / public save / canvas use) | [verified] PromptsPage mine tab + saveToMine + canvas insert |
| Unified Agent generation task status query | [verified] `generation_get_status` MCP/runtime |

Public progress TODO still only lists Claude Code CLI Adapter → Claude Agent SDK Adapter; remains **not targeted**.

### Public release recheck (2026-07-31)

- Basket latest public release is `v0.12.1`; this pass adds real turn-level
  Codex permissions, collapsible process progress, immediate composer/new-chat
  feedback and long-wait status on top of the v0.11.0 reasoning, drag-upload
  and credential-free preferences work. Dated debug files, full history
  management and file-manager reveal are now implemented and verified by the
  local API, Bun service, and Chromium Agent-history tests.
- The 2026-08-01 current-main recheck adds the current-account Codex model and
  reasoning picker plus structured Agent diagnostics and centered, reader-aware
  follow controls. These are implemented with the official Codex App Server
  `model/list` and `turn/start` contracts and shared local presentation code.
- Prompt/preset recheck adds the Tiger Xianyu GPT-Image-2 Markdown catalog
  (nested H2/H3/H4/H5 entries, numbered supplemental prompts, and stable IDs),
  common 1:1/3:2/2:3/4:3/3:4/16:9/9:16/21:9/5:4/4:5 image-size presets,
  provider-aware quality controls (GPT Image quality versus APIMart
  Seedream/Gemini 1K/2K resolution), adaptive size handling, and output-count
  limits. The admin catalog sync path accepts both JSON and structured Markdown
  sources.
- Tiger latest public release remains `v0.4.5`; current main is now
  `2fad4630d7478b630169e85ca35cc678ec57c7c1`, whose only post-tag public
  user-visible delta is the already-covered replacement of the separate canvas
  assistant with one authoritative `画布 Agent` entry.

### Public release recheck (2026-08-04)

- Basket latest public release is `v0.13.0`. The public release notes add
  background Codex/MCP prewarming for blank and new conversations, an
  initialization send gate, multi-line fenced-code rendering, shared live/history
  transcript ownership, and resize-safe floating node actions. These behaviors
  are implemented and covered by the new Bun unit tests and focused Chromium
  Agent E2E; the public behavior source is recorded in `docs/BEHAVIOR_SPEC.md`.

### Tiger public release recheck (2026-07-28)

The public Tiger release tag is `v0.4.5@9435f1c`. The formerly Unreleased
canvas refinements shipped in that tag together with local-channel generation,
ordinary-node reference input, prompt-library performance, prompt-detail
Markdown and layout fixes. No implementation source or assets were read:

| Public Unreleased name | Local status |
|---|---|
| Ctrl/Cmd+G grouping with drag, resize, drag-in/out, delete, copy/paste | [verified] Ctrl/Cmd+G and Shift modifier, context-menu grouping, exact group bounds, same-frame drag-in/out, resize/move, deletion, copy/paste, undo/redo and reload tests |
| Prevent continuous dragging after repeated pointer operations | [verified] canvas-surface pointer capture for pan/marquee and node drag/resize/connect; unified release on pointerup/cancel/lostpointercapture/Escape; same-frame pointer-up reconciliation and remaining-pointer recovery |
| Node hover-toolbar styling | [verified behavior] hover/focus actions remain reachable, stop pointer propagation so they do not consume canvas drag gestures, and wrap within a bounded max width; visual expression is independently authored |
| Long model names no longer overlap the node prompt action | [verified] text/config model inputs use `min-w-0` + truncate with title tooltip; prompt-library select is fixed-width shrink-0; hover toolbar and node prompt composer cap max width so long model names do not overlap the send action |

## Data and canvas

- [verified] Schema v2 documents; v1/no-version read compatibility plus save-time upgrade and reload E2E
- [verified] Project create, rename, delete, batch delete, JSON and media-bundle import/export
- [verified] PostgreSQL authoritative persistence, Redis disposable cache, and protected filesystem media with no browser persistence fallback
- [verified] Pan, wheel/pinch zoom, slider, reset, fit, minimap, backgrounds, themes, culling, and 1k/10k indexes
- [verified] Marquee/multi-select, copy/paste/duplicate, align/distribute, drag/click connections, edge deletion, undo/redo, and shortcuts
- [verified] Text/image/config/video/audio/panorama/director/plugin nodes; ports, drag, resize, preview, metadata inspection, and prompt bars; director character and crowd inspectors expose visual eight-look/twenty-pose catalogs with arrow-key navigation
- [verified] Formal project persistence accepts every current node type, including panorama, director, and plugin; director screenshots use CAS metadata plus protected filesystem or S3/R2 blobs and recover in an independent browser context
- [verified] Native director scene v4, deterministic v1/v2/v3 migration, eight procedural character looks, twenty poses, actor/extra staging, six primitives, compact bounded instanced crowds, locked objects, protected server-backed GLB import/missing-state/versioned relink, move/rotate/scale gizmos, independent director/shot views, named multi-camera management, ground/composition guides, reload persistence, panorama environment binding, recoverable WebGL failure, and protected screenshot tray with preview/cleanup/batch canvas insertion
- [verified] Node camera-prompt controls for image/video/config generation with bounded structured persistence, raw-prompt retry assembly, result inheritance, zoom-independent portal UI, and import validation
- [verified] Native 2:1 panorama upload/reuse with toolbar/drop import choice between panorama and ordinary image nodes, text generation with up to eight arbitrary-aspect managed image references, fixed 2048x1024 quality/count controls, atomic 1–8 result batches, strict import/archive/rehydration validation, WebGL/2D/keyboard viewing, reload persistence, and per-result director handoff
- [verified] Titles above nodes with bounded inline edit; blank-canvas double-click node chooser with create/upload/asset-library insert at the pointer
- [verified] Same-frame group drag-in/out, 16px exit threshold, hover feedback, exact 24px automatic bounds, grouped movement, undo/redo, and reload
- [verified] Text font size 10-72px, prompt selection, node model override, and provider-default inheritance
- [verified] Immediate text-to-image flow with retained failed config node and retry path

## AI and creative tools

- [verified] Independent text/image/video/audio URL, key, protocol, and model settings
- [verified] Bounded global system prompt applied to all text, image generation, and image editing requests
- [verified] OpenAI, Ark/Seedance, Gemini, exact APIMart/KIE, and restricted declarative Template adapters
- [verified] Authentication, redirect, timeout, cancellation, rate/error, task polling, malformed response, and bounded-download behavior
- [verified] AES-GCM provider secrets; exported projects and WebDAV backups omit keys
- [verified] Transparent image background capability checks and provider mapping
- [verified] Image reverse prompting into a connected text node
- [verified] Reproducible image request metadata, missing-reference preflight failure, and expandable multi-result batches
- [verified] AI call-log request traceability records the resolved provider endpoint and ordered reference storage keys for image-to-image calls while redacting credentials and binary payloads
- [verified] Camera/lens/focal-length/aperture prompt expansion for image/video/config nodes; disabled controls leave prompts unchanged and retries never duplicate the camera block
- [verified] Draggable image split guides with normalized coordinates and lineage
- [verified] Crop, rotate, multi-angle, mask/inpaint, upscale, replacement, download, grouping, and cascade behavior
- [verified] Image and video workbenches with provider/model/refs/parameters, independent concurrent runs, aggregate cancellation, persisted side/bottom layout, bounded image categories/filtering, local/history reference thumbnails, result byte sizes, managed “My Assets” reuse, a draggable persisted workflow entrance, download/delete/regenerate, and canvas insertion; audio generation is available through canvas nodes and durable jobs but does not have a standalone workbench route; jobs use server-side OpenAI/Gemini/APIMart/KIE/restricted-Template image, OpenAI/Ark/APIMart/KIE/restricted-Template video, and OpenAI audio execution with renewable attempt-scoped leases, tenant blob persistence/quota release, polling and cancellation across browser reloads; canvas image/config/prompt actions create indexed durable image placeholders, and every supported canvas video/audio entry reconciles from the same durable jobs; Template image/video execution is limited to bounded JSON, exact known placeholders, safe relative paths and fixed auth modes with no script execution, and expansion is size-accounted before marshaling; image results require fully decoded PNG/JPEG and media results pass bounded container/signature checks; retry rejects missing references and history deletion preserves shared board/job media while reclaiming orphans
- [verified] PostgreSQL generation-job persistence, paginated CRUD and timestamp-preserving atomic bulk restore
- [verified] Project deletion and selected media-node deletion cascade-clean generation job history without affecting other projects
- [verified] Ordinary project autosave never deletes remote projects; explicit delete and workspace replacement remain the only removal paths
- [verified] Workbench history multi-select bulk delete uses a bounded server bulk API or local batch delete; soft-deleted tombstones stay hidden from default history lists
- [verified] Generation history soft delete keeps internal tombstones for stale-write protection; default list and ID reads hide them, while explicit internal `includeDeleted` queries support media ownership and retention cleanup
- [verified] Protected media can use the default shared filesystem, process-level S3/R2, an enabled single tenant preference, or a tenant-admin weighted S3/R2 pool with SigV4, immutable placement metadata, stable destination IDs, tombstoned deletion, safe pre-write failover, tenant-hashed keys, CAS overwrite, idempotent quota release, range responses, SSRF/DNS-rebinding protection and no browser credential disclosure; invalid enabled credentials fail closed
- [verified] WebDAV full-workspace bundle v2 includes projects, assets, prompts, personal workflow templates, generation history and nested deduplicated workflow media while preserving local credentials; v1 imports migrate to an empty template catalog
- [verified] Creative image workflow workbench supports public/personal template catalogs, strict typed variables and acyclic step references, AI-assisted preview-before-save, durable browser/formal execution, per-step image history, cancellation/snapshot retry, and atomic final-result insertion

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
- [verified] One-click community catalog presets for the Image Prompts unified JSON registry (including Banana Prompt Quicker) and the Tiger Xianyu GPT Image 2 Markdown catalog
- [verified] Built-in Image Prompts catalogs are always present after hydrate and preserve enablement/status on merge
- [verified] Prompt-source cards show count, sync status, and last success time; failed refresh keeps last success cache
- [verified] Prompt center 「我的提示词」 tab for local manage / save-from-public / canvas use
- [verified] Canvas prompt library supports cross-source search and inserts with title preserved
- [verified] Local transform scripts can convert non-standard fetched catalogs into prompt arrays with parseJson/queryAll helpers
- [verified] Custom prompt-source scripts may async fetchText/fetchJson additional URLs (local-friendly source URL policy for loopback/LAN)
- [verified] Prompt source URLs accept personal local http(s) hosts (127.0.0.1/localhost/private LAN) while public media stays HTTPS-first
- [verified] Canvas left-panel tab underline slides between projects/elements/assets/prompts
- [verified] Structured community Markdown parsing for labeled/fenced and numbered supplemental prompt blocks (H2-H5), with section tags, stable IDs, and image galleries
- [verified] Add/edit/disable/delete source manager, legacy URL migration, active-tab scheduling with authoritative persisted merges, nested JSON field paths, bounded HTML selectors, preview, and PostgreSQL reload persistence
- [verified] Executable source formats, prototype paths, unsafe selectors, credential-bearing URLs, redirects, explicit private hosts, oversized responses, and excessive entries are rejected
- [verified] Prompt cover and bounded result-image galleries with detail preview and canvas insertion
- [verified] Canvas left panel prompt-library tab groups prompts by source with collapse and insert/copy actions
- [verified] Node prompt bar keeps the last prompt text after a successful generation so users can refine and resubmit
- [verified] Node prompt chip editor preserves multi-line paste including blank lines, serializes Enter/block structure, and keeps wheel scrolling local instead of zooming the canvas
- [verified] Text/image nodes create connected video nodes; image-to-video includes the source image reference
- [verified] Smart Seedance duration and Ark fast-model `1080p` preflight rejection
- [verified] Video first/last-frame mode maps ordered image references to Ark `first_frame` / `last_frame` roles on canvas config/video nodes and the video workbench, persists through retry/reload, and is enforced at document import and server job validation
- [verified] Config nodes preview ordered text, image, video, and audio inputs; reordering changes the actual Ark reference request order
- [verified] Canvas Agent image attachments are validated, cancellable and inserted into an image/config flow before the turn starts

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
- [verified] Turn interrupt, concurrent-start prevention, turn-ID race handling, three validated turn-level permission modes, and structured progress
- [verified] Up to ten image attachments/30MB, MIME validation, `0600` files, explicit pending-upload cancellation, completion/failure/close cleanup, and orphan purge on restart
- [verified] Safe Markdown/GFM output, raw-HTML suppression, remote-image suppression, previews, stop, and approvals
- [verified] Codex user messages render as right-biased accent bubbles; assistant replies stay open left Markdown without role labels
- [verified] Codex transcript sticks to the latest message and exposes a jump-to-bottom control when the user scrolls up
- [verified] Codex tool/reasoning item events merge into a collapsible process timeline with Chinese labels, per-step status, bounded incremental detail and failure reasons
- [verified] Consecutive command progress items in a turn collapse into one count-labeled command group (running/completed/failed tallies) whose verbose per-command previews stay hidden behind a per-group expander; lone commands and non-command items remain inline
- [verified] Codex send/new-conversation actions update the visible transcript immediately; long-running turns display elapsed time and retain a stop action
- [verified] Codex image attachments become canvas image nodes connected into an image-generation config flow before the agent turn starts
- [verified] Independent `plugins/openboard` installer and Claude standard-MCP instructions

## Product boundary

- [verified] Local/offline compatibility plus token-protected or authenticated formal runtime; deployment may remain single-user or enable local multi-tenant accounts
- [verified] Local multi-tenant accounts with email login, tenant-scoped projects/state/jobs/blobs, session header isolation, and usage quotas (no payment processor)
- [not targeted] Hosted SaaS registration marketplace, external payment/billing providers, and org-wide enterprise SSO
- [verified] Browser-hosted Claude conversation UI via local Claude Code CLI stream-json bridge (Local Agent panel tab), optional OpenBoard MCP injection, stop/new-session controls
- [verified] Standard Claude MCP setup docs remain available for external Claude clients
- [not targeted] Upstream public TODO item to replace the Claude Code CLI adapter with a Claude Agent SDK adapter (docs-only signal as of 2026-07-23; not adopted as a parity requirement)
- [external] Real-provider paid smoke depends on user-supplied credentials and is never a CI fixture
- [external] Commercial clean-room, trademark/trade-dress, patent, contributor-rights, and market-specific legal sign-off
- [verified] Public license recheck on 2026-07-24: reference remains AGPL-3.0; OpenBoard continues as an independent clean-room product identity under this repository's own license and docs/CLEANROOM.md process
