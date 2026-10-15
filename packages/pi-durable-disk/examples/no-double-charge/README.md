# No double charge

A paid call that a crash cuts in half is never sent again. pi-durable records a tool call before it runs. If the process
dies during the call, the next process to open the run reports that call to the model as `interrupted` instead of
running it a second time. A payment API therefore never sees the same charge twice from the run. No disk and no key:
the run lives in a directory of this machine (`localRun`), and pi-ai's faux model plays the agent.

## Run it

From a checkout, after the root `npm ci --ignore-scripts && npm run build`:

```sh
cd packages/pi-durable-disk
node examples/no-double-charge/main.ts
```

It takes a few seconds and ends with:

```
generation 1: charging invoice 2
payment server: charge #2 for invoice 2 received, held with no answer; killing generation 1 (SIGKILL)
generation 2 opened the run in .../no-double-charge-run
generation 2: charging invoice 3
...
  charge-2: interrupted (<harness> [error] Tool charge was interrupted and may have partially run </harness>)
...
payment server, every charge received:
  #1 invoice 1, key charge-1, answered
  #2 invoice 2, key charge-2, cut
  #3 invoice 3, key charge-3, answered
  #4 invoice 4, key charge-4, answered
ok: no invoice was charged twice, and the charge cut by the kill came back interrupted, not sent again (4 invoices, 4 charges at the server, invoice 2 interrupted)
```

If a charge reaches the server twice, or the run's record disagrees with the server, it prints `not ok: ...` to stderr
and exits 1.

## How it works

- **The payment server** (`payments.ts`) counts every `POST /charges` by its `Idempotency-Key` and never deduplicates,
  so a charge sent twice would show up twice. It holds the first charge for invoice 2 open, counted but unanswered.
- **The `charge` tool** (`main.ts`, in the `instance` branch) sends the charge with `api.callId` as the idempotency key.
  The call id is recorded before `execute` starts and is the same in every process that opens the run. The tool has no
  `replay: "safe"`, which is what makes a cut call come back `interrupted`. Add `replay: "safe"` and run it again: the
  cut charge is sent a second time on recovery, and the example fails with "invoice 2 reached the server 2 times".
- **The supervisor** (the end of `main.ts`) starts an instance and waits for the server to catch invoice 2's charge.
  It then kills the instance with `SIGKILL` and starts a second one on the same directory. Each instance submits the
  four invoices with request ids, so the second one skips what the first already admitted. Once the second instance
  finishes, it prints each charge's outcome as the run's store records it, and the supervisor compares that with the
  server's list.
- **The faux model** asks for one `charge` per invoice. Given an `interrupted` result, it reports it and doesn't try
  again.

## What it does not show

- **What happened to the cut charge.** The run only knows that the call started and never finished. Here the server did
  receive it. Settling it is up to you: a reconciler or a person asks the provider about its key. A key tied to the
  invoice rather than to the call also covers a model that decides to charge again with a new call, which pi-durable
  treats as a new call.
- **A real model.** The faux model is scripted not to retry. A real model decides for itself, so its instructions should
  say what to do with an `interrupted` charge.
- **Two machines.** A run on a local directory has no fence and guards one machine only: the kill and the second process
  are on the same host. On a network disk, the run's fence also stops the first host from writing once another host has
  taken over. Example 02 (`../02-paid-effect/`) shows that version, with Archil.
