---
packages: @parcha/agentrun-dsl, @parcha/agentrun-jev, repo
kind: docs
---
The `@parcha/agentrun-dsl` README and the guide's "Let Pi build and run a workflow" tell the story in five steps: the agent drafts a typed workflow, checks it, dry-runs it for free, runs it, and every node shows on its graph. Each step names the call or the `/agentrun` command that does it.
Install and `npx` lines use the `beta` dist-tag (`npx @parcha/agentrun-dsl@beta`, since npm has no unscoped `agentrun`), the starter's README names no version (it installs at the version its `package.json` pins), and the READMEs state one Pi range (1.0.4 to below 1.4, with the versions CI tests).
The `@parcha/agentrun-dsl` README says that a durable run's store keeps each effect's arguments as given, so secrets are redacted before they reach an effect.
The author skill and the guide say that a dry run gives a boolean whose schema leaves it open (no `const` or `enum`) the value `false`, so an `escalate` on such a boolean being `false` always fires there and the dry run reports `not_run`.
The Jev README, its types and its Box refusal no longer say that `jev-latest` is 1.13: a Box question needs `jev-1.14.0` (or later) or `jev-preview` by name, and the runner refuses it on `jev-latest` whatever version that alias points at.
