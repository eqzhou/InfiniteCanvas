# Provenance Register

This register records the intended origin of the current implementation. It is
an engineering record, not a legal opinion or proof that every historical
working-tree action was clean-room compliant.

## Implementation

| Area | Origin | Evidence |
|---|---|---|
| `web/src/lib` geometry, history, indexes, gestures | Original implementation from public behavior requirements and standard algorithms | Unit tests in the same module; no upstream files are vendored |
| React canvas and panels | Original implementation with independently chosen OpenBoard name, copy, colors, and layout | Playwright flows and screenshots generated in this repository |
| Go API, MCP, and Codex bridge | Original implementation using public HTTP, MCP, and JSON-RPC protocol concepts | Go tests, race detector, and fake app-server integration test |
| Fixtures under `web/e2e` | Independently generated test data | Test source records fixture bytes and expected behavior |
| AI adapters and image/video workbenches | Original provider-neutral contracts based on public protocol documentation | Mock-provider unit tests, workbench E2E, and formal generation-job persistence |
| Plugin registry, host, SDK, and examples | Original manifests, protocol, UI, and examples; Three.js is an MIT dependency | Permission/quota/catalog tests plus SVG and panorama E2E |
| Browser runtime and expanded MCP tools | Original ticketed WebSocket and command protocol | Go WebSocket/remote MCP tests and protected-snapshot E2E |
| Codex panel and OpenBoard Codex plugin | Original local integration over public app-server/MCP concepts | Fake app-server tests, Markdown/attachment/interrupt/approval E2E, owner-only connection-file tests |

## Reference behavior

Behavioral targets came from public project documentation, public demos, and
black-box interaction notes frozen to v0.8.2. No upstream source files, CSS,
SVGs, screenshots, plugins, or fixtures are stored in this repository. The
dated source register is in `docs/BEHAVIOR_SPEC.md`; independent reviewer and
per-file contributor sign-off remain required for an external legal claim.

## Assets and branding

No upstream logo, screenshot, or branded asset is intentionally bundled. The
OpenBoard mark, text, colors, icons, and UI copy are repository-authored or from
the listed icon dependency. Review generated screenshots before distribution.

## Review status

- [ ] Per-file author and review sign-off
- [x] Dated public behavior specification log
- [ ] Independent similarity review
- [ ] Counsel review for copyright, AGPL boundary, trademark, trade dress, and patents
