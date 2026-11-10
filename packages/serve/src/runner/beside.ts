// A runner beside a server on the same data directory: the CLI start's server-and-runner, the `runner` subcommand and
// the template eval's in-process server (template-eval.ts), which would otherwise leave every run it starts queued.

/** A runner beside the server on the same data directory (the CLI start's server-and-runner, and the `runner` subcommand):
 *  its own store handle (role runner), and the runner's dispatch (dispatch.ts) for each claimed run — pi on the kernel's
 *  adapter loop, a learning run on the learning loop. `env`: the runs' environment (runEnv of this process's, unless a
 *  caller hands its own: the template eval's in-process server, its faux's). Returns the runner and a close() that
 *  stops it and closes its store. */
export async function runnerBeside(dataDir: string, { loops, env }: { loops?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ runner: Awaited<ReturnType<typeof import("./runner.js")["startRunner"]>>; close: () => Promise<void> }> {
  const { startRunner } = await import("./runner.js");
  const { dispatchRunner } = await import("./harness-loops.js");
  const { routeOf } = await import("./model-route.js");
  const { openRunnerStore, runEnv, runnerComputers } = await import("./main.js");
  // The server's store, the runner's one way in (main.ts openRunnerStore, store/open.ts): Postgres when this process's
  // AGENTRUN_STORE_URL secret names one, else SQLite in the data directory; a schema it does not know is RunnerRefused.
  const { store } = await openRunnerStore(dataDir, process.env, (message) => void process.stderr.write(`agentrun-serve runner: ${message}\n`), undefined);
  // The server's seal key (seal-key.ts): the one handed over (read through secrets.js, which moves it out of the
  // environment as it loads), else the one the server keeps under the config home. A runner never starts without it: it
  // seals the live-viewer tokens, and there is no stand-in key.
  const { bootSealKey } = await import("../seal-key.js");
  const sealKey = bootSealKey().key;
  // The beside-runner sees the server's environment as a separate runner would (runEnv, not withoutFaux): so an API run on
  // a --faux server reaches the faux gateway and its computers. The run's claim-time computer is composed once, the one way
  // (main.ts runnerComputers, a desktop's or a phone's live view with it), from that same environment.
  const runs = env ?? runEnv(process.env);
  const computers = runnerComputers(store, runs, sealKey);
  const createLoop = dispatchRunner({ env: runs, data: dataDir, journal: (claim) => store.journal(claim), store, sealKey, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps });
  const runner = startRunner({ store, createLoop, ...(loops !== undefined ? { loops } : {}) });
  return { runner, close: async () => { await runner.close(); await store.close(); } };
}
