// A pi run's model request is marked on the run's root before it leaves (REQUEST_STARTED), and again if its stream
// ends aborted (REQUEST_ENDED). pi writes a request's entry when it answers or fails, and when it is aborted only if
// content had streamed, so one cut before that (a stop, a crash) would leave nothing to count; with the marks, the
// timeline counts it and reads the run's cost unknown, while a request still in flight reads as the sum so far.
//
// pi's compaction summary is a paid request too (`completeSimple`), and pi books its usage in its own usage document,
// never as an entry the run's timeline sums. So it is marked the same way (`request: "compaction"`), and its answer's
// cost is written as REQUEST_COST: the run's total, and /usage with it, include it, and one cut before its answer reads
// unknown. Both are wrapped here: `streamSimple` for the generation's requests, `completeSimple` for the summary.
//
// Under a cap (cap.ts), each request comes with the worst case the cap held for it, and the end mark of one stopped
// before its end (or a summary that failed) carries that figure (`heldUsd`): the cap counts the request at it, in a later
// process too. The timeline does not read it, so the run's shown cost is unknown as before. A request the cap refused
// gets a start mark of its own (`capRefused`), written before pi writes its error entry, so that entry answers its own
// mark and never stands for an earlier request a stop or a crash cut.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { CAP_REFUSED_FIELD, HELD_FIELD, HELD_USD } from "./cap.js";
import { RUN_CANCELLED } from "./files.js";

/** Whether the run in `root` (its directory) was cancelled: the mark serve's cancel writes there first. */
export const cancelledIn = (root: string) => () => existsSync(join(root, RUN_CANCELLED));

/** `models` with each generation request marked before it leaves, once `open` hands over the run (its Harness). Once
 *  `cancelled` says the run was cancelled, no request is sent: each is refused here, before it is marked, or after its
 *  mark when the cancel came while the mark waited, and then its start is withdrawn (an end mark, `unsent`). */
export async function markRequests<M extends Models>(models: M, cancelled: () => boolean = () => false, { refusalWaitMs = 60_000 }: { refusalWaitMs?: number } = {}): Promise<{ models: M; open(run: DurableRun): void; refused(): Promise<void> }> {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  let open!: (run: DurableRun) => void;
  // A request a resumed turn sends before the app's open waits for it: the mark needs the run's store.
  const opened = new Promise<DurableRun>((resolve) => (open = resolve));
  const mark = async (kind: string, data: Record<string, string | number | boolean | null> = {}) => {
    const run = await opened;
    await run.harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), BACKGROUND_CONTEXT);
  };
  const failed = (model: Model<Api>, why: string): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    errorMessage: why,
  });
  const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200);
  /** What the run's cap held for a request (its options' HELD_USD), as an end mark's field; none without a cap. */
  const heldOf = (options: unknown): Record<string, number> => {
    const held = (options as Record<symbol, unknown> | undefined)?.[HELD_USD];
    return typeof held === "number" && Number.isFinite(held) ? { [HELD_FIELD]: held } : {};
  };
  /** A cancelled run's request, never sent. It waits for the cancel to reach the run (the request's abort), and then ends
   *  as aborted, as a request the cancel cut does: the turn, or a workflow's node, stops, never failing on the refusal.
   *  serve's cancel aborts a live run's turn and then stops its process, so the wait is short. `refusalWaitMs` is a
   *  backstop for a process the cancel never reaches (an orphan of a server that died in between): it then ends as an
   *  error, and `markRefusal` lets the timeline skip pi's entry for it. */
  const refuse = async (model: Model<Api>, what: string, signal: AbortSignal | undefined, markRefusal: boolean): Promise<AssistantMessage> => {
    if (signal && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, refusalWaitMs);
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
        await mark(REQUEST_STARTED);
      } catch (error) {
        const message = failed(model, `the model request was not sent: its mark could not be written (${reason(error)})`);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
        return;
      }
      if (cancelled()) {
        await mark(REQUEST_ENDED, { unsent: true }).catch(() => undefined);
        return refused();
      }
      let result: AssistantMessage;
      try {
        const inner = models.streamSimple(model, context, options);
        for await (const event of inner) outer.push(event);
        result = await inner.result();
      } catch (error) {
        // A stream that throws instead of ending on an error event still ends the request, as an error, never a hang.
        result = failed(model, `the model request failed: ${reason(error)}`);
        outer.push({ type: "error", reason: "error", error: result });
      }
      // An answer or a failure gets pi's own entry; an abort may get none, so its end is marked, with the provider's id
      // for the request when it named one before the cut (the request joins its record by it). A store that cannot
      // take the mark leaves the request unended, which the timeline also reads as cut, at an unknown cost: the
      // conservative reading, so the failure is swallowed here.
      if (result.stopReason === "aborted") {
        const responseId = (result as { responseId?: unknown }).responseId;
        await mark(REQUEST_ENDED, { ...(typeof responseId === "string" ? { responseId } : {}), ...heldOf(options) }).catch(() => undefined);
      }
      outer.end(result);
    })();
    return outer;
  };
  const COMPACTION = { request: "compaction" };
  const completeSimple = async (model: Model<Api>, context: Context, options?: Parameters<Models["completeSimple"]>[2]): Promise<AssistantMessage> => {
    // A cancelled run sends no summary either; pi writes no entry for a failed summary, so nothing needs marking.
    if (cancelled()) return refuse(model, "summary request", options?.signal, false);
    try {
      await mark(REQUEST_STARTED, COMPACTION);
    } catch (error) {
      return failed(model, `the model request was not sent: its mark could not be written (${reason(error)})`);
    }
    if (cancelled()) {
      await mark(REQUEST_ENDED, { ...COMPACTION, unsent: true }).catch(() => undefined);
      return refuse(model, "summary request", options?.signal, false);
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
    if (result.stopReason === "aborted") await mark(REQUEST_ENDED, { ...COMPACTION, ...heldOf(options) }).catch(() => undefined);
    else {
      const total = result.usage?.cost?.total;
      await mark(REQUEST_COST, { ...COMPACTION, usd: typeof total === "number" ? total : null }).catch(() => undefined);
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
  // The start mark of a generation request the cap refused (capModels), which never left: pi's error entry answers it.
  const refused = () => mark(REQUEST_STARTED, { [CAP_REFUSED_FIELD]: true });
  return { models: proxy, open, refused };
}
