# Connect existing Claude Code and Codex agents

Connect an existing setup on the same machine as a loopback AgentRun server using the native CLI commands below. Select the project default, a Claude Code named agent, or a Codex profile. Verification checks the installed CLI and native sign-in without a model call; model and tool execution remain untested until a job runs.

The current bridge requires stable Claude Code 2.1.322 or later in major version 2, or Codex 0.167.2 or later in major version 0. Older, prerelease and other major versions show Needs attention until the bridge supports their protocol.

The public CLI provides the same handoff:

```sh
npx @parcha/agentrun native discover --project /absolute/project
npx @parcha/agentrun native connect --project /absolute/project --runtime claude-code
npx @parcha/agentrun native connect --project /absolute/project --runtime codex --profile review
```

Use `--agent NAME` for a discovered Claude named agent. Use `--data DIR` for another local instance, or `--url http://127.0.0.1:PORT`. Discovery runs metadata commands only. Local connection needs the local server credential; it needs no model API key. A browser cannot scan another machine.
## Connect another machine

The existing Python AgentRun CLI is bundled in `connector/`, with an opt-in `remote` command. Install it and the Node runtime from the same reviewed build as the server. Older released observation-only launchers do not provide remote native execution. From a built source checkout, use `uv tool install ./connector`; its `agentrun` command accepts `remote discover`, `remote connect`, `remote worker`, `remote status` and `remote disconnect`. `python -m agentrun_cli` in that installed environment avoids a command-name collision with the Node management CLI.

1. On the source machine, run `agentrun remote discover --project /absolute/project --runtime claude-code` or `codex`. Only the selected project is discovered; past sessions are not read.
2. Using the authenticated destination API, create a one-use connection code with `POST /v2/connectors/enrollment`. Enter it into the CLI's secure prompt, never a command argument or coding-agent prompt.
3. Run `agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime claude-code`, using the intended server's origin. `--selector-kind agent --selector-name NAME` selects a Claude named agent; `--selector-kind profile --selector-name NAME` selects a Codex profile. Connection imports exactly that source-bound setup and starts the worker, without starting a model task.
4. Verify the source worker is online and open its imported agent. Turn Self-improving On when wanted, then start a normal AgentRun job.

The CLI finds `agentrun-serve remote-bridge` from the matching Node installation. For a source checkout, pass `--bridge /path/to/checkout/packages/serve/dist/native/remote-worker-bridge.js`. Use a private `--state-dir` per connection; `--no-start` registers without starting observation/execution. An approved unattended connection can use `--credential-file /private/enrollment.json`: an owner-only file with `origin` and the one-use code in `api_key`. The broad server API token stays off the source machine. Only a restricted connector credential is retained after enrollment.

`agentrun remote worker --state-dir /private/connector --foreground` owns the worker in a terminal. A persistent service is optional and must be explicitly installed by the source operator. `remote disconnect` or an owner request to `DELETE /v2/connectors/{connector_id}` prevents future work and stops the worker on its next poll. Loss of a command lease closes native execution; an interrupted dispatch is recorded as uncertain and never automatically replayed. The source worker makes outbound HTTPS requests only, with no public inbound listener.

Import here means an ordinary agent/revision referencing the selected source setup. Its configuration, skills, MCP, hooks and sign-in stay on that machine. Run prompts, results, tool activity, usage and an immutable standing-instruction snapshot are sent to the destination for the approved runs and learning. The server cannot select another source path, executable or environment through the worker protocol. The original source permissions remain authoritative.

### Import selected history

The remote CLI can import completed Claude Code or Codex sessions from another machine. First preview one exact project and runtime on the source; nothing is uploaded:

```sh
agentrun remote history-preview --project /absolute/project --runtime codex
```

Review the selected destination and candidate session counts. Export can skip oversized or unsettled content after this metadata preview. The destination owner must create a code through `POST /v2/connectors/enrollment` with `capabilities.history_import: true` and the chosen `capabilities.native_execution` flag, and the source operator must explicitly choose the matching flag:

```sh
# Historical records only; no executing worker or self-improvement.
agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime codex --history-only

# A live project connection plus its completed session history.
agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime codex --history
```

Use only the selected command. History-only needs no native sign-in or model call. It cannot become runnable without a new owner enrollment. Completed sessions are imported as ordinary historical run records with source provenance, without executing them or using them as learning. Recent sessions (last ten minutes) and child sessions are skipped. `agentrun remote import-history --state-dir /private/connector` imports newly eligible sessions for the same approved target; repeated uploads skip duplicates. This is an explicit import, not continuous transcript collection or attachment to a conversation in progress.

History is scoped to the selected project/runtime. Native logs cannot reliably attribute sessions to a named Claude agent or Codex profile, so history flags reject those selectors. Connect a named setup separately and use a project-level history-only connection when both are needed. Local-store import remains available for local Claude Code, Codex and pi histories; stop the owning server before importing directly into its store.

Connected agents use the ordinary agent, revision, skills and per-agent learning records. Their revision contains a reference to the native source, not a copied prompt or credential store. Normal definition edits retain that reference. The portable `agent.md` template manifest continues to compile into the same ordinary records; it rejects native machine references. The current template API does not export a connected source setup. Existing managed adapters retain their isolated configuration.

New jobs run in the original project and use native configuration resolution, model selection, MCP tools, hooks and sign-in. A named Claude agent is selected as the main session; a Codex profile is a profile, not a custom subagent. Each run records its exact session and resolved configuration fingerprint. Local reconnection updates the same agent; Verify refreshes metadata for an existing remote binding. Replacing a revoked remote connector requires a new grant and private state directory, and creates a new binding. Disconnect prevents future starts without changing the project or removing history.

Turn **Self-improving** On to supply active notes and skills and reflect after completed tasks. Reflection resumes the exact task session with tools disabled, then the existing structural checker and a separate grader decide what to promote atomically. The grader uses an immutable snapshot of the source's declared instruction files as policy evidence, and the actual original user messages. Native policy evidence has a separate 64 KiB UTF-8 limit; the existing managed grading limit is unchanged. Missing or oversized policy evidence prevents promotion and produces a terminal refusal, without sending an incomplete policy to the grader. The snapshot names the files it covers; recursively imported instruction files and native memory are not claimed as a complete reconstructed system prompt. An explicit server grading model route takes precedence; otherwise a separate native signed-in session grades in an AgentRun-owned directory. Reflection and grading add model usage; registration and sign-in verification do not.

Learned notes are additive context. Learned skills are supplied with files under an AgentRun-owned per-run directory, preserving relative resource paths and leaving native permissions in charge. AgentRun never overwrites `AGENTS.md`, `CLAUDE.md`, native settings, or native memory. A skill with the same name as an existing native skill is withheld. Learned workflows are unavailable in this release. Off means later runs neither load nor create AgentRun learning; saved learning remains available. Risky proposals wait for the owner's password-session approval. API tokens cannot approve them. Retire and restore in Learning revoke and restore items for future seeds while running jobs keep their pinned revision.

The bridge supports new jobs, native event history, supported usage counters, stop and cancel. Interactive approval handling and in-session steering are unavailable; a denied tool request is shown explicitly. No permission-bypass flags are added. Per-run effort overrides and uploaded attachments are unavailable: change the original native setup or source files. Native dollar limits cannot be enforced by AgentRun, so capped launches are refused. Unknown costs, token counters and model request counts remain unknown; native turns are not counted as model requests.

Jobs for the same source directory are serialized. An interrupted native dispatch is never blindly replayed because its side effects may have happened. After a runner or source-worker crash, inspect the source project and its task-owned lock named by the failure before removing a stale lock and starting a new job. Native sessions launched independently in a terminal or desktop app are outside this bridge.

## Run the live acceptance test

The opt-in script makes real model calls using the server's native sign-in. Start a loopback instance from this checkout, then run:

```sh
AGENTRUN_NATIVE_E2E=1 node scripts/native-learning-e2e.mjs \
  --url http://127.0.0.1:7340 --token-file /path/to/agentrun-data/.token \
  --runtime all --out /path/to/private-evidence
```

The script creates disposable projects with ordinary native instructions, connects each, enables learning, teaches a preference, waits for checked grading and promotion, and starts a fresh session that must use the exact promoted revision. It then turns learning Off and verifies a fresh control receives no AgentRun learning and no reflection. It checks source instruction and static native configuration hashes, exact distinct native session IDs, and records sanitized usage receipts. It does not write the taught rule into a project file. Claude’s own `.claude.json` bookkeeping can change during normal native CLI use and is excluded from the static-file hash comparison. `--claude-agent` and `--codex-profile` select existing named setups. Native global instructions and hooks still apply, so choose a compatible source setup. A grader rejection is a test failure, not a reason to bypass grading.

This proves accepted learning reaches a later run. It does not establish a general quality improvement; that requires independent outcome evaluations.

For remote acceptance, first connect disposable source projects with the actual CLI worker, preferably in a separate filesystem where their paths do not exist on the server. Supply a JSON file listing the selected fixture `agent_id` and `runtime` values:

```sh
AGENTRUN_REMOTE_E2E=1 node scripts/remote-learning-e2e.mjs \
  --url https://console.example.com --token-file /private/server-token \
  --agents /private/remote-fixtures.json --out /private/remote-evidence
```

This makes real model calls for each selected agent: teach a preference, wait for checked grading and promotion, verify a fresh remote session uses the exact accepted revision and answer format, then verify a fresh Off control receives no seed or reflection. Successful fixtures are left with learning On. The receipt records real run/session IDs, reported usage and live working visibility. Separately verify source configuration hashes, connector revocation, lost-lease behavior and that the source cannot call unrelated server APIs.
