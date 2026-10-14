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
/** Joins the spools of every process of a recorded run into `events.jsonl` and writes `manifest.json`. */
export { finishRecording } from './record.ts';
/** The code a recording was cut from: repository, commit, and each package's version. */
export { codeOf } from './record.ts';
/** The store export the recorder reads the run's commits through; it throws if this build of the package lacks it. */
export { packageCommitRecorder } from './record-store.ts';

/** A job: the workflow, its input, and the files the run's tools find in `work/`. */
export type { Job } from './assemble.ts';
/** How a job ended, with the run's generation and what it spent. */
export type { RunResult } from './assemble.ts';
/** The options `run` takes: the run's `env`, and `vision` options merged over the example's. */
export type { RunOptions } from './assemble.ts';
/** Where a run lives: id, root, `work/` and the store. */
export type { RunPlace, Host, LocalHost, Fakes, StatusEvent, BrowserPlane } from './host.ts';
/** What a recorder writes: live and host lines, memos and blobs. */
export type { Recorder, Header } from './record.ts';
