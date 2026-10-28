// A pi run's model request is marked on the run's root before it leaves (REQUEST_STARTED) and as its stream ends
// (REQUEST_ENDED). pi writes a request's entry only once its answer has content, so one cut before that (a stop, a
// crash) would leave nothing to count; with the marks, the timeline counts it and reads the run's cost unknown, while
// a request still in flight reads as the sum so far. Only `streamSimple`, the generation's request: pi's
// compaction completes its summary another way and is not a request of the run's turns.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import type { DurableRun } from "@parcha/pi-durable-disk";

/** `models` with each generation request marked before it leaves, once `open` hands over the run (its Harness). */
export async function markRequests<M extends Models>(models: M): Promise<{ models: M; open(run: DurableRun): void }> {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  let open!: (run: DurableRun) => void;
  // A request a resumed turn sends before the app's open waits for it: the mark needs the run's store.
  const opened = new Promise<DurableRun>((resolve) => (open = resolve));
  const mark = async (kind: string) => {
    const run = await opened;
    await run.harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data: {} })), BACKGROUND_CONTEXT);
  };
  const failed = (model: Model<Api>, error: unknown): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    errorMessage: `the model request was not sent: its mark could not be written (${String((error as Error)?.message ?? error).slice(0, 200)})`,
  });
  const streamSimple = (model: Model<Api>, context: Context, options?: Parameters<Models["streamSimple"]>[2]) => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      try {
        await mark(REQUEST_STARTED);
      } catch (error) {
        const message = failed(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
        return;
      }
      const inner = models.streamSimple(model, context, options);
      for await (const event of inner) outer.push(event);
      const result = await inner.result();
      // Its end, before pi reads the answer: a store that cannot take it is the run's to fail on, as for any write.
      await mark(REQUEST_ENDED).catch(() => undefined);
      outer.end(result);
    })();
    return outer;
  };
  const proxy = new Proxy(models, {
    get: (target, key) => {
      if (key === "streamSimple") return streamSimple;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models: proxy, open };
}
