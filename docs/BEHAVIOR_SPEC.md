# Behavior Specification Log

This log records neutral behavioral requirements used by the implementation.
It intentionally excludes upstream source, source-derived identifiers, CSS,
fixtures, and implementation structure.

## Frozen baseline

The frozen core engineering baseline is `basketikun/infinite-canvas v0.8.2`
(`0c4288b8325c95a8bdca76e93737d07ffbc55f7e`) as
described by public documentation and recorded black-box behavior available on
2026-07-16. The public `v0.9.0` release delta published on 2026-07-17 was
adopted on 2026-07-18 as an additive interface target. Unlisted later upstream
changes remain out of scope. The implementation team did not use upstream
source, CSS, plugins, fixtures, screenshots, or assets as implementation input.

| Date | Surface | Public/observed input | Required observable result | Confidence |
|---|---|---|---|---|
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

## Evidence

- Automated evidence is in `web/src/**/*.test.ts`, `web/e2e/canvas.spec.ts`,
  `server/**/**_test.go`, and CI workflow definitions.
- The feature-to-evidence matrix is maintained in `docs/FEATURE_PARITY.md` and
  covers the v0.8.2 core and the explicitly listed v0.9.0 public delta above.
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
| https://spec.modelcontextprotocol.io/ | 2026-07-16 | MCP transport and tool lifecycle interoperability |
| https://www.jsonrpc.org/specification | 2026-07-16 | JSON-RPC request, notification, response, and error semantics |
| https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events | 2026-07-16 | Browser pointer and touch event semantics |
| https://spec.openapis.org/oas/latest.html | 2026-07-16 | HTTP contract documentation conventions |

## Reference license record

| Repository | Detected license | SPDX | Branch | Verified |
|---|---|---|---|---|
| https://github.com/basketikun/infinite-canvas | GNU Affero General Public License v3.0 | AGPL-3.0 | `main` | 2026-07-16 |

The record was checked through the repository's public GitHub metadata API on
2026-07-16. This implementation does not copy, modify, translate, or link to
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
