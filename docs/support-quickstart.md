# Connect the support workflow to Jev and your agent

Start with the [repository quickstart](../README.md#quickstart). The same [workflow document](../examples/support-answer.mjs) runs with scripted adapters or with live Jev and your configured host.

## 1. Check the scripted baseline

```sh
npm run demo:support
npm run test:support
```

The four fixtures cover reuse, investigation, and escalation. They use the real interpreter but fixed responses. They make no live model calls and do not measure decision quality.

The workflow searches once, checks the answer, and allows at most one agent investigation. Both checks require `yes` with confidence of at least `0.8`. A failed second check escalates for review. The interpreter validates the output shape and returns the answer to the caller; it does not send a reply.

## 2. Configure Jev and your host

Check whether `TYPESAFE_API_KEY` is already available to the server process without printing its value. If it is missing, create a key in the [TypeSafe dashboard](https://console.typesafe.ai/keys) using the [Jev setup guide](https://docs.typesafe.ai/introduction/quickstart). Store it using your host's existing secret configuration. A Claude Code, Codex, or Pi login does not authenticate Jev.

A saved `.env` file is not loaded automatically. Use your project's environment loader, Node's `--env-file`, or the host's secret bindings. Organizations with an approved gateway can set `TYPESAFE_BASE_URL`; it ends before `/v1/systemone`. See [Jev configuration](../packages/jev/README.md#configuration).

Copy the trusted server-side adapter template:

```sh
cp examples/support-answer-config.example.mjs support.config.mjs
```

Replace both stubs:

| Adapter | Required behavior |
| --- | --- |
| `runEffect(params)` | Dispatch `params.node.tool === 'help.search'` using `params.input.request`. Return `{ text, sources }`. When search finds nothing, return `{ text: "", sources: [] }`. |
| `runNode(params)` | Forward the full request to your existing agent runtime: `system`, `user`, `schema`, `tools`, `signal`, and `review` when present. Return the parsed `{ text, sources }` output. |

An empty answer or missing source references sends the request through the same single investigation and recheck. The final `Answer` still requires nonempty text and at least one source reference.

Register the read-only `support.read` tool in your host and scope access to the authenticated user. Keep model selection, permissions, turn limits, and budgets in that host. Honor cancellation and deadlines. The config module is trusted executable code; do not load user-supplied modules.

The live runner constructs `createJevRunner()` itself. It does not accept a replacement judge or fake transport in the config. Its lower-level execution helper accepts injected adapters for tests, which are labeled separately. Jev options in the config are limited to `apiKey`, `baseURL`, `model`, `timeoutMs`, and `maxAttempts`.

## 3. Run and inspect the calls

With credentials loaded and the adapters implemented:

```sh
npm run demo:support -- payment --config ./support.config.mjs
```

Or supply your own request:

```json
{ "request": "My payment failed. Can you investigate?" }
```

Save that as `request.json`, then run:

```sh
npm run demo:support -- --config ./support.config.mjs --input ./request.json
```

The report identifies `live Jev + configured host adapters`, the workflow digest, adapter calls, decision probabilities, and the final status. Request text, answer text, source references, and raw provider errors are omitted. Model and usage fields remain `null` when the service does not report them. Host adapters own their own logging.

Expected call order:

- Answer accepted immediately: `tool → judge`.
- Investigation required: `tool → judge → agent → judge`.
- Still insufficient or uncertain: escalate after that second check.

Real decisions may differ from the scripted fixtures. A typed `yes` and a source reference are not proof of factual correctness. Evaluate the question and threshold against independently labeled cases from your task before relying on them.

| Exit code | Meaning |
| --- | --- |
| `0` | Complete, or all scripted outcomes matched |
| `2` | A single request escalated |
| `1` | Setup, execution, cancellation, or timeout failed |

The default whole-run deadline is 60 seconds (`timeoutMs` in the config). Ctrl-C and SIGTERM cancel the run. Cancellation cannot undo an already admitted external call; host adapters must cooperate. Missing credentials stop the workflow before tools or agents run. Provider failures do not fall back to scripted responses.

To let your agent use the workflow, register a host tool that calls `runLiveSupport(input, config, { signal })`. Its return value contains both `result` (the validated output or escalation) and `report` (the redacted trace). Handle escalation explicitly and keep delivery in your application. See [host integration](host-integration.md).
