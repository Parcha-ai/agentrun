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
// - past its deadline, by the computer package's sweep (janitor.ts): the deadline label, or over the provider's cap; or
//   its run is over (final in the store), whatever its deadline: the run's end lets go of every claim's computer
//   (run-end-computers.ts), and this is for one a server that stopped before then left.
// What a computer leaves outside itself (Docker's egress parts) goes with its release; the provider's sweepLeftovers is
// not asked, since it reads labels alone and can't tell this server's parts from another's.
//
// A desktop or a phone kept at a run's park (computer-kept.ts) goes by its own row, on any provider: each sweep ends one
// past its time or whose run ended, and the janitor wakes again at the earliest time still ahead. One pinned to another
// runner still there is that runner's (computer-kept.ts heldElsewhere): the kept pass leaves its row. The provider sweep
// needs no such rule: it ends only a machine past its deadline or whose run is final, which no one uses, and the row's
// runner then reads it gone and marks its row ended.
//
// A provider whose sweep fails is logged, once per distinct failure, and the others are swept. It runs only where its
// start asks for it (the CLI's runner and the runner subcommand), never under --faux, and never two sweeps at once. Its
// close cuts a sweep under way and waits for it on a bound of its own (JANITOR_CLOSE_MS), so a stuck vendor call never
// holds up the runner's stop.
//
// An agent's own computer (a persistent setting, agent-computer.ts) is this server's when its owner names this server's
// id, never by its run: it goes only when its agent no longer wants it (ownerGoneOf: gone, archived, or no longer
// persistent on that provider), never by a deadline. Without the store's settings and agents, none is this server's.
import { type ComputerInfo, type ComputerProvider, epochOf, ok, ownerOf, RUN_HASH_LABEL, RUN_LABEL, type Result, runHash, sweep, type Swept } from "@parcha/agentrun-computer";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { FAUX_ENV } from "../model.js";
import { FINAL_STATES, type Store } from "../store/index.js";
import { deleteUnderHold, ownerGoneOf, serverIdOf, wantsOn } from "./agent-computer.js";
import type { ComputerDeps } from "./computer-deps.js";
import { type KeptHolder, type KeptSweep, sweepKept } from "./computer-kept.js";
import { storeLedger } from "./computer-ledger.js";
import { providerKeys } from "./resolve-computer.js";
import { intervalWrites } from "./computer-intervals.js";

/** How often the janitor sweeps after its first sweep at the runner's start. */
export const JANITOR_EVERY_MS = 10 * 60_000;
/** The longest close() waits for a sweep it cut: a vendor call that ignores the cut is left to finish on its own. */
export const JANITOR_CLOSE_MS = 5_000;
/** The longest one provider's sweep may take: past it the sweep is cut and left, said as a timeout, and the next provider
 *  is swept, so a stuck vendor (a Docker command has no timeout of its own) never stops the others or later sweeps. */
export const JANITOR_PROVIDER_MS = 5 * 60_000;

export interface JanitorDeps {
  /** The store: whose runs a computer's run label names, and the phone provider's ledger; with `settings` and `agents`,
   *  this server's id and its agents, whose own computers it then sweeps by their owner. */
  readonly store: Pick<Store, "runs" | "computerLedger"> & Partial<Pick<Store, "settings" | "agents" | "computerIntervals" | "runners">> & {
    /** The store's clock (Store.sealedKeys.clock): the kept pass judges each kept row's `until` by it, the clock it was
     *  stamped on (computer-kept.ts Kept.until), never this process's. */
    readonly sealedKeys: Pick<Store["sealedKeys"], "clock">;
  };
  /** The runner this janitor sweeps for (its name and presence incarnation): a computer kept at a park pinned to another
   *  runner still there is that runner's to end, never this one's kept pass's (computer-kept.ts sweepKept). Absent:
   *  every pinned row whose runner is there is left. */
  readonly self?: KeptHolder;
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
  /** The clock a computer's deadline label is read by. Default Date.now. A kept row's `until` is the store's clock's
   *  (store.sealedKeys), never this one's. */
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
 *  store, and no claim holds the run now (by the store's clock), or one holds it at a later epoch than the computer's.
 *  "over" for one of these whose run is over (final in the store): no claim of the run will use it again. An agent's own
 *  computer (owned, or an owner label, readable or not) is this server's when its owner names `serverId`, whatever its
 *  run: the sweep's ownerGone then decides. */
async function sweepable(store: JanitorDeps["store"], info: ComputerInfo, byHash: RunsByHash, serverId: string | undefined): Promise<boolean | "over"> {
  const { labels } = info;
  const label = ownerOf(labels);
  const owner = info.owner ?? (label.ok ? label.value : undefined);
  if (info.owned === true || owner !== undefined || !label.ok) return serverId !== undefined && owner?.server === serverId;
  const named = labels[RUN_LABEL];
  const hash = labels[RUN_HASH_LABEL];
  const runId = typeof named === "string" && named !== "" ? named : typeof hash === "string" && hash !== "" ? (await byHash()).get(hash) : undefined;
  if (runId === undefined) return false;
  const run = await store.runs.get(runId);
  // No such run here: another server's computer.
  if (!run) return false;
  const held = await store.runs.heldAt(run.id);
  // A claim holds its own epoch's computer; one of an older epoch is a lost claim's (releaseOlder's too).
  const epoch = epochOf(labels);
  if (held !== undefined && !(epoch.ok && epoch.value < held)) return false;
  return FINAL_STATES.includes(run.state) ? "over" : true;
}

/** `provider` as the sweep sees it: its list cut to this server's computers that no claim holds, and no leftovers pass.
 *  A computer of a run that is over is listed past its deadline (the run's end is its deadline), so the sweep ends it
 *  now: a server that stopped before its run's end let go of an earlier claim's computer (run-end-computers.ts) leaves
 *  it for this sweep, never for its day-long deadline. Each call goes to the provider itself, so its own state is used
 *  as it is. */
function thisServers(provider: ComputerProvider, store: JanitorDeps["store"], byHash: RunsByHash, serverId: string | undefined, at: number, ended: (id: string) => Promise<void>): ComputerProvider {
  // The agents' own computers the list kept, by id: their delete goes under the agent's hold (deleteUnderHold), which
  // also clears the agent's record of it, so its view no longer shows it deleting.
  const ownedBy = new Map<string, string>();
  const { settings, agents } = store;
  return {
    id: provider.id,
    version: provider.version,
    capabilities: () => provider.capabilities(),
    check: (spec) => provider.check(spec),
    create: (spec, context) => provider.create(spec, context),
    attach: (target, context) => provider.attach(target, context),
    network: (ref, policy, context) => provider.network(ref, policy, context),
    connect: (ref) => provider.connect(ref),
    async release(ref, how, context) {
      const agent = ownedBy.get(ref.id);
      if (how !== "delete" || agent === undefined || settings === undefined) {
        const released = await provider.release(ref, how, context);
        // A run's computer the sweep deleted: its interval ends (computer-intervals.ts), on the provider's ok alone.
        if (released.ok && how === "delete") await ended(ref.id);
        return released;
      }
      // Asked again under the hold: the agent may want it back since ownerGone was read (this server's owners carry no
      // idle TTL, so that is the one reason the sweep deletes one).
      const due = async () => !agents || !(await wantsOn({ agents }, agent, provider.id));
      return deleteUnderHold({ settings, runs: store.runs }, agent, ref.id, due, () => provider.release(ref, how, context));
    },
    async list(labels, context) {
      const listed = await provider.list(labels, context);
      if (!listed.ok) return listed;
      const kept: ComputerInfo[] = [];
      for (const info of listed.value) {
        const mine = await sweepable(store, info, byHash, serverId);
        if (!mine) continue;
        const label = ownerOf(info.labels);
        const owner = info.owner ?? (label.ok ? label.value : undefined);
        if (owner !== undefined) ownedBy.set(info.ref.id, owner.agent);
        kept.push(mine === "over" ? { ...info, deadline: new Date(at - 1) } : info);
      }
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
export async function sweepServerComputers(deps: Pick<JanitorDeps, "store" | "computers" | "now" | "providerMs"> & { readonly log?: (line: string) => void }, signal?: AbortSignal): Promise<ProviderSweep[]> {
  const { store, computers } = deps;
  const writes = intervalWrites(store, deps.log, deps.now);
  const at = (deps.now ?? Date.now)();
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const byHash = runsByHash(store);
  // This server's id and its agents: its agents' own computers are swept by their owner (ownerGoneOf).
  const { settings, agents } = store;
  const serverId = settings && agents ? await serverIdOf({ settings }) : undefined;
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
      const ownerGone = serverId !== undefined && settings && agents ? ownerGoneOf({ agents, settings, runs: store.runs }, serverId, entry.id) : undefined;
      out.push({ provider: entry.id, swept: await bounded(deps.providerMs ?? JANITOR_PROVIDER_MS, signal, (cut) => sweep(thisServers(provider, store, byHash, serverId, at, (id) => writes.ended(entry.id, id)), { now: new Date(at), signal: cut, ...(ownerGone ? { ownerGone } : {}) })) });
    } catch (error) {
      out.push({ provider: entry.id, swept: { ok: false, error: { code: "refused", message: error instanceof Error ? error.message : String(error) } } });
    }
  }
  return out;
}

/** The pass over the desktops and phones kept at a run's park (computer-kept.ts sweepKept): one past its time, or whose
 *  run ended, is ended through its provider, made with this server's keys, whatever its lifetime (a vendor's own end is
 *  hours away); one pinned to another runner still there (the store's runners) is left to that runner. Undefined without
 *  the store's settings, where none is kept. Never throws. */
export async function sweepKeptComputers(deps: Pick<JanitorDeps, "store" | "computers" | "now" | "self"> & { readonly log?: (line: string) => void }): Promise<KeptSweep | undefined> {
  const { store, computers } = deps;
  const writes = intervalWrites(store, deps.log, deps.now);
  if (!store.settings) return undefined;
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const providerOf = async (id: string): Promise<ComputerProvider | undefined> => {
    const make = Object.hasOwn(computers.providers, id) ? computers.providers[id] : undefined;
    if (!make || !computers.kinds.PROVIDERS.some((entry) => entry.id === id)) return undefined;
    const options = providerOptions(id, await keysOf(id), computers.settings ?? {}, computers.keyTable ?? KEY_TABLE);
    return options.ok ? make(options.options, { ledger: storeLedger(store.computerLedger, id) }) : undefined;
  };
  // Each row's `until` was stamped on the store's clock (computer-kept.ts Kept.until), so it is judged on it.
  let now: number;
  try {
    now = await store.sealedKeys.clock();
  } catch (error) {
    return { ended: [], failed: [`the store's clock could not be read, so no kept computer's time could be judged this pass: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return sweepKept({ settings: store.settings, runs: store.runs, now, providerOf, deleted: (provider, id) => writes.ended(provider, id), ...(store.runners ? { runners: store.runners } : {}), ...(deps.self ? { self: deps.self } : {}) });
}

/** The janitor: one sweep now, then one every `everyMs`, never two at once, and a kept pass at the earliest time a kept
 *  computer is due (sweepKeptComputers; each delete bounded, KEPT_DELETE_MS), so a park's keep ends on time though the
 *  process that parked it is gone. A wake that comes while a sweep runs runs the kept pass as soon as that sweep is done.
 *  `close()` stops it, cuts a sweep under way and waits for it at most `closeMs`. Under --faux it does nothing. */
export function startJanitor(deps: JanitorDeps): { readonly first: Promise<void>; close(): Promise<void> } {
  if (deps.env[FAUX_ENV]) return { first: Promise.resolve(), close: async () => {} };
  /** The last failure said per provider: a failure is said once, until it changes or the provider sweeps again. */
  const said = new Map<string, string>();
  const cut = new AbortController();
  let running: Promise<void> | undefined;
  /** The wake at the earliest kept computer's time, when it is sooner than the next sweep. */
  let wake: NodeJS.Timeout | undefined;
  /** A wake that came while a sweep ran: the kept pass runs again once that sweep is done. */
  let missed = false;
  const keptPass = async (): Promise<void> => {
    const kept = await sweepKeptComputers(deps);
    if (!kept || cut.signal.aborted) return;
    if (kept.ended.length > 0) deps.log(`the computer janitor ended the computers kept at a park past their time: ${kept.ended.join(", ")}`);
    for (const words of kept.failed) deps.log(`the computer janitor could not end a computer kept at a park: ${words}`);
    clearTimeout(wake);
    wake = undefined;
    if (kept.next === undefined) return;
    // `next` is on the store's clock, so the wait is reckoned from it. Unread: no wake, and the next sweep (everyMs)
    // passes over the rows again.
    const at = await deps.store.sealedKeys.clock().catch(() => undefined);
    if (at === undefined || cut.signal.aborted) return;
    wake = setTimeout(() => {
      if (cut.signal.aborted) return;
      if (running) missed = true;
      else void alone(keptPass);
    }, Math.max(0, kept.next - at) + 1_000);
    wake.unref();
  };
  /** `work` as the one sweep under way; a wake missed meanwhile runs the kept pass once it is done. */
  const alone = (work: () => Promise<void>): Promise<void> =>
    (running ??= (async () => {
      try {
        await work();
      } catch (error) {
        if (!cut.signal.aborted) deps.log(`the computer janitor's sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = undefined;
        if (missed && !cut.signal.aborted) {
          missed = false;
          void alone(keptPass);
        }
      }
    })());
  const once = (): Promise<void> =>
    alone(async () => {
      await keptPass();
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
    });
  const first = once();
  const timer = setInterval(() => void (cut.signal.aborted || running || once()), deps.everyMs ?? JANITOR_EVERY_MS);
  timer.unref();
  return {
    first,
    async close() {
      cut.abort();
      clearInterval(timer);
      clearTimeout(wake);
      if (!running) return;
      // A vendor call that ignores the cut (a release takes no signal) is left to finish on its own after this bound.
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([running, new Promise<void>((resolve) => (bound = setTimeout(resolve, deps.closeMs ?? JANITOR_CLOSE_MS)))]);
      clearTimeout(bound);
    },
  };
}
