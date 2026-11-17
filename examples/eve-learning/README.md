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

The proof requires an accepted run-generated lesson, the accepted revision recorded on this new run, a completed original `release_status` call for `demo-worker`, and an answer beginning `Launch note:` with the new version `3.1.2`. Plain text and Markdown bold (`**Launch note:**`) render the same visible prefix and both count; the baseline and Off control must lack either form.

Finally turn self-improvement Off and run that same `demo-worker` request in another fresh session. Its recorded learning revision must be absent, its original tool must still work, and the special prefix must not appear independently. A control that independently chooses the same wording is inconclusive, not a passing comparison.

Each invocation creates a fresh eve session; this avoids confusing conversation history with learning. The example's agent and recorded runs remain available in the console for inspection. This is an integration smoke test, not a general learning-quality benchmark.

### Run the connected proof automatically

After the original baseline and extension setup, use a fresh demonstration agent id with learning Off and no accepted lessons. The following command performs the connected Off task, enables notes through the same version-checked API used by the console, teaches the preference, waits up to three minutes for independent acceptance, tests fresh-session reuse with changed tool data, and runs the same agent with learning Off. It leaves that agent Off for inspection; enable it again in the console when finished.

```sh
npm run validate --prefix examples/eve-learning -- --live --output /tmp/eve-learning-proof.json
```

The validator reads the same `AGENTRUN_BASE_URL`, `AGENTRUN_API_KEY`, `AGENTRUN_AGENT_ID`, `EVE_BASE_URL` and optional `EVE_BEARER_TOKEN` from its environment. It makes four native model tasks plus server reflection calls. The output path must be new. It checkpoints session ids immediately and saves answers, tool observations, run ids, setting changes and accepted revisions without credentials or receipt tokens. It never retries a paid task, seeds a lesson or force-approves one. If checking fails, stop and inspect the saved stage and existing session instead of blindly rerunning.

To continue an interrupted validation without repeating completed model tasks:

```sh
npm run validate --prefix examples/eve-learning -- --live --resume /tmp/eve-learning-proof.json
```

Resume reads every saved native session's finite history and re-fetches its AgentRun run. It verifies one fresh turn, the exact original input, completed native tools and the recorded learning revision; saved answers alone are not trusted. Existing sessions are never resent or replaced. An unfinished session or uncertain submission without a confirmed session id stops the proof. Only stages that were never submitted may start a new task. The saved file is updated in place, preserving the earlier failure and resumption time; add `--output NEW_PATH` to save a separate continuation. A setting already at its intended value is left unchanged.

For deployed eve applications, retain the original channel authentication and pass `EVE_BEARER_TOKEN` to the invocation script if that route requires a bearer credential. Production `eve start` rejects session requests until route authentication is configured, even though health checks are public; follow eve's [route-authentication guide](https://github.com/vercel/eve/blob/main/docs/guides/auth-and-route-protection.md) for an application that has no production route policy yet. Never expose an unauthenticated local development server publicly.

## Learn and execute a workflow with the original tools

The optional workflow proof adds a read-only `format_release_brief` callback to the fictional application. Both native eve tools and learned workflows use the same exported functions in `agent/lib/release-tools.ts`. The formatter accepts only the complete, unchanged status object actually read in that task, including its fresh UUID. This distinguishes executing the original callbacks from repeating an old answer.

When the workflow fixture is enabled, its original standing policy explicitly permits that read-only formatter while retaining the restriction to observed release facts and forbidding external actions. Eve and AgentRun receive the same policy. Adding a tool binding alone does not grant permission to use it against the original job's instructions.

Service names are string inputs; the two fictional records are data, not an enum to bake into the reusable workflow. The original callback still rejects unknown services, and the formatter still rejects invented or modified observations. This lets the learned procedure apply to changed service data without weakening the tool's runtime checks.

Use a **separate clean copy of this example** and a new `AGENTRUN_AGENT_ID` so its skills and workflow have a verifiable origin. If another eve development server is running, give the copy its own working directory, `.eve` state, output directory and port; two eve servers must not build from the same directory. Install that copy against the same built AgentRun checkout. Do not copy an existing generated `agent/extensions/agentrun.ts` mount or prior `.eve` state.

Set the same model and AgentRun connection variables as above, plus:

```sh
export AGENTRUN_AGENT_ID=eve-workflow-release
export EVE_WORKFLOW_AUDIT_PATH=/tmp/eve-workflow-callbacks.jsonl
export EVE_BASE_URL=http://127.0.0.1:7443
```

Choose a new, absolute audit path accessible to both eve and the validator. The example creates it with mode `0600`. It is a bounded local journal of **only fictional fixture callback data**; it contains no model prompts, API keys or workflow capabilities. The formatter uses it to verify dataflow across eve's separate worker processes. This is test instrumentation, not a requirement to journal real customers' tool payloads.

From the separate example directory, mount workflow support and start eve:

```sh
node connect.mjs --workflows
npm run dev -- --port 7443
```

The mount supplies the existing workflow interpreter, the exact two callback references, their schemas, explicit native tool names and a live allow policy. The extension's package metadata preserves the interpreter's schema assets; the application's `agent.ts` needs no build override. It does not automatically expose any other eve tools. Keep the generated mount named `agentrun.ts`; other names require setting the extension's `workflows.toolName` to its actual namespaced eve tool name.

In another terminal with the same connection variables and audit path:

```sh
npm run validate:workflows -- --live --output /tmp/eve-workflow-proof.json
```

Use a new agent id that does not already exist. The validator creates that dedicated agent with learning Off and refuses to overwrite an existing agent or settings changed outside the proof.

This performs at most eight native model tasks, plus the server's independent learning calls:

1. Run the original two-tool procedure with learning Off.
2. Enable **notes and skills**, teach that reusable procedure, and wait for an independently accepted skill. SDK turns without owner feedback use this mode for look-back learning.
3. Enable **full workflow learning** with `learning: { compile_after: 5 }` for this new demonstration agent and run up to four ordinary practice tasks. The server must produce an independently accepted executable workflow at that configured cadence (the default is 20 completed runs). The checker and its acceptance thresholds are unchanged.
4. Ask about `demo-worker` in a fresh session, without repeating the taught procedure. Require the accepted revision, a completed `agentrun__learned_workflow` invocation, both original callback bindings as its children, a fresh observation UUID and the changed version `3.1.2`.
5. Turn the **same agent** Off and submit the same `demo-worker` task in another fresh session. Require direct native tools, no workflow invocation and no learning revision.

The validator changes settings through the version-checked public API and leaves learning Off. A correct answer obtained through direct tools does **not** pass the workflow-reuse stage. A rejected candidate, pending owner review, missing skill or missing workflow stops the proof; it never seeds a workflow, force-approves one or raises the paid-task limit to get a pass.

It checkpoints each session id as soon as eve returns it. To resume after inspecting an interruption:

```sh
npm run validate:workflows -- --live --resume /tmp/eve-workflow-proof.json
```

Resume re-reads actual native histories and AgentRun records; it never resubmits a recorded task. A submission without a confirmed session id is uncertain and stops. The proof contains native answers, fictional callback facts, accepted workflow documents and metadata for inspection; private workflow signatures and credentials are excluded.

The tool-only workflow needs no Jev key or extra workflow-model credential. Eve still needs its original model route, and the AgentRun server needs its reflection, compilation and independent-checker routes. This first eve bridge accepts explicitly read-only callbacks only, with no model nodes, judge nodes, shell/code execution or implicit permissions. See the [workflow extension details](../../docs/tutorials/eve-learning.md#execute-accepted-workflows-with-existing-tools).

Offline checks use scripted native/model receipts and a real local MCP bridge/interpreter, without model calls:

```sh
npm run test:workflows
npm run typecheck
```
