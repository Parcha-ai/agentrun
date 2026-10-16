Live suites: they mount a real Archil scratch disk. Without `PDA_LIVE=1` they skip.

```sh
export PDA_LIVE=1
export ARCHIL_API_KEY=...                # an Archil API key for the account that owns the scratch disk
export PDA_LIVE_DISK=dsk-...            # the scratch disk (never a disk with data you want to keep)
export PDA_LIVE_REGION=aws-us-east-1    # its region (default aws-us-east-1)
npm run test:live                       # all of them, or one: test:live:claim | env | lifecycle | run | store | supervise
npm run test:live:docker                # the docker host driver (T13); needs Docker and the image, see below
```

The key may come from anything that puts `ARCHIL_API_KEY` in the environment of the command (a secrets manager's run wrapper,
`env`, an exported variable). A suite exits with an error, and does not
skip, when `PDA_LIVE=1` is set without `PDA_LIVE_DISK`.

What they need: a Linux host with FUSE, the `archil` client (0.8.40 or later), passwordless `sudo` (the client needs root),
systemd (the supervise suite starts units), and a host near the disk's region (the latency assertions are loose, the
timing of the fence tests is not).

What they do: each suite uses `runs/<suite>-<id>/` on the scratch disk and mount points under `/mnt/pda/<suite>/`, mints
its own token users, records every token user, directory, mount and unit it creates in a ledger as it makes it, and removes
all of it in `after`, also on failure. Ledgers (and the results JSON next to them) go to `$PDA_STATE_DIR`, or to a fresh
temporary directory per run when it is unset (its path is printed on stderr); `PDA_P1_STATE` .. `PDA_P5_STATE` and `PDA_P8_STATE` (lifecycle) name one
suite's ledger file.

The mount roots are fixed (`/mnt/pda/p1` .. `/mnt/pda/p5`, and `/mnt/pda/p8` for lifecycle) and a suite's cleanup unmounts everything under its root, so
never run two live runs at once on one host; take a lock (`flock /tmp/pda-live.lock npm run test:live:supervise`). No token is
ever printed: it travels on the archil wrapper's stdin and is scrubbed from captured output.

The Daytona suite (`daytona.live.test.ts`, `_p9.ts`) ships this directory (without `node_modules`) into each box and installs
it there: on `daytona-medium`, `prepareBox` installs Node, the archil client and the package's dependencies at boot (`npm
install`, since this directory has no lockfile of its own in the workspace), about 16 s per box. `examples/verify-production-path.sh`
copies this directory and runs `npm ci` in it, so it needs a standalone checkout's lockfile.

The runtime snapshot makes a box ready in about 2 s instead. `daytona-snapshot.ts build <commit>` builds
`pda-p9-runtime-<commit>-<stamp>` on Daytona from `snapshotDockerfile(commit)`: `daytona-medium`'s image
(`daytonaio/sandbox:0.9.0`, the same toolbox user and resources) with the same pinned Node and archil, the run user, the
wrapper, the sudoers drop-in, the mount root and the package's dependencies, installed from its `package.json` at `commit`
(no build context; about 45 s). A daytonaHost start then takes `snapshot: <name>` and `prepare: (box) =>
prepareOnSnapshot(client, box)`: the checkout's package source replaces the snapshot's, over its `node_modules`, and `npm
install` runs only when the dependency fields differ from the ones the snapshot was built for. `check <name>` boots one box from
it, prepares it and imports the package as the run user; `baseline` does the same on `daytona-medium`; `delete <name>` removes
a snapshot this lane built. A snapshot is built once under a new name and never over an existing one (a default or another
lane's). Its storage is billed while it exists, so delete it once its takes are done.

The docker suite (`test:live:docker`, also run by `test:live` when `PDA_LIVE_DOCKER=1`) runs the instances in containers of
the package's image on this machine's Docker daemon; nothing on the host mounts. `docker.live.test.ts` is T13 for
`dockerHost`; `docker-park.live.test.ts` parks a run in a container under `supervise --host docker` and checks that the
exited container stays exited until the supervisor starts the next one at the wake (about 3 minutes). Build the image from
this directory first:
`rm -f docker/package/*.tgz && npm pack --pack-destination docker/package && docker build -f docker/Dockerfile -t pi-durable-disk:local .`
(`PDA_DOCKER_IMAGE` names another image). Its containers are labeled `pda.fleet=$PDA_DOCKER_FLEET` (default `live`) and
named `pda-<fleet>-...`, its run directories `runs/<fleet>-...`; the suite removes only those.

## The live disk check

The ship skill runs these suites whenever a pull request touches `packages/pi-durable-disk/src`, `bin`, `package.json` or
`test/live`. It is one command, from the repository root, under your credential wrapper:

```sh
npm run build && node packages/pi-durable-disk/test/live/ci.ts all          # the default, about 18 minutes
npm run build && node packages/pi-durable-disk/test/live/ci.ts all --slow   # with supervise-slow, about 35 minutes
```

The skill runs `all --slow` when the diff touches `packages/pi-durable-disk/src/claim.ts`, `src/supervise.ts`,
`src/hosts/**` or `test/live/**`, and `all` otherwise. `supervise-slow` (`supervise-slow.live.test.ts`) holds the three
tests that wait out a fixed window, the archil client's 5-minute token refresh twice and five minutes of backoff, so it takes
about 17 minutes at any load. They are a file of their own, with their own script, so the tier is a file, not a list of
test names. `ci.ts all --list` (with or without `--slow`) prints the suites and their commands and runs nothing.

The wrapper exports `ARCHIL_API_KEY` (a key of a **scratch** Archil organisation), `PDA_LIVE_DISK` (a **scratch** disk in
that organisation, `dsk-...`) and `PDA_LIVE_REGION` (its region; `aws-us-east-1` when unset). Never a production key or
disk: the suites create and delete run directories and token users on whatever disk they are given. No value is printed.

`all` runs, in order:

1. `preflight`: refuses to start without the key and a disk id. Without the key every suite skips, and a check would pass
   having checked nothing.
2. The host suites, `claim env run store supervise lifecycle` (with `supervise-slow` after `supervise` under `--slow`),
   each under a 25-minute deadline: one that hangs is killed with its processes and the next one runs.
3. The Docker suites, after the host suites so the two never share the disk. They build the package's image from this
   checkout first (`pi-durable-disk:live-check`) and have a 60-minute deadline.
4. The sweep, always (after a failure, a failed preflight or an interrupt): it removes what this run's ledgers recorded and
   never stamped as removed, which is what a suite killed at its deadline leaves (its `after` never ran). On the host first:
   systemd units and Docker containers named `pda-*`, then mounts under `/mnt/pda/`. Then on the disk: run directories
   (`runs/<name>/` only, through the package's own run-tree delete, which revokes the run's delegations first) and token
   users. Anything a ledger lists outside those names is reported and left alone.
5. The summary: each suite's result and time and the suites' timing measurements, as Markdown. Only numbers leave the
   results files: no disk id, host or identifier.

Its last line on stdout is `ok: live disk check passed (7 suites, sweep left 0)` (under `--slow`,
`ok: live disk check passed (8 suites incl. slow, sweep left 0)`) or `not ok: <first failing step>: <reason>`, and it exits
0 only with an `ok:` line: preflight passed, every suite passed, and the sweep left no run directory, token user, unit, container or mount. A first `SIGINT` or `SIGTERM` stops the running suite and goes on to the
sweep; a second exits at once. It holds `/tmp/pda-live.lock` (as `flock` does) for the whole run and refuses to start
while another live run on the host holds it. The ledgers and results go to `$PDA_STATE_DIR` (made absolute), or a fresh
temporary directory whose path it prints first.

The steps also run on their own: `ci.ts preflight`, `ci.ts suites <name>...`, `ci.ts sweep` (with `PDA_STATE_DIR` naming
a run's ledgers) and `ci.ts summary`.
