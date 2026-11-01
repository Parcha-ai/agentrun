---
packages: @parcha/pi-durable-disk
kind: feature
---
`boxHost({ provider, spec, app, ... })`, on the new entry `@parcha/pi-durable-disk/box`, is a host driver that runs a run on a plain directory inside a box of any pi-transport provider: pi-transport's launcher keeps `pi-durable-disk run --dir /run/agentrun/run --id <run> --app <app> --serve 0` (its door on the box's own loopback) and the caller's `runArgs` running there, restarting it on failure. Nothing mounts: no disk, no mount token, no FUSE, so it is never `ensureRunning`'s driver. `BOX_RUN_DIR` names the directory.
- The box is the caller's `spec` (an object, or a function of `{ run, attempt }`), created as given with two labels added, `pi-durable-disk.run` and `pi-durable-disk.attempt`. boxHost adds no environment to it.
- Secrets (`secrets`, by name) ride the launch frame only and reach the instance on fd 3, never an environment, an argv, a label or a file. Only a start with secrets needs a box whose facts say `secretsVia: "fd"`; one without runs on any provider.
- One live box per run: a start destroys every older attempt's box before it makes or adopts its own, and makes nothing while a newer attempt's box is there (`SUPERSEDED`). A running launch of the same attempt is adopted after a host restart; one that ended or was lost is replaced in a new box.
- `status` maps the launch's phases to `running`, `stopped`, `failed`, `gone` or `unknown`; `stop` drains through the launcher, then destroys the box; `kill` destroys it at once. Errors are `BoxHostError`.
- Packaging: `@parcha/pi-transport` is an optional peer, needed by `./box` only; the root entry does not load it.
