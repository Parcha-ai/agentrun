# Kill it anywhere

`npm run demo:kill` runs the reference job on the no-key host and ends it with SIGKILL at a seeded random point, ten
times. A fresh process resumes the same directory after each kill. When the run completes, the ledger counts what the job
did from the store's committed entries, the receipt files, `events.jsonl`, `ledger.jsonl` (one row per fake call, appended
by every process) and the fake browser backend's own ledger. It prints the seed; the same seed gives the same kills.

```sh
npm run demo:kill                    # a new seed each time
npm run demo:kill -- --seed 7        # the same ten kills again
npm run demo:kill -- --kills 5 --json
```

It exits 1 if any check fails. The test is `examples/reference-kill.test.mjs`.

## Where a kill lands

A kill lands at a crossing: a named point just before or after a step the job takes.

- In the job's process, which ends itself at its Nth crossing: each model request and answer, a tool's dispatch and return,
  the judge's ask and answer, a receipt's filing and filed, each status row the run reports (browser sessions, workflow
  events, the vision look), and the delivery. A clean run takes 34.
- In the supervisor, which owns the fake browser on loopback and holds each call the job makes to it between the call
  being applied and its answer leaving. The call is counted, and the job never learns the result.

Where the Nth crossing falls is a fact of the run, not of its timing. Each kill's window shrinks with the work left, so ten
kills spread over the run; a plan the process never reaches is drawn again, so ten kills landed.

## What the ledger claims

- **A paid effect (the search) is made exactly once.** A kill between its dispatch and its commit is not drawn: the driver
  admitted the effect, so the next process finds it admitted and never completed, stops the run on `FROZEN_EFFECT_UNKNOWN`
  (the run's result reads "Reconcile step:/root/steps/0#call:0 before resuming; it will not be repeated"), and never makes
  the call again. That is by design, so the call is never made twice. A host with a reconcile resumes there
  instead. The test cuts that window on purpose and holds the run to the stop.
- **The browser's page action (`page.run`) is made at most once.** An action whose outcome is unknown is never repeated. A
  kill while the tool runs leaves it unmade and the model gets an errored result. The reference job's scripted model ignores
  that result, so the record equalling the uninterrupted run's does not prove the action happened; the ledger prints
  `page.run x0` and the kill behind it.
- **`page.read` may repeat, each repeat tied to its kill.** A read applied before its result was committed is read again;
  its receipt is named by its content, so it is filed once.
- **A model turn or the judge is asked again only after a kill landed inside it**, in a later process, once per such kill.
  Every committed model turn appears exactly once, in order. A committed duplicate fails the run.
- **The browser session is created once and released once**, and the delivered record equals the uninterrupted run's.

## A slow seed

A kill that lands before the browser's session create is answered leaves a session whose creation is unknown. The browser
releases it only after its create deadline (60 s by default, `createDeadlineMs`), and the run waits for that release before it
closes, so a seed with such a kill takes about a minute longer.
