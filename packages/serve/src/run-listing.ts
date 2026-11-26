// The runs' listings (store/schema.ts RUN_LISTING_COLUMNS): what a runs list shows of each run, kept on its row so a list
// reads rows alone, whatever the number of runs and however long their journals. Every write that can change a run's view
// moves its row's mark in that write's own transaction (the journal's commits, the row, its commands, its learning), so a
// row whose listing is behind says so. This lister, in the server's process (the one that holds what a view is cut of:
// its secrets, its saved keys, its agents' sign-ins and learning), builds each behind run's listing from its view
// (store-view.ts listingOverStore) and writes it at the mark it read first: a write that lands meanwhile leaves it behind
// again, so it is built once more.
//
// A run no runner holds (parked, waiting on its person, ended) is built at once, so a list reads it as its view does within
// one pass. A run a runner holds and works on moves on every commit: it is built at most once per HELD_REBUILD_MS, or four
// times its last build's time when that is longer, so a long run's work never turns into a view built per commit. Two
// things outside a run's writes also move its listing: the server's keys (a failed run's error names a refused key by
// them; relist at the start and on a key's save) and an agent's learning (a learning held for its owner's OK reads
// as it stands there; read for the agents that have such runs, each pass). A list that finds a listing behind builds it
// through the lister too (Lister.build), so every build of a held listing hands the lister the folder state it read.
import type { RunListing, Store } from "./store/store.js";
import { LISTING_HELD, LISTING_KEYED } from "./store/schema.js";
import { LISTING_RETRY_MS, listingOverStore, type ViewDeps } from "./store-view.js";

/** Most rows one read of a pass reads. */
const PASS_ROWS = 32;
/** How often an idle lister looks again (ms). */
export const LISTER_IDLE_MS = 400;
/** The least time between two builds of one run a runner holds (ms). */
const HELD_REBUILD_MS = 1_000;

export interface Lister {
  /** Starts its own passes: the first at once, then one each idle time (none with an idle time of Infinity). */
  start(): void;
  /** Builds run `runId`'s listing over `deps` and writes it at `mark`, the mark read before the build (Runs.putListing:
   *  not written when a write moved it since). A listing that read a workflow held for its owner's OK puts its agent's
   *  folder among those each pass reads, with the statuses this build read: an approval that lands after that read is
   *  then seen by the next pass, whoever built the listing (a pass, or a list). Undefined for an unknown run. */
  build(runId: string, mark: number, deps: ViewDeps): Promise<{ listing: RunListing | undefined; written: boolean }>;
  /** Resolves once a pass finds nothing it may build now: every run's listing is current, but for a held run built within
   *  its rebuild time. For tests and benchmarks; the server never waits on it. */
  settled(): Promise<void>;
  /** The server's keys or settings changed: every failed run's listing (its error words) is marked behind before this
   *  resolves, so the next list builds it again. */
  keysChanged(): Promise<void>;
  /** A person changed agent `agentId`'s learning (a workflow approved, retired or restored): each of its runs
   *  whose listing read a workflow held for the owner's OK is marked behind before this resolves, so the next list says what
   *  the folder says now. A change made outside the server is read by the next pass. */
  learningChanged(agentId: string): Promise<void>;
  /** Stops after the pass under way. */
  stop(): Promise<void>;
}

/** The lister over `store`, its passes not started (Lister.start): a list may build through it before they are. */
export function createLister(store: Store, depsOf: () => ViewDeps, options: { readonly log?: (line: string, error: Error) => void; readonly now?: () => number; readonly idleMs?: number } = {}): Lister {
  const now = options.now ?? Date.now;
  /** Infinity: no pass of its own, only those settled() asks for. */
  const idleMs = options.idleMs ?? LISTER_IDLE_MS;
  let closing = false;
  let timer: NodeJS.Timeout | undefined;
  let pass: Promise<number> = Promise.resolve(0);
  /** A held run's last build: when, and how long it took. */
  const built = new Map<string, { at: number; ms: number }>();
  /** The agents with a run whose learning holds items for the owner's OK, with their folder's statuses as last read (for an
   *  agent first met in a build, as that build read them). */
  const folders = new Map<string, unknown>();
  /** When each run whose view failed to build last failed. */
  const failed = new Map<string, number>();
  /** The first pass marks behind every listing that read outside its run: the keys or folders may have moved while no
   *  server ran. */
  let relistKeys = true;

  const say = (what: string, error: unknown) => options.log?.(what, error instanceof Error ? error : new Error(String(error)));

  /** Lister.build: the one build of a listing, a pass's or a list's. */
  async function build(id: string, mark: number, deps: ViewDeps): Promise<{ listing: RunListing | undefined; written: boolean }> {
    // The folder statuses this build read, by agent: the baseline a later pass compares against, never a read made after
    // it, which a person's approval landing before this listing's write would already hold.
    const read = new Map<string, unknown>();
    const statuses = deps.statuses;
    const buildDeps: ViewDeps = statuses ? { ...deps, statuses: async (agentId) => { const seen = await statuses(agentId); if (!read.has(agentId)) read.set(agentId, seen); return seen; } } : deps;
    const listing = await listingOverStore(store, id, buildDeps);
    const written = listing ? await store.runs.putListing(id, mark, listing) : false;
    const agentId = listing ? String(listing.item.agent_id) : "";
    if (listing && listing.flags & LISTING_HELD && !folders.has(agentId)) folders.set(agentId, read.get(agentId));
    return { listing, written };
  }

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
    // PASS_ROWS rows at a time, until a read builds one or none is left. A row passed over (a held run built within its
    // rebuild time, a run whose view failed to build and waits for its retry, one written meanwhile) stays behind, so
    // the next read starts after every row passed over so far: such rows never hold up the rows after them.
    let count = 0;
    let passed = 0;
    for (;;) {
      const rows = await store.runs.behind({ limit: PASS_ROWS, offset: passed });
      for (const { id, mark, held } of rows) {
        if (closing) break;
        const last = built.get(id);
        if ((held && last && now() - last.at < Math.max(HELD_REBUILD_MS, 4 * last.ms)) || (failed.get(id) ?? -Infinity) > now() - LISTING_RETRY_MS) {
          passed++;
          continue;
        }
        const start = now();
        let listing: RunListing | undefined;
        let written: boolean;
        try {
          ({ listing, written } = await build(id, mark, deps));
          failed.delete(id);
        } catch (error) {
          failed.set(id, now());
          say("run_listing_unbuilt", error);
          passed++;
          continue;
        }
        if (!written) passed++;
        if (!listing) continue;
        count++;
        if (held) built.set(id, { at: now(), ms: now() - start });
        else built.delete(id);
      }
      if (closing || count > 0 || rows.length < PASS_ROWS) return count;
    }
  }

  /** A pass after the one under way: one at a time, whoever asks. */
  const turn = (): Promise<number> => (pass = pass.then(() => (closing ? 0 : once())).catch((error: unknown) => (say("run_listing_unbuilt", error), 0)));
  function next(delay: number): void {
    if (closing || !Number.isFinite(idleMs)) return;
    timer = setTimeout(() => void turn().then((count) => next(count > 0 ? 0 : idleMs)), delay);
    timer.unref();
  }

  return {
    start() {
      next(0);
    },
    build,
    async settled() {
      while ((await turn()) > 0);
    },
    async keysChanged() {
      await store.runs.relist({ flags: LISTING_KEYED });
    },
    async learningChanged(agentId) {
      await store.runs.relist({ flags: LISTING_HELD, agentId });
    },
    async stop() {
      closing = true;
      clearTimeout(timer);
      await pass;
    },
  };
}
