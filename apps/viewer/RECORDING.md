# agentrun.recording/1

Draft 38, 2026-10-17. The format the run viewer in this directory plays. A change to a field's meaning is
`agentrun.recording/2`.

A recording is one real run, kept so a static viewer can replay it exactly, with no key and no server. Live mode
streams the same lines while the run happens. The viewer draws only what the lines say.

## 1. The directory

```
<recording>/
  manifest.json     what was run, by which code, at what cost, and where the run record is
  events.jsonl      every event, one JSON object per line, in the order of section 3
  blobs/<sha256>.<ext>   content-addressed files the events point at (screenshots, frames, evidence, the result)
```

## 2. manifest.json

```ts
type Manifest = {
  format: "agentrun.recording/1";
  title: string;                      // shown in the gallery
  task: string;                       // the goal or workflow name, as run
  recorded: { started: string; ended: string };   // ISO 8601, the recording host's clock
  code: { repo: string; commit: string; packages: Record<string, string> };   // name -> version, pi's packages
                                      //   included (a fold of pi's documents depends on their version)
  model: string;                      // provider/model of the lead; others are named in their events
  generations: number;                // processes that opened the run, including the first
  kills: number;
  cost: { usd: number | null; parts: Record<string, number | null> };   // null: unknown, never 0; the same fold as
                                      //   section 6's cost, so usd is null when any part is
  source: { run: string; store_sha256: string };   // the run record this was cut from
  result?: { blob: string; title: string };         // the payoff, e.g. the report
  chapters?: { title: string; at: { gen: number; commit: number }; focus?: string }[];
                                      // jump points: the screen just after that commit (gen and commit, because a
                                      //   restore reuses commit numbers, 3.2); focus: an execution path prefix
  providers?: "real" | "scripted";   // "real" when every priced part (model, eyes, browser, a door's outside call)
                                      //   called a real provider; "scripted" when any was served from a cassette, a
                                      //   script or a fake
  job?: { blob: string; sha256: string };   // the job that ran ({ workflow, input, files: [names] }) as a JSON blob
  store?: { blob: string; at: { gen: number; commit: number } };
                                      // the run's store at the end, a SQLite blob of at most 10 MB, redacted and
                                      //   scanned like every blob before it is published
  see_also?: { recording: string; label: string }[];
                                      // other recorded runs of this demo, linked only (a weak-eyes pass); no computed
                                      //   difference, which is baseline's job
  baseline?: { recording: string; label: string };
                                      // another recorded agentrun.recording/1 directory (relative path or URL) whose
                                      //   counters show beside this one's; never typed-in numbers. A difference in
                                      //   cost (the price of the kills) is computed only when both manifests say
                                      //   providers "real"; otherwise, or when either lacks the field, it reads
                                      //   "not comparable"
};
```

## 3. Events

```ts
type Event = {
  channel: "durable" | "live";
  source: "workflow" | "pi" | "browser" | "vision" | "transport" | "host";
  kind: string;                       // the package's own record name (section 5)
  gen?: number;                       // live: the process incarnation that wrote it, from 1; durable: per section 3.1 (absent
                                      //   before the earliest surviving agentrun.driver revision)
  t: number;                          // ms since recorded.started, for display only
  commit?: number;                    // durable only: the store's global commit sequence; one commit has several lines
  snapshot?: true;                    // durable only: written at a process's open, the whole document at that commit
  order?: number;                     // durable only: the line's place inside its commit (document id, then entry id)
  seq?: number;                       // live only: order within its generation
  path?: string;                      // the workflow execution path it belongs to, when it has one
  conv?: number;                      // the pi conversation it belongs to, when it has one
  task?: string;                      // durable only: the pi task a task-scoped document belongs to
  data: Json;                         // the record, as the package wrote it, after redaction
  blobs?: string[];                   // sha256 of files in blobs/
};
```

### 3.1 What a durable line holds

- **A document line** (a document revision): `data` is `{ doc, key?, value, version? }`. `doc` is the document kind;
  `key` is the family key exactly as the store keeps it, absent for a singleton (for `agentrun.effects` it is
  `<journal key>\u0000<effect id>`, the NUL join of the store's effect key; a panel that wants the id splits on NUL);
  `value` is the document's WHOLE value after this revision, never a delta (the exporter applies each stored delta);
  `version` is the document's stored version, so a panel refuses a version it does not know instead of misreading it.
  A panel's reduce for documents is the latest value per `(doc, key, conv, task)`: a conversation-scoped document
  exists once per conversation (its line carries `conv`), a task-scoped one once per task (its line carries `task`).
- **An entry line** (a conversation entry): `data` is the entry as stored. The store export stays raw (a reader never
  transforms what is stored); the RECORDER moves image blocks out of the line: the block keeps
  `{ type: "image", mimeType, blob }`, where `blob` is the SHA-256 of the image file in `blobs/`.
- **A memo line** (a task memo pi keeps): `data` is `{ memo: <key>, value }`, `kind: "pi.memo"`. pi keeps memos inside
  the task's current record, with no commit of their own, and drops them when the task ends; an export after the run
  cannot see them. So a memo line is captured only by the LIVE recorder while its task runs: it takes the store's
  latest commit at observation and is ordered after that commit's own lines. A recording made after the task ended has
  none. Anything a panel must replay or count belongs in a document (durable, with a commit) or a blob, not only in a memo.
- **Its source** is the owner of its record, by the kind's prefix, for documents and tasks alike: `agentrun.` is
  `workflow` (so the `agentrun.workflow` task is `workflow`), `browser.` is `browser`, `vision.` is `vision`,
  `transport.` is `transport`, and `pi.` is `pi` (so `pi.generation` and `pi.tool` tasks are `pi`). pi's own entries
  and memos are `pi`. A kind with no package prefix (a host's own document, such as the example's `reference.label`)
  is `host`.
- **Its `t`** is when the recorder observed its commit; the store keeps no commit time.
- **The durable recorder runs inside each of the run's processes**, on pi-durable's `Session.subscribeCommits`:
  each publication is `{ seq, changes }`, a document change carries the WHOLE adopted revision and its version, and
  table changes include task writes. `@parcha/agentrun-pi/durable`'s `recordCommits(session, { gen, write })` maps each
  publication to the same lines as the file export; `gen` is the process's own driver generation and `t` is when the
  commit was adopted. A disk run's store admits one connection (its default profile), so no other process can read it
  while the run holds it.
- **Each process starts with a snapshot.** After the run is opened and before it resumes, the recorder writes every
  document of the run at the store's latest commit, as whole values marked `snapshot: true`. So the state is exact
  after any kill. A snapshot line's `gen` means what every durable line's means: the generation of the latest
  `agentrun.driver` revision at or before its commit, so at an open it is an EARLIER process's, never the lease's or
  the supervisor's count. A validator checks that durable `gen` never decreases in file order, outside a restore (3.2). What a kill can lose is the lines of the ONE commit in flight: the commit listener must not block,
  so lines are written just after their commit lands. The commit's effect on state is recovered by the next snapshot;
  only that commit's own lines can be missing, and the viewer shows the gap. The bound holds only when the recorder's
  `write` is synchronous (it completes before it returns, such as `appendFileSync`): an asynchronous writer queues the
  later commits' lines and a death loses all of them, and no durable queue can help, because the listener cannot block.
- **`recordingLines(file, { after? })`** is for a store no process holds: an export after the run. It carries only the
  revisions pi kept (pi prunes a current-only document's older revisions when it writes a new base), and a line
  before the earliest surviving `agentrun.driver` revision has no `gen`.
- **Tasks** are written at their real commit in process (subscribeCommits carries task writes). A bare export emits
  every task's current record once, at the store's last commit, after everything else, as the state at export.
- **Two writers.** The in-process recorder writes the durable and live lines of its process. The supervisor that
  starts, kills and restarts the processes runs outside them, survives every kill, and writes every live `host` line
  (`process.started`, `kill`, `result`); a process writes none. The recording joins both. The supervisor's lines carry
  no event-level `gen` (no run process wrote them) and number their own `seq`; the process a line is about is in its
  data (`process.started` `{ gen }`, `kill` `{ gen, label, crossing }`, `result` `{ gen, blob, title }`).

Order of `events.jsonl`: by `t`, ties broken by `(commit, order)` then `seq`. Invariants a validator checks: across
durable lines that are not snapshots, `commit` never decreases and `(commit, order)` strictly increases; a snapshot
line's `commit` is the store's latest commit at its process's open, never below any earlier line's; `seq` strictly
increases within one `gen` across live lines, and across the supervisor's lines (no `gen`). The one exception is a restore (3.2): the durable rules start again from
the restored generation's snapshot.

### 3.2 A move and a restore

- **A move keeps one store.** The source seals it, the target opens it only after it verifies the sealed head, and
  the target's first commit continues the sequence. Only one copy ever commits. Nothing in section 3 changes.
- **A restore does not.** After a box died, the run reopens the box's last checkpoint. The commits the dead process
  made after that checkpoint are in no store, and the restored store numbers its new commits from the checkpoint's
  head again. The lines the live recorder already wrote from those commits stay (the recorder never rewrites a line):
  they are the **lost branch**.
- **A reader finds it without a field.** A process's snapshot is the snapshot lines it writes at its open, after its
  `process.started` line (their `gen` is an earlier process's, 3.1). When that snapshot has a commit `S` below a commit
  already seen, every earlier durable line with a commit above `S` is the lost branch. The validator accepts that drop
  only when that process's lines, after its snapshot, carry a `transport.moves` record of kind `restore` whose `head`
  is `S + 1`; any
  other drop is refused. Every `transport.moves` record carries a top-level `head`: the sequence the target's first new
  commit takes, after any replay. A move's `head` equals its `seal.head`, and `S` equals the highest commit seen
  before it (no drop). A restore that replays the host's shipped commits carries `replayed { from, to }` and its
  `head` is `to + 1`. The host writes a commit's lines only after it has appended that commit's frame to its log, and
  each commit's lines follow its writes on the same ordered link (a `record` frame, then a `lines` frame), so a
  streamed recording's lines never run ahead of the log and a
  restore that replays the whole log has no lost branch. When `to` is below the last commit seen (lines recorded
  another way, or a log the restore did not replay to its end), the gap `(to, last seen]` is a lost branch under the
  same rule: counted, never hidden, accepted on that restore record. A restore from the checkpoint alone has `head`
  equal to `checkpoint.head`. In every case the process's first non-snapshot commit equals `head`, or `head + 1` when pi
  committed once at open (a generation was running: the process's own snapshot is then at commit `head`, so that
  commit's state is in the snapshot and nothing is lost), and the record's own commit is at or above it.
- **State.** A process's snapshot is the whole state at `S`: a reducer resets at its first snapshot line, and a `(doc, key)` the snapshot does not carry no longer exists.
- **Counters.** The lost branch happened. Its completed calls count in paid calls made (they were paid), and a redo of
  one of its identities in a later generation counts in repeated. A restore can show repeated above 0; the viewer
  shows it, never hides it.

## 4. The rules every panel keeps

1. **Counts come from durable lines, or from host lines written outside the run's processes.** Anything the viewer
   counts or calls "done" (paid calls made, calls repeated, judge asks, steps finished, cost) is folded from durable
   lines; processes and kills come from the supervisor's `host` lines. Live lines from inside the run only show what is
   in flight: a turn streaming, a node running, a tile moving. The one exception is labelled: a count only live lines
   can give is shown as "observed", never as proven (section 6).
2. **Durable lines are the store's commits.** They are produced by `@parcha/agentrun-pi/durable`'s read-only export of
   a run's store (one line per document revision or entry, with its commit sequence and its order inside the commit),
   never re-derived from callbacks. A viewer applies one commit's lines together, and a scrub stops only between
   commits: the driver writes a state and the effect admission it goes with in one commit, and a screen between them
   never existed.
3. **The process lane comes from the supervisor.** Each `host` `process.started` line opens a band and each `kill` line
   ends one, with its label. `agentrun.driver`'s generation counts journal opens, which can exceed processes; it is
   shown as a fact of the store, not as the process count.
4. **Positions are execution paths.** A line tied to a workflow position carries `path` as the DSL writes it. Focusing
   a branch hands its path to every panel's `view`; the shell drops no line for focus. Each panel shows what is under
   that prefix its own way (filter, dim, highlight), and keeps lines with no `path` (a conversation entry, a driver
   checkpoint) in its state.
5. **Panels are pure.** A panel is `accepts(event)`, `reduce(state, event)`, `view(state, blobs, focus)`. Reducing the lines
   up to a point gives exactly the screen at that point, so scrubbing is replaying.
6. **Time is for drawing.** `t` places a line on the timeline. It never orders durable facts; `commit` does.
7. **Unknown kinds are skipped.** A panel ignores kinds it does not know; the format adds kinds without a version bump.
   A change to a field's meaning is `agentrun.recording/2`.

## 5. Kinds, by source and channel

| source | durable (the store) | live (in process) |
|---|---|---|
| workflow | `agentrun.driver` (generation, revision, notes; its `state` is the recovery driver's checkpoint, schema `agentrun.frozen_run.v3` or, in the keyed layout, `agentrun.frozen_run.v4`, whose frame keeps each state as the SHA-256 of an `agentrun.states` document and which adds `maps`, `{ <map path>: { length, items, base } }` with `base` a state's SHA-256; version 1 either way, and `generation` is read as before); in the keyed layout only, `agentrun.items` (version 1, one per map item, key `<journal key>\u0000<item path>`: `{ driver, map, index, base, revision, status: "running" | "committed" | "failed", frame: { done, states, chains, loops, routes, inputs, steps }, effects, clocks, files, unknownResponses, maps }`, where `frame.states` maps a path to `{ set, unset, sha256 }`, that state as a delta against the map's `base`; the store replaces it whole when the item changes) and `agentrun.states` (version 1, one per state, key `<journal key>\u0000<sha256>`: `{ driver, sha256, state }`, written once and never changed); their lines carry the WHOLE value after each revision, as every document line does (3.1). A reader rebuilds an item's state at a path by taking the `agentrun.states` document its map's `base` names and applying the item's `set` and `unset` for that path, then checks the result against that path's `sha256`: when the base's `agentrun.states` document is missing or the hash differs, it shows the item as unreadable and never guesses (that rebuild is `itemState(item, states, path)` from `@parcha/agentrun-dsl/recovery`, which readers call rather than reimplement); each SHA-256 is of the state's canonical JSON (keys sorted); when a map fails, the v4 driver state's `pin.partial` is `{ path, as, results }`: `path` the failed map's execution path, `as` the state key its results go under, and `results` one SHA-256 naming an `agentrun.states` document whose state is the list of slots, one per map item in index order, each `null` (the item never finished) or the SHA-256 of another `agentrun.states` document whose state is that item's result (any JSON value); a reader showing a failed map's finished results looks up the list by `results`, then each non-null slot, checking every digest, and shows a missing or mismatched document as unreadable, never guessed (that read is `partialResults(partial, states)` from `@parcha/agentrun-dsl/recovery`, which readers call rather than reimplement; it also reads a v3 `pin.partial`, which keeps `results` inline as a list, unchanged); a map with `onItemFailure: "collect"` (no other run writes what follows) collects an item that fails instead of failing, and keeps how the item ended in exactly one place: in the keyed layout, the item's `agentrun.items` record, written with status `"failed"` and `outcome: { code, label, message }` (the failure's code, the label of the node that failed, its message, at most 300 characters; present exactly when the status is `"failed"`) in the commit that ends the item, and kept after the map commits, as a committed item's record is; otherwise the driver state's `pin.failures`, `{ <item path>: { code, label, message } }`, one row per failed item keyed by its path (`<map>/items/<i>`), kept with the run like `done`: every failed item of a run stored whole (`agentrun.frozen_run.v3`), and, in a run in the keyed layout, only an item of a map that committed while the run was still stored whole, before a later process moved the run to the keyed layout (such an item has no `agentrun.items` record); so a v4 reader looks for a failed item in `agentrun.items` and then in `pin.failures`; a step record whose status is `"failed"` (in `pin.steps` or an item's `frame.steps`) may carry `failure: { code, message }` when the failure was an item's inside a collecting map, and a later open refuses the step with it, so the item ends the same way in every process; the map's result keeps one slot per item under `as` (`null` for a failed item), and its `failedAs` key holds the rows `{ item_index, label, code, message }` in item order; a reader shows an item whose status is `"failed"` as failed, with its outcome, and has nothing to rebuild; both kinds are session-scope documents, so a process's snapshot at open carries every one of them; `agentrun.effects` (status `unknown`, written at admission before dispatch, then `completed`; the first revision is the admission; intent and outside calls: each call is the record the host's effect adapter passes to the driver's `call`, `{ outcome: "applied" | "failed" | "unknown", ... }`, written only when the host reports it. A host lists every applied call EXACTLY ONCE: a settlement that finds from evidence (a provider lookup) that the call applied, while `calls` holds no applied entry, reports `{ outcome: "applied" }` then, and one whose applied call is already listed adds none); `agentrun.receipts` (an agent's paid tool calls, one entry per tool and argsHash); `agentrun.decisions` (receipts, `run_key`); `agentrun.record` (a delivered record and its attempts); `agentrun.node`, `agentrun.nodes` (the node runner's index); `agentrun.gate`; `agentrun.workflow`, a pi task: in process, every write of the task at its commit (created with its request, the workflow as run and its input, so a graph draws from the start; then its state; then its outcome); in a bare export, its current record once at the export's last commit | `WorkflowEvent` `{ type, label, detail, executionPath }`: `node.start`, `node.end`, `effect.attempt`, `effect.poll`, `effect.failed`, `effect.late_settled`, `ask.evaluated`, `judge.answered`, `verify.answered`, `route.chosen`, `escalate.evaluated`, `loop.exited`, `code.patch`, `map.item_failed` (detail `{ item_index, label, code }`, one per item a collecting map collects), `map.failed` (on a collecting map, its detail adds `collected`, their count) |
| pi | conversation entries (messages, tool calls and results; image blocks as blobs), memos (`pi.memo`), the conversation documents (`pi.live`, one per conversation: `generation { attempt, message? }` with `message` the committed throttled partial of the answer in flight; `pi.usage`, `pi.agent`, `pi.inbox`), tasks (`pi.generation`, `pi.tool`), usage | `run_start`, `turn_start`, `turn_end`, `message_start`, `message_end`, `tool_execution_start`, `tool_execution_end` (streaming deltas dropped) |
| browser | `browser.sessions`, `browser.inventory` (custody records) | `SessionRow` on `launched`, `updated`, `released`; `EvidenceRecord` (body as a blob); `frame` (`{ session, provider, w, h, mime: "image/jpeg" }`, one JPEG blob; at most 10 fps at 800 px); `frame.gap` (`{ session, from, reason, detail? }`, reason `process_killed`, `credential_on_page` or `session_released`; for `credential_on_page`, `detail` says why: `field`, `typed`, `too_deep`, `unreadable_frame` or `host`; no frame is kept while a credential or a code is on the page); `frame.track`, optional, written at export (`{ session, fps, from, to }`, blobs: a WebM and its index). Every frame line carries the event-level `conv` of its session; `handoff.click` (`{ session, request, x, y }`, `x` and `y` as fractions of the frame), written only while the session is held for that handoff request and never while frames are paused for a credential, with no key ever recorded; the held and live states themselves come from the durable session rows |
| vision | a `vision.*` document where the host files each `LookRecord` (the durable source for looks paid and their cost); the look memos `vision:look:<key>` only as live memo lines (section 3.1); `vision.kept` (version 1, a conversation-scope family, one document per key, `{ kept, value }`, the first committed value kept and never rewritten): `vision:look:<key>` (the look key, the `LookRecord`'s `facts.key`) holds the answer as the provider gave it before any filing (for `vision.see` and the guard's look `{ text, model, usage, costUsd, billedBy? }`), and `vision:told:<key>` the receipt the look was filed under once the host was told (a string, or `null` when the sink keeps none), so a later call in that conversation reads the answer back marked kept at $0 whatever the host's replay mode; neither is ever a payment, and a fold counts payments and their cost only from `LookRecord`s (section 6); the host files each `vision.transcribe` call in the same `vision.*` document as a record of the same shape with tool `transcribe` (args `{ path, model, native: false, via }`; its body the transcript as rows `start<TAB>end<TAB>words` in seconds, against which a `#t=S` cite of that file is checked; `facts` with kind `audio` or `video`, `key`, `cost_usd` at the provider's list price per audio minute, `null` when unknown and never 0, `provider`, `kept?`), and a fold counts its payments and cost exactly as a look's, by `facts.key`, never by the tool's name; `facts.kind` gains `audio`; a transcription's kept answer under `vision:look:<key>` is `{ words: [{ text, start, end }], text, provider, model, costUsd }` | `LookEvent`, `MissEvent` |
| transport | `transport.moves`, one key per move id, written once in the commit the TARGET runner makes when it opens the moved store: `kind` (`move` or `restore`), epoch, `from` and `to` (`{ environment, provider, box }`), drain, ship and take ms, bytes, `stopped` (the attempts a kill or failure ended before landing), the placement id; `head`, the target's first new commit's sequence after any replay; a move's `seal` and a restore's `checkpoint` (`{ head, sha256, bytes }`, the checkpoint also `at`), and a replayed restore's `replayed { from, to }`. Hops and flights fold from it (added after draft 5's signatures, a named kind, no format change). A move continues the commit sequence; a restore starts it again (3.2) | box created and ended, and the session token, as live lines |
| host | | the supervisor's, all with no event-level `gen` (3.1): `process.started` (`gen`); `kill` (`gen`, `label`, `crossing`: `{ point, n }`, the named crossing the kill landed on and its ordinal, or `null` for a kill at no named crossing; `kind`, optional: `process` when only the run's process died, `box` when its whole machine or sandbox was taken away; absent means `process`, and a panel never guesses `box`); `result` (`gen` of the process that delivered, `blob`, `title`), written when that process exits with the delivery made. The supervisor's own failures are lines too, never a crash: `kill.failed` (`gen`, `code`, `message` of at most 240 characters, `kind`: the place could not kill the process the line is about, so that kill did not land); `kill.request.ignored` (`gen`, `point`, `reason`: `no nonce` or `wrong nonce`: a kill request without that attempt's nonce, refused, and no value is ever written); `signals.failed` (`gen`, `code`, `message` of at most 240 characters: the place's signals ended in a failure, so the supervisor could no longer hear that attempt's kill requests and ended the attempt as it does after `kill.failed`). Each message passes the recorder's exact-value redaction (the sign-in values and the host-N/boot-N labels of draft 29) and has any absolute path outside the run replaced by `<path>` before the line is written. `picture` (`blob`, `label` optional, `commit` optional): the run's result so far as an image (a canvas assembled from the run's committed results), written by the recording's home side, never by a process the run can lose, with `commit` the store's latest commit it was drawn from; a picture is drawn only from committed results that the recording itself also holds, as lines or blobs, after the recorder's redaction, so it shows nothing the recording does not, and it never renders a key, a sign-in value, a machine path or any value the recorder redacts as text into its pixels; `blob` is an image in `blobs/`; a panel draws the latest picture at or before the stop and keeps the last one after the run ends, and a recording with no `picture` line draws no picture. `box.receipt` (`box`, `provider`, `kind`, `from`, `to`, `seconds`, `usd_per_second`, `cost_usd`, `source`, `priced`): one box's time, written once when the box ends (destroyed, deleted under the run or swept) by the side that made it (the supervisor for the boxes it starts, with source `host`; pi-transport's home runner for its boxes, with source `transport`); `box` is a label (`box-1`, `box-2`, ... by first appearance), never the provider's id or name; `usd_per_second` is the provider's published list price for that kind, `source` the page it was read from and `priced` the ISO date it was read, and `cost_usd` is `seconds` times it; a box with no published price for its kind (a GPU, an unknown size) still gets its receipt, its time recorded, with `usd_per_second` and `cost_usd` `null`, and makes the run's cost unknown, never 0; `cost_usd` is an estimate at list price, not the provider's invoice (a minimum billing increment, a credit or a plan is not modeled), and a panel labels it at list price. `recording.carry.failed` (`gen`, `code`, `message` of at most 240 characters with any absolute path as `<path>`, `lost`): a box place could not bring an attempt's recording home from inside the place; with `lost: true` the attempt's box was lost, so its lines after the last time they were brought home are missing and are shown as a gap, the way a kill loses its in-flight commit (3.1), and the recording stands; a final failure for an attempt that ended on its own refuses the recording instead, so that line never appears in a finished recording without `lost: true`. A JSON result blob MAY be `agentrun.cited/1`: `{ format: "agentrun.cited/1", title?, rows: [{ label, value (string or number), note?, cites: [{ blob?, look?, fragment?, url?, at?, note? }] }] }`, where `url` is the page or file the evidence was read from and `at` its ISO 8601 time (they only say where and when; a cite with a url and no blob or look is shown as linked, not kept), and a cite names a blob (sha256 of a file in `blobs/`), a look (a `LookRecord`'s `facts.key`) or both, `fragment` is pi-vision's `page=`, `t=` or `xywh=percent:` form, a row with no cite says on screen that it cites nothing, and any other top-level field is the demo's own and ignored; and, for a run on a disk place (a claimed directory), the place's own facts, polled by the supervisor from what the package writes: `run.json` (`gen` = the claim generation, and of the package's `RunRecord` ONLY these fields, every other one dropped by the recorder: `run`, `status`, `generation`, `sealedSeq`, `wakeAt`, `holder { driver, host, bootId, pid, since }` (any other holder field, such as a sandbox id, a sandbox name or a mountpoint, is dropped), in which a recorder replaces `holder.host` and `holder.bootId` with labels (`host-1`, `host-2`, `boot-1`, ... in order of first appearance, the same label for the same value within one recording) before the recording is finished, so a takeover by a new box still shows a new holder; the recorder adds its own host name and boot id to its exact-value redaction, and a panel compares labels, never real names; `heartbeatAt`, `updatedAt`, and `detail` only as text of at most 240 characters that has passed the recorder's redaction with any absolute path written as `<path>`; written when status, generation, holder or sealedSeq changes, so a generation that lives between two polls can be missed; a generation that goes up with a new holder is a claim, and a status of `paused`, `sleeping`, `done` or `failed` is a release: a running record may still carry the previous release's `sealedSeq` until the store is open, so a seal alone proves nothing, and a seal that a later record adds to a released generation completes that release); `delegation` (`gen`, `clientId`, `inodeId`, `isOrphaned`, `isPending`, `path`: the Archil delegation of the run's own path, Archil places only, in which a recorder replaces `clientId` and `inodeId` with labels (`client-1`, `inode-1`, ... by first appearance, the same value the same label within one recording, in `revoke` lines too), so a panel compares labels, never the provider's ids; the first line with `isOrphaned` marks the first poll that SAW the orphan, not the instant); `revoke` (`gen`, `revoked: [{ clientId, inodeId, path, isOrphaned }]`, `ms`: the whole takeover, the revoke plus the start of the next holder); `fenced` (`gen`, `code`, `message`, `exit`: the old holder's first refused write, its FencedError's `code` and exit 75; written only when the old holder is still alive, a stall or a partition: a killed process or a deleted box never writes one). On these lines `gen` is the run.json generation of the incarnation the line is about; on `process.started` and `kill` it is the process, as above. A panel skips a field it does not know and refuses a `run.json` without `run` and an integer `generation` |

## 6. The counters strip (the same for every demo; every counter is folded from durable lines)

**Snapshot lines are state, not events.** If the commit in flight at a kill held an effect's completion, the next
process's snapshot shows that effect completed under the NEW generation; a per-generation fold would count it as a
dispatch there. So a counter that folds events by generation (repeated, asked twice, judge re-asked) skips snapshot
lines, and a count of finished things (paid calls made, unknown at the end) reads the latest value per `(doc, key)`,
snapshots included. A lost branch (3.2) is events, not state: the per-generation folds include it.

| counter | folded from |
|---|---|
| paid calls made | per source, then summed: workflow effects that reached `completed` (once per id, by construction; plus a lost branch's completions, 3.2); plus the agent's paid tool calls, `agentrun.receipts` entries (one per tool and argsHash); plus vision's paid looks, per look key (`facts.key`) over ok, non-native `LookRecord`s: each filing without `facts.kept` is one payment, and a key whose FIRST ok filing is kept adds one payment more (the eyes answered in a process that died before filing it; the kept filing carries that price); plus browser and transport from their own rows |
| repeated | per call, never across calls. A workflow effect: its calls list is append-only and every line carries the whole list, so walk the effect's lines in order, snapshots included, and take from each only the calls beyond the previous line's list. A non-snapshot line gives its new calls its own generation. A snapshot line gives them its own `gen`, which is an earlier process's (3.1): they were committed before its process opened, and their own lines were lost in flight. When a line's list is not an extension of the previous one (a restore's snapshot, 3.2), that line becomes the base, and a lost branch's calls stay counted where they were first seen; each `applied` call after the first of its id is one extra payment, counted once: in repeated when its generation is later than the previous `applied` call's, in asked twice when it is the same. An effect whose host reports no calls has repeated NOT MEASURED: the strip says so, never 0. Two effect ids with one intent are two calls. An agent's tool call counts only when it is PAID: the run holds an `agentrun.receipts` entry for its `(tool, argsHash)`. That receipt key is its identity, run-wide (an identical call in any conversation is answered from the receipt, `reused`, and skipped); each paid execution (not `reused`, not `refused`) after the first of one key is one extra payment, counted once: in repeated when its generation is later than the previous execution's, in asked twice when it is the same. A tool with no receipt (a read, a stateful tool whose arguments do not name what it read) is not a paid call and never counts here. A page action (browser): its identity is `(conv, tool, codeSha)` from a session record's `pendingEffect` in `browser.sessions` (`tool` absent means `run`; an upload's key hashes its selector with the file's SHA-256). pi-browser journals each replay-unsafe page action before it acts, as a `pendingEffect` with a new `callId` on the record or carried as `prior` by a later entry. Walk the document's lines in order, snapshots included, and give each `callId` the generation of the line it first appears in (a snapshot's is an earlier process's). An entry REACHED THE PAGE when a revision shows it `finished` or with a `sent` row whose `held` is not `"denied"`. Each later dispatch of a key, after one that reached the page, is one extra application, counted once: in repeated when its generation is later than that one's, in asked twice when it is the same (the agent repeating an action whose answer it had, which no kill explains). A refused repeat (`effect_unknown`) writes no entry, so the refusal path counts 0. A dispatch after an earlier one that shows neither `finished` nor a sent row is POSSIBLE, never proven. It reads only `browser.sessions` revisions, never a live line, and a recording whose `browser.sessions` lines all carry no `t` (a bare export's, 3.1: only the recorder adds `t`) shows page actions NOT MEASURED, never 0. A vision look: its identity is its look key; each payment (as in paid calls made) after the first of one key is one extra payment, counted once: in repeated when its generation is later than the previous payment's, in asked twice when it is the same. A first-kept key's own payment belongs to a generation earlier than its kept filing's. What the fold cannot see: an eyes request sent by a process that died before its memo and its filing committed leaves no durable trace. When live lines show a look started in a process with no later filing of its key from that process, and no later process filed that key as kept (a kept filing is that same answer read back, already counted as a payment), the strip shows a POSSIBLE extra payment, never a proven one, and the run's cost is a lower bound there |
| asked twice | an extra payment in the SAME generation as the previous one of its id or key (the repeated row says how each is counted), which no kill explains, counted apart from durability |
| unknown | effects still `unknown` at the end of the run. While the run goes, an `unknown` effect whose admitting generation is alive is "in flight" |
| judge asks | `agentrun.decisions` rows, split answered and failed (a row with `error`); re-asked = more than one answered row for one `decision_id` and `run_key` |
| model turns | committed = assistant entries in pi's conversations whose `stopReason` is not `aborted` (when the next ask starts, pi MAY append a cut answer's committed partial as an `aborted` entry, as on a mid-stream kill, though a resumed process can also re-stream without it; the fold counts non-aborted entries either way and does not depend on it; an aborted entry's usage still counts in cost). Asks fold from durable `pi.live` lines, per conversation: pi commits `generation` without `message` at the `pi.generation` request phase, BEFORE it calls the model, so a non-snapshot revision where `generation` appears without `message` is an ask, at position (conv, non-aborted assistant entries committed before it). A snapshot at open that still carries a `generation` is an ask a kill cut: the ask already open at that position, or, when its start line died in flight, one more ask by an earlier generation. An ask open when its process died (its start line, or a snapshot's stale `generation`) and followed by another ask at that position is re-asked: PROVEN when the cut ask committed a partial (`message`), since the model was answering, and POSSIBLE when it committed only the start marker, since the process may have died between that commit and the model call; the strip shows both, and only proven ones count. A later process's ask at a position whose start marker is still present shows as its first partial or its committed entry, because a revision to the same value writes no line; a partial a later process commits, different from the one its snapshot carried, is that process's ask, and proof it reached the model. A snapshot can show a cut ask's marker bare after pi drops its partial; the process's own non-snapshot lines are the proof, so a fold never classifies a cut ask from snapshots alone. Each cut ask counts once: one with a partial (its own line, or the next snapshot's) is PROVEN; a bare marker that stays unchanged across several opens is ONE possible cut ask, because no process that may have asked under it leaves a line. Re-asked counts per position: asks at the position minus one, split proven and possible by the cut asks that make them. A recording that never committed an ask start shows re-asked NOT MEASURED. `pi.live` is pi's internal document, not a published contract, and pi breaks in minors: this fold is tied to the `pi.live` version it was measured on (`data.version` 1, pi-durable 1.1.0), reads re-asked NOT MEASURED on a version it does not know, and a test on each pi leg the repo runs (1.1 and 1.2) proves it there |
| processes | the supervisor's `host` `process.started` lines (written outside the killed processes). `agentrun.driver`'s generation counts journal opens and is not used for this |
| cost | usage and priced parts, a vision look's `facts.cost_usd` once per payment (each non-kept filing's, and a first-kept key's kept filing once), never a kept filing that follows a payment, and never a native look's (its price is in the lead's usage; a native look charges nothing and never makes cost unknown); plus each `box.receipt` line's `cost_usd`, once per box (a box its writer's own lines show started with no `box.receipt` makes the cost unknown, never 0); a recording whose `providers` is `scripted` still sums its real priced parts (a box's receipt, a real model's usage), and a reader shows them with the scripted parts named (a scripted lead, real boxes at list price), never `scripted, $0` while a real part cost something (0 with zero tokens when no request was sent; an empty answer's own price; absent, so unknown, when the request threw); `null` when any part is unknown |

## 7. What may be in a recording

- No secret, ever. Packages already keep credentials out of their documents and results; the recorder also passes
  every live line through the host's redactor before writing it.
- A published recording uses public sources only, chosen and checked before it is recorded.
- Blobs are kept whole. A recording too large for a static host replaces its `frame` lines with `frame.track` lines
  (a WebM per session), and only then drops frames; it never drops durable lines.

