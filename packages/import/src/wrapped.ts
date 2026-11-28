// A year of work under a home, as numbers: what the year used, by which harnesses and models, and when. Every figure is
// bucketed by its REQUEST's time in the machine's local zone (a session that spans New Year splits); a session counts in
// `sessions` for the year its first request falls in. Text-free as parseHome's totals are: counts, names and times only,
// never a prompt, a title, a path or a project.
import { type Catalog, builtinCatalog, priceRequests } from "./price.js";
import { type ParseOptions, parseHome, type SessionRequest } from "./home.js";
import { READERS } from "./readers/index.js";
import { ACTIVE_GAP_MS, type Usage } from "./types.js";
import { addTokens, noTokens, type Tokens } from "./usage.js";

export type Wrapped = {
  year: number;
  /** Sessions whose first request is in the year, their prompts (`turns`, the person's own) with them. */
  sessions: number;
  turns: number;
  /** Requests in the year, each once, subagents' with them. */
  requests: number;
  tokens: Tokens;
  /** List price (the catalog's) of the requests it could price, USD; `unpricedRequests` counts those it could not (an
   *  unlisted model, no usage), so a sum that left some out says so. */
  cost: number;
  unpricedRequests: number;
  /** Requests whose session recorded no tokens for them (Cursor's CLI keeps none; pi leaves usage off an aborted
   *  request): `tokens` holds none of theirs, so a year of only these has unknown tokens, not zero. */
  tokensUnknownRequests: number;
  /** The year's requests whose time is only their session's start (Cursor keeps no message times): counted in the hours
   *  and days at that start, never in `activeMs`. */
  timeUnknownRequests: number;
  /** Local days with a request, ascending: that day's requests and tokens (input, output and cache together). */
  days: { day: string; requests: number; tokens: number }[];
  /** Requests by local hour of the day (24) and by weekday (7, Sunday first). */
  hours: number[];
  weekdays: number[];
  /** Time at work: the gaps between a session's requests of the year, each counted when it is under ACTIVE_GAP_MS. */
  activeMs: number;
  /** By reader's harness, the way serve runs it, and by model ("provider/model", "unknown" for a request naming none). */
  harnesses: { harness: string; sessions: number; requests: number; tokens: number; tokensUnknownRequests: number }[];
  /** `unpricedRequests` per model: of its requests, those its `cost` leaves out (all of them: no price was known). */
  models: { model: string; requests: number; tokens: Tokens; cost: number; unpricedRequests: number; tokensUnknownRequests: number }[];
  sources: { source: string; sessions: number; requests: number }[];
};

const all = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const by = <T>(map: Map<string, T>, key: string, make: () => T): T => map.get(key) ?? map.set(key, make()).get(key)!;

/** `year` under `home`, from parseHome's reads: its options (`state` and `requests` aside). */
export async function wrappedHome(home: string, year: number, options: Omit<ParseOptions, "state" | "requests"> & { price?: (model: string | undefined, usage: Usage) => Promise<number | undefined> | number | undefined } = {}): Promise<Wrapped> {
  const prices: Catalog | undefined = options.catalog === false ? undefined : (options.catalog ?? (await builtinCatalog()));
  const out: Wrapped = { year, sessions: 0, turns: 0, requests: 0, tokens: noTokens(), cost: 0, unpricedRequests: 0, tokensUnknownRequests: 0, timeUnknownRequests: 0, days: [], hours: new Array<number>(24).fill(0), weekdays: new Array<number>(7).fill(0), activeMs: 0, harnesses: [], models: [], sources: [] };
  const days = new Map<string, { requests: number; tokens: number }>();
  const harnesses = new Map<string, { sessions: number; requests: number; tokens: number; tokensUnknownRequests: number }>();
  const models = new Map<string, { requests: number; tokens: Tokens; cost: number; unpricedRequests: number; tokensUnknownRequests: number }>();
  const sources = new Map<string, { sessions: number; requests: number }>();
  // The usage of each model's requests of the year, priced once the read is over (a rejection of the price then rejects
  // this call, with no promise left floating), and each request that carries none, which no price can cover.
  const usages = new Map<string, Usage[]>();
  const readerOf = (source: string) => ((options.readers ?? READERS) as Record<string, { harness: string; untimed?: true } | undefined>)[source];
  const harnessOf = (source: string) => readerOf(source)?.harness ?? source;
  await parseHome(home, {
    ...options,
    requests: (totals, requests, started) => {
      const mine = requests.filter((r) => Number.isFinite(r.at) && new Date(r.at).getFullYear() === year).sort((a, b) => a.at - b.at);
      const counted = started !== undefined && new Date(started).getFullYear() === year;
      if (counted) {
        out.sessions += 1;
        out.turns += totals.turns;
        by(sources, totals.source, () => ({ sessions: 0, requests: 0 })).sessions += 1;
        by(harnesses, harnessOf(totals.source), () => ({ sessions: 0, requests: 0, tokens: 0, tokensUnknownRequests: 0 })).sessions += 1;
      }
      const untimed = readerOf(totals.source)?.untimed === true;
      for (let i = 0; i < mine.length; i++) {
        const r = mine[i]!;
        const when = new Date(r.at);
        const held = all(addTokens(noTokens(), r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
        out.requests += 1;
        if (r.usage) addTokens(out.tokens, r.usage);
        out.hours[when.getHours()]! += 1;
        out.weekdays[when.getDay()]! += 1;
        const d = by(days, day(when), () => ({ requests: 0, tokens: 0 }));
        d.requests += 1;
        d.tokens += held;
        by(sources, totals.source, () => ({ sessions: 0, requests: 0 })).requests += 1;
        const h = by(harnesses, harnessOf(totals.source), () => ({ sessions: 0, requests: 0, tokens: 0, tokensUnknownRequests: 0 }));
        h.requests += 1;
        h.tokens += held;
        const m = by(models, r.model ?? "unknown", () => ({ requests: 0, tokens: noTokens(), cost: 0, unpricedRequests: 0, tokensUnknownRequests: 0 }));
        m.requests += 1;
        if (r.usage) addTokens(m.tokens, r.usage);
        if (untimed) out.timeUnknownRequests += 1;
        else if (i > 0 && r.at - mine[i - 1]!.at < ACTIVE_GAP_MS) out.activeMs += r.at - mine[i - 1]!.at;
        // A request with no usage (pi leaves it off an aborted request) is unpriced; known zero usage is free and priced.
        if (r.usage) by(usages, r.model ?? "unknown", () => []).push(r.usage);
        else {
          out.unpricedRequests += 1;
          m.unpricedRequests += 1;
          out.tokensUnknownRequests += 1;
          h.tokensUnknownRequests += 1;
          m.tokensUnknownRequests += 1;
        }
      }
    },
  });
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  // One price per model: the caller's per request, or the catalog's over all of the model's requests at once (one rounding
  // of the model's sum, so many requests of a fraction of a cent each still add up). A model it cannot price leaves only
  // its own requests out, counted in `unpricedRequests`.
  for (const [model, list] of usages) {
    const known = model === "unknown" ? undefined : model;
    let usd: number | undefined;
    // A request of known zero tokens is free at any price: it is neither priced nor counted as unpriced.
    const paid = list.filter((usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0);
    if (paid.length === 0) continue;
    if (options.price) {
      // The caller's price answers per request: one it cannot price is left out alone.
      for (const usage of paid) {
        const one = await options.price(known, usage);
        if (one === undefined) {
          out.unpricedRequests += 1;
          models.get(model)!.unpricedRequests += 1;
        } else usd = (usd ?? 0) + one;
      }
      if (usd === undefined) continue;
    } else if (prices) usd = await priceRequests(paid.map((usage) => ({ ...(known ? { model: known } : {}), usage })), prices);
    if (usd === undefined) {
      out.unpricedRequests += paid.length;
      models.get(model)!.unpricedRequests += paid.length;
    } else {
      out.cost += usd;
      models.get(model)!.cost = usd;
    }
  }
  out.cost = round(out.cost);
  out.days = [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]) => ({ day: d, ...v }));
  out.harnesses = [...harnesses].map(([harness, v]) => ({ harness, ...v })).sort((a, b) => b.tokens - a.tokens || (a.harness < b.harness ? -1 : 1));
  out.models = [...models].map(([model, v]) => ({ model, ...v, cost: round(v.cost) })).sort((a, b) => all(b.tokens) - all(a.tokens) || (a.model < b.model ? -1 : 1));
  out.sources = [...sources].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.requests - a.requests || (a.source < b.source ? -1 : 1));
  return out;
}
