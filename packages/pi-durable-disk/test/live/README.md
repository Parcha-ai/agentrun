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
`rm -f docker/package/*.tgz && npm pack --pack-destination docker/package && docker build -f docker/Dockerfile -t pi-durable-disk:local .`
(`PDA_DOCKER_IMAGE` names another image). Its containers are labeled `pda.fleet=$PDA_DOCKER_FLEET` (default `live`) and
named `pda-<fleet>-...`, its run directories `runs/<fleet>-...`; the suite removes only those.

## The daily job

`.github/workflows/pi-durable-disk-live.yml` runs these suites once a day and on demand (Actions, "pi-durable-disk live",
"Run workflow"). It never runs for a pull request or in a fork, and one run at a time holds the disk. Its steps are
`test/live/ci.ts`:

- `preflight` refuses to start without the secrets below. Without the key, every suite would skip and the job would pass
  having checked nothing.
- `suites claim env run store supervise lifecycle` runs each suite in turn under a 25-minute deadline (one that hangs is
  killed with its processes and the next one runs), recording each start and end in `$PDA_STATE_DIR/suites.jsonl`.
- `sweep` (always) removes the run directories (`runs/<name>/` only) and token users that the run's ledgers recorded
  and never stamped as removed: what a suite cut by its deadline or the step's timeout left on the disk. It fails if
  anything is left.
- `summary` (always) writes each suite's result and time and the suites' timing measurements to the job summary. It
  reads only numbers from the results files: no disk id, host or identifier.

A second job runs `suites docker` (the Docker driver, then parking) after the first, on its own runner. Until it has
passed on GitHub's runners, it reports without failing the run.

The repository secrets it needs:

| Secret | What |
|---|---|
| `ARCHIL_API_KEY` | An API key of the Archil account that owns the scratch disk. The suites use it to read the disk, add and remove token users on it, list, write and delete its objects, and revoke delegations on it. |
| `ARCHIL_SCRATCH_DISK` | The scratch disk's id (`dsk-...`): a disk that holds nothing you want to keep. |
| `ARCHIL_SCRATCH_REGION` | The disk's region, such as `aws-us-east-1` (the default when unset). The fence tests' timing wants a region near GitHub's runners. |
