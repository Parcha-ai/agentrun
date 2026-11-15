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
// find: its provider is not asked. A provider that can't be made here (its key is not in this runner's environment or the
// store) or that fails is said in the runner's log; the run's end stands. The janitor (computer-janitor.ts) ends a
// computer of a run that is over on its next sweep too, for a server that stopped before this ran.
import { releaseOlder } from "@parcha/agentrun-computer";
import { KEY_TABLE, providerOptions } from "../computer-keys.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { settingOf } from "./computer-for-claim.js";
import type { ComputerDeps } from "./computer-deps.js";
import { storeLedger } from "./computer-ledger.js";
import { type ComputerSetting, providerKeys } from "./resolve-computer.js";

/** The longest the provider's listing and its deletes may take at a run's end: past it they are cut, said in the log. */
export const RUN_END_COMPUTERS_MS = 60_000;

export interface RunEndComputersDeps {
  /** The run's row and launch (its revision and place) and the agent's revision, where its computer setting is; the
   *  computer ledger, for a provider that keeps one. */
  readonly store: Pick<Store, "agents" | "computerLedger"> & { readonly runs: Pick<Store["runs"], "get" | "launch"> };
  /** The run's computers as the runner composed them (computer-deps.ts computerDepsFrom): the registry, the provider
   *  makers, the key reader, and --faux's launch with the providers it takes. */
  readonly computers: Pick<ComputerDeps, "kinds" | "providers" | "keyOf" | "keyTable" | "settings" | "launch" | "launches">;
  /** Where what was let go, and a provider that failed, are said. */
  readonly log: (line: string) => void;
  /** The bound on the provider's calls. Default RUN_END_COMPUTERS_MS. */
  readonly timeoutMs?: number;
}

/** The run's end for its computers (RunEndComputersDeps): given the claim that ended the run, every computer of the run
 *  at or below its epoch deleted. Never throws: a failure is said in the log. */
export function runEndComputers(deps: RunEndComputersDeps): (claim: { readonly runId: string; readonly epoch: number }) => Promise<void> {
  const { store, computers, log } = deps;
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
    if (!options.ok) throw new Error(options.error.message);
    return make(options.options, { ledger: storeLedger(store.computerLedger, entry.id) });
  };
  return async ({ runId, epoch }) => {
    if (epoch <= 1) return;
    try {
      const provider = await providerOf(runId, epoch);
      if (!provider) return;
      // Every claim's at or below this one's: a computer of a later epoch fences the call (a later claim holds the run).
      const released = await releaseOlder(provider, runId, epoch + 1, { signal: AbortSignal.timeout(deps.timeoutMs ?? RUN_END_COMPUTERS_MS) });
      if (!released.ok) return log(`run ${runId} is over, but its computers on ${provider.id} could not be let go: ${released.error.message}`);
      const names = released.value.released.map((ref) => ref.name);
      if (names.length > 0) log(`run ${runId} is over: let go of ${names.length === 1 ? "the computer" : "the computers"} an earlier claim left on ${provider.id}, ${names.join(", ")}`);
    } catch (error) {
      log(`run ${runId} is over, but its computers could not be let go: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
