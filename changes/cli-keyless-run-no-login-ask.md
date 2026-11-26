---
packages: @parcha/agentrun-serve
kind: fix
---
A CLI harness run that sends no model key (one on a `--faux` start, or one pinned to the faux model) no longer reads the Claude login setting at its claim, nor asks its runner for the login when it runs in a process of its own. Before, only a held run skipped that read. The earlier notes for held and keyless runs said a held Cursor run's key is "never decrypted" and that such runs open no saved model key: the claim still decrypts every sealed secret into the run's redactors, to scrub it from the run's output, but it never reads one for the run or lays it on the run.
