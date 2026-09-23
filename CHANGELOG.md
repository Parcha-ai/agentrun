# Changelog

## 0.1.0-beta.1, unreleased

Initial beta of `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, and `@parcha/agentrun-pi`.

- Define workflows in JSON or TypeScript with supported Standard JSON Schema and Zod contracts. Input and output types are inferred; intermediate state paths are validated at runtime.
- Compose tools, code, agent steps and typed decisions with branches, bounded loops, parallel work and isolated child workflows.
- Inspect workflow structure without executing code. Run scripted examples and evaluate a selected step with independent expectations.
- Use the optional Jev adapter for typed decisions or the Pi extension to author and run workflows with the active Pi model.
- Run the support quickstart without credentials, then connect the same workflow to your own tools, Jev and agent runtime.

Live Pi demos keep status and cancellation commands responsive. Support example failures preserve the original error and eventual tool outcome for host reconciliation while keeping JSON reports redacted. Dry-run accepts valid empty-only output schemas.

Code and documentation use Apache-2.0. Packages are unpublished. Pi workflows are session-local; durable storage and external delivery belong to the host. See [compatibility](docs/compatibility.md) and [execution limits](docs/guide.md#limits).
