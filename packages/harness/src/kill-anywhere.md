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

- **A paid effect (the search) is made exactly once, wherever the kill lands after the host has kept its answer.** The host
  keeps the tool's answer before the driver commits it, so a process killed between the two is answered from that record on
  resume and the call is not sent again. A kill before the host kept the answer (the tool dispatched, or returned and not
  yet recorded) leaves nothing to reconcile from: the next process refuses the run with `FROZEN_EFFECT_UNKNOWN` ("Reconcile
  step:/root/steps/0#call:0 before resuming; it will not be repeated") and never makes the call again. That is the case of a
  host with no reconcile, and the test cuts it on purpose; the random draw does not.
- **The browser's page action (`page.run`) is applied at most once, counted from the fake provider's own applied record.**
  A kill while the tool runs leaves it unmade, or made with its answer lost, and the resume commits an interrupted, errored
  result. The lead then takes a snapshot and does not ask again blind: its record cites the filing scan alone and says the
  page's outcome is unknown, so the committed turns read `run, snapshot, ...` and the record differs from the uninterrupted
  run's by design. The ledger accepts that reduced record, or the full one with `page.run` present, and never the full
  record without the action. A run applied twice fails the run, with each application listed (`pageRuns`: process, pid,
  applied, answered, input).
- **`page.read` may repeat, each repeat tied to its kill.** A read applied before its result was committed is read again;
  its receipt is named by its content, so it is filed once.
- **A model turn is asked again only after a kill landed inside it**, in a later process, once per such kill. The judge's
  answer is recorded before it acts, so it is asked again only if the kill came before the record. Every committed model turn
  appears exactly once, in order. A committed duplicate fails the run.
- **The browser session is created once and released once**, and the delivered record equals the uninterrupted run's.
- **Every reference gate passes** on the final directory; each is also a check of the run.

## A slow seed

A kill that lands before the browser's session create is answered leaves a session whose creation is unknown. The run waits
for the browser to release it after its create deadline, which the host here sets to 3 s (`createDeadlineMs`), so each such
kill adds about three seconds. At the browser's default of 60 s it added about a minute.
