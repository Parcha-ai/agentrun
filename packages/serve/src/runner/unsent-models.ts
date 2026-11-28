import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

/** The members of Models that send a request to a model, each with its options (and their abort signal) third. */
const SENDS = new Set<PropertyKey>(["stream", "streamSimple", "streamDeferred", "complete", "completeSimple", "fetchDeferred"]);
/** Of those, the ones that answer with an event stream rather than a message. */
const STREAMS = new Set<PropertyKey>(["stream", "streamSimple", "streamDeferred"]);

/** The words an unsent request's message carries. pi never writes them: the request ends only once its task is aborted. */
const UNSENT = "the run's loop was stopped: this request was not sent, and the run's next claim makes it";

/** `models`, whose requests are not sent while `unsent()` says so when one is made (read at each request): such a request
 *  waits for its own abort (its options' signal, the pi task's, aborted when the turn is aborted or the Harness closes)
 *  and then ends aborted, nothing sent. pi reads an answer that comes after its task's abort as no answer at all: it
 *  writes nothing of it, and the task stays where it was for the next Harness to run. A request with no signal ends
 *  aborted at once. Every other member is `models`'s own. */
export function unsentWhile(models: Models, unsent: () => boolean): Models {
  return new Proxy(models, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (!SENDS.has(key)) return value.bind(target);
      return (model: Model<string>, context: unknown, options?: { signal?: AbortSignal }) => {
        if (!unsent()) return (value as (...args: unknown[]) => unknown).call(target, model, context, options);
        const ended = abortedOf(model, options?.signal);
        if (!STREAMS.has(key)) return ended;
        const stream = createAssistantMessageEventStream();
        void ended.then((message) => {
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        });
        return stream;
      };
    },
  });
}

/** The aborted message of an unsent request on `model`, once `signal` aborts. */
function abortedOf(model: Model<string>, signal: AbortSignal | undefined): Promise<AssistantMessage> {
  const message = (): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "aborted",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    errorMessage: UNSENT,
  }) as AssistantMessage;
  if (!signal || signal.aborted) return Promise.resolve(message());
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(message()), { once: true }));
}
