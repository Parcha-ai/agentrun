# Agent instructions

Guidance for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the authority where the two differ. To add AgentRun to another project, use [docs/agent-instructions.md](docs/agent-instructions.md) instead.

## Layout

- `packages/dsl`: the interpreter, validator and CLI (`@parcha/agentrun-dsl`).
- `packages/jev`: the Jev adapter for System One decisions (`@parcha/agentrun-jev`).
- `packages/pi`: the Pi extension (`@parcha/agentrun-pi`).
- `examples/`, `docs/`, `spec/lean/` (optional Lean model), `scripts/` (build, schema, export and release checks).

The three packages share one version and are published in that order.

## Setup and checks

Use Node 22.19+ (`.nvmrc`; release verification uses 22.23.2) and npm.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check   # build, generated-file checks, typecheck, all tests
```

Tests import from `dist/`, so rebuild before running a single file with `node --test`. Tests use scripted adapters and need no credentials or network. Live examples are opt-in.

## Rules

- For a behavior change, add a test that fails before the change, with an expected result chosen independently of the implementation.
- Keep provider configuration and application policy outside the interpreter. Hosts integrate through `runNode`, `runJudge` and `runEffect`.
- After changing workflow types, run `node scripts/generate-schema.mjs`. When validation, state paths, branches, loops or desugaring change, follow the Lean steps in CONTRIBUTING.md.
- Never edit a fixture just to make a changed implementation pass.
- This repository is public. Keep machine paths, internal hostnames, credentials and customer data out of code, tests, commits and issues. `npm run export:source` rejects many of these.
- Never publish from a local machine. Releases go through the reviewed workflow in [docs/releasing.md](docs/releasing.md).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md), never in a public issue.
