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
// A machine the run's park kept (computer-kept.ts) goes too when this end's provider lists it, whichever runner kept it:
// the run is final, so it has no user. Its row is marked ending first (endingKept), so no claim takes it back while the
// delete runs (a follow-up that queues the run again makes a new one). Once that machine is gone, its row is marked
// ended here (finishedKept), whatever came of the other machines' deletes: its own delete answered ok, or its vendor
// says it is gone already, or a later try's list no longer shows it. A row left ending refuses the run's next park until
// a janitor's pass, so a follow-up would keep nothing, and no retry here would find the machine to end it by. A row
// whose machine this list never showed (another runner's engine) stays ending for that runner's end. A
// row a later claim wrote or is taking back (a follow-up that queued the run again while this end
// waited on the store) is that claim's: the mark leaves it as it stands, and the delete leaves its machine. A row
// that reads ended once the deletes are done is removed (forgetEnded): the resume it was ended for came and went, so a
// follow-up that queues the run again reads no keep and never says that lapse again, with no janitor's pass to wait for.
//
// A later claim that took the run before this end got to it (a follow-up queued the stopped run again, claimed it and
// took the kept machine back, the row gone) holds a machine labelled at the epoch of the claim that made it, at or below
// the ending claim's: deleted here, it would go from under that claim's turn. So an end whose run a later claim has
// taken (its epoch moved past the end's own move, run-patch.ts) lets nothing go, and leaves the kept row as it reads:
// every machine left is that claim's to let go, at its own end or its launch (releaseOlderClaims). Read before the mark
// and again after it: a claim takes a row only after its claim, so one not yet there once the row reads ending, ended or
// gone can no longer take a machine of this end's.
// A machine kept on Archil has its park's mount credential removed before its row is marked ended
// (computer-janitor.ts keptMountRevoke, as the janitor's kept pass removes it): an ended row is one no janitor pass
// removes a credential for, so one marked ended first would leave it valid for its ttl with no machine. A remove that
// fails, or an end composed without the runs' environment, leaves the row ending, and the janitor's kept pass removes the
// credential and ends it.
import { type ComputerProvider, epochOf, ok, releaseOlder } from "@parcha/agentrun-computer";
import { KEY_TABLE, providerOptions } from "../computer-keys.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { settingOf } from "./computer-for-claim.js";
import type { ComputerDeps } from "./computer-deps.js";
import { keptMountRevoke } from "./computer-janitor.js";
import { endingKept, finishedKept, forgetEnded, type KeptMountRevoke } from "./computer-kept.js";
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

/** `provider` with the kept machine `id` out of its lists, where releaseOlder would delete it (labelled at or below the
 *  ending claim's `epoch`, or with no epoch it can read); labelled above, it stays listed and fences the call as before. */
function sparing(provider: ComputerProvider, id: string, epoch: number): ComputerProvider {
  return new Proxy(provider, {
    get(target, key) {
      if (key !== "list") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<ComputerProvider["list"]>) => {
        const listed = await target.list(...args);
        if (!listed.ok) return listed;
        return ok(listed.value.filter((info) => {
          if (info.ref.id !== id) return true;
          const read = epochOf(info.labels);
          return read.ok && read.value > epoch;
        }));
      };
    },
  });
}

/** `provider` that calls `gone` once the kept machine `id` is gone, whatever comes of the other deletes in the same
 *  release: its own delete answered ok, or not_found or gone (its vendor ended it already), or a list no longer shows it
 *  where an earlier one did (a delete that went through with its answer lost). `seen` carries what earlier lists showed
 *  across tries, each of which makes its provider anew. */
function finishing(provider: ComputerProvider, id: string, seen: { listed: boolean }, gone: () => Promise<void>): ComputerProvider {
  return new Proxy(provider, {
    get(target, key) {
      if (key === "list") {
        return async (...args: Parameters<ComputerProvider["list"]>) => {
          const listed = await target.list(...args);
          if (!listed.ok) return listed;
          if (listed.value.some((info) => info.ref.id === id)) seen.listed = true;
          else if (seen.listed) await gone();
          return listed;
        };
      }
      if (key === "release") {
        return async (...args: Parameters<ComputerProvider["release"]>) => {
          const released = await target.release(...args);
          const [ref, how] = args;
          if (ref.id === id && how === "delete" && (released.ok || released.error.code === "not_found" || released.error.code === "gone")) await gone();
          return released;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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

export interface RunEndComputersDeps {
  /** The run's row and launch (its revision and place) and the agent's revision, where its computer setting is; the
   *  computer ledger, for a provider that keeps one. */
  readonly store: Pick<Store, "agents" | "computerLedger" | "settings" | "sealedKeys"> & { readonly runs: Pick<Store["runs"], "get" | "launch">; readonly computerIntervals?: Store["computerIntervals"] };
  /** The runs' environment and the server's seal key, as the janitor is handed them: with them, a machine kept on Archil
   *  that this end deletes has its park's mount credential removed (computer-janitor.ts keptMountRevoke) before its row
   *  is marked ended. Absent `env`: that row is left ending, for the janitor's kept pass. */
  readonly env?: NodeJS.ProcessEnv;
  readonly sealKey?: Buffer | undefined;
  /** Archil's control plane for that remove: a test's fake. Absent: the region's own. */
  readonly mountControl?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
  /** The run's computers as the runner composed them (computer-deps.ts computerDepsFrom): the registry, the provider
   *  makers, the key reader, and --faux's launch with the providers it takes. */
  readonly computers: Pick<ComputerDeps, "kinds" | "providers" | "keyOf" | "keyTable" | "settings" | "launch" | "launches">;
  /** Where what was let go, and a provider that failed, are said. */
  readonly log: (line: string) => void;
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
  /** The remove of a kept row's Archil mount credential, its ttl judged on the store's clock. */
  const revokeMount = deps.env !== undefined ? keptMountRevoke({ settings: store.settings, sealedKeys: store.sealedKeys, env: deps.env, sealKey: deps.sealKey, ...(deps.mountControl ? { mountControl: deps.mountControl } : {}) }, () => store.sealedKeys.clock()) : undefined;
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
    return endingDeletes(await make(options.options, { ledger: storeLedger(store.computerLedger, entry.id) }), entry.id, writes);
  };
  /** Whether a later claim took run `runId` since the claim at `epoch` ended it: that end moved the run's epoch once past
   *  the claim's (run-patch.ts), and only a claim (or its release) moves it again. Said once in the log when so. A run
   *  gone or a read that fails says no: the deletes below are fenced by the end's epoch all the same. */
  const movedOn = async (runId: string, epoch: number): Promise<boolean> => {
    const run = await store.runs.get(runId).catch(() => undefined);
    if (!run || run.epoch <= epoch + 1) return false;
    log(`run ${runId}'s end at claim ${epoch} lets no computer go: a later claim took the run again and may hold one of them, so they are that claim's to let go`);
    return true;
  };
  return async ({ runId, epoch }) => {
    if (epoch <= 1) return;
    if (await movedOn(runId, epoch)) return;
    const bound = deps.timeoutMs ?? RUN_END_COMPUTERS_MS;
    const signal = AbortSignal.timeout(bound);
    let said = false;
    const failed = (why: string) => {
      if (said) return;
      said = true;
      log(`run ${runId} is over, but its computers could not be let go: ${why}`);
    };
    // Its kept row, where its park kept one, marked ending before any delete: no claim takes that machine back now. A
    // later claim's keep is left as it stands, its machine with it (endingKept). A mark the store fails is tried again;
    // a machine whose row no try marked is not deleted, since a claim could still take the row and attach it mid-delete:
    // it is left for its row's own time (its keeper's end, or a janitor's pass, which marks the row first). A row that
    // could not even be read names no machine, so none of the run's is deleted here, and the janitor's sweep ends them.
    const marked = await endingKept(store.settings, runId, epoch);
    if (marked.kind === "unmarked") {
      log(`run ${runId} is over, but its kept computer's row could not be marked ending (${marked.why}): ${marked.id === undefined ? "no computer of the run is let go here, and the computer janitor's next sweep ends them" : `${marked.id} is left for its row's time, which ends it`}`);
      if (marked.id === undefined) return;
    }
    if (await movedOn(runId, epoch)) return;
    /** The kept machine this end leaves: a later claim's, or one whose row no try marked. */
    const spared = marked.kind === "marked" ? undefined : marked.id;
    /** The kept row this end marked ending: ended as soon as its own machine is gone (finishing), so a follow-up's park
     *  writes its own keep, though another machine's delete failed and this end asks again or gives up. On Archil, its
     *  park's mount credential is removed first (finishedKept); one that fails leaves the row ending, said. */
    const kept = marked.kind === "marked" ? marked.kept : undefined;
    const seen = { listed: false };
    let finished = false;
    const revoked: KeptMountRevoke | undefined = revokeMount && (async (id, row) => {
      try {
        await revokeMount(id, row);
      } catch (error) {
        log(`run ${runId} is over and its kept ${row.kind} ${row.id} is gone, but its mount credential could not be removed (${error instanceof Error ? error.message : String(error)}): its row is left ending, and the computer janitor's next pass removes it`);
        throw error;
      }
    });
    const gone = async () => {
      if (finished || !kept) return;
      finished = true;
      await finishedKept(store.settings, runId, kept, revoked);
    };
    /** The last try's failure, for the line said at the bound. */
    let why = `its provider did not answer within ${bound / 1000} s`;
    const tries = async () => {
      for (;;) {
        try {
          const found = await providerOf(runId, epoch);
          if (!found) return;
          const provider = spared !== undefined ? sparing(found, spared, epoch) : kept ? finishing(found, kept.id, seen, gone) : found;
          // Every claim's at or below this one's: a computer of a later epoch fences the call (a later claim holds the run).
          const released = await releaseOlder(provider, runId, epoch + 1, { signal });
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
    // Its row, where it reads ended now (this end finished it, or it was ended before): the run's no more.
    await forgetEnded(store.settings, runId, epoch);
  };
}
