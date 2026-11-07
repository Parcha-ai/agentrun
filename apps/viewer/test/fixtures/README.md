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
and resumed each time. Eleven processes. Recorded at `51c178bc` (after the recorder stopped keeping a browser session's live-view URL) with `npm run demo:kill -- --seed 21 --json --record
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

