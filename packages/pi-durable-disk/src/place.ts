// Places: where one run lives, and how its instance starts, is killed and comes back. A supervisor that decides when to
// kill (agentrun's reference demo) is the same for every place; the place decides how. `localPlace` runs the instance on
// a directory of this machine (`run --dir`, no disk and no key). The types match the reference's place seam
// (@parcha/agentrun-harness/place) structurally. The supervisor reads nothing under the run's directory: the outcome and
// the run's record come through the place.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPath } from "./claim.ts";
import { reapCommands } from "./commands.ts";
import { HeldError, PdaError } from "./errors.ts";
import { assertStoreFree, STORE_FILE } from "./run.ts";
import { listLocalRunFiles, readLocalRunFile } from "./run-files.ts";
import { readLocalRunStatus, type RunRecord } from "./status.ts";

export type PlaceKill = "process" | "box";
/** The run's paths in the place: its id, its directory, and the `work` and `store` under it. */
export type PlacePaths = { id: string; root: string; work: string; store: string };
/**
 * How the run stood when a runner ended: the instance's own report, or the run's record as it left it. `status` is the run's
 * word: `complete` when it delivered, else `failed`. `models`, on any status: the role-to-model ids the run's live parts
 * chose (`lead`, `eyes`, ...), when the app reported a plain object of strings; absent otherwise, never `{}` in its place.
 */
export type PlaceOutcome = { status: string; generation: number | null; code?: string | null; message?: string; record?: unknown; storeSha256?: string; models?: Record<string, string> };
/** How a runner ended. `exit`: the exit code or signal. */
export type PlaceExit = { exit: number | string | null; signal: string | null; outcome?: PlaceOutcome; stderr: string };
/** One instance of the run in a place. `epoch`: 1 on a plain directory. */
export type PlaceRunner = { epoch: number; pid?: number; exited: Promise<PlaceExit> };
/** What a runner is handed: its number in the run, its environment, and what goes to its stdin. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };
/** What a recovery did, and `ms`, the whole of it. */
export type PlaceRecovery = {
  runner: PlaceRunner;
  restored?: { checkpoint: string; head: number };
  replayed?: { from: number; to: number };
  ms?: number;
};
/**
 * What a runner announces to its supervisor: a crossing it took, or a request to be killed at one (it parks there until
 * the kill). `signals-failed` is the place's own last word when it could not read the requests: it ends the iterator,
 * which never rejects. `code` is the failing read's error code when it has one (CONTROL_API_FAILED for a read that timed
 * out), else SIGNALS_FAILED.
 */
export type PlaceSignal =
  | {
      kind: "crossing" | "kill-request";
      crossing: { point: string; n: number; pid?: number; info?: Record<string, unknown> };
      /** The attempt's nonce the runner wrote into its request, lifted out of `crossing`: the supervisor honors a kill request only with the nonce it minted for that attempt. */
      nonce?: string;
    }
  | { kind: "signals-failed"; code: string; message: string };
/**
 * What the supervisor hands a place factory: the run's paths as it computed them, how to take the boxes the run made,
 * and where attempt n's runner writes its kill request (a file of the supervisor's machine).
 */
export type PlaceContext = { paths: PlacePaths; self?: string; destroyBoxes?: () => void | Promise<void>; requestFile?: (attempt: number) => string };

export interface Place {
  /** `local`, for the recording's lines. */
  readonly name: string;
  readonly paths: PlacePaths;
  /** What this place can lose. */
  readonly kills: ReadonlyArray<PlaceKill>;
  start(order: RunnerOrder): Promise<PlaceRunner>;
  /**
   * Where attempt `attempt`'s runner writes its kill request, as a path in the place (the supervisor puts it in the
   * runner's order). A place with `signals` has it, and `signals(attempt)` reads what is written there.
   */
  requestFile?(attempt: number): string;
  /**
   * The kill requests (and crossings) attempt `attempt`'s runner announces. The supervisor stops reading with `return()`
   * once the runner has exited, and `return()` ends a pending `next()`.
   */
  signals?(attempt: number): AsyncIterable<PlaceSignal>;
  /** Takes the runner away abruptly, as a crash would. Safe on a runner that is already gone. */
  kill(runner: PlaceRunner, kind: PlaceKill): Promise<void>;
  /** Kills `last` if it still runs, then starts the next runner. */
  recover(last: PlaceRunner, kind: PlaceKill, order: RunnerOrder): Promise<PlaceRecovery>;
  checkpoint?(): Promise<{ taken: boolean; heldBy?: string }>;
  move?(to: Place): Promise<Record<string, unknown>>;
  /** Lets the run go: stops what still runs (its commands too), never the run's directory. */
  release(): Promise<void>;
  /**
   * The bytes of the run's own file `path` (`runs/<id>/<path>`), or null when there is no such file; every other failure
   * throws a `RunFileError` (INVALID_PATH, RUN_MISSING, NOT_A_FILE, CONTROL_API_FAILED). Read only: never a write, never
   * the claim. A place never parses what it reads.
   */
  readRunFile?(path: string): Promise<Uint8Array | null>;
  /** The names directly under `dir` in the run (`""` for its root), sorted; [] for a directory not there yet. A missing run, or a failed read, throws. */
  listRunFiles?(dir: string): Promise<string[]>;
}

export type PlaceErrorCode = "INVALID_ARGUMENT" | "RELEASE_FAILED";

export class PlaceError extends PdaError {
  constructor(code: PlaceErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

// The package's own CLI, with the extension this module has: `.ts` from a checkout, `.js` once built.
const CLI = fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url));
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** After the instance exits, how long its output may take to close (a command it left running can hold it open). */
const OUTPUT_GRACE_MS = 2_000;
/** How often a local place looks for a kill request (a file of this machine). */
const LOCAL_SIGNAL_POLL_MS = 20;
/** How long reads of a kill request may fail without a break before `signals` says so. */
const SIGNAL_FAIL_MS = 60_000;
const STDERR_KEEP = 600;
/** The longest message a place reports in a signal, as a kill line's. */
const MESSAGE_KEEP = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The outcome the run's record gives, in the run's vocabulary rather than the record's: `complete` when the run is `done` and
 * delivered a record (the detail of the app's last status carries one), `failed` for anything else (done with no result,
 * failed, or a run its instance left `running`, `paused` or `sleeping`). Its generation, and what the app put in that
 * detail.
 */
function outcomeOf(record: RunRecord | null | undefined): PlaceOutcome | undefined {
  if (!record) return undefined;
  const detail = record.detail !== null && typeof record.detail === "object" && !Array.isArray(record.detail) ? (record.detail as Record<string, unknown>) : {};
  const delivered = record.status === "done" && "record" in detail && detail.record !== null && detail.record !== undefined;
  const models = modelsOf(detail.models);
  return {
    status: delivered ? "complete" : "failed",
    generation: record.generation,
    code: typeof detail.code === "string" ? detail.code : null,
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
    ...("record" in detail ? { record: detail.record } : {}),
    ...(typeof detail.storeSha256 === "string" ? { storeSha256: detail.storeSha256 } : {}),
    ...(models ? { models } : {}),
  };
}

/**
 * The role-to-model ids an outcome carries: a copy of `value` when it is a plain object whose values are all strings,
 * else undefined, so a malformed report is left out and never stands in as `{}`.
 */
function modelsOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, id]) => typeof id === "string") ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

const pathsUnder = (id: string, root: string): PlacePaths => ({ id, root, work: join(root, "work"), store: join(root, "store") });

// ---- the local place ----------------------------------------------------------------------------------------------------

export interface LocalPlaceOptions {
  /** The app module `run --app` loads. */
  app: string;
  /** The run's directory. Default: the context's `paths.root`. */
  root?: string;
  /** The instance program; `run` and its flags are appended. Default: this Node and the package's CLI. */
  command?: string[];
  /** Extra flags for `run` (a park threshold). */
  runArgs?: string[];
}

/**
 * The run on a directory of this machine: each runner is `pi-durable-disk run --dir <root> --id <id> --epoch <its order's gen> --app <app>`, a
 * child in its own process group, with `{ PATH, ...order.env }` and nothing else of this process's environment. No disk,
 * no key and no token. A process kill is SIGKILL to the group, and the next runner resumes the run from the directory; a
 * box kill also takes the boxes the run made (`destroyBoxes`), so `kills` has `box` only when the context gives that.
 * A runner's outcome is the instance's `{"outcome":...}` line on stdout, or, without one, the run's record as it left it.
 */
export function localPlace(options: LocalPlaceOptions): (ctx: PlaceContext) => Place {
  if (!options.app) throw new PlaceError("INVALID_ARGUMENT", "localPlace needs the app module the instance runs");
  return (ctx) => {
    runPath(ctx.paths.id);
    const root = resolve(options.root ?? ctx.paths.root);
    const paths = pathsUnder(ctx.paths.id, root);
    const command = options.command ?? [process.execPath, CLI];
    const alive = new Map<PlaceRunner, number>();
    /** A runner's boxes being taken, or taken: one deletion per runner, shared while in flight, retried after a failure. */
    const boxesTaken = new Map<PlaceRunner, Promise<void>>();

    const start = async (order: RunnerOrder): Promise<PlaceRunner> => {
      // The runner's number in the run is its epoch: the place is the run's one supervisor.
      const argv = [...command.slice(1), "run", "--dir", root, "--id", paths.id, "--epoch", String(order.gen), "--app", options.app, ...(options.runArgs ?? [])];
      const child = spawn(command[0], argv, {
        detached: true,
        env: { PATH: process.env.PATH || SAFE_PATH, ...order.env },
        stdio: [order.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      await new Promise<void>((ok, fail) => {
        child.once("spawn", ok);
        child.once("error", (err) => fail(new PlaceError("INVALID_ARGUMENT", `cannot start ${command[0]}`, { cause: err })));
      });
      if (order.stdin !== undefined) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(order.stdin);
      }
      let outcome: PlaceOutcome | undefined;
      let partial = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) outcome = outcomeLine(line) ?? outcome;
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      const exited = new Promise<PlaceExit>((settle) => {
        let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        let done = false;
        const finish = async () => {
          if (done || !ended) return;
          done = true;
          outcome = outcomeLine(partial) ?? outcome;
          const fallback = outcome ? undefined : outcomeOf(await readLocalRunStatus(root).catch(() => undefined));
          const report = outcome ?? fallback;
          settle({ exit: ended.signal ?? ended.code, signal: ended.signal, ...(report ? { outcome: report } : {}), stderr: stderr.trim().slice(0, STDERR_KEEP) });
        };
        child.once("exit", (code, signal) => {
          // Its pid is free from here: no kill may reach the group by it again.
          alive.delete(runner);
          ended = { code, signal };
          setTimeout(() => void finish(), OUTPUT_GRACE_MS).unref();
        });
        child.once("close", () => void finish());
      });
      const runner: PlaceRunner = { epoch: 1, pid: child.pid!, exited };
      alive.set(runner, child.pid!);
      return runner;
    };

    const kill = async (runner: PlaceRunner, kind: PlaceKill): Promise<void> => {
      // Only a runner still alive: its pid (the group's id) is not yet free for another process to take.
      const pid = alive.get(runner);
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await runner.exited;
      // Once per runner: a supervisor that kills and then recovers the same runner takes its boxes once. A deletion that
      // failed is forgotten, so the next kill or recover tries again before any runner starts.
      if (kind === "box" && ctx.destroyBoxes) {
        let taking = boxesTaken.get(runner);
        if (!taking) {
          taking = (async () => ctx.destroyBoxes!())().then(
            () => undefined,
            (error: unknown) => {
              boxesTaken.delete(runner);
              throw error;
            },
          );
          boxesTaken.set(runner, taking);
        }
        await taking;
      }
    };

    return {
      name: "local",
      paths,
      readRunFile: (path) => readLocalRunFile(root, paths.id, path),
      listRunFiles: (dir) => listLocalRunFiles(root, paths.id, dir),
      kills: ctx.destroyBoxes ? ["process", "box"] : ["process"],
      start,
      // The runner is a child of this machine, so its kill request is the supervisor's own file.
      ...(ctx.requestFile
        ? {
            requestFile: ctx.requestFile,
            signals: (attempt: number) => {
              const file = ctx.requestFile!(attempt);
              return requestSignals(async () => (existsSync(file) ? readFileSync(file, "utf8") : undefined), LOCAL_SIGNAL_POLL_MS, SIGNAL_FAIL_MS);
            },
          }
        : {}),
      kill,
      recover: async (last, kind, order) => {
        await kill(last, kind);
        return { runner: await start(order) };
      },
      release: async () => {
        await Promise.all([...alive.keys()].map((runner) => kill(runner, "process")));
        // pi runs each command in a process group of its own, which the instance's kill does not reach: end what the
        // run recorded, as its next open would, since there may be none. Only while no process holds the run's store,
        // as an open does: while another process holds the run, the commands are its own, not this place's.
        const commands = join(root, "commands");
        if (!existsSync(commands)) return;
        try {
          assertStoreFree(join(root, "store", STORE_FILE));
        } catch (error) {
          if (error instanceof HeldError) return;
          throw error;
        }
        const reaped = await reapCommands(commands);
        if (reaped.survivors.length > 0) {
          throw new PlaceError("RELEASE_FAILED", `releasing ${root} left commands alive after SIGKILL: pids ${reaped.survivors.map((m) => m.pid).join(", ")}`);
        }
      },
    };
  };
}

/**
 * The kill request a runner writes whole when it parks at its planned crossing, as one signal, read with `read` every
 * `pollMs` until it names a crossing. `read` answers undefined while there is no request yet; a read that fails is tried
 * again, and once reads have failed for `failMs` without a break, the iterator yields one `signals-failed` and ends (a
 * runner parked at its crossing would otherwise wait with no word of why). It never rejects. A custom iterator, not a
 * generator: `return()` must end a
 * pending `next()`, which a generator would queue behind the poll, and it does even while a read is in flight (a read
 * over the network can hang). Each wait has its own wake, dropped after it, so a long poll attaches nothing to anything
 * that lives as long as the iterator.
 */
function requestSignals(read: () => Promise<string | undefined>, pollMs: number, failMs: number): AsyncIterable<PlaceSignal> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let wake: (() => void) | undefined;
      /** `work`, or undefined as soon as `return()` runs. */
      const unlessReturned = <T>(work: Promise<T>): Promise<T | undefined> =>
        new Promise<T | undefined>((resolve, reject) => {
          wake = () => resolve(undefined);
          work.then(resolve, reject);
        }).finally(() => {
          wake = undefined;
        });
      let failingSince: number | undefined;
      return {
        async next(): Promise<IteratorResult<PlaceSignal>> {
          while (!closed) {
            let text: string | undefined;
            try {
              text = await unlessReturned(read());
              failingSince = undefined;
            } catch (error) {
              failingSince ??= Date.now();
              if (!closed && Date.now() - failingSince >= failMs) {
                closed = true;
                const code = (error as { code?: unknown } | null)?.code;
                const message = `reading the kill request failed for ${failMs} ms: ${String((error as Error | null)?.message ?? error)}`.slice(0, MESSAGE_KEEP);
                return { done: false, value: { kind: "signals-failed", code: typeof code === "string" && code ? code : "SIGNALS_FAILED", message } };
              }
            }
            const request = closed || text === undefined ? undefined : requestIn(text);
            if (request) {
              closed = true;
              // The nonce is the signal's, not the crossing's: a supervisor reads it at the top, as from any place.
              const { nonce, ...crossing } = request;
              return { done: false, value: { kind: "kill-request", crossing, ...(typeof nonce === "string" ? { nonce } : {}) } };
            }
            if (!closed) await unlessReturned(sleep(pollMs));
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<PlaceSignal>> {
          closed = true;
          wake?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** What a kill request file holds: the crossing, with the attempt's nonce beside its fields. */
type RequestCrossing = Extract<PlaceSignal, { crossing: unknown }>["crossing"] & { nonce?: unknown };

/**
 * What a request names: `point` and `n` at least, with every other field it carries; the per-attempt nonce the
 * supervisor put in the order (never the place's token) is lifted out of the crossing into the signal. Anything else (a
 * half write, another file) is not one yet.
 */
function requestIn(text: string): RequestCrossing | undefined {
  try {
    const v = JSON.parse(text) as Partial<RequestCrossing> | null;
    return v && typeof v.point === "string" && typeof v.n === "number" && Number.isFinite(v.n) ? (v as RequestCrossing) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `outcome` of a `{"outcome":{...}}` line with at least a status; undefined for any other line. Its `models` stays
 * only when it is a plain object of strings (`modelsOf`), as the record's does.
 */
function outcomeLine(line: string): PlaceOutcome | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as { outcome?: PlaceOutcome };
    if (!parsed.outcome || typeof parsed.outcome !== "object" || typeof parsed.outcome.status !== "string") return undefined;
    const { models: reported, ...outcome } = parsed.outcome as PlaceOutcome & { models?: unknown };
    const models = modelsOf(reported);
    return models ? { ...outcome, models } : outcome;
  } catch {
    return undefined;
  }
}

