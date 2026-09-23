# agent.run() + Pi

Describe a task in Pi. AgentRun turns it into a workflow you can inspect and runs its steps using your current Pi model. Requires Node 22.19+ and Pi 0.87.0.

## Install

If you do not have Pi, install the tested host version first:

```sh
npm install -g @earendil-works/pi-coding-agent@0.87.0
```

Then, in your project:

```sh
pi install npm:@parcha/agentrun-pi@0.1.0-beta.2 -l
pi --offline
```

`-l` writes project settings in `.pi/settings.json`. Omit it to install for all your Pi sessions. `--offline` skips startup downloads; it does not disable model calls. No AgentRun checkout or build is needed.

On first launch, Pi asks whether you trust the project before loading its extension. If Pi is already open, use `/reload`. Reloading clears the current workflow definition; run the demo or describe your task again to create one.

For live tasks, configure model access in Pi first. AgentRun uses Pi's current model and authentication; it needs no separate model configuration. The scripted demo below works without provider access.

Try the bundled example inside Pi:

```text
/agentrun demo
```

The demo shows the workflow graph, progress, and a completed result with call counts. It uses scripted responses over fictional sources. It makes no model calls and does not test model quality. Run `/agentrun status` to check the loaded skill and Pi host version. The tested version is 0.87.0; status flags a different host without blocking it. Missing Pi or Jev access does not prevent the scripted demo. To repeat it, run `/agentrun run` or `/agentrun demo`. A scripted demo stays scripted on rerun, including its missing-evidence path. Use `/agentrun demo live` to switch to real Pi and Jev calls. Workflows authored by Pi use real adapters.

For an offline Pi startup, use `pi --offline`. Without that flag, Pi may download optional command-line tools on first launch. This is separate from the scripted demo, which makes no network calls.

## Describe, inspect, run

```text
/agentrun Find the main entry points in this repository and summarize how requests reach them.
```

The command loads the packaged `agentrun-author` skill. Pi reads the available tools, builds a workflow, inspects its graph, then runs it with the task's input. You can also invoke `/skill:agentrun-author <task>` directly. Ask Pi to change a step or explain a result as you would in an ordinary conversation.

| Command | What happens |
| --- | --- |
| `/agentrun <task>` | Ask Pi to build, inspect, and run a workflow for the task. |
| `/agentrun help` | List commands and demo modes. |
| `/agentrun` | Show the current workflow, or help if there is none. |
| `/agentrun run` | Repeat the current workflow with its last supplied input. Scripted demos stay scripted; authored workflows use real adapters. |
| `/agentrun status` | Check skill discovery, active Pi selection, and Jev configuration without making provider calls. |
| `/agentrun stop` | Request cancellation of the running workflow. |

A progress widget shows active steps and the number finished. Results appear in Pi, with full output and events in the structured result.

Pi 0.87.0 cannot export a fresh session containing only slash-command results. To save an offline research receipt from the checkout, run `node examples/research-live.mjs --out research-result.json`. This runs the scripted example again and writes its result; it does not export the Pi session.

One workflow runs at a time. Definitions and run state belong to the current Pi session; switching sessions or closing Pi does not create a saved workflow library. Named saves and reuse across sessions are planned for V2. This extension does not support them.

### Three demo modes

| Command | What it demonstrates |
| --- | --- |
| `/agentrun demo` | Scripted successful execution over the bundled fictional sources, without model calls. |
| `/agentrun demo empty` | Scripted insufficient-evidence path, without model calls. |
| `/agentrun demo live` | Real Pi agent steps and Jev system one decisions over the same fictional sources. |

Live mode uses your active Pi model and requires configured TypeSafe access for Jev. It still does not search the web or prove accuracy on real research. See the [Jev adapter configuration](https://github.com/Parcha-ai/agentrun/tree/main/packages/jev#readme). Live calls can incur usage charges; scripted mode needs no provider access.

## Tools and execution

By default, the extension exposes currently active Pi built-in `read`, `grep`, `find`, and `ls` tools. A workflow can narrow that set; it cannot enable a tool that the host has not supplied. The additional `search` tool reads only the bundled fictional demo sources.

The user must issue `/agentrun run --trusted` for each run that needs code nodes or active built-in `bash`, `edit`, or `write` tools. This permits local, unsandboxed execution; authorization does not carry into the next run. A model cannot grant itself that permission with a tool argument.

Native V1 does not supply SOP text. Workflows declaring `sopSection` stop before execution with a setup error; keep the required sections and use an SDK host that supplies the complete SOP.

Custom extension tools and the outer Pi session's permission hooks are **not inherited**, including in trusted runs. A configured host can explicitly supply its own tool definitions as described below. Shell/executor effect transports and artifact delivery are unavailable in this extension; declared tool effects must use an available tool.

A direct `call` to a Pi built-in returns a Pi tool result. Its `content` is an array of text/image blocks; `details` may be absent from the workflow's JSON result. Declare that result shape in the output schema. Custom `PiToolDefinition` implementations follow Pi's SDK contract and return a `details` field; use `details: undefined` when there is no extra data. Only the demo `search` tool returns `{sources}` directly. A tool-only workflow does not create an agent session. Jev is needed only for system one decisions.

Jev design guidance is bundled with the author skill and returned by `describe`
under `authoring.jev`, including for hosts without a file-reading tool. No separate
TypeSafe skill install is required for DSL authoring. The
[source-read example](skills/author/examples/read-source-decision.json) preserves
original tool evidence through a Jev decision and deterministic projection; its
fictional tests demonstrate wiring, not measured semantic accuracy. Explicit
`tools: []` disables tools for an agent node; omission inherits the host allowlist.

Inspection checks nonexecuting host admission as well as DSL structure; `describe`
also exposes structural limits. Runtime contract failures provide safe error codes,
stages and schema problems for repair. Unknown provider failures remain opaque;
provider bodies and arbitrary code exception text are not included in reports.
Recognized Jev response/transport failures use fixed `jev_*` categories, and a Pi
session response failure uses `model_response_failed`, with the failing node label.
Pi runner stops use `pi_timeout`, `pi_turn_limit`, `pi_submission_limit`,
`pi_no_submission`, or `pi_aborted`, with a fixed message explaining the next step.
Operator cancellation of the workflow still reports `cancelled`.
Jev reports may also include a fixed `error.reason` identifying the rejected
response invariant, or a numeric HTTP `error.status`. A recognized token-capacity
rejection reports `max_tokens_exceeded`; this is not a byte-to-token estimate or
permission to truncate evidence. Provider text remains private.
These diagnostics add no retry and do not infer an unobserved provider cause.

Use `/agentrun stop` to cancel a slash-command run; pressing Escape is not a guaranteed cancellation path. Stopping signals admitted tools, but already-started effects may still finish. Check their results before retrying; a stop does not undo a write.

Displayed workflow counts include direct tool calls, system one decisions, and model steps. They do not include tools called inside an agent step or measure tokens, requests, or spending. Hosts can count child tool attempts through `onToolAttempt`.

Agent steps capture the active Pi model when the run starts and keep that selection for the run. Request-count and deadline limits bound execution; they are not token or spending caps.

The native model-facing interface starts with `agentrun` and `action: "describe"` for available tool schemas and configuration presence, then `action: "inspect"` and a complete `workflow`, followed by `action: "run"` and `input`. There is no outer `submit` tool: `submit` belongs to the internal child runner and the SDK author described below.

### Configure the native extension from a host

Hosts that own a restricted corpus, an approved Jev transport, or shared accounting can configure the same native extension:

```js
import { createAgentRunExtension } from '@parcha/agentrun-pi/extension';

// These definitions and callbacks belong to the embedding host.
export default createAgentRunExtension({
  hostTools: ctx => approvedToolsFor(ctx),
  createJudge: ({ signal }) => makeHostJudge({ signal }),
  onToolAttempt: () => sharedBudget.admit('tool'),
});
```

All options are optional; the default export retains ordinary Pi setup. `hostTools` replaces the complete built-in and demo tool inventory, including during trusted runs. `describe` reports the supplied schemas. Direct calls to these tools return `{content, details?}` even if a supplied tool is named `search`. Definitions refresh from the execution context before each run. Tool names must be unique; `agentrun` and `submit` are reserved.

`createJudge` supplies the runner for workflow Jev nodes and is called only when the graph requires one. A failed factory never falls back to ambient configuration. The host receives cancellation signals and owns transport configuration and accounting. `onToolAttempt` is synchronous admission: it runs before each direct tool call and each native child tool attempt, including invalid arguments, unknown tools, and `submit`. Throwing prevents the attempted effect. Outer authoring calls are counted by their own host. `describe.limits` reports the configured workflow deadline, model-request, judge-call and tool-attempt ceilings, and per-node turn, submission, and timeout limits. The callback can impose a shared budget across authoring and execution.

Hosts may supply `runtimeLimits` to lower a finite limit or explicitly disable it with `null`: `deadlineMs`, `modelRequests`, `judgeCalls`, `toolAttempts`, `nodeMaxTurns`, `nodeMaxSubmissions`, and `nodeTimeoutMs`. Omitted values keep existing finite defaults. Disabling all seven removes extension inference/time admission caps while preserving operator cancellation, schema validation, graph structure, concurrency, and trace/data guards. This is host configuration; neither a workflow nor an author tool argument can change it. Tool-specific timeouts and provider limits are separate host/tool contracts.

Trace retention is **not an execution budget**. A run keeps recent sanitized events
within a bounded in-memory report and continues when that retention fills. The
report's `trace` counts received, retained, dropped and rejected events/bytes;
`traceTruncated` discloses incomplete retained history, not incomplete output.
Individual events still have plain-JSON, byte, depth and value-count safety guards.
The SDK service configures those separately with `maxTraceBytes` (retention) and
`maxEventBytes` (individual safety).

For complete host-owned observation, configure `onWorkflowEvent(frame)`. Each
frame has `workflowDigest`, a registration-local `runOrdinal`, a per-run `sequence`,
and an isolated sanitized `event`. Valid events arrive even after report retention
fills, including cancellation cleanup before run closure. This callback cannot
grant authority or change execution. It is not a durable-store guarantee: the host
must record write failures, drain asynchronous work, and check received sequences
against report counters before claiming a complete journal. Callback errors are
nonfatal to the workflow. Do not store source material without an appropriate
host-owned storage policy.

An operator may select a different active Pi model between inspection and execution; child agent steps capture that execution selection. The workflow cannot choose a replacement model or configure host callbacks. Code still requires the per-run trusted command and remains unsandboxed: a restricted tool inventory is not a sandbox for executable code. The host must review executable candidates before granting that authority.

## SDK: embed the runner

The native extension handles configuration above. For another Pi extension that already has a context:

```js
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createPiHostRunner } from '@parcha/agentrun-pi';

const result = await runWorkflow(workflow, input, {
  runNode: createPiHostRunner(ctx, { tools: allowedTools }),
  // Supply runJudge separately for Jev nodes or semantic verification.
});
```

`ctx` supplies the active model and public model registry. Tools are explicitly supplied and receive the original context; outer hooks are not copied. The captured active model remains fixed for the run. The host thinking level is inherited when provided, and a node can override it. The runner bounds turns, submissions, and time, and refuses an absent model instead of selecting a fallback. These limits do not impose token or spending caps.

For a standalone application, `createPiRunner(options)` accepts a configured SDK `ModelRuntime` and its selected `model`. Supply `tools` explicitly. It loads no ambient filesystem tools, workspace instructions, extensions, prompt templates, or skills. `createPiHostSessionFactory(ctx)` exposes the same native child session transport for integrations that own their own runner. Factories are unnecessary for ordinary extension use.

LLM `instructions` are literal text. Refer to "the text field in the JSON input" and declare `requires: ["text"]`; `{text}` inside instructions stays literal. An optional node `state` map scopes the JSON user message. Placeholder substitution applies to designated fields such as `state` and `call.args`.

The child model delivers `{value: result}` through its `submit` tool. Schema and review rejections return feedback to the same session. Exhausting a turn, submission, timeout, or cancellation limit throws `PiRunError`; a rejected draft is never returned as success. A host can explicitly pass `null` for runner `maxTurns`, `maxSubmissions`, or `timeoutMs` to disable that limit. Omission keeps the default; external cancellation still interrupts unlimited runs.

## SDK: retain candidates and check fixed fixtures

The SDK author saves candidate files separately from the native extension's session-local workflow. Supply configured runner options and host-owned acceptance checks:

```js
import { authorWorkflow } from '@parcha/agentrun-pi';

const candidate = await authorWorkflow({
  request: 'Extract a numeric count from text',
  outputDir: './candidates',
  inputKeys: ['text'],
  pi: options, // Your configured PiRunnerOptions.
  maxCandidates: 4,
  acceptance: workflow => checkAgainstYourFixtures(workflow),
});
console.log(candidate.path, candidate.checks);
```

The host owns `checkAgainstYourFixtures`: return diagnostics, or `[]` to accept. Without that callback, acceptance is labeled `structural` and does not establish correct behavior. The author retains each submitted version and its feedback, never activates it, and cannot edit the host's acceptance checks.

With `rubricSections`, every supplied section must appear on every generated LLM node, including child workflows. The author conservatively rejects Jev nodes, semantic `ask` predicates, and `verify` clauses under that policy; those need a separately reviewed question contract. Schema properties named `node`, `verify`, or `predicate` remain ordinary data. Supply the authoritative rubric as `deps.sop` when executing the candidate.

The standalone CLI remains available as `node packages/pi/dist/cli.js --help` from source. It imports a trusted caller-owned `--config` module for `author` and `run`; importing that module executes its code. `validate` can evaluate code probes. Review executable workflows before using it.

## Develop from source

To change the extension itself, clone and build the repository:

```sh
git clone --branch main --single-branch https://github.com/Parcha-ai/agentrun.git
cd agentrun
npm ci --ignore-scripts
npm run build
./node_modules/.bin/pi install ./packages/pi -l
./node_modules/.bin/pi --offline
```

Use a separate project for this source installation. Pi loads the extension and skill from the checkout, so keep it in place. After source changes, rebuild and run `/reload`.

## Dependencies and retained data

Pi is optional for `@parcha/agentrun-dsl`. This package brings the Pi coding-agent SDK, its provider dependencies, and the Jev adapter; its dependency footprint is larger than the core. The release inventory records the locked versions.

The SDK dependencies remain pinned so standalone applications and the CLI have a complete runtime. When loaded as an extension, Pi resolves its core packages and TypeBox through the host loader. The tested host is Pi 0.87.0; installed SDK pins do not make an older or newer host compatible. The offline loader regression checks competing local dependencies, a native file read, and the scripted workflow. Pi's [package guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies) recommends peers for extension-only packages; this package also provides the standalone SDK.

Candidate directories retain request text, rubric text, workflow versions, and feedback. Native Pi messages can contain workflow inputs and results. Choose storage and tool access appropriate for that data. The accompanying `skills/author/SKILL.md` describes the native and SDK authoring paths for agents.

## License

Apache-2.0. See the included LICENSE and NOTICE files.
