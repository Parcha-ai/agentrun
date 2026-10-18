# Test fixtures

These serve the tests only and are never bundled into the gallery: a hand-cut fixture is not a recording of a run.

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


## hear-and-find

A whole recording of pi-vision's hear-and-find example (`examples/hear-and-find`) on its scripted path: a 34 s
public-domain NASA clip of the Apollo 11 landing, a scripted lead, scripted eyes, a scripted Jev and a scripted
transcriber, so it holds no model's output, no key and no cost. The run transcribes the clip, then has Jev look at
stills it cuts from the film, each look named `eagle-heard-and-seen.webm#t=S` (kind `image`, its own fragment empty),
and its `agentrun.cited/1` result cites the frame at 28 s with the box Jev drew (`#t=28&xywh=percent:30.3,5.6,50.3,54.4`).
It is kept whole (manifest, lines and its 12 blobs, 472 KB): the vision panel's tests read it to draw those looks in the
film lane at their seconds, never as photographs. It is a valid recording: the repository's validator and the viewer's
`validate` find nothing in it, and the credential and machine-value scans found nothing.
