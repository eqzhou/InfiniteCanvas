# Behavior Specification Log

This log records neutral behavioral requirements used by the implementation.
It intentionally excludes upstream source, source-derived identifiers, CSS,
fixtures, and implementation structure.

## Frozen baseline

The current engineering baseline is `basketikun/infinite-canvas v0.8.2` as
described by public documentation and recorded black-box behavior available on
2026-07-16. Later upstream changes are out of scope until a new baseline is
explicitly adopted. The implementation team did not use upstream source, CSS,
plugins, fixtures, screenshots, or assets as implementation input.

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

## Evidence

- Automated evidence is in `web/src/**/*.test.ts`, `web/e2e/canvas.spec.ts`,
  `server/**/**_test.go`, and CI workflow definitions.
- The feature-to-evidence matrix is maintained in `docs/FEATURE_PARITY.md` and
  is frozen to the v0.8.2 scope above.
- Public protocol evidence includes OpenAI-compatible HTTP conventions, MCP
  transport conventions, JSON-RPC, and browser pointer events.
- Exact reference-project behavior remains an interoperability target, not a
  license to copy protected expression.

## Public source register

| URL | Accessed | Used for |
|---|---|---|
| https://github.com/basketikun/infinite-canvas | 2026-07-16 | Public project identity, v0.8.2 feature surface, and black-box target reference |
| https://github.com/basketikun/infinite-canvas/blob/main/README.md | 2026-07-16 | Publicly described workflows and setup behavior |
| https://github.com/basketikun/infinite-canvas/releases/tag/v0.8.2 | 2026-07-17 | Frozen release identifier and public release notes; URL availability verified without reading source files |
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
