---
packages: repo
kind: ci
---
Anyone with write access can cut a release: the release workflow checks what a person used to. Its `gate` job refuses a tag that is not newer than npm's `latest` for `@parcha/agentrun-serve` and the newest GitHub release (semver order, beta.9 < beta.10 < 0.1.0), or that is not the version the manifests at the tag say, and requires every check `main`'s ruleset requires (`verify` and `lean`, not `verify` alone) to have passed on the push run of exactly the tagged commit. After every publish job passes, a new `github-release` job publishes the release on the existing tag with the version's folded `CHANGELOG.md` section and the install lines as its notes, and a `slack` job posts it to the channel in the repository variable `SLACK_RELEASES_CHANNEL` with the star notifications' bot token; Slack never fails a release. Approval stays the `npm-release` environment's required reviewers.
- A release that stopped partway is finished by re-running its failed jobs: a new dispatch of a tag npm already has stops at the gate.
