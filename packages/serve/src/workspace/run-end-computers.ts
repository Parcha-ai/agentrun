// A run's computers at its end: once the run is over, whatever ended it, no computer any of its claims made is left
// running. A claim lets go of its own computer at its end, and of every earlier claim's before it makes its own
// (computer-for-claim.ts releaseOlderClaims). A later claim that ends before that point (its computer refused or its
// image failed, a person's stop or cancel, a claim refused before the computer, a claim lost again) never gets there, so a
// lost runner's computer ran on to its deadline: a day on Docker, the vendor's own lifetime elsewhere, billed all along.
// The runner calls this once a run it ended is final (runner.ts announceEnd), before it says the run ended: the run's
// provider, by the agent's computer setting read as the claim reads it (settingOf), lists the run's computers by its
// label, and each one at or below the ending claim's epoch is deleted (the computer package's releaseOlder).
//
// Never let go here: the agent's own computer (a persistent setting: it outlives its runs), a paired computer (a person's
// own, never made or deleted: its id is no provider of the registry), and --faux's computers (the server's own launch
// makes them, with no provider to list). A run whose last claim was its first (epoch 1) has no earlier claim's computer to
// find: its provider is not asked. A vendor or a daemon that does not answer (often the very Docker that failed the later
// claim, still hung) is asked again every RUN_END_RETRY_MS until RUN_END_COMPUTERS_MS; a provider that can't be had here
// at all (its key is not in this runner's environment or the store) is not. Either is said in the runner's log, and the
// run's end stands. The janitor (computer-janitor.ts) ends a computer of a run that is over on its next sweep too, for a
// server that stopped before this ran, or a vendor that stayed down past the bound.
//
// Nor a computer the run's park kept pinned to a runner other than this one while that keep lasts (computer-kept.ts: its
// row names that runner, and is neither ending nor ended): a stop or cancel ends the run on whichever runner claims it,
// and the machine is the keeping runner's to end, at its time or its janitor's pass. A vendor's list (a dial machine's)
// shows it here too; it is left out of the list, so nothing under its id is deleted from here.
import { type ComputerProvider, releaseOlder } from "@parcha/agentrun-computer";
import { KEY_TABLE, providerOptions } from "../computer-keys.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { settingOf } from "./computer-for-claim.js";
import type { ComputerDeps } from "./computer-deps.js";
import { keptBy, type KeptHolder, readKept } from "./computer-kept.js";
import { storeLedger } from "./computer-ledger.js";
import { type ComputerSetting, providerKeys } from "./resolve-computer.js";
import { endingDeletes, intervalWrites } from "./computer-intervals.js";

/** The longest a run's end may spend on its computers, every try with its pauses: past it the provider's calls are cut
 *  (one that takes no signal, a release, left to finish on its own) and the run's end goes on, said in the log. */
export const RUN_END_COMPUTERS_MS = 120_000;
/** The pause before a run's end asks a provider that did not answer again. */
export const RUN_END_RETRY_MS = 5_000;

/** Why a run's end can't have its provider here, which no later try changes: its keys or options. */
class NoProviderHere extends Error {}

/** A releaseOlder answer no later try changes: fenced by a later claim's computer (refused), asked wrongly, or cut. */
const FINAL_CODES: ReadonlySet<string> = new Set(["refused", "invalid", "aborted"]);

/** Waits `ms`, or less when `signal` aborts first: whether the wait ran its course. */
const pause = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** `provider` with the computer `id` left out of its lists: releaseOlder never sees it, so never deletes it. */
const sparing = (provider: ComputerProvider, id: string): ComputerProvider =>
  new Proxy(provider, {
    get(target, key) {
      if (key !== "list") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<ComputerProvider["list"]>) => {
        const listed = await target.list(...args);
        return listed.ok ? { ...listed, value: listed.value.filter((info) => info.ref.id !== id) } : listed;
      };
    },
  });

export interface RunEndComputersDeps {
  /** The run's row and launch (its revision and place) and the agent's revision, where its computer setting is; the
   *  computer ledger, for a provider that keeps one. */
  readonly store: Pick<Store, "agents" | "computerLedger" | "settings"> & { readonly runs: Pick<Store["runs"], "get" | "launch">; readonly computerIntervals?: Store["computerIntervals"] };
  /** The run's computers as the runner composed them (computer-deps.ts computerDepsFrom): the registry, the provider
   *  makers, the key reader, and --faux's launch with the providers it takes. */
  readonly computers: Pick<ComputerDeps, "kinds" | "providers" | "keyOf" | "keyTable" | "settings" | "launch" | "launches">;
  /** Where what was let go, and a provider that failed, are said. */
  readonly log: (line: string) => void;
  /** The runner this end runs in (its name and presence incarnation), read at each end: a computer kept pinned to it is
   *  its own to let go here. Absent: every kept row that names a runner is another's. */
  readonly self?: () => KeptHolder | undefined;
  /** The bound on every try. Default RUN_END_COMPUTERS_MS. */
  readonly timeoutMs?: number;
  /** The pause between tries. Default RUN_END_RETRY_MS. */
  readonly retryMs?: number;
}

/** The run's end for its computers (RunEndComputersDeps): given the claim that ended the run, every computer of the run
 *  at or below its epoch deleted, a provider that did not answer asked again until the bound. Never throws: a failure
 *  is said in the log. */
export function runEndComputers(deps: RunEndComputersDeps): (claim: { readonly runId: string; readonly epoch: number }) => Promise<void> {
  const { store, computers, log } = deps;
  /** Each computer let go here ends its interval (computer-intervals.ts), on its provider's ok alone. */
  const writes = intervalWrites(store, log);
  /** The provider the run's computers are on, by the agent's setting; undefined where none of them is this end's to let
   *  go (none, the agent's own, a paired computer, --faux's). */
  const providerOf = async (runId: string, epoch: number) => {
    const run = await store.runs.get(runId);
    if (!run) return undefined;
    const launch = readLaunchBody((await store.runs.launch(runId)).body);
    const computer = (launch as { computer?: ComputerSetting } | undefined)?.computer;
    const setting = await settingOf({ runId, epoch, revisionId: run.revisionId, ...(computer ? { computer } : {}), ...(launch?.place ? { place: launch.place } : {}) }, store);
    if (!setting || setting.kind === "none" || setting.persistent === true || !setting.provider) return undefined;
    const entry = computers.kinds.PROVIDERS.find((one) => one.id === setting.provider);
    if (!entry) return undefined;
    if (computers.launch && (computers.launches?.(entry.id) ?? true)) return undefined;
    const make = Object.hasOwn(computers.providers, entry.id) ? computers.providers[entry.id] : undefined;
    if (!make) return undefined;
    const keys = await providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined))(entry.id);
    const options = providerOptions(entry.id, keys, computers.settings ?? {}, computers.keyTable ?? KEY_TABLE);
    if (!options.ok) throw new NoProviderHere(options.error.message);
    // A throw from here on is the vendor's or the daemon's (Docker's architecture asked): asked again.
    return { entry: entry.id, provider: endingDeletes(await make(options.options, { ledger: storeLedger(store.computerLedger, entry.id) }), entry.id, writes) };
  };
  /** The run's computer its park kept pinned to a runner other than this one, while the keep lasts: its provider's id
   *  and its own. A read that fails throws, and is asked again (a delete from here must not guess). */
  const keptElsewhere = async (runId: string): Promise<{ readonly provider: string; readonly id: string } | undefined> => {
    const kept = await readKept(store.settings, runId);
    return kept && kept.runner !== undefined && !kept.ending && !kept.ended && !keptBy(kept, deps.self?.()) ? { provider: kept.provider, id: kept.id } : undefined;
  };
  return async ({ runId, epoch }) => {
    if (epoch <= 1) return;
    const bound = deps.timeoutMs ?? RUN_END_COMPUTERS_MS;
    const signal = AbortSignal.timeout(bound);
    let said = false;
    const failed = (why: string) => {
      if (said) return;
      said = true;
      log(`run ${runId} is over, but its computers could not be let go: ${why}`);
    };
    /** The last try's failure, for the line said at the bound. */
    let why = `its provider did not answer within ${bound / 1000} s`;
    const tries = async () => {
      for (;;) {
        try {
          const made = await providerOf(runId, epoch);
          if (!made) return;
          const { provider } = made;
          // Spared only on the kept row's own provider: an id is a provider's, so another's machine of the same id is not it.
          const kept = await keptElsewhere(runId);
          const spared = kept?.provider === made.entry ? kept.id : undefined;
          // Every claim's at or below this one's: a computer of a later epoch fences the call (a later claim holds the run).
          const released = await releaseOlder(spared === undefined ? provider : sparing(provider, spared), runId, epoch + 1, { signal });
          if (released.ok) {
            const names = released.value.released.map((ref) => ref.name);
            if (names.length > 0) log(`run ${runId} is over: let go of ${names.length === 1 ? "the computer" : "the computers"} an earlier claim left on ${provider.id}, ${names.join(", ")}`);
            return;
          }
          why = `on ${provider.id}, ${released.error.message}`;
          if (FINAL_CODES.has(released.error.code)) return failed(why);
        } catch (error) {
          why = error instanceof Error ? error.message : String(error);
          if (error instanceof NoProviderHere) return failed(why);
        }
        if (!(await pause(deps.retryMs ?? RUN_END_RETRY_MS, signal))) return failed(`${why} (asked until its bound)`);
      }
    };
    // A release takes no signal, and a Docker delete has no timeout of its own: at the bound the run's end is answered
    // whatever the provider is doing (its call is left to finish on its own), so a hung delete never holds the runner.
    let stop = () => {};
    const cut = new Promise<void>((resolve) => {
      stop = () => {
        failed(`${why} (asked until its bound)`);
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      await Promise.race([tries(), cut]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}
