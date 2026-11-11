---
packages: @parcha/agentrun-serve, @parcha/pi-durable-disk
kind: fix
---
Security: on the runner, a claude-agent, codex or opencode run's CLI process now starts under `setpriv --no-new-privs`, as pi's commands do, so a setuid program or file capability that the CLI or a command it runs reaches grants nothing. It has been unconfined since the per-run process went. It uses pi's own rule (`noNewPrivsPrefix`, new in `@parcha/pi-durable-disk/internals`): Linux only, nothing on macOS, and on Linux a run is refused with pi's `SETPRIV_UNAVAILABLE` words where `/usr/bin/setpriv` (util-linux) is not usable.
- A separately started runner (`agentrun-serve runner`) no longer loads a faux module named in its environment. `AGENTRUN_SERVE_FAUX*` and `AGENTRUN_HARNESS_TABLE` left in an operator's shell or a platform's settings decided what a run answered. A runner now loads the faux model only from its own `--faux <module>`, as the server does. Test setups that gave a runner `AGENTRUN_SERVE_FAUX` pass `--faux` instead (`deploy/walk/compose.walk.yaml` does).
