// Every session under a home, as totals: what each used, its subagents' requests with it, and what it cost. A session is
// one per source and id, however many files write it (a Codex thread resumed in a new file, a Claude Code session copied
// into a resumed one's); a subagent's is no session of its own but its parent's. A request another source's session also
// holds (an OpenCode claude-agent request, which Claude Code writes too: its `mirrors`) is that session's, when the same
// call reads it, and counts once there.
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { relative, sep } from "node:path";
import { type CalculateCost, type Catalog, builtinCatalog, loadCalculateCost, priceRequest, priceRequests, roundUsd } from "./price.js";
import { childrenOf, inOrder, type Readers, readerOf, sessionLocators } from "./read.js";
import { type Env, type Locator, locatorKey, type SessionRead } from "./reader.js";
import { READERS, SOURCES, type Source } from "./readers/index.js";
import { addRequest, atOf, type Counts, counts as noCounts, HAS_LONG, HAS_REASONING, HAS_USAGE, STRIDE, trimmed } from "./counts.js";
import { OLD_MB, type PoolRead, ReadPool, readAheadBytes } from "./pool.js";
import { addAll, addRecord, dropOwner, locatorNumber, ownAll, ownerOf, type RecordIndex, recordIndex, someRecord } from "./record-index.js";
import { type Packed, packed, packInto } from "./record-key.js";
import { mirroredIn, sessionKey } from "./mirror.js";
import type { Mirror, Usage } from "./types.js";
import { addTokens, noTokens, type Tokens } from "./usage.js";

export type SessionTotals = {
  /** The sha256 (hex) of the session's first file's path relative to the home, with "/" between its parts, and
   *  `#<session id>` after it for a file that holds many sessions (its locator names the id). */
  key: string;
  /** That path. */
  file: string;
  source: string;
  /** The source's own id for the session. */
  id: string;
  /** Its requests' tokens, its subagents' with them. */
  tokens: Tokens;
  /** Of `tokens.output`, the part spent reasoning, where the source says (0 where it does not). */
  reasoning: number;
  /** USD: the source's own cost when it wrote one, else its requests' (its subagents' with them) at the catalog's list
   *  prices; null when neither is known. */
  cost: number | null;
  /** The person's turns: the session's user messages (a subagent's prompts are its parent agent's, not counted). */
  turns: number;
  /** Model requests, its subagents' with them, each once. */
  calls: number;
  /** The subagents' sessions counted in it. */
  subagents: number;
};

/** What parseHome keeps between passes, when handed one: each locator's cursor (its reader's own), the records each
 *  source has read with the locator that read each first, and which locators found a record another read first, so a
 *  second pass reads only what was written since. It holds no session text (its reads are turns: false and totals: counts,
 *  ids and paths alone, each request as its model, usage and time), so it can be kept with v8.serialize. Its contents are the
 *  package's; `read` is the last pass's bytes, `version` the shape's. A state of another version (or of none, an earlier
 *  one's) is set aside, and every source read again from its start. */
export type HomeState = { version?: number; read?: number; sources?: Partial<Record<string, SourceState>> };

/** The shape of the HomeState this version keeps: a state of any other is set aside. */
const STATE_VERSION = 1;

/** One source's part of a HomeState. */
type SourceState = {
  cursors: Map<string, unknown>;
  /** Each record read (the reader's "u:"/"m:" keys, packed: packInto), with the locator (locatorKey) that read it first: the one it counts in. */
  owners: RecordIndex;
  /** For each locator, the locators whose records it found already read (its copies' owners). */
  copied: Map<string, Set<string>>;
};

export type ParseOptions = {
  /** The sources to read (default: every registered one). */
  sources?: readonly (Source | (string & {}))[];
  /** The readers to read them with (default: the registry's). */
  readers?: Readers;
  /** Kept across calls: a pass goes on from where the last one stopped (see HomeState). */
  state?: HomeState;
  /** The catalog to price requests with; false prices none (cost is then the source's own or null). Default: pi-ai's. */
  catalog?: Catalog | false;
  /** pi-ai's calculateCost, when the caller imported pi-ai itself (the CLI); else priceRequests loads it. */
  calculateCost?: CalculateCost;
  /** Where the readers look for a source's own directory (CLAUDE_CONFIG_DIR, CODEX_HOME). Default: none, the home's. */
  env?: Env;
  /** Where each locator its reader could not read goes (unopenable, an I/O error midway); the rest are totalled. Without
   *  it, parseHome throws ReadFailures instead: an unreadable file is never taken for an empty one. */
  failures?: ReadFailure[];
  /** Called with each session as it is totalled: its totals, and its requests (its subagents' with them, each once) with
   *  their times and models, text-free as the totals are. `started`: the time (ms) of the first request of the session's
   *  own files (not its subagents'), absent when it has none. For a caller that buckets the same numbers (wrapped.ts). */
  requests?: (totals: SessionTotals, requests: readonly SessionRequest[], started: number | undefined) => void;
  /** Threads that read the sources' files ahead, largest first, without a state and with the registry's readers (default:
   *  the cores this process may run on, at most 8: past that the largest files set the time, and each worker costs its
   *  heap). Each read is kept only when it is the one parseHome would make in order; 1 reads every file in order on this
   *  thread. At most MOST_THREADS (64). */
  threads?: number;
  /** With threads, a cap on the bytes of finished reads made ahead of the one being taken that may wait (default
   *  readAheadBytes(): 1 GiB, or a sixteenth of the machine's memory when less); at it, the threads read only the file
   *  being taken. Large files (BIG_FILE, 64 MiB, and over) are read first, the rest in the import's order. More holds
   *  more memory and waits less behind a large file. A cap on finished reads waiting, plus at most one read in flight
   *  per thread; not on the process's memory. */
  readAhead?: number;
  /** With threads, each worker's old generation in MB (default OLD_MB, 64). A worker that runs out of it gives its file
   *  back, which is read on this thread, and another takes its place; past 2 x threads such losses the rest is read here. */
  workerOldMb?: number;
};

/** One model request of a session: when (ms), by which model ("provider/model", the session's when the request names none),
 *  and its tokens where the source counted them. */
export type SessionRequest = { at: number; model?: string; usage?: Usage };

/** A locator its reader could not read: its key (as SessionTotals'), its file, and the reader's error. */
export type ReadFailure = { key: string; file: string; source: string; error: unknown };

/** What parseHome throws when a locator could not be read and the caller took no failures list. Its message names no
 *  path; `failures` holds them. */
export class ReadFailures extends Error {
  constructor(readonly failures: ReadFailure[]) {
    super(`${failures.length} session ${failures.length === 1 ? "file" : "files"} could not be read`);
    this.name = "ReadFailures";
  }
}

/** A session's key: the sha256 of its file's path relative to the home, "/" between its parts, `#<id>` after it when its
 *  locator names one. */
export const keyOf = (home: string, { file, id }: Locator): { key: string; file: string } => {
  const path = relative(home, file).split(sep).join("/");
  return { key: createHash("sha256").update(id === undefined ? path : `${path}#${id}`).digest("hex"), file: path };
};

/** What a total takes of one session a read found, and no more: its session's counts and ids, and each request's model
 *  and tokens, packed. A whole SessionRead holds every request as objects (its calls, uuids, key, effort); a source of
 *  millions of requests held so until its totals are taken outgrows the heap. */
type Meta = Pick<SessionRead["session"], "id" | "child" | "parent" | "users" | "copies" | "costUsd" | "model">;
type Unpriced = {
  session: Meta;
  /** Its requests as a totals read counts them (Counts: each one's model, usage and time, in Counts' stride), trimmed to
   *  them. A request names no model of its own when counts.model[i] is -1: it is the session's. */
  counts: Counts;
  /** Only where a request names another source's session that holds it too (OpenCode's claude-agent turns): each
   *  request's Mirror, and the cost it wrote (NaN for none), so the totals can leave the mirrored ones out (mirror.ts). */
  mirrors?: { of: (Mirror | undefined)[]; cost: Float64Array };
};

/** A part once its requests are priced, as they are read when the prices are in hand: their tokens summed (exact: whole
 *  counts, the source's sums at most 2^53 - 1), and each request's cost, unrounded, to be summed in the totals' order.
 *  Without a requests sink a part is kept so: 8 bytes a request, not the request's model, tokens and time. */
type Counted = {
  session: Meta;
  /** Its requests. */
  n: number;
  /** input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning: its requests' sums. */
  tokens: Float64Array;
  /** Each request's cost (0 for one of no tokens); undefined when there are no prices (no catalog, or no pi-ai). */
  costs: Float64Array | undefined;
  /** Whether a request could not be priced: its tokens unknown, or its model listed nowhere. */
  unpriceable: boolean;
};

type Compact = Unpriced | Counted;
export const requestsOf = (read: Compact): number => ("n" in read ? read.n : read.counts.n);

/** The prices requests are taken at, loaded once one is needed, as the totals would: the catalog, and pi-ai's
 *  calculateCost when the catalog is there. `ready` once both are as they will be. */
export type Pricer = { ready: boolean; catalog?: Catalog | undefined; calculate?: CalculateCost | undefined; load: () => Promise<void> };

/** Tokens summed as reads come cannot round: thrown when a count is not a whole number of at most 2^53 - 1 or a source's
 *  sum would pass it, and the source is read again with each request's tokens kept. */
class Inexact extends Error {}

/** The default threads' ceiling (ParseOptions.threads). */
const MAX_THREADS = 8;

/** The most threads parseHome takes: each is a worker with a heap of its own, and past the cores the largest files set
 *  the time anyway. More is refused before any worker starts. */
export const MOST_THREADS = 64;

/** `read` as a total takes it (Unpriced): its session's counts and ids, and its requests as Counts. A totals read's
 *  counts are kept as read; a reader with no totals read gives its requests whole, and they are counted the same way. */
function compact(read: SessionRead): Unpriced {
  const { id, child, parent, users, copies, costUsd, model } = read.session;
  const session: Meta = { id, child, users, copies, ...(parent !== undefined ? { parent } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(model !== undefined ? { model } : {}) };
  if (read.counts) return { session, counts: trimmed(read.counts) };
  const counts = noCounts();
  for (const request of read.requests) addRequest(counts, request.model, request.usage, request.at);
  const out: Unpriced = { session, counts: trimmed(counts) };
  if (read.requests.some((request) => request.mirrors !== undefined)) out.mirrors = { of: read.requests.map((request) => request.mirrors), cost: Float64Array.from(read.requests, (request) => request.costUsd ?? Number.NaN) };
  return out;
}

/** The i-th request of `read` as priceRequests and the requests sink take it. */
function requestAt({ session, counts }: Unpriced, i: number): SessionRequest {
  // Its own model, else the session's.
  const model = counts.models[counts.model[i]!] ?? session.model;
  const request: SessionRequest = { at: atOf(counts, i), ...(model !== undefined ? { model } : {}) };
  const has = counts.has[i]!;
  if (!(has & HAS_USAGE)) return request;
  const { values } = counts;
  const o = i * STRIDE;
  const usage: Usage = { input: values[o]!, output: values[o + 1]!, cacheRead: values[o + 2]!, cacheWrite: values[o + 3]! };
  if (has & HAS_LONG) usage.cacheWrite1h = values[o + 4]!;
  if (has & HAS_REASONING) usage.reasoning = values[o + 5]!;
  return { ...request, usage };
}

/** Each request of a part read whole (readSource's `whole`), as the sink takes it: a part priced as read keeps none. */
export function* requestsIn(read: Compact): Generator<SessionRequest> {
  if ("n" in read) throw new Error("a part priced as read keeps no requests");
  for (let i = 0; i < read.counts.n; i += 1) yield requestAt(read, i);
}

const TOKEN_FIELDS = 6;

/** `read` priced (Counted), its tokens added to `sums` (the source's so far). */
function counted(read: Unpriced, pricer: Pricer, sums: Float64Array): Counted {
  const { n } = read.counts;
  const tokens = new Float64Array(TOKEN_FIELDS);
  const { catalog, calculate } = pricer;
  const costs = catalog && calculate ? new Float64Array(n) : undefined;
  let unpriceable = false;
  for (let i = 0; i < n; i += 1) {
    const request = requestAt(read, i);
    const { usage } = request;
    if (usage) {
      const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cacheWrite1h ?? 0, usage.reasoning ?? 0];
      for (let k = 0; k < TOKEN_FIELDS; k += 1) {
        const count = counts[k]!;
        if (!Number.isSafeInteger(count) || count < 0) throw new Inexact();
        tokens[k]! += count;
      }
    }
    if (costs && !unpriceable) {
      const usd = priceRequest(request, catalog!, calculate!);
      if (usd === undefined) unpriceable = true;
      else costs[i] = usd;
    }
  }
  for (let k = 0; k < TOKEN_FIELDS; k += 1) if ((sums[k]! += tokens[k]!) > Number.MAX_SAFE_INTEGER) throw new Inexact();
  return { session: read.session, n, tokens, costs, unpriceable };
}

type Part = { locator: Locator; read: Compact };

/** A session's cost with its subagents': Claude Code's written cost holds its subagents' already (its cost-state), so it
 *  stays as it is; every other source writes a subagent's cost on the subagent's own session, so each is added. Unknown
 *  when the session's is, or when one it adds is: never a subagent counted at 0. parseHome's totals and serve's import. */
export function withSubagentCosts(source: string, cost: number | undefined, subagents: readonly (number | undefined)[]): number | undefined {
  if (source === "claude-code" || cost === undefined) return cost;
  return subagents.reduce<number | undefined>((sum, usd) => (sum === undefined || usd === undefined ? undefined : sum + usd), cost);
}

/** A part with its own requests alone (none another session of the call holds) and the cost it wrote of them: its own
 *  when it holds none of another's, else its own requests' when each that used tokens is priced (mirror.ts ownRequests,
 *  over the packed requests). Counted when `unpriced` is false and the prices are in hand (a part whose requests mirror
 *  another's is kept Unpriced until the call knows which sessions it read). */
function ownPart(read: Compact, mirrored: (request: { mirrors?: Mirror }) => boolean, pricer: Pricer, unpriced: boolean): Compact {
  if ("n" in read || !read.mirrors) return read;
  const marks = read.mirrors;
  const { counts } = read;
  const at = Array.from({ length: counts.n }, (_, i) => i).filter((i) => !mirrored({ mirrors: marks.of[i] }));
  let own: Unpriced = read;
  if (at.length !== counts.n) {
    const priced = at.every((i) => !Number.isNaN(marks.cost[i]!) || !(counts.has[i]! & HAS_USAGE));
    const costUsd = priced ? at.reduce((n, i) => n + (Number.isNaN(marks.cost[i]!) ? 0 : marks.cost[i]!), 0) : undefined;
    const { costUsd: _, ...session } = read.session;
    // Its own requests' rows of Counts (each STRIDE numbers: usage and time), their model indexes and HAS_* bits.
    const values = new Float64Array(at.length * STRIDE);
    for (const [k, i] of at.entries()) values.set(counts.values.subarray(i * STRIDE, (i + 1) * STRIDE), k * STRIDE);
    own = {
      session: { ...session, ...(costUsd !== undefined ? { costUsd } : {}) },
      counts: { n: at.length, models: counts.models, model: Int32Array.from(at, (i) => counts.model[i]!), values, has: Uint8Array.from(at, (i) => counts.has[i]!) },
    };
  }
  return unpriced || !pricer.ready ? own : counted(own, pricer, new Float64Array(TOKEN_FIELDS));
}

/** Every session of `sources` under `home`, as totals, sorted by key. */
export async function parseHome(home: string, { sources = SOURCES, readers = READERS, state, catalog, calculateCost, env, failures, requests, threads = Math.min(availableParallelism(), MAX_THREADS), readAhead = readAheadBytes(), workerOldMb = OLD_MB }: ParseOptions = {}): Promise<SessionTotals[]> {
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > MOST_THREADS) throw new RangeError(`threads: a whole number from 1 to ${MOST_THREADS}, not ${threads}`);
  if (!(readAhead >= 0)) throw new RangeError(`readAhead: a number of bytes, 0 or more, not ${readAhead}`);
  if (!Number.isSafeInteger(workerOldMb) || workerOldMb < 1) throw new RangeError(`workerOldMb: a whole number of MB, at least 1, not ${workerOldMb}`);
  const pool = !state && readers === READERS && threads > 1 ? new ReadPool(threads, readAhead, workerOldMb) : undefined;
  try {
  let prices: Promise<Catalog | undefined> | undefined;
  const priceWith = () => (catalog === false ? Promise.resolve(undefined) : catalog ? Promise.resolve(catalog) : (prices ??= builtinCatalog()));
  const out: SessionTotals[] = [];
  const failed: ReadFailure[] = [];
  if (state) {
    if (state.version !== STATE_VERSION) {
      state.version = STATE_VERSION;
      state.sources = {};
    }
    state.read = 0;
  }
  // Requests are priced as they are read once the prices are in hand: at once when the caller handed them in (or none),
  // else loaded when a session is read that the totals will price, as they would load them. A requests sink takes each
  // request with its time, so with one every part keeps its requests (Unpriced) to the totals.
  const pricer: Pricer = {
    ready: catalog === false || (catalog !== undefined && calculateCost !== undefined),
    ...(catalog ? { catalog } : {}),
    ...(catalog && calculateCost ? { calculate: calculateCost } : {}),
    async load() {
      if (this.ready) return;
      this.catalog = await priceWith();
      this.calculate = this.catalog ? (calculateCost ?? (await loadCalculateCost())) : undefined;
      this.ready = true;
    },
  };
  const whole = requests !== undefined;
  // With a pool, every source is listed first and all their files queued at once, in the import's order: a source's last
  // files then share the threads with the next source's, and the largest files of every source are read first (pool.ts).
  const ahead = new Map<string, Listing>();
  if (pool) {
    for (const source of sources) ahead.set(source, await listSource(home, source, readers, env, true));
    const items = [...ahead].flatMap(([source, { listed, childList }]) => [...listed.map(({ locator, stats }) => ({ source, locator, size: stats.size })), ...childList.map(({ locator, size }) => ({ source, locator, size }))]);
    const ids = pool.readAll(items);
    let at = 0;
    for (const listing of ahead.values()) {
      listing.ids = ids.slice(at, (at += listing.listed.length + listing.childList.length));
      listing.reads = listing.ids.map((id) => () => pool.take(id));
    }
  }
  // Every session this call read, by source and id, and the sources held to be totalled after the rest.
  const readKeys = new Set<string>();
  const mirroring: { source: string; read: { tops: Part[]; children: (Part & { of: Locator })[] } }[] = [];
  for (const source of sources) {
    let read;
    try {
      read = await readSource(home, source, readers, env, state, pricer, whole, ahead.get(source));
    } catch (error) {
      if (!(error instanceof Inexact)) throw error;
      // Tokens that cannot be summed as read: the source again, each request's tokens kept to the totals.
      if (state) (state.sources ??= {})[source] = undefined;
      // The pool's reads of this source left untaken would hold the read-ahead for nothing.
      pool?.drop(ahead.get(source)?.ids ?? []);
      read = await readSource(home, source, readers, env, state, pricer, true);
    }
    const { tops, children, unread } = read;
    for (const part of [...tops, ...children]) readKeys.add(sessionKey(source, part.read.session.id));
    // A source whose requests mirror another's (OpenCode's claude-agent ones) is totalled once every source is read: a
    // mirrored request counts in the session it mirrors when this call reads that one too.
    if ([...tops, ...children].some(({ read }) => "mirrors" in read && read.mirrors)) mirroring.push({ source, read });
    else out.push(...(await totalsOf(home, source, tops, children, pricer, priceWith, calculateCost, requests)));
    failed.push(...unread.map(({ locator, error }) => ({ key: keyOf(home, locator).key, file: locator.file, source, error })));
  }
  // A request that mirrors a session this call read is counted in it, not again: each part keeps its own requests alone.
  const mirrored = mirroredIn(readKeys);
  for (const held of mirroring) {
    const { source } = held;
    let { read } = held;
    const own = (all: boolean) => {
      for (const part of [...read.tops, ...read.children]) part.read = ownPart(part.read, mirrored, pricer, all);
    };
    try {
      // Priced as the source's other parts are: Counted when one is (the prices came in while it was read), else Unpriced.
      own(whole || ![...read.tops, ...read.children].some((part) => "n" in part.read));
    } catch (error) {
      if (!(error instanceof Inexact)) throw error;
      // As a source read above: again, each request's tokens kept to the totals.
      if (state) (state.sources ??= {})[source] = undefined;
      read = await readSource(home, source, readers, env, state, pricer, true);
      own(true);
    }
    out.push(...(await totalsOf(home, source, read.tops, read.children, pricer, priceWith, calculateCost, requests)));
  }
  if (failed.length && !failures) throw new ReadFailures(failed);
  failures?.push(...failed);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } finally {
    pool?.close();
  }
}

/** What a pass that reads chains (the cache analyzer's) does with each session read, as it is read: it returns what of
 *  it the pass keeps (a whole home's turns would not fit). */
export type Each = (read: SessionRead) => Promise<SessionRead>;

/** A source's locators in the import's order, its subagents' with their sizes, and (with a pool) how to take each one's read. */
type Listing = { listed: { locator: Locator; stats: Stats }[]; childList: { locator: Locator; of: Locator; size: number }[]; reads?: (() => Promise<PoolRead>)[]; ids?: number[] };

async function listSource(home: string, source: string, readers: Readers, env: Env | undefined, sized = false): Promise<Listing> {
  const listed = await inOrder(await sessionLocators(home, source, { ...(env ? { env } : {}), readers }), source, readers);
  const children = await childrenOf(home, source, { ...(env ? { env } : {}), readers });
  const childList = await Promise.all(children.map(async (child) => ({ ...child, size: sized ? ((await stat(child.locator.file).catch(() => undefined))?.size ?? 0) : 0 })));
  return { listed, childList };
}

/** `source`'s locators read in the import's order, sessions first, then the subagents beside them, through one `seen`.
 *  A pass handed a state goes on from its cursors, and comes out as a fresh pass would: a record copied into many files
 *  counts in the first of them in the order as it is now. The whole source is read again when a locator it read before is
 *  gone, when its reader could not go on from its cursor (a new inode, truncated, rewritten), or when a locator holding a
 *  copy now comes before the one its record counts in (an append moved an older file after its resumed copy, a new file
 *  sorts before one it shares records with). A change of order among locators that share no record reads nothing again.
 *  With `each` (Each), each file is read with its chain and its turns, never through the pool, and the part keeps what
 *  `each` returns. */
export async function readSource(home: string, source: string, readers: Readers, env: Env | undefined, state: HomeState | undefined, pricer: Pricer, whole: boolean, listing?: Listing, each?: Each): Promise<{ tops: Part[]; children: (Part & { of: Locator })[]; unread: { locator: Locator; error: unknown }[] }> {
  const reader = readerOf(source, readers);
  // The pool's listing, when parseHome read this source ahead (pool.ts); each read is taken below in order, or made again.
  const { listed, childList, reads: ahead } = listing ?? (await listSource(home, source, readers, env));
  // Each locator's place in this pass's order of reading.
  const place = new Map([...listed.map(({ locator }) => locatorKey(locator)), ...childList.map(({ locator }) => locatorKey(locator))].map((key, at) => [key, at]));
  // Whether a locator holds a copy of a record that now counts after it: the fresh pass would count it in that locator.
  const outOfOrder = (kept: SourceState) => [...kept.copied].some(([key, owners]) => [...owners].some((owner) => place.get(owner)! > place.get(key)!));
  for (let pass = 0; ; pass += 1) {
    let kept = state ? (state.sources ??= {})[source] : undefined;
    // A source's state whose files changed so (a locator gone, a copy now before its record's) is set aside: the source is
    // read from its start and its state rebuilt.
    if (kept && ([...kept.cursors.keys()].some((key) => !place.has(key)) || outOfOrder(kept))) kept = undefined;
    // A pass from nothing is the last: only its sessions may load the prices (one resumed may be read again).
    const fresh = !kept || kept.cursors.size === 0;
    if (state && !kept) kept = state.sources![source] = { cursors: new Map(), owners: recordIndex(), copied: new Map() };
    const { owners, copied } = kept ?? { owners: recordIndex(), copied: new Map<string, Set<string>>() };
    let restarted = false;
    const unread: { locator: Locator; error: unknown }[] = [];
    const read = async (locator: Locator, pooled?: () => Promise<PoolRead>): Promise<SessionRead[]> => {
      const key = locatorKey(locator);
      const cursor = kept?.cursors.get(key);
      // The records read so far, as the reader asks for them, each new one this locator's, each found one noted. Both are
      // staged and kept only when the read succeeds: a read that fails partway leaves no record owned that no cursor
      // holds, which a retry would take for a copy.
      // Records are held by their packed keys (packInto), each packed as it is asked for.
      const me = locatorNumber(owners, key);
      const mine = recordIndex(64);
      const found = new Set<string>();
      const at = packed();
      const seen = {
        has: (record: string) => {
          packInto(record, at);
          let owner = ownerOf(owners, at);
          if (owner === -1) owner = ownerOf(mine, at);
          if (owner === -1) return false;
          if (owner !== me) found.add(owners.locators[owner]!);
          return true;
        },
        add(record: string) {
          packInto(record, at);
          if (ownerOf(owners, at) === -1) addRecord(mine, at, me);
          return this;
        },
      } as Set<string>;
      if (pooled) {
        // The pool's read is this one when none of the records it added, or asked for and did not hold, is one read before it.
        const made = await pooled();
        const held = (record: Packed) => ownerOf(owners, record) !== -1;
        if (made.ok && !someRecord(made.mine, held) && !someRecord(made.missed, held)) {
          ownAll(made.mine, me);
          addAll(owners, made.mine);
          return made.sessions;
        }
      }
      const result = await reader.read(locator, cursor, each ? { seen, chain: true } : { turns: false, totals: true, seen }).catch((error: unknown) => void unread.push({ locator, error }));
      if (!result) {
        // A locator read before that cannot be read now gives up its cursor and the records it held, as a fresh pass
        // would hold none of them: the next pass reads it from its start. A locator that found them already read (a
        // copy) skipped them, though the fresh pass counts them there: the source is read again.
        if (kept && cursor !== undefined) {
          kept.cursors.delete(key);
          dropOwner(owners, me);
          copied.delete(key);
          if ([...copied.values()].some((owners) => owners.has(key))) restarted = true;
        }
        return [];
      }
      addAll(owners, mine);
      if (found.size) for (const owner of found) (copied.get(key) ?? copied.set(key, new Set()).get(key)!).add(owner);
      if (cursor !== undefined && !result.resumed) restarted = true;
      if (state) state.read! += result.read;
      kept?.cursors.set(key, result.cursor);
      return each ? Promise.all(result.sessions.map(each)) : result.sessions;
    };
    const tops: Part[] = [];
    const children: (Part & { of: Locator })[] = [];
    const sums = new Float64Array(TOKEN_FIELDS);
    // Each locator's sessions packed as soon as they are read. A totals read gives each request's counts alone, and its
    // cursor, kept in a state between passes, holds those too: no request is held as an object, by a pass or a state. A
    // reader with no totals read gives its requests whole: only one locator's are held so at a time. Without a requests
    // sink each part is priced once the prices are in hand. A session's own file that wrote no cost and is no file of
    // copies alone is one the totals price: the prices are loaded then, and the parts read so far priced.
    const pack = async (session: SessionRead, top: boolean): Promise<Compact> => {
      const unpriced = compact(session);
      // A part whose requests mirror another's stays Unpriced: its own are known once every source is read (ownPart).
      if (whole || unpriced.mirrors) return unpriced;
      const { child, parent, costUsd, copies, users } = session.session;
      if (!pricer.ready && fresh && top && !(child && parent) && costUsd === undefined && !(copies > 0 && users === 0 && (session.counts?.n ?? session.requests.length) === 0)) {
        await pricer.load();
        for (const part of [...tops, ...children]) if (!("n" in part.read) && !part.read.mirrors) part.read = counted(part.read, pricer, sums);
      }
      return pricer.ready ? counted(unpriced, pricer, sums) : unpriced;
    };
    for (const [i, { locator }] of listed.entries()) for (const session of await read(locator, pass === 0 ? ahead?.[i] : undefined)) tops.push({ locator: session.locator, read: await pack(session, true) });
    for (const [i, { locator, of }] of childList.entries()) for (const session of await read(locator, pass === 0 ? ahead?.[listed.length + i] : undefined)) children.push({ locator: session.locator, read: await pack(session, false), of });
    // A locator its reader could not go on in, or a copy this pass found whose record counts after it: read the source
    // again, from nothing.
    if (pass > 0 || !kept || !(restarted || outOfOrder(kept))) return { tops, children, unread };
    state!.sources![source] = undefined;
  }
}

/** A source's sessions: each with its files (`parts`, in the import's order) and its subagents' (`children`); `untied`, a
 *  subagent's whose session is not under the home, a session of its own. A session whose every file holds only records
 *  an earlier file holds (copies) is none: its records count where they were first read. serve's import leaves such a
 *  file out the same way. */
export function groupsOf(tops: Part[], children: (Part & { of: Locator })[]): { parts: Part[]; children: Part[]; untied?: true }[] {
  // Sessions by id, their locators in the import's order; one naming its parent (a Codex subagent's thread) is the
  // parent's, as is each one beside a session's (Claude Code's subagents).
  const sessions = new Map<string, { parts: Part[]; children: Part[]; untied?: true }>();
  const named: { part: Part; parent: string }[] = [];
  for (const part of tops) {
    const { session } = part.read;
    if (session.child && session.parent) {
      named.push({ part, parent: session.parent });
      continue;
    }
    const held = sessions.get(session.id) ?? sessions.set(session.id, { parts: [], children: [] }).get(session.id)!;
    held.parts.push(part);
  }
  const byLocator = new Map(tops.map((part) => [locatorKey(part.locator), part.read.session.id]));
  const untied: Part[] = [];
  for (const child of children) {
    const id = byLocator.get(locatorKey(child.of));
    const held = id !== undefined ? sessions.get(id) : undefined;
    if (held) held.children.push(child);
    else untied.push(child);
  }
  // A thread's parent is a session, or another thread that names its own parent: up the chain to the session.
  const parentOf = new Map(named.map(({ part, parent }) => [part.read.session.id, parent]));
  for (const { part, parent } of named) {
    let at: string | undefined = parent;
    const visited = new Set<string>();
    while (at !== undefined && !sessions.has(at) && !visited.has(at)) {
      visited.add(at);
      at = parentOf.get(at);
    }
    const held = at !== undefined ? sessions.get(at) : undefined;
    if (held) held.children.push(part);
    else untied.push(part);
  }
  // A subagent whose session is not under the home: a line of its own, but its prompts are its parent agent's.
  for (const part of untied) sessions.set(`\0${locatorKey(part.locator)}`, { parts: [part], children: [], untied: true });
  return [...sessions.values()].filter(({ parts, children }) => !(parts.every(({ read }) => read.session.copies > 0 && read.session.users === 0 && requestsOf(read) === 0) && children.length === 0));
}

async function totalsOf(home: string, source: string, tops: Part[], children: (Part & { of: Locator })[], pricer: Pricer, priceWith: () => Promise<Catalog | undefined>, calculateCost: CalculateCost | undefined, sink?: ParseOptions["requests"]): Promise<SessionTotals[]> {
  const out: SessionTotals[] = [];
  for (const { parts, children: subagents, untied } of groupsOf(tops, children)) {
    const first = parts[0]!;
    const tokens = noTokens();
    let reasoning = 0;
    let calls = 0;
    // Parts priced as read (Counted) or not (Unpriced): a source's are all one or all the other, and all Unpriced with a sink.
    const all = [...parts, ...subagents].map(({ read }) => read);
    const priced = all.filter((read): read is Counted => "n" in read);
    if (priced.length && (priced.length !== all.length || sink)) throw new Error("parts priced and not in one session");
    const requests: SessionRequest[] = [];
    if (priced.length) {
      // Whole counts summed below 2^53: the same sums in any order.
      for (const read of priced) {
        calls += read.n;
        tokens.input += read.tokens[0]!;
        tokens.output += read.tokens[1]!;
        tokens.cacheRead += read.tokens[2]!;
        tokens.cacheWrite += read.tokens[3]!;
        tokens.cacheWrite1h += read.tokens[4]!;
        reasoning += read.tokens[5]!;
      }
    } else {
      for (const read of all as Unpriced[]) for (let i = 0; i < read.counts.n; i += 1) requests.push(requestAt(read, i));
      for (const { usage } of requests) {
        calls += 1;
        if (!usage) continue;
        addTokens(tokens, usage);
        reasoning += usage.reasoning ?? 0;
      }
    }
    // The source's own cost, when each of its files wrote one: Claude Code writes the session's running total, its
    // subagents' with it (a moved session's copy goes on from the original's), so the highest; another source prices each
    // request, so the sum of its files' and its subagents' (OpenCode's subagent is a session of its own).
    const written = parts.map(({ read }) => read.session.costUsd);
    const files = written.some((usd) => usd === undefined) ? undefined : source === "claude-code" ? Math.max(...(written as number[])) : (written as number[]).reduce((n, usd) => n + usd, 0);
    let cost = withSubagentCosts(source, files, subagents.map(({ read }) => read.session.costUsd));
    if (cost === undefined && priced.length) {
      // Each request's cost as priced when read, summed in the order priceRequests sums them.
      if (pricer.catalog && pricer.calculate && !priced.some(({ unpriceable }) => unpriceable)) {
        let total = 0;
        for (const { costs, n } of priced) for (let i = 0; i < n; i += 1) total += costs![i]!;
        cost = roundUsd(total);
      }
    } else if (cost === undefined) {
      const catalog = await priceWith();
      cost = catalog ? await priceRequests(requests, catalog, calculateCost) : undefined;
    }
    const { key, file } = keyOf(home, first.locator);
    const totals: SessionTotals = {
      key,
      file,
      source,
      id: first.read.session.id,
      tokens,
      reasoning,
      cost: cost ?? null,
      // A subagent's session counted on its own line (its parent not under the home, or named nowhere: Codex's
      // source.subagent alone, a Claude Code sidechain file): its prompts are its parent agent's, as serve takes it.
      turns: untied || parts.every(({ read }) => read.session.child) ? 0 : parts.reduce((n, { read }) => n + read.session.users, 0),
      calls,
      subagents: subagents.length,
    };
    out.push(totals);
    if (sink) {
      // The session's first time: the least finite one of its own files' requests (Unpriced, as every part is with a
      // sink), read where they are held.
      let started: number | undefined;
      for (const { read } of parts as { read: Unpriced }[])
        for (let i = 0; i < read.counts.n; i += 1) {
          const at = atOf(read.counts, i);
          if (Number.isFinite(at) && (started === undefined || at < started)) started = at;
        }
      sink(totals, requests, started);
    }
  }
  return out;
}
