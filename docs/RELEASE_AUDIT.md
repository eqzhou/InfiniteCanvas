# Release Audit

Run this checklist before publishing a commercial or closed-source build.

Use `bun run audit:release` to fail closed while any unchecked item remains.
This is a release gate, not a legal opinion.

## Personal local readiness

- [x] Formal runtime binds to loopback and requires a local connection token.
- [x] PostgreSQL is authoritative, Redis is disposable, and provider keys are AES-GCM encrypted.
- [x] Production build, cross-browser E2E, formal-storage E2E, and container smoke pass.
- [x] Formal tests use isolated PostgreSQL/Redis/media stores and verify zero residue.
- [x] The fail-closed OSV audit reported zero active records across 223 installed npm/Go package versions on 2026-07-19.

The personal local single-user target is engineering-ready. The unchecked items
below intentionally keep commercial/closed-source publication blocked; they do
not indicate missing local canvas functionality.

## Engineering

- [x] Chromium, WebKit, and Firefox Playwright projects are configured.
- [x] Full cross-browser and production-build Playwright suites pass at the dated baseline recorded in the `FEATURE_PARITY.md` verification summary.
- [x] Production desktop and mobile runs use isolated Go storage and record intentional environment/device skips separately.
- [x] Touch and mobile flows are covered by mobile Chromium; Firefox desktop touch injection is skipped by design.
- [x] Bun unit tests, TypeScript build, Go race tests, and `go vet` pass.
- [x] CI performs a fail-closed OSV batch audit for installed npm and Go module versions.
- [x] Container build and PostgreSQL/Redis smoke pass in the latest required `main` CI workflow.
- [x] Container smoke verifies the unprivileged runtime, exact Alpine FFmpeg package,
  FFmpeg/FFprobe executable probes, configured paths, and Film MP4 capability.
- [x] Local/PM2 media diagnosis degrades only MP4 and is covered by script tests;
  Provider credentials are not required by CI.
- [x] Formal local PostgreSQL/Redis/media E2E passes and leaves zero temporary databases and zero Redis DB 14 keys.
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
- [ ] Complete FFmpeg/codec build-option, source-offer, notice, patent and target-
  market redistribution review for the pinned Alpine package. Recording package
  metadata in `THIRD_PARTY_NOTICES.md` is not legal sign-off.
- [ ] Include complete third-party license texts and notices.
- [ ] Review fonts, icons, screenshots, favicon, generated media, and customer
  supplied assets.
- [ ] Review brand name, logo, trade dress, patents, and domain names.
- [ ] Obtain qualified counsel's written release opinion for the target markets.

The repository's MIT license covers only independently authored code that the
contributors are entitled to license. It does not certify absence of third-
party or derivative-work claims.
