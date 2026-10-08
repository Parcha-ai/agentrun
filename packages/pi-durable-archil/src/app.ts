// The app an instance hosts (`pi-durable-archil run --app <module>`): an ES module whose default export is a function
// of where the run lives that returns pi's Harness options (without `env`, which the run builds on its claim), an
// optional `onOpen` for the app to submit or resume work once the run is open and resumed, how `serve` creates the root
// conversation, and how a parking run records its wake.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Harness } from "@earendil-works/pi-durable";
import type { RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import type { DurableRun, OpenDurableRunOptions } from "./run.ts";

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
   * Called once per incarnation after the run is open and resumed; `run.generation` tells a first start from a resume.
   * Work that must keep the instance up belongs in pi's tasks and tools: parking sees only those.
   */
  onOpen?(run: DurableRun): void | Promise<void>;
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
