# serve-and-park: an idle agent holds no process

An instance serves `POST /submit`. The agent's model is overloaded, and pi retries after a long wait. A run that only waits
parks: the instance writes `sleeping` and the wake time into `run.json`, releases the run and exits 0. Nothing runs, and
nothing is billed, until the wake time, when a small restart loop opens the run again and the retry finishes. A submit
with the same `requestId` after the restart is answered with the first submission and its answer, not run a second time.

It shows that a durable agent does not need a process while it waits, and that the `requestId` makes a client's retry safe
across a park and a restart.

## Run it

From an install of the package instead of a checkout: this needs `@parcha/pi-durable-disk` 0.1.0-beta.13 or later (`localRun` and `beforeResume` first shipped in it); [Run one from an install](../README.md#run-one-from-an-install).

From a checkout, after the root `npm ci --ignore-scripts && npm run build`, on Linux with Node 22.19 or later (no disk,
no key, no network):

```sh
cd packages/pi-durable-disk
node examples/serve-and-park/main.ts       # about 8 seconds, 3 of them parked
```

It writes `serve-and-park-run/` under the current directory and prints:

```
generation 1 serves http://127.0.0.1:41593
submitted order-1: submission 8 is placed
model request (generation 1)
generation 1 parked until 2026-10-14T19:12:22.058Z, released, exiting
no process holds the run for 2939 ms, until 2026-10-14T19:12:22.058Z
generation 2 serves http://127.0.0.1:44097
model request (generation 2)
submitted order-1 again: submission 8 is done, answered "recovered, answered once" by generation 2
ok: an idle run holds no process: it parked on a long retry, a restart at its wakeAt finished it, and a repeated requestId was answered, not run again
```

## How it works

- The example is its own supervisor. `main.ts` starts `main.ts instance` children on one run directory, reads their lines,
  and waits for `close`. Each instance is `localRun` plus `serveRun`: the server listens first (503 `OPENING` until the
  run is attached) and `server.attach(run)` serves the Harness.
- The model is pi-ai's faux provider. Generation 1's model answers every request with an overloaded error, which pi
  retries after `RETRY_MS` (3 s); generation 2's answers. That is the only thing standing in for a provider's outage.
- Parking is `watchParking(run, { thresholdMs, keepAwake, quiesce })`. After every commit it asks pi what the run is
  doing. Work that only waits longer than the threshold is a park: new submissions get 503 `PARKING`, the wake (the
  retry's deadline) is written to `run.json` as `sleeping` with `wakeAt`, then the run is released and the instance exits.
  An open request (`server.active`) keeps the instance up.
- The restart loop is a `setTimeout` to `wakeAt` and another `start()`. A real host does this with the supervisor
  (`ensureRunning`) or a scheduler; the run's record is the only thing it reads. The new instance opens the run as
  generation 2, pi resumes the retry, and the model answers.
- The duplicate submit goes to generation 2 with the same `requestId` and `wait: true`. pi keeps the request id in the
  run's store, so it returns submission 8, already done by the retry, and the model is asked no more: the example counts
  the requests of both generations (one each).
- The example checks the record at the park (`sleeping`, a future `wakeAt`, the store sealed, the last holder's process
  gone), the answer, the submission id, the request count, and `done` at the end; it prints `not ok: ...` and exits 1
  otherwise. Without a park (a threshold above the wait) or with a new `requestId`, it fails.

## What it does not show

A run on a local directory has no fence and guards one machine only. `run.json` keeps the last holder after a release, so
it is a record of who held the run, not a lock; the release is what frees the claim. The restart loop here is the
example's own: it is not the supervisor, which also takes over runs whose holder died. The overload is scripted, so it
says nothing about a real provider's retry timing.
