// A pi run's model request is marked on the run's root before it leaves (REQUEST_STARTED), and again if its stream
// ends aborted (REQUEST_ENDED). pi writes a request's entry when it answers or fails, and when it is aborted only if
// content had streamed, so one cut before that (a stop, a crash) would leave nothing to count; with the marks, the
// timeline counts it and reads the run's cost unknown, while a request still in flight reads as the sum so far.
//
// pi's compaction summary is a paid request too (`completeSimple`), and pi books its usage in its own usage document,
// never as an entry the run's timeline sums. So it is marked the same way (`request: "compaction"`), and its answer's
// cost is written as REQUEST_COST: the run's total, and /usage with it, include it, and one cut before its answer reads
// unknown. Both are wrapped here: `streamSimple` for the generation's requests, `completeSimple` for the summary. A
// tool's own request on the run's models (web_search's, hosted-search.ts) is a side request the same way, under its own
// label (sideRequests), and its cost is its tokens' plus the fee its tool names.
//
// Under a cap (cap.ts), each request comes with the worst case the cap held for it, and its start mark carries that
// figure (`heldUsd`), as does the end mark of a summary that failed: the cap counts a request a crash cut at it, in a
// later process too. The end mark of one stopped before its end carries what the cap counts it at given what it streamed
// (cap.ts stoppedFigure: what it streamed and an allowance, never more than its worst case). The timeline does not read it, so the run's shown cost
// is unknown as before. A request the cap refused gets a start mark of its own (`capRefused`), written before pi writes
// its error entry, so that entry answers its own mark and never stands for an earlier request a stop or a crash cut.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { CAP_WRAPUP, REQUEST_COST, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { anyAttemptLost, ATTEMPTS, type Attempt, attemptLost, BOUND_FIELD, BOUND_USD, CAP_REFUSED_FIELD, END_NOT_WRITTEN, CLAMP, HELD_FIELD, HELD_USD, MARK_NOT_WRITTEN, markResponseBegan, piEnded, type RefusalFigures, refusalFields, sideRequests, STOPPED_USD, type Stopped } from "./cap.js";
import { RUN_CANCELLED } from "./files.js";
import { isConnectCode, isGatewayTimeout } from "@parcha/agentrun-kernel";


/** Whether the run in `root` (its directory) was cancelled: the mark serve's cancel writes there first. */
export const cancelledIn = (root: string) => () => existsSync(join(root, RUN_CANCELLED));

/** How long a mark that carries a hold (a lost or failed request's end, an unreadable cost's) may take to reach the store
 *  before the request fails loudly (END_NOT_WRITTEN): 15 s. A lost mark is waited for before the retry is sent, so a
 *  commit queued behind a large entry on a slow disk (seconds) past 1 s let the retry leave, and its answer reach pi,
 *  with no mark in the store: a crash then read the request at the answer's own usage. Such a mark is written only on a
 *  path already lost or failed, so the wait costs latency there and nowhere else; 15 s holds such a commit with room to
 *  spare, and still fails a store that has stopped within a turn's patience, never a turn held without bound. */
export const END_MARK_WAIT_MS = 15_000;
/** How long a stop's mark is waited for before pi has the stopped result: a stop's mark needs no fatal wait (without it
 *  the request reads as cut, at its hold, never less), so a slow store costs a stop at most this. */
const STOP_MARK_WAIT_MS = 1_000;

/** `models` with each generation request marked before it leaves, once `open` hands over the run (its Harness). Once
 *  `cancelled` says the run was cancelled, no request is sent: each is refused here, before it is marked, or after its
 *  mark when the cancel came while the mark waited, and then its start is withdrawn (an end mark, `unsent`). */
export async function markRequests<M extends Models>(models: M, cancelled: () => boolean = () => false, { holdMarkWaitMs = END_MARK_WAIT_MS }: { holdMarkWaitMs?: number } = {}): Promise<{ models: M; open(run: DurableRun): void; refused(figures?: RefusalFigures): Promise<void>; wrapUp(data: { capUsd: number; leftUsd: number; words: string }): void }> {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  let open!: (run: DurableRun) => void;
  // A request a resumed turn sends before the app's open waits for it: the mark needs the run's store.
  const opened = new Promise<DurableRun>((resolve) => (open = resolve));
  type Mark = string | number | boolean | null | { [key: string]: Mark };
  const mark = async (kind: string, data: Record<string, Mark> = {}) => {
    const run = await opened;
    await run.harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), BACKGROUND_CONTEXT);
  };
  const failed = (model: Model<Api>, why: string): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    errorMessage: why,
  });
  const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200);
  /** Whether `work` (a mark's write) is in the store within `holdMarkWaitMs` (END_MARK_WAIT_MS, a test's own when it
   *  gives one): undefined when it is, else why not (its refusal, or the wait run out). */
  const landed = (work: Promise<unknown>): Promise<unknown> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(new Error(`the store had not taken it in ${holdMarkWaitMs} ms`)), holdMarkWaitMs);
    work.then(() => (clearTimeout(timer), resolve(undefined)), (error: unknown) => (clearTimeout(timer), resolve(error ?? new Error("refused"))));
  });
  /** Until `work` settles, or `ms` pass. */
  const within = (work: Promise<unknown>, ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.finally(() => (clearTimeout(timer), resolve()));
  });
  /** What the run's cap held for a request (its options' HELD_USD), as an end mark's field; none without a cap. */
  const heldOf = (options: unknown): Record<string, number> => {
    const held = (options as Record<symbol, unknown> | undefined)?.[HELD_USD];
    return typeof held === "number" && Number.isFinite(held) ? { [HELD_FIELD]: held } : {};
  };
  /** Whether a request the cap watched is lost (piEnded, from the attempts its cap recorded): an error before any event
   *  that left, or an answer after an attempt that was lost. It can have been billed, so it counts at its hold. Only a
   *  request the cap watched (a hold, and its attempts, or null on an API it cannot watch): another is read as before. */
  const lostOf = (options: unknown, message: AssistantMessage): boolean => {
    const record = options as Record<symbol, unknown> | undefined;
    if (typeof record?.[HELD_USD] !== "number" || !record || !(ATTEMPTS in record)) return false;
    return piEnded(message, false, (record[ATTEMPTS] as Attempt[] | null) ?? undefined).end === "lost";
  };
  /** `options` whose fetch writes the request's end mark at its hold (`lost`), once, the moment an attempt is known lost:
   *  a rejection once it could have left (any code but a connect one, and not the run's own stop) or a gateway's timeout
   *  (504, 524), as that attempt's fetch ends; an answer pi-ai then tries again (a 2xx that was not the last), before the
   *  next attempt is sent, since only the retry says so. Whatever follows (a retry's answer, a stop while pi-ai waits to
   *  retry, an error), the provider can have billed the lost attempt, and the mark is in the store before pi's entry for
   *  the request can be, so a later process reads the hold this one books, with no window between them. `options` as
   *  given on a request the cap does not watch. */
  const watchingLost = <O>(options: O, markLost: () => Promise<void>): O => {
    const record = options as (Record<symbol, unknown> & { fetch?: typeof fetch }) | undefined;
    const attempts = record && ATTEMPTS in record ? (record[ATTEMPTS] as Attempt[] | null) : null;
    if (!attempts || typeof record?.[HELD_USD] !== "number" || typeof record.fetch !== "function") return options;
    const inner = record.fetch;
    let marked = false;
    const markOnce = async () => {
      if (marked) return;
      marked = true;
      await markLost().catch(() => undefined);
    };
    /** Whether the attempt the fetch just recorded is lost as it ends, whatever comes after it. */
    const lostNow = () => {
      const last = attempts.at(-1);
      return last !== undefined && ("code" in last ? !last.aborted && !isConnectCode(last.code) : isGatewayTimeout(last.status));
    };
    return { ...record, fetch: (async (input, init) => {
      // An answer pi-ai tries again: lost, as the retry shows.
      if (attempts.some((attempt) => attemptLost(attempt, false))) await markOnce();
      let response: Response;
      try {
        response = await inner(input, init);
      } catch (error) {
        if (lostNow()) await markOnce();
        throw error;
      }
      if (lostNow()) await markOnce();
      return response;
    }) as typeof fetch } as O;
  };
  /** What the run's cap counts a request stopped before its end at, given the answer it had streamed (its options'
   *  STOPPED_USD), as an end mark's field; its worst case when the cap gave no such figure, or when an attempt before the
   *  stop was lost (anyAttemptLost: it can have been billed, and the cap counts it at its hold in this process too); none
   *  without a cap. The one figure every stop's end mark carries, a generation's and a summary's. */
  const stoppedOf = (options: unknown, message: AssistantMessage): Record<string, number> => {
    const attempts = (options as Record<symbol, unknown> | undefined)?.[ATTEMPTS] as Attempt[] | null | undefined;
    if (anyAttemptLost(attempts ?? undefined)) return heldOf(options);
    const stopped = (options as Record<symbol, unknown> | undefined)?.[STOPPED_USD] as Stopped | undefined;
    const figure = typeof stopped === "function" ? stopped(message) : undefined;
    return typeof figure === "number" && Number.isFinite(figure) ? { [HELD_FIELD]: figure } : heldOf(options);
  };
  /** A request's bound (BOUND_FIELD, when above 0: the run's cost serves it while the request is in flight), as its
   *  start mark keeps it. */
  const boundOf = (options: unknown): Record<string, number> => {
    const bound = (options as Record<symbol, unknown> | undefined)?.[BOUND_USD];
    return typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? { [BOUND_FIELD]: bound } : {};
  };
  /** A start mark's figures: what the cap held it at, its bound, and what the cap limited its output to when it did
   *  (CLAMP), so a reply cut short there says so on the run's timeline. */
  const startOf = (options: unknown): Record<string, Mark> => {
    const clamp = (options as Record<symbol, unknown> | undefined)?.[CLAMP] as { tokens?: unknown; leftUsd?: unknown; capUsd?: unknown } | undefined;
    const kept: Record<string, Mark> = clamp && typeof clamp.tokens === "number" && typeof clamp.leftUsd === "number" && typeof clamp.capUsd === "number" ? { clamp: { tokens: clamp.tokens, leftUsd: clamp.leftUsd, capUsd: clamp.capUsd } } : {};
    return { ...heldOf(options), ...boundOf(options), ...kept };
  };
  /** A cancelled run's request, never sent. It waits for the cancel to reach the run (the request's abort), and then ends
   *  as aborted, as a request the cancel cut does: the turn, or a workflow's node, stops, never failing on the refusal.
   *  serve's cancel aborts a live run's turn and then stops its process, so the wait is short. Its bound, a minute, is a
   *  backstop for a process the cancel never reaches (an orphan of a server that died in between): it then ends as an
   *  error, and `markRefusal` lets the timeline skip pi's entry for it. */
  const refuse = async (model: Model<Api>, what: string, signal: AbortSignal | undefined, markRefusal: boolean): Promise<AssistantMessage> => {
    if (signal && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
    if (signal?.aborted) return { ...failed(model, ""), stopReason: "aborted", errorMessage: undefined } as AssistantMessage;
    if (markRefusal) await mark(REQUEST_REFUSED).catch(() => undefined);
    return failed(model, `the run was cancelled: the ${what} was not sent`);
  };
  const streamSimple = (model: Model<Api>, context: Context, options?: Parameters<Models["streamSimple"]>[2]) => {
    const outer = createAssistantMessageEventStream();
    const refused = async () => {
      const message = await refuse(model, "model request", options?.signal, true);
      outer.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      outer.end(message);
    };
    void (async () => {
      if (cancelled()) return refused();
      try {
        await mark(REQUEST_STARTED, startOf(options));
      } catch (error) {
        const message = failed(model, `${MARK_NOT_WRITTEN} (${reason(error)})`);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
        return;
      }
      if (cancelled()) {
        await mark(REQUEST_ENDED, { unsent: true }).catch(() => undefined);
        return refused();
      }
      let result: AssistantMessage;
      // Whether the provider's response had begun (an event came in) by the time the request ended.
      let began = false;
      // The stream's error event, passed on once the request's end is marked (below): the outer stream's result, which
      // pi writes as the entry and the cap counts, settles on that event.
      let failure: Parameters<typeof outer.push>[0] | undefined;
      // Its done event, held the same way: the stream's result settles on it too, so pi has an answer only once its mark
      // that carries a hold (a lost or unpriced request's) is in the store, and its entry always comes after that mark.
      let done: Parameters<typeof outer.push>[0] | undefined;
      // Marked lost before pi-ai tries again (watchingLost): its end mark is in the store before its answer can be.
      let lostMarked = false;
      // Its write refused: the request's end is not recorded, and the request fails saying so (END_NOT_WRITTEN).
      let lostRefused: unknown;
      const sent = watchingLost(options, async () => {
        lostMarked = true;
        lostRefused = await landed(mark(REQUEST_ENDED, { lost: true, ...heldOf(options) }));
      });
      try {
        const inner = models.streamSimple(model, context, sent);
        for await (const event of inner) {
          if (event.type === "error") {
            failure = event;
            continue;
          }
          began = true;
          if (event.type === "done") {
            done = event;
            continue;
          }
          outer.push(event);
        }
        result = await inner.result();
      } catch (error) {
        // A stream that throws instead of ending on an error event still ends the request, as an error, never a hang.
        result = failed(model, `the model request failed: ${reason(error)}`);
        failure = { type: "error", reason: "error", error: result };
      }
      // An answer or a failure gets pi's own entry; an abort may get none, so its end is marked, with the provider's id
      // for the request when it named one before the cut (the request joins its record by it). A store that cannot
      // take the mark leaves the request unended, which the timeline also reads as cut, at an unknown cost: the
      // conservative reading, so the failure is swallowed here.
      let ending: Promise<void> | undefined;
      // Whether `ending` carries the hold a later process must read (an error's or a lost request's): it is in the store
      // before pi has the result, however long the store takes, and a refused one fails the request loudly. A stop's
      // mark keeps its bound: without it the request stays open, read at its hold, which is never less.
      let holding = false;
      // An answer whose cost cannot be read counts at its hold (the booking rule), in this process and in a later one: its
      // end mark carries the hold (`unpriced`), in the store before pi has the answer, as a lost request's does.
      const total = result.usage?.cost?.total;
      const unpriced = result.stopReason !== "error" && result.stopReason !== "aborted" && !(typeof total === "number" && Number.isFinite(total)) && Object.keys(heldOf(options)).length > 0;
      // A request marked lost before its retry was sent has its end in the store already, at its hold: nothing more.
      if (lostMarked) {
        if (result.stopReason === "error" && failure?.type === "error") markResponseBegan(failure.error);
      } else if (result.stopReason === "aborted") {
        // Reached only with no lost attempt: watchingLost sets `lostMarked` synchronously, before it awaits the mark, the
        // moment an attempt is lost, and that mark lands before pi-ai's retry sleep, so a stop in the sleep finds it set.
        const responseId = (result as { responseId?: unknown }).responseId;
        ending = mark(REQUEST_ENDED, { ...(typeof responseId === "string" ? { responseId } : {}), ...stoppedOf(options, result) });
      } else if (result.stopReason === "error" && (began || lostOf(options, result))) {
        // An error after its response began (an overload part way, a reset): its usage is what had streamed, not what the
        // provider can have billed. Its message is recorded (markResponseBegan), which the cap counts at its hold in this
        // process, and its end is marked with the hold (`error`), which the spend read back counts. One before any event
        // (a 429, a 5xx) is refused unbilled, and counts at its own usage.
        markResponseBegan(result);
        if (failure?.type === "error") markResponseBegan(failure.error);
        ending = mark(REQUEST_ENDED, { error: true, ...heldOf(options) });
        holding = true;
      } else if (unpriced) {
        ending = mark(REQUEST_ENDED, { unpriced: true, ...heldOf(options) });
        holding = true;
      }
      // The end mark goes in before pi has the result, so the store holds it before pi's entry; a store that has not taken
      // it in END_MARK_WAIT_MS does not hold the turn. One that carries a hold and is not in the store by then (refused, or
      // still being written) fails the request loudly (END_NOT_WRITTEN): pi's entry for it then leaves its start open, read
      // at its hold (spentIn), so no store's pace stands between a crash and a request read at less than it can have cost.
      // A stop's mark needs none of that: without it the request reads as cut, at its hold, which is never less.
      let unrecorded = lostRefused;
      if (ending && holding) unrecorded = await landed(ending);
      else if (ending) await within(ending.catch(() => undefined), STOP_MARK_WAIT_MS);
      if (unrecorded !== undefined && result.stopReason !== "aborted") {
        result = failed(model, `${END_NOT_WRITTEN} (${reason(unrecorded)})`);
        failure = { type: "error", reason: "error", error: result };
      }
      // A request whose end could not be recorded fails loudly (failure, above) in place of its answer.
      if (failure) outer.push(failure);
      else if (done) outer.push(done);
      outer.end(result);
    })();
    return outer;
  };
  const completeSimple = async (model: Model<Api>, context: Context, options?: Parameters<Models["completeSimple"]>[2]): Promise<AssistantMessage> => {
    const side = sideRequests.get(context);
    // Its label, and an id of its own: such requests run inside tool calls, which pi runs side by side, so its marks name
    // it (bounds.ts closes its bound by it).
    const COMPACTION = { request: side?.label ?? "compaction", requestId: randomUUID() };
    const what = side ? `${side.label} request` : "summary request";
    // A cancelled run sends no summary either; pi writes no entry for a failed summary, so nothing needs marking.
    if (cancelled()) return refuse(model, what, options?.signal, false);
    try {
      await mark(REQUEST_STARTED, { ...COMPACTION, ...heldOf(options), ...boundOf(options) });
    } catch (error) {
      return failed(model, `${MARK_NOT_WRITTEN} (${reason(error)})`);
    }
    if (cancelled()) {
      await mark(REQUEST_ENDED, { ...COMPACTION, unsent: true }).catch(() => undefined);
      return refuse(model, what, options?.signal, false);
    }
    let result: AssistantMessage;
    try {
      result = await models.completeSimple(model, context, options);
    } catch (error) {
      await mark(REQUEST_ENDED, { ...COMPACTION, ...heldOf(options) }).catch(() => undefined);
      throw error;
    }
    // Its cost closes it; an abort, as for a generation's request, closes it unpriced. A store that cannot take either
    // leaves it open, which reads as cut, at an unknown cost.
    if (result.stopReason === "aborted") await mark(REQUEST_ENDED, { ...COMPACTION, ...stoppedOf(options, result) }).catch(() => undefined);
    else {
      const total = result.usage?.cost?.total;
      // A side request's fee is its cost too, on the answer as well: the cap counts the answer's total (cap.ts).
      const usd = typeof total === "number" ? total + (side?.feeUsd() ?? 0) : null;
      if (side && usd !== null) result.usage.cost.total = usd;
      // Its tokens, in pi's shape, when pi counted any: zeros are no count.
      const u = result.usage;
      const usage = u && u.input + u.output + u.cacheRead + u.cacheWrite > 0 ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } : undefined;
      // One that ended on an error after its response began (it holds content or a token count; a summary has no events
      // to read) counts at its hold: it says so, and carries it. One before any of that counts at its own usage.
      const began = result.stopReason === "error" && (usage !== undefined || result.content.length > 0);
      if (began) markResponseBegan(result);
      // Failed before any response, it counts at its hold too unless it provably never left (piEnded): the same figure the
      // cap books in this process, which a later process reads from this mark.
      // An answer whose cost cannot be read counts at its hold too (the booking rule), which its mark carries.
      const failure = began || lostOf(options, result) ? { failed: true, ...heldOf(options) } : result.stopReason !== "error" && !(typeof usd === "number" && Number.isFinite(usd)) && Object.keys(heldOf(options)).length > 0 ? { unpriced: true, ...heldOf(options) } : {};
      await mark(REQUEST_COST, usage ? { ...COMPACTION, usd, usage: usage as never, ...failure } : { ...COMPACTION, usd, ...failure }).catch(() => undefined);
    }
    return result;
  };
  const proxy = new Proxy(models, {
    get: (target, key) => {
      if (key === "streamSimple") return streamSimple;
      if (key === "completeSimple") return completeSimple;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The start mark of a generation request the cap refused (capModels), which never left: pi's error entry answers it. A
  // refusal for room keeps its figures on it (what the cap counted as taken, and the least the request needed).
  const refused = (figures?: RefusalFigures) => mark(REQUEST_STARTED, { [CAP_REFUSED_FIELD]: true, ...refusalFields(figures) });
  // The wrap-up's row (cap.ts capModels' `wrapUp`): what the run's model was told near its cap, on the root.
  const wrapUp = (data: { capUsd: number; leftUsd: number; words: string }) => void mark(CAP_WRAPUP, data).catch(() => undefined);
  return { models: proxy, open, refused, wrapUp };
}
