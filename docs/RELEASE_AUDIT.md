# Release Audit

Run this checklist before publishing a commercial or closed-source build.

Use `bun run audit:release` to fail closed while any unchecked item remains.
This is a release gate, not a legal opinion.

## Engineering

- [x] Chromium, WebKit, and Firefox Playwright projects are configured.
- [x] Full Playwright suite passes locally (65 passed, 3 environment-specific skips); Chromium/WebKit/Firefox/mobile Chromium projects are configured.
- [x] Touch and mobile flows are covered by mobile Chromium; Firefox desktop touch injection is skipped by design.
- [x] Bun unit tests, TypeScript build, Go race tests, and `go vet` pass.
- [ ] Container build and smoke test pass on a host with Docker.
- [ ] Independent security and similarity review is signed off.

## Copyright and licensing

- [ ] Verify the reference repository's current license and preserve evidence of
  the clean-room specification process.
- [x] Record the current public AGPL-3.0 metadata and verification date in
  `docs/BEHAVIOR_SPEC.md`.
- [x] Maintain a neutral behavior specification log in `docs/BEHAVIOR_SPEC.md`.
- [ ] Complete per-file provenance and contributor rights review.
- [x] Generate a preliminary SPDX SBOM with `bun run audit:licenses`.
- [x] Generate `docs/LICENSE_REVIEW.json` with per-package license-file status.
- [x] CI runs the license audit and uploads the generated SBOM artifact on every
  pull request and push.
- [x] CI runs `bun run audit:cleanroom` to catch reference-source identifiers in
  implementation and shipped assets.
- [x] Locate upstream MIT license sources for the two platform binary packages
  without in-package notice files (`@esbuild/darwin-arm64` and
  `@rollup/rollup-darwin-arm64`); see `docs/LICENSE_REVIEW.json`.
- [x] Include core MIT notice texts in the repository's
  `third_party/licenses/` notice bundle.
- [ ] Verify the complete upstream Rollup notice, including bundled dependency
  notices, before redistribution; the core MIT text is present locally.
- [ ] Review the generated SBOM against frozen lockfiles, transitive source
  licenses, browser binaries, and container/base-image licenses.
- [ ] Include complete third-party license texts and notices.
- [ ] Review fonts, icons, screenshots, favicon, generated media, and customer
  supplied assets.
- [ ] Review brand name, logo, trade dress, patents, and domain names.
- [ ] Obtain qualified counsel's written release opinion for the target markets.

The repository's MIT license covers only independently authored code that the
contributors are entitled to license. It does not certify absence of third-
party or derivative-work claims.
