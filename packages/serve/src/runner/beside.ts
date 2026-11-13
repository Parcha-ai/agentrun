// A runner beside a server on the same data directory: the CLI start's server-and-runner, the `runner` subcommand and
// the template eval's in-process server (template-eval.ts), which would otherwise leave every run it starts queued.
import { maxRunsOf } from "../host.js";
import { durationMs } from "../print.js";
import { runnerCloseBoundMs } from "./runner.js";

/** How long a busy run may finish its turn when the server stops, unless --drain-timeout says (cli.ts). */
export const DRAIN_TIMEOUT = "30s";

/** The runner beside a server holds what the server's own flags say (cli.ts): at most --max-runs runs at once (the same
 *  number maxRunsOf gives the capabilities' max_concurrent_runs: AGENTRUN_MAX_RUNS, else as many pi runs as this host's
 *  memory holds), and on its close lets each held run finish its turn for up to --drain-timeout (default DRAIN_TIMEOUT)
 *  before it stops the rest to resume. The server has checked both by the time this reads them (startServe). */
export function besideRunnerOptions(serve: { maxRuns?: number; drainTimeout?: string }, env: NodeJS.ProcessEnv): { loops: number; drainMs: number } {
  const drainTimeout = serve.drainTimeout ?? DRAIN_TIMEOUT;
  const drainMs = durationMs(drainTimeout);
  if (drainMs === undefined) throw new Error(`the drain timeout ${drainTimeout} is not a duration such as 8s`);
  return { loops: maxRunsOf(env, serve.maxRuns), drainMs };
}

/** What the CLI's stop waits on (stop-signals.ts StopDeps.stopping) with a runner beside the server: the server's runs
 *  and the runs the runner holds, and the longer of the server's bound and the runner's whole close (its drain, then
 *  the stop of the loops left: runnerCloseBoundMs), so the stop's deadline never cuts a run's end and release short. */
export function besideStopping(server: { runs: number; boundMs: number }, held: number, drainMs: number): { runs: number; boundMs: number } {
  return { runs: server.runs + held, boundMs: Math.max(server.boundMs, runnerCloseBoundMs(drainMs)) };
}

/** A runner beside the server on the same data directory (the CLI start's server-and-runner, and the `runner` subcommand):
 *  its own store handle (role runner), and the runner's dispatch (dispatch.ts) for each claimed run — pi on the kernel's
 *  adapter loop, a learning run on the learning loop. `env`: the runs' environment (runEnv of this process's, unless a
 *  caller hands its own: the template eval's in-process server, its faux's). `loops` and `drainMs`: the runner's
 *  (RunnerOptions), the CLI start's from the server's flags (besideRunnerOptions). `janitor`: run the computer janitor
 *  too (workspace/computer-janitor.ts), as the CLI's start asks. Returns the runner and a close() that stops both and
 *  closes its store. */
export async function runnerBeside(dataDir: string, { loops, drainMs, env, janitor, mcpLoopback, onLine }: { loops?: number; drainMs?: number; env?: NodeJS.ProcessEnv; janitor?: boolean; mcpLoopback?: boolean; onLine?: (line: string) => void } = {}): Promise<{ runner: Awaited<ReturnType<typeof import("./runner.js")["startRunner"]>>; close: () => Promise<void> }> {
  const { startRunner } = await import("./runner.js");
  const { dispatchRunner } = await import("./harness-loops.js");
  const { routeOf } = await import("./model-route.js");
  const { openRunnerStore, runEnv } = await import("./main.js");
  const { computerDepsFrom } = await import("../workspace/index.js");
  // The server's store, the runner's one way in (main.ts openRunnerStore, store/open.ts): Postgres when this process's
  // AGENTRUN_STORE_URL secret names one, else SQLite in the data directory; a schema it does not know is RunnerRefused.
  const { store } = await openRunnerStore(dataDir, process.env, (message) => void process.stderr.write(`agentrun-serve runner: ${message}\n`), undefined);
  // The server's seal key (seal-key.ts), booted the one way and checked against the store: the one handed over (read
  // through secrets.js, which moves it out of the environment as it loads), else the one in the data directory. A runner
  // never starts without it, nor with a key that is not the store's: it seals the live-viewer tokens, and there is no
  // stand-in key.
  const { bootSealKey } = await import("../seal-key.js");
  let seal: Awaited<ReturnType<typeof bootSealKey>>;
  try {
    seal = await bootSealKey(store, dataDir, { role: "runner" });
  } catch (error) {
    await store.close();
    throw error;
  }
  // The beside-runner sees the server's environment as a separate runner would (runEnv, not withoutFaux): so an API run on
  // a --faux server reaches the faux gateway and its computers. The run's claim-time computer is composed once, the one way
  // (workspace/computer-deps.ts computerDepsFrom), from that same environment; a Docker computer's mounts by where this
  // process's Docker has the data directory (box-paths.ts), read once.
  const runs = env ?? runEnv(process.env);
  const { dockerPathsForRuns } = await import("../box-paths.js");
  const { hostAddressesOnce } = await import("../docker-host-addresses.js");
  const { PROVIDERS } = await import("@parcha/agentrun-computer");
  const { hostCommandRefusals } = await import("../computers.js");
  const computers = computerDepsFrom({ env: runs, store, sealKey: seal.key, dockerPaths: () => dockerPathsForRuns(runs, dataDir), hostAddresses: () => hostAddressesOnce(runs), hostWhy: hostCommandRefusals(PROVIDERS, process.env.PATH) });
  // `mcpLoopback`: the server beside it is a local install (Serve.localInstall), so its runs may reach an MCP server on
  // loopback; any other runner's runs never do.
  const createLoop = dispatchRunner({ env: runs, data: dataDir, journal: (claim) => store.journal(claim), store, sealKey: seal.key, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps, ...(mcpLoopback ? { mcpLoopback: true } : {}) });
  // It claims by the host's memory as well as by --max-runs (memory-claim.ts): a heavy harness's run waits queued for room.
  const { runnerMemory } = await import("./memory-claim.js");
  // Before it claims: the scratch folders of runs that ended after their runner died (scratch-sweep.ts).
  const { sweepEndedScratch } = await import("./scratch-sweep.js");
  await sweepEndedScratch(store, dataDir, { log: (line) => console.error(`agentrun-serve runner: ${line}`) });
  // Its run start and end lines go where the server's lines do (print.ts runLine), the one stdout; `onLine` is where a
  // launcher in this process (a test) reads them instead.
  const { runLine } = await import("../print.js");
  const runner = startRunner({ store, createLoop, memory: runnerMemory(store), onEvent: (event) => { const line = runLine(event); if (line) (onLine ?? console.log)(line); }, ...(loops !== undefined ? { loops } : {}), ...(drainMs !== undefined ? { drainMs } : {}) });
  // The computer janitor over the same computers, when the start asks for it: never under --faux. Its lines are the
  // runner's, on stderr (a stderr whose reader closed loses them, never the process: cli.ts).
  const { startJanitor } = await import("../workspace/computer-janitor.js");
  const swept = janitor ? startJanitor({ store, computers: computers.computerDeps, env: runs, log: (line) => console.error(`agentrun-serve runner: ${line}`) }) : undefined;
  // Its close waits for any first-use install its claims let go of to stop (its npm ended) before it lets go of the data.
  const { claimInstallsStopped } = await import("../harness-install.js");
  // The janitor's sweep is cut and waited for on a bound of its own, beside the runner's close, never before it.
  return { runner, close: async () => { await Promise.all([swept?.close(), runner.close()]); await claimInstallsStopped(); await store.close(); seal.release(); } };
}

/** A server and one runner beside it, both in this process, as the CLI's start composes them (cli.ts): the runner holds
 *  what the server's options say (besideRunnerOptions) and sees the server's test switches (fauxEnvOf), so a --faux
 *  server's runs reach its fakes. For a launcher that starts serve in-process (a demo, a smoke): a server alone leaves
 *  every run queued. close() stops both. */
export async function serveWithRunner(options: import("../server.js").ServeOptions): Promise<{ serve: import("../server.js").Serve; close(): Promise<void> }> {
  const { fauxEnvOf, startServe } = await import("../server.js");
  const { besideRunEnv } = await import("./main.js");
  const { loops, drainMs } = besideRunnerOptions(options, process.env);
  const serve = await startServe(options);
  const beside = await runnerBeside(options.data, { loops, drainMs, env: besideRunEnv(process.env, fauxEnvOf(options)), mcpLoopback: serve.localInstall, ...(options.log ? { onLine: options.log } : {}) }).catch(async (error: unknown) => {
    await serve.close();
    throw error;
  });
  // Once: a second call (a SIGTERM and a SIGINT both) is the first one's promise, so the runner's store is never closed
  // under a run still finishing.
  let closing: Promise<void> | undefined;
  return { serve, close: () => (closing ??= Promise.all([beside.close(), serve.close()]).then(() => undefined)) };
}
