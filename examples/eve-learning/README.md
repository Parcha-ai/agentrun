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

The AgentRun server needs its runner enabled and a configured compilation model. Configure those model keys in its Settings; self-improvement makes additional model calls there.

```sh
npm run connect --prefix examples/eve-learning
```

This creates **only** `agent/extensions/agentrun.ts`, copying the mount under `connection/`. It refuses to overwrite an existing mount. The generated mount is ignored by Git so the checked-in example always starts as the original, unconnected agent. Rebuild/restart eve after adding it. Keep the generated mount stable afterward: renaming it changes eve's extension state namespace.

Invoke the original task again. The extension registers the existing agent in AgentRun and records the task with runtime **Vercel eve**. Self-improvement is initially Off. AgentRun does not start an extra eve task or replace the original tool.

## Test owner corrections on the next run

The base extension delivers the owner's `corrections.md`. It does **not** autonomously create notes or skills. Automatic workflow learning is the separate, two-tool proof below.

After the original baseline and extension setup, use a fresh demonstration agent id with learning Off and no corrections or workflows:

```sh
npm run validate --prefix examples/eve-learning -- --live --output /tmp/eve-correction-proof.json
```

This makes three native model tasks: a connected Off baseline, a fresh-session reuse task, and a fresh-session Off control on the same agent. Between the first two, the validator enables learning and explicitly writes an **owner-authored correction** to `corrections.md` through the version-checked API: begin release reports with `Launch note:` and use one concise sentence. It records the owner commit and verifies that the next run pins that revision. This is correction delivery, not evidence of autonomous learning.

The reuse task asks about `demo-worker` without repeating the correction. It must execute the original `release_status` callback with a fresh observation UUID and report version `3.1.2` with the prefix. Plain text and Markdown bold (`**Launch note:**`) render the same prefix. The baseline and Off control must lack either form; otherwise the comparison is inconclusive. The same agent is left Off afterward. Each invocation uses a fresh native session, so earlier conversation history cannot supply the correction.

The validator reads `AGENTRUN_BASE_URL`, `AGENTRUN_API_KEY`, `AGENTRUN_AGENT_ID`, `EVE_BASE_URL` and optional `EVE_BEARER_TOKEN`. Its output path must be new. It checkpoints session ids immediately and saves answers, fictional tool observations, run ids, setting changes and the correction revision without credentials or receipt tokens. It never retries a paid task.

To inspect and continue an interrupted validation:

```sh
npm run validate --prefix examples/eve-learning -- --live --resume /tmp/eve-correction-proof.json
```

Resume re-reads native histories and server records. Confirmed sessions are never resubmitted; a submission without a confirmed session id stops. An interrupted correction write is resolved by reading the exact saved body, never blindly re-sending it. Only stages that were never submitted can start a task. Earlier failures remain in the resumption record. Legacy note/skill proof files cannot be resumed under this lifecycle.

For deployed eve applications, retain the original channel authentication and pass `EVE_BEARER_TOKEN` to the invocation script if that route requires a bearer credential. Production `eve start` rejects session requests until route authentication is configured, even though health checks are public; follow eve's [route-authentication guide](https://github.com/vercel/eve/blob/main/docs/guides/auth-and-route-protection.md) for an application that has no production route policy yet. Never expose an unauthenticated local development server publicly.

## Learn and execute a workflow with the original tools

The optional workflow proof adds a read-only `format_release_brief` callback to the fictional application. Both native eve tools and learned workflows use the same exported functions in `agent/lib/release-tools.ts`. The formatter accepts only the complete, unchanged status object actually read in that task, including its fresh UUID. This distinguishes executing the original callbacks from repeating an old answer.

When the workflow fixture is enabled, its original standing policy explicitly permits that read-only formatter while retaining the restriction to observed release facts and forbidding external actions. Eve and AgentRun receive the same policy. Adding a tool binding alone does not grant permission to use it against the original job's instructions.

Service names are string inputs; the two fictional records are data, not an enum to bake into the reusable workflow. The original callback still rejects unknown services, and the formatter still rejects invented or modified observations. This lets the learned procedure apply to changed service data without weakening the tool's runtime checks.

Use a **separate clean copy of this example** and a new `AGENTRUN_AGENT_ID` so its compiled workflow has a verifiable origin. If another eve development server is running, give the copy its own working directory, `.eve` state, output directory and port; two eve servers must not build from the same directory. Install that copy against the same built AgentRun checkout. Do not copy an existing generated `agent/extensions/agentrun.ts` mount or prior `.eve` state.

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

This performs at most nine native model tasks, plus the server's compiler calls:

1. Run the original two-tool procedure with learning Off.
2. Enable `learning: { compile_after: 5 }`, teach the repeatable procedure, then run up to four ordinary practice tasks. The server counts completed native traces, including the connected Off baseline; compilation can therefore happen after the third practice task. The default cadence is 20 completed runs. Practice stops as soon as a committed workflow exists.
3. Require a new workflow from a run in this proof, successful compiler static and synthesized dry-run checks, a matching document digest, and its run-owned learning commit. No corrections, skills or workflow files are written by the validator.
4. Run an independent native task against `demo-worker`; the compiled candidate stays out of model context. Its local shadow check reuses recorded results and must promote the candidate before reuse.
5. Ask about `demo-worker` in a fresh session without repeating the procedure. Require the committed revision, a completed `agentrun__learned_workflow` invocation, both original callback bindings, a fresh observation UUID and changed version `3.1.2`. Verify the workflow parent and callback children also reached the canonical server timeline.
6. Turn the **same agent** Off and submit the same task in another fresh session. Require direct native tools, no workflow invocation and no learning revision.

Compilation, static validation and a synthesized dry run produce a draft. The independent native shadow check must compare it with the agent's actual answer and promote it before any reuse. A checking or held draft stops this proof. The proof records the checking run separately from compilation and from the later workflow invocation.

The validator uses the version-checked public API and leaves learning Off. Direct-tool fallback does not pass workflow reuse. Missing compilation, a changed digest, foreign provenance, pending owner review or incomplete telemetry stops the proof; it never seeds a workflow, forces approval or raises its task limit to get a pass. The original pre-extension baseline adds one task, for at most ten total.

It checkpoints each session id as soon as eve returns it. To resume after inspecting an interruption:

```sh
npm run validate:workflows -- --live --resume /tmp/eve-workflow-proof.json
```

Resume re-reads actual native histories and AgentRun records; it never resubmits a recorded task. A submission without a confirmed session id is uncertain and stops. The proof contains native answers, fictional callback facts, committed workflow documents and metadata for inspection; private workflow signatures and credentials are excluded.

The tool-only workflow needs no Jev key or extra workflow-model credential. Eve still needs its original model route, and the AgentRun server needs its compilation model route. This first eve bridge accepts explicitly read-only callbacks only, with no model nodes, judge nodes, shell/code execution or implicit permissions. See the [workflow extension details](../../docs/tutorials/eve-learning.md#execute-promoted-workflows-with-existing-tools).

Offline checks use scripted native/model receipts and the shared in-process bridge/interpreter, without model calls:

```sh
npm run test:workflows
npm run typecheck
```
