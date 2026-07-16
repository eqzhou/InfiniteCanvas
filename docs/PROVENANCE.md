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

## Reference behavior

Behavioral targets came from public project documentation, public demos, and
black-box interaction notes. No upstream source files, CSS, SVGs, screenshots,
or fixtures are stored in this repository. A dated URL/evidence log still needs
to be completed before an external clean-room claim.

## Assets and branding

No upstream logo, screenshot, or branded asset is intentionally bundled. The
OpenBoard mark, text, colors, icons, and UI copy are repository-authored or from
the listed icon dependency. Review generated screenshots before distribution.

## Review status

- [ ] Per-file author and review sign-off
- [ ] Dated public behavior specification log
- [ ] Independent similarity review
- [ ] Counsel review for copyright, AGPL boundary, trademark, trade dress, and patents
