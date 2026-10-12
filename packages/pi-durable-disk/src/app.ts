// The app an instance hosts (`pi-durable-disk run --app <module>`): an ES module whose default export is a function
// of where the run lives that returns pi's Harness options (without `env`, which the run builds on its claim), an
// optional `beforeResume` for work that must be committed before the run resumes, an optional `onOpen` for the app to
// submit or resume work once the run is open and resumed, how `serve` creates the root conversation, and how a parking
// run records its wake.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Harness } from "@earendil-works/pi-durable";
import type { RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import type { Claim } from "./claim.ts";
import type { DurableRun, OpenDurableRunOptions, RunEnv } from "./run.ts";

/** Where the run lives on this host; known before it opens, so the app can build paths into its options. */
export interface AppContext {
  readonly ref: RunRef;
  readonly root: string;
  readonly work: string;
  readonly store: string;
}

/** pi's HarnessOptions without `env` (registry, models, settings, conversationCreated, now, onReport), plus the hooks below. */
export type AppOptions = OpenDurableRunOptions["harness"] & {
  /**
   * Called once per incarnation after the Harness is open and before it resumes (`OpenDurableRunOptions.beforeResume`):
   * what it admits is committed before any resumed work commits. A rejection fails the open (exit 1, retried).
   */
  beforeResume?: OpenDurableRunOptions["beforeResume"];
  /**
   * The instance's own lease trail (`OpenDurableRunOptions.onLease`): each heartbeat write's duration and the fence's reason, called synchronously and never awaited.
   * A host that wants to know why an instance died keeps these somewhere that outlives it (the demo's cloud app sends them over its link).
   */
  onLease?: OpenDurableRunOptions["onLease"];
  /**
   * Called once per incarnation after the run is open and resumed; `run.generation` tells a first start from a resume.
   * Work that must keep the instance up belongs in pi's tasks and tools: parking sees only those.
   */
  onOpen?(run: DurableRun): void | Promise<void>;
  /**
   * Wraps the run's environment once the claim is open: a host that gives some conversations an environment of their own (a thread's
   * tools on its own machine) returns an env that answers for those and hands every other conversation to `env`. It must keep
   * `env.cleanup` (the lease's: it kills every command the run started).
   */
  wrapEnv?(env: RunEnv, claim: Claim): RunEnv;
  /** pi's `root()` options for when `serve` creates the root conversation (its agent: model, extensions). */
  root?: Parameters<Harness["root"]>[1];
  /** Record a parking run's wake (park.ts `ParkOptions.wake`); default run.json `sleeping` with `wakeAt`. */
  wake?(run: DurableRun, at: number | null): Promise<void>;
};

/** What `--app` names: `export default async (ctx) => ({ registry, models, onOpen })`. */
export type AppModule = (ctx: AppContext) => AppOptions | Promise<AppOptions>;

/**
 * The app module is missing, does not load, has no default export function, throws, returns no options, or its
 * `onOpen` failed. Exit 1: not terminal, so the unit retries within systemd's start limit.
 */
export class AppError extends PdaError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("APP_FAILED", message, options);
  }
}

export async function loadApp(path: string, ctx: AppContext): Promise<AppOptions> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  } catch (err) {
    throw new AppError(`cannot load the app module ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (typeof mod.default !== "function") throw new AppError(`the app module ${path} has no default export function`);
  let options: AppOptions;
  try {
    options = await (mod.default as AppModule)(ctx);
  } catch (err) {
    throw new AppError(`the app module ${path} threw: ${(err as Error).message}`, { cause: err });
  }
  if (typeof options !== "object" || options === null || !options.registry || !options.models) {
    throw new AppError(`the app module ${path} returned no Harness options (registry and models)`);
  }
  return options;
}

/** The run's env factory with the app's wrapper applied (none: the base as it is). */
export function composeEnv(base: ((claim: Claim) => RunEnv) | undefined, defaultBase: (claim: Claim) => RunEnv, wrap: AppOptions["wrapEnv"]): ((claim: Claim) => RunEnv) | undefined {
  if (!wrap) return base;
  return (claim) => wrap((base ?? defaultBase)(claim), claim);
}
