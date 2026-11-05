---
packages: @parcha/agentrun-serve
kind: feature
---
**Under `bash: ask`, only the background calls that start or feed a process ask: `bash_output`, `bash_list` and `bash_signal` run unasked**
- With `bash` set to `ask`, `bash_background` and `bash_input` (and `bash`) still park the run for the owner's approval, each under its own name. `bash_output`, `bash_list` and `bash_signal` now run without asking, so watching one approved process no longer costs an approval per page. They reach only the processes the run itself started, by its own ids: another run's id, or one never started, is answered "there is no background process <id> in this run".
- `bash: deny` still refuses all five, and `bash: allow` runs them. None is a settings key of its own, so no setting of one lifts `bash`'s.
- `capabilities.tools` and `GET /v2/agents/{id}`'s `tools` show the split: under `bash: ask`, the three watchers read `allow`, with `permission_from` where `bash`'s setting came from.
- On a server with accounts off, the three watchers run under `bash: ask`, where an asked call is refused.
