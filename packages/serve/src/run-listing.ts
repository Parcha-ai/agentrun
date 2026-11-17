// The runs' listings (store/schema.ts RUN_LISTING_COLUMNS): what a runs list shows of each run, kept on its row so a list
// reads rows alone, whatever the number of runs and however long their journals. Every write that can change a run's view
// moves its row's mark in that write's own transaction (the journal's commits, the row, its commands, its learning), so a
// row whose listing is behind says so. This lister, in the server's process (the one that holds what a view is cut of:
// its secrets, its saved keys, its agents' sign-ins and learning folders), builds each behind run's listing from its view
// (store-view.ts listingOverStore) and writes it at the mark it read first: a write that lands meanwhile leaves it behind
// again, so it is built once more.
//
// A run no runner holds (parked, waiting on its person, ended) is built at once, so a list reads it as its view does within
// one pass. A run a runner holds and works on moves on every commit: it is built at most once per HELD_REBUILD_MS, or four
// times its last build's time when that is longer, so a long run's work never turns into a view built per commit. Two
// things outside a run's writes also move its listing: the server's keys (a failed run's error names a refused key by
// them; relist at the start and on a key's save) and an agent's learning folder (a learning held for its owner's OK reads
// as it stands there; read for the agents that have such runs, each pass).
import type { Store } from "./store/store.js";
import { LISTING_HELD, LISTING_KEYED } from "./store/schema.js";
import { listingOverStore, type ViewDeps } from "./store-view.js";

/** Most rows a pass reads. */
const PASS_ROWS = 32;
/** How often an idle lister looks again (ms). */
export const LISTER_IDLE_MS = 400;
/** The least time between two builds of one run a runner holds (ms). */
const HELD_REBUILD_MS = 1_000;
/** How long a run whose view failed to build waits before it is tried again (ms). */
const FAILED_RETRY_MS = 30_000;

export interface Lister {
  /** Resolves once a pass finds nothing it may build now: every run's listing is current, but for a held run built within
   *  its rebuild time. For tests and benchmarks; the server never waits on it. */
  settled(): Promise<void>;
  /** The server's keys or settings changed: every failed run's listing (its error words) is marked behind before this
   *  resolves, so the next list builds it again. */
  keysChanged(): Promise<void>;
  /** Stops after the pass under way. */
  stop(): Promise<void>;
}

export function startLister(store: Store, depsOf: () => ViewDeps, options: { readonly log?: (line: string, error: Error) => void; readonly now?: () => number; readonly idleMs?: number } = {}): Lister {
  const now = options.now ?? Date.now;
  /** Infinity: no pass of its own, only those settled() asks for. */
  const idleMs = options.idleMs ?? LISTER_IDLE_MS;
  let closing = false;
  let timer: NodeJS.Timeout | undefined;
  let pass: Promise<number> = Promise.resolve(0);
  /** A held run's last build: when, and how long it took. */
  const built = new Map<string, { at: number; ms: number }>();
  /** The agents with a run whose learning holds items for the owner's OK, with their folder's statuses as last read. */
  const folders = new Map<string, unknown>();
  /** When each run whose view failed to build last failed. */
  const failed = new Map<string, number>();
  /** The first pass marks behind every listing that read outside its run: the keys or folders may have moved while no
   *  server ran. */
  let relistKeys = true;

  const say = (what: string, error: unknown) => options.log?.(what, error instanceof Error ? error : new Error(String(error)));

  /** One pass: what moved outside the runs' writes, then each behind row this pass may build. The rows it built. */
  async function once(): Promise<number> {
    const deps = depsOf();
    if (relistKeys) {
      relistKeys = false;
      await store.runs.relist({ flags: LISTING_HELD | LISTING_KEYED });
    }
    for (const [agentId, seen] of folders) {
      const statuses = await deps.statuses?.(agentId);
      if (statuses === seen) continue;
      folders.set(agentId, statuses);
      await store.runs.relist({ flags: LISTING_HELD, agentId });
    }
    let count = 0;
    for (const { id, mark, held } of await store.runs.behind({ limit: PASS_ROWS })) {
      if (closing) break;
      const last = built.get(id);
      if (held && last && now() - last.at < Math.max(HELD_REBUILD_MS, 4 * last.ms)) continue;
      // A run whose view failed to build is tried again after FAILED_RETRY_MS, never holding up the rows after it.
      if ((failed.get(id) ?? -Infinity) > now() - FAILED_RETRY_MS) continue;
      const start = now();
      let listing: Awaited<ReturnType<typeof listingOverStore>>;
      try {
        listing = await listingOverStore(store, id, deps);
        if (listing) await store.runs.putListing(id, mark, listing);
        failed.delete(id);
      } catch (error) {
        failed.set(id, now());
        say("run_listing_unbuilt", error);
        continue;
      }
      if (!listing) continue;
      count++;
      if (held) built.set(id, { at: now(), ms: now() - start });
      else built.delete(id);
      const agentId = String(listing.item.agent_id);
      if (listing.flags & LISTING_HELD && !folders.has(agentId)) folders.set(agentId, await deps.statuses?.(agentId));
    }
    return count;
  }

  /** A pass after the one under way: one at a time, whoever asks. */
  const turn = (): Promise<number> => (pass = pass.then(() => (closing ? 0 : once())).catch((error: unknown) => (say("run_listing_unbuilt", error), 0)));
  function next(delay: number): void {
    if (closing || !Number.isFinite(idleMs)) return;
    timer = setTimeout(() => void turn().then((count) => next(count > 0 ? 0 : idleMs)), delay);
    timer.unref();
  }
  next(0);

  return {
    async settled() {
      while ((await turn()) > 0);
    },
    async keysChanged() {
      await store.runs.relist({ flags: LISTING_KEYED });
    },
    async stop() {
      closing = true;
      clearTimeout(timer);
      await pass;
    },
  };
}
