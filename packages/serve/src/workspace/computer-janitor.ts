// The computer janitor of this server: at the runner's start, then every JANITOR_EVERY_MS, each computer this server made
// that is past its deadline is ended. A run's release ends its computer; the janitor is for the ones a crashed runner
// left, on a provider whose vendor never ends them itself (capabilities().lifetime "janitor": Docker, Orgo).
//
// Which computers it may end:
// - a provider's whose keys this server has (saved, or in its environment); Docker takes none, so it is always asked;
// - one whose agentrun.run label names a run in this server's store: a vendor account or a Docker host shared with another
//   server lists that server's computers too, and they are never touched;
// - never one a live claim holds: its run has a runner whose claim has not lapsed, at the computer's own epoch;
// - past its deadline, by the computer package's sweep (janitor.ts): the deadline label, or over the provider's cap.
// What a computer leaves outside itself (Docker's egress parts) goes with its release; the provider's sweepLeftovers is
// not asked, since it reads labels alone and can't tell this server's parts from another's.
//
// A provider whose sweep fails is logged, once per distinct failure, and the others are swept. It runs only where its
// start asks for it (the CLI's runner and the runner subcommand), never under --faux, and never two sweeps at once.
import { type ComputerInfo, type ComputerProvider, epochOf, ok, RUN_LABEL, type Result, sweep, type Swept } from "@parcha/agentrun-computer";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { FAUX_ENV } from "../model.js";
import type { Store } from "../store/index.js";
import type { ComputerDeps } from "./computer-deps.js";
import { storeLedger } from "./computer-ledger.js";
import { providerKeys } from "./resolve-computer.js";

/** How often the janitor sweeps after its first sweep at the runner's start. */
export const JANITOR_EVERY_MS = 10 * 60_000;

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
  /** The clock a deadline and a claim are read by. Default Date.now. */
  readonly now?: () => number;
}

/** One provider's sweep: what it ended, or why it could not sweep, in words. */
export type ProviderSweep = { readonly provider: string; readonly swept: Result<Swept> };

/** Whether a listed computer is this server's and no live claim holds it: its run is in this store, and is not claimed
 *  now at the computer's epoch. */
async function sweepable(store: JanitorDeps["store"], labels: Readonly<Record<string, string>>, now: number): Promise<boolean> {
  const runId = labels[RUN_LABEL];
  if (typeof runId !== "string" || runId === "") return false;
  const run = await store.runs.get(runId);
  // No such run here: another server's computer.
  if (!run) return false;
  const claimed = run.runner !== null && run.claimedUntil !== null && run.claimedUntil > now;
  if (!claimed) return true;
  // A live claim holds its own epoch's computer; one of an older epoch is a lost claim's (releaseOlder's too).
  const epoch = epochOf(labels);
  return epoch.ok && epoch.value < run.epoch;
}

/** `provider` as the sweep sees it: its list cut to this server's computers that no live claim holds, and no leftovers
 *  pass. Each call goes to the provider itself, so its own state is used as it is. */
function thisServers(provider: ComputerProvider, store: JanitorDeps["store"], now: number): ComputerProvider {
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
      for (const info of listed.value) if (await sweepable(store, info.labels, now)) kept.push(info);
      return ok(kept);
    },
  };
}

/** One sweep of every provider this server can list: each provider whose keys it has and whose computers the janitor
 *  ends, its computers past their deadline that are this server's and unheld ended. A provider that fails is answered
 *  in its words; nothing throws. */
export async function sweepServerComputers(deps: Pick<JanitorDeps, "store" | "computers" | "now">): Promise<ProviderSweep[]> {
  const { store, computers } = deps;
  const at = (deps.now ?? Date.now)();
  const keysOf = providerKeys(computers.kinds, computers.keyOf ?? (async () => undefined));
  const out: ProviderSweep[] = [];
  for (const entry of computers.kinds.PROVIDERS) {
    const make = Object.hasOwn(computers.providers, entry.id) ? computers.providers[entry.id] : undefined;
    if (!make) continue;
    // Its keys not here: nothing of this server's can be listed there.
    const options = providerOptions(entry.id, await keysOf(entry.id), computers.settings ?? {}, computers.keyTable ?? KEY_TABLE);
    if (!options.ok) continue;
    try {
      const provider = await make(options.options, { ledger: storeLedger(store.computerLedger, entry.id) });
      // A vendor that ends its own computers needs no janitor.
      if (provider.capabilities().lifetime !== "janitor") continue;
      out.push({ provider: entry.id, swept: await sweep(thisServers(provider, store, at), { now: new Date(at) }) });
    } catch (error) {
      out.push({ provider: entry.id, swept: { ok: false, error: { code: "refused", message: error instanceof Error ? error.message : String(error) } } });
    }
  }
  return out;
}

/** The janitor: one sweep now, then one every `everyMs`, never two at once. `close()` stops it and waits for a sweep under
 *  way. Under --faux it does nothing. */
export function startJanitor(deps: JanitorDeps): { readonly first: Promise<void>; close(): Promise<void> } {
  if (deps.env[FAUX_ENV]) return { first: Promise.resolve(), close: async () => {} };
  /** The last failure said per provider: a failure is said once, until it changes or the provider sweeps again. */
  const said = new Map<string, string>();
  let running: Promise<void> | undefined;
  let closed = false;
  const once = (): Promise<void> =>
    (running ??= (async () => {
      try {
        for (const { provider, swept } of await sweepServerComputers(deps)) {
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
        deps.log(`the computer janitor's sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = undefined;
      }
    })());
  const first = once();
  const timer = setInterval(() => void (closed || running || once()), deps.everyMs ?? JANITOR_EVERY_MS);
  timer.unref();
  return {
    first,
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
