// The trained model as a pi-ai provider: `tab-local`, whose one model is the 1B the run trained and this page loaded. The Harness talks to it like any
// provider: a pi Context in, a stream of pi events out. Everything model-specific stays in the 04 tab's ModelHost (two-phase decoding, budgets, stray tags,
// the dark-content judge between the stream and the screen): this file only converts.
//   in:  the history policy (04 tab, src/history.ts): no system prompt, no tools, no tool results, NEVER an earlier turn's thinking; `last` carries the
//        previous exchange's answer text, `none` nothing. A conversation WITH tools (one configured onto this model, see brain.ts) is read through a window instead
//        (tool-window.ts): the tool prompt, the previous exchange if this model gave it, and the current task with this model's own tool loop; never the trip.
//        The format of calls and results is the `ToolFormat` seam (tool-format.ts).
//   out: `<thinking>...</thinking>` becomes a pi `thinking` block and the rest a `text` block (with tools, the reply's calls become `toolCall` blocks and the stop
//        reason `toolUse`), only ever judged text. A held answer is ONE text block, the
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
import { PLACEHOLDER_FORMAT, type ToolFormat } from "./tool-format.ts";
import { hasTools, windowWithPrompt } from "./tool-window.ts";

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

/** The newest user message of a pi transcript: the question the judge reads an answer against, even when the model's last turn read a tool result. */
const questionOf = (messages: readonly { role: string; content?: unknown }[]): string => {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? (m.content as { type?: string; text?: string }[]).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") : "";
};

export function streamBrain(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options?: { signal?: AbortSignal }, format: ToolFormat = PLACEHOLDER_FORMAT): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
  void (async () => {
    try {
      const tooled = hasTools(context.messages as { role: string }[]);
      const messages = tooled ? windowWithPrompt(context.messages as never, { provider: BRAIN_PROVIDER, format, mode: brain.historyMode() }) : chatMessages(context.messages as { role: string }[], brain.historyMode());
      const last = messages.at(-1);
      if (!last || last.role !== "user") throw new Error("nothing to answer: the conversation has no user message");
      const input = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
      stream.push({ type: "start", partial: output });
      // the blocks as the judged text grows: thinking first, then the answer; each only ever grows
      let thinking = "", answer = "", thinkingAt = -1, textAt = -1;
      const show = (raw: string, final?: boolean) => {
        const s = splitThinking(raw, final);
        if (tooled) s.answer = format.visible(s.answer); // a reader never sees a call's markup
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
      const r = await brain.generate(tooled ? questionOf(context.messages as never) : last.content, messages, show, options?.signal);
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
        // with tools the reply is prose and calls (the format says which); a reply whose call does not parse stays text, so the loop goes on and the model sees its own words
        const parsed = tooled ? format.parse(s.answer) : { text: s.answer, calls: [], error: undefined as string | undefined };
        const calls = parsed.error ? [] : parsed.calls;
        const prose = tooled && !parsed.error ? parsed.text : s.answer;
        output.content = [
          ...(s.thinking ? [{ type: "thinking" as const, thinking: s.thinking }] : []),
          ...(prose ? [{ type: "text" as const, text: prose }] : []),
          ...calls.map((c, i) => ({ type: "toolCall" as const, id: `tl-${Date.now().toString(36)}-${i}`, name: c.name, arguments: c.arguments as never })),
        ];
        if (thinkingAt >= 0 && textAt < 0) stream.push({ type: "thinking_end", contentIndex: thinkingAt, content: thinking, partial: output });
        if (textAt >= 0) stream.push({ type: "text_end", contentIndex: textAt, content: prose, partial: output });
        output.stopReason = calls.length ? "toolUse" : r.cut ? "length" : "stop";
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
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
export function brainProvider(brain: BrainModel, model: Model<typeof BRAIN_API>, format: ToolFormat = PLACEHOLDER_FORMAT): Provider {
  const run = (m: Model<string>, c: TranscriptContext, o?: { signal?: AbortSignal }) => streamBrain(brain, m, c, o, format);
  return createProvider({
    id: BRAIN_PROVIDER,
    name: "The model this run trained (in this tab)",
    auth: { apiKey: { name: "local model", resolve: async () => ({ auth: { apiKey: "local" } }) } },
    models: [model],
    api: { stream: run as never, streamSimple: run as never },
  });
}
