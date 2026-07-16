# Behavior Specification Log

This log records neutral behavioral requirements used by the implementation.
It intentionally excludes upstream source, source-derived identifiers, CSS,
fixtures, and implementation structure.

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

## Evidence

- Automated evidence is in `web/src/**/*.test.ts`, `web/e2e/canvas.spec.ts`,
  `server/**/**_test.go`, and CI workflow definitions.
- Public protocol evidence includes OpenAI-compatible HTTP conventions, MCP
  transport conventions, JSON-RPC, and browser pointer events.
- Exact reference-project behavior remains an interoperability target, not a
  license to copy protected expression.

## Public source register

| URL | Accessed | Used for |
|---|---|---|
| https://github.com/basketikun/infinite-canvas | 2026-07-16 | Public project identity, feature surface, and black-box target reference |
| https://github.com/basketikun/infinite-canvas/blob/main/README.md | 2026-07-16 | Publicly described workflows and setup behavior |
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
