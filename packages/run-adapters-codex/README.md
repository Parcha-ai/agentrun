# @parcha/agentrun-codex

Codex as an AgentRun harness: a DSL `agent` node runs on Codex through `@parcha/agentrun-adapters`, durable in AgentRun's
own store, with the host's tools as its only tools. It is held: not on npm yet.

```ts
import { createHarnessRunner } from "@parcha/agentrun-adapters";
import { codexAdapter } from "@parcha/agentrun-codex";

const runNode = createHarnessRunner(
  codexAdapter({
    model: "gpt-5.4-mini",
    provider: { origin: "https://api.openai.com", credential: () => process.env.OPENAI_API_KEY! },
    sessionsDir: "/var/lib/my-host/codex-sessions",
  }),
  { store, tools },
);
```

- **The host's tools only.** Codex's app-server runs with its built-in tools off: no shell, no file edits, no web, no
  images, no sub-agents. A classic model is offered exactly the host's tools (and the runner's `submit`); a code-mode
  model is offered code mode's `exec` and `wait`, whose runtime has no Node modules, no process and no network, and
  reaches the host's tools by their own names. `test/tool-off.test.mjs` runs the pinned binary against a scripted model
  that calls every built-in, and checks that nothing runs, writes or spawns.
- **The model behind a proxy.** Codex talks to a model proxy on the loopback interface with a key of its session's own;
  it never holds the provider key. The proxy forwards `POST /v1/responses` only, fixes the model, stores nothing at the
  provider, drops any tool that is not the session's, and asks the runner before every paid request, so the turn cap and
  the host's budget hold. Each response's usage comes back to the runner.
- **A private, empty machine.** A session runs in its own directories with an empty working directory. Codex's
  environment is an allowlist (`PATH`, `LANG`, `TZ`, its own homes and the proxy key); nothing else of the host's
  reaches it, and its process group ends with the session.
- **Durable.** A session's records are in the store the host lends (Codex's rollout mirrored line by line, every tool
  call an effect recorded before it runs). A session a process died inside resumes from its records: a `safe` tool runs
  again, a `never` tool's cut-off call is reported to the model as interrupted and never repeated.

The adapter is pinned to Codex 0.164.0 (`@openai/codex`, a dev dependency here): `check` refuses a session when the
binary is missing or is not that build. `CODEX_BIN` names another path to the same build.

Code this package copies from another project is listed in `vendor/durable-harness/UPSTREAM.json` and credited in
`NOTICE`.
