# Provenance Register

This register records the intended origin of the current implementation. It is
an engineering record, not a legal opinion or proof that every historical
working-tree action was clean-room compliant.

## Implementation

| Area | Origin | Evidence |
|---|---|---|
| `web/src/lib` geometry, history, indexes, gestures | Original implementation from public behavior requirements and standard algorithms | Unit tests in the same module; no upstream files are vendored |
| React canvas and panels | Original implementation with independently chosen OpenBoard name, copy, colors, and layout | Playwright flows and screenshots generated in this repository |
| `docs/screenshots/final-responsive-canvas.png` | Screenshot generated from the local OpenBoard implementation at 1440×900 after the responsive shell review; no upstream visual asset is embedded | Browser geometry checks at 1440, 1024, 768, and 390 pixels plus responsive Playwright coverage |
| Go API, MCP, and Codex bridge | Original implementation using public HTTP, MCP, and JSON-RPC protocol concepts | Go tests, race detector, and fake app-server integration test |
| Fixtures under `web/e2e` | Independently generated test data | Test source records fixture bytes and expected behavior |
| AI adapters and image/video workbenches | Original provider-neutral contracts based on public protocol documentation | Mock-provider unit tests, workbench E2E, and formal generation-job persistence |
| Image-workbench productivity controls | Original React state, storage helpers, previews, and pointer interaction informed only by Tiger's public feature documentation | Helper unit tests plus production-build E2E for layouts, concurrency, categories, byte sizes, asset references, and draggable-entry persistence |
| Plugin registry, host, SDK, and examples | Original manifests, protocol, UI, and examples; Three.js is an MIT dependency | Permission/quota/catalog tests plus SVG and panorama E2E |
| Browser runtime and expanded MCP tools | Original ticketed WebSocket and command protocol | Go WebSocket/remote MCP tests and protected-snapshot E2E |
| WebDAV workspace bundles | Original bounded ZIP manifest, media remapping, credential filtering, and rollback protocol | Workspace bundle unit tests and formal generation-history restore E2E |
| Creative image workflows | Original typed template/DAG contract and leased workflow coordinator, informed only by Tiger's public README/features/CHANGELOG behavior descriptions | Workflow document/DAG/job tests, browser production E2E, Go lease/cancellation tests, and formal reload E2E |
| S3/R2 protected media | Original provider-neutral object boundary and dependency-free AWS Signature V4 client, informed by Tiger's public CHANGELOG name and the public S3 HTTP protocol | Object lifecycle, tenant isolation, CAS/quota, protected range API, signing, unsafe-configuration, and per-tenant Settings/object-storage preference routing Go tests |
| Durable server video/audio | Original leased job executors and provider-neutral checkpoint contract based on public OpenAI and Ark HTTP protocols plus Tiger's public persistent-generation behavior description | Go API/client/restart/media-validation tests, canvas recovery unit tests, and formal reload E2E with mock providers |
| Durable Gemini canvas images | Original extension of this repository's leased image-job and protected-blob boundaries using Google's public Gemini HTTP contract, informed only by Tiger's public persistent-generation behavior description | Gemini request/response/security Go tests, immutable indexed-placeholder/recovery unit tests, and formal reload E2E with a mock Gemini provider |
| Durable restricted Template image/video | Original Go implementation of this repository's pre-existing declarative browser template contract, using only bounded JSON traversal and standard HTTP concepts | Schema/compiler/expansion-size/auth/redirect/cancellation Go tests plus formal image/video reload E2E with mock Template providers and protected result readback |
| Director visual cast catalog | Original SVG projection of this repository's independently authored procedural character and pose definitions | Distinct/bounded preview-model tests plus keyboard selection, persistence, and reload E2E |
| Director screenshot synchronization | Original tenant resource contract built on this repository's protected blob and CAS-state boundaries, informed only by Tiger's public director/cloud-sync behavior names | PNG validation, isolation, quota compensation and prune API tests plus independent-browser formal E2E |
| Codex panel and OpenBoard Codex plugin | Original local integration over public app-server/MCP concepts | Fake app-server tests, Markdown/attachment/interrupt/approval E2E, owner-only connection-file tests |
| Codex model controls and Agent diagnostics | Original bounded adapter and shared React components based on the official Codex App Server protocol plus public Basket release/CHANGELOG behavior names | Fake app-server catalog/turn tests, Bun normalization/diagnostic tests, typecheck, and Agent E2E assertions |
| Film Production Mode | Repository-authored project/stage/timeline/delivery contracts using generic production-workflow concepts and public Provider protocols; recorded as a local additive capability rather than reference parity | Film Go/unit tests, Bun film document/import/timeline/client tests, credential-free Chromium Film E2E, and bounded FFmpeg/FFprobe capability tests |
| Deployment media capability | Repository-authored optional-capability diagnostics and hardened container integration; FFmpeg itself is the Alpine-distributed third-party package listed in `THIRD_PARTY_NOTICES.md` | Script RED/GREEN tests, deployment environment audit, exact-package container smoke, non-root/read-only/tmpfs checks, and capability endpoint verification |

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

The entries above record implementation intent and test surfaces only. They do
not close the unchecked contributor, similarity, dependency-notice, container
redistribution, or counsel review items.
