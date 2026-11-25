// The runner process: `agentrun-serve runner --data D [--loops N] [--drain-timeout D] [--name N]` (cli.ts, through the server's launcher, the
// same bin and Node, its secrets over the launcher's pipe). A long-lived process of its own, beside the server, with its
// own connection to the store (in the data directory, or the Postgres AGENTRUN_STORE_URL names). It never sets the store up: a store whose schema it does not know
// (or one the server has not set up yet) is refused before any run is claimed. Once it can claim it says so in one line,
// `Runner <name> ready: store <kind> schema v<N>, <N> loops`; from then it writes its heartbeat (runner-<name>.alive under
// the data directory) as its loop turns, which `agentrun-serve runner --check --data D [--name N]` reads without a store
// connection. It holds at most --loops runs at once (default AGENTRUN_MAX_RUNS, else as many pi runs as this host's
// memory holds: the server's --max-runs default, host.ts maxRunsOf). SIGTERM or SIGINT closes it: each busy run finishes
// its turn for up to --drain-timeout (default AGENTRUN_DRAIN_TIMEOUT, else RUNNER_DRAIN_TIMEOUT), then every loop left is stopped where it can resume
// and its run handed back for another runner (a loop that never stops is given up when its claim would run out, and its
// run is claimable when its lease lapses); then 0. Bad arguments exit 2, a store it cannot open (yet) 3, anything else 1.
// A store a later server migrated past what this build can run beside (its runner floor rose above the version this build
// knows; read again at each renewal) is the same stop: nothing more claimed, the drain, its runs handed back; then 3, so
// its platform starts a runner of the new release in its place.
// A run isolation it cannot give (run-child-host.ts runIsolationOf) is said, and it stays up claiming nothing until a stop: 0.
// An error nothing handles exits 1 at once, said with its stack (lastResort).
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type HostedDial, PROVIDERS } from "@parcha/agentrun-computer";
import { type RunnerRelay, startRunnerRelay } from "../dial-relay.js";
import type { PairedRelay } from "../workspace/attached-computers.js";
import { freeModelRequestsOf } from "@parcha/agentrun-kernel/kernel/cap";
import { ArchilSettingsEnvInvalid, archilSettingsFromEnv } from "../archil-settings.js";
import { dockerPathsForRuns } from "../box-paths.js";
import { COMPOSIO_KEY_ENV } from "../composio-made.js";
import { hostCommandRefusals } from "../computers.js";
import { hostAddressesOnce } from "../docker-host-addresses.js";
import { claimInstallsStopped } from "../harness-install.js";
import { HARNESS_MODULES_ENV, HARNESS_MODULES_SETTING, HARNESS_RECIPES_ENV, HARNESS_RECIPES_SETTING, HARNESS_TABLE_ENV, harnessModulesEnv, harnessModulesOf, harnessRecipesEnv, harnessRecipesOf, harnessTable } from "../harness-table.js";
import { DEFAULT_PORT, maxRunsOf } from "../host.js";
import { FAUX_ENV, FAUX_PREFIX, withoutFaux } from "../model.js";
import { durationMs, runLine } from "../print.js";
import { bootSealKey } from "../seal-key.js";
import { handedSecret, SECRET_NAMES, secret } from "../secrets.js";
import { migrationsIn, openStore, RunnerBelowFloor, SchemaVersionUnknown, type Store, StoreAwaitsServer, storePlace, storeTarget } from "../store/index.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { SEAL_KEY_ENV, sealKeyOf } from "../tool-keys.js";
import { LAUNCH_HOOK_SECRET_ENV } from "../trigger-launch-hook.js";
import { FAUX_BROWSER_ENV } from "../tools.js";
import { claimViewOpener } from "../computer-live.js";
import { LOOPBACK as LIVE_LOOPBACK, runnerLiveOf } from "../live-reach.js";
import { LOOPBACK } from "../mcp-oauth.js";
import { serverOwn } from "../mcp-private-hosts.js";
import { MCP_ALLOW_LOOPBACK_ENV } from "../mcp-servers-store.js";
import { PRIVATE_HOSTS_ENV, privateHostsSwitchValue } from "../mcp-private-hosts.js";
import { envValue, type KeyEnv } from "../key-meta.js";
import { fauxComputers } from "../faux-computers.js";
import { type ComputerDeps, computerDepsFrom, type ComputerDepsOptions } from "../workspace/computer-deps.js";
import { startJanitor } from "../workspace/computer-janitor.js";
import { projectRunEnded } from "../source-sync/checkpoints.js";
import { runEndComputers } from "../workspace/run-end-computers.js";
import { sayLoginRunner } from "../claude-login-token.js";
import { createDispatchLoop } from "./dispatch.js";
import { resolveRunnerLoop } from "./harness-loops.js";
import type { LoopFactory } from "./loop-contract.js";
import { routeOf } from "./model-route.js";
import { RUN_PROCESS_MIB, runnerMemory } from "./memory-claim.js";
import { childLoops, isolationLoops, type RunIsolation, RunIsolationRefused, runIsolationOf } from "./run-child-host.js";
import { sweepEndedScratch } from "./scratch-sweep.js";
import { runCensus } from "../run-census.js";
import { RUNNER_LOOPS, RUNNER_RENEW_EVERY_MS, runnerName, startRunner, type Runner, type RunnerEvent, type RunnerMemory } from "./runner.js";
import { keepPresence, type Presence } from "./presence.js";
import { diskFreeGate } from "./disk-free.js";
import { checkLines, checkRunnerEnv, type CheckRow } from "./runner-check.js";
import { metricLine, startRunnerGauge } from "./runner-metrics.js";

export { RUNNER_RENEW_EVERY_MS } from "./runner.js";

export interface RunnerProcessOptions {
  /** The data directory (--data): the store is the store module's file in it; the runner never names it. */
  dataDir: string;
  /** Most runs held at once (--loops). */
  loops?: number;
  /** How long close() lets each busy run finish its turn (--drain-timeout; RunnerOptions.drainMs). Default 0. */
  drainMs?: number;
  /** Its memory budget and its runs' weights (RunnerOptions.memory). Default: this host's memory, each run weighed by its
   *  harness (memory-claim.ts runnerMemory). */
  memory?: RunnerMemory;
  /** With the default memory: what each run's own process weighs beside its harness's run (memory-claim.ts
   *  RUN_PROCESS_MIB), for a runner whose runs are each a process of their own. Default 0. */
  processMib?: number;
  /** This runner's name in the runs it claims, its lines and its heartbeat. Default runner.ts runnerName(). */
  name?: string;
  /** Each claimed run's loop; default the runner's dispatch over the store (runnerLoop), with the computers it composed.
   *  A factory of the store is given the runner's dial and its paired computers' relay too, where it has a relay
   *  (dial-relay.ts). */
  createLoop?: LoopFactory | StoreFactory;
  /** Run the computer janitor (workspace/computer-janitor.ts) over the computers createLoop composed: at the start, then
   *  on its interval. Only the runner subcommand asks for it; a test that does not ask runs none. */
  janitor?: boolean;
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
  /** How often the store's runner floor is read again (Store.schemaState): each renewal (RUNNER_RENEW_EVERY_MS) unless a
   *  test says. */
  floorEveryMs?: number;
}

export interface RunnerProcess {
  readonly runner: Runner;
  /** What the store is, for the ready line: its kind and schema version. */
  readonly store: { readonly kind: string; readonly schema: number };
  /** What its runs may hold, in MiB (RunnerMemory.budgetMib): its host's memory, or its container's limit, less the
   *  server's own. Said once at its start, after the ready line. */
  readonly memoryMib: number;
  /** Settles, once, with the words of why, when the store's runner floor rises above the version this build knows (a
   *  later server applied a migration that breaks earlier runners): this runner should close, handing its runs back, and
   *  its process exit non-zero. Never settles otherwise. */
  readonly outdated: Promise<string>;
  /** Closes the runner (its loops stopped, its runs released), then its store connection. */
  close(): Promise<void>;
}

/** A store this runner cannot use, or arguments it cannot take, in words a person starting it can act on. */
export class RunnerRefused extends Error {
  override name = "RunnerRefused";
}

/** The store, opened as a runner, its kind and its schema version: refused when its schema is one this build does not
 *  know, not set up yet, or not yet upgraded by its server. The one place the runner opens its store (store/open.ts:
 *  Postgres when AGENTRUN_STORE_URL names one, else SQLite in the data directory). */
export async function openRunnerStore(dataDir: string, env: NodeJS.ProcessEnv, warn: (message: string) => void, url: string | undefined): Promise<{ store: Store; kind: string; schema: number }> {
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
    if (error instanceof StoreAwaitsServer) throw new RunnerRefused(`The store in ${where} is behind this runner: start the server first, which upgrades the store in place, then the runner.`, { cause: error });
    if (error instanceof RunnerBelowFloor) throw new RunnerRefused(`The store in ${where} is at schema version ${error.found}, and a runner on it must know version ${error.floor} or later; this runner knows ${error.known}: run a runner of the server's release.`, { cause: error });
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
 *  tokens (the token and the token list) and API key, the seal key (the runner holds it as its sealKey), the store's connection (its URL holds a
 *  database password), the launch hook's signing secret (the server's alone), and the Composio account key, which the
 *  runner's claim alone reads (composio-made.ts composioEnvKey) and sends only as a granted Composio server's MCP header.
 *  And every OpenTelemetry setting (OTEL_*: OTEL_EXPORTER_OTLP_HEADERS holds a backend's key): a run's process is never
 *  handed them, in an environment or on its pipe. It posts its trace over its channel and the runner exports it
 *  (otel/tracer.ts postedTracing, tracePosts), so no harness, tool or computer of a run has them. */
const RUNNER_ONLY = (name: string): boolean => name === "AGENTRUN_TOKEN" || name === "AGENTRUN_TOKENS" || name === "AGENTRUN_API_KEY" || name === SEAL_KEY_ENV || name === LAUNCH_HOOK_SECRET_ENV || name === COMPOSIO_KEY_ENV || name.startsWith("AGENTRUN_STORE_") || name.startsWith("OTEL_");

/** A run's environment as the runner hands its loops (AdapterSpecDeps.env): this process's, less the runner's own
 *  secrets, with every other secret the launcher's pipe handed it (a model key, a tool key, a box key) readable by name
 *  but not enumerable, as secrets.ts withSecrets makes them: code that reads one by name (the model route) finds it, and
 *  a spread of the object or a spawn given it carries none. */
export function runEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!RUNNER_ONLY(name)) out[name] = value;
  for (const name of SECRET_NAMES) {
    if (RUNNER_ONLY(name)) continue;
    const value = secret(name);
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: false, writable: false, configurable: false });
  }
  return out;
}

/** The run's computer at its claim, composed once for a runner (workspace/computer-deps.ts computerDepsFrom), the live view
 *  of a desktop or a phone (computer-live.ts openClaimView) with it: runnerLoop's, runnerBeside's and a test's in-process
 *  runner's. `own`: where Docker has the data directory and this host's addresses, and a test's kind registry and
 *  provider loader in place of the computer package's. Under --faux (the runs' environment names the faux model, as a
 *  --faux server's and a `runner --faux` give it), --faux's computers are beside them, as the server's start check
 *  reads them (server.ts computerReady): a run on the faux desktop is claimed, and its live view opened, the real way. */
export const runnerComputers = (store: Store, env: KeyEnv, sealKey: Buffer, own: Pick<ComputerDepsOptions, "kinds" | "load" | "dockerPaths" | "hostAddresses" | "hostWhy" | "hub" | "dial" | "pairedRelay"> = {}) =>
  // A runner on another host than its server (AGENTRUN_RUNNER_LIVE_HOST): its viewers answer there (live-reach.ts).
  computerDepsFrom({ env, store, sealKey, openComputerView: claimViewOpener(runnerLiveOf(env, sealKey)), ...(envValue(env, FAUX_ENV) ? { faux: fauxComputers() } : {}), ...own });

/** The beside-runner's environment (the CLI start's server-and-runner): runEnv of `env` with every test switch this
 *  process inherited taken out (AGENTRUN_SERVE_FAUX*, the harness table: a leftover in a shell would otherwise reach a
 *  run without --faux, as the server's own withoutFaux keeps it from the server), then `switches`, the ones this start
 *  enabled (server.ts fauxEnvOf). Deleted from runEnv's result, never spread: its secrets are non-enumerable and a spread
 *  drops them. */
export function besideRunEnv(env: NodeJS.ProcessEnv, switches: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = runEnv(env);
  for (const name of Object.keys(out)) if (name.startsWith(FAUX_PREFIX) || name === HARNESS_TABLE_ENV || name === HARNESS_MODULES_ENV || name === HARNESS_RECIPES_ENV) delete out[name];
  return Object.assign(out, switches);
}

/** The runner's loop for every run: the dispatch over the store (createDispatchLoop), each run's harness loop picked by
 *  its launch (harness-loops.ts resolveRunnerLoop), with the data directory, the run environment (runEnv), the store's
 *  journal, the seal key and the model route. `booted`: the seal key startRunnerProcess booted against the store (else
 *  this process's, as it was handed or booted). Refused in words with no seal key. */
export function runnerLoop(store: Store, dataDir: string, env: NodeJS.ProcessEnv = process.env, booted?: Buffer, isolation?: RunIsolation, dial?: HostedDial, paired?: PairedRelay): RunnerParts {
  const sealKey = booted ?? sealKeyOf(secret(SEAL_KEY_ENV) ?? env[SEAL_KEY_ENV]);
  if (!sealKey) throw new RunnerRefused(`A runner needs the server's seal key (${SEAL_KEY_ENV}): start it through the server's launcher, which hands it over.`);
  const runs = runEnv(env);
  // The run's computer at its claim, composed once (runnerComputers): none for the runner's place, a box's computer by the
  // agent's setting, its keys read from the run environment first, then the store's sealed rows; a Docker computer's
  // mounts by where this process's Docker has the data directory (box-paths.ts), read once; a desktop's or a phone's live
  // view opened with it. A machine that dials goes to this runner's own hub, through the server's relay (`dial`, its
  // relay's: dial-relay.ts); with none, its provider refuses. A paired computer is brought onto that same hub for the run
  // (`paired`, the relay's); with none, it is refused in words.
  const computers = runnerComputers(store, runs, sealKey, { dockerPaths: () => dockerPathsForRuns(runs, dataDir), hostAddresses: () => hostAddressesOnce(runs), hostWhy: hostCommandRefusals(PROVIDERS, process.env.PATH), ...(dial ? { dial } : {}), ...(paired ? { pairedRelay: paired } : {}) });
  const loopback = runnerLoopback(env);
  // The operator's bound on owner-allowed private hosts (mcp-private-hosts.ts), read by every dial this runner and its
  // runs' processes make (they inherit it, runEnv): said at the start when it narrows the owner's list.
  const privateBound = privateHostsSwitchValue(env);
  if (privateBound !== null) process.stderr.write(`agentrun-serve runner: ${PRIVATE_HOSTS_ENV}=${privateBound}: an owner's private-network hosts for MCP servers and calendars are ${privateBound.startsWith("none") ? "never allowed" : `allowed only in ${privateBound}`} on this runner\n`);
  if (loopback) process.stderr.write(`agentrun-serve runner: ${MCP_ALLOW_LOOPBACK_ENV}=1: this runner's runs may reach an MCP server on this machine's loopback, never at ${loopback.own.join(" or ")} nor where its server listens\n`);
  const deps = {
    env: runs, data: dataDir, journal: (claim: Parameters<Store["journal"]>[0]) => store.journal(claim), store, sealKey, routeOf,
    computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps,
    // A run's log lines (a sweep that failed) on the runner's stderr, as its
    // warnings are.
    log: (line: string) => void process.stderr.write(`agentrun-serve runner: ${line}\n`),
    // An MCP server on loopback: reached only when this process's own operator set AGENTRUN_MCP_ALLOW_LOOPBACK=1
    // (runnerLoopback), never at a server's own port on it.
    // The server's own addresses, as it kept them in the store at its last start, are read at each claim beside these.
    ...(loopback ? { mcpLoopback: true, mcpOwn: loopback.own, mcpOwnOf: () => serverOwn(store) } : {}),
  };
  // `isolation`: each run a process of its own (run-child-host.ts), as the runner subcommand runs them; none, in this one
  // (a test's runner).
  const createLoop = isolation ? childLoops({ deps, isolation, log: deps.log }) : createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) });
  return { createLoop, computers: computers.computerDeps, env: runs };
}

/** What a runner in its own process may reach on loopback, from its own environment alone, as a server takes its opt-in
 *  (cli.ts mcpLoopback): with AGENTRUN_MCP_ALLOW_LOOPBACK=1, an MCP server on this machine's loopback (the machine this
 *  process runs on, its container's in a container), never at `own`: the port a server listens on unless --port says
 *  otherwise (DEFAULT_PORT) and, when this environment names one on loopback, the port of its public address
 *  (AGENTRUN_PUBLIC_URL); runnerLoop adds, at each claim, the addresses the server kept in the store at its last start
 *  (serverOwn), so a run never reaches a server beside this runner through an MCP server's address, whatever its port.
 *  Undefined without it. The opt-in is never read from the store or the data directory: a runner never inherits
 *  another process's. */
export function runnerLoopback(env: NodeJS.ProcessEnv): { readonly own: readonly string[] } | undefined {
  if (env[MCP_ALLOW_LOOPBACK_ENV] !== "1") return undefined;
  const own = [`http://${LIVE_LOOPBACK}:${DEFAULT_PORT}`];
  const pub = URL.parse(env.AGENTRUN_PUBLIC_URL ?? "");
  if (pub && LOOPBACK.test(pub.hostname)) own.push(pub.origin);
  return { own };
}

/** A runner's loop factory with the run's computers it composed and the runs' environment: what the janitor sweeps with. */
export type RunnerParts = { readonly createLoop: LoopFactory; readonly computers: ComputerDeps; readonly env: NodeJS.ProcessEnv };

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
      writeFileSync(file, `${name}\n`, { mode: 0o600 });
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
  const env = options.env ?? process.env;
  const { store, kind, schema } = await openRunnerStore(options.dataDir, env, warn, options.storeUrl);
  // A store a later server migrated, additively: said once, so a runner behind its server is seen where it runs.
  const opened = await store.schemaState?.().catch(() => undefined);
  if (opened?.version != null && opened.version > schema) warn(`the store is at schema version ${opened.version}, ahead of this runner's ${schema}; its runner floor is ${opened.runnerFloor}, so this runner runs on it until a later migration raises the floor`);
  const memory = options.memory ?? runnerMemory(store, undefined, env, options.processMib ?? 0);
  let runner: Runner;
  let seal: Awaited<ReturnType<typeof bootSealKey>> | undefined;
  let janitor: ReturnType<typeof startJanitor> | undefined;
  let relay: RunnerRelay | undefined;
  let presence: Presence | undefined;
  try {
    // The server's seal key, booted the one way the server boots it (seal-key.ts): the one handed over, else the one in
    // this data directory, checked against what the store records. A runner on a store whose secrets another key sealed
    // (another machine's key on a shared Postgres, a lost key file) is refused in the server's words; a runner never makes
    // or records a key.
    seal = await bootSealKey(store, options.dataDir, { given: handedSecret(SEAL_KEY_ENV) ?? env[SEAL_KEY_ENV], role: "runner" });
    const name = options.name ?? runnerName();
    // One incarnation for this process: its word in the store that it is there (presence.ts) and its relay's minted
    // tokens and proofs name the same one, so the server's "restarted since" and the runner's row speak of one process.
    // The presence first, then the relay says where it answers on the presence's row.
    // Its row says this build's version and the most runs it holds (its loops), for the server's capacity read.
    const incarnation = randomUUID();
    presence = keepPresence(store.runners, name, null, { warn, incarnation, slots: options.loops ?? RUNNER_LOOPS });
    // Its relay (dial-relay.ts), where its environment names the server's public address: a machine that dials the
    // server lands in this runner's hub, through the server. Its log lines are the runner's warnings.
    relay = await startRunnerRelay({ store, sealKey: seal.key, runner: name, presence, env, log: warn });
    const made = options.createLoop ?? ofStore((opened, sealKey, dial, paired) => runnerLoop(opened, options.dataDir, undefined, sealKey, undefined, dial, paired));
    // A factory of the store (marked by ofStore) is given the store; a loop factory is used as is.
    const parts = isStoreFactory(made) ? made(store, seal.key, relay?.dial, relay?.paired) : made;
    const createLoop = typeof parts === "function" ? parts : parts.createLoop;
    // The janitor sweeps with the computers the loop composed, never a second composition. Its lines are the runner's
    // warnings, said where the runner says its others (warn: stderr unless a test gives its own).
    // It sweeps as this runner (its name and its presence's incarnation): a computer kept at a park pinned to another
    // runner still there is that runner's to end (computer-kept.ts sweepKept).
    if (options.janitor && typeof parts !== "function") janitor = startJanitor({ store, computers: parts.computers, env: parts.env, log: warn, self: { runner: name, incarnation } });
    // Before it claims: the scratch folders of runs that ended after their runner died (scratch-sweep.ts), said as warnings.
    await sweepEndedScratch(store, options.dataDir, { log: warn });
    // A run's end lets go of what its earlier claims' computers left, with the same computers (run-end-computers.ts).
    const runEnded = projectRunEnded(store, typeof parts !== "function" ? runEndComputers({ store, computers: parts.computers, log: warn }) : undefined);
    runner = startRunner({
      store,
      createLoop,
      name,
      presence,
      // Each end counts where in the run's files what its caller handed it sits, as the server reads them.
      census: runCensus(store, { data: options.dataDir, sealKey: seal.key, env }),
      ...(options.loops ? { loops: options.loops } : {}),
      ...(options.drainMs ? { drainMs: options.drainMs } : {}),
      memory,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      runEnded,
      // A runner on a disk of its own claims nothing while the server keeps runs' folders on the server's disk (Mode 1),
      // and says why on its presence row (disk-free.ts): those runs wait for a runner on the server's disk.
      claimGate: diskFreeGate(store, options.dataDir, env, kind),
      onBeat: heartbeat(options.dataDir, name, options.now ?? Date.now),
    });
  } catch (error) {
    await janitor?.close();
    await relay?.close();
    await presence?.close();
    seal?.release();
    await store.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const held = seal;
  const relayed = relay;
  const kept = presence;
  const floor = watchFloor(store, schema, options.floorEveryMs ?? RUNNER_RENEW_EVERY_MS);
  const close = () =>
    (closing ??= (async () => {
      floor.stop();
      // The janitor's sweep is cut and waited for on its own bound, beside the runner's close, never before it.
      await Promise.all([janitor?.close(), runner.close()]);
      // Its relay after its runs: a run's release revokes its machine's token through it. Then its word that it is
      // there: it claims no more.
      await relayed?.close();
      await kept.close();
      // A first-use install its claims started, stopped as they let go: its npm ends before this process can.
      await claimInstallsStopped();
      await store.close();
      held.release();
    })());
  // A floor above this runner closes it at once: it claims nothing from the read that saw the floor on, drains and hands
  // its runs back. The process's own close (runnerMain, after `outdated`) is this same close, awaited.
  // Its failure is the process's to say: runnerMain awaits this same close.
  void floor.outdated.then(() => close()).catch(() => undefined);
  return {
    runner,
    store: { kind, schema },
    memoryMib: memory.budgetMib,
    outdated: floor.outdated,
    close,
  };
}

/** Reads `store`'s runner floor every `everyMs` (Store.schemaState): `outdated` settles, once, with the words of why,
 *  when it is above `known`, the version this runner's build knows, and the reads stop. A read that fails (a busy store,
 *  a connection down) is tried at the next one: a renew's own failure says so, and only a floor read says to stop. */
function watchFloor(store: Store, known: number, everyMs: number): { readonly outdated: Promise<string>; stop(): void } {
  let settle!: (why: string) => void;
  const outdated = new Promise<string>((resolve) => (settle = resolve));
  if (!store.schemaState) return { outdated, stop: () => {} };
  let reading = false;
  let done = false;
  const read = async () => {
    if (reading || done) return;
    reading = true;
    try {
      const state = await store.schemaState!();
      if (done || state.runnerFloor === null || state.runnerFloor <= known) return;
      done = true;
      clearInterval(timer);
      settle(`the store is at schema version ${state.version}, and its runner floor rose to ${state.runnerFloor}, above the version this runner knows (${known}): a later server changed the schema in a way this runner cannot run beside`);
    } catch {
      // Tried again at the next read.
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void read(), everyMs);
  timer.unref();
  return {
    outdated,
    stop: () => {
      done = true;
      clearInterval(timer);
    },
  };
}

const storeFactories = new WeakSet<object>();
/** A function of the store: startRunnerProcess gives it the store it opens, and its relay's dial and paired computers'
 *  relay where it has a relay. */
type StoreFactory = (store: Store, sealKey: Buffer, dial?: HostedDial, paired?: PairedRelay) => LoopFactory | RunnerParts;
/** Marks `make` as a function of the store (StoreFactory). */
export function ofStore<Made extends LoopFactory | RunnerParts>(make: (store: Store, sealKey: Buffer, dial?: HostedDial, paired?: PairedRelay) => Made): (store: Store, sealKey: Buffer, dial?: HostedDial, paired?: PairedRelay) => Made {
  storeFactories.add(make);
  return make;
}
const isStoreFactory = (made: LoopFactory | StoreFactory): made is StoreFactory => storeFactories.has(made);

/** How long a runner process lets each busy run finish its turn on SIGTERM, unless --drain-timeout or
 *  AGENTRUN_DRAIN_TIMEOUT says: the image's server drain (its CMD's --drain-timeout 6s), so a runner beside a --no-runner
 *  server drains as the server's own runner would.
 *  BOUND: this drain plus the stuck-loop stop after it (runner.ts runnerCloseBoundMs: the claim's lease less its margin,
 *  30 s - 5 s = 25 s) is 6 + 25 = 31 s, inside deploy/compose.yaml's 35 s stop_grace_period for its runners
 *  (runner-beside-flags.test.mjs pins it). Raise this default only with that grace. */
export const RUNNER_DRAIN_TIMEOUT = "6s";
/** The environment's drain for a runner process when --drain-timeout gives none. */
export const RUNNER_DRAIN_ENV = "AGENTRUN_DRAIN_TIMEOUT";

/** What a runner process holds, from its arguments and `env`: --loops, else the server's --max-runs default
 *  (AGENTRUN_MAX_RUNS, else as many pi runs as this host's memory holds; maxRunsOf); --drain-timeout, else
 *  AGENTRUN_DRAIN_TIMEOUT, else RUNNER_DRAIN_TIMEOUT. A bad AGENTRUN_MAX_RUNS, AGENTRUN_DRAIN_TIMEOUT or
 *  AGENTRUN_FREE_MODEL_REQUESTS is RunnerRefused. */
export function runnerHolds(args: { loops?: number; drainMs?: number }, env: NodeJS.ProcessEnv): { loops: number; drainMs: number } {
  let loops = args.loops;
  if (loops === undefined) {
    try {
      loops = maxRunsOf(env);
    } catch (error) {
      throw new RunnerRefused((error as Error).message);
    }
  }
  let drainMs = args.drainMs;
  if (drainMs === undefined) {
    const given = env[RUNNER_DRAIN_ENV];
    drainMs = durationMs(given || RUNNER_DRAIN_TIMEOUT);
    if (drainMs === undefined) throw new RunnerRefused(`${RUNNER_DRAIN_ENV} is a duration such as 6s, 500ms or 1m, not ${JSON.stringify(given)}`);
  }
  // The limit on each run's requests on free models (AGENTRUN_FREE_MODEL_REQUESTS), read again at each claim: a bad one refuses
  // the runner here, never a run at its claim.
  try {
    freeModelRequestsOf(env);
  } catch (error) {
    throw new RunnerRefused((error as Error).message);
  }
  return { loops, drainMs };
}

/** The runner process's arguments: `--data D [--loops N] [--drain-timeout D] [--name N] [--faux M [--faux-browser M]]`, or
 *  `--check --data D [--name N]`. Each option with a value is also taken as `--option=value` (the bin hands a data
 *  directory that starts with "-" so, never read as an option); an empty one is refused like a missing one. `--faux`: the
 *  faux model module, a test switch, as the server's own --faux; the only way a runner loads one. `--faux-browser`: the
 *  fake browser's module, with --faux only, as the server's. */
export function runnerArgs(argv: readonly string[]): { dataDir: string; loops?: number; drainMs?: number; name?: string; faux?: string; fauxBrowser?: string; check?: true; envOnly?: true; heartbeatOnly?: true; harnessModules?: string[]; harnessRecipes?: string[] } {
  let dataDir: string | undefined;
  let envOnly = false;
  let heartbeatOnly = false;
  let loops: number | undefined;
  let drainMs: number | undefined;
  let name: string | undefined;
  let faux: string | undefined;
  let fauxBrowser: string | undefined;
  let check = false;
  const harnessModules: string[] = [];
  const harnessRecipes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const given = argv[i]!;
    const equals = /^(--(?:data|loops|drain-timeout|name|faux|faux-browser|harness-module|harness-recipe))=(.*)$/s.exec(given);
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
    } else if (arg === "--drain-timeout") {
      const text = value();
      drainMs = durationMs(text);
      if (drainMs === undefined) throw new RunnerRefused(`--drain-timeout is a duration such as 6s, 500ms or 1m, not ${JSON.stringify(text)}`);
    } else if (arg === "--name") name = value();
    else if (arg === "--faux") faux = value();
    else if (arg === "--faux-browser") fauxBrowser = value();
    else if (arg === "--harness-module") harnessModules.push(value());
    else if (arg === "--harness-recipe") harnessRecipes.push(value());
    else if (arg === "--check") check = true;
    else if (arg === "--env") envOnly = true;
    else if (arg === "--heartbeat") heartbeatOnly = true;
    else throw new RunnerRefused(`unknown argument ${JSON.stringify(arg)}: a runner takes --data D [--loops N] [--drain-timeout D] [--name N] [--faux M [--faux-browser M]] [--harness-module M ...] [--harness-recipe F ...], or --check --data D [--name N], or --check --env [--data D], or --check --heartbeat --data D [--name N]`);
  }
  if (envOnly && !check) throw new RunnerRefused("--env goes with --check: runner --check --env [--data D]");
  if (heartbeatOnly && !check) throw new RunnerRefused("--heartbeat goes with --check: runner --check --heartbeat --data D [--name N]");
  if (heartbeatOnly && envOnly) throw new RunnerRefused("--check takes --env (its environment alone) or --heartbeat (its heartbeat alone), not both: give neither to check both");
  // `--check --env` checks the environment alone, which needs no data directory where the store is AGENTRUN_STORE_URL's.
  if (envOnly) return { dataDir: dataDir ?? "", check: true, envOnly: true, ...(harnessModules.length ? { harnessModules } : {}), ...(harnessRecipes.length ? { harnessRecipes } : {}), ...(loops === undefined ? {} : { loops }), ...(drainMs === undefined ? {} : { drainMs }), ...(name === undefined ? {} : { name }) };
  if (!dataDir) throw new RunnerRefused("a runner needs its data directory: --data D");
  if (heartbeatOnly) return { dataDir, check: true, heartbeatOnly: true, ...(name === undefined ? {} : { name }) };
  if (fauxBrowser !== undefined && faux === undefined) throw new RunnerRefused("--faux-browser goes with --faux");
  return { dataDir, ...(harnessModules.length ? { harnessModules } : {}), ...(harnessRecipes.length ? { harnessRecipes } : {}), ...(loops === undefined ? {} : { loops }), ...(drainMs === undefined ? {} : { drainMs }), ...(name === undefined ? {} : { name }), ...(faux === undefined ? {} : { faux }), ...(fauxBrowser === undefined ? {} : { fauxBrowser }), ...(check ? { check: true as const } : {}) };
}

/** Runs until SIGTERM or SIGINT, or until the store's runner floor rises above this runner (RunnerProcess.outdated),
 *  then closes: nothing more claimed, the drain, its runs handed back. Answers the floor's words when that was the stop,
 *  else undefined. `ready` is called once the signals are handled, never before: a line that says the runner is ready (on
 *  a pipe, written at once) may bring a SIGTERM back before the next statement runs, and one that came before the
 *  handlers would end the process unclosed. `outdated`: told the floor's words before the close begins. */
export async function runUntilSignalled(process: Pick<RunnerProcess, "close"> & Partial<Pick<RunnerProcess, "outdated">>, signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"], ready: () => void = () => {}, outdated: (why: string) => void = () => {}): Promise<string | undefined> {
  const why = await new Promise<string | undefined>((resolve) => {
    const done = (value: string | undefined) => {
      for (const signal of signals) globalThis.process.off(signal, onSignal);
      resolve(value);
    };
    const onSignal = () => done(undefined);
    for (const signal of signals) globalThis.process.on(signal, onSignal);
    void process.outdated?.then(done);
    ready();
  });
  if (why !== undefined) outdated(why);
  await process.close();
  return why;
}

/** The runner process's last resort (runnerMain installs it for unhandledRejection and uncaughtException): says what
 *  went wrong, in the runner's name with its stack, then exits 1 at once, closing nothing. A runner that went on after
 *  an error nothing handled could keep renewing the claim of a run whose loop is dead, and that run would hang claimed
 *  by a live runner. Exiting lets the claim lapse: another runner (or this one, started again) takes the run back at the
 *  next epoch, and the fence refuses the dead loop's late writes. The line is written to stderr synchronously
 *  (writeSync), so a pipe's slow reader still gets the whole stack before the exit. Exported for its test. */
export function lastResort(name: string, write: (line: string) => void = (line) => void writeSync(2, line), exit: (code: number) => void = (code) => process.exit(code)): (reason: unknown) => void {
  return (reason) => {
    const said = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
    write(`agentrun-serve runner: Runner ${name}: an error nothing handled, so the runner exits (its claims lapse, and are taken back): ${said}\n`);
    exit(1);
  };
}

/** One line of what the runner did, in its name. */
function said(name: string, event: RunnerEvent): string | undefined {
  if (event.type === "refusing") return event.reason === null ? `Runner ${name} claims runs again` : undefined;
  if (event.type === "claimed") return `Runner ${name} claimed ${event.claim.runId} (epoch ${event.claim.epoch})`;
  if (event.type === "released") return `Runner ${name} released ${event.runId} (${event.end})`;
  if (event.type === "started" || event.type === "ended") return runLine(event);
  return troubleLine(name, event);
}

/** The line of a runner's trouble, in its name: a claim it lost, and an error (a renew or a stop that failed), which
 *  goes to stderr. Undefined for any other event. The runner beside a server says them the same way (beside.ts), so a
 *  lapse of every claim at once shows its cause. */
export function troubleLine(name: string, event: RunnerEvent): string | undefined {
  if (event.type === "refusing" && event.reason !== null) return `Runner ${name} claims nothing: ${event.reason}`;
  if (event.type === "claim-lost") return `Runner ${name} lost its claim on ${event.runId} (${event.why})`;
  if (event.type === "error") return `Runner ${name}: ${event.step}${event.runId ? ` ${event.runId}` : ""}: ${event.message}`;
  return undefined;
}

/** `agentrun-serve runner ...`: the exit code. 2: bad arguments; 3: a store this runner cannot open (a schema it does not
 *  know, none set up yet, or one its server has yet to upgrade), or one whose runner floor rose above it while it ran
 *  (closed, its runs handed back); 1: anything else; 0: closed on a signal, or --check found a fresh heartbeat. AGENTRUN_RUNNER_NAME names it when --name does not. */
export async function runnerMain(argv: readonly string[], given: NodeJS.ProcessEnv = process.env, hooks: RunnerMainHooks = {}): Promise<number> {
  let args: ReturnType<typeof runnerArgs>;
  try {
    args = runnerArgs(argv);
  } catch (error) {
    if (!(error instanceof RunnerRefused)) throw error;
    console.error(`agentrun-serve runner: ${error.message}`);
    return 2;
  }
  // A test switch is this start's option alone, as on the server (server.ts withoutFaux, fauxEnvOf): one the process
  // inherited (AGENTRUN_SERVE_FAUX*, the harness table, left in an operator's shell or a platform's settings) never loads
  // a module or decides what a run answers. --faux sets the faux model's, --faux-browser the fake browser's.
  // The owner's harness modules are this start's too: --harness-module, else AGENTRUN_SERVE_HARNESS_MODULES, as the
  // server reads them, so a runner apart from the server runs the harnesses its table adds. Each is loaded and checked
  // here, as the server's start checks them (harness-table.ts harnessTable), before the runner opens the store or claims a
  // run: a module that names a built-in, repeats an id, gives an id the API does not carry or lacks a member refuses the
  // start in words naming the module and the id, never failing every run the runner would claim.
  // Its harness recipes the same way: --harness-recipe, else AGENTRUN_SERVE_HARNESS_RECIPES, each loaded here.
  let modules: NodeJS.ProcessEnv;
  try {
    modules = { ...harnessModulesEnv(harnessModulesOf(args.harnessModules, given), args.dataDir), ...harnessRecipesEnv(harnessRecipesOf(args.harnessRecipes, given), args.dataDir) };
    harnessTable(modules);
  } catch (error) {
    console.error(`agentrun-serve runner: ${(error as Error).message}`);
    return 2;
  }
  const env: NodeJS.ProcessEnv = { ...withoutFaux(given), ...modules, ...(args.faux ? { [FAUX_ENV]: resolve(args.faux) } : {}), ...(args.fauxBrowser ? { [FAUX_BROWSER_ENV]: resolve(args.fauxBrowser) } : {}) };
  const name = args.name ?? env.AGENTRUN_RUNNER_NAME ?? undefined;
  if (args.check) return runnerCheck(args, env, name);
  let holds: ReturnType<typeof runnerHolds>;
  try {
    holds = runnerHolds(args, env);
    // The Archil settings an operator sets, read by every run's claim here as the server reads them (archil-settings.ts):
    // one of the region and S3 URL without the other, or a value the server would refuse, stops this start as it stops
    // the server's.
    archilSettingsFromEnv(env);
  } catch (error) {
    if (!(error instanceof RunnerRefused) && !(error instanceof ArchilSettingsEnvInvalid)) throw error;
    console.error(`agentrun-serve runner: ${error.message}`);
    return 2;
  }
  // Each run a process of its own, as a user of its own where the image's helper can switch: a helper that cannot is
  // refused here in words that name the setting (run-child-host.ts runIsolationOf), before any run is claimed. The slots
  // the helper reaches bound the runs held at once: a number it was told (--loops, AGENTRUN_MAX_RUNS) past them is
  // refused, and its memory's count is cut to them, said on its log.
  let isolation: RunIsolation;
  const told = args.loops !== undefined || Boolean(env.AGENTRUN_MAX_RUNS);
  try {
    isolation = await runIsolationOf(env, told ? holds.loops : undefined, (line) => void console.error(`agentrun-serve runner: ${line}`));
  } catch (error) {
    if (!(error instanceof RunIsolationRefused)) throw error;
    // Said, then up and claiming nothing until a stop: in the image's server-and-runner either process's exit stops the
    // container, which a platform that restarts it (Render, Railway) would loop on, the refusal lost in the restarts.
    console.error(`agentrun-serve runner: ${error.message}`);
    // And said in the store until the stop (presence.ts), so the server, in its own process or on another host, refuses a
    // launch in these words and fails the runs left queued while no runner that claims is there.
    const stop = untilSignalled(RUNNER_SIGNALS);
    await refusedInStore(args.dataDir, env, name ?? runnerName(), error.message, stop);
    return 0;
  }
  if (isolation.kind === "uid" && holds.loops > isolation.slots) console.error(`agentrun-serve runner: each run runs as a user of its own, and the helper reaches ${isolation.slots} slots from slot ${isolation.first}: this runner holds at most ${isolation.slots} runs at once`);
  holds = { ...holds, loops: isolationLoops(isolation, holds.loops) };
  let started: RunnerProcess;
  const runnerOf = name ?? runnerName();
  // Said on the data folder before it claims: whether its runs on Claude Code's login stay in this process, its CLI on
  // the login's folder (claude-login-token.ts sayLoginRunner), for a runner whose runs are users of their own to read.
  sayLoginRunner(args.dataDir, runnerOf, isolation.kind === "uid" ? "uid" : "process");
  // The last resort, in this process only (never the library, the server's CLI or the runner beside a server): an error
  // nothing handled is said with its stack, and the process exits 1 at once (lastResort: crashing is the safe failure).
  const fatal = lastResort(runnerOf);
  process.on("unhandledRejection", fatal);
  process.on("uncaughtException", fatal);
  // The stop is listened for before the start, as the server's CLI listens (cli.ts): startRunnerProcess starts claiming
  // runs before it returns, so a SIGTERM or SIGINT during it (a platform's redeploy) would otherwise end the process by the
  // signal itself, its claims held and a paid request in flight cut. A stop asked then is kept, and the runner closes as
  // soon as its start is done, through the same close as a stop after it: its runs handed back, its store closed.
  let asked = false;
  const early = () => void (asked = true);
  for (const signal of RUNNER_SIGNALS) process.on(signal, early);
  const unlisten = () => {
    for (const signal of RUNNER_SIGNALS) process.off(signal, early);
  };
  try {
    started = await startRunnerProcess({
      dataDir: args.dataDir,
      name: runnerOf,
      env,
      loops: holds.loops,
      drainMs: holds.drainMs,
      // Each run a process of its own (`isolation`); its computer, with this runner's relay's dial, held here in the
      // runner, which the run's process asks for it over its channel (run-child-host.ts, held.ts computer).
      createLoop: ofStore((store, sealKey, dial, paired) => runnerLoop(store, args.dataDir, env, sealKey, isolation, dial, paired)),
      // Each run's own process weighed beside its harness's run (memory-claim.ts RUN_PROCESS_MIB).
      processMib: RUN_PROCESS_MIB,
      // The runner subcommand ends what a crashed runner of this server left (never under --faux).
      janitor: true,
      onEvent: (event) => {
        if (event.type === "error" || (event.type === "refusing" && event.reason !== null)) return void console.error(troubleLine(runnerOf, event));
        const line = said(runnerOf, event);
        if (line) console.log(line);
        // Its metric line beside it (runner-metrics.ts): claims, hand-backs by cause, the drain.
        const metric = metricLine(runnerOf, event);
        if (metric) console.log(metric);
      },
    });
  } catch (error) {
    unlisten();
    console.error(`agentrun-serve runner: ${(error as Error)?.message ?? String(error)}`);
    return error instanceof RunnerRefused && (error.cause instanceof SchemaVersionUnknown || error.cause instanceof StoreAwaitsServer) ? 3 : 1;
  }
  await hooks.started?.(started);
  // From here the handlers below take the stop, with nothing awaited between: no signal falls in a gap.
  unlisten();
  if (asked) {
    console.log(`Runner ${started.runner.name} stopping: a stop came during its start`);
    await started.close();
    return 0;
  }
  // Its gauge (runner-metrics.ts): the runs it holds of its loops, and its process's memory, every minute until its stop.
  const gauge = startRunnerGauge({ runner: started.runner.name, held: () => started.runner.held().length, slots: holds.loops, write: (line) => console.log(line) });
  // Ready is said once SIGTERM and SIGINT are handled, so a stop sent on reading it always closes the runner.
  // Then its memory budget, a line of its own (the ready line's shape is read by deploy checks): what a container's limit
  // gave it is seen where it runs.
  try {
    const outdated = await runUntilSignalled(started, RUNNER_SIGNALS, () => {
      console.log(`Runner ${started.runner.name} ready: store ${started.store.kind} schema v${started.store.schema}, ${holds.loops} loops`);
      console.log(`Runner ${started.runner.name} memory: ${started.memoryMib} MiB for runs, each weighed by its harness`);
    }, (why) => console.error(`agentrun-serve runner: Runner ${started.runner.name} stops claiming and hands its runs back: ${why}. Run a runner of the server's release.`));
    // Past the floor: non-zero, so its platform starts a runner of the new release in its place.
    return outdated === undefined ? 0 : 3;
  } finally {
    gauge.stop();
  }
}

/** `runner --check`: the runner's environment (runner-check.ts checkRunnerEnv), by name, never by value, then, without
 *  --env, its heartbeat in --data under its name (checkRunner). `--heartbeat`: the heartbeat alone, with no store and no
 *  secret (a liveness check a database blip does not fail). Each row on stdout, each gap on stderr too. 0 when nothing is
 *  missing or bad and the heartbeat is fresh, 1 otherwise, 2 for a heartbeat check with no name. */
async function runnerCheck(args: ReturnType<typeof runnerArgs>, env: NodeJS.ProcessEnv, name: string | undefined): Promise<number> {
  if (!args.envOnly && !name) {
    console.error("agentrun-serve runner: --check needs the runner's name: --name N or AGENTRUN_RUNNER_NAME (or --check --env, for its environment alone)");
    return 2;
  }
  // Harness modules given as --harness-module hold what AGENTRUN_SERVE_HARNESS_MODULES would (harness-table.ts
  // harnessModulesOf): a runner started with the flag is checked with it.
  const flagged = "harnessModules" in args && args.harnessModules?.length ? args.harnessModules.join(",") : undefined;
  const recipesFlagged = "harnessRecipes" in args && args.harnessRecipes?.length ? args.harnessRecipes.join(",") : undefined;
  const read = (one: string) => (one === HARNESS_MODULES_SETTING && flagged !== undefined ? flagged : one === HARNESS_RECIPES_SETTING && recipesFlagged !== undefined ? recipesFlagged : (secret(one) ?? env[one]));
  const rows: CheckRow[] = args.heartbeatOnly ? [] : await checkRunnerEnv({ ...(args.dataDir ? { dataDir: args.dataDir } : {}), env, read });
  // What the runner's start refuses before it claims (runnerMain): its run slots, drain and free-model requests, the
  // Archil settings it is given, and its runs' isolation (the user each run runs as, and the image's helper that switches
  // to it), checked the same way, so a runner whose start would stop or claim nothing never passes this check.
  if (!args.heartbeatOnly) {
    try {
      // The flags the runner is started with win over the environment there (--loops, --drain-timeout), and here.
      const loops = "loops" in args ? args.loops : undefined;
      const holds = runnerHolds({ ...(loops !== undefined ? { loops } : {}), ...("drainMs" in args && args.drainMs !== undefined ? { drainMs: args.drainMs } : {}) }, env);
      archilSettingsFromEnv(env);
      await runIsolationOf(env, loops !== undefined || Boolean(env.AGENTRUN_MAX_RUNS) ? holds.loops : undefined, () => {});
      rows.push({ state: "ok", name: "start", why: "the runner's start takes its settings: run slots, drain, free-model requests, Archil, run isolation" });
    } catch (error) {
      if (!(error instanceof RunnerRefused) && !(error instanceof ArchilSettingsEnvInvalid) && !(error instanceof RunIsolationRefused)) throw error;
      rows.push({ state: "bad", name: "start", why: `the runner's start refuses its environment: ${error.message}` });
    }
  }
  if (!args.envOnly && name) {
    const checked = checkRunner({ dataDir: args.dataDir, name });
    rows.push(checked.ok ? { state: "ok", name: "heartbeat", why: `Runner ${name} is alive` } : { state: "bad", name: "heartbeat", why: checked.why });
  }
  const { lines, ok } = checkLines(rows);
  for (const line of lines) console.log(line);
  for (const row of rows) if (row.state === "missing" || row.state === "bad") console.error(`agentrun-serve runner: ${row.name}: ${row.why}`);
  return ok ? 0 : 1;
}

/** The signals that stop a runner process. */
const RUNNER_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** How long a refusing runner waits before it tries its store again (refusedInStore). */
const REFUSED_STORE_RETRY_MS = 5_000;

/** A runner whose run isolation was refused: its `words` kept in its store (presence.ts) until `stopped`, then its row
 *  removed and the store closed. A store that does not open (not set up yet, one its server has yet to upgrade, a
 *  connection down) is said, once for each reason, and tried again every REFUSED_STORE_RETRY_MS until it opens or the
 *  stop: a runner that starts before its server still tells that server, once it is there. */
async function refusedInStore(dataDir: string, env: NodeJS.ProcessEnv, name: string, words: string, stopped: Promise<void>): Promise<void> {
  const warn = (line: string) => void console.error(`agentrun-serve runner: ${line}`);
  let stop = false;
  void stopped.then(() => void (stop = true));
  let said: string | undefined;
  while (!stop) {
    let store: Store;
    try {
      ({ store } = await openRunnerStore(dataDir, env, warn, undefined));
    } catch (error) {
      const why = (error as Error)?.message ?? String(error);
      if (why !== said) warn(`the server is not told yet that this runner claims nothing, since its store did not open (tried again every ${REFUSED_STORE_RETRY_MS / 1000} s): ${why}`);
      said = why;
      await Promise.race([sleep(REFUSED_STORE_RETRY_MS, undefined, { ref: false }), stopped]);
      continue;
    }
    if (said !== undefined) warn("its store opened: the server is told that this runner claims nothing");
    const presence = keepPresence(store.runners, name, words, { warn });
    await stopped;
    await presence.close();
    await store.close();
    return;
  }
}

/** Holds the process up, with nothing else to do, until one of `signals`. */
function untilSignalled(signals: readonly NodeJS.Signals[]): Promise<void> {
  return new Promise<void>((resolve) => {
    // A signal's listener alone does not keep Node's loop alive.
    const alive = setInterval(() => {}, 2 ** 30);
    const onSignal = () => {
      for (const signal of signals) process.off(signal, onSignal);
      clearInterval(alive);
      resolve();
    };
    for (const signal of signals) process.on(signal, onSignal);
  });
}

/** A test's hooks into runnerMain: `started`, awaited once the runner has started claiming and before its stop handlers
 *  take over from the ones its start listened on (the window a stop must not fall through). */
export type RunnerMainHooks = { readonly started?: (process: RunnerProcess) => void | Promise<void> };
