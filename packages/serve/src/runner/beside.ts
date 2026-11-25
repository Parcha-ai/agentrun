// A runner beside a server on the same data directory: the CLI start's server-and-runner, the `runner` subcommand and
// the template eval's in-process server (template-eval.ts), which would otherwise leave every run it starts queued.
import { maxRunsOf } from "../host.js";
import { durationMs } from "../print.js";
import { RUNNER_LOOPS, type RunnerEvent, runnerCloseBoundMs } from "./runner.js";

/** How long a busy run may finish its turn when the server stops, unless --drain-timeout says (cli.ts). */
export const DRAIN_TIMEOUT = "30s";

/** The runner beside a server holds what the server's own flags say (cli.ts): at most --max-runs runs at once (the same
 *  number maxRunsOf gives the capabilities' max_concurrent_runs: AGENTRUN_MAX_RUNS, else as many pi runs as this host's
 *  memory holds), and on its close lets each held run finish its turn for up to --drain-timeout (default DRAIN_TIMEOUT)
 *  before it stops the rest to resume. The server has checked both by the time this reads them (startServe). */
export function besideRunnerOptions(serve: { maxRuns?: number; drainTimeout?: string }, env: NodeJS.ProcessEnv): { loops: number; loopsTold: boolean; drainMs: number } {
  const drainTimeout = serve.drainTimeout ?? DRAIN_TIMEOUT;
  const drainMs = durationMs(drainTimeout);
  if (drainMs === undefined) throw new Error(`the drain timeout ${drainTimeout} is not a duration such as 8s`);
  // `loopsTold`: the number was given (--max-runs, AGENTRUN_MAX_RUNS), not the host's memory's count.
  return { loops: maxRunsOf(env, serve.maxRuns), loopsTold: serve.maxRuns !== undefined || Boolean(env.AGENTRUN_MAX_RUNS), drainMs };
}

/** What the CLI's stop waits on (stop-signals.ts StopDeps.stopping) with a runner beside the server: the server's runs
 *  and the runs the runner holds, and the longer of the server's bound and the runner's whole close (its drain, then
 *  the stop of the loops left: runnerCloseBoundMs), so the stop's deadline never cuts a run's end and release short. The
 *  runner's ChatGPT renewals drain beside that close, from its start (stopRenewals, RENEWAL_DRAIN_MS = 25 s), which the
 *  close's bound (the drain, then the lease less its margin: 25 s) already holds. */
export function besideStopping(server: { runs: number; boundMs: number }, held: number, drainMs: number): { runs: number; boundMs: number } {
  return { runs: server.runs + held, boundMs: Math.max(server.boundMs, runnerCloseBoundMs(drainMs)) };
}

/** A runner beside the server on the same data directory (the CLI start's server-and-runner, and the `runner` subcommand):
 *  its own store handle (role runner), and the runner's dispatch (dispatch.ts) for each claimed run — pi on the kernel's
 *  adapter loop, a learning run on the learning loop. `env`: the runs' environment (runEnv of this process's, unless a
 *  caller hands its own: the template eval's in-process server, its faux's). `loops` and `drainMs`: the runner's
 *  (RunnerOptions), the CLI start's from the server's flags (besideRunnerOptions). `janitor`: run the computer janitor
 *  too (workspace/computer-janitor.ts), as the CLI's start asks. `hub`: the server's AttachHub (Serve.attachHub), which
 *  holds each paired computer's socket in this process, so a run here takes one. `dial`: the server's (Serve.dial), which
 *  a remote provider's create takes, so a machine that dials the server lands in this process's hub. Returns the runner
 *  and a close() that stops both and closes its store. `loopsTold`: `loops` was given (besideRunnerOptions), so on uid
 *  isolation a number past the helper's slots is refused rather than cut. */
export async function runnerBeside(dataDir: string, { loops, loopsTold, drainMs, env, janitor, ownProcesses, hub, dial, mcpLoopback, mcpOwn, ollamaHost, evalFakes, harnessInstall, onLine, onRunEnded }: { loops?: number; loopsTold?: boolean; drainMs?: number; env?: NodeJS.ProcessEnv; ollamaHost?: string; janitor?: boolean; ownProcesses?: boolean; hub?: import("@parcha/agentrun-computer").AttachHub; dial?: import("@parcha/agentrun-computer").HostedDial; mcpLoopback?: boolean; mcpOwn?: readonly string[]; evalFakes?: (agentId: string) => import("./adapter-run-spec.js").EvalFakes | undefined; harnessInstall?: import("../harness-install.js").HarnessInstaller; onLine?: (line: string) => void; onRunEnded?: (status: string) => void } = {}): Promise<{ runner: Awaited<ReturnType<typeof import("./runner.js")["startRunner"]>>; close: () => Promise<void> }> {
  const { runnerName, startRunner } = await import("./runner.js");
  const { dispatchRunner } = await import("./harness-loops.js");
  const { routeOf } = await import("./model-route.js");
  const { openRunnerStore, runEnv, runnerComputers, troubleLine } = await import("./main.js");
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
  // (main.ts runnerComputers, a desktop's or a phone's live view with it), from that same environment; a Docker computer's
  // mounts by where this process's Docker has the data directory (box-paths.ts), read once.
  // `ollamaHost`: the Ollama the server beside it asks (Serve.ollamaHost), the default address on one owner's own machine
  // that names none, so its runs ask the same one; a runner in its own process asks the one its environment names alone.
  const runs = env ?? runEnv(process.env);
  if (ollamaHost && !runs.OLLAMA_HOST?.trim()) runs.OLLAMA_HOST = ollamaHost;
  const { dockerPathsForRuns } = await import("../box-paths.js");
  const { hostAddressesOnce } = await import("../docker-host-addresses.js");
  const { PROVIDERS } = await import("@parcha/agentrun-computer");
  const { hostCommandRefusals } = await import("../computers.js");
  const computers = runnerComputers(store, runs, seal.key, { dockerPaths: () => dockerPathsForRuns(runs, dataDir), hostAddresses: () => hostAddressesOnce(runs), hostWhy: hostCommandRefusals(PROVIDERS, process.env.PATH), ...(hub ? { hub } : {}), ...(dial ? { dial } : {}) });
  // `mcpLoopback`: the server beside it is a local install (Serve.localInstall), so its runs may reach an MCP server on
  // loopback; a runner in its own process does only as its own environment says (main.ts runnerLoopback). `mcpOwn`: that server's own addresses (Serve.own), whose ports a run's
  // loopback read never goes to. A run's log lines (a sweep that failed) go to
  // stderr with the runner's other lines. `evalFakes`: the template eval's fakes (EvalFakes: a case's web, now, monid and
  // email), by the agent each of its runs is of; only the eval, in its own process, hands them. `harnessInstall`: what a
  // claim's first-use install installs with (the eval's sharedInstaller, which the server beside it takes too).
  const { installForClaim } = await import("../harness-install.js");
  const deps = { env: runs, data: dataDir, journal: (claim: Parameters<typeof store.journal>[0]) => store.journal(claim), store, sealKey: seal.key, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps, ...(mcpLoopback ? { mcpLoopback: true } : {}), ...(mcpOwn ? { mcpOwn } : {}), ...(evalFakes ? { evalFakes } : {}), ...(harnessInstall ? { installForClaim: ((entry, dir, pins, given) => installForClaim(entry, dir, pins, { ...given, install: harnessInstall })) satisfies typeof installForClaim } : {}), log: (line: string) => console.error(`agentrun-serve runner: ${line}`) };
  // `ownProcesses`: each run a process of its own (run-child-host.ts), as a user of its own where the image's helper can
  // switch, as the CLI's start runs them; a helper that cannot is refused in words naming the setting. The template eval's
  // runner (its fakes are functions of this process) runs its runs in this one.
  let isolation: import("./run-child-host.js").RunIsolation | undefined;
  let held = loops;
  if (ownProcesses && !evalFakes && !harnessInstall) {
    const { isolationLoops, runIsolationOf } = await import("./run-child-host.js");
    try {
      isolation = await runIsolationOf(process.env, loopsTold ? loops : undefined, deps.log);
    } catch (error) {
      await store.close();
      seal.release();
      throw error;
    }
    if (loops !== undefined && isolation.kind === "uid" && loops > isolation.slots) deps.log(`each run runs as a user of its own, and the helper reaches ${isolation.slots} slots from slot ${isolation.first}: this runner holds at most ${isolation.slots} runs at once`);
    if (loops !== undefined) held = isolationLoops(isolation, loops);
    else if (isolation.kind === "uid") held = isolation.slots;
  }
  const { childLoops } = await import("./run-child-host.js");
  const createLoop = isolation ? childLoops({ deps, isolation, log: deps.log }) : dispatchRunner(deps);
  // It claims by the host's memory as well as by --max-runs (memory-claim.ts): a heavy harness's run waits queued for room,
  // each run's own process weighed with it.
  const { runnerMemory, RUN_PROCESS_MIB } = await import("./memory-claim.js");
  // Before it claims: the scratch folders of runs that ended after their runner died (scratch-sweep.ts).
  const { sweepEndedScratch } = await import("./scratch-sweep.js");
  await sweepEndedScratch(store, dataDir, { log: (line) => console.error(`agentrun-serve runner: ${line}`) });
  // Its run start and end lines go where the server's lines do (print.ts runLine), the one stdout; `onLine` is where a
  // launcher in this process (a test) reads them instead. A claim it lost and an error (a renew or a stop that failed)
  // are said in its name as the runner subcommand says them (main.ts troubleLine: a lost claim on stdout, an error on
  // stderr), so a lapse of its claims shows its cause.
  const { runLine } = await import("../print.js");
  const { metricLine, startRunnerGauge } = await import("./runner-metrics.js");
  const name = runnerName();
  const said = (event: RunnerEvent) => {
    for (const { line, error } of besideLines(name, event, { metricLine, troubleLine, runLine })) (onLine ?? (error ? console.error : console.log))(line);
    // The server's anonymous counts (telemetry.ts) hear a run's end: its state alone, never which run or agent.
    if (event.type === "ended") onRunEnded?.(event.status);
  };
  // A run's end lets go of what its earlier claims' computers left, with the same computers (run-end-computers.ts), as
  // the runner beside it (read at each end, once it has started): a computer kept pinned to another runner is that one's.
  const { runEndComputers } = await import("../workspace/run-end-computers.js");
  const { projectRunEnded } = await import("../source-sync/checkpoints.js");
  const self = () => (runner.incarnation ? { runner: name, incarnation: runner.incarnation } : undefined);
  const runEnded = projectRunEnded(store, runEndComputers({ store, computers: computers.computerDeps, log: (line) => console.error(`agentrun-serve runner: ${line}`), self }));
  const runner = startRunner({ store, name, createLoop, memory: runnerMemory(store, undefined, runs, isolation ? RUN_PROCESS_MIB : 0), onEvent: said, runEnded, ...(held !== undefined ? { loops: held } : {}), ...(drainMs !== undefined ? { drainMs } : {}) });
  // The computer janitor over the same computers, when the start asks for it: never under --faux. Its lines are the
  // runner's, on stderr (a stderr whose reader closed loses them, never the process: cli.ts).
  const { startJanitor } = await import("../workspace/computer-janitor.js");
  // As the runner beside it (its name and its presence's incarnation): a kept computer pinned to another runner still
  // there is that runner's to end (computer-kept.ts sweepKept).
  const swept = janitor ? startJanitor({ store, computers: computers.computerDeps, env: runs, log: (line) => console.error(`agentrun-serve runner: ${line}`), ...(runner.incarnation ? { self: { runner: name, incarnation: runner.incarnation } } : {}) }) : undefined;
  // Its close waits for any first-use install its claims let go of to stop (its npm ended) before it lets go of the data.
  const { claimInstallsStopped } = await import("../harness-install.js");
  // The janitor's sweep is cut and waited for on a bound of its own, beside the runner's close, never before it.
  // Its gauge (runner-metrics.ts): the runs it holds of its loops, and the process's memory (the server's with it), every
  // minute until its close.
  const gauge = startRunnerGauge({ runner: name, held: () => runner.held().length, slots: held ?? RUNNER_LOOPS, write: (line) => (onLine ?? console.log)(line) });
  // Its close stops the ChatGPT renewals its claims' readers make on its store as it begins, and drains the ones out
  // before the store closes: a refresh token OpenAI spent leaves its new pair saved (chatgpt-plan.ts stopRenewals).
  const { stopRenewals } = await import("../chatgpt-plan.js");
  return {
    runner,
    close: async () => {
      gauge.stop();
      const renewalsStopped = stopRenewals(store);
      await Promise.all([swept?.close(), runner.close()]);
      await claimInstallsStopped();
      await renewalsStopped;
      await store.close();
      seal.release();
    },
  };
}

/** The lines runner `name` beside a server says for `event`, in order, each with whether it goes to stderr (`error`): its
 *  metric line (runner-metrics.ts metricLine: a claim, a hand-back by cause, a lost claim, the drain), then its trouble
 *  (main.ts troubleLine: a lost claim, an error) or else its run's start or end (print.ts runLine). A lost claim says
 *  both its metric and its trouble. The three are handed in, as runnerBeside imports them on its start. */
export function besideLines(name: string, event: RunnerEvent, say: { metricLine: (name: string, event: RunnerEvent) => string | undefined; troubleLine: (name: string, event: RunnerEvent) => string | undefined; runLine: (event: RunnerEvent) => string | undefined }): { line: string; error: boolean }[] {
  const lines: { line: string; error: boolean }[] = [];
  const metric = say.metricLine(name, event);
  if (metric) lines.push({ line: metric, error: false });
  const trouble = say.troubleLine(name, event);
  if (trouble) lines.push({ line: trouble, error: event.type === "error" });
  else {
    const line = say.runLine(event);
    if (line) lines.push({ line, error: false });
  }
  return lines;
}

/** A server and one runner beside it, both in this process, as the CLI's start composes them (cli.ts): the runner holds
 *  what the server's options say (besideRunnerOptions) and sees the server's test switches (fauxEnvOf), so a --faux
 *  server's runs reach its fakes. For a launcher that starts serve in-process (a demo, a smoke): a server alone leaves
 *  every run queued. close() stops both. */
export async function serveWithRunner(options: import("../server.js").ServeOptions): Promise<{ serve: import("../server.js").Serve; close(): Promise<void> }> {
  const { fauxEnvOf, startServe } = await import("../server.js");
  const { besideRunEnv } = await import("./main.js");
  const { loops, loopsTold, drainMs } = besideRunnerOptions(options, process.env);
  const serve = await startServe(options);
  // Each run a process of its own, as a user of its own where the image's helper can switch, as the CLI's start runs
  // them (cli.ts): the isolation the server's capabilities say (runIsolationOf over the same helper) is the runner's.
  const beside = await runnerBeside(options.data, { loops, loopsTold, drainMs, env: besideRunEnv(process.env, fauxEnvOf(options)), ownProcesses: true, hub: serve.attachHub, dial: serve.dial, mcpLoopback: serve.localInstall, mcpOwn: serve.own, ollamaHost: serve.ollamaHost, ...(options.log ? { onLine: options.log } : {}) }).catch(async (error: unknown) => {
    await serve.close();
    throw error;
  });
  // Once: a second call (a SIGTERM and a SIGINT both) is the first one's promise, so the runner's store is never closed
  // under a run still finishing.
  let closing: Promise<void> | undefined;
  return { serve, close: () => (closing ??= Promise.all([beside.close(), serve.close()]).then(() => undefined)) };
}
