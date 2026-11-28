// The fetch step: a part judged in passages, or the chunks of a page its objective asks for, with the page guard beside.
import type { Fee, Pay } from "../fees.js";
import type { WebPage, WebRead, WebUnread } from "../fetch.js";
import { clip, type Page, type Part, unwrittenLinks } from "../page.js";
import { QUERY_MAX } from "../search.js";
import type { Verdict, WebDecider } from "./decider.js";
import type { PageGuard, Warned } from "./page-guard.js";
import { passagesOf } from "./passages.js";
import { bounded, byScore, decisionPay, type DecisionRecord, droppedOf, drops, failed, ran, relevanceOf, type Scored, type Sift, type Sifted, since, skipped, type StepOptions } from "./record.js";

/** What stands in the text of a fetched part for each run of passages left out. */
export const LEFT_OUT = "\n…\n";

/** A fetched part judged by `decider` in passages: the kept ones in order, LEFT_OUT for each run left out, the part's
 *  place in the page (chars, offset, next_offset) unchanged, and `sift` telling the model what was done. With no task
 *  the part is not judged and comes back as it is, with no `sift`: a line saying nothing was done, on every fetch,
 *  would only cost the model tokens; the record says why (`skipped: "no task"`). */
export async function judgePart(decider: WebDecider, url: string, page: WebPage | Page, options: StepOptions): Promise<Sifted<(WebPage | Page) & { sift?: string }>> {
  if (!page.ok || !page.text) return { answer: page, classifier: skipped(decider, "fetch", "no page") };
  const spans = passagesOf(page.text);
  if (!options.task) return { answer: page, classifier: skipped(decider, "fetch", "no task", spans.length) };
  const judged = await judgeSpans(decider, url, options.task, page.text, spans, page.offset ?? 0, options);
  if ("failure" in judged) return { answer: { ...page, sift: `not run (${judged.failure.error!.code}); this part is whole` }, classifier: judged.failure };
  const { texts, scored } = judged;
  const dropped = droppedOf(scored);
  const kept = spans.length - dropped.length;
  let text = "";
  if (kept) texts.forEach((passage, i) => (text += !drops(scored[i]!.score) ? passage : i > 0 && drops(scored[i - 1]!.score) ? "" : LEFT_OUT));
  const sift = `${decider.id} kept ${kept} of ${spans.length} passages of this part; … marks a passage left out`;
  return { answer: { ...page, text, sift }, classifier: judged.record(dropped) };
}

/** `spans` of `text` judged by `decider` against `need` (its judge request), each scored as passage p1, p2, ... at its
 *  place in the page (`base` the text's offset in it); `record` the step's record once the caller knows what it left
 *  out, or `failure` the record of a step that failed. */
type Judged = { texts: string[]; scored: Scored[]; record: (dropped: DecisionRecord["dropped"], kept?: number) => DecisionRecord };
async function judgeSpans(decider: WebDecider, url: string, need: string, text: string, spans: [number, number][], base: number, options: StepOptions): Promise<Judged | { failure: DecisionRecord }> {
  const texts = spans.map(([s, e]) => text.slice(s, e));
  const start = performance.now();
  const { got, requests } = await bounded((ctx) => decider.judge(url, need, texts, ctx), options);
  if ("code" in got) return { failure: failed(decider, "fetch", spans.length, since(start), requests, got) };
  const ms = since(start);
  const scored: Scored[] = spans.map(([s, e], i) => ({ id: `p${i + 1}`, score: got.verdicts[i] as Verdict, at: [base + s, base + e] }));
  return { texts, scored, record: (dropped: DecisionRecord["dropped"], kept?: number) => ran(decider, "fetch", got, ms, requests, scored, dropped, kept) };
}

/** The most chunks a page is cut into for an objective (passagesOf), and how many of them an answer shows. */
export const FIND_CHUNKS_MAX = 200;
export const FOUND_CHUNKS = 8;
/** A chunk of a page an objective shows: where it starts in the page (web_fetch's offset), and its text. */
export type FoundChunk = { offset: number; relevance?: number; text: string };
/** A page as an objective answers it: the chunks most likely to hold what the agent wants from it, in page order. */
export type FoundPage = Pick<Page, "ok" | "url" | "status" | "title" | "original_chars" | "beyond_read"> & Pick<WebPage, "via" | "parallel"> & { found: FoundChunk[]; sift: string };

/** The `found` chunks (its setup's, else FOUND_CHUNKS) of the whole page `read` most likely to hold `need` (what the
 *  agent wants from it), in page order: its text cut into at most FIND_CHUNKS_MAX chunks, each judged by `decider` with `need` as the task (its
 *  judge request), ranked by score, a refused one after every scored one, ties in page order. A step that fails answers
 *  null, its record saying why. */
export async function findInPage(decider: WebDecider, url: string, read: WebRead, need: string, options: StepOptions, found: number = decider.setup?.fetch.found ?? FOUND_CHUNKS): Promise<Sifted<FoundPage | null>> {
  const spans = passagesOf(read.text, FIND_CHUNKS_MAX);
  const judged = await judgeSpans(decider, url, need, read.text, spans, 0, options);
  if ("failure" in judged) return { answer: null, classifier: judged.failure };
  const { texts: chunks, scored } = judged;
  const shown = spans
    .map((_, i) => i)
    .sort((a, b) => byScore(scored[a]!.score, scored[b]!.score) || a - b)
    .slice(0, found)
    .sort((a, b) => a - b);
  const answer: FoundPage = {
    ok: true,
    url: read.url,
    status: read.status,
    title: read.title,
    ...(read.length === undefined ? {} : { original_chars: read.length }),
    ...(read.beyond ? { beyond_read: true as const } : {}),
    found: shown.map((i) => ({ offset: spans[i]![0], ...relevanceOf(scored[i]!.score), text: chunks[i]! })),
    via: read.via,
    ...(read.parallel ? { parallel: read.parallel } : {}),
    sift: `${decider.id} showed the ${shown.length} of ${spans.length} chunks of the page most likely to hold what your objective asks for (relevance 0 to 1), in page order; to read on from one, call web_fetch with its offset and no objective`,
  };
  return { answer, classifier: judged.record([], shown.length) };
}

/** A fetch's answer: the part (judged or not), or what its objective found; with the guard's warning when it gave one. */
export type FetchAnswer = (((WebPage | Page) & Sift) | FoundPage) & Warned;
/** How a fetch is decided: the call's `task` and `objective`, the part it asked for (`offset`, `maxChars`, as given), the
 *  step's bounds, `pay` and the call's fee `lines`, and `guard`, the run's page guard for this read (absent when it is
 *  off). */
export type FetchStep = Pick<StepOptions, "task" | "signal" | "ms"> & Part & { objective?: unknown; pay: Pay; lines: Fee[]; guard?: ((options: StepOptions) => Promise<PageGuard>) | undefined };

/** A fetch decided: with an `objective` and a decider, what findInPage finds in the whole page, its sift line naming an
 *  offset past 0 or a max_chars the call gave as ignored (or the part, saying the objective was not applied, where the
 *  step fails); else the part judged against `task`; and the page guard asked beside either, its warning added and its
 *  fee lines put after the step's once both have settled. With no decider the part is the answer, its sift line saying
 *  an objective given was not applied. */
export async function decideFetch(decider: WebDecider | undefined, url: string, whole: WebRead | WebUnread, part: WebPage, options: FetchStep): Promise<{ answer: FetchAnswer; classifier: DecisionRecord | "off"; guard?: PageGuard }> {
  const step: StepOptions = { signal: options.signal, ms: options.ms, pay: decisionPay(options.pay, options.lines) };
  const guardLines: Fee[] = [];
  const guarding = whole.ok && whole.text ? options.guard?.({ ...step, pay: decisionPay(options.pay, guardLines) }) : undefined;
  const need = typeof options.objective === "string" ? clip(options.objective.trim(), QUERY_MAX) : "";
  const notApplied = (why: string) => ({ ...part, sift: `objective not applied (${why}); this part is in page order` });
  let answer: FetchAnswer = part;
  let classifier: DecisionRecord | "off" = "off";
  if (need && whole.ok && whole.text && decider) {
    const found = await findInPage(decider, url, whole, need, step);
    // What it found is the whole page's, whatever part the call named: the sift line says which of the call's bounds
    // that leaves aside, so a call reading on with an objective is not handed the same chunks as if they were new.
    const ignored = [...(options.offset ? ["offset"] : []), ...(options.maxChars === undefined ? [] : ["max_chars"])];
    answer = !found.answer ? notApplied(found.classifier.error!.code) : ignored.length ? { ...found.answer, sift: `${found.answer.sift}; ${ignored.join(" and ")} ignored: found chunks come from the whole page, each with its offset` } : found.answer;
    classifier = found.classifier;
  } else if (decider) {
    ({ answer, classifier } = await judgePart(decider, url, part, { task: options.task, ...step }));
    // A first part that left passages out lists again the links only they wrote: what it lists is checked against the
    // text the model is given, never the part before judging.
    if (whole.ok && whole.written && !(part.offset ?? 0) && "text" in answer && answer.text !== part.text) answer = { ...answer, ...unwrittenLinks(whole.written, answer.text) };
  }
  else if (need && whole.ok && whole.text) answer = notApplied("no classifier in this run");
  const guard = await guarding;
  options.lines.push(...guardLines);
  if (guard?.warning) answer = { ...answer, warning: guard.warning };
  return { answer, classifier, ...(guard ? { guard } : {}) };
}
