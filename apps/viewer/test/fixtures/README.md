# Test fixtures

These serve the tests only and are never bundled into the gallery: a hand-cut fixture is not a recording of a run.

## reference-job

A recording of a run, not cut by hand: the reference job (`examples/reference`) with scripted providers, no key, $0, one
process. Recorded at `79868e54` with `npm run demo:reference -- --record <dir>`, and nothing in it is edited: one paid
call, one judge ask, four model turns, nothing repeated or asked twice, cost $0. It left the gallery, which shows agent
runs only; the tests read it as a clean run (the chat view's, the gate's and the Pages step's tests, the timeline's
golden test, the cost comparison).

## ten-kills-seed21

A recording of a run, not cut by hand, kept for the tests that read a killed run beside the clean `reference-job`
(the timeline's golden test, the gallery gate's tests): the reference job killed ten times, at the points seed 21 picks
(a model turn, the judge, a browser read, receipt filings, the supervisor before and after an outside call applied),
and resumed each time. Eleven processes. Recorded at `79868e54` with `npm run demo:kill -- --seed 21 --json --record
<dir>`, and nothing in it is edited.

Its counters agree with `reference-job`'s: one paid call, one judge ask, four model turns, nothing repeated or asked
twice, cost $0. It adds its processes and kills, and one possible re-ask: a kill cut turn 0 after its ask's start was
committed, so the store cannot show whether the model was reached. The kill run's own ledger, which counts at the
scripted provider, shows it was asked twice there; the ledger's gates (the record matches its schema, its citations
name filed evidence, each scripted outside call ran once, every node ended, every browser session was released) all
passed. The ledger is not part of the recording.

## reference-killed

The reference job (`examples/reference`) killed once in the lead's model request after the browser read, then
resumed by a second process to the same record, cut by hand from that real run's store:

- Its durable lines are the run's store, read after the run: each document revision with its whole value, each
  conversation entry as stored, each task's current record at the last commit, as the store export writes them. Image
  blocks are moved to `blobs/`.
- Its `host` lines (each process's start, the kill and its label, the result) and the assistant `message_start`
  lines (one per model request the run's own ledger counted, in each process) are placed by hand, at the commit each
  one precedes. The `host` lines are the supervisor's: they carry no `gen` and number their own `seq`, and the process
  each is about is in `data.gen`. The kill was placed at a commit, not at a counted crossing, so its `crossing` is
  null.
- Its `t` values are placed in commit order, not observed: they are for drawing only.
- The run's code opened the journal twice in each process, so the store's generation reaches 4 for 2 processes.

## spacedeck-asks

A scripted dependency audit over 24 branches of a public repository, killed 30 times in a storm (31 processes), cut
down to the lines the re-ask fold reads, and only those:

- the supervisor's `process.started` and `kill` lines, with `data.gen` only;
- every durable `pi.live` line, its value reduced to `generation { attempt, message }`, where `message` is replaced by
  the first 16 hex digits of the SHA-256 of its JSON with sorted keys (so two partials compare as they did);
- every durable `pi.assistant` entry, its messages reduced to `role` and `stopReason`.

Every kept line keeps its `channel`, `source`, `kind`, `gen`, `t`, `commit`, `order`, `conv` and `snapshot`, in file
order. The fold over this cut equals the fold over the whole recording: 188 committed turns, 136 proven re-asks over 16
turns, and 9 possible. It is not a valid recording on its own (no manifest), and the tests only fold it.

## transport-route-real, transport-route-docker, transport-t4-wait

Real recordings of a session that moved between machines (the transport panel's tests): the whole route on Daytona and Modal boxes, the same route on
Docker stand-ins, and one hop to a Modal T4 with its wait. They are host recordings: the supervisor's `host` lines, the transport live lines, and the browser's
frames. They have no durable lines (a boxed home's commits are not shipped to the host yet), so the panel's counters read "not measured" on them. Only the
frames and the result's summary are kept as blobs; the film itself is left out (the result's summary still names its blob). The edits are the
temporary directory in a local box's workspace path (from a private scratch path to `/tmp/`) and the manifest's `cost.usd`, which is `null`: with no durable
line the cost is unknown (RECORDING.md section 6), and it was `0` when these were recorded.

`transport-route-real` is the second real run of the route (the first had its box kill after the cut): the Daytona box is destroyed with its disk 7 s into the download,
and the session is rebuilt in a new box from its last checkpoint; a runner process is killed mid-install on the Modal T4 box and recovered in place.

## disk-takeover

A hand-built run on a disk place (no disk, no key, nothing real ran): three claims of one run. Generation 1's box is
deleted while a paid call (`charge`) is in flight, the claim is orphaned and revoked, generation 2 claims it and finishes
`ship`, then stalls and is fenced (`LEASE_LAPSED`, exit 75) after a second revoke, and generation 3 finishes `notify` and
releases with a sealed sequence of 9. Its host lines are in the shapes RECORDING.md section 5 gives for a disk place
(`run.json` with `gen`, `delegation`, `revoke`, `fenced`, with `process.started` and `kill`); its durable lines are the
`agentrun.driver` and `agentrun.effects` documents the store would hold (a process's snapshot at its open, with each
effect's calls list unchanged). Its `t` values are placed, not observed. The disk panel's tests read it.

## disk-kept

The disk demo's recording (a supervisor prototype's `run.json` lines; the real ones come from R2's supervisor), cut to what the
disk panel reads: every live `host` line (`process.started`, `kill`, `run.json`, `result`) and every `agentrun.effects` line,
in file order, with the machine's name and boot id relabelled as a published recording carries them (`holder.host` is `host-1`, `holder.bootId` is `boot-1`; every other field is as recorded). Ten charges: the first four paid and recorded by generation 1; the fifth paid by generation 1, which
was killed at `effect.kept charge` before the store recorded the call, and settled by generation 2 from the answer generation 1
kept in evidence (its call carries `via: "evidence"`) without calling again; the last five paid by generation 2. It is not a valid
recording on its own (no manifest, no driver, pi or browser lines), and the tests only fold it.


## disk-resumed

A scripted run of the disk demo's job (a map of ten invoices, each item's body one `call` node, `charge`), killed once
mid-map and resumed by a second process, recorded as it ran: the durable lines are its store's (`agentrun.driver` is
`agentrun.frozen_run.v3`, whose last checkpoint lists every item's body done), with the live workflow events and the
supervisor's `host` lines of both processes. It is the case a panel must read from durable state: a map whose body is
one node gives the workflow document no steps to look for, and no judge answers. `test/node-status.test.ts` reads it.

## map-in-map

A map inside a map's item (rows, each a map over its cells, each cell a lookup and a tally), run by the DSL's own
fixture driver (`packages/dsl/test/fixtures/graph/generate.mjs`'s `capture`) in both layouts, to its end and cut at the
third commit of `tally`. `runs.json` holds the workflow, its input and, per run, what the driver kept: the snapshot's
frame and the map items' records (in the keyed layout, each inner cell has a record of its own). `make.mjs` writes it
again from a fresh DSL build. Read by `node-status.test.ts` and `workflow-map.test.ts`.
