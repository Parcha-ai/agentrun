// The runner process: `agentrun-serve runner --data D [--loops N] [--name N]` (cli.ts, through the server's launcher, the
// same bin and Node, its secrets over the launcher's pipe). A long-lived process of its own, beside the server, with its
// own connection to the store (in the data directory, or the Postgres AGENTRUN_STORE_URL names). It never sets the store up: a store whose schema it does not know
// (or one the server has not set up yet) is refused before any run is claimed. Once it can claim it says so in one line,
// `Runner <name> ready: store <kind> schema v<N>, <N> loops`; from then it writes its heartbeat (runner-<name>.alive under
// the data directory) as its loop turns, which `agentrun-serve runner --check --data D [--name N]` reads without a store
// connection. SIGTERM or SIGINT closes it: every loop stopped where it can resume and its run handed back at once for
// another runner (a loop that never stops is given up when its claim would run out, and its run is claimable when its
// lease lapses); then 0. Bad arguments exit 2, a store schema it does not know 3, anything else 1.
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FAUX_ENV, isFauxName } from "../model.js";
import { keptSealKey, SealKeyRefused, sealKeyHome } from "../seal-key.js";
import { SECRET_NAMES, secret } from "../secrets.js";
import { migrationsIn, openStore, SchemaVersionUnknown, type Store, storePlace, storeTarget } from "../store/index.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { SEAL_KEY_ENV, sealKeyOf } from "../tool-keys.js";
import { computerDepsFrom } from "../workspace/computer-deps.js";
import { createDispatchLoop } from "./dispatch.js";
import { resolveRunnerLoop } from "./harness-loops.js";
import type { LoopFactory } from "./loop-contract.js";
import { routeOf } from "./model-route.js";
import { RUNNER_LOOPS, RUNNER_RENEW_EVERY_MS, runnerName, startRunner, type Runner, type RunnerEvent } from "./runner.js";

export { RUNNER_RENEW_EVERY_MS } from "./runner.js";

export interface RunnerProcessOptions {
  /** The data directory (--data): the store is the store module's file in it; the runner never names it. */
  dataDir: string;
  /** Most runs held at once (--loops). */
  loops?: number;
  /** This runner's name in the runs it claims, its lines and its heartbeat. Default runner.ts runnerName(). */
  name?: string;
  /** Each claimed run's loop; default the runner's dispatch over the store (runnerLoop). */
  createLoop?: LoopFactory | ((store: Store) => LoopFactory);
  onEvent?: (event: RunnerEvent) => void;
  /** For tests: the clock the heartbeat is written by. Default Date.now. */
  now?: () => number;
  /** Where AGENTRUN_STORE_SCHEMA is read (process.env). The store's URL is a secret, read by name (secrets.ts secret),
   *  never from an environment. */
  env?: NodeJS.ProcessEnv;
  /** For tests: the store's URL, held by the caller. By default this process's AGENTRUN_STORE_URL secret. */
  storeUrl?: string;
  /** What a person should see at the start (a clock far from the store's Postgres): stderr by default. */
  warn?: (message: string) => void;
}

export interface RunnerProcess {
  readonly runner: Runner;
  /** What the store is, for the ready line: its kind and schema version. */
  readonly store: { readonly kind: string; readonly schema: number };
  /** Closes the runner (its loops stopped, its runs released), then its store connection. */
  close(): Promise<void>;
}

/** A store this runner cannot use, or arguments it cannot take, in words a person starting it can act on. */
export class RunnerRefused extends Error {
  override name = "RunnerRefused";
}

/** The store, opened as a runner, its kind and its schema version: refused when its schema is one this build does not
 *  know, or not set up yet. The one place the runner opens its store (store/open.ts: Postgres when AGENTRUN_STORE_URL
 *  names one, else SQLite in the data directory). */
async function openRunnerStore(dataDir: string, env: NodeJS.ProcessEnv, warn: (message: string) => void, url: string | undefined): Promise<{ store: Store; kind: string; schema: number }> {
  // The store module owns where the store is (design: only the store adapter knows a file or a schema). The URL is this
  // process's secret (as the launcher handed it over), unless a test hands one.
  const target = url === undefined ? storeTarget(dataDir, env) : storeTarget(dataDir, env, url);
  // The same words on either store: the data directory's, or the Postgres schema's (never its URL).
  const where = target.kind === "sqlite" ? dataDir : storePlace(target);
  const on = target.kind === "sqlite" ? "this data directory" : storePlace(target);
  try {
    const store = await openStore({ dataDir, role: "runner", env, warn, ...(url === undefined ? {} : { url }) });
    return { store, kind: target.kind, schema: target.kind === "sqlite" ? SCHEMA_VERSION : migrationsIn().at(-1)!.version };
  } catch (error) {
    if (!(error instanceof SchemaVersionUnknown)) throw error;
    const { found, known } = error;
    throw new RunnerRefused(
      found === null
        ? `The store in ${where} is not set up yet: start the server on ${on} first, then the runner.`
        : `The store in ${where} is at schema version ${found}, and this runner knows ${known}: run a runner of the same release as the server.`,
      { cause: error },
    );
  }
}

/** The runner's own secrets, which a run never gets, not even in the runner's in-process environment: the server's
 *  token and API key, the seal key (the runner holds it as its sealKey), and the store's connection (its URL holds a
 *  database password). */
const RUNNER_ONLY = (name: string): boolean => name === "AGENTRUN_TOKEN" || name === "AGENTRUN_API_KEY" || name === SEAL_KEY_ENV || name.startsWith("AGENTRUN_STORE_");

/** A run's environment as the runner hands its loops (AdapterSpecDeps.env): this process's, less the runner's own
 *  secrets, with every other secret the launcher's pipe handed it (a model key, a tool key, a box key) readable by name
 *  but not enumerable, as secrets.ts withSecrets makes them: code that reads one by name (the model route) finds it, and
 *  a spread of the object or a spawn given it carries none. */
export function runEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // Never a test hook's name (model.ts isFauxName): one the operator's environment holds gives no run fake answers and
  // loads no module, as on the server (withoutFaux); a --faux start hands its runner the switches from its options.
  for (const [name, value] of Object.entries(env)) if (!RUNNER_ONLY(name) && !isFauxName(name)) out[name] = value;
  for (const name of SECRET_NAMES) {
    if (RUNNER_ONLY(name)) continue;
    const value = secret(name);
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: false, writable: false, configurable: false });
  }
  return out;
}

/** The runner's loop for every run: the dispatch over the store (createDispatchLoop), each run's harness loop picked by
 *  its launch (harness-loops.ts resolveRunnerLoop), with the data directory, the run environment (runEnv), the store's
 *  journal, the seal key and the model route. Refused in words with no seal key. `switches`: the test switches the
 *  runner's own options name (runnerArgs --faux), assigned onto the run environment, which drops any its process holds. */
export function runnerLoop(store: Store, dataDir: string, env: NodeJS.ProcessEnv = process.env, switches: NodeJS.ProcessEnv = {}): LoopFactory {
  // The key handed over (the launcher's pipe, or the environment), else the one the server keeps under the config home
  // (seal-key.ts), read and never made here: the server makes it at its first start, and a runner's own would not open
  // what the server sealed.
  const handed = secret(SEAL_KEY_ENV) ?? env[SEAL_KEY_ENV];
  let sealKey = sealKeyOf(handed);
  // A handed key that is no key is refused, as the server refuses it (seal-key.ts ensureSealKey): never passed over for
  // the kept one, which may not be the server's.
  if (handed && !sealKey) throw new RunnerRefused(`${SEAL_KEY_ENV} is set but is not 32 bytes in base64: hand the runner the server's seal key.`);
  try {
    sealKey ??= keptSealKey(sealKeyHome(env))?.key;
  } catch (error) {
    if (error instanceof SealKeyRefused) throw new RunnerRefused(error.message, { cause: error });
    throw error;
  }
  if (!sealKey) throw new RunnerRefused(`A runner needs the server's seal key: ${SEAL_KEY_ENV} handed over by the server's launcher, or the one the server keeps under the config home (start the server on this machine first).`);
  // Assigned, never spread: runEnv's secrets are readable by name but not enumerable.
  const runs = Object.assign(runEnv(env), switches);
  // The run's computer at its claim, composed once (workspace/computer-deps.ts): none for the runner's place, a box's
  // computer by the agent's setting, its keys read from the run environment first, then the store's sealed rows.
  const computers = computerDepsFrom({ env: runs, store, sealKey });
  const deps = {
    env: runs, data: dataDir, journal: (claim: Parameters<Store["journal"]>[0]) => store.journal(claim), store, sealKey, routeOf,
    computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps,
  };
  return createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) });
}

/** Where runner `name` writes its heartbeat in `dataDir`. */
export const heartbeatFile = (dataDir: string, name: string): string => join(dataDir, `runner-${name.replace(/[^A-Za-z0-9._:-]/g, "_")}.alive`);

/** The runner's heartbeat writer: its file's time set to now, at most every half renew interval. */
function heartbeat(dataDir: string, name: string, now: () => number): () => void {
  const file = heartbeatFile(dataDir, name);
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < RUNNER_RENEW_EVERY_MS / 2) return;
    last = at;
    const seconds = at / 1000;
    try {
      utimesSync(file, seconds, seconds);
    } catch {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, `${name}\n`);
      utimesSync(file, seconds, seconds);
    }
  };
}

/** Whether runner `name`'s heartbeat in `dataDir` is fresh: younger than twice the renew interval. */
export function checkRunner(options: { dataDir: string; name: string; now?: () => number }): { ok: true } | { ok: false; why: string } {
  const { dataDir, name } = options;
  const now = (options.now ?? Date.now)();
  let at: number;
  try {
    at = statSync(heartbeatFile(dataDir, name)).mtimeMs;
  } catch {
    return { ok: false, why: `${name} has no heartbeat in ${dataDir}: it is not running there, or never ran` };
  }
  const age = now - at;
  if (age < 2 * RUNNER_RENEW_EVERY_MS) return { ok: true };
  return { ok: false, why: `${name}'s heartbeat is ${Math.round(age / 1000)} s old, past ${(2 * RUNNER_RENEW_EVERY_MS) / 1000} s: its loop has stopped` };
}

/** Opens the store as a runner and starts claiming runs. */
export async function startRunnerProcess(options: RunnerProcessOptions): Promise<RunnerProcess> {
  const warn = options.warn ?? ((message: string) => void process.stderr.write(`agentrun-serve runner: ${message}\n`));
  const { store, kind, schema } = await openRunnerStore(options.dataDir, options.env ?? process.env, warn, options.storeUrl);
  let runner: Runner;
  try {
    const name = options.name ?? runnerName();
    const made = options.createLoop ?? ofStore((opened) => runnerLoop(opened, options.dataDir));
    // A factory of the store (marked by ofStore) is given the store; a loop factory is used as is.
    const createLoop = isStoreFactory(made) ? made(store) : made;
    runner = startRunner({
      store,
      createLoop,
      name,
      ...(options.loops ? { loops: options.loops } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      onBeat: heartbeat(options.dataDir, name, options.now ?? Date.now),
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    runner,
    store: { kind, schema },
    close: () =>
      (closing ??= (async () => {
        await runner.close();
        await store.close();
      })()),
  };
}

const storeFactories = new WeakSet<object>();
/** Marks `make` as a function of the store (startRunnerProcess gives it the store it opens). */
export function ofStore(make: (store: Store) => LoopFactory): (store: Store) => LoopFactory {
  storeFactories.add(make);
  return make;
}
const isStoreFactory = (made: LoopFactory | ((store: Store) => LoopFactory)): made is (store: Store) => LoopFactory => storeFactories.has(made);

/** The runner process's arguments: `--data D [--loops N] [--name N] [--faux M]`, or `--check --data D [--name N]`. Each
 *  option with a value is also taken as `--option=value` (the bin hands a data directory that starts with "-" so, never
 *  read as an option); an empty one is refused like a missing one. `--faux M`: the test switch a --faux server takes (its
 *  runs' model is the module M's), the runner's only way to it: a faux name its environment holds enables nothing. */
export function runnerArgs(argv: readonly string[]): { dataDir: string; loops?: number; name?: string; faux?: string; check?: true } {
  let dataDir: string | undefined;
  let loops: number | undefined;
  let name: string | undefined;
  let faux: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const given = argv[i]!;
    const equals = /^(--(?:data|loops|name|faux))=(.*)$/s.exec(given);
    const arg = equals ? equals[1]! : given;
    const value = () => {
      const next = equals ? equals[2] : argv[++i];
      if (next === undefined || next === "") throw new RunnerRefused(`${arg} needs a value`);
      return next;
    };
    if (arg === "--data") dataDir = value();
    else if (arg === "--loops") {
      const text = value();
      loops = Number(text);
      if (!Number.isSafeInteger(loops) || loops < 1) throw new RunnerRefused(`--loops is a whole number of runs above zero, not ${JSON.stringify(text)}`);
    } else if (arg === "--name") name = value();
    else if (arg === "--faux") faux = value();
    else if (arg === "--check") check = true;
    else throw new RunnerRefused(`unknown argument ${JSON.stringify(arg)}: a runner takes --data D [--loops N] [--name N] [--faux M], or --check --data D [--name N]`);
  }
  if (!dataDir) throw new RunnerRefused("a runner needs its data directory: --data D");
  return { dataDir, ...(loops === undefined ? {} : { loops }), ...(name === undefined ? {} : { name }), ...(faux === undefined ? {} : { faux }), ...(check ? { check: true as const } : {}) };
}

/** Runs until SIGTERM or SIGINT, then closes. `ready` is called once the signals are handled, never before: a line that
 *  says the runner is ready (on a pipe, written at once) may bring a SIGTERM back before the next statement runs, and one
 *  that came before the handlers would end the process unclosed. */
export async function runUntilSignalled(process: RunnerProcess, signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"], ready: () => void = () => {}): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      for (const signal of signals) globalThis.process.off(signal, onSignal);
      resolve();
    };
    for (const signal of signals) globalThis.process.on(signal, onSignal);
    ready();
  });
  await process.close();
}

/** One line of what the runner did, in its name. */
function said(name: string, event: RunnerEvent): string | undefined {
  if (event.type === "claimed") return `Runner ${name} claimed ${event.claim.runId} (epoch ${event.claim.epoch})`;
  if (event.type === "released") return `Runner ${name} released ${event.runId} (${event.end})`;
  if (event.type === "claim-lost") return `Runner ${name} lost its claim on ${event.runId} (${event.why})`;
  return undefined;
}

/** `agentrun-serve runner ...`: the exit code. 2: bad arguments; 3: a store schema this runner does not know (or none
 *  set up yet); 1: anything else; 0: closed on a signal, or --check found a fresh heartbeat. AGENTRUN_RUNNER_NAME names
 *  it when --name does not. */
export async function runnerMain(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ReturnType<typeof runnerArgs>;
  try {
    args = runnerArgs(argv);
  } catch (error) {
    if (!(error instanceof RunnerRefused)) throw error;
    console.error(`agentrun-serve runner: ${error.message}`);
    return 2;
  }
  const name = args.name ?? env.AGENTRUN_RUNNER_NAME ?? undefined;
  if (args.check) {
    if (!name) {
      console.error("agentrun-serve runner: --check needs the runner's name: --name N or AGENTRUN_RUNNER_NAME");
      return 2;
    }
    const checked = checkRunner({ dataDir: args.dataDir, name });
    if (checked.ok) {
      console.log(`Runner ${name} is alive`);
      return 0;
    }
    console.error(`agentrun-serve runner: ${checked.why}`);
    return 1;
  }
  let started: RunnerProcess;
  const runnerOf = name ?? runnerName();
  try {
    started = await startRunnerProcess({
      dataDir: args.dataDir,
      name: runnerOf,
      env,
      ...(args.loops ? { loops: args.loops } : {}),
      createLoop: ofStore((store) => runnerLoop(store, args.dataDir, env, args.faux ? { [FAUX_ENV]: resolve(args.faux) } : {})),
      onEvent: (event) => {
        if (event.type === "error") return void console.error(`Runner ${runnerOf}: ${event.step}${event.runId ? ` ${event.runId}` : ""}: ${event.message}`);
        const line = said(runnerOf, event);
        if (line) console.log(line);
      },
    });
  } catch (error) {
    console.error(`agentrun-serve runner: ${(error as Error)?.message ?? String(error)}`);
    return error instanceof RunnerRefused && error.cause instanceof SchemaVersionUnknown ? 3 : 1;
  }
  // Ready is said once SIGTERM and SIGINT are handled, so a stop sent on reading it always closes the runner.
  await runUntilSignalled(started, ["SIGTERM", "SIGINT"], () => console.log(`Runner ${started.runner.name} ready: store ${started.store.kind} schema v${started.store.schema}, ${args.loops ?? RUNNER_LOOPS} loops`));
  return 0;
}
