# Changelog

## Unreleased

- `validateAnswers` accepts a choice or score distribution when it could be the two-place rounding of a distribution that sums to 1. The test is that each true probability lies within 0.005 of the reported one and inside [0, 1]. Previously the sum had to be within 1e-5 of 1. System One rounds each probability to two places, so about 1% of real eight-option choices summed to 0.99. The validator refused them as `probability_mass`, and the Jev adapter then failed the whole request. The allowed drift now grows with the number of options: eight equal options report 0.13 each and sum to 1.04. Probabilities are still passed through unchanged, never rescaled. A distribution that no rounding explains is still refused. `score_consistency` is unchanged. ([#25](https://github.com/Parcha-ai/agentrun/issues/25))
- Release tooling: the final registry check now waits for npm to list every release version in both the full and the abbreviated packument before its one clean install. It uses the same 60 x 5 second budget as the per-package check. The beta.4 publish succeeded, but this step ran `npm install` one second after the Pi check passed and got `ETARGET`, so the run was marked failed.

## 0.1.0-beta.4, 2026-09-24

- Every node accepts an optional `metadata` object for host markers. Validation refuses a non-object value and names the node. Otherwise the engine never reads it. Desugaring, dry runs, runs and the author's candidate loop carry it verbatim, and it never reaches state, events, prompts, judge requests or effect idempotency keys. `workflowSha256` covers it because it hashes the whole document. `HOST_NODE_FIELDS` and the `NodeMetadata` type are exported, and the editor schema admits `metadata` on every node kind.
- The author contract states once that `metadata` is host-owned and that authors set only the keys the host names. `AuthorHostAddendum.metadataKeys` names those keys. The host enforces them in its acceptance checks.
- `spec/lean`: a conformance case with metadata on several node kinds. The model ignores the field by design.

## 0.1.0-beta.3, 2026-09-23

- Pi can inspect workflow steps, save named definition revisions, and load them in another session. Saved definitions exclude run input and execution permission. Save and list show commands for loading the exact revision. Code runs require `/agentrun run --trusted` each time.
- The support example registers its agent tool as `support_read`, a name accepted by providers that prohibit dots in tool names.

- One author. `@parcha/agentrun-dsl` now owns the author contract, the author skill and the candidate loop. `authorContract({ host? })` renders the language every author receives (`renderAuthorContract` also returns the sha256 of that exact text, which `authorWorkflow` records with every candidate as `contractSha256`), then an optional `AuthorHostAddendum` (`name`, `initialState`, `outputTypes`, `nodeKinds`, `rules`) that names a host's vocabulary without changing the language. `authorWorkflow` moved from `@parcha/agentrun-pi` and now takes the host's `runNode` adapter instead of Pi runner options; it enforces a declared addendum's node kinds and output types and validates against its initial state. `candidatePolicyErrors` is the shared author policy. `authorWorkflow` returns the candidate its review accepted; `applyHostOutputTypes` gives the interpreter view of a host's prose output types. The skill ships in the dsl package under `skills/author`, with the contract generated as `references/language.md`; `authorSkillDirectory`, `loadAuthorReference` and `loadAuthorSkillBundle` expose it.
- The Pi package registers the dsl skill rendered with its own host addendum (`PI_HOST_ADDENDUM`, exported), built into `dist/skills/author`, so a session reads the Pi rules without calling `describe`. `describe` returns `authoring.language` and `authoring.host` beside the guides.
- One vocabulary. `WORKFLOW_NODE_KINDS`, `NODE_FIELDS`, `WORKFLOW_PREDICATES` and the other vocabulary constants are exported, and the validator and the author contract both read them, so the contract names exactly what the validator admits.
- Validation now refuses an `escalate.when` path or key that no input or earlier node produces, a `loop.until` path that neither the state before the loop nor its body produces, and a parallel branch that reads a key only a sibling branch writes. None of them could hold at runtime.
- `spec/lean`: a contributor model for checking control-flow rules and their assumptions. Its proofs apply to the abstract model; shared conformance cases compare selected behaviors with the TypeScript interpreter. Executable regressions cover runtime input checks, parallel conflicts and recovery adapter obligations. The model does not prove the TypeScript runtime correct or predict model output.
- Validation rejects a child workflow input that assigns the reserved `$host` key before any parent or child step executes.

- One path resolver for every state reader. Predicates (`escalate.when`, `loop.until`, `sift.keep`) now index arrays the way `requires`, interpolation, `itemsPath` and `output.path` already did: `scores.0` reads `9` from `{scores: [9]}` everywhere, so a gate on an array index fires. A record is read by key, an array by a non-negative canonical integer index, and any other value (a string, a number, a missing value) resolves to `undefined`; an array exposes indexes, not properties. `getPath` is exported.
- The parallel `$host` merge refuses a mixed-shape write in either branch order. An array append that meets a scalar a sibling wrote to the same new key is a `parallel_write_conflict`, as the reverse order already was; before, the append silently replaced the scalar. Appends from several branches still join in branch order, and equal writes remain one write.

### Breaking changes

This is a prerelease, so there are no forwarding exports. Every removed `@parcha/agentrun-pi` export and its replacement:

| Removed from `@parcha/agentrun-pi` | Replacement |
| --- | --- |
| `authorWorkflow(options)` with `options.pi: PiRunnerOptions` | `authorWorkflow` from `@parcha/agentrun-dsl`, with `runNode: createPiRunner({ ...options, tools: [], maxSubmissions })` in place of `pi` |
| type `AuthorWorkflowOptions` | `AuthorWorkflowOptions` from `@parcha/agentrun-dsl` (`runNode` replaces `pi`; adds `host` and `signal`) |
| type `AuthoredWorkflow` | `AuthoredWorkflow` from `@parcha/agentrun-dsl` (adds `contractSha256`) |
| `AUTHOR_CONTRACT` (string) | `authorContract({ host? })`, or `renderAuthorContract({ host? })` for `{ text, sha256 }`, from `@parcha/agentrun-dsl` |
| `loadPiAuthorSkillBundle()` | `loadAuthorSkillBundle()` from `@parcha/agentrun-dsl` |
| the package's `skills/author` directory | the neutral skill at `authorSkillDirectory()` in `@parcha/agentrun-dsl`; the Pi-rendered copy ships at `dist/skills/author` |

Validation is also stricter when the caller supplies an input contract (`input` or `inputKeys`). It refuses the three unreachable reads listed above, which a workflow validated without an input contract never triggers.

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
