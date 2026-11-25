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
// What a computer leaves outside itself (Docker's egress proxy and volume) goes with its release. One a release never
// took (a server that stopped partway through a teardown) is the provider's sweepLeftovers', asked for this server's
// alone (leftoverMine): one whose agentrun.run label (or its hash) names a run in this store, or whose owner names this
// server, by the same labels the computers go by. Another server's on the same Docker host is never touched; it goes at
// that server's own next sweep.
//
// A desktop or a phone kept at a run's park (computer-kept.ts) goes by its own row, on any provider: each sweep ends one
// past its time or whose run ended, with the mount credential of a run folder it held on Archil, and the janitor wakes
// again at the earliest time still ahead. One pinned to another runner still there is that runner's (computer-kept.ts
// heldElsewhere): the kept pass leaves its row, its credential with it. The provider sweep ends only a machine past its
// deadline or whose run is final, which no one uses. Its row is marked ending before that delete (endingKeptMachine), so
// a follow-up never takes the machine back mid-delete, and ended once the delete took it (finishedKept), so the run's
// next park writes its own keep; a row a claim is taking back is left, and the machine with it, said as a failed delete.
// A machine kept on Archil has its park's mount credential removed before its row is marked ended, as the kept pass
// removes it: no pass removes a credential for an ended row. A remove that fails leaves the row ending, and the kept pass
// that then ends it removes the credential.
//
// A provider whose sweep fails is logged, once per distinct failure, and the others are swept. It runs only where its
// start asks for it (the CLI's runner and the runner subcommand), never under --faux, and never two sweeps at once. Its
// close cuts a sweep under way and waits for it on a bound of its own (JANITOR_CLOSE_MS), so a stuck vendor call never
// holds up the runner's stop.
//
// An agent's own computer (a persistent setting, agent-computer.ts) is this server's when its owner names this server's
// id, never by its run: it goes only when its agent no longer wants it (ownerGoneOf: gone, archived, or no longer
// persistent on that provider), never by a deadline. Without the store's settings and agents, none is this server's.
import { type ComputerInfo, type ComputerProvider, epochOf, fail, ok, ownerOf, RUN_HASH_LABEL, RUN_LABEL, type Result, runHash, sweep, type Swept } from "@parcha/agentrun-computer";
import { loadArchilSettings } from "../archil-settings.js";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { FAUX_ENV } from "../model.js";
import { FINAL_STATES, type Store } from "../store/index.js";
import { deleteUnderHold, ownerGoneOf, serverIdOf, wantsOn } from "./agent-computer.js";
import { archilApiKey } from "./archil-key.js";
import { removeRunMountTokens } from "./archil-mount-credential.js";
import type { ComputerDeps } from "./computer-deps.js";
import { endingKeptMachine, finishedKept, type Kept, type KeptHolder, type KeptMountRevoke, type KeptSweep, readKept, sweepKept } from "./computer-kept.js";
import { MOUNT_TTL_MS } from "./archil-claim.js";
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
    /** The store's sealed keys: the saved Archil account key the kept pass removes a mount credential with
     *  (archil-key.ts), and the store's clock (Store.sealedKeys.clock), by which the kept pass judges each kept row's
     *  `until`, the clock it was stamped on (computer-kept.ts Kept.until), never this process's. */
    readonly sealedKeys: Store["sealedKeys"];
  };
  /** The server's seal key, as the runner's claims are handed it: it opens the saved Archil account key (archil-key.ts)
   *  the kept pass removes a run's mount credential with. Undefined: only an ARCHIL_API_KEY in `env` is had. */
  readonly sealKey: Buffer | undefined;
  /** Archil's control plane for that remove, as the claims' mountControl: a test's fake. Absent: the region's own. */
  readonly mountControl?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
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

/** The run a computer's labels name: by its run label, or its hash's (runsByHash); undefined for none of this store's. */
async function runOf(labels: ComputerInfo["labels"], byHash: RunsByHash): Promise<string | undefined> {
  const named = labels[RUN_LABEL];
  const hash = labels[RUN_HASH_LABEL];
  return typeof named === "string" && named !== "" ? named : typeof hash === "string" && hash !== "" ? (await byHash()).get(hash) : undefined;
}

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
  const runId = await runOf(labels, byHash);
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

/** What the provider sweep marks a kept machine's row by: the store's settings, the provider's registry id, the one a
 *  row names, and the remove of a row's Archil mount credential (keptMountRevoke), asked before a row kept on Archil is
 *  marked ended (computer-kept.ts finishedKept). Absent: such a row is left ending, for the kept pass. */
type KeptMarks = {
  readonly settings: NonNullable<JanitorDeps["store"]["settings"]>;
  readonly entry: string;
  readonly revokeMount?: KeptMountRevoke;
};

type LeftoverContext = Parameters<NonNullable<ComputerProvider["sweepLeftovers"]>>[0];

/** Whether a leftover with these labels is this server's to remove: an agent's (an owner label) when its owner names
 *  `serverId`; otherwise when its run (by its label, or its hash's) is in this store and no claim holds it now
 *  (runs.heldAt, by the store's clock). A held run's runner may be making the computer this part belongs to: create
 *  makes the proxy before the computer. The provider reads the computer after this answer (Docker's sweepLeftovers),
 *  and that read is final: a computer is made only under a held claim, its name is its claim's (runId#epoch), so once
 *  none holds the run, no create at that claim is left, and a later claim's computer has another name. */
async function leftoverMine(store: JanitorDeps["store"], labels: Record<string, string>, byHash: RunsByHash, serverId: string | undefined): Promise<boolean> {
  const label = ownerOf(labels);
  if (!label.ok || label.value !== undefined) return label.ok && serverId !== undefined && label.value?.server === serverId;
  const named = labels[RUN_LABEL];
  const hash = labels[RUN_HASH_LABEL];
  const runId = typeof named === "string" && named !== "" ? named : typeof hash === "string" && hash !== "" ? (await byHash()).get(hash) : undefined;
  if (runId === undefined || (await store.runs.get(runId)) === undefined) return false;
  return (await store.runs.heldAt(runId)) === undefined;
}

/** `provider` as the sweep sees it: its list cut to this server's computers that no claim holds, and its leftovers pass
 *  (where it has one) cut to this server's (leftoverMine).
 *  A computer of a run that is over is listed past its deadline (the run's end is its deadline), so the sweep ends it
 *  now: a server that stopped before its run's end let go of an earlier claim's computer (run-end-computers.ts) leaves
 *  it for this sweep, never for its day-long deadline. Each call goes to the provider itself, so its own state is used
 *  as it is. */
function thisServers(provider: ComputerProvider, store: JanitorDeps["store"], byHash: RunsByHash, serverId: string | undefined, at: number, ended: (id: string) => Promise<void>, keeps?: KeptMarks): ComputerProvider {
  // The agents' own computers the list kept, by id: their delete goes under the agent's hold (deleteUnderHold), which
  // also clears the agent's record of it, so its view no longer shows it deleting.
  const ownedBy = new Map<string, string>();
  // The machines the list kept that their run's park row keeps, by id, each that run: the row is marked ending before
  // the delete (endingKeptMachine), and a row a claim has is left with its machine. A machine whose run's row could not
  // be read is left too, in the store's words: it may be kept, and a delete unmarked could go under a claim's attach.
  const keptRun = new Map<string, string>();
  const unread = new Map<string, string>();
  const { settings, agents } = store;
  const leftovers = provider.sweepLeftovers?.bind(provider);
  return {
    id: provider.id,
    version: provider.version,
    capabilities: () => provider.capabilities(),
    check: (spec) => provider.check(spec),
    create: (spec, context) => provider.create(spec, context),
    attach: (target, context) => provider.attach(target, context),
    network: (ref, policy, context) => provider.network(ref, policy, context),
    connect: (ref) => provider.connect(ref),
    ...(leftovers === undefined ? {} : { sweepLeftovers: (context: LeftoverContext) => leftovers({ ...context, mine: (labels) => leftoverMine(store, labels, byHash, serverId) }) }),
    async release(ref, how, context) {
      const why = how === "delete" ? unread.get(ref.id) : undefined;
      if (why !== undefined) return fail("refused", `its run's kept row could not be read (${why}), so it was left`);
      const run = how === "delete" ? keptRun.get(ref.id) : undefined;
      /** The machine's row as marked ending here: ended once the delete took it, a credential on Archil removed first
       *  (finishedKept). */
      let finished: (() => Promise<unknown>) | undefined;
      if (run !== undefined && keeps) {
        const marked = await endingKeptMachine(keeps.settings, run, { provider: keeps.entry, id: ref.id });
        if (marked.kind === "left") return fail("refused", `it is kept at run ${run}'s park and a claim is taking it back or has it, so it was left`);
        if (marked.kind === "unmarked") return fail("refused", `it is kept at run ${run}'s park and its row could not be marked ending (${marked.why}), so it was left for the row's time`);
        const kept = marked.kept;
        if (kept && kept.provider === keeps.entry && kept.id === ref.id) finished = () => finishedKept(keeps.settings, run, kept, keeps.revokeMount);
      }
      const agent = ownedBy.get(ref.id);
      if (how !== "delete" || agent === undefined || settings === undefined) {
        const released = await provider.release(ref, how, context);
        // A run's computer the sweep deleted: its interval ends (computer-intervals.ts), on the provider's ok alone.
        if (released.ok && how === "delete") {
          await ended(ref.id);
          await finished?.();
        }
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
        // Its run's kept row, read before any delete: whether it keeps this machine.
        const runId = keeps ? await runOf(info.labels, byHash) : undefined;
        if (keeps && runId !== undefined) {
          try {
            const row = await readKept(keeps.settings, runId);
            if (row && !row.ended && row.provider === keeps.entry && row.id === info.ref.id) keptRun.set(info.ref.id, runId);
          } catch (error) {
            unread.set(info.ref.id, error instanceof Error ? error.message : String(error));
          }
        }
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
export async function sweepServerComputers(deps: Pick<JanitorDeps, "store" | "computers" | "now" | "providerMs"> & Partial<Pick<JanitorDeps, "env" | "sealKey" | "mountControl">> & { readonly log?: (line: string) => void }, signal?: AbortSignal): Promise<ProviderSweep[]> {
  const { store, computers } = deps;
  const writes = intervalWrites(store, deps.log, deps.now);
  const at = (deps.now ?? Date.now)();
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const byHash = runsByHash(store);
  // This server's id and its agents: its agents' own computers are swept by their owner (ownerGoneOf).
  const { settings, agents } = store;
  // A kept machine on Archil this sweep deletes has its park's mount credential removed before its row is marked ended,
  // its ttl judged on the store's clock, as the kept pass judges it. Without the runs' environment, its row is left
  // ending for the kept pass.
  const revokeMount = settings && deps.env ? keptMountRevoke({ settings, sealedKeys: store.sealedKeys, env: deps.env, sealKey: deps.sealKey, ...(deps.mountControl ? { mountControl: deps.mountControl } : {}) }, () => store.sealedKeys.clock()) : undefined;
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
      out.push({ provider: entry.id, swept: await bounded(deps.providerMs ?? JANITOR_PROVIDER_MS, signal, (cut) => sweep(thisServers(provider, store, byHash, serverId, at, (id) => writes.ended(entry.id, id), settings ? { settings, entry: entry.id, ...(revokeMount ? { revokeMount } : {}) } : undefined), { now: new Date(at), signal: cut, ...(ownerGone ? { ownerGone } : {}) })) });
    } catch (error) {
      out.push({ provider: entry.id, swept: { ok: false, error: { code: "refused", message: error instanceof Error ? error.message : String(error) } } });
    }
  }
  return out;
}

/** The remove of a kept row's Archil mount credential (computer-kept.ts KeptMountRevoke), as every end of a row kept on
 *  Archil asks it (the kept pass, the provider sweep, a run's end): the run's credentials up to the row's epoch removed,
 *  by name, on the disk its row names (the park's), with this server's Archil key read as the claims read it
 *  (archil-key.ts): no run lookup, so a run deleted since, or an agent whose disk changed, still has it removed. A row
 *  that names no disk has none removed, and its credential ends at its ttl. Past its keep's time plus MOUNT_TTL_MS, by
 *  `now` (the store's clock, the one `until` was stamped on), no remove is asked: the credential was minted before the
 *  park, so it has ended at its ttl. Throws where the remove failed, or this server's Archil settings are gone. */
export function keptMountRevoke(deps: {
  readonly settings: NonNullable<JanitorDeps["store"]["settings"]>;
  readonly sealedKeys: Pick<Store["sealedKeys"], "get">;
  readonly env: NodeJS.ProcessEnv;
  readonly sealKey: Buffer | undefined;
  readonly mountControl?: JanitorDeps["mountControl"];
}, now: () => Promise<number>): (runId: string, kept: Pick<Kept, "epoch" | "until" | "disk">) => Promise<void> {
  return async (runId, kept) => {
    const { disk } = kept;
    if (disk === undefined || (await now()) >= kept.until + MOUNT_TTL_MS) return;
    const archil = await loadArchilSettings({ settings: deps.settings }, deps.env);
    if (!archil) throw new Error("its mount credential was not removed: this server's Archil settings are gone");
    const { value } = await archilApiKey({ env: deps.env, keys: deps.sealedKeys, sealKey: deps.sealKey });
    await removeRunMountTokens({ region: archil.region, key: () => value, disk, ...deps.mountControl }, runId, kept.epoch);
  };
}

/** The pass over the desktops and phones kept at a run's park (computer-kept.ts sweepKept): one past its time, or whose
 *  run ended, is ended through its provider, made with this server's keys, whatever its lifetime (a vendor's own end is
 *  hours away); one pinned to another runner still there (the store's runners) is left to that runner. One that held the
 *  run's folder on Archil has the run's mount credentials up to its epoch removed (keptMountRevoke). Past its keep's time
 *  plus MOUNT_TTL_MS no remove is asked, so a remove that can never succeed (Archil turned off, its key gone, a refusal
 *  for good) no longer keeps the row ending and said at every pass. Undefined without the store's settings, where none
 *  is kept. Never throws. */
export async function sweepKeptComputers(deps: Pick<JanitorDeps, "store" | "computers" | "env" | "sealKey" | "mountControl" | "now" | "self"> & { readonly log?: (line: string) => void }): Promise<KeptSweep | undefined> {
  const { store, computers } = deps;
  const writes = intervalWrites(store, deps.log, deps.now);
  const { settings } = store;
  if (!settings) return undefined;
  // Each row's `until` was stamped on the store's clock (computer-kept.ts Kept.until), so it is judged on it: its end and
  // the give-up of its credential's remove (past `until` plus MOUNT_TTL_MS) alike.
  let now: number;
  try {
    now = await store.sealedKeys.clock();
  } catch (error) {
    return { ended: [], failed: [`the store's clock could not be read, so no kept computer's time could be judged this pass: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const revokeMount = keptMountRevoke({ settings, sealedKeys: store.sealedKeys, env: deps.env, sealKey: deps.sealKey, ...(deps.mountControl ? { mountControl: deps.mountControl } : {}) }, async () => now);
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const providerOf = async (id: string): Promise<ComputerProvider | undefined> => {
    const make = Object.hasOwn(computers.providers, id) ? computers.providers[id] : undefined;
    if (!make || !computers.kinds.PROVIDERS.some((entry) => entry.id === id)) return undefined;
    const options = providerOptions(id, await keysOf(id), computers.settings ?? {}, computers.keyTable ?? KEY_TABLE);
    return options.ok ? make(options.options, { ledger: storeLedger(store.computerLedger, id) }) : undefined;
  };
  return sweepKept({ settings, runs: store.runs, now, providerOf, deleted: (provider, id) => writes.ended(provider, id), revokeMount, ...(store.runners ? { runners: store.runners } : {}), ...(deps.self ? { self: deps.self } : {}) });
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
        if ((swept.value.leftovers ?? []).length > 0) deps.log(`the computer janitor removed what ${provider}'s computers left behind: ${(swept.value.leftovers ?? []).join(", ")}`);
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
