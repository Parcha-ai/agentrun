// Each computer a run made, from its create to its proven delete (store `computer_intervals`): so whoever runs the server
// can see how long each of a run's computers lived, find one left running after its run, and match the provider's
// invoice by the provider's own id. Written where the runner already acts: the claim's create (computer-for-claim.ts
// providerLaunch, and a lost sandbox's new one), the run's park (kept), and every delete whose provider answered ok (the
// claim's release, an older claim's computers let go, the run's end, a kept computer's end, the janitor's sweeps). A
// delete that failed, or whose answer is unknown, writes nothing: the row stays open, never a guessed end.
//
// What the computer was made with is what its create asked (spec.gpu, spec.cpus, spec.memoryMb), null where it asked none:
// a hosted vendor that sizes its own machines is never given numbers here. Only a computer the run made itself has a row:
// never the agent's own (it outlives every run), a paired computer or --faux's.
//
// A write never fails or holds up the run: each is caught and said on the log, and the claim goes on.
import type { ComputerProvider, ComputerSpec } from "@parcha/agentrun-computer";
import type { ComputerIntervals } from "../store/index.js";

/** The store as these writes need it: its intervals, where it keeps them (a test's store or an older caller's may not). */
export type IntervalsStore = { readonly computerIntervals?: ComputerIntervals };

/** The writes of one process, each safe: a failure is said on `log` and never thrown. */
export interface IntervalWrites {
  /** Run `runId`'s computer `providerId` on `provider` was made with `spec`, of `kind`. */
  opened(provider: string, providerId: string, runId: string, kind: string | null, spec: Pick<ComputerSpec, "gpu" | "cpus" | "memoryMb">): Promise<void>;
  /** The run's park kept it past its claim. */
  kept(provider: string, providerId: string): Promise<void>;
  /** Its provider's delete answered ok, now. */
  ended(provider: string, providerId: string): Promise<void>;
}

/** The default log: the runner's stderr, as its other lines. */
const stderrLog = (line: string): void => void process.stderr.write(`agentrun-serve runner: ${line}\n`);

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The interval writes over `store` (none written where it keeps none), on the clock `now`, failures said on `log`. */
export function intervalWrites(store: IntervalsStore | undefined, log: (line: string) => void = stderrLog, now: () => number = Date.now): IntervalWrites {
  const intervals = store?.computerIntervals;
  const safely = async (what: string, write: (intervals: ComputerIntervals) => Promise<void>): Promise<void> => {
    if (!intervals) return;
    try {
      await write(intervals);
    } catch (error) {
      log(`the computer interval of ${what} was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    opened: (provider, providerId, runId, kind, spec) =>
      safely(`${provider} ${providerId} (run ${runId})`, (to) =>
        to.opened({
          runId, provider, providerId, kind,
          gpuType: typeof spec.gpu?.type === "string" ? spec.gpu.type : null,
          gpuCount: spec.gpu ? count(spec.gpu.count) : null,
          cpus: count(spec.cpus),
          memoryMb: count(spec.memoryMb),
          startedAt: now(),
        })),
    kept: (provider, providerId) => safely(`${provider} ${providerId}`, (to) => to.kept(provider, providerId)),
    ended: (provider, providerId) => safely(`${provider} ${providerId}`, (to) => to.ended(provider, providerId, now())),
  };
}

/** `provider` with each delete that answers ok ended in `writes` under `id` (the provider's registry id): the janitor's
 *  sweeps and a run's end let computers go through it. A detach, or a delete that fails, writes nothing. */
export function endingDeletes(provider: ComputerProvider, id: string, writes: IntervalWrites): ComputerProvider {
  return new Proxy(provider, {
    // Every other member is the provider's own, called on the provider itself (its private fields are its own).
    get(target, key) {
      if (key !== "release") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<ComputerProvider["release"]>) => {
        const released = await target.release(...args);
        const [ref, how] = args;
        if (released.ok && how === "delete") await writes.ended(id, ref.id);
        return released;
      };
    },
  });
}
