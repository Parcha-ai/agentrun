# audit-across-crashes: the store is the record

A run is killed twice, in the middle of a tool call. Then every incarnation is accounted for (who asked what, who answered,
which calls were cut and who settled them) from the run's store and nothing else: no log of the instances is read.

It shows that the store of a durable run is its audit trail. Each incarnation is a recorder's snapshot away from being
inspected, and the account of generation N is the difference between what the store held when generation N opened and
what it held when N+1 did.

## Run it

From a checkout, after the root `npm ci --ignore-scripts && npm run build`, on Linux with Node 22.19 or later (no disk,
no key, no network):

```sh
cd packages/pi-durable-disk
node examples/audit-across-crashes/main.ts       # a few seconds
```

It writes `audit-across-crashes-run/` (the run) and `audit-across-crashes-snapshots/` (what the recorder saw) under the
current directory, and prints:

```
in flight: question 2 (generation 1)
generation 1 was killed (SIGKILL)
...
generation 1:
  question: Tell me about tides
  called lookup as lookup-1
  lookup-1 returned: notes on tides
  answered: Generation 1: notes on tides.
  question: Tell me about granite
  called lookup as lookup-2
  killed with lookup-2 in flight
generation 2:
  lookup-2 settled as interrupted, never run again
  answered: Generation 2: the lookup was cut by a crash, so I will not guess.
  ...
ok: the store alone shows three generations, two calls cut mid-flight, each settled as interrupted by the next generation and never run again
```

## How it works

- The example is its own supervisor. `main.ts` starts `main.ts instance` children on the same run directory and kills the
  first one while question 2's `lookup` call is in flight, and the second while question 4's is. The third finishes the
  run. The model is pi-ai's faux provider, scripted: it calls `lookup` once per question and reports an interrupted call
  instead of guessing.
- The recorder is the `beforeResume` option of `openDurableRun`. The hook runs once per incarnation, after the Harness is
  open and before it resumes, and gets `storage` (four reads: `scanConversations`, `scanTasks`, `scanDocuments`,
  `document`, and nothing that writes) and `head`, the store's last committed sequence. `snapshotAt` reads every task,
  every document and every transcript entry (through `harness.conversation(...).entries`) and writes them to a file named
  for the generation.
- Documents are read the way pi-durable allows. A document that keeps no history (`latest`, and every session or task
  document) is read at `"current"`, which is its state at `head` until the hook commits something, and only a
  `rewindable` one is read at `head`. Asking for a sequence on the others is refused.
- After the third instance exits, the supervisor opens the run once more, as an auditor, with the same recorder. Its
  snapshot is the final state, so every generation has a successor to be compared with.
- The account: what generation N did is the entries in snapshot N+1 that snapshot N lacks. A tool task that is not
  terminal in snapshot N+1 is a call that was in flight when N died; the next incarnation records it as `interrupted`
  and does not run it again. The example checks all of this and prints `not ok: ...` and exits 1 if the store says
  otherwise. The one thing it takes from outside the store is the supervisor's count of how many times each call started
  (once each), which is the world's side of "never run again".

## What it does not show

A run on a local directory has no fence and guards one machine only: nothing here stops a second process from opening the
run while the first is alive. The recorder's snapshots are files beside the run, so a real deployment would keep them in a
store of its own. The model is scripted, so the answers say nothing about a real model's behaviour after an interrupted
call.
