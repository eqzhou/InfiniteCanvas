# Behavior Specification Log

This log records neutral behavioral requirements used by the implementation.
It intentionally excludes upstream source, source-derived identifiers, CSS,
fixtures, and implementation structure.

## Frozen baseline

The frozen core engineering baseline is `basketikun/infinite-canvas v0.8.2`
(`0c4288b8325c95a8bdca76e93737d07ffbc55f7e`) as
described by public documentation and recorded black-box behavior available on
2026-07-16. The public `v0.9.0` release delta published on 2026-07-17 was
adopted on 2026-07-18 as an additive interface target. Four public Unreleased
behaviors at commits `d4130bbb79`, `bdca6b0a5c`, `062e4569aa`, and
`5e1fd7a825` were adopted on 2026-07-19. A public recheck on 2026-07-23
confirmed the latest public release is still `v0.9.0` and the public TODO only
lists a Claude Agent SDK adapter follow-up (not yet adopted as a parity target).
The public deltas through Basket `v0.13.0` (with the Basket current-main
snapshot `main@ee5804e586a95a3cc127caa37f2b87e6ade5c28f` recorded on
2026-08-01) and Tiger current `main@2fad4630d7478b630169e85ca35cc678ec57c7c1`
were independently rechecked and adopted through 2026-08-04. The v0.13.0
release behavior names are
recorded from public release metadata and CHANGELOG only; no implementation
source was used.
Unlisted later upstream changes remain out of scope. The implementation team
did not use upstream source, CSS, plugins, fixtures, screenshots, or assets as
implementation input.

| Date | Surface | Public/observed input | Required observable result | Confidence |
|---|---|---|---|---|
| 2026-08-18 | Freestylefly prompt source | Install the built-in Freestylefly GPT Image 2 catalog from the prompt center | The public Image Prompts JSON source appears as a built-in preset and can be enabled without a custom URL | high |
| 2026-08-18 | Locate-node zoom | Click locate on a left-panel element while zoomed above 100% | The node is centered and zoom is capped at 100%; a zoomed-out view only recenters | high |
| 2026-08-18 | Multi-image slot actions | Expand a multi-result image node and retry, delete, download, or copy one result | Failed leaves can retry in place; deleting one slot keeps the others; download and copy do not change the remaining batch | high |
| 2026-08-18 | Director camera move | Add a camera move, record keyframes, choose a speed curve, and preview | Playback interpolates the stored keyframes in the viewport; stored cameras are unchanged until the user records a keyframe | high |
| 2026-07-16 | Canvas camera | Pointer drag, wheel, pinch, reset, fit | Viewport translates/scales around the expected anchor and remains bounded | high |
| 2026-07-16 | Selection/history | Marquee, additive select, delete, undo/redo | Selection and history preserve ordering; redo is invalidated by a new edit | high |
| 2026-07-16 | Media nodes | Import image/video/audio, resize, preview, transform | Media remains inspectable, persists locally, and derived images retain lineage metadata | high |
| 2026-07-16 | Project data | JSON/ZIP export and import with invalid data | Valid projects round-trip; malformed geometry, IDs, references, and unsafe archive paths are rejected | high |
| 2026-07-16 | AI providers | OpenAI-compatible generation and Ark/Seedance task polling | Authentication, rate, timeout, cancellation, terminal status, and malformed responses are surfaced explicitly | medium |
| 2026-07-16 | Plugins | Install manifest, consent, sandbox message, state persistence | Remote executable content requires explicit consent, bounded state/messages, and opaque isolation | medium |
| 2026-07-16 | Local agent | Go health/status, project sync, MCP, Codex session | Authenticated local APIs expose validated tools; Codex streams notifications and requires explicit approvals | medium |
| 2026-07-16 | Responsive UI | Desktop, mobile Chromium, Firefox, WebKit | Primary canvas/media/asset/Prompt workflows remain usable without horizontal overflow | high |
| 2026-07-17 | Versioned canvas | Load v1, edit titles/fonts/models, double-click blank canvas, cross group bounds | Documents upgrade to v2 without loss; interactions persist and participate in history | high |
| 2026-07-17 | Creative workbenches | Configure four provider protocols, generate/retry/cancel, inspect history | Independent endpoints remain isolated; jobs and results persist and can be inserted into a board | high |
| 2026-07-17 | Image utilities | Request transparency/reverse prompt, drag split guides | Unsupported capabilities fail before request; derived nodes preserve normalized lineage | high |
| 2026-07-17 | Plugin lifecycle | Normalize v1 manifest, consent, install/upgrade/rollback/uninstall | Host permissions are explicit; plugins never receive provider secrets | high |
| 2026-07-17 | Panorama | Load local or generated panorama with and without WebGL | Three.js renders interactive pixels; a 2D interaction fallback remains usable | high |
| 2026-07-17 | Browser runtime | Connect WebSocket, report state, execute identified commands, disconnect | Commands are validated, atomic where applicable, return structured results, time out, and never replay | high |
| 2026-07-17 | Codex continuity | Reuse/new thread, attach image, stop turn, approve tool | Profile thread persists; attachments are owner-only and cleaned; approval remains explicit | high |
| 2026-07-17 | Formal storage | Run isolated PostgreSQL/Redis/media E2E | Data reloads through the production-shaped stack and the temporary test stores are empty afterward | high |
| 2026-07-18 | Image generation replay | Generate one/many images, retry after reference loss | Requests retain model/size/quality/count/transparency/reference lineage; missing references fail before network use; multiple results remain grouped | high |
| 2026-07-18 | Plugin lifecycle | Disable and re-enable installed or built-in plugins | Disabled plugins cannot be added or executed; existing node state remains intact and becomes available after re-enable | high |
| 2026-07-18 | Prompt catalogs | Filter by tag, save/refresh/remove multiple remote sources, inspect result images | Filters are independent; refreshed entries replace stale cache; bounded HTTPS galleries remain inspectable | high |
| 2026-07-18 | Video creation | Generate video from text/image nodes with smart or explicit duration | A connected video node is created; image references are forwarded; unsupported Ark duration/resolution combinations fail before request | high |
| 2026-07-18 | Assistant images | Paste, preview, remove, insert, send, and reinsert images | Attachments remain visible and controllable without exposing provider credentials or requiring a chat turn | high |
| 2026-07-18 | Workspace backup | Upload and restore projects, assets, prompts, generation jobs, shared media, and local configuration through WebDAV | Media is deduplicated and remapped; provider/WebDAV credentials are excluded; failed persistence removes newly imported blobs and restores prior data | high |
| 2026-07-18 | Multi-tab runtime | Open multiple OpenBoard tabs and execute live board tools while tabs connect, report state, and close independently | Tabs do not evict one another; commands route to the most recently active runtime; disconnect only cancels that tab's pending commands | high |
| 2026-07-18 | Config text batches | Select text mode and request 1-8 alternatives from a generation config node | The requested number of text calls complete before connected result nodes are committed | high |
| 2026-07-18 | New API local link | Open a loopback URL containing legacy `apiKey` and `baseUrl` query parameters | The active text provider is populated and the sensitive query is immediately removed; non-loopback deployments require a fragment link | high |
| 2026-07-18 | Prompt media references | Type `@` in a node prompt with connected media | The menu inserts labeled thumbnail chips; chips delete atomically and serialize into deterministic media labels forwarded with the request | high |
| 2026-07-18 | Port connections | Click an output port, then click an input port | The pending connection remains armed between clicks and commits one edge; blank click or Escape cancels it | high |
| 2026-07-18 | Overlay dismissal | Open stacked canvas/panel/modal overlays and press Escape | Only the visually topmost dismissible surface closes; another Escape closes the next surface | high |
| 2026-07-18 | Fast group drag | Dispatch move and pointer-up before the next animation frame | Final geometry and group membership commit atomically; 24px bounds, 16px exit, undo/redo, and reload remain consistent | high |
| 2026-07-18 | Ordered config inputs | Reorder connected media and execute an Ark video config | Preview numbering, persisted `inputOrder`, and provider reference array use the selected order | high |
| 2026-07-18 | Legacy save and workbench cancellation | Import v1 then reload; cancel a running workbench request then retry | The project persists as v2 without loss; the cancelled job remains in history and retry creates a successful job | high |
| 2026-07-18 | Global system prompt | Configure a global instruction, then generate or edit text/images | Every text request receives a system instruction and every image prompt receives the instruction before the user prompt | high |
| 2026-07-18 | Workbench media lifecycle | Retry a job after reference loss; insert a result then delete its history | Missing references block the request; shared board/job media survives history deletion; unowned references and results are reclaimed | high |
| 2026-07-18 | v0.9 workspace navigation | Resize/collapse the canvas side panel, switch project/element/asset views, select and locate elements | Panel state persists; multi-selection mirrors the canvas; viewport movement is animated and bounded | high |
| 2026-07-18 | v0.9 asset workflow | Upload and preview image/video/audio assets, insert or delete them from the canvas panel | Media persists through the formal storage API; deletion reclaims only unreferenced protected blobs | high |
| 2026-07-18 | v0.9 prompt and node presentation | Manage local prompts and inspect a canvas node without selecting it | Local prompts create/edit/copy/insert/delete without replacing remote entries; node titles appear on hover/select/edit | high |
| 2026-07-18 | v0.9 export workflow | Select multiple elements or export the active canvas archive from the top bar | Selected elements download as a bounded ZIP; the active project downloads as a media-complete `.openboard` archive | high |
| 2026-07-19 | Unreleased prompt sources | Add, map, preview, schedule, edit, disable, refresh, and remove custom sources | Legacy URLs migrate without loss; JSON/HTML/Markdown mappings persist; local transform scripts return prompt arrays; unsafe network/content inputs are rejected | high |
| 2026-07-19 | Community prompt catalogs | Install and refresh public community prompt repositories from the prompt library | Five public raw catalogs install with declarative mappings; labeled/fenced Markdown entries become searchable prompts with tags and covers | high |
| 2026-07-21 | Image Prompts registry | Install Banana Prompt Quicker and community catalogs from unified JSON | Built-in presets load yukkcat/image-prompts dist JSON; custom standard JSON sources remain supported | high |
| 2026-07-21 | Prompt source status cache | Refresh remote sources from the manager or library cards | Cards show count/sync/last success; failed refresh keeps last successful items | high |
| 2026-07-21 | My prompts | Save public prompts into local mine tab and use them on canvas | Local CRUD remains independent of remote source removal | high |
| 2026-07-20 | Canvas prompt library panel | Open the canvas left-panel prompt tab and insert a grouped entry | Prompts are collapsible by source; insert creates a text node without leaving the canvas | high |
| 2026-07-20 | Node prompt retention | Generate from a node prompt bar | The prompt draft remains after success so users can refine and resubmit | high |
| 2026-07-20 | Codex chat layout | Send user and assistant messages in the Codex panel | User text uses a right-biased accent bubble; assistant text stays open left Markdown without role labels | high |
| 2026-07-20 | Codex transcript navigation | Receive new messages or scroll the history | The transcript sticks to the latest message; scrolling up reveals a jump-to-bottom control | high |
| 2026-07-20 | Codex attachment canvas flow | Attach images and send a Codex turn | Each image becomes a canvas image node connected into a generation config node while still uploading to Codex | high |
| 2026-07-20 | Prompt source transform scripts | Add a script-format source, preview, and refresh | Fetched text is transformed by the user script into validated prompt items; invalid script output is rejected | high |
| 2026-07-19 | Unified generation status | Query generation progress from canvas nodes or image/video workbench tasks, including after reload | `generation_get_status` returns normalized queued/running/succeeded/failed/cancelled state for bounded `nodeIds` or an owned `taskId`; interrupted owned workbench jobs become retryable failures | high |
| 2026-07-19 | Client-scoped Agent operations | Start a turn in one tab, focus/close other tabs, and return tool results | The initiating client remains pinned for the turn; foreign results are ignored; disconnect falls back only to the most recently focused client on the same project | high |
| 2026-07-19 | Shared Codex state | Send, stop, approve, switch, reload, and open a second tab while a turn/tool is running | Session, user messages, resolved approvals and running state replay across tabs; thread-mismatched events are ignored; tool completion does not unlock the turn | high |
| 2026-07-23 | Public recheck | Re-read public README feature inventory, releases list, and progress TODO without source inspection | Confirmed latest public release remains `v0.9.0`; no new public release delta adopted; public TODO Claude Agent SDK adapter remains not-targeted | high |
| 2026-07-24 | Public recheck | Re-read CHANGELOG Unreleased names, features.mdx, releases API, and progress TODO without source inspection | Latest public tag still `v0.9.0` (2026-07-17); CHANGELOG Unreleased names Banana Prompt Quicker / custom standard JSON / My prompts / unified Agent generation status already covered by verified local behaviors; public TODO remains Claude Agent SDK adapter (not-targeted) | high |
| 2026-07-24 | Creative image workflows | Create/copy/edit personal templates, fill typed variables, run single/series DAG steps, refresh while active, cancel/retry, insert final images, and export/import the workspace | Template and run snapshots are strictly bounded; formal runs use an isolated leased coordinator and deterministic server image children; every successful step appears in image history; final results and nested media survive reload and workspace bundle v2 restore | high |
| 2026-07-24 | S3/R2 protected media | Select a private S3-compatible backend, then upload/read/overwrite/delete tenant media and execute server generation | Existing authenticated blob URLs remain stable; objects are tenant-isolated, bounded and conditionally replaced; deletion and failed writes preserve quota accounting; credentials stay server-side | high |
| 2026-07-25 | User-level S3/R2 media | Enable Settings object storage with encrypted credentials, then upload/read/delete protected media; disable or clear credentials and retry | Enabled tenant preferences route blobs to the user bucket ahead of process OPENBOARD_S3_*; invalid enabled credentials fail closed; disabled preferences fall back to process/filesystem storage; secrets remain server-side | high |
| 2026-07-25 | Canvas pointer capture cleanup | Start pan, node drag, resize, or connect, move outside the surface, then release or cancel the pointer | Drag state ends; subsequent blank-canvas move does not pan; node geometry commits on release when applicable | high |
| 2026-07-25 | Long model-name node controls | Set a very long model id on a text node and a config node, then inspect the model row and prompt composer | Model text truncates inside its field with a title tooltip; adjacent prompt-library/send controls remain visible and clickable without horizontal overflow of the node chrome | high |
| 2026-07-24 | Durable server video/audio | Start OpenAI or Ark video work, or OpenAI-compatible speech, from the formal workbench/canvas and reload while it runs | Independent leased workers persist validated protected results; video restart resumes the checkpointed provider task; canvas placeholders reconcile to success or a retryable terminal error; unsupported protocols keep the browser path | high |
| 2026-07-25 | Director visual cast catalog | Browse character looks and poses for an actor or crowd from the director inspector using pointer or keyboard | Eight looks and twenty poses render distinct thumbnails from the same procedural definitions as the 3D scene; selection updates the staged object immutably and survives undo, redo, export, and reload | high |
| 2026-07-25 | Tiger public recheck (historical) | Re-read public Tiger CHANGELOG and release metadata without source inspection | At that date the latest tag was `v0.4.4`; this snapshot is superseded by the 2026-07-28 v0.4.5 recheck below | high |
| 2026-07-25 | Tiger image-workbench public recheck | Re-read Tiger's public feature documentation without inspecting source or bundled assets, then switch layout, start two categorized jobs, filter history, reuse an image asset, and drag/reload the workflow entrance | Side/bottom layout persists; jobs execute independently and can be cancelled together; bounded categories survive job persistence and filter history; input/history thumbnails and output byte sizes render; managed image assets become references; the workflow entrance remains within the viewport and restores its dragged position | high |
| 2026-07-25 | Video first/last frames | Choose 首尾帧 on a video workbench/config/video entry, provide two ordered images, generate with Ark/Seedance, then retry after reload | The first image is sent as `first_frame`, the second as `last_frame`, later images remain ordinary references, and the mode survives job persistence/retry without inspecting upstream source | high |
| 2026-07-25 | Prompt multiline paste and wheel | Paste multi-line text with blank lines into a node prompt bar, blur/reselect the node, then wheel over the prompt | Newlines and blank lines persist in the draft; wheel scrolls the prompt without changing canvas zoom | high |
| 2026-07-25 | Generation history cascade cleanup | Create jobs under two projects, delete one project and a media node with generationJobId in the other | Only the deleted project's jobs disappear; node-linked job history is removed; remaining project history stays intact | high |
| 2026-07-25 | Multi-tab project catalog isolation | Open project A in tab 1 and project B in tab 2, edit A, then delete B only from tab 2 | Saving A never removes B; deleting B removes only B and its generation history |
| 2026-07-25 | 2:1 local image import choice | Upload or drag a strict 2:1 JPEG/PNG/WebP onto the canvas, choose panorama or ordinary image, then reload | Confirming creates a panorama node with equirectangular projection; declining creates an ordinary image node; non-2:1 images remain ordinary without a prompt | high |
| 2026-07-25 | Director image environment | Connect an ordinary image or 2:1 panorama node to a director, select it as environment, then disconnect | Connected image/panorama appears in the environment list and lights the viewport when media is present; disconnect removes it from the director environment selection without deleting the source node | high |
| 2026-07-25 | Blank-canvas chooser media insert | Double-click blank canvas, choose upload or asset-library insert, place media | Menu exposes upload and asset-library actions; inserted media/nodes land at the double-click world position | high |
| 2026-07-25 | Server material library | Open /library, browse shared URL/text assets, insert to canvas; admin create/edit/delete | Users see tenant catalog and can insert; admins can manage entries via /api/library-assets; non-admins cannot mutate | high |
| 2026-07-25 | AI call logs | Run a backend proxy generation job, open /ai-logs as admin, inspect request/response, delete selected or cleanup by age | Logs show kind/status/model/channel/duration without secrets; non-admins are blocked; cleanup removes only older entries | high |
| 2026-07-31 | AI request traceability | Open an image/text/video/audio call detail after a server generation, then inspect an image-to-image request | Detail shows the sanitized HTTP method and actual provider endpoint; image-to-image rows list ordered reference storage keys and basic metadata without persisting binary data or credentials | high |
| 2026-07-25 | Admin site policies | As admin, toggle registration/custom-channel/cloud-channel in Settings; try register and backend generation when disabled | Disabled registration returns forbidden; custom-channel off blocks add-channel; cloud-channel off blocks backend generation jobs; defaults are open | high |
| 2026-07-25 | Workbench history bulk delete | Create two completed workbench history cards, select both, bulk delete, then refresh | Both selected cards disappear in one action; unselected history remains; server history listing no longer returns the deleted ids |
| 2026-07-28 | Generation history tombstones | Delete a completed workbench history card, then attempt default list/ID reads, stale create/update, full restore, versioned writes, and retention purge | The job disappears from default list and ID reads; stale writes/restore collisions return 410; purge removes only expired rows whose status and `deleted_at` both identify a tombstone | high |
| 2026-07-25 | Director screenshot synchronization | Capture, preview, send, delete, clear, reload, and open the same director from an independent browser session | The server validates the complete PNG, stores tenant version metadata and a protected quota-accounted blob, restores it across sessions, compensates failed metadata writes, and reclaims deleted-project/expired-orphan media | high |
| 2026-07-25 | Durable Gemini canvas images | Start a two-result Gemini image request from a canvas image/config/prompt entry, reload while the provider is running, then reload after completion | The Go worker sends header-only credentials and bounded inline references, persists two validated protected results, and maps each result index back to its durable placeholder; the batch and media survive reload while offline mode retains browser execution | high |
| 2026-07-25 | Durable restricted Template images | Start a formal image job using a declarative Template, reload while its PUT request is running, then read the protected result | The server validates a bounded JSON-only template, compiles exact allowed placeholders, applies the selected header-auth mode, blocks unsafe endpoints/redirects/scripts, validates the returned image, and restores the successful job after reload | high |
| 2026-07-25 | Durable restricted Template video | Start a formal Template video PUT, reload while it is running, then read its signed output through protected storage | The leased worker compiles bounded duration/ratio/resolution and typed media-reference placeholders, keeps the header credential server-side, rejects redirects and oversized expansion before marshaling, downloads and validates the video, and restores the terminal job after reload; cancellation aborts the provider request | high |
| 2026-07-23 | Claude conversation UI | Open Local Agent, Claude tab, start session, send prompt, stop turn | Local Claude Code CLI streams assistant deltas into the sidebar; optional MCP config is attached when openboard-mcp is installed | medium |
| 2026-07-23 | Prompt center presentation | Open formal local `/prompts` with server storage | Dense library shell remains usable: collapsible sources, library/mine tabs, filters, insert/detail/copy, and existing remote/local counts preserved | high |
| 2026-07-28 | Tiger v0.4.5 public recheck | Read the public v0.4.5 release page and behavior names without inspecting implementation source or assets | Grouping, local-channel generation, ordinary-node `@` input, prompt-catalog drag performance, pointer release, prompt-detail Markdown and bounded toolbar/model layout each map to an independent local behavior or an explicit authentication difference | high |
| 2026-07-28 | Prompt detail and help | Open a Markdown prompt detail, copy/insert it, then navigate to `/help` from desktop/mobile navigation | GFM renders without raw HTML, executable URL schemes or remote body-image loads; copy/insert keeps the original body; help documents the current OpenBoard routes and auth modes | high |
| 2026-07-28 | Workbench and channel preferences | Choose an image aspect/model, switch channels, refill history, reload, then fetch an admin channel model catalog | Custom sizes and per-channel/per-kind model preferences persist and safely fall back when retired; fetched models are previewed as added/existing/removed and do not overwrite configuration before confirmation | high |
| 2026-07-28 | Exact APIMart contracts | Submit exact Seedream 5.0 Pro, Gemini 3.1 Flash Lite Image / Nano Banana 2 Lite, HappyHorse 1.1 and Kling 3.0 Turbo requests, including promptless first-frame video | Only documented exact IDs, bounds, reference modes and JSON fields are accepted; promptless video reaches the worker only for documented first-frame modes; unknown names including Agnes fail closed | high |
| 2026-07-28 | Optional account boundary | Create the first account, then request projects, state, blobs and shared channels with no session or only the process token | Protected data-plane routes return 401 and the SPA shows the login wall while preserving the requested route; `off` remains the only no-account mode | high |
| 2026-07-25 | Left-panel asset drag | Drag a sidebar asset card onto the canvas surface | Asset is inserted as a node near the drop world point; click insert still works | high |
| 2026-07-31 | Basket v0.11.0 public recheck | Read the public v0.11.0 release and CHANGELOG behavior names without inspecting implementation source | Text nodes expose persisted reasoning effort; image/video workbenches accept bounded drag-upload references; versioned configuration/preferences files exclude secrets and import into the authoritative database | high |
| 2026-07-31 | Basket v0.12.0 public recheck | Read the public v0.12.0 release and CHANGELOG behavior names without inspecting implementation source | Codex offers three real turn-level permission modes, retains in-conversation approval, folds item events into collapsible step progress, shows elapsed waiting, and updates send/new-conversation feedback immediately; dated debug files, durable full history management, and validated file-manager reveal are implemented and verified locally | high |
| 2026-07-31 | Basket v0.12.1 public recheck | Read the public v0.12.1 release and current CHANGELOG behavior names without inspecting implementation source | Codex reads the current account's advertised model/reasoning catalog, safely falls back to Codex defaults, and retains valid choices for later turns without storing them in browser storage | high |
| 2026-07-31 | Prompt and preset parity recheck | Read public Basket/Tiger CHANGELOG and feature documentation plus the named public Xianyu catalog shape | The prompt center includes the Tiger Xianyu nested H2-H5 Markdown source with stable IDs; admin sync accepts JSON/Markdown; image size, quality/resolution and output-count controls are shared, normalized at every request boundary, and filtered by known model capabilities | high |
| 2026-07-31 | Project-scoped voice cast | Configure narrator/character voices for one canvas, bind an audio node, change or remove the role, export/import and reload | Provider/default voice stays global; reusable roles persist only inside that project document; nodes follow role changes unless they explicitly override the voice; removing a role clears only the stale binding and legacy global roles migrate once after the project write succeeds | high |
| 2026-07-31 | Tiger Agent consolidation | Read the public Tiger Unreleased behavior name without inspecting implementation source | The legacy assistant and duplicate navigation entry are absent; one dockable canvas Agent provides the existing Codex/Claude, approval, attachment, stop and generation-status workflows | high |
| 2026-08-01 | Basket structured Agent diagnostics | Read public CHANGELOG and commit titles without inspecting implementation source | Codex and Claude expose fixed diagnostic filters above an independently scrollable log, expandable details, and consecutive duplicate collapse | high |
| 2026-08-01 | Basket Agent follow behavior | Read public CHANGELOG and commit titles without inspecting implementation source | Conversation and diagnostic logs follow new output while at the bottom, pause when the reader scrolls upward, and expose the same centered jump-to-bottom control | high |
| 2026-08-01 | Tiger current-main recheck | Read public release/CHANGELOG metadata and commit titles without inspecting implementation source | The sole post-v0.4.5 user-visible delta is the already-covered single canvas Agent consolidation; no additional local gap was found | high |
| 2026-08-02 | Director formal shot | Capture one director camera, select exactly one synchronized capture, and choose the explicit model-backed action | The capture keeps an immutable bounded camera/scene snapshot; one atomic capture → editable config → result chain is committed; the copied reference survives tray deletion; the existing server image channel, timeout, audit and recovery path executes the job; retry remains bound to the saved channel and editable prompt | high |
| 2026-08-04 | Basket v0.13.0 Agent initialization and transcript stability | Enter a blank Agent conversation, start a new conversation, send while Codex/MCP initializes, render a multi-line fenced code block, refresh/open another window during a turn, and resize a selected node | Codex/MCP prewarming is deduplicated and runs before the first turn; Agent controls and Enter remain disabled during initialization; fenced Markdown preserves line breaks; live SSE events and durable history use one stable transcript identity without replay duplicates and delayed hydration does not discard newer output; the floating node toolbar is paused during resize and returns afterward | high |

## Evidence

- Automated evidence is in `web/src/**/*.test.ts`, `web/e2e/canvas.spec.ts`,
  `server/**/**_test.go`, and CI workflow definitions.
- The feature-to-evidence matrix is maintained in `docs/FEATURE_PARITY.md` and
  covers the v0.8.2 core, the explicitly listed deltas through v0.13.0, and the
  current Tiger v0.4.5 convergence.
- Public protocol evidence includes OpenAI-compatible HTTP conventions, MCP
  transport conventions, JSON-RPC, and browser pointer events.
- Exact reference-project behavior remains an interoperability target, not a
  license to copy protected expression.

## Public source register

| URL | Accessed | Used for |
|---|---|---|
| https://github.com/basketikun/infinite-canvas/tree/v0.8.2 | 2026-07-18 | Frozen public project identity and target commit `0c4288b8325c95a8bdca76e93737d07ffbc55f7e` |
| https://github.com/basketikun/infinite-canvas/blob/v0.8.2/README.md | 2026-07-18 | Public overview and New API local-link behavior; blob `32c4bf4493788fe0f8a8cbafe146fad04bcf3ea6` |
| https://github.com/basketikun/infinite-canvas/blob/v0.8.2/docs/content/docs/overview/features.mdx | 2026-07-18 | Public feature inventory; blob `69d5ffc8da68b595bfff9fb13b50063916d4d26b` |
| https://github.com/basketikun/infinite-canvas/blob/v0.8.2/docs/content/docs/canvas/canvas-node-manual.mdx | 2026-07-18 | Public node workflows; blob `fa09a603765d235080b0977e98930735950dc324` |
| https://github.com/basketikun/infinite-canvas/blob/v0.8.2/docs/content/docs/canvas/canvas-shortcuts.mdx | 2026-07-18 | Public shortcut behavior; blob `12865173d4e0f190b03d2694de42fb834d0c303a` |
| https://github.com/basketikun/infinite-canvas/blob/v0.8.2/docs/content/docs/progress/todo.mdx | 2026-07-18 | Publicly declared remaining reference-project work; blob `36ce0801b904de38c7b0a75344f2ee8f11b85c17` |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.8.2 | 2026-07-17 | Frozen release identifier and public release notes; URL availability verified without reading source files |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.9.0 | 2026-07-18 | Public release metadata used to define the additive interface delta; no release source, styles, screenshots, plugins, or assets were used |
| https://github.com/basketikun/infinite-canvas/releases | 2026-07-23 | Public release list recheck; latest tag remains `v0.9.0` |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.11.0 | 2026-07-31 | Public release metadata and user-visible change names for the v0.11 additive interface delta; no implementation source, styles, screenshots, plugins, or assets were used |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.12.0 | 2026-07-31 | Public release metadata and user-visible Agent behavior names; no implementation source, styles, screenshots, plugins, or assets were used |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.12.1 | 2026-08-01 | Public Codex current-account model and reasoning-selection behavior names; tag commit `6f1b6633b76e485312382f4d916d49af8a23afaa` |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.13.0 | 2026-08-04 | Public Agent prewarm, initialization gating, transcript ownership, Markdown rendering, and resize-stability behavior names; no implementation source, styles, screenshots, plugins, or assets were used |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.15.1 | 2026-08-11 | Frozen release `a2576d559ad765ba83e9563894adfbcd4e63405a`; public release metadata and public commit titles through v0.15.1 used to scope internationalization and confirm already-covered multi-image, canvas-tool, prompt-editor and Agent-reference behavior; no patches or source files inspected |
| https://github.com/basketikun/infinite-canvas/blob/main/docs/content/docs/overview/features.mdx | 2026-07-23 | Public feature inventory recheck (docs only; no source trees) |
| https://github.com/basketikun/infinite-canvas/blob/main/docs/content/docs/progress/todo.mdx | 2026-07-23 | Public remaining-work recheck; Claude Agent SDK adapter noted as not-targeted |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md | 2026-07-24 | Public Unreleased behavior names for prompt sources, generation status, tab ownership, and Codex synchronization |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md | 2026-07-31 | Public v0.12.1 release and current Unreleased behavior names for Agent/model/version/log/stream updates |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md | 2026-08-01 | Public current-main behavior names for structured diagnostic filters, duplicate collapse, expandable details, and centered follow controls; main commit `ee5804e586a95a3cc127caa37f2b87e6ade5c28f` |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md | 2026-08-04 | Public v0.13.0 behavior names for Agent prewarming, initialization gating, transcript/history ownership, multi-line code rendering, and resize stability; no implementation source was used |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/docs/content/docs/progress/pending-test.mdx | 2026-07-19 | Public black-box acceptance descriptions and exact `generation_get_status` interoperability name |
| https://raw.githubusercontent.com/tigerowo/infinite-canvas/main/CHANGELOG.md | 2026-07-25 | Public Tiger behavior names for persistent generation, workflows, S3/R2 configuration, panorama, camera controls, 3D director, grouping and pointer/layout refinements; SHA-256 `38111d82f76b2d46fe4f425a9112c307692970bbc462b5068fe9ef205662bc4b`; no implementation source inspected |
| https://raw.githubusercontent.com/tigerowo/infinite-canvas/main/CHANGELOG.md | 2026-07-31 | Public Tiger Unreleased Agent-consolidation behavior name; no implementation source inspected |
| https://github.com/xianyu110/awesome-gptimage2 | 2026-07-31 | Public catalog landing page used to verify the named Markdown prompt source; only its public catalog shape and URL are used, not prompt content as implementation input |
| https://github.com/tigerowo/infinite-canvas/blob/main/docs/overview/features.md | 2026-07-25 | Public image-workbench behavior inventory: side/bottom layout, concurrent tasks, persistent categories, reference/result metadata, reusable assets, and draggable workflow entrance; documentation only, no implementation source or assets inspected |
| https://api.github.com/repos/tigerowo/infinite-canvas/releases/latest | 2026-07-25 | Historical release metadata snapshot: at that date the latest tag was `v0.4.4`; superseded by the v0.4.5 row below |
| https://github.com/tigerowo/infinite-canvas/releases/tag/v0.4.5 | 2026-07-28 | Public v0.4.5 release metadata and user-visible change names; tag commit `9435f1c`; no implementation source or assets inspected |
| https://github.com/tigerowo/infinite-canvas/releases/tag/v0.5.2 | 2026-08-11 | Frozen release `4b5fdbff37a7de9bb29e90bc0fc9622a9e70a7b8`; public release notes used to scope WebDAV media, MiMo voice/text, Seedance 2.5 and desktop-client decisions; no implementation source or assets inspected |
| https://github.com/tigerowo/infinite-canvas/releases/tag/v0.5.3 | 2026-08-18 | Public release notes for guest local-channel adapter reuse, Grok2API parameter refresh, 2K/4K labels, workbench preset sync, select/move invert, locate-node 100% zoom, and resource-badge removal; no implementation source or assets inspected |
| https://github.com/tigerowo/infinite-canvas/releases/tag/v0.5.4 | 2026-08-18 | Public release notes for official GLM, director camera-move timeline and speed curves, director grid control, MiMo Agent image understanding, current-camera capture, and top-down camera orientation; no implementation source or assets inspected |
| https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md | 2026-08-18 | Public Unreleased Freestylefly GPT Image 2 source name and v0.15.0 multi-image/locate-zoom/select-move behavior names; no implementation source inspected |
| https://github.com/yukkcat/image-prompts/tree/main/dist/sources | 2026-08-18 | Public Image Prompts registry listing used only to confirm the `freestylefly-gpt-image-2.json` catalog identity and HTTPS URL |
| https://github.com/dramaclaw/dramaclaw/releases/tag/v1.3.2 | 2026-08-11 | Frozen release `07fd68bc4adfd7ce424f4b424b74d55d26afaf46`; public release notes and README behavior used to scope local ComfyUI workflows, stable video modes and film-production deltas; no implementation source, prompts, assets or UI expression inspected |
| https://api.github.com/repos/tigerowo/infinite-canvas/commits | 2026-08-01 | Public post-tag commit metadata only; current main `2fad4630d7478b630169e85ca35cc678ec57c7c1` names the already-covered Agent consolidation |
| https://learn.chatgpt.com/docs/app-server.md | 2026-08-01 | Official Codex App Server `model/list` catalog and `turn/start` model/effort override contract |
| https://docs.apimart.ai/en/api-reference/images/seedream-5-0-pro/generation | 2026-07-28 | Exact Seedream 5.0 Pro model ID, output count, resolution, ratio and reference-image contract |
| https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation-lite | 2026-07-28 | Exact Gemini 3.1 Flash Lite Image / Nano Banana 2 Lite aliases, resolution and reference-image contract |
| https://docs.apimart.ai/en/api-reference/videos/happyhorse-1.1/generation | 2026-07-28 | Exact HappyHorse 1.1 model, duration, ratio, resolution and reference-mode contract |
| https://docs.apimart.ai/en/api-reference/videos/kling-3.0-turbo/generation | 2026-07-28 | Exact Kling 3.0 Turbo model, duration, ratio, resolution and first-frame contract |
| https://api.github.com/repos/basketikun/infinite-canvas/commits | 2026-07-19 | Public commit hashes/messages and changed-file names only; implementation patches were not read |
| https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html | 2026-07-24 | Public SigV4 protocol and published GET-object signature test vector |
| https://modelcontextprotocol.io/specification/2025-11-25 | 2026-07-28 | MCP transport and tool lifecycle interoperability; replaces the retired legacy specification host |
| https://www.jsonrpc.org/specification | 2026-07-16 | JSON-RPC request, notification, response, and error semantics |
| https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events | 2026-07-16 | Browser pointer and touch event semantics |
| https://spec.openapis.org/oas/latest.html | 2026-07-16 | HTTP contract documentation conventions |

## Reference license record

| Repository | Detected license | SPDX | Branch | Verified |
|---|---|---|---|---|
| https://github.com/basketikun/infinite-canvas | GNU Affero General Public License v3.0 | AGPL-3.0 | `main` | 2026-07-23 |

The record was first checked through the repository's public GitHub metadata API
on 2026-07-16 and reconfirmed via the public repository license label on
2026-07-23. This implementation does not copy, modify, translate, or link to
the reference source; it targets independently recorded behavior and uses a
different name, architecture, UI system, assets, and identifiers. A qualified
lawyer must still assess derivative-work, trade-dress, trademark, patent, and
network-source obligations for the intended distribution.

The reference project URL is used only as a public behavior target. No source
file, stylesheet, asset, screenshot, fixture, or source-derived identifier is
stored or used as implementation material.

## Open review

- [ ] Attach URLs and archived dates for each public behavior source.
- [ ] Independent reviewer signs off that no source code or source-derived notes
  entered implementation.
- [ ] Counsel reviews copyright, AGPL boundary, trademark/trade dress, patents,
  and distribution terms.
