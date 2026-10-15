# agent.run() + Pi

Describe a task in Pi, inspect the workflow, run it with your current model, and save its definition for new input. Requires Node 22.19+ and Pi 1.2.0.

## Install

If you do not have Pi, install the tested host version first:

```sh
npm install -g @earendil-works/pi-coding-agent@1.2.0
```

Then, in your project:

```sh
pi install npm:@parcha/agentrun-pi@beta -l
pi --offline
```

`-l` writes project settings in `.pi/settings.json`. Omit it to install for all your Pi sessions. `--offline` skips startup downloads; it does not disable model calls. No AgentRun checkout or build is needed.

On first launch, Pi asks whether you trust the project before loading its extension. If Pi is already open, use `/reload`. The current draft is restored from a persisted Pi session branch when available; named definition saves are stored separately.

For live tasks, configure model access in Pi first. AgentRun uses Pi's current model and authentication; it needs no separate model configuration. The scripted demo below works without provider access.

Try the bundled example inside Pi:

```text
/agentrun demo
```

No Pi session at hand? The same scripted workflow runs from a shell, with no key and no network:

```sh
npx @parcha/agentrun-pi@beta demo
```

It prints each sub-question with its answer, then `Status: complete`, the answer and the scripted call counts, and exits 0. `npx @parcha/agentrun-pi@beta demo empty` runs the missing-evidence path and prints `Status: escalated`.

The demo shows the workflow graph, progress, and a completed result with call counts. It uses scripted responses over fictional sources. It makes no model calls and does not test model quality. Run `/agentrun status` to check the loaded skill and Pi host version. The tested version is 1.2.0; status flags a different host without blocking it. Missing Pi or Jev access does not prevent the scripted demo. To repeat it, run `/agentrun run` or `/agentrun demo`. A scripted demo stays scripted on rerun, including its missing-evidence path. Use `/agentrun demo live` to switch to real Pi and Jev calls. Workflows authored by Pi use real adapters.

For an offline Pi startup, use `pi --offline`. Without that flag, Pi may download optional command-line tools on first launch. This is separate from the scripted demo, which makes no network calls.

## Preview, run, save, reuse

```text
/agentrun Preview a reusable workflow that identifies breaking changes and migration actions in supplied release notes. Do not run it yet.
```

The command loads the `agentrun-author` skill. Its source ships in `@parcha/agentrun-dsl`; this package registers it rendered with the Pi host rules. A preview validates and displays the graph without running it. Ask Pi to run when ready, or use `/agentrun run`. You can also invoke `/skill:agentrun-author <task>` directly.

Open `/agentrun` to inspect the graph in the native terminal UI. Select a stage to see its contract, instructions or criteria, and observed evidence. The Actions page offers run, input, edit, save, load, and history. Arrow keys navigate, Enter inspects, `a` opens Actions, and Escape goes back or closes the view. Closing the inspector does not cancel execution; non-TUI hosts receive a text view.

After inspecting a definition, save it and reuse it in a new Pi session in the same project:

```text
/agentrun input The release note says requests now require X-Workspace.
/agentrun run
/agentrun save release-review
```

```text
/agentrun load release-review
/agentrun input The next release removes /events; clients must use /v2/events.
/agentrun run
```

Loading starts with empty input and does not execute. A save retains the definition, not input or execution permission. Scripted demo adapters are not saved: loading a saved demo uses live adapters and requires the corresponding model and Jev access. Each run restarts with the current input and model; it is not checkpoint resume.

| Command | What happens |
| --- | --- |
| `/agentrun <task>` | Ask Pi to author, edit, or run; say when you want a preview only. |
| `/agentrun help` | List commands and demo modes. |
| `/agentrun` | Inspect the current workflow, or show help if there is none. |
| `/agentrun input <case or JSON>` | Set new input without changing the definition or running it. |
| `/agentrun run` | Repeat the current workflow with its last supplied input. Scripted demos stay scripted; authored workflows use real adapters. |
| `/agentrun save <name>` | Save an immutable, project-local definition revision. |
| `/agentrun load <name> [digest]` | Load the newest or exact revision; input starts empty. |
| `/agentrun list` | List saved revisions. |
| `/agentrun history` | Inspect retained run receipts on this Pi branch. |
| `/agentrun status` | Check skill discovery, active Pi selection, and Jev configuration without making provider calls. |
| `/agentrun stop` | Request cancellation of the running workflow. |

A progress widget shows active steps and the number finished. Results distinguish completion, escalation, failure, and interruption. Decision records show supplied evidence, criteria, answer, and route, not hidden reasoning or proof of correctness.

Pi 1.1.0 cannot export a fresh session containing only slash-command results. To save an offline research receipt from the checkout, run `node examples/research-live.mjs --out research-result.json`. This runs the scripted example again and writes its result; it does not export the Pi session.

A live run is durable. Its journal is kept in `.pi/agentrun/runs/<run id>/journal.json`, and `/agentrun run` after an interruption (`/agentrun stop`, a closed session, a killed process) or a failure continues the same run: committed steps are answered from the journal, a tool call that completed is answered from its receipt and is not made again, and the next step runs. The run is bound to its workflow, input, SOP text and tool names; a change to any of them starts a new run. A tool call that was in flight when the run stopped has an unknown outcome and is never made again: the resumed run fails naming it, and the person who knows whether it happened reconciles it before a new run. An agent step that was interrupted starts over from its first turn. A run that completed or escalated is not resumed; `/agentrun run` starts a new one. Scripted demos keep no journal.

One workflow runs at a time. Named definitions are durable across sessions in the same project. Pi run receipts belong to the current branch and may remain in memory until Pi persists its session; saving a definition does not save a receipt.

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

A workflow that names `sopSection`s needs SOP text. `/agentrun sop <file>` reads a Markdown file inside the project (up to 512 KiB) and checks that it has a `## <section>` heading for each section the workflow names; `/agentrun sop` shows what is set. The file's digest is kept with the session, and a run is refused if the file changed since it was supplied. A host that passes `sop` to `createAgentRunExtension` supplies the text itself and `/agentrun sop` is not used.

Custom extension tools and the outer Pi session's permission hooks are **not inherited**, including in trusted runs. A configured host can explicitly supply its own tool definitions as described below. Shell/executor effect transports and artifact delivery are unavailable in this extension; declared tool effects must use an available tool.

A direct `call` to a Pi built-in returns a Pi tool result. Its `content` is an array of text/image blocks; `details` may be absent from the workflow's JSON result. Declare that result shape in the output schema. Custom `PiToolDefinition` implementations follow Pi's SDK contract and return a `details` field; use `details: undefined` when there is no extra data. Only the demo `search` tool returns `{sources}` directly. A tool-only workflow does not create an agent session. Jev is needed only for system one decisions.

Jev design guidance is bundled with the author skill and returned by `describe`
under `authoring.jev`, including for hosts without a file-reading tool. No separate
TypeSafe skill install is required for DSL authoring. The
[source-read example](../dsl/skills/author/examples/read-source-decision.json) preserves
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

`authorWorkflow` lives in `@parcha/agentrun-dsl` beside the language it teaches. It saves candidate files separately from the native extension's current draft and named procedure revisions. Give it a Pi runner with no host tools, and bound its submissions by the candidate limit:

```js
import { authorWorkflow } from '@parcha/agentrun-dsl';
import { createPiRunner } from '@parcha/agentrun-pi';

const candidate = await authorWorkflow({
  request: 'Extract a numeric count from text',
  outputDir: './candidates',
  inputKeys: ['text'],
  runNode: createPiRunner({ ...options, tools: [], maxSubmissions: 4 }), // Your configured PiRunnerOptions.
  maxCandidates: 4,
  acceptance: workflow => checkAgainstYourFixtures(workflow),
});
console.log(candidate.path, candidate.checks);
```

The host owns `checkAgainstYourFixtures`: return diagnostics, or `[]` to accept. Without that callback, acceptance is labeled `structural` and does not establish correct behavior. The author retains each submitted version and its feedback, never activates it, and cannot edit the host's acceptance checks. See [the author contract](../../docs/authoring.md#one-author-contract) for the host addendum.

With `rubricSections`, every supplied section must appear on every generated LLM node, including child workflows. The author conservatively rejects Jev nodes, semantic `ask` predicates, and `verify` clauses under that policy; those need a separately reviewed question contract. Schema properties named `node`, `verify`, or `predicate` remain ordinary data. Supply the authoritative rubric as `deps.sop` when executing the candidate.

The standalone CLI remains available as `node packages/pi/dist/cli.js --help` from source. It imports a trusted caller-owned `--config` module for `author` and `run`; importing that module executes its code. `validate` can evaluate code probes. Review executable workflows before using it.

## Sign in, pick a model, check keys

`@parcha/agentrun-pi/signin` is what a demo, or your own app, runs before its first model call. It is the only entry of this package that loads `@earendil-works/pi-ai`, an optional peer: install it beside the package (`npm install @earendil-works/pi-ai@~1.2.0`) to use this entry. No other entry imports it.

```js
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { checkKeys, resolveModel, usageLimitError } from '@parcha/agentrun-pi/signin';

const report = checkKeys(spec, { live: true, dir: demoDir });
if (!report.ok) { console.error(report.text); process.exit(report.exitCode); } // 2: nothing was sent
const { model, getApiKey, source } = await resolveModel(spec, { provider, model: modelId });
const message = await builtinModels().completeSimple(model, context, { apiKey: await getApiKey() });
if (usageLimitError(message)) throw usageLimitError(message);
```

- `checkKeys(spec, options)` lists what this run needs and what is missing: each key by its env name and where to create it, each program on `PATH` (refused outside its `platforms`, or below its `min` version as the first x.y.z that `<cmd> --version` prints), and each package as the demo's directory resolves it, with the exact `npm install --no-save <name>@<version>` line when it is missing. An item with `for: 'live'` or `for: 'kill'` counts only in that mode. A `oneOf` choice is met by any member, and an array member only by all of its items. A Jev judge asks for `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. The check sends no request and prompts for nothing; a key's value is never printed.
- `checkSetupPrompt(spec, text)` checks a demo's setup prompt against its spec: every key env name, program command and package name in the spec appears in it, and it names no credential env name (`*_API_KEY`, `*_KEY`, `*_TOKEN*`, `*_SECRET*`, `*_PROJECT_ID`) the spec does not list. `node scripts/check-setup-prompts.mjs` runs it for every `examples/*/demo.json` in CI.
- `resolveModel(spec, options)` picks the model and its key. An explicit `provider` (and `model`) with that provider's env key wins, passed on as an explicit key; Anthropic takes `ANTHROPIC_API_KEY` only. Otherwise a stored ChatGPT sign-in is used, and the model is chosen from the account's own `GET /v1/models` by what the spec needs (text, tools, images): the spec's default when the account lists it, else the newest one pi-ai knows. With neither, it runs the sign-in. A sign-in's model takes only streaming Responses calls with `store: false` (`responsesOnly`, `unsupported`). The spec's eyes model resolves the same way: an explicit `eyes` model with its key, else the lead model when it meets the eyes' needs, else a `ResolveError` naming the gap; the ChatGPT plan takes no video input. The result serializes without its key.
- `signIn(options)` runs pi-ai's own Sign in with ChatGPT once per install, with this app's name and a host id kept for the install. pi-ai's callback port is fixed at 1455; when another login holds it, the sign-in fails at once and says to finish or cancel that login. A pi-ai that ignores the app name (before 1.1) is refused before the page opens.
- The sign-in lives in `$AGENTRUN_HOME/auth.json` (default `~/.config/agentrun/`): the directory is 0700 and the file 0600, written whole and renamed into place. An existing directory others can read is refused, not changed. Refreshes are serialized across processes by an operating-system lock, an exclusive SQLite transaction on `auth.json.lock` (an empty database beside it, through `node:sqlite`). The system frees it when its holder exits or is killed, so a crashed run leaves no lock to clear, the rotating refresh token is never sent twice, and a process that waited reads the new token. On Node 22, `node:sqlite` prints one experimental warning when the first write loads it. A token never reaches a log, a URL or a recording.
- The plan's usage limit (`subscription_sharing_usage_limit_exceeded`) maps to `UsageLimitError`: "Your ChatGPT plan's usage limit is reached; wait, or set a provider key." It is never retried.

## Develop from source

To change the extension itself, clone and build the repository:

```sh
git clone --branch main --single-branch https://github.com/Parcha-ai/agentrun.git
cd agentrun
npm ci --ignore-scripts
npm run build
agentrun_checkout="$PWD"
mkdir -p ../agentrun-pi-project
cd ../agentrun-pi-project
"$agentrun_checkout/node_modules/.bin/pi" install "$agentrun_checkout/packages/pi" -l
"$agentrun_checkout/node_modules/.bin/pi" --offline
```

These commands create a separate `agentrun-pi-project` beside the checkout. You can use your own project directory instead. Pi loads the extension and skill from the checkout, so keep it in place. After source changes, rebuild and run `/reload`.

## Dependencies and retained data

Pi is optional for `@parcha/agentrun-dsl`. This package depends on the DSL and the Jev adapter only. The Pi packages it uses (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `@earendil-works/pi-ai` for the sign-in entry only) and `typebox` are optional peer dependencies at `*`, as Pi's package guidance requires, so an installed copy never shadows the host's. The release inventory records the locked versions.

When loaded as an extension, Pi resolves its core packages and TypeBox through the host loader, and `pi install` adds nothing else. A standalone application or the `agentrun-pi` CLI has no host: install the peers yourself (`npm install @earendil-works/pi-coding-agent@~1.2.0 @earendil-works/pi-agent-core@~1.2.0 @earendil-works/pi-tui@~1.2.0 typebox`). The pi packages are pinned to 1.2: pi 1.3.0 pins its own packages to exact versions, and this release's ranges stop below 1.3 until the next one. The tested host is Pi 1.2.0; peer ranges at `*` do not make an older or newer host compatible. The sign-in entry needs pi-ai 1.1.0 or later: pi-ai 1.0.x ignores the app name and would put pi's name on ChatGPT's sign-in page, so `signIn` refuses it with `SignInError` (`APP_NAME_IGNORED`) before the page is shown. The offline loader regression checks competing local dependencies, a native file read, and the scripted workflow. Pi's [package guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies) is the rule this follows.

The durable entry (`@parcha/agentrun-pi/durable`) takes pi-durable and chord as optional peers from 1.0.4 to below 1.3; CI runs it on 1.0.4, 1.1.0 and 1.2.0. A run that pi-durable 1.1 left (killed, paused, or with a tool call in flight) continues on 1.2. The move does not go back. A run that pi 1.2 left with a tool call in flight cannot be continued by pi 1.1: 1.1 waits on the newer task, and the only thing it writes is that task's mark from running back to pending, as pi does for any task a dead process left running. Continue such a run on 1.2, and do not downgrade pi under a live run. A host can call `refuseNewerTasks(harness, context)` from the durable entry after opening its Harness. On pi before 1.2, it then fails such a store with `NewerTaskError` (code `PI_TASK_NEWER`, naming the task's kind and version) instead of waiting.

Candidate directories retain request text, rubric text, workflow versions, and feedback. Native Pi messages can contain workflow inputs and results. Choose storage and tool access appropriate for that data. The author skill in `@parcha/agentrun-dsl` describes the native and SDK authoring paths for agents.

## License

Apache-2.0. See the included LICENSE and NOTICE files.
