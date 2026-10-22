// The place seam (settled with the disk lead and pt-modal): where one session lives, and how its process starts, stops and restarts. The supervisor in `demo()` decides when to kill, writes the kill line
// first and is the same for every place; a place decides how: a pid kill for a process, the provider's destroy for a box. Implementations come from the packages
// (pi-durable-disk: a local claim on a plain directory, an Archil claim; pi-transport: a box runner that also moves the session); this file defines the type and the
// one place every machine has, the local one.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunPlace } from './host.ts';

/** How a runner ended. `outcome` is what the child reported on its way out: how the run ended, the record it delivered and the hash of its store (the supervisor reads nothing under the run's directory). */
export type Exit = { exit: number | string | null; signal: string | null; outcome?: { status: string; generation: number | null; code?: string | null; message?: string; record?: unknown; result?: { json: unknown; title: string }; models?: Record<string, string>; storeSha256?: string }; stderr: string };
/** One process of the session in a place. `epoch` is the place's lease epoch (1 for a place with no lease; a box restore raises it). */
export type Runner = { epoch: number; pid?: number; exited: Promise<Exit> };
/** What a runner is handed: its number in the run, its environment (the run's directory, the kill plan, the mode), and, for a place whose runner opens a claim, the per-attempt
 *  mount token on its standard input: never in argv or env. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };
export type MoveReceipt = Record<string, unknown>;
/** What a runner announces to its supervisor: a crossing it took, or a request to be killed at one (a child parks at a planned crossing until the supervisor's kill arrives, so the
 *  latency of reading it from a remote place is acceptable). `info` carries what the place knows of the crossing (`gen`, `box`, `tool`, a transport crossing's `session` and `epoch`). */
export type PlaceSignal = { kind: 'crossing' | 'kill-request'; crossing: { point: string; n: number; pid?: number; info?: Record<string, unknown> }; /** The attempt's nonce the runner wrote into its request (a place passes every request field through): the supervisor honors a kill request only with the nonce it minted for that attempt. */ nonce?: string } | {
  /** A place's signals may END with this: it could not keep reading (a store that went away, a credential that expired). The supervisor writes a `signals.failed` host line and ends the attempt as it does after a kill that failed. */
  kind: 'signals-failed'; code: string; message: string };

/** A delegation of the run's own path (an Archil place): who holds it and whether it is orphaned or still pending. */
export type PlaceDelegation = { clientId: string; inodeId: string | number; path?: string; isOrphaned: boolean; isPending?: boolean };

/** A box place's recording, brought home (the one seam for a place whose child writes its spool inside the place: a disk place, a transport box). `dir(attempt)` is the recording directory as the child sees it inside the place (the place rewrites the order's `RECORD_DIR` to it; the recording's clock reaches the child as the order's `RECORD_STARTED`,
 *  which the child writes into its own `.spool/` when it has none, so a place writes nothing into the run's disk). `bringHome(into)` is idempotent: it pulls what is new from the place into the host recording directory `into`: first the blobs not
 *  yet home (hash-checked, written to a temporary name beside their final one, synced, renamed), then the new bytes of `.spool/*.jsonl` up to the last whole line. It throws an error with a `code`: `BOX_GONE` (the box is gone), `CARRY_FAILED` (a transfer
 *  failed in a box that is still there), `BLOB_MISMATCH` (a blob whose bytes do not hash to its name; it is skipped and the rest comes home first). The supervisor drives it: every status tick while a runner runs, and once with `final: true` after the runner
 *  has exited, before the follower closes, the manifest and the release. A place reads its `dir` by any means that never takes the run's claim. The child's recorder syncs its spool after each batch of lines, so a lost box loses less. For a disk place `dir(attempt)`
 *  sits inside the run's directory (`runs/<id>/record/<attempt>/`), so the delegation covers it and the sweep removes it. */
export type RecordHome = { dir(attempt: number): string; bringHome(into: string, options?: { final?: boolean }): Promise<void> };

/** The run's own files during a place's unheld window (disk's K9 `UnheldRun`, the members the harness uses): K8's reads, and a
 *  create-only `put` that answers an error with code `EXISTS` when the path is there, writing nothing. A window takes no secret. */
export type UnheldRun = {
  readonly signal: AbortSignal;
  read(path: string): Promise<Uint8Array | null>;
  list(dir: string): Promise<string[]>;
  put(path: string, text: string): Promise<void>;
};
/** The start a place's unheld window is for (disk's K9 `UnheldStart`): its attempt, and `box`, exactly the `HOST_BOX` that start
 *  makes (absent when the place hands none over). */
export type UnheldStart = { readonly attempt: number; readonly box?: { readonly provider: string; readonly key: string; readonly run: string } };
/** The supervisor's tap of a place's host boxes (H3), handed to a place of the demo's own: a place whose host driver makes boxes
 *  (disk's `boxHost`) passes it `provider(...)` and its own `unheld` hook `unheld`, both or neither, so each host box's life is in the
 *  recording by its run-wide label. `unheld` refuses a start with no host box: wire it only with the tapped provider. */
export type HostTap = {
  /** The provider the place's host driver makes its boxes with, tapped: the same type out as in. */
  provider<P extends { readonly name: string }>(provider: P): P;
  /** The place's unheld hook: it notes the start's host box (a pending entry of its own) and returns no environment. */
  unheld(run: UnheldRun, start: UnheldStart): Promise<void>;
};

export type Place = {
  /** For the recording's lines and the README: `local`, `box:docker`, `archil`. */
  name: string;
  /** The session's paths in the place: id, root, work, store. */
  paths: RunPlace;
  /** A place whose runner opens a claim (Archil) mints the mount token of each attempt itself: the supervisor passes what this returns on the runner's standard input, never in argv or env. The local place has none. */
  token?(attempt: number): string | undefined | Promise<string | undefined>;
  /** What this place can lose: `process` always, `box` when it is a machine of its own. */
  kills: ReadonlyArray<'process' | 'box'>;
  start(order: RunnerOrder): Promise<Runner>;
  /** The crossings and kill requests of attempt `attempt`, as they are announced; the supervisor stops reading when the runner has exited. The local place reads the files its child writes; a box place reads them from the run's disk (over S3 for a remote one). The supervisor reads nothing under the run's directory itself. The iterator's `return()` must end a pending `next()`: the supervisor calls it when the runner has exited. */
  signals?(attempt: number): AsyncIterable<PlaceSignal>;
  /** Where attempt n's runner writes its kill request: the place answers it (the child never derives it), and a place that has `signals(attempt)` has `requestFile(attempt)`; the two agree. */
  requestFile?(attempt: number): string;
  /** A place whose child writes its recording inside the place brings it home through this; without it (the local place) the child writes straight into the host's recording directory. */
  recordHome?: RecordHome;
  /** A hint: how far this place's clock may be from the host's, in ms (a remote box). The live recorder holds a line longer before placing it: max(1 s, 2 x this). */
  clockSkewMs?: number;
  /** Kills the runner: `process` ends the runner, `box` takes the place's machine away. The supervisor has written the kill line before it calls this. Safe on a runner that is already gone. */
  kill(runner: Runner, kind: 'process' | 'box'): Promise<void>;
  /** How the session stands, read the way the place reads it (a package's status reader), never from the store or `work/`: the supervisor is control-plane only. */
  status?(): Promise<unknown>; // { record?: the run's record, delegations?: PlaceDelegation[], boxes?: HostBox[] } for a place that has them
  /** The run's files, read through the place in disk's K8 shape (`readRunFile` / `listRunFiles` over its control), paths relative to the run's root. With both,
   *  and the `HOST_BOX` handover to the run's process, the supervisor reads the labels that process claimed for the place's host boxes, and the place shares one
   *  numbering with the tools' boxes; the place only reads bytes, never a label. `readRunFile` answers `null` for a file that is not there (not landed yet: read
   *  again), `listRunFiles` `[]` for a directory that is not there; any other failure THROWS (a missing run, a path that is not a regular file, a failed control
   *  call), and the supervisor takes a throw as an unreadable label, never as one not landed. A place without them numbers its host boxes in the supervisor, and is
   *  refused beside tool-made boxes (`DemoOptions.providers`). */
  readRunFile?(path: string): Promise<Uint8Array | null>;
  listRunFiles?(dir: string): Promise<string[]>;
  /** The next runner after a kill: a process kill restarts in the same place with the store intact; a box kill replaces the machine and restores from the last checkpoint, and says what it restored and replayed. */
  recover(last: Runner, kind: 'process' | 'box', order: RunnerOrder): Promise<{ runner: Runner; restored?: { checkpoint: string; head: number }; replayed?: { from: number; to: number }; /** A takeover that revoked the old holder's delegations (an Archil place): what was revoked, and how long the whole takeover took in ms (the revoke plus the start of the next holder). Written as a `revoke` host line. */ revoked?: PlaceDelegation[]; ms?: number }>;
  /** Takes a checkpoint at rest; reports what held it when it could not. A place that cannot lose its machine has none. */
  checkpoint?(): Promise<{ taken: boolean; heldBy?: string }>;
  /** Moves the session to another place. */
  move?(to: Place): Promise<MoveReceipt>;
  release(): Promise<void>;
};

/** The local place: a child process of this machine on a directory of it, the entry's own `run.ts` started with `--child`. A box kill takes the boxes the run made
 *  with it (`destroyBoxes`), since the machine the box stood for is this machine's. */
export function localPlace(options: { self: string; paths: RunPlace; destroyBoxes?: () => void | Promise<void>; /** Where attempt n's child writes its kill request (a file in the supervisor's own scratch). */ requestFile?: (attempt: number) => string }): Place {
  const start = async (order: RunnerOrder): Promise<Runner> => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(options.self), '--child'], { env: { PATH: process.env.PATH!, ...order.env }, stdio: [order.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (order.stdin !== undefined) proc.stdin!.end(order.stdin);
    const exited = new Promise<Exit>((resolve, reject) => {
      let stdout = ''; let stderr = '';
      proc.stdout!.on('data', (chunk) => { stdout += chunk; });
      proc.stderr!.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
        resolve({ exit: signal ?? code, signal, ...(row ? { outcome: row.outcome } : {}), stderr: stderr.trim().slice(0, 600) });
      });
    });
    return { epoch: 1, pid: proc.pid!, exited };
  };
  // A runner the supervisor has stopped: `recover` does not stop it again (a box's providers are not asked twice).
  const stopped = new WeakSet<Runner>();
  const kill = async (runner: Runner, kind: 'process' | 'box') => {
    if (runner.pid !== undefined) { try { process.kill(runner.pid, 'SIGKILL'); } catch { /* already gone */ } }
    await runner.exited;
    if (kind === 'box') await options.destroyBoxes?.();
    stopped.add(runner);
  };
  return {
    name: 'local', paths: options.paths, kills: options.destroyBoxes ? ['process', 'box'] : ['process'],
    start, kill,
    ...(options.requestFile ? { requestFile: options.requestFile, signals: (attempt) => localSignals(options.requestFile!(attempt)) } : {}),
    recover: async (last, kind, order) => { if (!stopped.has(last)) await kill(last, kind); return { runner: await start(order) }; },
    release: async () => undefined,
  };
}

/** The local place's signals: the kill request the child writes whole, by rename, when it parks at its planned crossing. A custom iterator, not a generator: the supervisor's `return()` must end a pending `next()`
 *  (a generator would queue it behind the poll and hang). */
function localSignals(file: string): AsyncIterable<PlaceSignal> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let last: string | undefined;
      return {
        async next(): Promise<IteratorResult<PlaceSignal>> {
          for (;;) {
            if (closed) return { done: true, value: undefined };
            if (existsSync(file)) {
              try {
                const text = readFileSync(file, 'utf8');
                if (text !== last) {
                  const { nonce, ...crossing } = JSON.parse(text);
                  last = text;
                  return { done: false, value: { kind: 'kill-request', crossing, ...(typeof nonce === 'string' ? { nonce } : {}) } };
                }
              } catch { /* written whole by rename: a half read is retried */ }
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
        async return(): Promise<IteratorResult<PlaceSignal>> { closed = true; return { done: true, value: undefined }; },
      };
    },
  };
}
