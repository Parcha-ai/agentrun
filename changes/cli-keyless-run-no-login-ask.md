---
packages: @parcha/agentrun-serve
kind: fix
---
A CLI harness run that sends no model key (one on a `--faux` start, or one pinned to the faux model) no longer reads the Claude login setting at its claim, nor asks its runner for the login when it runs in a process of its own. Before, only a held run skipped that read.
