// The computer janitor of this server: at the runner's start, then every JANITOR_EVERY_MS, each computer this server made
// that is past its deadline is ended. A run's release ends its computer; the janitor is for the ones a crashed runner
// left, on a provider whose vendor never ends them itself (capabilities().lifetime "janitor": Docker, Orgo).
//
// Which computers it may end:
// - a provider's whose keys this server has (saved, or in its environment); Docker takes none, so it is always asked;
// - one whose agentrun.run label names a run in this server's store (or, where the provider keeps only the run's hash,
//   agentrun.run.hash is the hash of one): a vendor account or a Docker host shared with another server lists that
//   server's computers too, and they are never touched;
// - never one a claim holds, at the computer's own epoch: whether a claim holds the run now is the store's to say
//   (runs.heldAt), by its own clock, never this process's. A claim that ran out holds nothing, so a run a crashed runner
//   left parked under its name still has its computer swept at the deadline;
// - past its deadline, by the computer package's sweep (janitor.ts): the deadline label, or over the provider's cap.
// What a computer leaves outside itself (Docker's egress parts) goes with its release; the provider's sweepLeftovers is
// not asked, since it reads labels alone and can't tell this server's parts from another's.
//
// A provider whose sweep fails is logged, once per distinct failure, and the others are swept. It runs only where its
// start asks for it (the CLI's runner and the runner subcommand), never under --faux, and never two sweeps at once. Its
// close cuts a sweep under way and waits for it on a bound of its own (JANITOR_CLOSE_MS), so a stuck vendor call never
// holds up the runner's stop.
import { type ComputerInfo, type ComputerProvider, epochOf, ok, RUN_HASH_LABEL, RUN_LABEL, type Result, runHash, sweep, type Swept } from "@parcha/agentrun-computer";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { FAUX_ENV } from "../model.js";
import type { Store } from "../store/index.js";
import type { ComputerDeps } from "./computer-deps.js";
import { storeLedger } from "./computer-ledger.js";
import { providerKeys } from "./resolve-computer.js";

/** How often the janitor sweeps after its first sweep at the runner's start. */
export const JANITOR_EVERY_MS = 10 * 60_000;
/** The longest close() waits for a sweep it cut: a vendor call that ignores the cut is left to finish on its own. */
export const JANITOR_CLOSE_MS = 5_000;
/** The longest one provider's sweep may take: past it the sweep is cut and left, said as a timeout, and the next provider
 *  is swept, so a stuck vendor (a Docker command has no timeout of its own) never stops the others or later sweeps. */
export const JANITOR_PROVIDER_MS = 5 * 60_000;

export interface JanitorDeps {
  /** The store: whose runs a computer's run label names, and the phone provider's ledger. */
  readonly store: Pick<Store, "runs" | "computerLedger">;
  /** The run's computers as the runner composed them (computer-deps.ts computerDepsFrom): the registry, the provider
   *  makers and the key reader. */
  readonly computers: Pick<ComputerDeps, "kinds" | "providers" | "keyOf"> & { readonly settings?: ProviderSettings; readonly keyTable?: KeyTable };
  /** The runs' environment: under --faux (AGENTRUN_SERVE_FAUX) the janitor never starts. */
  readonly env: NodeJS.ProcessEnv;
  /** Where a sweep's outcome and a provider's failure are said. */
  readonly log: (line: string) => void;
  readonly everyMs?: number;
  /** The longest close() waits for a sweep it cut. Default JANITOR_CLOSE_MS. */
  readonly closeMs?: number;
  /** The longest one provider's sweep may take. Default JANITOR_PROVIDER_MS. */
  readonly providerMs?: number;
  /** The clock a computer's deadline is read by. Default Date.now. */
  readonly now?: () => number;
}

/** One provider's sweep: what it ended, or why it could not sweep, in words. */
export type ProviderSweep = { readonly provider: string; readonly swept: Result<Swept> };

/** This store's runs by their hash (runHash), read once per sweep and only when a provider lists a hash. */
type RunsByHash = () => Promise<ReadonlyMap<string, string>>;
const runsByHash = (store: JanitorDeps["store"]): RunsByHash => {
  let read: Promise<ReadonlyMap<string, string>> | undefined;
  return () => (read ??= store.runs.list({}).then((rows) => new Map(rows.map((row) => [runHash(row.id), row.id]))));
};

/** Whether a listed computer is this server's and no claim holds it: its run (by its label, or its hash's) is in this
 *  store, and no claim holds the run now (by the store's clock), or one holds it at a later epoch than the computer's. */
async function sweepable(store: JanitorDeps["store"], labels: Readonly<Record<string, string>>, byHash: RunsByHash): Promise<boolean> {
  const named = labels[RUN_LABEL];
  const hash = labels[RUN_HASH_LABEL];
  const runId = typeof named === "string" && named !== "" ? named : typeof hash === "string" && hash !== "" ? (await byHash()).get(hash) : undefined;
  if (runId === undefined) return false;
  const run = await store.runs.get(runId);
  // No such run here: another server's computer.
  if (!run) return false;
  const held = await store.runs.heldAt(run.id);
  if (held === undefined) return true;
  // A claim holds its own epoch's computer; one of an older epoch is a lost claim's (releaseOlder's too).
  const epoch = epochOf(labels);
  return epoch.ok && epoch.value < held;
}

/** `provider` as the sweep sees it: its list cut to this server's computers that no claim holds, and no leftovers pass.
 *  Each call goes to the provider itself, so its own state is used as it is. */
function thisServers(provider: ComputerProvider, store: JanitorDeps["store"], byHash: RunsByHash): ComputerProvider {
  return {
    id: provider.id,
    version: provider.version,
    capabilities: () => provider.capabilities(),
    check: (spec) => provider.check(spec),
    create: (spec, context) => provider.create(spec, context),
    attach: (target, context) => provider.attach(target, context),
    network: (ref, policy, context) => provider.network(ref, policy, context),
    connect: (ref) => provider.connect(ref),
    release: (ref, how) => provider.release(ref, how),
    async list(labels, context) {
      const listed = await provider.list(labels, context);
      if (!listed.ok) return listed;
      const kept: ComputerInfo[] = [];
      for (const info of listed.value) if (await sweepable(store, info.labels, byHash)) kept.push(info);
      return ok(kept);
    },
  };
}

/** `work` given a signal cut at `ms` (or with `signal`), answered at the cut whether or not `work` heeds it: a call that
 *  ignores it is left to finish on its own, and the answer is a timeout (or aborted) in words. */
async function bounded(ms: number, signal: AbortSignal | undefined, work: (cut: AbortSignal) => Promise<Result<Swept>>): Promise<Result<Swept>> {
  const timer = AbortSignal.timeout(ms);
  const cut = signal ? AbortSignal.any([signal, timer]) : timer;
  let stop: () => void = () => {};
  const given = new Promise<Result<Swept>>((resolve) => {
    stop = () => resolve(timer.aborted ? { ok: false, error: { code: "timeout", message: `its sweep took longer than ${ms / 1000} s and was left` } } : { ok: false, error: { code: "aborted", message: "the sweep was cut" } });
    cut.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work(cut), given]);
  } finally {
    cut.removeEventListener("abort", stop);
  }
}

/** One sweep of every provider this server can list: each provider whose keys it has and whose computers the janitor
 *  ends, its computers past their deadline that are this server's and unheld ended. A provider that fails is answered
 *  in its words; nothing throws. */
export async function sweepServerComputers(deps: Pick<JanitorDeps, "store" | "computers" | "now" | "providerMs">, signal?: AbortSignal): Promise<ProviderSweep[]> {
  const { store, computers } = deps;
  const at = (deps.now ?? Date.now)();
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const byHash = runsByHash(store);
  const out: ProviderSweep[] = [];
  for (const entry of computers.kinds.PROVIDERS) {
    if (signal?.aborted) break;
    const make = Object.hasOwn(computers.providers, entry.id) ? computers.providers[entry.id] : undefined;
    if (!make) continue;
    try {
      // Its keys not here: nothing of this server's can be listed there. A key that can't be read is this provider's
      // failure alone.
      const options = providerOptions(entry.id, await keysOf(entry.id), computers.settings ?? {}, computers.keyTable ?? KEY_TABLE);
      if (!options.ok) continue;
      const provider = await make(options.options, { ledger: storeLedger(store.computerLedger, entry.id) });
      // A vendor that ends its own computers needs no janitor.
      if (provider.capabilities().lifetime !== "janitor") continue;
      out.push({ provider: entry.id, swept: await bounded(deps.providerMs ?? JANITOR_PROVIDER_MS, signal, (cut) => sweep(thisServers(provider, store, byHash), { now: new Date(at), signal: cut })) });
    } catch (error) {
      out.push({ provider: entry.id, swept: { ok: false, error: { code: "refused", message: error instanceof Error ? error.message : String(error) } } });
    }
  }
  return out;
}

/** The janitor: one sweep now, then one every `everyMs`, never two at once. `close()` stops it, cuts a sweep under way
 *  and waits for it at most `closeMs`. Under --faux it does nothing. */
export function startJanitor(deps: JanitorDeps): { readonly first: Promise<void>; close(): Promise<void> } {
  if (deps.env[FAUX_ENV]) return { first: Promise.resolve(), close: async () => {} };
  /** The last failure said per provider: a failure is said once, until it changes or the provider sweeps again. */
  const said = new Map<string, string>();
  const cut = new AbortController();
  let running: Promise<void> | undefined;
  const once = (): Promise<void> =>
    (running ??= (async () => {
      try {
        for (const { provider, swept } of await sweepServerComputers(deps, cut.signal)) {
          // A sweep the close cut says nothing more.
          if (cut.signal.aborted) break;
          if (!swept.ok) {
            const words = `${swept.error.code}: ${swept.error.message}`;
            if (said.get(provider) !== words) deps.log(`the computer janitor could not sweep ${provider}'s computers: ${swept.error.message}`);
            said.set(provider, words);
            continue;
          }
          said.delete(provider);
          if (swept.value.deleted.length > 0) deps.log(`the computer janitor ended ${provider}'s computers past their deadline: ${swept.value.deleted.join(", ")}`);
        }
      } catch (error) {
        if (!cut.signal.aborted) deps.log(`the computer janitor's sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = undefined;
      }
    })());
  const first = once();
  const timer = setInterval(() => void (cut.signal.aborted || running || once()), deps.everyMs ?? JANITOR_EVERY_MS);
  timer.unref();
  return {
    first,
    async close() {
      cut.abort();
      clearInterval(timer);
      if (!running) return;
      // A vendor call that ignores the cut (a release takes no signal) is left to finish on its own after this bound.
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([running, new Promise<void>((resolve) => (bound = setTimeout(resolve, deps.closeMs ?? JANITOR_CLOSE_MS)))]);
      clearTimeout(bound);
    },
  };
}
