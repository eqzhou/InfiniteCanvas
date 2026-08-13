# Third-Party Notices

This file is a starting inventory for release review. The repeatable audit also
writes `docs/SBOM.spdx.json`; verify exact versions and complete license texts
from the lockfile and package registries before distribution.

## Web dependencies

| Package | Version range | License source |
|---|---:|---|
| React / React DOM | 19.2.7 | npm package metadata; MIT |
| React Router DOM | 7.18.1 | npm package metadata; MIT |
| Zustand | 5.0.14 | npm package metadata; MIT |
| lucide-react | 0.525.x | npm package metadata; ISC |
| nanoid | 5.1.16 | npm package metadata; MIT |
| clsx | 2.1.x | npm package metadata; MIT |
| html-to-image | 1.11.13 | npm package metadata; MIT |
| react-markdown | 10.1.0 | npm package metadata; MIT |
| remark-gfm | 4.0.1 | npm package metadata; MIT |
| Three.js / types | 0.185.1 | npm package metadata; MIT |
| Vite / TypeScript / Playwright | dev dependencies | verify exact package metadata before release |

## Go dependencies

| Module | Version | License source |
|---|---:|---|
| github.com/go-chi/chi/v5 | 5.3.1 | upstream module metadata; MIT |
| github.com/coder/websocket | 1.8.15 | upstream module metadata; ISC |
| github.com/jackc/pgx/v5 | 5.10.0 | upstream module metadata; MIT |
| github.com/redis/go-redis/v9 | 9.21.0 | upstream module metadata; BSD-2-Clause |

Platform binary packages with no bundled text notice are tracked by
`docs/LICENSE_REVIEW.json`: `@esbuild/darwin-arm64` (MIT,
https://github.com/evanw/esbuild) and `@rollup/rollup-darwin-arm64` (MIT,
https://github.com/rollup/rollup).
Core MIT notice texts are included under `third_party/licenses/`; verify the
complete upstream Rollup notice, including bundled dependency notices, before
shipping a build that includes the native binding.

## Container media package

| Package | Version | Package source and declared license |
|---|---:|---|
| FFmpeg | 8.0.1-r1 | Alpine Linux v3.23 `community` signed package metadata; `GPL-2.0-or-later AND LGPL-2.1-or-later` |
| Poppler utilities | 25.12.0-r0 | Alpine Linux v3.23 `main` signed package metadata; `GPL-2.0-or-later` |
| Bubblewrap | 0.11.0-r2 | Alpine Linux v3.23 `main` signed package metadata; `LGPL-2.0-or-later` |

The digest-pinned Alpine 3.23 runtime installs this exact repository package,
which provides `/usr/bin/ffmpeg`, `/usr/bin/ffprobe`, `/usr/bin/pdftotext`,
and `/usr/bin/bwrap`. No standalone binary is downloaded. This inventory
records package metadata; it does not
determine which license options apply to a particular FFmpeg build or complete
source-offer, notice, codec/patent, or distribution obligations. Preserve the
APK/base-image package records and complete the container redistribution review
before shipping an image.

The Go standard library is distributed under the Go license. Container base
images, Nginx, Bun, and Playwright browser binaries require separate release
inventory and attribution review.

## Release gate

- [x] Generate a preliminary SPDX SBOM from the installed frozen web dependency tree
- [x] Scan installed npm and Go module versions against OSV in CI
- [ ] Include complete license texts and notices for shipped dependencies
- [ ] Complete container/base-image, FFmpeg, Poppler, and Bubblewrap build/redistribution license review
- [ ] Review fonts, icons, screenshots, and generated media
