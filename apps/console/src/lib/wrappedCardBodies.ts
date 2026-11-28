// Each Wrapped card as a CardBody: what it says, from the year the server counted (GET /v2/wrapped) and nothing else. A
// card is drawn when every wait of its is met (SATISFIED_WAITS) and the year has sessions (or the store keeps it); a
// card with no body here is never drawn, whatever it waits on. No number is one the year does not give: a price not
// known is said as unknown, never $0, and requests with no known price are counted beside the price.
import { harnessLabel } from "@/lib/agentForm";
import { type CardBar, type CardBody, type CardChart, chartCapacity, MAX_ROWS } from "@/lib/cardImage";
import { compact, dollars } from "@/lib/format";
import type { Wrapped } from "@/lib/v2";
import type { CardWait, WrappedCard } from "@/lib/wrappedCards";

/** The waits met in this build: the card renderer, the cache analyzer (the year's `cache`, from the runs imported here)
 *  and the import's key count (the year's `secrets`). `opt-in` is met only on the page, when the person turns the card
 *  on. The launch benchmark has not landed, and no card's derived rules can be computed from the year alone (the agent
 *  type's need subagent shares and parallelism; the laptop's need last month's cost and an electricity estimate). */
export const SATISFIED_WAITS: ReadonlySet<CardWait> = new Set<CardWait>(["race-card-renderer", "cache-analyzer", "secret-count"]);

/** A card's body from the year, or null to draw nothing. Reads only the fields its card's `reads` names. */
export type BodyOf = (data: Wrapped) => CardBody | null;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const eyebrow = (data: Wrapped) => `Wrapped ${data.year}`;
const allTokens = (t: Wrapped["tokens"]) => t.input + t.output + t.cache_read + t.cache_write;
/** Dollars as the page says them (to four places under a cent), with thousands grouped past $1,000, and nothing as $0.00. */
const usd = (n: number) => (n === 0 ? "$0.00" : n >= 1_000 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : dollars(n));
/** "2 pm", "12 am": an hour of the day in words. */
const hourWords = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
const hoursAtWork = (ms: number) => `${(ms / 3_600_000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;

/** `part` as a whole percent of `total`: a part above zero never reads as 0%, nor a part short of the total as 100%. */
function percent(part: number, total: number): string {
  const whole = total > 0 ? Math.round((part / total) * 100) : 0;
  if (part > 0 && whole === 0) return "<1%";
  if (part < total && whole === 100) return ">99%";
  return `${whole}%`;
}

/** The first index of the largest count, or undefined when every count is zero. */
function busiest(counts: readonly number[]): number | undefined {
  let best: number | undefined;
  counts.forEach((n, i) => { if (n > 0 && (best === undefined || n > counts[best]!)) best = i; });
  return best;
}

/** The year's list price: unknown when no request was priced, and the requests with no known price as a row of their own:
 *  those whose tokens were recorded (a request with none has no price either, and tokenRows counts it). */
function priceRows(data: Pick<Wrapped, "cost_usd" | "unpriced_requests" | "requests" | "tokens_unknown_requests">): { label: string; value: string }[] {
  const none = data.unpriced_requests >= data.requests;
  const rows = [{ label: "At list price", value: none ? "Unknown" : usd(data.cost_usd) }];
  const unpriced = data.unpriced_requests - data.tokens_unknown_requests;
  if (unpriced > 0) rows.push({ label: "No known price", value: plural(unpriced, "request", "requests") });
  return rows;
}

/** The year's tokens as a card's figure: unknown, never 0, when no request's tokens were recorded (Cursor keeps none). */
const tokenFigure = (data: Pick<Wrapped, "tokens" | "requests" | "tokens_unknown_requests">) =>
  ({ value: data.requests > 0 && data.tokens_unknown_requests >= data.requests ? "Unknown" : compact(allTokens(data.tokens)), unit: "tokens" });
/** The requests whose tokens were not recorded, as a row, when there are any. */
const tokenRows = (data: Pick<Wrapped, "tokens_unknown_requests">): { label: string; value: string }[] =>
  data.tokens_unknown_requests > 0 ? [{ label: "Tokens not recorded", value: plural(data.tokens_unknown_requests, "request", "requests") }] : [];

/** A cover's or summary's rows within what the card draws: a year with both requests of unknown tokens and requests of no
 *  known price has a row too many, and leaves out its days at work, which the hours card shows. */
const fitRows = (rows: { label: string; value: string }[]) => (rows.length > MAX_ROWS ? rows.filter((r) => r.label !== "Days at work") : rows);

/** The foot line of a year read short: as the page says it. */
const unreadNote = (data: Pick<Wrapped, "unread_files">): { footnote?: string } =>
  data.unread_files > 0 ? { footnote: `${plural(data.unread_files, "session file", "session files")} could not be read, so these numbers may be incomplete.` } : {};

/** A model's name without its provider ("claude-sonnet"), unless another of `all` has the same name. */
function modelName(model: string, all: readonly string[]): string {
  const bare = (m: string) => m.slice(m.indexOf("/") + 1);
  return all.filter((m) => bare(m) === bare(model)).length > 1 ? model : bare(model);
}

type Share = { name: string; tokens: number };

/** Shares by tokens, most first (a stable sort: ties keep the year's order). A harness by the name the console gives it. */
const byTokens = (shares: readonly Share[]): Share[] => [...shares].sort((a, b) => b.tokens - a.tokens);
const harnessShares = (data: Pick<Wrapped, "harnesses">): Share[] => byTokens(data.harnesses.map((h) => ({ name: harnessLabel(h.harness), tokens: h.tokens })));
const modelShares = (data: Pick<Wrapped, "models">): Share[] => {
  const names = data.models.map((m) => m.model);
  return byTokens(data.models.map((m) => ({ name: modelName(m.model, names), tokens: m.tokens })));
};
const sum = (shares: readonly Share[]) => shares.reduce((n, s) => n + s.tokens, 0);

/** `shares` as bars, each with its percent of their total: at most `capacity` of them, the rest folded into one "other"
 *  bar of their summed tokens when more are given than fit. */
function shareBars(shares: readonly Share[], capacity: number): CardBar[] {
  const total = sum(shares);
  const bar = (label: string, tokens: number): CardBar => ({ label, value: tokens, text: percent(tokens, total) });
  if (shares.length <= capacity) return shares.map((s) => bar(s.name, s.tokens));
  const kept = shares.slice(0, Math.max(0, capacity - 1));
  return [...kept.map((s) => bar(s.name, s.tokens)), bar("other", sum(shares.slice(kept.length)))];
}

const cover: BodyOf = (data) => ({
  eyebrow: eyebrow(data),
  title: `Your ${data.year} in agents`,
  figure: tokenFigure(data),
  rows: fitRows([
    { label: "Sessions", value: count(data.sessions) },
    { label: "Prompts", value: count(data.turns) },
    { label: "Model requests", value: count(data.requests) },
    { label: "Days at work", value: count(data.days.length) },
    ...tokenRows(data),
    ...priceRows(data),
  ]),
  ...unreadNote(data),
});

const split: BodyOf = (data) => {
  const harnesses = harnessShares(data);
  const models = modelShares(data);
  const total = sum(harnesses);
  if (total <= 0) return null;
  const top = harnesses[0]!;
  const charts: CardChart[] = [{ label: "Harnesses", kind: "rows", bars: harnesses.map((s) => ({ label: s.name, value: s.tokens })) }];
  if (sum(models) > 0) charts.push({ label: "Models", kind: "rows", bars: models.map((s) => ({ label: s.name, value: s.tokens })) });
  const body: CardBody = { eyebrow: eyebrow(data), title: "Where your tokens went", figure: { value: percent(top.tokens, total), unit: top.name }, charts, ...unreadNote(data) };
  // How many bars of each fit is the layout's (it does not change with how many are given); the rest fold into "other".
  const capacity = chartCapacity(body);
  const shares = [harnesses, models];
  return { ...body, charts: charts.map((chart, i) => ({ ...chart, bars: shareBars(shares[i]!, capacity[i]!) })).filter((chart) => chart.bars.length > 0) };
};

const hours: BodyOf = (data) => {
  const hour = busiest(data.hours);
  const weekday = busiest(data.weekdays);
  return {
    eyebrow: eyebrow(data),
    title: "When your agents work",
    ...(hour === undefined ? {} : { figure: { value: hourWords(hour), unit: "busiest hour" } }),
    rows: [
      ...(weekday === undefined ? [] : [{ label: "Busiest day", value: WEEKDAY_NAMES[weekday]! }]),
      { label: "Time at work", value: hoursAtWork(data.active_ms) },
      { label: "Days at work", value: count(data.days.length) },
    ],
    charts: [
      { label: "Requests by hour", kind: "columns", bars: data.hours.map((value, h) => ({ label: `${h}h`, value })) },
      { label: "Requests by weekday", kind: "columns", bars: data.weekdays.map((value, d) => ({ label: WEEKDAY_SHORT[d]!, value })) },
    ],
    ...unreadNote(data),
  };
};

const summary: BodyOf = (data) => {
  const top = (shares: Share[]) => (sum(shares) > 0 ? `${percent(shares[0]!.tokens, sum(shares))} ${shares[0]!.name}` : undefined);
  const harness = top(harnessShares(data));
  const model = top(modelShares(data));
  const hour = busiest(data.hours);
  return {
    eyebrow: eyebrow(data),
    title: `${data.year} in agents`,
    figure: tokenFigure(data),
    rows: fitRows([
      ...tokenRows(data),
      ...priceRows(data),
      { label: "Days at work", value: count(data.days.length) },
      ...(harness ? [{ label: "Top harness", value: harness }] : []),
      ...(model ? [{ label: "Top model", value: model }] : []),
      ...(hour === undefined ? [] : [{ label: "Busiest hour", value: hourWords(hour) }]),
    ]),
    ...unreadNote(data),
  };
};

type YearCache = NonNullable<Wrapped["cache"]>;
type CacheCause = keyof YearCache["breaks"];

/** Each cause of a break as a column's label (short enough to sit under its column), in the order the analyzer tries them:
 *  a model switch, an idle gap past the cache's life, a compaction, an edit of the history, a sidechain, none recorded. */
const CAUSE_NAMES: Readonly<Record<CacheCause, string>> = { model: "Model", idle: "Idle", compaction: "Compact", edited: "Edited", sidechain: "Sidechain", unknown: "Unknown" };

/** The grade a hit rate earns: the least rate for each, three points apart, set so the prototype's example (88%) is a
 *  B+. Under the last step, F. */
export const CACHE_GRADES: readonly (readonly [number, string])[] = [[0.97, "A+"], [0.94, "A"], [0.91, "A-"], [0.88, "B+"], [0.85, "B"], [0.82, "B-"], [0.78, "C+"], [0.74, "C"], [0.7, "C-"], [0.6, "D"]];
const gradeOf = (rate: number) => CACHE_GRADES.find(([least]) => rate >= least)?.[1] ?? "F";

/** The year's cache: its grade, hit rate, what its breaks cost above a cache read (unknown when none was priced) and
 *  why they happened. Only the runs imported here are in it, and the card says so; none drawn with none analyzed. */
const cache: BodyOf = (data) => {
  const year = data.cache;
  if (!year || year.hit_rate === null) return null;
  const causes = Object.keys(CAUSE_NAMES) as CacheCause[];
  const breaks = causes.reduce((n, cause) => n + year.breaks[cause], 0);
  const lost = causes.reduce((n, cause) => n + year.extra_cost_usd[cause], 0);
  // Every cause a column, in the analyzer's order: a rows chart beside the grade fits two bars, and the causes are six.
  const bars = causes.map((cause) => ({ label: CAUSE_NAMES[cause], value: year.breaks[cause], text: compact(year.breaks[cause]) }));
  return {
    eyebrow: eyebrow(data),
    title: "How your cache held",
    figure: { value: gradeOf(year.hit_rate), unit: "cache grade" },
    rows: [
      { label: "Hit rate", value: percent(Math.round(year.hit_rate * 10_000), 10_000) },
      { label: "Lost to breaks", value: breaks === 0 ? "$0.00" : year.unpriced_breaks >= breaks ? "Unknown" : usd(Math.round(lost * 100) / 100) },
      { label: "Breaks", value: count(breaks) },
    ],
    ...(breaks > 0 ? { charts: [{ label: "Breaks by cause", kind: "columns" as const, bars }] } : {}),
    // The unpriced breaks in the foot line: a fourth row does not fit beside the grade and the chart.
    footnote: `From the ${plural(year.runs, "run", "runs")} imported here${year.unpriced_breaks > 0 && year.unpriced_breaks < breaks ? `; ${plural(year.unpriced_breaks, "break", "breaks")} with no known price ${year.unpriced_breaks === 1 ? "is" : "are"} not in the loss` : ""}.`,
  };
};

/** The year's leak receipt: the keys and tokens the import cut out of the sessions it counted, how many sessions held
 *  one and how many were counted. Counts alone, never a key; none drawn with no run counted. Off the page until the person
 *  turns it on (its `opt-in` wait). */
const leak: BodyOf = (data) => {
  const year = data.secrets;
  if (!year) return null;
  return {
    eyebrow: eyebrow(data),
    title: "Your leak receipt",
    figure: { value: count(year.removed), unit: year.removed === 1 ? "key or token cut" : "keys and tokens cut" },
    rows: [
      { label: "Sessions with a key", value: count(year.runs_holding) },
      { label: "Sessions checked", value: count(year.runs) },
    ],
    footnote: `From the ${plural(year.runs, "run", "runs")} counted on import; counts only, no key shown.`,
  };
};

/** The cards with a body, by id. The others (laptop, type, launch) need what the year does not hold. */
export const CARD_BODIES: Readonly<Record<string, BodyOf>> = { cover, split, hours, cache, leak, summary };

/** The cards drawn from what the store keeps of the year's imported runs (its cache, the keys their import cut), not from
 *  the session files: a year whose files are gone keeps them, while the store does. */
const STORED: ReadonlySet<string> = new Set(["cache", "leak"]);

/** `card`'s body from `data`: none for an empty year (no sessions or no requests) unless the store keeps it (STORED),
 *  or a card with no body in `bodies`. */
export function toBody(card: WrappedCard, data: Wrapped, bodies: Readonly<Record<string, BodyOf>> = CARD_BODIES): CardBody | null {
  if ((data.sessions === 0 || data.requests === 0) && !STORED.has(card.id)) return null;
  return bodies[card.id]?.(data) ?? null;
}

/** `card`'s body when every wait of its is in `satisfied`, else null: what the page draws. */
export function drawnBody(card: WrappedCard, data: Wrapped, satisfied: ReadonlySet<CardWait> = SATISFIED_WAITS, bodies: Readonly<Record<string, BodyOf>> = CARD_BODIES): CardBody | null {
  return card.waits.every((wait) => satisfied.has(wait)) ? toBody(card, data, bodies) : null;
}
