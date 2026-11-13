---
packages: @parcha/agentrun-serve
kind: fix
---
On Postgres, a command written while another command of the same run was still being written could be skipped by the runner holding the run: the two rows could commit out of id order, and the runner, which reads the rows past the last id it handed on, never saw the lower one (not at the next command poll either, so it waited for the run's next claim). Every write of a run's command row (a command, a trigger's message, a reopen) now takes a per-run lock first, so a run's rows commit in id order, as they do on SQLite.
