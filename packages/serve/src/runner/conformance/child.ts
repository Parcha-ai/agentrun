// The conformance suite's runner process (harness.ts, the process cases): a runner of its own on the suite's data
// directory, running the subject's loop for one call, that SIGKILLs itself at the kernel point it is given, so only what
// it had committed survives. Its argument: { dataDir, module, export, tool, point, countFile, eventsFile, stopOnce } as JSON;
// on its stdin, { storeUrl } as JSON (a Postgres store's URL may hold a password, so never on argv). Its
// runner's events (claims, releases, lost claims, errors, each with its time) are appended to eventsFile as JSON lines,
// written synchronously so the kill loses none, for the case to show beside the second runner's.
import { appendFileSync } from "node:fs";
import { openStore } from "../../store/index.js";
import type { LoopFactory } from "../loop-contract.js";
import { startRunner } from "../runner.js";
import { CONFORMANCE_PROCESS_TIMING, storeClockOf, suiteTools } from "./harness.js";
import type { ConformanceSubject, KernelHooks, ToolName } from "./subject.js";

// `clockFile`: the case's store clock skew (harness.ts runOut), so this process's store reads the same now as the case's:
// its claim runs out when the case moves the clock past its until, never by waiting for a real lease.
const config = JSON.parse(process.argv[2] ?? "{}") as { dataDir: string; storeEnv?: Record<string, string>; module: string; export: string; tool: ToolName; point: keyof KernelHooks; countFile: string; eventsFile?: string; stopOnce?: boolean; clockFile?: string };
/** The store's URL, read whole from stdin (the harness writes it there and closes it): never on argv or in the environment. */
const input: Buffer[] = [];
for await (const chunk of process.stdin) input.push(chunk as Buffer);
const { storeUrl } = JSON.parse(Buffer.concat(input).toString("utf8") || "{}") as { storeUrl?: string };
const subject = (await import(config.module))[config.export] as ConformanceSubject;
const { tools } = suiteTools(config.countFile);
const said = (event: object) => {
  if (config.eventsFile) appendFileSync(config.eventsFile, `${JSON.stringify({ runner: "runner-process", at: Date.now(), ...event })}\n`);
};
const die = async () => {
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
};
// `stopOnce`: the first time the point is reached the process stops itself (SIGSTOP) instead, until the case sends SIGCONT
// once its lease has run out; it then goes on from there, as a process the box paused does. The next time, it dies.
let stopped = false;
const at = async (point: keyof KernelHooks) => {
  if (config.point !== point) return;
  if (config.stopOnce && !stopped) {
    stopped = true;
    said({ type: "stopping", point });
    // For the suite's own test: a pause between saying it stops and stopping, the whole process held (as a loaded box can
    // hold it), so the case must wait until the process is stopped before it lets it go on (harness.ts processStopped),
    // never take the word for it.
    const gap = Number(process.env.AGENTRUN_TEST_STOP_GAP_MS ?? 0);
    for (const until = Date.now() + gap; Date.now() < until; );
    process.kill(process.pid, "SIGSTOP");
    said({ type: "continued", point });
    return;
  }
  await die();
};
const hooks: KernelHooks = { beforeIntent: () => at("beforeIntent"), beforeResult: () => at("beforeResult") };
// The store the harness's world opened (its data directory, or its own Postgres schema).
const store = await openStore({ dataDir: config.dataDir, role: "runner", url: storeUrl ?? "", env: { ...process.env, ...config.storeEnv }, now: storeClockOf(config.clockFile) });
// Each journal commit's outcome, by the claim's epoch: one that lands, or one refused and by what (the runner's ClaimLost,
// or the store's Fenced), so the case can say what a loop that lost its claim tried to write.
const createLoop = subject.createLoop({ script: [{ call: config.tool }, { say: "done" }], tools, hooks });
const observedLoop: LoopFactory = (deps) =>
  createLoop({
    ...deps,
    journal: (claim) =>
      new Proxy(deps.journal(claim), {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          if (property !== "commit") return value.bind(target);
          return async (...args: unknown[]) => {
            try {
              const result = await value.apply(target, args);
              said({ type: "commit-landed", epoch: claim.epoch });
              return result;
            } catch (error) {
              said({ type: "commit-refused", epoch: claim.epoch, name: (error as Error)?.name });
              throw error;
            }
          };
        },
      }),
  });
startRunner({ store, createLoop: observedLoop, name: "runner-process", ...CONFORMANCE_PROCESS_TIMING, onEvent: said });
