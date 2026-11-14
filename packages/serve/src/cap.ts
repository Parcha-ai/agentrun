// What a run's spend cap leaves behind in serve once the kernel's cap (run-adapters kernel/cap) holds the money: the
// refusal's code and words as every reader of a refusal reads them, the cap modes a run is created with, and the spend
// and /usage meters read back from a run's entries (spentFrom, meterFiguresFrom), over marks the kernel's cap also reads.
import { type EntryLike, REQUEST_COST, REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, REQUEST_CONTINUED, timelineOf, TOOL_COST, TOOL_STARTED } from "./timeline/index.js";

/** How a request the cap refused begins its error, which the server ends the run with. */
export const SPEND_CAP_REACHED = "spend_cap_reached";
/** How near two dollar figures are the same figure: a sum a float puts a hair past the cap (0.0028 + 0.3072 is
 *  0.31000000000000005) is the cap, and fits it. A raise must be above a run's cap by more (runs.ts). */
export const CAP_TOLERANCE = 1e-9;
/** How far past what is left a sum may read and still fit it: a float's own tail (0.0028 + 0.3072 is 0.31000000000000005
 *  against a 0.31 cap), never a spend that is past the cap, by however little (a 1e-11 hair is past it). CAP_TOLERANCE
 *  is the other question: how near two caps are the same cap. */
export const FIT_TOLERANCE = 1e-12;

/** How a run's cap prices a request's input (`cap_mode`): "expected" (the default) from the previous request's cache, so
 *  only a cache miss can pass the cap, by at most the request's bound; "strict" every input token uncached, the worst
 *  case, so no request can pass it. */
export const CAP_MODES = ["expected", "strict"] as const;
export type CapMode = (typeof CAP_MODES)[number];

/** The field of a request's end mark (REQUEST_ENDED) that says what the cap held for it, when its stream ended aborted
 *  or its summary failed: the request counts at that figure. Optional: an end with none (an older store, a run with no
 *  cap) leaves the request cut, at an unknown cost. */
export const HELD_FIELD = "heldUsd";
/** The field of the start mark (REQUEST_STARTED) written for a request this cap refused: it never left, and pi's error
 *  entry for it answers this mark, never an earlier request's. */
export const CAP_REFUSED_FIELD = "capRefused";

/** How pi's error for a request whose start mark could not be written begins (request-start.ts builds it from this): the
 *  request never left, so the entry answers none, and spentFrom leaves it out by this. */
export const MARK_NOT_WRITTEN = "the model request was not sent: its mark could not be written";
/** pi's error for a request that left and whose end mark the store refused (request-start.ts): its cost is not recorded
 *  as booked, so it stays open, read at its start mark's hold, never closed by this entry at its own usage. */
export const END_NOT_WRITTEN = "the model request's end could not be recorded";
const endUnrecorded = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(END_NOT_WRITTEN);
};

/** The input a request carrying claude-agent's native web search may read in beyond its body, added to its input bound
 *  by its adapter (adapters.ts hands it over): Claude's CLI asks for at most 8 searches a request (max_uses 8), and each
 *  search's results are billed as input, about 25,000 tokens a search as a working estimate. */
export const NATIVE_SEARCH_ALLOWANCE_TOKENS = 8 * 25_000;

/** The code a cap's refusal begins with: `spend_cap_reached: `, or with a note after it, as a request it limited refuses
 *  in (CAP_REFUSAL_CODE, "spend_cap_reached (out of budget): "). Every reader of a refusal's text (a run's end, its
 *  learning, the spend read back) reads the code through this, never a bare prefix. */
export const CAP_REFUSAL_PREFIX = /^spend_cap_reached(?: \([^)]*\))?: /;

/** Whether `entry` is pi's answer to a request this cap refused (capModels): an error that begins spend_cap_reached. */
const refusedHere = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && CAP_REFUSAL_PREFIX.test(message.errorMessage);
};

/** Whether `entry` is pi's error for a request whose start mark could not be written (request-start.ts, MARK_NOT_WRITTEN):
 *  it never left and has no mark of its own, so it answers no request, and read as an answer it would close another's. */
const notSentHere = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(MARK_NOT_WRITTEN);
};

/** The cost an entry adds to what a run spent, as the timeline counts it: a pi answer's total (none for one stopped
 *  before its end), and the usd of a cost written apart from an answer, a paid tool's charge among them; 0 for anything
 *  else, or for a cost that is not a number (which makes the whole spend unknown, by the timeline's verdict). */
export const costOf = (entry: EntryLike): number => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; usage?: { cost?: { total?: unknown } } } | undefined) : undefined;
  const cost = message ? (message.stopReason === "aborted" ? undefined : message.usage?.cost?.total)
    : entry.kind === REQUEST_COST || entry.kind === REQUEST_COST_LATE || entry.kind === TOOL_COST ? (entry.data as { usd?: unknown } | undefined)?.usd : undefined;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
};

/** A held figure as a mark carries it: a finite number, else none. */
const figureOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** What the cap held for a request, as its start mark says; undefined when it says none (an older store). */
type Figure = number | undefined;

/** Takes one figure out of `open`: `figure` itself when it is there, else the smallest, a figure that is not there reading
 *  as the largest (a start with none stays while any other could go). */
const close = (open: Figure[], figure?: number) => {
  if (!open.length) return;
  let at = figure === undefined ? -1 : open.indexOf(figure);
  if (at < 0) at = open.reduce<number>((low, f, i) => (f !== undefined && (open[low] === undefined || f < open[low]!) ? i : low), 0);
  open.splice(at, 1);
};

/** The figures of the requests of each kind that `entries` leave open, marked as sent with no answer, cost or end, read in
 *  order, as the run's timeline counts them, so the two agree on how many were cut. A start adds
 *  its figure. An end mark closes its own start: a stopped request's at the figure it names, a withdrawn one's (`unsent`,
 *  which names none) the smallest. An end that names none for a request that left (an older store) closes nothing, so
 *  that request stays cut. An answer, or a summary's cost, closes the smallest figure still open, since when requests
 *  overlap the marks do not say which one it answered. What stays open is then never less than the requests truly open,
 *  figure for figure: taking the smallest, or the very figure an end names, never leaves a smaller figure open than any
 *  other way of reading the same marks. It is exactly them when requests do not overlap. pi's answer to a request that
 *  never left (REQUEST_REFUSED's error entry) and a harness answer's continuation close nothing. */
function openFigures(entries: readonly EntryLike[]): { generation: Figure[]; compaction: Figure[] } {
  const open = { generation: [] as Figure[], compaction: [] as Figure[] };
  let [refused, continued] = [0, 0];
  for (const entry of entries) {
    const message = entry.model?.[0] as { stopReason?: unknown } | undefined;
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // A side request (a compaction's summary, a tool's own request): marked with a label, as the timeline reads it.
    const kind = typeof data.request === "string" ? "compaction" : "generation";
    if (entry.kind === REQUEST_REFUSED) refused += 1;
    else if (entry.kind === "pi.assistant" && refused > 0 && message?.stopReason === "error") refused -= 1;
    else if (entry.kind === REQUEST_CONTINUED) continued += 1;
    else if (entry.kind === "pi.assistant" && continued > 0 && message) continued -= 1;
    else if (entry.kind === REQUEST_STARTED) open[kind].push(figureOf(data[HELD_FIELD]));
    else if (entry.kind === REQUEST_ENDED) {
      if (data.unsent === true) close(open[kind]);
      else if (figureOf(data[HELD_FIELD]) !== undefined) close(open[kind], figureOf(data[HELD_FIELD]));
    } else if (entry.kind === REQUEST_COST) close(open.compaction);
    else if (entry.kind === "pi.assistant" && message) close(open.generation);
  }
  return open;
}

/** What the run's model requests cost, from its entries in log order: the one computation, which the one-store reader
 *  (store-reads/cap.ts spentOverStore) runs over A's journal. These readings are the cap's
 *  own, on its copy of the entries (the run's shown cost is the timeline's, unchanged): a request stopped before its end
 *  counts at the figure its end mark holds (HELD_FIELD), and one a crash cut (marked as sent, no answer, no end) at the
 *  figure its start mark holds (openFigures), each the worst case the cap held for it; without that figure either stays
 *  cut, at an unknown cost. This cap's refusals are left out, as none left. Unknown is null, which a cap never reads as $0. */
export function spentFrom(rows: readonly EntryLike[]): number | null {
  // The store's own entries, as read (without the answers written below for a stopped request): openFigures reads them.
  const entries: EntryLike[] = [];
  const read: EntryLike[] = [];
  let marked = false;
  // pi's error entry for a request that ended on an error after its response began is left out, as an aborted one is: its
  // end mark (`error`) counts it at its hold. pi writes the entry as the mark is written, before it or after, so each such
  // mark takes the nearest error entry not yet taken among those after the earliest start holding its figure (a request's
  // start and end marks hold the same, request-start.ts). Its own entry comes after its own start, so it is always among
  // them. An error before every such start answered an earlier request (a 429, before any event): taken when a crash came
  // between the mark and pi's entry, it would leave that request open at its hold. The marks with the fewest entries to
  // choose from take first, so as many are taken as the marks' own entries in the store and no more errors are read as
  // answers than are, one of which could close a start a crash cut; which one a mark takes, when errors overlap, moves no
  // figure below what can have been spent, as an answer's choice of start does not (openFigures). An earlier start holding
  // the very same figure (a 429's retry, with the same context) leaves its 429 takeable, so the spend then reads high,
  // never low: telling the two apart needs to know which request each entry answers, and the marks do not say. An error
  // with no such mark (before any event: a 429, a 5xx) is its request's answer.
  // A cancel's refusal (REQUEST_REFUSED) answers the next error entry, as openFigures and the timeline read them: those are
  // no request's, and no end mark takes one.
  const stopOf = (entry: EntryLike) => (entry.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason;
  const errorsAt: number[] = [];
  // pi's answers: a `lost` end mark (written before a retry, request-start.ts) takes pi's entry for its own request, an
  // answer or an error, the first after the mark: it is counted at the mark's hold, never at its usage too.
  const answersAt: number[] = [];
  let refusals = 0;
  rows.forEach((entry, at) => {
    if (entry.kind === REQUEST_REFUSED) refusals += 1;
    else if (entry.kind === "pi.assistant" && stopOf(entry) === "error" && !refusedHere(entry) && !notSentHere(entry) && !endUnrecorded(entry)) {
      if (refusals > 0) refusals -= 1;
      else errorsAt.push(at);
    } else if (entry.kind === "pi.assistant" && stopOf(entry) !== "error" && stopOf(entry) !== "aborted") answersAt.push(at);
  });
  const taken = new Set<number>();
  const fieldsOf = (entry: EntryLike) => (entry.data ?? {}) as Record<string, unknown>;
  const generationStart = (entry: EntryLike) => entry.kind === REQUEST_STARTED && typeof fieldsOf(entry).request !== "string" && fieldsOf(entry)[CAP_REFUSED_FIELD] !== true;
  // Each such end mark, with the earliest start holding its figure (-1 for none: any error entry then).
  const endsOf = (field: "error" | "lost" | "unpriced") => rows.flatMap((entry, at) => entry.kind === REQUEST_ENDED && fieldsOf(entry)[field] === true
    ? [{ at, from: rows.findIndex((start, i) => i < at && generationStart(start) && figureOf(fieldsOf(start)[HELD_FIELD]) === figureOf(fieldsOf(entry)[HELD_FIELD])) }]
    : []);
  // A `lost` mark is written before its request's retry is sent (request-start.ts watchingLost) and is in the store before
  // pi has the request's result, so its request's entry is the first after it, before the next generation request's start
  // (one sent after it): never an earlier request's answer, however near. None there (its entry was the loud failure of a
  // mark the store took late, END_NOT_WRITTEN, or a crash came first) and it takes none. These go first, so an error mark
  // never takes a lost request's own entry.
  const afterMark = [...errorsAt, ...answersAt].sort((a, b) => a - b);
  // An `unpriced` mark (an answer whose cost cannot be read, at its hold) is written the same way, before pi has the answer.
  for (const { at } of [...endsOf("lost"), ...endsOf("unpriced")]) {
    const next = rows.findIndex((entry, i) => i > at && generationStart(entry));
    const own = afterMark.find((entry) => entry > at && (next < 0 || entry < next) && !taken.has(entry));
    if (own !== undefined) taken.add(own);
  }
  for (const { at, from } of endsOf("error").sort((a, b) => b.from - a.from)) {
    let nearest = -1;
    for (const entry of errorsAt) if (entry > from && !taken.has(entry) && (nearest < 0 || Math.abs(entry - at) < Math.abs(nearest - at))) nearest = entry;
    if (nearest >= 0) taken.add(nearest);
  }
  // Each paid tool call marked and not settled, by call: what it was held at.
  const calls = new Map<unknown, unknown>();
  for (const [at, entry] of rows.entries()) {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // A request this cap refused never left, and costs nothing: its mark and pi's error entry for it (an older store
    // has the entry alone, which the timeline would count as answering an earlier request a crash cut). Nor did one
    // whose start mark could not be written, whose error entry has no mark at all. A cancel's refusal is its mark
    // (REQUEST_REFUSED) and pi's error for it, which close nothing together (openFigures, and the timeline).
    if (refusedHere(entry) || notSentHere(entry) || (entry.kind === REQUEST_STARTED && data[CAP_REFUSED_FIELD] === true)) continue;
    // A paid call settled at a charge it did not say: at the figure its mark holds, the cap's bound for it.
    const bound = entry.kind === TOOL_COST && figureOf(data.usd) === undefined ? figureOf(calls.get(data.call)) : undefined;
    if (entry.kind === TOOL_STARTED) calls.set(data.call, data[HELD_FIELD]);
    if (entry.kind === TOOL_COST) calls.delete(data.call);
    if (entry.kind === REQUEST_STARTED) marked = true;
    // pi's entry for a marked request stopped before its end (what had streamed of it): the request is counted by its
    // marks instead, at the figure its end holds, or cut. Before the first mark (an older run) it stays unknown.
    if (marked && entry.kind === "pi.assistant" && (entry.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason === "aborted") continue;
    // pi's entry for a request whose end mark the store refused: the request stays open, at its start's hold.
    if (marked && endUnrecorded(entry)) continue;
    if (taken.has(at)) continue;
    entries.push(bound === undefined ? entry : { ...entry, data: { ...data, usd: bound } });
    read.push(entry);
    const held = data[HELD_FIELD];
    // A summary that ended on an error after its response began (its cost mark says `failed`) counts at its hold.
    // So does one whose cost could not be read (`unpriced`): the booking rule's figure for an answer with no cost.
    if (entry.kind === REQUEST_COST && (data.failed === true || data.unpriced === true) && figureOf(held) !== undefined) entries[entries.length - 1] = { ...entry, data: { ...data, usd: held } };
    if (entry.kind !== REQUEST_ENDED || data.unsent === true || typeof held !== "number" || !Number.isFinite(held)) continue;
    // The stopped request closed at what the cap held for it: a summary by its cost, a generation by an answer.
    entries.push(typeof data.request === "string"
      ? { kind: REQUEST_COST, data: { request: data.request, usd: held } }
      : { kind: "pi.assistant", ...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}), model: [{ role: "assistant", content: [], stopReason: "stop", usage: { cost: { total: held } }, timestamp: 0 }] });
  }
  // A paid tool call a crash cut (marked, never settled) counts at its held figure, settled by it here, as a cut request.
  for (const [call, figure] of calls) entries.push({ kind: TOOL_COST, data: { call, usd: figureOf(figure) ?? null } });
  // A request still open is one a crash cut, with no answer and no end: it counts at what the cap held for it, as its start
  // mark says: its own figure when requests do not overlap, else one never less (openFigures). One still open with no
  // figure (an older store) leaves them all cut, unknown.
  const open = openFigures(read);
  for (const kind of ["generation", "compaction"] as const) {
    const figures = open[kind];
    if (figures.some((figure) => figure === undefined)) continue;
    for (const figure of figures as number[]) {
      entries.push(kind === "compaction"
        ? { kind: REQUEST_COST, data: { request: "compaction", usd: figure } }
        : { kind: "pi.assistant", model: [{ role: "assistant", content: [], stopReason: "stop", usage: { cost: { total: figure } }, timestamp: 0 }] });
    }
  }
  // The timeline says whether the spend is known; the amount is summed here, as it is, since the timeline rounds its total
  // for display (to the millionth of a dollar), and a cap must not lose what that drops.
  const usage = timelineOf(entries, { settled: true }).find((row) => row.kind === "usage")?.usage;
  if (usage === undefined) return 0;
  if (typeof usage.usd !== "number" || !Number.isFinite(usage.usd)) return null;
  return entries.reduce((sum, entry) => sum + costOf(entry), 0);
}

/** /usage's meters for a run that ended, from its store: `tools`, each TOOL_COST's `usd`, unknown (null) when one is,
 *  or when a call was cut (marked, never settled: what it charged no one knows); and `tokens`, the rest of its root
 *  conversation as its settled timeline prices it; `browser`, the part of `tools` that is browser session time
 *  (browser-cost.ts), with its seconds; and `others`, the rest of `tools`, each unknown (null) apart; and `notMetered`, the tool calls it ran with no price (TOOL_UNMETERED, an MCP tool its owner set none for), outside every figure here (absent when none). A mark is never a charge here (the cap's alone). Never for a live run: its process
 *  holds the store exclusively. */
export type Meters = { tools: number | null; tokens: number | null; browser: { usd: number | null; seconds: number }; others: number | null; notMetered?: number };
/** A browser charge's record on the run's root when the run books its money on the runner's one ledger (browser-cost.ts
 *  browserSpend's `paid`): the same record a browser TOOL_COST is, for what the browser's process holds and the seconds
 *  it was for, under a kind no cost reads. The charge's money is the ledger's paid step alone, which the cap counts and
 *  the run's cost (adapter-run-spec.ts endPatch), its timeline and its meters (store-reads/journal.ts withPaidCosts) read,
 *  as every paid tool's on the runner: a TOOL_COST beside it would count the same charge twice. Its seconds are the
 *  browser_time meter's (meterFiguresFrom). */
export const BROWSER_CHARGED = "agentrun.browser_charged";

/** /usage's meter figures from a run's entries by conversation, in log order, and beside them each meter's known dollars:
 *  its settled charges' figures, whether or not another of its charges is unknown (a hold, a call cut or never settled, is
 *  no charge here: it adds nothing). The one computation, which the one-store reader (store-reads/cap.ts metersOverStore)
 *  runs over A's journal. A paid tool's charge reaches it as the TOOL_COST / TOOL_UNMETERED the store reader folds back in from the
 *  paid-tools session (store-reads/journal.ts withPaidCosts), as the file-backed run's root held each natively. */
export function meterFiguresFrom(rows: readonly { conversation: number; entry: EntryLike }[]): Meters & { known: { tokens: number; browser: number; others: number } } {
  const root = rows.reduce((min, row) => Math.min(min, row.conversation), Infinity);
  const marks = new Set<unknown>();
  const charges: (number | undefined)[] = [];
  const browser = { usd: 0 as number | null, seconds: 0 };
  const others: (number | undefined)[] = [];
  // Each meter's known dollars, whether or not one of its charges is unknown: what a run of unknown cost is known to
  // have spent on it (server.ts /usage).
  const known = { tokens: 0, browser: 0, others: 0 };
  for (const { entry } of rows) {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // On the runner a browser charge's money reaches here from the run's ledger (a TOOL_COST of tool "browser", with no
    // seconds) and its seconds from its record on the root: each counted once.
    if (entry.kind === BROWSER_CHARGED && data.tool === "browser") browser.seconds += figureOf(data.seconds) ?? 0;
    if (entry.kind === TOOL_STARTED) marks.add(data.call);
    else if (entry.kind === TOOL_COST) marks.delete(data.call), charges.push(figureOf(data.usd));
    if (entry.kind === TOOL_COST && data.tool !== "browser") others.push(figureOf(data.usd)), (known.others += figureOf(data.usd) ?? 0);
    if (entry.kind !== TOOL_COST || data.tool !== "browser") continue;
    const usd = figureOf(data.usd);
    known.browser += usd ?? 0;
    browser.usd = browser.usd === null || usd === undefined ? null : browser.usd + usd;
    browser.seconds += figureOf(data.seconds) ?? 0;
  }
  const tools = marks.size || charges.some((usd) => usd === undefined) ? null : (charges as number[]).reduce((sum, usd) => sum + usd, 0);
  const rest = rows.filter(({ conversation, entry }) => conversation === root && entry.kind !== TOOL_STARTED && entry.kind !== TOOL_COST).map(({ entry }) => entry);
  const usage = timelineOf(rest, { settled: true }).find((row) => row.kind === "usage");
  const otherTools = marks.size || others.some((usd) => usd === undefined) ? null : (others as number[]).reduce((sum, usd) => sum + usd, 0);
  known.tokens = usage ? (usage.usage?.usd ?? usage.usage?.so_far_usd ?? 0) : 0;
  const notMetered = usage?.usage?.not_metered;
  return { tools, tokens: usage ? (usage.usage?.usd ?? null) : 0, browser, others: otherTools, known, ...(notMetered ? { notMetered } : {}) };
}

/** An amount in words: two decimals, or as many as it takes (up to eight) to show it whole ($0.50, $0.105, $0.0005). */
export function money(usd: number): string {
  // A whole number of dollars as given ($1), else two decimals or as many as it takes (up to eight) to show it whole.
  if (Number.isInteger(usd)) return `$${usd}`;
  for (let digits = 2; digits < 8; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(8))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(8)}`;
}

/** The code a cap's refusal begins with: `spend_cap_reached`, which the server ends the run with, and "out of budget",
 *  which pi-ai's retry (isRetryableAssistantError, which reads only an error's text) takes as final whatever digits the
 *  words after it hold. The words after it are the ones a person reads. */
export const CAP_REFUSAL_CODE = `${SPEND_CAP_REACHED} (out of budget): `;
/** A refusal for room's figures, beside its words: what the cap counted as taken (spent, and held for requests still
 *  answering), the least the refused request needs, and the least cap that sends it (`leastCapUsd`: the very figure its
 *  words name, "Raise the cap to at least $X", from the one call that wrote them: the request's figure there is what
 *  admission prices it at, its expected cost, or its worst case under strict, so a cap at it admits the request). Kept on
 *  the refusal's own start mark (`spentUsd`, `needsUsd`, `leastCapUsd`), so a run paused at its cap says them (runs.ts
 *  pending), and its cap's raise is checked against them. `boundUsd`: the most a cache miss could make the refused
 *  request cost beyond what it needs (BOUND_USD; absent for 0). */
export type RefusalFigures = { spentUsd: number; needsUsd: number; leastCapUsd: number; boundUsd?: number };
/** The words of a refusal for room (CAP_REFUSAL_CODE: what is left of the cap cannot buy the request's least), which a
 *  higher cap would send; undefined for any other text, a refusal no cap could fix included (an unknown spend, no price,
 *  no output ceiling, an input not measured: the bare `spend_cap_reached: ` code). The one reader of that difference. */
export const roomRefusal = (text: string | undefined): string | undefined => (text?.startsWith(CAP_REFUSAL_CODE) ? text.slice(CAP_REFUSAL_CODE.length) : undefined);
