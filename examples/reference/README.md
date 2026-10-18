# The reference assembly

One program that puts the open packages together and runs one job end to end on pi-durable. A host supplies seven
functions; `assemble.ts` wires them into a durable run, the recovery driver, the node runner, the browser and vision.
The defaults need no key and no network: a scripted model, an in-process tool, the browser's fake backend.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:reference
```

It prints the record, the receipts it cites, what each package did and the usage, and exits 0. `-- --json` prints the
same as one JSON object. `-- --dir <path>` keeps the run's directory, so a second process resumes what the first left.
`-- --chrome` drives a local Chrome instead of the fake (`CHROME_PATH`, default `/usr/bin/google-chrome`): this
process serves the job's pages as Chrome's proxy, and every other host fails to resolve. `-- --box local` or
`-- --box docker` runs the job's tools in a box of `@parcha/pi-transport` (`boxEnv`) while the run's store stays on the
disk: a local box's workspace is the run's `work/`; a Docker box is a container (`debian:bookworm-slim`, which Docker
pulls if it is not there) that the job's files are uploaded to. The box is destroyed when the run ends.
`-- --record <dir>` keeps the run as an `agentrun.recording/1` directory the run viewer (`apps/viewer`) plays. Before
it finishes one, the recorder scans every line, every text blob and the manifest with `scan.ts`, the one scanner the
repository's recording validator and the hosted gallery's gate import: a credential's shape or a machine path stops
it with what it found and where, and the directory is left without a manifest, so it is never a finished recording.

## The job

`job.ts`, small and fixed so the output is a constant:

1. `call search`: the host's tool returns two URLs. The tool door keeps each answer in `<run>/answers/`, under the
   admitted effect's `argsHash` (its input, node and idempotency key, so two steps that call one tool alike are two
   answers), before the result is committed, so a run resumed after a kill between the two takes the answer
   instead of stopping on the unknown call, and never sends it again. A call that was admitted and never sent stays
   unknown: the resumed run is refused with `FROZEN_EFFECT_UNKNOWN`.
2. `agent investigate`: the lead opens the first result with `run`, reads it with `browser_read`, reads `filing.png`
   from the workspace with `read` (vision serves the image), and submits `{ answer, citations }` citing the two
   receipt paths its tools returned. Like a model, it asks a read that errs again, three attempts in all. A page action
   a crash cut, or one the browser will not send again (`effect_unknown`, read from its JSON answer), is never asked
   again before the lead looks: it takes a snapshot, as the browser asks, and decides from the browser's
   `pendingEffect` details (the page when the action was sent, and now): applied, it goes on; not applied, it runs it
   again, three runs in all; cannot tell, it asks no more. The browser does not send those details yet, so today a cut
   action is always `cannot tell`, and the page action is never applied twice. A page it did not open is not read: the record then cites only the
   scan and says whether the page could not be opened or its outcome is unknown.
3. `judge verdict`: a scripted judge says whether the receipts support the answer.
4. `code finish`: the output.

## The host functions

`host.ts` declares them as one value, `Host`. `localHost()` gives the no-key defaults.

| # | Function | Who asks for it | `localHost()` passes |
|---|---|---|---|
| 1 | `models` | pi-durable's `models`, the node runner's agent | pi-ai's faux provider, answering from the job's script |
| 2 | `tools` | the workflow's `call` (`runEffect`), a resumed run's lookup of a call a kill left unknown (`answered`), the agent's extensions, the browser's provider and driver | the job's `search` and the answers it kept, no extra extensions, `FakeBackend` from `@parcha/pi-browser/testing` |
| 3 | `evidence` | the browser and vision, one sink for both record types | a JSON file per record under `<run>/evidence/<label>/`, named by its hash |
| 4 | `decisions` | the workflow's `judge` (`runJudge`), the browser's page judge (`classifyPage`) | the job's scripted answers; a page judge only when the fakes give one. Each answer's receipt is a row in the run's store (`agentrun.decisions`) before it acts, and a resumed run replays it instead of asking again |
| 5 | `status` | browser sessions and reconcile, vision looks and misses, workflow events | one JSON line per row in `<run>/events.jsonl` |
| 6 | `deliver` | the workflow's output | `<run>/out/record.json` |
| 7 | `credentials` | the browser's `redact`, the environment of a program vision starts | none; a started program sees only `PATH` |

Where the run lives (`RunPlace`) is the disk package's `AppContext`: `root`, `work`, `store` (`<root>/store`, holding
`run.sqlite`, which the package's readers take as a file; a directory whose store is at `<root>/durable`, where the
version before kept it, is refused with both paths named, and nothing runs). The run opens on a claim
over a plain directory, with the disk package's own file and shell tools confined to `work/`. `run()` takes another
environment for the tools as `env`, the disk run's own option; `--box` passes a transport box there.

Extensions install in this order: file and shell tools, the host's extensions, vision, the browser, the node runner,
the workflow's task (`createWorkflowExtension` from `@parcha/agentrun-pi/durable`). Then the run opens and pi resumes
what a killed process left, the workflow's task among them. The driver opens the journal once and, in that open, hands the
host each call a killed process left unknown (`reconcile`): the example looks each up with `tools.answered` (kept by the effect's
id), or runs it again with `tools.rerun` when that is safe, and reports the applied call once in the receipt the driver appends to
the effect's own calls. A call neither settles stays unknown and is refused. Each process raises the journal's generation once,
which a recording reads as a process. The browser reconciles its sessions; the workflow's task is
started, or reached when the open resumed it, and waited on; the record is delivered; every open browser session is
released, and the run is released. `run()` returns the task's outcome: `complete` with the output, `escalated`,
`refused` with a code and message, or `stopped`.

## Gates and cases

`gates.ts` checks the files a run leaves, structurally: files exist, JSON parses, counts and cross-references hold.
None of them judges prose. What ran is read from the run's store through the packages' own readers (`readJournal`,
`durableDoc`); `events.jsonl` is best effort (a killed process may never write a row) and is for people.

| Gate | Holds when |
|---|---|
| `record-matches-output-schema` | `out/record.json` exists, parses, and its record validates against the workflow's output schema |
| `citations-name-filed-evidence` | every string in the record that names a path under `evidence/` is a file there that parses and has `tool`, `args` and `status` |
| `no-failed-evidence-cited` | no cited receipt was filed `failed` |
| `fakes-called-once` | in `ledger.jsonl`, every tool call happened once across the run's processes; each turn of a conversation and each judge was asked at most once in each process (each row names its process by an id drawn at start); and a judge was asked again only after a process that died at its ask, before the answer was recorded |
| `browser-ops-ran` | in `ledger.jsonl`, a record that cites a browser read rests on a `page.run` and a `page.read`, and no more pages were judged than read. The lead may ask the browser again, so these rows are not counted once |
| `nodes-end` | the run's journal holds no step started and never committed |
| `browser-sessions-released` | the browser's inventory in the run's store holds no session |

```sh
npm run demo:reference -- --dir /tmp/run && node examples/reference/gates.ts /tmp/run
```

It prints one line per gate and exits 1 when one fails. From code, `gates(runDir, job)` returns `{ id, ok, detail }[]`.
When `ledger.jsonl` or the store is missing or cannot be read, or a ledger line does not parse, the gates that read it
fail and say so, and the others still report.
`localHost()` creates the ledger empty when it starts, so a run that called nothing still has one.

`cases/` holds synthetic cases, each a way out the packages already have:

- `login-wall`: the browser's page judge calls the page a login wall; the read is filed `failed` and the lead cites
  only the scan.
- `no-vision-route`: the lead takes no images and vision has no eyes; reading the scan is vision's typed miss, filed
  `failed`, and the lead cites only the page.
- `search-fails`: the host's tool throws; the workflow's task ends `refused` (`WORKFLOW_FAILED`, with the tool's own
  message), nothing is delivered, and `record-matches-output-schema` and `nodes-end` fail: the journal holds the
  search started and never committed.

A case is a `Case` (`gates.ts`): a job, the fakes it runs on (usually `job.ts`'s with one member changed), and what
its run must show: its status, the gates that fail, the tools whose receipts are filed `failed`. To add one, write a
file in `cases/` and list it in `cases/index.ts`; `examples/reference-rig.test.mjs` runs every listed case and the
reference job, then checks each against the gates. It also kills a run of the reference job after the browser read,
resumes it in a second process, and checks that run passes every gate.

## Swap a fake for a real part

Each fake is one member of `Host`. Build `localHost()`'s value and replace that member:

- Models: a pi-ai `Models` with a real provider, and its model as `models.lead`.
- Judge: `createJevRunner()` from `@parcha/agentrun-jev` as `decisions.runJudge` (it needs `TYPESAFE_API_KEY`).
- Browser: `browserbaseProvider()` from `@parcha/pi-browser/providers/browserbase` and `stagehandDriver()` from
  `@parcha/pi-browser/driver/stagehand` as `tools.browser`, with your prices. Leave `createDeadlineMs` unset: the
  browser's default (60 s) waits that long for a create whose answer a kill lost. `localHost()` passes 3 s for its fake,
  which answers in the same process.
- Tools: your own pi extensions in `tools.extensions`, and your tool server behind `tools.runEffect`.

## What it does not do yet

- Model tiers: one lead model.
- A cost fold: it prints pi's usage as it is.
- A tool gateway with grants: extensions pass straight through.
- Workspace custody: the disk package's confined tools, nothing more.
- The lead's own session runner: the workflow's LLM step runs on the node runner.
- A real browser by default. The fake backend opens on the first search result and returns `run`'s code unrun.

## Gaps it works around

Each is marked in the code with the package that owns it.

- The disk run's temporary directories are under `<root>/tmp`, which its confinement will not let a tool write, and a
  read that runs a program (a video through ffmpeg) writes there. `assemble.ts` keeps them under `work/.tmp` until the
  disk package's #380 lands. This example's PNG read writes no temporary file.
- The browser's `release` returns before its background task runs, and `waitForIdle` does not wait for background
  tasks. `assemble.ts` waits for the release tasks before it closes the run.
- The disk run's open resumes pi's pending tasks before the host can reconcile the browser, which asks to run first.
  A resumed workflow task would reach the browser before its sessions are reconciled. `assemble.ts` holds the task's
  steps until the reconcile has run, and until `start` has accepted this job's request: `start` refuses a request that is
  not the run's own with `RUN_STORE_BINDING_MISMATCH`, so a refused job never lets the saved task run.

## The entry as a demo's platform: `demo()`

A demo's `run.ts` is about twenty lines: its spec, its job, its fakes and one call. The entry reads the standard flags and runs the job on the no-key host.

```ts
import { demo } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import job from './job.ts';

await demo({ self: import.meta.url, spec, job, fakes });
```

| Flag | What it does |
|---|---|
| (none) | the job on fakes: $0, no key |
| `--live` | real models and services; refused unless the demo supplies them (`live`) |
| `--kill` | the spec's `kills`, in order, each ending one process; a fresh process resumes on the same directory |
| `--record <dir>` | an `agentrun.recording/1` directory, through the reference recorder |
| `--input <path\|json>` | the job's input; the job's own is the default |
| `--max-usd <n>` | stops the run past n dollars, metered on the recording's lines (default twice `expectedCost`); a run that finishes past it says so and exits 1 |
| `--provider <p>`, `--model <m>`, `--eyes-model <m>` | with `--live`: the models to use, handed to the demo's `live({ env, models })` as `{ provider, model, eyesModel }` (each absent when not given; the demo's sign-in plan decides what they mean). `--provider` needs `--model`; without `--live` they are refused |
| `--see-also <recording>` | links a finished recording of the same demo (a weak-eyes pass) in the manifest's `see_also`, by its directory's name and its manifest's title; repeat for more |
| `--local-chrome` | with `--live` and no Browserbase key pair: a Chrome on your own machine (`CHROME_PATH`). Browserbase is used only when `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are both set, decided before anything starts (a half pair is named, never used); a local Chrome is never chosen for you |
| `--fetch-sources` | fetches the demo's `sources.json` into the run's `work/` before the job runs (always with `--live`) |
| `--cache <dir>` | where fetched sources are kept by hash, so a re-run does not fetch them again (default `agentrun-sources` in the OS temp dir) |
| `--dir <path>` | keeps the run's directory |
| `--json` | the result as one JSON object |

### The spec

The parts of `demo.json` the entry acts on:

- `kills`: a list. Each entry is a named crossing `{ point, why }` or a storm `{ storm: { kills, gapMs } }`. A crossing entry may add `kind: "box"` (the whole machine or sandbox was taken away; the supervisor destroys the process's boxes with it, and the kill line says `box`), `target` (`"run"`, the default: the process the run lives in dies; `"tool"`: a box a tool made is destroyed once at the crossing, the run's process lives, no kill line is written, and the transport box lines record the loss) `n` (the nth time the crossing is taken, default 1) and `where` (`{ field: value }`: only a crossing announced with those info fields counts, and `n` is the nth matching one; a crossing is announced by whatever takes it with `cross(point, { info })`, and the crossing log records the info; the entry's own taps (the model, the judge, the tools' dispatch and return, the boxes, the filing) announce none, so a point such as `transport.tool.started` fires only in a demo whose own adapter calls `cross` for it, with `{ tool }` in the info, and `{ point: "transport.tool.started", where: { tool: "install" } }` is then the install step). A storm kills `kills` times, each at the first crossing taken once the process has run `gapMs` and has opened the journal and begun its first node (a kill earlier leaves a generation the journal never recorded); a named point is taken as named. The template's single `kill` is a list of one.
- `expectedCost`: dollars a live run is expected to cost; `--max-usd` defaults to twice it.
- `sites`: `{ <name>: { title, description, startUrl } }`. The agent gets `use_website`: a task for a site runs a child agent in a browser of its own, starting at `startUrl`, and a short report comes back. A request id runs once: a kill while the child works leaves the child recorded under `<site>:<request id>`, and the resumed run finds it instead of starting a second. A child has the browser and web tools only, never `use_website`.
- `sources`: `true` (the demo's `sources.json`), or a path (relative to the demo's directory, to the repository when it starts with `examples/`, or absolute): `sources.json` has two kinds of entry. `pages` are visited live by the agent (each with its URL, what it shows and its hand-check date): the entry passes them through untouched, never fetching or refusing them. `files` (or `items`) are the checked files `{ id, url, bytes, sha256, license }` the job reads. They are fetched into `work/` as `<id><extension of the URL's path>`, verified by size and hash (a file already there with the right hash is kept; one that is not the checked bytes is refused, naming what was checked and what came), on `--live` and with `--fetch-sources`. A no-key run uses the files the demo commits (`job.files`). A demo whose files depend on the input gives `sourcesFor(input)` instead (the same item shape, without `license`): only those items are fetched, and a no-key run that lacks their files is refused in one line naming `--fetch-sources`.
- `input`: `{ fixtures: { <name>: "examples/<demo>/fixtures/<file>.json" } }`: the demo's captures, each a name (`[a-z0-9-]`) and the JSON file that is the job's input for it. `--input <name>` runs the job on that capture. A path outside `examples/<demo>/fixtures/` is refused; on fakes a bare name that is not a capture (and not a file) is refused with the list of captures; `--live` reads the real thing.
- `boxes`: `{ kind: "local" | "docker", image?, runIn? }`. Docker is used only with `--live`: a no-key run uses a local box and starts no container. The provider is handed to the demo's tools as `context.boxes` (their second argument), with the crossings and transport lines below built in. A tool's `context` also carries `live` (false on a no-key run: one set of tools reads live or replays a capture) and the run's `place` (`{ root, work }`), where it reads the run's evidence files and the job's files. `runIn: true` also runs the job's own disk tools in a box of it.

### Crossings

A crossing is a named point the child takes; `kills[].point` names one, and the first time (or the nth) the child takes it, the child is killed with SIGKILL. A package adds its own through the same `cross` function (`vision.filing`).

| Point | Where |
|---|---|
| `model.request turn <n>` / `model.answered turn <n>` | the scripted model's request, and its answer, at the turn after n tool results |
| `judge.asked <label>` / `judge.answered <label>` | the judge's question and answer |
| `tool.dispatch <tool>` / `tool.returned <tool>` | a scripted tool is called and returns. Never a kill point: between the dispatch and the host keeping the answer nothing records what the tool did, and a kill there leaves the call unknown |
| `effect.kept <tool>` | the host has kept the tool's answer and the driver has not yet committed it. A kill point only when no other call is in that window. The resumed process settles the call from the kept answer: it is not sent again |
| `receipt.filing <tool>` / `receipt.filed <tool>` | an evidence receipt is about to be filed, and has been |
| `vision.filing` / `vision.filed` | a look is about to be filed, and has been. The eyes have answered by then and the answer is kept: a kill at `vision.filing` makes the next process file the kept answer and not ask the eyes again (the first of the packages' own crossings) |
| `event <source>.<type>` | each row of events the run reports (`event workflow.node.start`, `event browser.launched`, `event vision.look`) |
| `deliver.writing` / `deliver.written` | the delivery |
| `transport.box.create` / `transport.box.created` | a box is about to be made, and exists |
| `transport.box.exec` | a box command is in flight: started, its answer not yet read |
| `transport.box.destroy` | a box is about to be destroyed |

A crossing taken inside a tool call (`transport.box.*` from a tool that makes its own box) is never a `target: "run"` kill point, for the reason `tool.dispatch` is not. It can be a `target: "tool"` kill.

The transport box lines are live lines of source `transport`: `box.created` `{ box, provider }`, `box.killed` `{ box, crossing }` (written before the box is destroyed) and `box.ended` `{ box, provider, killed }`.

### The judge seam

Every demo's typed questions pass through one seam that carries Jev's limits and Jev's price, whoever answers: at most 50 requests and 40,000 tokens (in and out) over the run. The next request after a cap is reached is refused with `JEV_CAP_REACHED` and is never sent; a failed request counts, a refused one does not. The count is kept in the run's directory, so a resumed process continues it. An answer that reports usage and no price of its own is priced at Jev's public list price, $0.042 per million input tokens and nothing for output (`jev-1.12`; source: the TypeSafe cookbook, 2026-07); a price the answer reports is kept.

### The vision option

The entry files every look the vision guard or a read reports into the run's store: one `vision.looks` document per look key, each entry the whole `LookRecord` (`facts.key`, `kept`, `cost_usd`, `status`, `model`), the evidence path of the screenshot it was of as its receipt, and the image the eyes were shown as a blob in the recording. The recording's counters then read `paid.vision` and the eyes' cost. An entry also carries the data set's `item` it belongs to (`DemoOptions.itemOf(path)`), the `miss` { code, reason } when the look failed, and each image's frame second `at`; every read leaves one live `vision`/`shown` line (its arguments, the media facts and the captions with the images). A demo passes only its eyes: `fakes.vision(host, running)` returns `{ eyes }` on fakes (with a lead that takes only text, every image a read or a screenshot makes goes to them), and the live parts' `vision(host, running)` returns the real eyes. Both are `Partial<VisionAdapterOptions>`, one seam; the entry's own filing is always on, and it calls a demo's own `onLook` and `onMiss` after its own and never replaces them.

### Holding the kill at `vision.filing`

A kill entry may carry `hold` (and `waitMs`, default 3000): the filing that is the nth, and those that reach `vision.filing` after it, are parked, never completed, until `hold` of them are parked or `waitMs` has passed, and then the process is killed. Several answers are by then kept in the journal and none is filed, so the resume files each kept answer: "6 kept, nothing paid twice". Without `hold` the kill is at the first crossing.

### Kills that never land

A planned kill whose crossing the process never takes (a typo, or a demo that does not reach it) is not hidden: the result's `unlanded` lists it, the summary says so, and the command exits 1.

### What a demo hands the entry, besides its job

`fakes.extensions` (pi extensions a no-key run installs beside the host's own) and `fakes.vision(host, running, { input, place })` (the demo's vision lane on fakes, handed the input the run was given and the run's `place` (`{ root, work }`, as a tool's context has it), as `LiveParts.vision` is: an eyes object, limits, an evidence sink; `running.harness` is undefined until the run is open). `DemoOptions.result(record, { dir, keep })` returns `{ json, title }`: the entry writes the run's result line and its blob from it (`agentrun.cited/1` for a payoff that cites what it read) instead of the raw delivered record; `keep` stores a file in the recording's blobs and returns its SHA-256.

### What a live child's environment holds

On `--live` the child is given exactly the environment names `demo.json` declares (every `env` in `keys`, the members of a `oneOf` group included, and in `programs`), plus the process basics (`PATH`, `HOME`, `TMPDIR`), and nothing else: an undeclared variable in the parent's environment never reaches it, so the spec and the child's environment cannot drift. A no-key run passes the demo's own `DEMO_*` settings (no secret). `LiveParts.vision(host, running)` is built the way `fakes.vision(host, running)` is: one seam for both.

### `manifest(context)` and `source.run`

A demo may pass `manifest({ dir, record, input, live, models })` (`models` is what the live parts reported choosing, `LiveParts.models`; absent on fakes): it returns fields the entry adds to the manifest (a demo's own sources, slice or models). A name the entry writes itself (`format`, `source`, `result`, `providers`, `see_also`, `job`, `store`, ...) is refused. `source.run` is the demo's name, plus the input file's name when `--input` named a file (`apollo-apollo-11`); a demo's `run.ts` reads `demo()`'s result for its own summary lines.

### The child as an app module

`child-app.ts` is the child as a `pi-durable-disk run --app` module, so a run has one open path (the claim, the fence, the stdin mount token, run.json's holder, the seal and restarts are the disk package's): `DEMO_ENTRY=<file URL of the demo's run.ts, which exports its \`options\`> pi-durable-disk run --dir <dir> --app examples/reference/child-app.ts --id <id>`. It builds the host exactly as the entry's own child does (the same environment, which every order carries from the supervisor, `DEMO_ENTRY` and `DEMO_NAME` included, so a place needs no wrapper: `PLAN`, `KILL_REQUEST`, `RECORD_DIR`, `INPUT`), drives the job in `onOpen`, prints its outcome line, writes the run's final status `done` with the record and the store's hash (a box place has only run.json), releases the run and exits 0. A kill -9 and the same command again resumes the run.

### The default input per mode, and why a run stopped

`Fakes.input` is the input a no-key run takes when `--input` names none (a smaller slice than the job's own, which stays the live default); `--input` always wins. When the last process did not complete, the summary prints `  stopped: <its reason>` (a missing source file, a refused workflow).

### Secrets in a recording

`--record` knows the exact secret values and takes them out: the values of the environment names the demo declares, and the sign-in's tokens (the `access`, `refresh` and `idToken` strings and an API-key credential's `key` in `$AGENTRUN_HOME/auth.json`, else `~/.config/agentrun/auth.json`; a missing file is fine, an unreadable or non-JSON one fails the record before the run starts). Every recorded line, text blob (redacted before it is hashed and named) and the manifest has each value replaced by `[redacted]`, and when the recording is finished a scan of every file in it refuses one that still holds a value (its manifest is removed), naming the key and the file, never the value. A sign-in refreshes its access token during a long run: the sign-in file's mtime and size are checked before each write, and a changed file is read again, so a refreshed token is redacted from then on (the redaction uses every value seen), and the scan at the end reads the file once more and refuses a recording that holds a token the recorder had not yet seen (an event written just before the refresh). The supervisor hands the child `AGENTRUN_HOME` (the directory of the sign-in file it resolved), the one name added to the child's environment beside the declared ones, so a child that signs in uses the file the recorder reads. A recording without a sign-in is unchanged. Strings under 12 characters are not treated as secrets.

### Where a kill request is written, and who may make one

The place answers where attempt n's runner writes its kill request (`Place.requestFile(attempt)`, the same file its `signals(attempt)` reads; the child never derives it, and the entry uses a file in its own scratch for a place that has none). The request is written durably: a temporary file beside it, synced, renamed into place, the directory synced. The supervisor mints a random 16-byte nonce for each attempt and puts it in the order's environment as `KILL_NONCE`; the child reads it once when it loads and removes it from its environment before anything starts (so pi's commands, which inherit the process's environment, never get it), and writes it into its request. The supervisor honors a request only when its nonce is the attempt's, and writes a `kill.request.ignored` host line (the point and `no nonce` or `wrong nonce`, never a value) for one that is not. The place knows nothing about the nonce: a signals reader passes every request field through. This stops a stale or other attempt's process and a command running as another user from putting a kill line in a recording; it cannot stop a command running as the instance's own user, which can read `/proc/<pid>/environ`.

### One run id per invocation

The supervisor mints one run id per invocation, `<demo name>-<8 random hex>`, the same across that invocation's processes (every kill and its resume), and gives it to the place as `paths.id` and to each process as `RUN_ID` (a supervised process without one refuses to start: no fixed key ever reaches a place). A second run of one demo on a shared disk never finds the first's `run.json` `done` or its old signals files. `DemoResult.runId` says which. The manifest is written before the place is released (a release may delete the run's tree).

### The place's own record, as `run.json` lines

A place that has `status()` reports its reading of the run (`{ record }`, a disk place's `RunRecord`), and the supervisor writes it as a `run.json` host line: `gen` is the record's generation and the rest is the record verbatim, only when its `status`, `generation`, `holder` or `sealedSeq` changes (RECORDING.md's host row). It is read at the boundaries (a runner's start and exit, a kill, a result) and on a 2 s tick while a runner runs; a place without `status()` writes none, and a reading that fails or is not a run record (it needs a `run` and an integer `generation`) writes none and never fails the run. The recorder replaces `holder.host` and `holder.bootId` with labels (`host-1`, `host-2`, `boot-1`, ... in order of first appearance, the same label for the same value within one recording), so a takeover by a new box still shows a new holder; and this machine's own host name and boot id (`os.hostname()` and `/proc/sys/kernel/random/boot_id` where it exists) are in the recorder's exact-value redaction, wherever they would appear.

### When a place's signals fail

A place's `signals(attempt)` iterator may END with `{ kind: 'signals-failed', code, message }` (a store that went away, a credential that expired), or its reader may throw. The supervisor writes a `signals.failed` host line `{ gen, code, message }` and ends the attempt as it does after a kill that failed: it waits for that runner to exit and starts no further process (`DemoResult.failedSignals`, the summary, exit code 1). The pump has a `.catch`, so nothing in it can end the supervisor. Every message the supervisor writes about a place's failure (`kill.failed`'s and `signals.failed`'s) has any absolute path outside the run's directory replaced by `<path>` (the run's own paths stay) and is capped at 240 characters before the recorder's exact-value redaction runs on the line.

### The operator's kill

`--operator-kill <file>` names a control the supervisor owns (never the child's request file): when a process is running and the file appears, the supervisor removes it, writes a `kill` host line with `crossing: null` and `label: "operator"`, kills through the place, and resumes as usual. A kill still planned for the attempt it ended is planned for the next, so a planned kill is not lost. The path must not exist when the run starts (a stale file would kill the first process); a page's server makes it with any process of the same user, so the path belongs in a directory only the operator can write. The operator may kill anywhere, so a kill inside a tool's dispatch leaves that effect unknown, as any kill there does.

### A demo with no browser

`browser: false` in demo.json (`DemoSpec.browser`) means the entry creates no browser, live or on fakes: `--live` then needs no Browserbase key and no Chrome (`chooseBrowser` is not asked), the live parts' browser is ignored, and a page tool call fails with `this demo has no browser` rather than a missing key. The default (a browser) is unchanged.

### Blobs appear whole

Each blob is written to a temporary file in the recording's `.spool/` (`blob-<sha>.<ext>.tmp-<pid>`), synced, and renamed into `blobs/`, so a viewer following a live run finds it absent or whole, and a process killed mid-write leaves a temporary file in `.spool/` and never a torn blob; a blob already there is left alone. No validator or gate change is needed: `.spool/` is never published.

### Code mode (opt-in; it runs model-written code)

Code mode needs one extra install: `@earendil-works/pi-codemode`, which the repository declares as a root devDependency (`npm ci` installs it). A box that installs the entry's devDependencies has it; one that installs only the packages does not.

`DemoOptions.codeMode` (or `codeMode` in demo.json; `true`, or `{ timeoutMs, outputChars }`) installs one `code` tool, after the vision handle exists. Its script runs in pi-codemode's sandbox, QuickJS compiled to WebAssembly, and gets two things: `tools.bash({ command })`, which runs a shell command through the call's own environment (`api.env.exec`) in the run's `work/` and resolves `{ exitCode, output }`, and `vision.see(...)`, the composed vision handle's global for that call (a demo needs no wiring of its own). Nested calls never enter the model's context: only the script's output and return value do. Off by default.

What the sandbox can reach: the two functions above and nothing else. It has no network, no `fetch`, no `process`, no `require`, no timers, no `WebAssembly`, and no file access of its own; the script is bounded by a deadline (5 minutes by default) and by the VM's own limits. What it cannot stop: a command `tools.bash` runs does whatever the run's environment lets a shell do (the claim's confined environment, the same one the agent's own bash tool has), so turn code mode on only where the agent's bash is allowed. The tool is not replay-safe: a call a crash interrupted is not run again, because the commands it ran may have had effects.

### Live tools

`LiveParts.tools` is the same name -> function map as `Fakes.tools`. On `--live` the entry's effect door (the same wrapper: evidence filing, receipts, kill crossings) dispatches to it. A tool missing there runs from `fakes.tools` only when demo.json's `tools` entry for it says `local: "fakes"`; otherwise the call fails `no live source for <tool>`. A demo that supplies no `tools` keeps the old behavior (every tool runs from `fakes.tools`). On fakes nothing changes: `fakes.tools` is the only source, and live tools are never looked at.

### A live run and its replay are one file

`--record` follows the run: a follower in the supervisor reads each process's spool and appends the lines to `events.jsonl` as they become safe to place, whole lines in one append, in section 3's order (`t`, ties by (commit, order), then seq). A line is placed once its `t` is a second behind the recording's clock (the time every writer has to get it to a spool), and a memo once a later commit has appeared. Blobs are written whole before any line names them, and `manifest.json` is written last, so a viewer in follow mode (polling `events.jsonl`) sees the run as it goes and the finished file is the replay. `finishRecording` completes the file: what was not placed is appended, and a line that arrived later than the hold is put in its place by replacing the file whole (a rename); the finished file always equals a fresh export of the spools. Every line the follower places goes through the supervisor's redactor (with the latest union of secret values), so a token a sign-in refreshed is placed clean; and if a secret was already in the file as it was placed (a viewer could have fetched it: a hold of 0, a slow refresh), the recording is refused though the finished file would be redacted. The manifest's `job` blob (`{ workflow, input, files: [names] }`, the input the run took) is written whenever the entry knows the job, so every recording can draw its workflow graph.

A place that has `status()` reports its reading of the run (`{ record }`, a disk place's `RunRecord`), and the supervisor writes it as a `run.json` host line: `gen` is the record's generation and the rest is the record verbatim, only when its `status`, `generation`, `holder` or `sealedSeq` changes (RECORDING.md's host row). It is read at the boundaries (a runner's start and exit, a kill, a result) and on a 2 s tick while a runner runs; a place without `status()` writes none, and a reading that fails or is not a run record (it needs a `run` and an integer `generation`) writes none and never fails the run. The line is an allowlist (`run`, `status`, `generation`, `sealedSeq`, `wakeAt`, `holder { driver, host, bootId, pid, since }`, `heartbeatAt`, `updatedAt`): every other field (a sandbox id, a name, a mountpoint) is dropped, and a `detail` is kept only as text of at most 240 characters with every absolute path replaced by `<path>`. The recorder replaces `holder.host` and `holder.bootId` with labels (`host-1`, `host-2`, `boot-1`, ... in order of first appearance, the same label for the same value within one recording), so a takeover by a new box still shows a new holder; and this machine's own host name and boot id (`os.hostname()` and `/proc/sys/kernel/random/boot_id` where it exists) are in the recorder's exact-value redaction, wherever they would appear.

### Crossings on a live host

The judge and the model of a `--live` run have the crossings the fakes' have, by the same names and counting as `tapFakes`: `judge.asked <label>` and `judge.answered <label>` around each typed question, and `model.request turn <n>` before and `model.answered turn <n>` after each request (n counts the tool results so far). A kill at one lands with a paid question or request in flight; the judge seam's caps are outside them. They are put on the live host after the live parts are merged in, so a live part's own judge and model are tapped, not replaced.

### The demo's own Jev caps, and a model whose key is not declared

`models.judge.caps` in demo.json (`{ requests, tokens }`) sets the demo's own Jev caps. The defaults are 50 requests and 40,000 tokens; each given value is a positive integer at most 4 times the default (200 and 160,000), and anything else is refused at load, before any process starts. The judge seam still refuses the request after a cap is reached (`JEV_CAP_REACHED`, never sent), and `--max-usd` still applies.

A model whose provider needs a key the demo does not declare is refused at load too, naming the group to add: no key is implied, and demo.json stays the one list the child's environment and the setup prompt read. The first case is `models.judge` (Jev): its demo needs a `keys` group with `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`.

### Delegation and revoke lines

A place whose `status()` also returns `delegations` (`[{ clientId, inodeId, path, isOrphaned, isPending }]`, the Archil delegations of the run's own path) gets a `delegation` host line each time one appears or its orphaned or pending state changes (`gen` is the run's current generation; the first line with `isOrphaned` marks the first reading that SAW the orphan, not the instant), and none while it is stable. A place whose `recover()` returns `{ revoked, ms }` (the old holder's delegations that the takeover revoked, and how long the whole takeover took) gets a `revoke` line `{ gen, revoked: [{ clientId, inodeId, path, isOrphaned }], ms }`. A place without them writes none.

The judge and the model of a `--live` run have the crossings the fakes' have, by the same names and counting as `tapFakes`: `judge.asked <label>` and `judge.answered <label>` around each typed question, and `model.request turn <n>` before and `model.answered turn <n>` after each request (n counts the tool results so far). A kill at `judge.asked` or `model.request` lands before the question or request is sent (the planned kill parks the process there), and one at `judge.answered` or `model.answered` lands after the provider has answered and before the run keeps the answer; neither stops a paid request while it is outstanding, so they test the resume's paying once, not recovery from a cut request. The judge seam's caps are outside them. They are put on the live host after the live parts are merged in, so a live part's own judge and model are tapped, not replaced.
