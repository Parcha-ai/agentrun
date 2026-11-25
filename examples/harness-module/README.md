# A harness module

This module adds a harness to an AgentRun server without changing the server. It adds Goose, an ACP agent, under an id
of its own, `goose-module`, run from a Goose binary its owner names. [HARNESS.md](../../HARNESS.md) explains each part.

- `index.mjs` is the module: Goose's facts under the new id, `missing` (the binary is named and is the pinned Goose),
  the recipe for a run, the model proxy, and a pin check before each Goose process starts.
- `test/subject.mjs` is the conformance suite's subject: serve's ACP adapter, which `kit.acpEntry` builds the harness
  on, driven by the kernel's adapter loop on the fake ACP agent.
- `test/conformance.test.mjs` runs the suite.

## Test it

From the repository root, after `pnpm install --frozen-lockfile` and `pnpm run build`:

```sh
npm run test:harness-module-example
```

It typechecks the module and runs the suite with no binary, no model and no key. It passes as
[HARNESS.md](../../HARNESS.md#what-passing-looks-like) shows. The skipped cases are the ones an ACP agent rules out by
its facts, and each says why.

## Run it

On the server's machine, with the pinned Goose installed (`agentrun harness install goose` puts it at
`<data>/harnesses/goose/goose`):

```sh
npm install --prefix <data>/harnesses ./examples/harness-module
EXAMPLE_GOOSE_BINARY=<data>/harnesses/goose/goose AGENTRUN_TELEMETRY=0 \
  agentrun-serve --data <data> --harness-module agentrun-harness-module-example
```

`GET /v2/capabilities` then lists `goose-module` after the built-in harnesses. It runs Anthropic's models, on an
Anthropic or OpenRouter key. Until `EXAMPLE_GOOSE_BINARY` names the pinned Goose, its offer says so and names no key.
