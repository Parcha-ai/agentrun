---
packages: repo
kind: feature
---
`@parcha/pi-git-remote` is published from this release, under the `beta` tag, with the other packages: its manifest no longer says `"private": true`. It depends on none of the other packages and needs git 2.40 or later; `@earendil-works/pi-coding-agent` stays an optional peer at `*`, for the `./coding-agent` extension only. Its README's "Quickstart (no key, no network)" runs from the packed tarball in an empty directory with an empty environment in the `stranger` CI job (`scripts/stranger/pi-git-remote.json`), and fails when its output differs from the README's by a byte. Its README and `packages/pi-git-remote/CHANGELOG.md` have the details.
