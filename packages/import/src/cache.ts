// The cache analyzer: a session's cache hit rate, and each turn whose cache read dropped more than 80% against the turn
// before it (a break), with the tokens it paid for again, what that cost, and the cause its transcript shows. It reads
// the session's chain (ChainRecord: ids, parents and hashes, never text), so it hands back numbers and cause names only.
import { groupsOf, keyOf, ReadFailures, readSource, type ParseOptions } from "./home.js";
import { type CalculateCost, type Catalog, builtinCatalog, priceRequests } from "./price.js";
import { locatorKey, type SessionRead } from "./reader.js";
import { READERS, SOURCES } from "./readers/index.js";
import type { Answer, ChainRecord, SessionOf, Usage } from "./types.js";

/** The causes of a break, in the order they are tried: the first the transcript shows evidence of is the break's. */
export const CACHE_CAUSES = ["model", "idle", "compaction", "edited", "sidechain", "unknown"] as const;
export type CacheCause = (typeof CACHE_CAUSES)[number];

/** A break is a drop of more than this part of the turn before's cache read. */
export const BREAK_DROP = 0.8;
/** How long a cache lives unread: 5 minutes, or an hour where it was written for one (Anthropic's 1h cache). */
export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_TTL_LONG_MS = 60 * 60_000;

/** One break. `turn`: the request's number among the session's assistant turns, from 1 (the first is never a break);
 *  `at`: its time (ms since the epoch); `dropPct`: how much of the turn before's cache read it lost, in percent;
 *  `rewritten`: the tokens of the read lost that it paid for again, as a cache write or uncached input; `extraCost`: USD,
 *  what those cost above reading them from the cache, at the request's model's list prices (null when unpriced);
 *  `diverged`: for an edit, the index of the first message where its prompt and the turn before's differ. */
export type CacheBreak = { turn: number; at: number; dropPct: number; rewritten: number; extraCost: number | null; cause: CacheCause; diverged?: number };

/** `hitRate`: the cache read over the whole prompt (input, cache read and write), null for a session that sent none.
 *  `last`: the last turn compared, to carry into the session's next file (CacheOptions.before). */
export type CacheReport = { hitRate: number | null; breaks: CacheBreak[]; last?: CacheCarry };

/** The turn a file of a session ended on, which the session's next file compares its first turn with: its model, its
 *  time, its usage, and whether the latest cache write by then was a 1h one. */
export type CacheCarry = { model?: string; at: number; usage: Usage; long: boolean };

export type CacheOptions = {
  /** The catalog to price with; false prices none (every extraCost null). Default: pi-ai's. */
  catalog?: Catalog | false;
  /** pi-ai's calculateCost, when the caller imported pi-ai itself; else priceRequests loads it. */
  calculateCost?: CalculateCost;
  /** The last turn of the session's file before this one (CacheReport.last): this file's first turn is compared with
   *  it, and its turns are no session's first. Absent for a session's first file. */
  before?: CacheCarry;
};

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;
const promptOf = ({ input, cacheRead, cacheWrite }: Usage): number => input + cacheRead + cacheWrite;

/** A session's cache, from a read with `chain: true` (readSession(locator, source, { chain: true })). A session read
 *  without its chain names a model change or an idle gap; its other breaks are unknown. A turn compared is a request with
 *  usage that sent a prompt (a request that failed before it sent any, or whose usage is unknown, is passed over); a
 *  break compares it with the one before it. */
export async function analyzeCache(session: Pick<SessionOf, "turns" | "chain" | "model">, { catalog, calculateCost, before: carried }: CacheOptions = {}): Promise<CacheReport> {
  const answers = session.turns.filter((turn): turn is Answer => turn.role === "assistant");
  const chain = session.chain ?? [];
  // The record that opens each request, by its index among the answers, and each record by id (the first of a repeat).
  const opens = new Map<number, number>();
  const byId = new Map<string, ChainRecord>();
  chain.forEach((record, at) => {
    if (record.request !== undefined && !opens.has(record.request)) opens.set(record.request, at);
    if (record.id !== undefined && !byId.has(record.id)) byId.set(record.id, record);
  });
  const prices = catalog === false ? undefined : (catalog ?? (await builtinCatalog()));
  let read = 0;
  let prompt = 0;
  const breaks: CacheBreak[] = [];
  // The turn before, at index -1 when it is the session's previous file's.
  let before: { index: number; answer: Pick<Answer, "model" | "at">; usage: Usage } | undefined = carried ? { index: -1, answer: { at: carried.at, ...(carried.model ? { model: carried.model } : {}) }, usage: carried.usage } : undefined;
  // Whether the latest request that wrote the cache wrote it for an hour.
  let long = carried?.long ?? false;
  for (const [index, answer] of answers.entries()) {
    const usage = answer.usage;
    if (!usage || promptOf(usage) === 0) continue;
    read += usage.cacheRead;
    prompt += promptOf(usage);
    if (before && before.usage.cacheRead > 0 && (before.usage.cacheRead - usage.cacheRead) / before.usage.cacheRead > BREAK_DROP) {
      const lost = before.usage.cacheRead - usage.cacheRead;
      const rewritten = Math.min(lost, usage.cacheWrite + usage.input);
      const { cause, diverged } = causeOf(before.index, before.answer, index, answer, { long, chain, opens, byId });
      const model = answer.model ?? session.model;
      breaks.push({
        turn: index + 1,
        at: answer.at,
        dropPct: round((lost / before.usage.cacheRead) * 100, 2),
        rewritten,
        extraCost: prices ? await extraCostOf(model, usage, rewritten, prices, calculateCost) : null,
        cause,
        ...(diverged !== undefined ? { diverged } : {}),
      });
    }
    if (usage.cacheWrite > 0) long = (usage.cacheWrite1h ?? 0) > 0;
    before = { index, answer, usage };
  }
  const last = before ? { ...(before.answer.model ?? session.model ? { model: (before.answer.model ?? session.model)! } : {}), at: before.answer.at, usage: before.usage, long } : undefined;
  return { hitRate: prompt > 0 ? round(read / prompt, 4) : null, breaks, ...(last ? { last } : {}) };
}

type Evidence = { long: boolean; chain: ChainRecord[]; opens: Map<number, number>; byId: Map<string, ChainRecord> };

/** The first cause, in CACHE_CAUSES' order, the transcript shows for the break at request `index` after `last`. */
function causeOf(lastIndex: number, last: Pick<Answer, "model" | "at">, index: number, answer: Answer, { long, chain, opens, byId }: Evidence): { cause: CacheCause; diverged?: number } {
  if (last.model && answer.model && last.model !== answer.model) return { cause: "model" };
  if (answer.at - last.at > (long ? CACHE_TTL_LONG_MS : CACHE_TTL_MS)) return { cause: "idle" };
  // The turn before in the session's previous file: a compaction this file opens with is since it; its chain is that
  // file's, so no edit or sidechain is named across the two.
  const from = lastIndex < 0 ? -1 : opens.get(lastIndex);
  const to = opens.get(index);
  if (from === undefined || to === undefined) return { cause: "unknown" };
  if (chain.slice(from + 1, to).some((record) => record.compact && !record.copy)) return { cause: "compaction" };
  if (from < 0) return { cause: "unknown" };
  const was = chain[from]!;
  const now = chain[to]!;
  // A sidechain's prompt is a conversation of its own, never an edit of the main one's.
  if (was.id !== undefined && now.id !== undefined && !was.sidechain === !now.sidechain) {
    // The turn before's prompt with its own answer, and this turn's prompt: this one should go on from all of it.
    const had = hashesTo(was.id, byId);
    const has = now.parent === undefined ? [] : hashesTo(now.parent, byId);
    let same = 0;
    while (same < had.length && same < has.length && had[same] === has[same]) same += 1;
    if (same < had.length) return { cause: "edited", diverged: same };
  }
  if (now.sidechain && !was.sidechain) return { cause: "sidechain" };
  return { cause: "unknown" };
}

/** The hashes of the chain that ends at `id`, from its root: the conversation as a request held it. */
function hashesTo(id: string, byId: Map<string, ChainRecord>): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  const visited = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !visited.has(at); ) {
    visited.add(at);
    const record = byId.get(at);
    if (!record) break;
    out.push(record.hash);
    at = record.parent;
  }
  return out.reverse();
}

/** What the request paid for `rewritten` tokens above reading them from the cache: its usage priced as it was, less as
 *  it would have been with them read (taken from its cache write first, then its uncached input; the write's 1h part in
 *  proportion). */
async function extraCostOf(model: string | undefined, usage: Usage, rewritten: number, catalog: Catalog, calculateCost: CalculateCost | undefined): Promise<number | null> {
  const fromWrite = Math.min(rewritten, usage.cacheWrite);
  const cacheWrite = usage.cacheWrite - fromWrite;
  const held: Usage = {
    ...usage,
    input: usage.input - (rewritten - fromWrite),
    cacheRead: usage.cacheRead + rewritten,
    cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite > 0 ? Math.round((usage.cacheWrite1h * cacheWrite) / usage.cacheWrite) : 0 } : {}),
  };
  const paid = await priceRequests([{ ...(model ? { model } : {}), usage }], catalog, calculateCost);
  const would = await priceRequests([{ ...(model ? { model } : {}), usage: held }], catalog, calculateCost);
  return paid === undefined || would === undefined ? null : round(paid - would, 6);
}

/** One session's cache under a home, keyed as parseHome keys its totals (`key`, `file`, `source`, `id`): `hitRate` over
 *  its requests and its subagents' (the tokens parseHome totals), and the breaks in each of its files (`turn` counted
 *  across them, in the import's order) and in each subagent's, which is a conversation of its own (`subagent`: its
 *  number among the session's, from 1; `turn` counted in it). */
export type SessionCache = { key: string; file: string; source: string; id: string; hitRate: number | null; breaks: (CacheBreak & { subagent?: number })[] };

/** Every session of `sources` under `home` with its cache (SessionCache), sorted by key: the sessions parseHome totals,
 *  each file read with its chain, and analyzed as it is read (one at a time: a whole home's turns would not fit). Its
 *  options are parseHome's but `state`: each call reads every file from its start. */
export async function cacheHome(home: string, { sources = SOURCES, readers = READERS, catalog, calculateCost, env, failures }: Omit<ParseOptions, "state"> = {}): Promise<SessionCache[]> {
  const prices = catalog === false ? false : (catalog ?? (await builtinCatalog()) ?? false);
  const priced: CacheOptions = { catalog: prices, ...(calculateCost ? { calculateCost } : {}) };
  const out: SessionCache[] = [];
  const failed: NonNullable<ParseOptions["failures"]> = [];
  for (const source of sources) {
    // Each file analyzed as it is read, on its own; and its first turn compared, with the chain before it, kept to compare
    // with the last turn of the session's file before it once the files are joined (a Codex thread goes on in a new
    // rollout).
    const reports = new Map<string, { alone: CacheReport; head?: Pick<SessionOf, "turns" | "chain" | "model">; skipped: number }>();
    const { tops, children, unread } = await readSource(home, source, readers, env, undefined, async (read): Promise<SessionRead> => {
      reports.set(locatorKey(read.locator), { alone: await analyzeCache(read.session, priced), ...headOf(read.session) });
      const { turns: _turns, chain: _chain, firstPrompt: _prompt, titleText: _title, sourceTitle: _source, cwd: _cwd, ...session } = read.session;
      return { locator: read.locator, session: { ...session, turns: [] }, requests: read.requests.map(({ at, usage }): Answer => ({ role: "assistant", text: "", calls: [], at, ...(usage ? { usage } : {}) })) };
    });
    failed.push(...unread.map(({ locator, error }) => ({ key: keyOf(home, locator).key, file: locator.file, source, error })));
    for (const { parts, children: subagents } of groupsOf(tops, children)) {
      let read = 0;
      let prompt = 0;
      for (const { usage } of [...parts, ...subagents].flatMap((part) => part.read.requests)) {
        if (!usage) continue;
        read += usage.cacheRead;
        prompt += promptOf(usage);
      }
      const breaks: SessionCache["breaks"] = [];
      // The session's files in the import's order, one conversation: each file's first turn compared with the last
      // turn before it in the files before, its turns counted on from theirs.
      let counted = 0;
      let carry: CacheCarry | undefined;
      for (const part of parts) {
        const report = reports.get(locatorKey(part.locator));
        if (!report) continue;
        if (carry && report.head) {
          const { breaks: [edge] } = await analyzeCache(report.head, { ...priced, before: carry });
          if (edge) breaks.push({ ...edge, turn: edge.turn + report.skipped + counted });
        }
        for (const found of report.alone.breaks) breaks.push({ ...found, turn: found.turn + counted });
        carry = report.alone.last ?? carry;
        counted += part.read.requests.length;
      }
      subagents.forEach((part, n) => {
        for (const found of reports.get(locatorKey(part.locator))?.alone.breaks ?? []) breaks.push({ ...found, subagent: n + 1 });
      });
      const first = parts[0]!;
      out.push({ ...keyOf(home, first.locator), source, id: first.read.session.id, hitRate: prompt > 0 ? round(read / prompt, 4) : null, breaks });
    }
  }
  if (failed.length && !failures) throw new ReadFailures(failed);
  failures?.push(...failed);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The breaks of `sessions` by cause, each cause there with 0 where none: how many, and their extra cost (USD, of the
 *  priced ones); `unpriced`, the breaks whose extra cost is unknown. */
export function cacheTotals(sessions: readonly Pick<SessionCache, "breaks">[]): { sessions: number; breaks: Record<CacheCause, number>; extraCost: Record<CacheCause, number>; unpriced: number } {
  const breaks = Object.fromEntries(CACHE_CAUSES.map((cause) => [cause, 0])) as Record<CacheCause, number>;
  const extraCost = Object.fromEntries(CACHE_CAUSES.map((cause) => [cause, 0])) as Record<CacheCause, number>;
  let unpriced = 0;
  for (const { cause, extraCost: usd } of sessions.flatMap((session) => session.breaks)) {
    breaks[cause] += 1;
    if (usd === null) unpriced += 1;
    else extraCost[cause] = round(extraCost[cause] + usd, 6);
  }
  return { sessions: sessions.length, breaks, extraCost, unpriced };
}

/** A file's first turn compared (a request with usage that sent a prompt), with the chain up to it, as a session of that
 *  turn alone; `skipped`, the turns before it. None for a file with no such turn. */
function headOf(session: Pick<SessionOf, "turns" | "chain" | "model">): { head?: Pick<SessionOf, "turns" | "chain" | "model">; skipped: number } {
  const answers = session.turns.filter((turn): turn is Answer => turn.role === "assistant");
  const index = answers.findIndex(({ usage }) => usage !== undefined && promptOf(usage) > 0);
  if (index < 0) return { skipped: 0 };
  const chain = session.chain ?? [];
  const opens = chain.findIndex(({ request }) => request === index);
  const answer = answers[index]!;
  // Only whether a compaction came before it: the chain's ids are this file's alone.
  const compacted = opens > 0 && chain.slice(0, opens).some(({ compact, copy }) => compact && !copy);
  return { head: { turns: [{ role: "assistant", text: "", calls: [], at: answer.at, ...(answer.model ? { model: answer.model } : {}), usage: answer.usage! }], chain: [...(compacted ? [{ compact: true as const }] : []), { request: 0 }], ...(session.model ? { model: session.model } : {}) }, skipped: index };
}
