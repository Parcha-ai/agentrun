// The runner process (draft command: `agentrun runner --data D [--loops N]`): a long-lived process of its own, beside the
// server, with its own connection to the store in the data directory. It never sets the store up: a store whose schema
// it does not know (or one the server has not set up yet) is refused before any run is claimed. SIGTERM or SIGINT closes
// it: every loop stopped where it can resume, its runs flushed and released for another runner.
import { openSqliteStore, SchemaVersionUnknown, type Store } from "../store/index.js";
import type { LoopFactory } from "./loop-contract.js";
import { startRunner, type Runner, type RunnerEvent } from "./runner.js";

export interface RunnerProcessOptions {
  /** The data directory (--data): the store is the store module's file in it; the runner never names it. */
  dataDir: string;
  /** Most runs held at once (--loops). */
  loops?: number;
  /** This runner's name in the runs it claims. */
  name?: string;
  /** Each claimed run's loop (B2's loop.ts for pi and the CLI harnesses). */
  createLoop: LoopFactory;
  onEvent?: (event: RunnerEvent) => void;
}

export interface RunnerProcess {
  readonly runner: Runner;
  /** Closes the runner (its loops stopped, its runs released), then its store connection. */
  close(): Promise<void>;
}

/** A store this runner cannot use, in words a person starting it can act on. */
export class RunnerRefused extends Error {
  override name = "RunnerRefused";
}

/** The store, opened as a runner: refused when its schema is one this build does not know, or not set up yet. */
async function openStore(dataDir: string): Promise<Store> {
  try {
    // The store module owns the file name in the data directory (design: only the store adapter knows a file).
    return await openSqliteStore({ dataDir, role: "runner" });
  } catch (error) {
    if (!(error instanceof SchemaVersionUnknown)) throw error;
    const { found, known } = error;
    throw new RunnerRefused(
      found === null
        ? `The store in ${dataDir} is not set up yet: start the server on this data directory first, then the runner.`
        : `The store in ${dataDir} is at schema version ${found}, and this runner knows ${known}: run a runner of the same release as the server.`,
      { cause: error },
    );
  }
}

/** Opens the store as a runner and starts claiming runs. */
export async function startRunnerProcess(options: RunnerProcessOptions): Promise<RunnerProcess> {
  const store = await openStore(options.dataDir);
  let runner: Runner;
  try {
    runner = startRunner({
      store,
      createLoop: options.createLoop,
      ...(options.name ? { name: options.name } : {}),
      ...(options.loops ? { loops: options.loops } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    runner,
    close: () =>
      (closing ??= (async () => {
        await runner.close();
        await store.close();
      })()),
  };
}

/** `--data D [--loops N]`: the runner process's arguments. */
export function runnerArgs(argv: readonly string[]): { dataDir: string; loops?: number } {
  let dataDir: string | undefined;
  let loops: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new RunnerRefused(`${arg} needs a value`);
      return next;
    };
    if (arg === "--data") dataDir = value();
    else if (arg === "--loops") {
      const text = value();
      loops = Number(text);
      if (!Number.isSafeInteger(loops) || loops < 1) throw new RunnerRefused(`--loops is a whole number of runs above zero, not ${JSON.stringify(text)}`);
    } else throw new RunnerRefused(`unknown argument ${JSON.stringify(arg)}: a runner takes --data D [--loops N]`);
  }
  if (!dataDir) throw new RunnerRefused("a runner needs its data directory: --data D");
  return { dataDir, ...(loops === undefined ? {} : { loops }) };
}

/** Runs until SIGTERM or SIGINT, then closes. */
export async function runUntilSignalled(process: RunnerProcess, signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"]): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      for (const signal of signals) globalThis.process.off(signal, onSignal);
      resolve();
    };
    for (const signal of signals) globalThis.process.on(signal, onSignal);
  });
  await process.close();
}
