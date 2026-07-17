# Clean-room policy

This file defines the required process. It does not by itself prove that the
current tree is uncontaminated. Because the repository began without a commit
history, a provenance review and a signed baseline are required before making
clean-room claims externally.

## Allowed inputs

- Public README, feature lists, release notes, API documentation, and demos
- Recorded black-box inputs, outputs, errors, shortcuts, and performance
- Standard protocols and independently licensed interoperability formats
- Independently created fixtures, visuals, copy, and acceptance tests

## Forbidden inputs

- Upstream source, CSS, SVG, logos, screenshots, fixtures, or code snippets
- Line-by-line translation or structural porting into another language
- Source-derived tests, identifiers, module boundaries, or schemas used as the
  independent team's specification
- Identical third-party branding, distinctive UI chrome, copy, or assets

## Required process

1. A specification role records only public documentation and observable
   behavior, with URL, date, input, output, and uncertainty.
2. An implementation role that has not inspected upstream source works only
   from that neutral specification.
3. Use original architecture, algorithms, identifiers, fixtures, copy, visual
   tokens, icons, screenshots, and assets.
4. Record each file's author/source, dependency SPDX license, design decision,
   and test evidence; preserve review and commit history.
5. Run similarity review against protected expression without importing
   upstream files into this repository or using them as implementation input.
6. Have counsel review copyright, AGPL, trademarks/trade dress, patents, and
   third-party assets before a commercial or closed-source release.

## Baseline audit gate

- [ ] Every existing source file has documented provenance.
- [ ] No implementer used upstream source or source-derived notes.
- [ ] UI copy, visuals, icons, and fixtures have independent provenance.
- [ ] Every dependency and bundled asset has an SPDX/license record.
- [x] Public behavior specifications cite source URLs and observation dates in
  `docs/BEHAVIOR_SPEC.md`.
- [x] Neutral behavior specification log exists in `docs/BEHAVIOR_SPEC.md`;
  independent reviewer sign-off remains required.
- [x] Automated implementation scan is available as `bun run audit:cleanroom`
  and runs in CI; it does not replace independent similarity review.
- [x] Every engineering parity category has automated unit, integration, E2E,
  formal-storage, or CI smoke evidence mapped in `docs/FEATURE_PARITY.md`.
- [ ] Legal review is complete for the intended markets and distribution.

## AGPL boundary

If a reference is AGPL-3.0, copying, modifying, or translating its covered code
must be treated as an AGPL path, including the network-source obligations that
apply to modified versions. Independently authored code may use a separate
license only when it is not a covered or derivative work. Changing TypeScript
to Go is not, by itself, a clean-room implementation.

Clean-room separation also does not remove trademark, trade-dress, patent, or
third-party asset risk. Use a distinct name and visual identity and obtain legal
review before commercial release. This policy is engineering guidance, not
legal advice.

The current public license record for the reference repository is captured in
`docs/BEHAVIOR_SPEC.md`; it must be rechecked before each external release.
