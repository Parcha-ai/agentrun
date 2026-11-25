# Connect existing Claude Code and Codex agents

Use **Connect your agents** and choose whether to connect a live setup, import past history, or both. For a live connection, select this server or another source machine, discover the selected project and choose its default, a Claude Code named agent, or a Codex profile. Verify checks the CLI and native sign-in without a model call. It separately reports that model and tool execution remain untested. The console handoff reads the skill bundled with that exact server build at `/skills/agentrun-serve/SKILL.md`.

The current bridge requires stable Claude Code 2.1.322 or later in major version 2, or Codex 0.167.2 or later in major version 0. Older, prerelease and other major versions show Needs attention until the bridge supports their protocol.

The public CLI provides the same handoff:

```sh
npx @parcha/agentrun native discover --project /absolute/project
npx @parcha/agentrun native connect --project /absolute/project --runtime claude-code
npx @parcha/agentrun native connect --project /absolute/project --runtime codex --profile review
```

Use `--agent NAME` for a discovered Claude named agent. Use `--data DIR` for another local instance, or `--url http://127.0.0.1:PORT`. Discovery runs metadata commands only. Local connection needs the local server credential; it needs no model API key. A browser cannot scan another machine; use its explicit outbound connector below.

## Connect another machine

For an agent your backend or terminal already runs, use [metadata observation](../connector/README.md#observe-agents-that-already-run-elsewhere). The OSS server accepts the existing hosted CLI/Collector protocol. It shows observed sessions without creating runnable copies of the agent. The following remote execution path is for jobs AgentRun starts.

The existing Python AgentRun CLI is bundled in `connector/`, with an opt-in `remote` command. Install it and the Node runtime from the same reviewed build as the server. Older released observation-only launchers do not provide remote native execution. From a built source checkout, use `uv tool install ./connector`; its `agentrun` command accepts `remote discover`, `remote connect`, `remote worker`, `remote status` and `remote disconnect`. `python -m agentrun_cli` in that installed environment avoids a command-name collision with the Node management CLI.

1. On the source machine, run `agentrun remote discover --project /absolute/project --runtime claude-code` or `codex`. Only the selected project is discovered; past sessions are not read.
2. In the destination console, open **Connect agent → Another machine**, select **Live agent**, and create a one-use connection code. Enter it into the CLI's secure prompt, never a command argument or coding-agent prompt. Choose **History only** or **Both** only when that transfer is wanted; the default code does not grant history upload.
3. Run `agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime claude-code`, using the intended server's origin. `--selector-kind agent --selector-name NAME` selects a Claude named agent; `--selector-kind profile --selector-name NAME` selects a Codex profile. Connection imports exactly that source-bound setup and starts the worker, without starting a model task.
4. Verify the source worker is online and open its imported agent. Turn Self-improving On when wanted, then start a normal AgentRun job.

The CLI finds `agentrun-serve remote-bridge` from the matching Node installation. For a source checkout, pass `--bridge /path/to/checkout/packages/serve/dist/native/remote-worker-bridge.js`. Use a private `--state-dir` per connection; `--no-start` registers without starting observation/execution. An approved unattended connection can use `--credential-file /private/enrollment.json`: an owner-only file with `origin` and the one-use code in `api_key`. The broad server API token stays off the source machine. Only a restricted connector credential is retained after enrollment.

`agentrun remote worker --state-dir /private/connector --foreground` owns the worker in a terminal. A persistent service is optional and must be explicitly installed by the source operator. `remote disconnect` or the console's Revoke action prevents future work and stops the worker on its next poll. Loss of a command lease closes native execution; an interrupted dispatch is recorded as uncertain and never automatically replayed. The source worker makes outbound HTTPS requests only, with no public inbound listener.

Import here means an ordinary agent/revision referencing the selected source setup. Its configuration, skills, MCP, hooks and sign-in stay on that machine. Run prompts, results, tool activity, usage and an immutable standing-instruction snapshot are sent to the destination for the approved runs and learning. The server cannot select another source path, executable or environment through the worker protocol. The original source permissions remain authoritative. Metadata observation uses the existing observer protocol on both hosted and OSS servers.

### Import selected history

The same Connect agent skill can import completed Claude Code or Codex sessions from another machine. First preview one exact project and runtime on the source; nothing is uploaded:

```sh
agentrun remote history-preview --project /absolute/project --runtime codex
```

Review the selected destination and candidate session counts. Export can skip oversized or unsettled content after this metadata preview. The destination owner must create a code with **History only** or **Both** access, and the source operator must explicitly choose the matching flag:

```sh
# Historical records only; no executing worker or self-improvement.
agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime codex --history-only

# A live project connection plus its completed session history.
agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime codex --history
```

Use only the selected command. History-only needs no native sign-in or model call. It cannot become runnable without a new owner enrollment. Completed sessions are imported as ordinary historical run records with source provenance, without executing them or using them as learning. Recent sessions (last ten minutes) and child sessions are skipped. `agentrun remote import-history --state-dir /private/connector` imports newly eligible sessions for the same approved target; repeated uploads skip duplicates. This is an explicit import, not continuous transcript collection or attachment to a conversation in progress.

History is scoped to the selected project/runtime. Native logs cannot reliably attribute sessions to a named Claude agent or Codex profile, so history flags reject those selectors. Connect a named setup separately and use a project-level history-only connection when both are needed. Local-store import remains available for local Claude Code, Codex and pi histories; follow the skill's maintenance-window instructions before taking ownership of a running server's store.

Connected agents use the ordinary agent, revision, skills and per-agent learning records. Their revision contains a reference to the native source, not a copied prompt or credential store. Normal definition edits retain that reference. The portable `agent.md` template manifest continues to compile into the same ordinary records; it rejects native machine references. The current template API does not export a connected source setup. Existing managed adapters retain their isolated configuration.

New jobs run in the original project and use native configuration resolution, model selection, MCP tools, hooks and sign-in. A named Claude agent is selected as the main session; a Codex profile is a profile, not a custom subagent. Each run records its exact session and resolved configuration fingerprint. Local reconnection updates the same agent; Verify refreshes metadata for an existing remote binding. Replacing a revoked remote connector requires a new grant and private state directory, and creates a new binding. Disconnect prevents future starts without changing the project or removing history. Imported conversations remain historical; they neither become live jobs nor enter this learning path.

Turn **Self-improving** On to give each run the agent's corrections (its `corrections.md`, under `# Learned`). An owner's feedback on a run becomes one line of `corrections.md` with no model turn. You can also edit the corrections in the Learning tab. Native connections do not compile or run learned workflows; those require managed execution or a compatible backend workflow bridge. They do not generate automatic notes or skills or launch extra native reflection sessions.

The corrections are additive context. AgentRun never overwrites `AGENTS.md`, `CLAUDE.md`, native settings, or native memory. Off means later runs neither load nor create AgentRun learning; saved learning remains available. Running jobs keep their pinned learning revision.

The bridge supports new jobs, native event history, supported usage counters, stop and cancel. Interactive approval handling and in-session steering are unavailable; a denied tool request is shown explicitly. No permission-bypass flags are added. Per-run effort overrides and uploaded attachments are unavailable: change the original native setup or source files. Native dollar limits cannot be enforced by AgentRun, so capped launches are refused. Unknown costs, token counters and model request counts remain unknown; native turns are not counted as model requests.

Jobs for the same source directory are serialized. An interrupted native dispatch is never blindly replayed because its side effects may have happened. After a runner or source-worker crash, inspect the source project and its task-owned lock named by the failure before removing a stale lock and starting a new job. Native sessions launched independently in a terminal or desktop app use a separate [existing CLI learning integration](tutorials/existing-cli-learning.md): project hooks capture completed prompt windows and deliver explicit owner corrections without handing execution to this bridge. Source-hook capture does not generate automatic notes or skills, compile workflows, or launch extra native reflection calls.

## Verify correction delivery

Use a disposable connected agent and its original source configuration. In Learning, add a harmless, distinctive owner correction such as a required answer prefix, then start a fresh task with learning On. Inspect the run's pinned learning revision and confirm its answer follows that correction. Start a fresh Off control and verify it receives no AgentRun learning. These tasks make real model calls through the selected source CLI.

For remote connections, use the actual source worker and also verify connector revocation, cancellation and source configuration preservation. Confirm that the worker cannot call unrelated server APIs. Preserve run/session IDs and reported usage as evidence without recording credentials.

The historical `native-learning-e2e.mjs` and `remote-learning-e2e.mjs` scripts target the retired notes/skills and grading pipeline. They are not acceptance tests for the current corrections model. The [backend SDK examples](../examples/sdk-learning/README.md) include automated fresh-session correction checks for SDK integrations.
