# Example 02: a paid effect that is never sent twice

An agent charges six invoices through a paid API, one tool call each. While the third charge is in flight, host A is taken
away, and host B finishes the run. A fake paid API (`test/fixtures/paid-api.ts`) counts every charge it receives, so the demo can compare what the world
outside received with what the run's own store recorded:

- the three charges before the cut and the three after each reach the API exactly once;
- the charge that was in flight is **not sent again**: the run records it `interrupted`, and the API has it once, as a
  request whose client went away before the answer (`cut`).

Without a durable record of intent, a restart would repeat the cut charge. Here the intent was committed before the call
started, so the new host knows the call may have gone out and tells the model so instead of calling again.

Two ways to lose a host:

| Scenario | What happens to host A | How host B learns |
|---|---|---|
| `kill` | its instance and its FUSE daemon are SIGKILLed at once, as a power cut does | Archil flags the dead client's claim orphaned within a second |
| `freeze` | its FUSE daemon is SIGSTOPped: the mount hangs while the host looks alive | the lease runs out (10 s in the demo, 90 s by default) |

## Run it

You need the Quickstart's setup from the [top-level README](../../README.md#quickstart-on-a-linux-host-kill-a-host-watch-the-run-resume-on-another)
(the root-owned wrapper and the two mount roots, once per machine), a scratch disk and its API key. No model key: the model is
pi-ai's faux provider.

```sh
(cd ../.. && npm ci --ignore-scripts && npm run build)   # once, from the repository root; builds dist/
export ARCHIL_API_KEY=...  ARCHIL_DISK=dsk-...  ARCHIL_REGION=aws-us-east-1
node examples/02-paid-effect/demo.ts kill      # about 15 seconds
node examples/02-paid-effect/demo.ts freeze    # about 25 seconds (it waits for the lease)
```

The demo creates `runs/paid-<random>/` on the disk, removes it and the run's token users when it ends (`--keep` leaves the
directory), and prints every command it runs. `node examples/02-paid-effect/demo.ts --help` lists the options (mount roots,
the wrapper path, `--id`, `--api-key-env`).

### With Docker (macOS or Linux, no root)

`examples/docker-quickstart.sh` does everything below: it builds the image and runs `kill`. By hand, from
`packages/pi-durable-disk` after the workspace's `npm ci --ignore-scripts` at the repository root:

```sh
rm -f docker/package/*.tgz && npm run build && npm pack --pack-destination docker/package
docker build -f docker/Dockerfile -t pi-durable-disk:local .
node examples/02-paid-effect/demo.ts kill   --host docker    # about 17 seconds
node examples/02-paid-effect/demo.ts freeze --host docker    # about 27 seconds
```

Each instance is a container (`pda-demo-<run>-<disk key>-g<attempt>`), and the paid API listens on this machine where the
containers reach it as `host.docker.internal`. `kill` is `docker kill`. `freeze` is `docker pause`: host B's supervisor
talks to the same Docker daemon, so once the lease expires it stops the paused container (STONITH; `docker stop` thaws the
container to deliver SIGTERM, and the instance drains) before it revokes the claim. With two daemons, the frozen host
would instead exit 75 when thawed, as `freeze` without Docker shows.

## What you should see

`kill`, trimmed (the demo prefixes every line with a time):

```
the third charge is in flight. Host A loses power: its instance and its FUSE daemon are killed at once
  fault    kill: sudo kill -s SIGKILL 391686 391978   (the processes of the unit and its FUSE scope)

host B: a supervisor on another machine sees the dead client, revokes the claim and starts an instance
  agent    generation 1: dispatching invoice 3
  paid API charge #3 received (key charge-3), held: no answer yet
  supervise started pda-demo-b-paid-m3p9ze-muybewea7x on host-b (orphaned, revoked 1 delegation)
  agent    generation 2 opened on host-b as uid 1000
  agent    generation 2: dispatching invoice 4
  agent    generation 2: invoice 4 charged (API call #4)
  paid API charge #4 received (key charge-4)
  agent    generation 2: dispatching invoice 5
  agent    generation 2: invoice 5 charged (API call #5)
  paid API charge #5 received (key charge-5)
  agent    generation 2: dispatching invoice 6
  agent    generation 2: invoice 6 charged (API call #6)
  paid API charge #6 received (key charge-6)
  supervise run is done

what the paid API received, against what the run recorded
    invoice  key         run's record   what the API saw
    1        charge-1    charged        #1 answered (host-a generation 1)
    2        charge-2    charged        #2 answered (host-a generation 1)
    3        charge-3    interrupted    #3 cut (host-a generation 1)
    4        charge-4    charged        #4 answered (host-b generation 2)
    5        charge-5    charged        #5 answered (host-b generation 2)
    6        charge-6    charged        #6 answered (host-b generation 2)

    API calls: 6 (a clean run sends 6); charges the run recorded as interrupted: 1

at most once held: no charge was received twice, and the one cut in flight was reported interrupted, not sent again
```

In `freeze`, host B's takeover is `(lease-expired, revoked 1 delegation)` about 11 seconds after the freeze, and host A's
instance is reported `exited with status 75` once its mount is thawed (it may already have fenced itself on its lease, which
is why the API sees charge 3 as `cut` in both scenarios).

## What the demo does, by hand

Every command below is printed by the demo as it runs, with the API key shown as `…`. The two supervisors are the same
`pi-durable-disk supervise` you would run as a service on each host.

1. A paid API on a local port that holds its third call open: `node test/fixtures/paid-api.ts --port 7071`, then
   `curl -X POST localhost:7071/_hold -d '{"route":"charge","key":"charge-3"}'` (the demo does the same in process).
2. **Host A**, the supervisor creates the run directory and starts an instance as a systemd unit, with no restarter, like a VM
   that is gone for good:

   ```sh
   ARCHIL_API_KEY=… node dist/cli.js supervise --disk $ARCHIL_DISK --region $ARCHIL_REGION --id $RUN \
       --mount-root /mnt/archil-a --host-name host-a --unit-prefix pda-demo-a- --no-restart --create \
       --lease-expiry 10s --run-arg=--heartbeat-ms=2000 --run-arg=--lease-expiry-ms=10000 --run-arg=--lease-margin-ms=3000 \
       --env PAID_API=http://127.0.0.1:$PORT --app $PWD/examples/02-paid-effect/app.ts
   ```

   The unit runs `pi-durable-disk run --app .../app.ts`: the instance mounts `runs/$RUN` at `/mnt/archil-a/runs/$RUN`,
   opens the store and runs the app's `onOpen`.
3. When the paid API has received the third charge, host A is taken away:

   ```sh
   sudo systemctl kill --signal=SIGKILL <unit>.service '<unit>-fuse-*.scope'      # kill
   sudo systemctl kill --signal=SIGSTOP '<unit>-fuse-*.scope'                     # freeze
   ```

4. **Host B** runs the same `supervise` with `--mount-root /mnt/archil-b --host-name host-b --every 2s`. Its first pass
   that finds the claim orphaned (kill) or the lease expired (freeze) revokes host A's delegation through the control API and
   starts an instance. The new instance mounts the same directory, opens the store, and pi-durable resumes: the cut call is
   `interrupted`, the model is told, the run goes on with invoice 4.
5. (`freeze` only) host A's FUSE daemon is thawed (`SIGCONT`). The old instance wakes up to a revoked claim: its next
   write is refused and it exits 75. (It may already have exited 75 on its own lease before the thaw.)
6. The demo reads the paid API's ledger and the run's recorded outcomes and checks the invariants: no key received twice,
   every `charged` invoice received once, the cut one `interrupted` and received at most once.

## The files

- `app.ts`: the app module `--app` loads. A `charge` tool (an effect: no `replay: "safe"`), a faux model that charges
  `Charge invoice k` once and never retries, and an `onOpen` that submits the six invoices with a `requestId` each, so a
  resumed run sends only what is missing.
- `../../test/fixtures/paid-api.ts`: the fake paid API (it never deduplicates; a re-sent effect would show as a second request
  for the same key). Also runnable alone; `GET /_counts?route=charge` shows what it has received.
- `demo.ts`: the orchestration, and `../lib/demo.ts` (shared with example 01): the supervisors as child processes, the
  fault injection, the cleanup.

## Notes

- The charge's idempotency key is pi's tool call id, which is stable across incarnations. A real paid API should receive it
  as an idempotency key. If your model decides to retry an `interrupted` charge, that is a new call with a new id: the runtime
  guarantees it does not start an effect twice, not that your model never asks twice.
- To use a real model, replace the faux provider in `app.ts` with your provider (see the top-level README's "The app").
