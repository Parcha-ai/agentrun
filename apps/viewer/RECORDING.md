# agentrun.recording/1

Draft 10, 2026-10-14. The format the run viewer in this directory plays. A change to a field's meaning is
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
  code: { repo: string; commit: string; packages: Record<string, string> };   // name -> version
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
  baseline?: { recording: string; label: string };
                                      // another REAL agentrun.recording/1 directory (relative path or URL) whose
                                      //   counters show beside this one's; never typed-in numbers
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
  after any kill. What a kill can lose is the lines of the ONE commit in flight: the commit listener must not block,
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
- **A reader finds it without a field.** When a generation's first snapshot line has a commit `S` below a commit
  already seen, every earlier durable line with a commit above `S` is the lost branch. The validator accepts that drop
  only when the same generation carries a `transport.moves` record of kind `restore` whose `head` is `S + 1`; any
  other drop is refused. Every `transport.moves` record carries a top-level `head`: the sequence the target's first new
  commit takes, after any replay. A move's `head` equals its `seal.head`, and `S` equals the highest commit seen
  before it (no drop). A restore that replays the host's shipped commits carries `replayed { from, to }` and its
  `head` is `to + 1`. The host writes a commit's lines only after it has appended that commit's frame to its log, and
  the lines travel in the same frame as the writes, so a streamed recording's lines never run ahead of the log and a
  restore that replays the whole log has no lost branch. When `to` is below the last commit seen (lines recorded
  another way, or a log the restore did not replay to its end), the gap `(to, last seen]` is a lost branch under the
  same rule: counted, never hidden, accepted on that restore record. A restore from the checkpoint alone has `head` equal to `checkpoint.head`. In every case the
  generation's first non-snapshot commit equals `head`, and the record's own commit is at or above it.
- **State.** A generation's snapshot is the whole state at `S`: a reducer resets at the generation's first snapshot
  line, and a `(doc, key)` the snapshot does not carry no longer exists.
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
| workflow | `agentrun.driver` (generation, revision, notes); `agentrun.effects` (status `unknown`, written at admission before dispatch, then `completed`; the first revision is the admission; intent and outside calls: each call is the record the host's effect adapter passes to the driver's `call`, `{ outcome: "applied" | "failed" | "unknown", ... }`, written only when the host reports it); `agentrun.receipts` (an agent's paid tool calls, one entry per tool and argsHash); `agentrun.decisions` (receipts, `run_key`); `agentrun.record` (a delivered record and its attempts); `agentrun.node`, `agentrun.nodes` (the node runner's index); `agentrun.gate`; `agentrun.workflow`, a pi task: in process, every write of the task at its commit (created with its request, the workflow as run and its input, so a graph draws from the start; then its state; then its outcome); in a bare export, its current record once at the export's last commit | `WorkflowEvent` `{ type, label, detail, executionPath }`: `node.start`, `node.end`, `effect.attempt`, `effect.poll`, `effect.failed`, `effect.late_settled`, `ask.evaluated`, `judge.answered`, `verify.answered`, `route.chosen`, `escalate.evaluated`, `loop.exited`, `code.patch` |
| pi | conversation entries (messages, tool calls and results; image blocks as blobs), memos (`pi.memo`), tasks (`pi.generation`, `pi.tool`), usage | `run_start`, `turn_start`, `turn_end`, `message_end`, `tool_execution_start`, `tool_execution_end` (streaming deltas dropped) |
| browser | `browser.sessions`, `browser.inventory` (custody records) | `SessionRow` on `launched`, `updated`, `released`; `EvidenceRecord` (body as a blob); `frame` (`{ session, provider, w, h, mime: "image/jpeg" }`, one JPEG blob; at most 10 fps at 800 px); `frame.gap` (`{ session, from, reason }`, reason `process_killed`, `credential_on_page` or `session_released`; no frame is kept while a credential or a code is on the page); `frame.track`, optional, written at export (`{ session, fps, from, to }`, blobs: a WebM and its index). Every frame line carries the event-level `conv` of its session |
| vision | a `vision.*` document where the host files each `LookRecord` (the durable source for looks paid and their cost); the look memos `vision:look:<key>` only as live memo lines (section 3.1) | `LookEvent`, `MissEvent` |
| transport | `transport.moves`, one key per move id, written once in the commit the TARGET runner makes when it opens the moved store: `kind` (`move` or `restore`), epoch, `from` and `to` (`{ environment, provider, box }`), drain, ship and take ms, bytes, `stopped` (the attempts a kill or failure ended before landing), the placement id; `head`, the target's first new commit's sequence after any replay; a move's `seal` and a restore's `checkpoint` (`{ head, sha256, bytes }`, the checkpoint also `at`), and a replayed restore's `replayed { from, to }`. Hops and flights fold from it. A move continues the commit sequence; a restore starts it again (3.2) | box created and ended, and the session token, as live lines |
| host | | the supervisor's, all with no event-level `gen` (3.1): `process.started` (`gen`); `kill` (`gen`, `label`, `crossing`: `{ point, n }`, the named crossing the kill landed on and its ordinal, or `null` for a kill at no named crossing); `result` (`gen` of the process that delivered, `blob`, `title`), written when that process exits with the delivery made |

## 6. The counters strip (the same for every demo; every counter is folded from durable lines)

**Snapshot lines are state, not events.** If the commit in flight at a kill held an effect's completion, the next
process's snapshot shows that effect completed under the NEW generation; a per-generation fold would count it as a
dispatch there. So a counter that folds events by generation (repeated, asked twice, judge re-asked) skips snapshot
lines, and a count of finished things (paid calls made, unknown at the end) reads the latest value per `(doc, key)`,
snapshots included. A lost branch (3.2) is events, not state: the per-generation folds include it.

| counter | folded from |
|---|---|
| paid calls made | per source, then summed: workflow effects that reached `completed` (once per id, by construction; plus a lost branch's completions, 3.2); plus the agent's paid tool calls, `agentrun.receipts` entries (one per tool and argsHash); plus browser, vision and transport from their own rows |
| repeated | per call, never across calls. A workflow effect: its outside calls (section 5) are read across every line of the effect's id, a lost branch included (3.2), and a call belongs to the generation of the line it first appears on; repeated is an `applied` call in a later generation than an earlier `applied` one of the same id. An effect whose host reports no calls has repeated NOT MEASURED: the strip says so, never 0. Two effect ids with one intent are two calls. An agent's tool call counts only when it is PAID: the run holds an `agentrun.receipts` entry for its `(tool, argsHash)`. That receipt key is its identity, run-wide (an identical call in any conversation is answered from the receipt, `reused`, and skipped); repeated is a second paid execution (not `reused`, not `refused`) of one key in a later generation than one that completed. A tool with no receipt (a read, a stateful tool whose arguments do not name what it read) is not a paid call and never counts here; the browser's own paid actions count from its own rows |
| asked twice | a paid call made twice in ONE generation, which no kill explains, counted apart from durability: two `applied` calls of one effect id, or a second paid execution (not `reused`, not `refused`) of one receipt key |
| unknown | effects still `unknown` at the end of the run. While the run goes, an `unknown` effect whose admitting generation is alive is "in flight" |
| judge asks | `agentrun.decisions` rows, split answered and failed (a row with `error`); re-asked = more than one answered row for one `decision_id` and `run_key` |
| model turns | committed = assistant entries in pi's conversations (durable). Re-asked is NOT in the store: a turn a kill cut resumes the same `pi.generation` task, with no new task and no attempt count. So re-asked folds from live `turn_start` lines per process for the same turn, shown as "observed", never proven |
| processes | the supervisor's `host` `process.started` lines (written outside the killed processes). `agentrun.driver`'s generation counts journal opens and is not used for this |
| cost | usage and priced parts; `null` when any part is unknown |

## 7. What may be in a recording

- No secret, ever. Packages already keep credentials out of their documents and results; the recorder also passes
  every live line through the host's redactor before writing it.
- A published recording uses public sources only, chosen and checked before it is recorded.
- Blobs are kept whole. A recording too large for a static host replaces its `frame` lines with `frame.track` lines
  (a WebM per session), and only then drops frames; it never drops durable lines.

