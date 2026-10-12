// The trained model as a pi-ai provider: `tab-local`, whose one model is the 1B the run trained and this page loaded. The Harness talks to it like any
// provider: a pi Context in, a stream of pi events out. Everything model-specific stays in the 04 tab's ModelHost (two-phase decoding, budgets, stray tags,
// the dark-content judge between the stream and the screen): this file only converts.
//   in:  the history policy (04 tab, src/history.ts): no system prompt, no tools, no tool results, NEVER an earlier turn's thinking; `last` carries the
//        previous exchange's answer text, `none` nothing. A conversation WITH tools (one configured onto this model, brain.ts mode configure) is read through a
//        window (tool-window.ts) rendered by the shared format module (tool-format.ts, D1's: the bytes training saw), and each turn is decoded raw (decode.ts:
//        capped thinking, free text until <tool_call>, then the call body under the format's grammar) with no judge.
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
import { decodeTurn, toPiContent, type DecodedTurn } from "./decode.ts";
import { CHARS_PER_TOKEN, CONTEXT_TOKENS, hasTools, toolPrompt } from "./tool-window.ts";
import { nativeContent, nativeTurn, toolProperties } from "./native-turn.ts";
import type { ToolChatRequest, ToolChatResult, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";

export const BRAIN_PROVIDER = "tab-local";
export const BRAIN_API = "tab-local";
/** `rawStopReason` of a held answer. */
export const HELD_MARK = HELD;

/** What the provider needs of the page's model: ModelHost's gated generation (chat) or its raw completion (tool turns), and its settings. */
export interface BrainModel {
  generate(prompt: string, messages: ChatMsg[], show: (shownRaw: string, final?: boolean) => void, signal?: AbortSignal): Promise<Answered>;
  /** Tool turns: a backend over the model's raw completion, for decode.ts. */
  withBackend<T>(use: (backend: { complete(req: { prompt: string; maxTokens: number; stop?: string[]; grammar?: string }): Promise<{ text: string; stoppedBy: "eog" | "stop" | "length"; promptTokens: number; outputTokens: number; timings?: Record<string, number>; ms?: number }> }) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Native tool template: one chat turn with the model's own template (ModelHost.toolChat); absent for a model that is decoded in the trained format. */
  toolChat?(req: ToolChatRequest, signal?: AbortSignal): Promise<ToolChatResult>;
  historyMode(): HistoryMode;
  state(): { sampling: { max_tokens: number }; size_bytes: number | null };
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The model entry the Harness selects: `{provider: "tab-local", modelId}`. */
export function brainModel(modelId: string, name: string, contextWindow: number, maxTokens: number): Model<typeof BRAIN_API> {
  return { id: modelId, name, api: BRAIN_API, provider: BRAIN_PROVIDER, baseUrl: "tab-local:", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
}

/** How a tool turn is decoded, and what each turn reports (for the page and the checks). */
export interface ToolDecoding {
  /** The thinking is closed after this many tokens. */
  thinkTokens: number;
  /** The text before a call, or the final answer. */
  answerTokens: number;
  /** The call body. */
  callTokens: number;
  /**
   * What of the earlier conversation the window carries. "none" (default): the current task alone, as the model was trained (one task per trajectory, the spec, then the task). "last": the
   * previous exchange too. Measured (real Chrome, the 71% model): with "last" the model, shown a previous task answered in one line with no tool call (the window carries the answer, not the
   * tool loop), answered the next task the same way, without calling a tool, in 3 of 3 runs after a reload.
   */
  history?: "none" | "last";
  /** "lazy": ONE completion, the grammar engaging on <tool_call> (default). "grammar": three completions, the body under the grammar. "free": one plain generation. */
  mode: "grammar" | "lazy" | "free" | "native";
  /** `native`: the system prompt of the model's own template, the context it was loaded with (tokens), the model's view of the tools (e.g. the skills that exist), and whether its template thinks (off: measured). */
  system?: string;
  nCtx?: number;
  refine?: (tools: ToolChatTool[]) => ToolChatTool[];
  /** Awaited before each native turn is built: refresh whatever `refine` reads (the skills that came home), so a change reaches the very next request. */
  prepare?: () => Promise<void>;
  templateThinking?: boolean;
  /** A task that has taken this many of the model's own turns without an answer ends with a plain line instead of another model call (a small model stuck repeating one call would otherwise run for ever, each turn about ten seconds). Default 16. */
  maxSteps?: number;
  /** Called once per decoded turn, with how long it took and what it cost. */
  onTurn?(turn: { ms: number; tokensPerSecond: number | null; decoded: DecodedTurn; callId: string; prompt: string; completions: { ms: number | undefined; promptTokens: number; outputTokens: number; stoppedBy: string; timings?: Record<string, number> }[] }): void;
}

export const DEFAULT_MAX_STEPS = 16;
export const DEFAULT_TOOL_DECODING: ToolDecoding = { thinkTokens: 64, answerTokens: 200, callTokens: 512, mode: "lazy", history: "none" };

export function streamBrain(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options?: { signal?: AbortSignal }, decoding: ToolDecoding = DEFAULT_TOOL_DECODING): AssistantMessageEventStream {
  if (hasTools(context.messages as { role: string }[])) return decoding.mode === "native" && brain.toolChat ? streamNative(brain, model, context, options, decoding) : streamTools(brain, model, context, options, decoding);
  return streamChat(brain, model, context, options);
}

/** A turn of a conversation that has tools: the window rendered by the format, decoded raw, the reply turned into pi's blocks. */
function streamTools(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options: { signal?: AbortSignal } | undefined, d: ToolDecoding): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
  void (async () => {
    try {
      const { prompt, tools, window, steps } = toolPrompt(context.messages as never, { provider: BRAIN_PROVIDER, mode: d.history ?? "none", maxPromptChars: Math.max(0, (CONTEXT_TOKENS - d.thinkTokens - Math.max(d.answerTokens, d.callTokens)) * CHARS_PER_TOKEN) });
      if (!window.some((m) => m.role === "user")) throw new Error("nothing to answer: the conversation has no user message");
      stream.push({ type: "start", partial: output });
      if (steps >= (d.maxSteps ?? DEFAULT_MAX_STEPS)) {
        const line = `I stopped after ${steps} steps without finishing. Tell me how you want me to go on.`;
        output.content = [{ type: "text", text: line }];
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: line, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: line, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      const started = performance.now();
      const callId = `tl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const completions: { ms: number | undefined; promptTokens: number; outputTokens: number; stoppedBy: string; timings?: Record<string, number> }[] = [];
      const decoded = await brain.withBackend((backend) => decodeTurn({ complete: async (req) => { const r = await backend.complete(req); completions.push({ ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, stoppedBy: r.stoppedBy, ...(r.timings ? { timings: r.timings } : {}) }); return r; } }, prompt, { mode: d.mode === "native" ? "lazy" : d.mode, thinkTokens: d.thinkTokens, answerTokens: d.answerTokens, callTokens: d.callTokens, tools }), options?.signal);
      const ms = performance.now() - started;
      d.onTurn?.({ ms, tokensPerSecond: decoded.outputTokens > 0 && ms > 0 ? decoded.outputTokens / (ms / 1000) : null, decoded, callId, prompt, completions });
      output.usage = { ...zeroUsage(), input: decoded.promptTokens, output: decoded.outputTokens, totalTokens: decoded.promptTokens + decoded.outputTokens };
      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else {
        const { content, stopReason } = toPiContent(decoded.parsed, callId);
        output.content = content.filter((b) => !(b.type === "thinking" && b.thinking === "")) as never;
        output.stopReason = stopReason === "stop" && decoded.cut ? "length" : stopReason;
        output.content.forEach((block, i) => {
          if (block.type === "thinking") { stream.push({ type: "thinking_start", contentIndex: i, partial: output }); stream.push({ type: "thinking_delta", contentIndex: i, delta: block.thinking, partial: output }); stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output }); }
          else if (block.type === "text") { stream.push({ type: "text_start", contentIndex: i, partial: output }); stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: output }); stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output }); }
          else if (block.type === "toolCall") { stream.push({ type: "toolcall_start", contentIndex: i, partial: output }); stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output }); }
        });
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

/** A turn for a model with its own tool template: its jinja renders the tools and the window, its tool_calls come back (native-turn.ts). */
function streamNative(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options: { signal?: AbortSignal } | undefined, d: ToolDecoding): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
  void (async () => {
    try {
      const maxTokens = d.answerTokens + d.callTokens;
      await d.prepare?.();
      const turn = nativeTurn(context.messages as never, { provider: BRAIN_PROVIDER, mode: d.history ?? "none", ...(d.system ? { system: d.system } : {}), ...(d.refine ? { refine: d.refine } : {}), maxChars: Math.max(0, ((d.nCtx ?? 4096) - maxTokens) * CHARS_PER_TOKEN) });
      if (!turn.messages.some((m) => m.role === "user")) throw new Error("nothing to answer: the conversation has no user message");
      stream.push({ type: "start", partial: output });
      if (turn.steps >= (d.maxSteps ?? DEFAULT_MAX_STEPS)) {
        const line = `I stopped after ${turn.steps} steps without finishing. Tell me how you want me to go on.`;
        output.content = [{ type: "text", text: line }];
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: line, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: line, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      const started = performance.now();
      const r = await brain.toolChat!({ messages: turn.messages, tools: turn.tools, toolChoice: "auto", maxTokens, templateKwargs: { enable_thinking: d.templateThinking === true } }, options?.signal);
      const names = turn.tools.map((t) => t.function.name);
      const { content, calls, problems } = nativeContent(r, names, toolProperties(turn.tools));
      const ms = performance.now() - started;
      d.onTurn?.({ ms, tokensPerSecond: r.outputTokens > 0 && ms > 0 ? r.outputTokens / (ms / 1000) : null, callId: `nt-${Date.now().toString(36)}`, prompt: JSON.stringify({ messages: turn.messages.length, tools: turn.tools.length, dropped: turn.dropped }), completions: [{ ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, stoppedBy: r.stoppedBy }],
        decoded: { promptTokens: r.promptTokens, outputTokens: r.outputTokens, thinkTokens: 0, calls, thinkingCut: false, cut: r.stoppedBy === "length", raw: r.text, parsed: { ...(calls > 0 ? { call: { name: (content.find((b) => b.type === "toolCall") as { name: string }).name, arguments: (content.find((b) => b.type === "toolCall") as { arguments: unknown }).arguments } } : {}), ...(problems.length > 0 ? { problem: { kind: "arguments", detail: problems.join("; ") } } : {}) } } as never });
      output.usage = { ...zeroUsage(), input: r.promptTokens, output: r.outputTokens, totalTokens: r.promptTokens + r.outputTokens };
      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else {
        output.content = content as never;
        output.stopReason = calls > 0 ? "toolUse" : r.stoppedBy === "length" ? "length" : "stop";
        output.content.forEach((block, i) => {
          if (block.type === "thinking") { stream.push({ type: "thinking_start", contentIndex: i, partial: output }); stream.push({ type: "thinking_delta", contentIndex: i, delta: block.thinking, partial: output }); stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output }); }
          else if (block.type === "text") { stream.push({ type: "text_start", contentIndex: i, partial: output }); stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: output }); stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output }); }
          else if (block.type === "toolCall") { stream.push({ type: "toolcall_start", contentIndex: i, partial: output }); stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output }); }
        });
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

function streamChat(brain: BrainModel, model: Model<string>, context: TranscriptContext | Context, options?: { signal?: AbortSignal }): AssistantMessageEventStream {
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
export function brainProvider(brain: BrainModel, model: Model<typeof BRAIN_API>, decoding: ToolDecoding = DEFAULT_TOOL_DECODING): Provider {
  const run = (m: Model<string>, c: TranscriptContext, o?: { signal?: AbortSignal }) => streamBrain(brain, m, c, o, decoding);
  return createProvider({
    id: BRAIN_PROVIDER,
    name: "The model this run trained (in this tab)",
    auth: { apiKey: { name: "local model", resolve: async () => ({ auth: { apiKey: "local" } }) } },
    models: [model],
    api: { stream: run as never, streamSimple: run as never },
  });
}
