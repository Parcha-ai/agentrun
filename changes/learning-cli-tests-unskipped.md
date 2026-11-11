---
packages: @parcha/agentrun-serve
kind: ci
---
Most of the learning tests that were skipped for the CLI harnesses run again. A test's harness table now reaches the in-process runner with or without the faux model, so a CLI run on a gateway runs on the test's harness, never on an installed CLI. These now pass: learned_workflow on claude-agent and codex, the gateway route on codex and opencode, both capped-codex cases, the side-call and claude-agent proxy cases, the real-adapter ask-and-allow cases, and the usage meter. Their checks of root entries the old per-run process wrote now read the runner's request records. Four cases that can't run on the in-process runner are gone, each still covered elsewhere:
- a learned call set to ask on the faux CLI harness, which asks no gate: covered by learned-route-real's real-adapter ask-and-allow cases on claude-agent and codex;
- a call cut off with its process, which would kill the test's own process: covered by the kernel's runner tests (a request a crash cut off is booked once, cut) and learned_workflow's never-replay case;
- claude-agent on OpenRouter alone, which needs a preload in a separate run process: covered by openrouter-route's or-1 and the kernel's side-key test;
- a call beside learned_workflow staying on its answer, which read the old root entries: covered by the kernel's side-key test (a side request is never the turn's answer).
Three sites in learn-workflow-run stay skipped, under reasons of their own: the two claude-agent native-search cases (:369, :383) wait on #2458, and the allow-before-the-parked-result race (:430, on codex and claude-agent) waits for the faux harness to ask the gate. learned-route's R2 and R3 no longer check the network guard: its preload can't reach an in-process runner, so those checks proved nothing.
Upgrading: nothing to do.
