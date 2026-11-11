---
packages: @parcha/agentrun-serve
kind: feature
---
A learning run whose only tool work was its learned workflows, each answering, with nothing said after its first message (no follow-up, no approval, no tool error or refused call), is no longer asked its end-of-run turn: no model request is sent and looking back costs $0. Its learning ends `dropped` with reason `empty` and the words "Nothing new: the run only ran a learned workflow." Any other tool, a follow-up, or a learned workflow that fails is asked as before. On every harness the runner runs (pi, and a CLI harness's `learned_workflow` by its own name or claude-agent's `mcp__hands__` alias).
Upgrading: nothing to do; a client that reads a run's learning sees reason `empty` for these runs, with its `detail` saying why.
