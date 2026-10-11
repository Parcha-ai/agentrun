// The trained model as a pi-ai provider: `tab-local`, whose one model is the 1B the run trained and this page loaded. The Harness talks to it like any
// provider: a pi Context in, a stream of pi events out. Everything model-specific stays in the 04 tab's ModelHost (two-phase decoding, budgets, stray tags,
// the dark-content judge between the stream and the screen): this file only converts.
//   in:  the history policy (04 tab, src/history.ts): no system prompt, no tools, no tool results, NEVER an earlier turn's thinking; `last` carries the
//        previous exchange's answer text, `none` nothing.
//   out: `<thinking>...</thinking>` becomes a pi `thinking` block and the rest a `text` block, only ever judged text. A held answer is ONE text block, the
//        refusal line, marked `rawStopReason: "held_by_judge"`: nothing of the held answer or its thinking is in the stream or in the transcript.
//   also: abort (the request's signal), usage (output tokens counted by the model; input estimated at 4 characters a token, the model gives no count), a
//        length stop when the answer was cut at its budget.
// Portable: no Node API.
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, Provider, TranscriptContext, Usage } from "@earendil-works/pi-ai";
import { REFUSAL } from "../../04-walks-home/tab/src/guard.ts";
import { chatMessages, HELD, type HistoryMode } from "../../04-walks-home/tab/src/history.ts";
import type { Answered, ChatMsg } from "../../04-walks-home/tab/src/modelhost.ts";
import { splitThinking } from "../../04-walks-home/tab/src/thinking.ts";

export const BRAIN_PROVIDER = "tab-local";
export const BRAIN_API = "tab-local";
/** `rawStopReason` of a held answer. */
export const HELD_MARK = HELD;

/** What the provider needs of the page's model: ModelHost's gated generation and its settings. */
export interface BrainModel {
  generate(prompt: string, messages: ChatMsg[], show: (shownRaw: string, final?: boolean) => void, signal?: AbortSignal): Promise<Answered>;
  historyMode(): HistoryMode;
  state(): { sampling: { max_tokens: number }; size_bytes: number | null };
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The model entry the Harness selects: `{provider: "tab-local", modelId}`. */
export function brainModel(modelId: string, name: string, contextWindow: number, maxTokens: number): Model<typeof BRAIN_API> {
  return { id: modelId, name, api: BRAIN_API, provider: BRAIN_PROVIDER, baseUrl: "tab-local:", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
}

export function streamBrain(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options?: { signal?: AbortSignal }): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
  void (async () => {
    try {
      const messages = chatMessages(context.messages as { role: string }[], brain.historyMode());
      const last = messages.at(-1);
      if (!last || last.role !== "user") throw new Error("nothing to answer: the conversation has no user message");
      const input = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
      stream.push({ type: "start", partial: output });
      // the blocks as the judged text grows: thinking first, then the answer; each only ever grows
      let thinking = "", answer = "", thinkingAt = -1, textAt = -1;
      const show = (raw: string, final?: boolean) => {
        const s = splitThinking(raw, final);
        if (s.thinking !== null && s.thinking.startsWith(thinking) && s.thinking.length > thinking.length) {
          if (thinkingAt < 0) { thinkingAt = output.content.push({ type: "thinking", thinking: "" }) - 1; stream.push({ type: "thinking_start", contentIndex: thinkingAt, partial: output }); }
          const delta = s.thinking.slice(thinking.length);
          thinking = s.thinking;
          (output.content[thinkingAt] as { thinking: string }).thinking = thinking;
          stream.push({ type: "thinking_delta", contentIndex: thinkingAt, delta, partial: output });
        }
        if (s.answer.startsWith(answer) && s.answer.length > answer.length) {
          if (thinkingAt >= 0 && textAt < 0) stream.push({ type: "thinking_end", contentIndex: thinkingAt, content: thinking, partial: output });
          if (textAt < 0) { textAt = output.content.push({ type: "text", text: "" }) - 1; stream.push({ type: "text_start", contentIndex: textAt, partial: output }); }
          const delta = s.answer.slice(answer.length);
          answer = s.answer;
          (output.content[textAt] as { text: string }).text = answer;
          stream.push({ type: "text_delta", contentIndex: textAt, delta, partial: output });
        }
      };
      const r = await brain.generate(last.content, messages, show, options?.signal);
      output.usage = { ...zeroUsage(), input, output: r.tokens, totalTokens: input + r.tokens };
      if (r.aborted || options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else if (r.refused) {
        // the reader saw the refusal line in place of the answer: that is all the transcript keeps
        output.content = [{ type: "text", text: REFUSAL }];
        output.rawStopReason = HELD;
        stream.push({ type: "done", reason: "stop", message: output });
      } else {
        const s = splitThinking(r.text, true);
        output.content = [...(s.thinking ? [{ type: "thinking" as const, thinking: s.thinking }] : []), ...(s.answer ? [{ type: "text" as const, text: s.answer }] : [])];
        if (thinkingAt >= 0 && textAt < 0) stream.push({ type: "thinking_end", contentIndex: thinkingAt, content: thinking, partial: output });
        if (textAt >= 0) stream.push({ type: "text_end", contentIndex: textAt, content: s.answer, partial: output });
        output.stopReason = r.cut ? "length" : "stop";
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
    }
    stream.end();
  })();
  return stream;
}

/** The provider, for `models.setProvider(...)` once the page has the model loaded. */
export function brainProvider(brain: BrainModel, model: Model<typeof BRAIN_API>): Provider {
  const run = (m: Model<string>, c: TranscriptContext, o?: { signal?: AbortSignal }) => streamBrain(brain, m, c, o);
  return createProvider({
    id: BRAIN_PROVIDER,
    name: "The model this run trained (in this tab)",
    auth: { apiKey: { name: "local model", resolve: async () => ({ auth: { apiKey: "local" } }) } },
    models: [model],
    api: { stream: run as never, streamSimple: run as never },
  });
}
