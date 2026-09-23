# Changelog

## 0.1.0-beta.2, 2026-09-23

- `WorkflowDeps.hostPolicy`: application policy around generative nodes and completed steps, handed in by the host and unreachable from workflow documents. `systemBlocks` appends host text to a node's prompt; `submissionSchema` widens the adapter's transport schema with host-owned channels; `decodeSubmission` splits an accepted submission into the domain value and host state; `afterNode` enriches a completed step's state before commit and checkpoint. The domain value is always validated against the unchanged stage schema and is what a `verify` clause reviews; host state lives under the reserved `$host` state key (checkpointed and restored with the state, isolated per map item, branch and child, merged by delta across parallel branches), is excluded from a path-less output projection, and is returned as `result.host`. Validation rejects an `as` that names a `$`-prefixed key; a code node or `afterNode` patch writing `$host` fails with `reserved_state_key`. Events `host.decoded` and `host.patched` name the keys written. Absent, the engine behaves exactly as before.
- Exported for host facades: `childSteps`, `declaredWrites`, `terminalArtifactType`, `artifactNodeIsProse`, `schemaProblems`, `buildReferenceContext`, `normalizeStringNullsForSchema`, `parseCsvRows`, `compileTransform`, `compileTransformSyntax`.
- CI also runs on Node 24.21.0.

## 0.1.0-beta.1, 2026-09-23

Initial beta of `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, and `@parcha/agentrun-pi`.

- Define workflows in JSON or TypeScript with supported Standard JSON Schema and Zod contracts. Input and output types are inferred; intermediate state paths are validated at runtime.
- Compose tools, code, agent steps and typed decisions with branches, bounded loops, parallel work and isolated child workflows.
- Inspect workflow structure without executing code. Run scripted examples and evaluate a selected step with independent expectations.
- Use the optional Jev adapter for typed decisions or the Pi extension to author and run workflows with the active Pi model.
- Run the support quickstart without credentials, then connect the same workflow to your own tools, Jev and agent runtime.

Live Pi demos keep status and cancellation commands responsive. Support example failures preserve the original error and eventual tool outcome for host reconciliation while keeping JSON reports redacted. Dry-run accepts valid empty-only output schemas.

Code and documentation use Apache-2.0. All three packages are available on npm under the `beta` tag. Pi workflows are session-local; durable storage and external delivery belong to the host. See [compatibility](docs/compatibility.md) and [execution limits](docs/guide.md#limits).
