---
packages: @parcha/agentrun-serve
kind: feature
---
serve reads the box settings at start, and `GET /v2/capabilities` says where runs' harness tools would run, as a serve extension, `box` (`x-agentrun-serve: box/1`).
- The settings: `AGENTRUN_BOX` (`local` by default, `unsandboxed`, `daytona` or `modal`), `AGENTRUN_BOX_CGROUP` (a shared server's delegated cgroup v2 subtree) and `AGENTRUN_BOX_EGRESS` (`open`). A value serve does not know stops the start, naming the setting.
- `box.mode` is what the box's probe proved: `bwrap`, `seatbelt`, `provider` or `unsandboxed`. A missing box or a failed probe reads as `unavailable` with a stable `error` code (`bwrap_missing`, `bwrap_setuid`, `bwrap_userns_denied`, `box_probe_failed`, `box_refused`, `box_start_failed`) and a `detail` a person can act on. `error` and `detail` appear only then, in fixed words; the cause itself (the probe's own message, or why the box could not be made) goes to the server's log. Native tools stay off on every harness.
- `AGENTRUN_BOX=unsandboxed` is the only way to run without a box, and it is loud: a banner at start, a line at the start of each run's log, and the mode in each run's record (`serve.json`'s `box`) and in capabilities.
- With `AGENTRUN_BOX_CGROUP` set to a subtree not delegated to serve's user, serve refuses to start. Unset, serve is single-user (`box.cgroup: false`).
- A run that started in a box never continues unsandboxed. Opened again unsandboxed, it ends `box_downgrade`, even a run that was waiting for the person. With no box at all here, it is held until a server that has one opens it.
- A run's `serve.json` is written whole. Each write goes through its own temporary file, so two writes at once never collide.
