# Connect an existing eve agent and prove learning reuse

This fictional release reporter is a normal eve 1.0.0 application before AgentRun is connected. It has its own model route, standing instructions and read-only `release_status` tool. The optional extension adds learning without moving execution to AgentRun.

Use the client, extension and server from the same reviewed checkout. `@parcha/agentrun-eve` is a private development package; these instructions do not claim it has been published to npm.

## Run the original agent first

Build the checkout and the extension as described in the [cookbook](../../docs/tutorials/eve-learning.md), then install this independent example:

```sh
npm ci --prefix examples/eve-learning --ignore-scripts
```

Set a capped `OPENROUTER_API_KEY` in this application's environment. `EVE_MODEL` optionally selects a tool-capable model; the default is `anthropic/claude-haiku-4.5`. This credential stays with eve. Do not put it in chat, source control or an AgentRun prompt.

```sh
npm run dev --prefix examples/eve-learning
```

In another terminal, set `EVE_BASE_URL` to the local eve server address, then invoke its original agent:

```sh
npm run invoke --prefix examples/eve-learning -- --live
```

The command makes a real model call. It requires the native tool to complete and prints only the answer, session/turn ids and fictional release-tool facts. It does not retry a failed or uncertain task. Keep that session id as the baseline.

## Add the extension

Keep the same original agent files and tool. Set these variables in eve's environment:

- `AGENTRUN_BASE_URL`: the matching AgentRun API URL ending in `/v2`.
- `AGENTRUN_API_KEY`: an AgentRun API key, separate from the model credential.
- `AGENTRUN_AGENT_ID`: a stable id for this agent, such as `eve-demo-release`.

The AgentRun server needs its runner enabled and a configured reflection/grading model. Configure those model keys in its Settings; self-improvement makes additional model calls there.

```sh
npm run connect --prefix examples/eve-learning
```

This creates **only** `agent/extensions/agentrun.ts`, copying the mount under `connection/`. It refuses to overwrite an existing mount. The generated mount is ignored by Git so the checked-in example always starts as the original, unconnected agent. Rebuild/restart eve after adding it. Keep the generated mount stable afterward: renaming it changes eve's extension state namespace.

Invoke the original task again. The extension registers the existing agent in AgentRun and records the task with runtime **Vercel eve**. Self-improvement is initially Off. AgentRun does not start an extra eve task or replace the original tool.

## Enable self-improvement and test the next run

Open the connected agent in AgentRun and enable self-improvement on its Learning tab. Then run a fresh eve task that teaches a harmless reporting preference:

```sh
npm run invoke --prefix examples/eve-learning -- --live 'Read release status for demo-api and report its service, version, test result and readiness. For this and future release reports, begin the final answer with the exact prefix "Launch note:" and use one concise sentence. Remember this preference.'
```

Wait for AgentRun's independent checker to accept the resulting note or skill. Task completion alone does not mean learning has finished. If it is pending review or rejected, inspect that decision rather than approving it merely to make the demo pass.

Next, ask about a different fixture service in a fresh session **without repeating the preference**:

```sh
npm run invoke --prefix examples/eve-learning -- --live 'Read release status for demo-worker and report its service, version, test result and readiness.'
```

The proof requires an accepted run-generated lesson, the accepted revision recorded on this new run, a completed original `release_status` call for `demo-worker`, and an answer beginning `Launch note:` with the new version `3.1.2`.

Finally turn self-improvement Off and run that same `demo-worker` request in another fresh session. Its recorded learning revision must be absent, its original tool must still work, and the special prefix must not appear independently. A control that independently chooses the same wording is inconclusive, not a passing comparison.

Each invocation creates a fresh eve session; this avoids confusing conversation history with learning. The example's agent and recorded runs remain available in the console for inspection. This is an integration smoke test, not a general learning-quality benchmark.

### Run the connected proof automatically

After the original baseline and extension setup, use a fresh demonstration agent id with learning Off and no accepted lessons. The following command performs the connected Off task, enables notes through the same version-checked API used by the console, teaches the preference, waits up to three minutes for independent acceptance, tests fresh-session reuse with changed tool data, and runs the same agent with learning Off. It leaves that agent Off for inspection; enable it again in the console when finished.

```sh
npm run validate --prefix examples/eve-learning -- --live --output /tmp/eve-learning-proof.json
```

The validator reads the same `AGENTRUN_BASE_URL`, `AGENTRUN_API_KEY`, `AGENTRUN_AGENT_ID`, `EVE_BASE_URL` and optional `EVE_BEARER_TOKEN` from its environment. It makes four native model tasks plus server reflection calls. The output path must be new. It checkpoints session ids immediately and saves answers, tool observations, run ids, setting changes and accepted revisions without credentials or receipt tokens. It never retries a paid task, seeds a lesson or force-approves one. If checking fails, stop and inspect the saved stage and existing session instead of blindly rerunning.

For deployed eve applications, retain the original channel authentication and pass `EVE_BEARER_TOKEN` to the invocation script if that route requires a bearer credential. Never expose an unauthenticated local development server publicly.
