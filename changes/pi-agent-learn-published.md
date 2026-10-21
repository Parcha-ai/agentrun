---
packages: repo
kind: feature
---
`@parcha/pi-agent-learn` is published from this release, under the `beta` tag, with the other packages: its manifest no longer says `"private": true`. It depends on `@parcha/agentrun-dsl`, `@parcha/agentrun-pi` and `@parcha/pi-git-remote` at this release's exact version, and on pi-durable and chord 1.1 to 1.3.x as peers; it needs git 2.40 or later. Its README's "Quickstart (no key, no network)" runs from the packed tarballs in an empty directory with an empty environment in the `stranger` CI job (`scripts/stranger/pi-agent-learn.json`), and fails when its output differs from the README's by a byte. Its README and `packages/pi-agent-learn/CHANGELOG.md` have the details.
