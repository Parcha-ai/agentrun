// The reference assembly as one import, for another example that wants the same pi-durable host: its own job and its own
// fakes, this file's wiring. `import { run, placeAt, localHost } from '../reference/index.ts'`. The names below are the
// surface; the other files of this directory are the example's own and may change.

/** Runs a job on a place through the open packages (pi-durable on a plain directory, the workflow's task, the browser and vision) and returns how it ended. A second call on the same place resumes the run. */
export { run } from './assemble.ts';
/** A place for a run: a directory with `work/`, the store's path and the run's id. Pass a path to keep it, or nothing for a fresh one under the temp directory. */
export { placeAt } from './assemble.ts';
/** The run's id, and the key its workflow's task and journal are kept under. */
export { RUN_KEY } from './assemble.ts';
/** The no-key host: scripted models, tools, judge and pages from a `Fakes`, a ledger of every fake call, and the events of the run written under the place. Give `recorder` to record the run. */
export { localHost } from './host.ts';
/** A recorder for this process of the run; pass it to `localHost` as `recorder`. */
export { openRecorder } from './record.ts';
/** The supervisor's writer for a recording: the host lines (`process.started`, `kill`, `result`) of a run's processes, from outside them, with no event-level `gen` and a `seq` of its own. */
export { openSupervisor } from './record.ts';
/** Joins the spools of every process of a recorded run into `events.jsonl` and writes `manifest.json`. */
export { finishRecording } from './record.ts';
/** The code a recording was cut from: repository, commit, and each package's version. */
export { codeOf } from './record.ts';
export { keepBlob } from './record.ts';
/** The store export the recorder reads the run's commits through; it throws if this build of the package lacks it. */
export { packageCommitRecorder } from './record-store.ts';

/** The cost of the run a recording's lines record, for the manifest: `usd` is the sum of the priced parts, and null while any part is unknown (never 0). */
export { cost } from './fold.ts';

/** A job: the workflow, its input, and the files the run's tools find in `work/`. */
export type { Job } from './assemble.ts';
/** How a job ended, with the run's generation and what it spent. */
export type { RunResult } from './assemble.ts';
/** The options `run` takes: the run's `env`, and `vision` options merged over the example's. */
export type { RunOptions } from './assemble.ts';
/** Where a run lives: id, root, `work/` and the store. */
export type { RunPlace, Host, LocalHost, Fakes, StatusEvent, BrowserPlane, Rerun, Delivery, LedgerRow } from './host.ts';
/** What a recorder writes: live and host lines, memos and blobs. */
export type { Recorder, Supervisor, Header } from './record.ts';

/** The reference entry as a demo's platform: a demo's `run.ts` is its spec, its job, its fakes and this call. It reads the standard flags (`--live`, `--kill`, `--record`, `--input`, `--max-usd`, `--local-chrome`, `--dir`, `--json`) and runs the spec's kills through a supervisor. */
export { demo } from './demo.ts';
/** What the entry acts on in a demo's `demo.json`: its `kills`, `expectedCost`, `input` and `boxes`. */
export type { DemoSpec, KillSpec, CrossingKill, StormKill, BoxSpec } from './demo-spec.ts';
export type { ToolContext } from './host.ts';
export type { DemoOptions, DemoResult, LiveParts } from './demo.ts';
/** The browser a live run drives, and the spend cap and kill plans the standard flags give. */
export { chooseBrowser, killsOf, maxUsdOf, parseInput, plansOf } from './demo-spec.ts';
/** A crossing function and the taps that put the crossings at the host's seams: a package adds its own crossing (`vision.filing`) through the same function. */
export { crossings, tapFakes, tapHost } from './crossings.ts';
export type { Cross } from './crossings.ts';
/** The box provider the entry hands a demo, with its crossings (`transport.box.exec`: a box command in flight) and transport box lines built in. */
export { tapBox, BOX_CROSSINGS } from './boxes.ts';

/** The judge seam: Jev's caps (50 requests, 40,000 tokens; the next is refused with JEV_CAP_REACHED, a failed request counts and a refused one does not) and Jev's public list price, for every demo. */
export { capJudge, jevCost, JEV_CAPS, JEV_LIST_PRICE } from './judge.ts';
