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

The Daytona suite (`daytona.live.test.ts`, `_p9.ts`) and `examples/verify-production-path.sh` install the package the way a
standalone checkout allows: they copy this directory and run `npm ci` in it. In the agentrun workspace the dependencies are
hoisted to the repository root and this directory has no lockfile of its own, so both need an install step of their own
before they can run from here. They have not been run from the workspace.

The docker suite (`test:live:docker`, also run by `test:live` when `PDA_LIVE_DOCKER=1`) runs the instances in containers of
the package's image on this machine's Docker daemon; nothing on the host mounts. `docker.live.test.ts` is T13 for
`dockerHost`; `docker-park.live.test.ts` parks a run in a container under `supervise --host docker` and checks that the
exited container stays exited until the supervisor starts the next one at the wake (about 3 minutes). Build the image from
this directory first:
`rm -f docker/package/*.tgz && npm pack --pack-destination docker/package && docker build -f docker/Dockerfile -t pi-durable-archil:local .`
(`PDA_DOCKER_IMAGE` names another image). Its containers are labeled `pda.fleet=$PDA_DOCKER_FLEET` (default `live`) and
named `pda-<fleet>-...`, its run directories `runs/<fleet>-...`; the suite removes only those.
