# Connect existing Claude Code and Codex agents

Run AgentRun on the machine where the original CLI is installed and signed in. In **Connect existing agents**, select the source project, discover its setups, and connect the project default, a Claude Code named agent, or a Codex profile. Verify checks the CLI and native sign-in without a model call. It separately reports that model and tool execution remain untested.

The current bridge requires stable Claude Code 2.1.322 or later in major version 2, or Codex 0.167.2 or later in major version 0. Older, prerelease and other major versions show Needs attention until the bridge supports their protocol.

The public CLI provides the same handoff:

```sh
npx @parcha/agentrun native discover --project /absolute/project
npx @parcha/agentrun native connect --project /absolute/project --runtime claude-code
npx @parcha/agentrun native connect --project /absolute/project --runtime codex --profile review
```

Use `--agent NAME` for a discovered Claude named agent. Use `--data DIR` for another local instance, or `--url http://127.0.0.1:PORT`. Discovery runs metadata commands only. Connection needs the local server credential; it needs no model API key. A browser on a hosted instance cannot discover a laptop: hosted pairing and migration are deferred.

Connected agents use the ordinary agent, revision, skills and per-agent learning records. Their revision contains a reference to the native source, not a copied prompt or credential store. Normal definition edits retain that reference. The portable `agent.md` template manifest continues to compile into the same ordinary records; it rejects native machine references. The current template API does not export a connected source setup. Existing managed adapters retain their isolated configuration.

New jobs run in the original project and use native configuration resolution, model selection, MCP tools, hooks and sign-in. A named Claude agent is selected as the main session; a Codex profile is a profile, not a custom subagent. Each run records its exact session and resolved configuration fingerprint. Reconnecting updates the same agent. Disconnect prevents future starts without changing the project or removing history. Existing conversations can be imported separately; imports neither become live jobs nor enter this learning path.

Turn **Self-improving** On to supply active notes and skills and reflect after completed tasks. Reflection resumes the exact task session with tools disabled, then the existing structural checker and a separate grader decide what to promote atomically. The grader uses an immutable snapshot of the source's declared instruction files as policy evidence, and the actual original user messages. Native policy evidence has a separate 64 KiB UTF-8 limit; the existing managed grading limit is unchanged. Missing or oversized policy evidence prevents promotion and produces a terminal refusal, without sending an incomplete policy to the grader. The snapshot names the files it covers; recursively imported instruction files and native memory are not claimed as a complete reconstructed system prompt. An explicit server grading model route takes precedence; otherwise a separate native signed-in session grades in an AgentRun-owned directory. Reflection and grading add model usage; registration and sign-in verification do not.

Learned notes are additive context. Learned skills are supplied with files under an AgentRun-owned per-run directory, preserving relative resource paths and leaving native permissions in charge. AgentRun never overwrites `AGENTS.md`, `CLAUDE.md`, native settings, or native memory. A skill with the same name as an existing native skill is withheld. Learned workflows are unavailable in this release. Off means later runs neither load nor create AgentRun learning; saved learning remains available. Risky proposals wait for the owner's password-session approval. API tokens cannot approve them. Retire and restore in Learning revoke and restore items for future seeds while running jobs keep their pinned revision.

The bridge supports new jobs, native event history, supported usage counters, stop and cancel. Interactive approval handling and in-session steering are unavailable; a denied tool request is shown explicitly. No permission-bypass flags are added. Per-run effort overrides and uploaded attachments are unavailable: change the original native setup or source files. Native dollar limits cannot be enforced by AgentRun, so capped launches are refused. Unknown costs, token counters and model request counts remain unknown; native turns are not counted as model requests.

Jobs for the same source directory are serialized. An interrupted native dispatch is never blindly replayed because its side effects may have happened. After a runner crash, inspect the source project and the task-owned `native-locks` entry named by the failure before removing a stale lock and starting a new job. Native sessions launched independently in a terminal or desktop app are outside this bridge.

## Run the live acceptance test

The opt-in script makes real model calls using the server's native sign-in. Start a loopback instance from this checkout, then run:

```sh
AGENTRUN_NATIVE_E2E=1 node scripts/native-learning-e2e.mjs \
  --url http://127.0.0.1:7340 --token-file /path/to/agentrun-data/.token \
  --runtime all --out /path/to/private-evidence
```

The script creates disposable projects with ordinary native instructions, connects each, enables learning, teaches a preference, waits for checked grading and promotion, and starts a fresh session that must use the exact promoted revision. It then turns learning Off and verifies a fresh control receives no AgentRun learning and no reflection. It checks source instruction and static native configuration hashes, exact distinct native session IDs, and records sanitized usage receipts. It does not write the taught rule into a project file. Claude’s own `.claude.json` bookkeeping can change during normal native CLI use and is excluded from the static-file hash comparison. `--claude-agent` and `--codex-profile` select existing named setups. Native global instructions and hooks still apply, so choose a compatible source setup. A grader rejection is a test failure, not a reason to bypass grading.

This proves accepted learning reaches a later run. It does not establish a general quality improvement; that requires independent outcome evaluations.
