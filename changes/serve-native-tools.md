---
packages: @parcha/agentrun-serve
kind: feature
---
serve can give a run its harness's own tools (its shell and file tools) only in a box that the run's own process builds for that run alone, and that can never see the server's data root. They stay off for every harness for now: a boxed claude-agent run can't resume a restored session yet.
- `agentrun-serve` probes the host's box at start (`AGENTRUN_BOX=local`, bubblewrap). `capabilities.harnesses[].native_tools` stays false for every harness, in a box too: claude-agent's wait for a boxed resume (`BOXED_CLAUDE_RESUME` in native-tools.ts), and when that switch turns on, it is true for claude-agent only when the probe passed. Codex's adapter takes no option to turn on its own tools yet. pi's tools are pi's own. With no box, an unavailable one, or `AGENTRUN_BOX=unsandboxed`, native tools stay off. macOS has no box yet (no Seatbelt box exists), so a Mac install gets no native tools.
- serve hands each run's process its box settings in `AGENTRUN_RUN_BOX`: its data root, what the probe proved and the shared server's cgroup subtree. That is a plain, non-secret variable, never the secrets pipe. The run's process builds the kernel's box from them, once.
- The box's hidden list is the data root (the server's tokens and store, and every other run), plus the run's own `store/` and `process.log`, plus `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set. A box binds nothing under them but its run's harness directory, so it can neither read nor write the run's journal, log, `box.json` or `serve.json`.
- The box is refused by name, and the run gets no box, when the settings name no data root, or when the run's directory, resolved, is not under the data root it was handed.
- A run started before its workspace moved to `harness/work` keeps its harness's own tools off.
- The boxes runs leave are swept by the reap of the box the server made.
