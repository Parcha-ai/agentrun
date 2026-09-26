# Agent instructions

Guidance for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the authority where the two differ. To add AgentRun to another project, use [docs/agent-instructions.md](docs/agent-instructions.md) instead.

## What this is

AgentRun is a workflow language for agents a host already runs. A workflow is a JSON document (or TypeScript builder output) of typed nodes. The interpreter executes it and calls back into the host for every model call and side effect. The host keeps its tools, models, permissions, budgets and delivery. The DSL fixes the steps, state contracts, bounded control flow and escalation points, so a repeatable procedure can be inspected, rerun, tested with fixtures and offered to an agent as one tool.

## Layout

| Path | What |
| --- | --- |
| `packages/dsl` | `@parcha/agentrun-dsl`: types, `validateWorkflow`, `runWorkflow`, dry run, inspection, CLI (`agentrun`) |
| `packages/dsl/src/workflow.ts` | The interpreter: node execution, state paths, parallel merge, desugaring |
| `packages/dsl/skills/author/` | Packaged authoring skill. `references/language.md` is the full node reference; `references/jev-decisions.md` covers judgment design |
| `packages/dsl/schema/workflow.schema.json` | Generated editor schema |
| `packages/jev` | `@parcha/agentrun-jev`: `createJevRunner()`, the `runJudge` adapter for Jev |
| `packages/pi` | `@parcha/agentrun-pi`: the Pi extension (`/agentrun`) and Pi-backed `runNode` runner |
| `spec/lean` | Optional Lean model of validation and execution, plus a conformance corpus shared with TypeScript |
| `examples/` | Support, typed research and starter app, offline by default with scripted adapters |
| `docs/` | `guide.md` (primitives, limits), `authoring.md`, `host-integration.md`, `releasing.md` |
| `scripts/` | Node floor, schema and contract generation, source export, package and release verification |

The three packages share one version and are published in that order.

## Setup and checks

Use Node 22.19+ (`.nvmrc`; release verification uses 22.23.2) and npm.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check   # build, generated-file checks, typecheck, all tests
```

Tests import from `dist/`, so rebuild before running a single file with `node --test`. Tests use scripted adapters and need no credentials or network. Live examples are opt-in. After changing workflow types, run `node scripts/generate-schema.mjs` and `node scripts/generate-author-contract.mjs`. For packaging changes, run `npm run export:source` and `npm run verify:source`.

## The host boundary

The engine is policy-agnostic. It reaches the outside world only through three adapters:

- `runNode` runs generative nodes (`agent`, `decide`, `extract`, `report`, `artifact`) in the host's agent.
- `runJudge` answers typed questions (`judge`, `pick`, `sift`, `route`, `ask`, `verify`).
- `runEffect` performs `call` nodes (tool, executor, shell).

Provider configuration, SOP text, budgets and application policy stay in the host or in the workflow document that travels with the task, never in the interpreter. Node `metadata` belongs to the host; the engine never reads it.

## Jev

Jev (TypeSafe System One) returns typed answers with probabilities: a boolean's yes-probability, a choice with confidence, or a leveled score. It writes no prose and calls no tools. Use it for one focused semantic decision per property: select evidence, compare a claim to its source, choose a route. Code does exact work (lookups, arithmetic, joins); agents do open-ended research. Give Jev the original source text, not an agent's paraphrase. Thresholds live in the workflow (`gte`, `route.unsure`, or a code gate on `<as>$answers`), and uncertainty escalates or takes an explicit fallback. Live calls need `TYPESAFE_API_KEY`; tests never do.

## Lean

`spec/lean` is a contributor tool, not a runtime dependency. It proves properties of a model of the interpreter, and the cases in `spec/lean/conformance/*.json` check that the model and TypeScript agree on them. When validation, state paths, branch merges, loops or desugaring change:

1. Add a TypeScript regression test whose expected result was chosen independently of the implementation.
2. Update the Lean definitions or proofs if the model or its assumptions changed, and add a conformance case.
3. Run the Lean checks in [CONTRIBUTING.md](CONTRIBUTING.md#changing-workflow-behavior) (`lake build`, `lake exe conformance`, the validator sweep).

CI runs Lean separately from `npm run check`. Documentation-only changes don't need Lean.

## Rules

- For a behavior change, add a test that fails before the change and asserts what the caller depends on. Mock at adapter boundaries.
- Keep semantic judgment in the model and execution invariants in code. Structural checks (shape, schema, reachability, state paths) belong in the validator; meaning belongs in a typed question. A heuristic patched a second time for new phrasing should become a question.
- Change one falsifiable thing at a time. A passing unit test or a model verdict does not prove a host integration works.
- Make failures observable: keep evidence, provenance, limits and cancellation. Never rerun an uncertain effect blindly.
- Never edit a fixture, check or threshold just to make a changed implementation pass, and never let a candidate rewrite its own verifier.
- A generative node carries the whole rubric it applies: `sopSection` lists every SOP section the decision depends on, and merged nodes inherit the union. Don't paraphrase policy into `instructions`.
- Extend the existing node, adapter and lifecycle interfaces before adding a mechanism. Delete superseded machinery only after its replacement passes.
- Document breaking changes and failure behavior in [CHANGELOG.md](CHANGELOG.md).
- This repository is public. Keep machine paths, internal hostnames, credentials and customer data out of code, tests, commits and issues. `npm run export:source` rejects many of these.
- Never publish from a local machine. Releases go through the reviewed workflow in [docs/releasing.md](docs/releasing.md).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md), never in a public issue.
