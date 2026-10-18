---
packages: @parcha/agentrun-dsl, repo
kind: docs
---
The `@parcha/agentrun-dsl` README and the guide's "Let Pi build and run a workflow" tell the release's story in five steps: the agent drafts a typed workflow, checks it, dry-runs it for free, runs it, and every node shows on its graph. Each step names the call or the `/agentrun` command that does it.
The READMEs name the release where they name a version, state one Pi range (1.0.4 to below 1.4, with the versions CI tests), and run the CLI as `npx @parcha/agentrun-dsl@RELEASE_VERSION`, since npm has no unscoped `agentrun`.
