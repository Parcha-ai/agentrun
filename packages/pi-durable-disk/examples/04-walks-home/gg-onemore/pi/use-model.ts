// The agent switches its own brain: one tool configures the calling conversation (and, optionally, the threads it owns)
// onto a provider for an OpenAI-compatible endpoint, here the steered Qwen3.5-27B that vLLM serves on the GPU box. The
// model a request uses is fixed when the request is prepared, so the switch takes effect from the next request: the rest
// of the very turn that called the tool already comes from the new model, in the same conversation, with its history.
// Portable: no Node API.
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";

/** The diagnostic type on a message the fallback model wrote in place of a broken steered turn; its details are `{ why, from }`. */
export const FALLBACK_DIAGNOSTIC = "steered-fallback";
export const STEERED_PROVIDER = "steered";
export const USE_MODEL_TOOL = "use_model";

/** Where the endpoint is now: `baseUrl` ends in `/v1`. Undefined while there is none. */
export type Endpoint = { readonly baseUrl: string; readonly apiKey: string };

export interface SteeredProviderOptions {
  readonly id?: string;
  readonly modelId: string;
  /** The name the model is registered with: what a page shows for it (default its id). */
  readonly modelName?: string;
  /** Read at every request, so a box created after the Harness opened is reachable without re-registering. */
  readonly endpoint: () => Endpoint | undefined;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** What of the conversation the model is shown; default all of it. */
  readonly window?: (context: TranscriptContext) => TranscriptContext;
  /** A replacement for the HTTP fetch (to record the exact requests). */
  readonly fetch?: typeof globalThis.fetch;
  /** Thinking tokens per level, sent as vLLM's `thinking_token_budget`; default pi-ai's. */
  readonly thinkingBudgets?: ThinkingBudgets;
  /** The model a broken turn (`brokenTurn`) is asked again, with the whole conversation; without it the turn stands as it came. */
  readonly fallback?: (context: TranscriptContext, options: SimpleStreamOptions | undefined) => AssistantMessageEventStream;
  /** Told why a turn went to the fallback. */
  readonly onFallback?: (why: string) => void;
  /** Each thinking delta of the steered stream as it arrives, before the turn is held and checked: a live view of the thinking. */
  readonly onThinking?: (delta: string) => void;
}

/**
 * Why a steered turn cannot stand, or undefined: tool-call markup the server could not parse left in its text, a call to a
 * tool it was not offered or without that tool's required arguments, or a failed request. An aborted turn stands. Each
 * reason finishes the page's sentence "the edited model's turn ..." (D5's fallback line).
 */
export function brokenTurn(message: AssistantMessage, tools: readonly Tool[]): string | undefined {
  if (message.stopReason === "error") return `failed: ${message.errorMessage ?? "no detail"}`;
  for (const part of message.content) {
    if (part.type === "text" && /<tool_call>|<function=/.test(part.text)) return "left tool-call markup the server could not parse";
    if (part.type === "toolCall") {
      const tool = tools.find((t) => t.name === part.name);
      if (!tool) return `called ${part.name}, a tool it was not offered`;
      const required = ((tool.parameters as { required?: unknown }).required ?? []) as string[];
      const missing = required.filter((k) => !(k in (part.arguments ?? {})));
      if (missing.length) return `called ${part.name} without ${missing.join(", ")}`;
    }
  }
  return undefined;
}

/**
 * A window that starts at the switch: the conversation stays one, but the model it switched to is shown `instructions` as
 * its system prompt and only the turns since another model last spoke there: the use_model result (or whatever results
 * that last turn got) opens the window as a user turn. It holds for every conversation configured onto this provider,
 * the caller and its threads alike, because the boundary is read from the turns themselves.
 */
export function sinceSwitch(o: { instructions: string; provider?: string }) {
  const provider = o.provider ?? STEERED_PROVIDER;
  return (context: TranscriptContext): TranscriptContext => {
    const real = context.messages.filter((m) => m.role !== "system");
    let at = -1;
    for (let i = real.length - 1; i >= 0 && at < 0; i--) {
      const m = real[i]!;
      if (m.role === "assistant" && m.provider !== provider && !(m.diagnostics ?? []).some((d) => d.type === FALLBACK_DIAGNOSTIC)) at = i;
    }
    const after = real.slice(at + 1);
    // Results whose call is outside the window cannot go as tool messages (the API needs the call), so they open it as one user turn.
    let lead = 0;
    while (lead < after.length && after[lead]!.role === "toolResult") lead++;
    const opening = after.slice(0, lead).flatMap((m) => (m.role === "toolResult" ? m.content.filter((p) => p.type === "text") : []));
    const messages: Message[] = [...(lead > 0 ? [{ role: "user" as const, content: opening, timestamp: after[0]!.timestamp }] : []), ...after.slice(lead)];
    return normalizeContext({ systemPrompt: o.instructions, messages, tools: getCurrentTools(context.messages) });
  };
}

/** A pi-ai provider on the chat-completions API with vLLM's and Qwen3.5's request shape. */
export function steeredProvider(opts: SteeredProviderOptions) {
  const id = opts.id ?? STEERED_PROVIDER;
  const api = openAICompletionsApi();
  const current = (): Endpoint => {
    const e = opts.endpoint();
    if (!e) throw new Error(`the ${id} endpoint is not up: there is no steered model to talk to yet`);
    return e;
  };
  const at = (model: Model<Api>): Model<Api> => ({ ...model, baseUrl: current().baseUrl });
  const keyed = <T extends StreamOptions | undefined>(options: T): T =>
    ({ ...(opts.thinkingBudgets ? { thinkingBudgets: opts.thinkingBudgets } : {}), ...(options ?? {}), apiKey: current().apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) as T;
  const seen = (context: TranscriptContext) => (opts.window ? opts.window(context) : context);
  const errorTurn = (model: Model<Api>, errorMessage: string): AssistantMessageEvent => ({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    },
  });
  // The thinking is passed on as it arrives; the turn itself still goes through `checked`.
  const live = (model: Model<Api>, run: () => AssistantMessageEventStream): (() => AssistantMessageEventStream) => {
    const onThinking = opts.onThinking;
    if (!onThinking) return run;
    return () => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const e of run()) {
            if (e.type === "thinking_delta") onThinking(e.delta);
            out.push(e);
          }
        } catch (error) {
          out.push(errorTurn(model, `the request threw: ${error instanceof Error ? error.message : String(error)}`));
        } finally {
          out.end();
        }
      })();
      return out;
    };
  };
  // The steered turn is held to its end, then shown as it came or, when broken, replaced by the fallback's turn.
  // The steered turn's thinking goes out as it arrives; the rest of the turn is held to its end, then shown as it came or,
  // when broken, replaced by the fallback's turn after the thinking already shown, marked with a steered-fallback diagnostic.
  const checked = (model: Model<Api>, run: () => AssistantMessageEventStream, context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessageEventStream => {
    const fallback = opts.fallback;
    if (!fallback) return run();
    const out = createAssistantMessageEventStream();
    void (async () => {
      const held: AssistantMessageEvent[] = [];
      let shown: AssistantMessage | undefined;
      let last: AssistantMessage | undefined;
      let threw: string | undefined;
      try {
        for await (const e of run()) {
          if (e.type === "start" || e.type === "thinking_start" || e.type === "thinking_delta" || e.type === "thinking_end") {
            // the stream keeps mutating one partial message, and thinking_end comes once the answer has begun: what goes out is
            // a copy of its thinking as it is now
            shown = { ...e.partial, content: e.partial.content.filter((p) => p.type === "thinking").map((p) => ({ ...p })) };
            out.push({ ...e, partial: shown });
            continue;
          }
          held.push(e);
          if (e.type === "done") last = e.message;
          else if (e.type === "error") last = e.error;
        }
      } catch (error) {
        threw = `the request threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      const why = threw ?? (last === undefined ? "ended without a message" : last.stopReason === "aborted" ? undefined : brokenTurn(last, getCurrentTools(context.messages)));
      if (!why) {
        for (const e of held) out.push(e);
        out.end();
        return;
      }
      // Qwen's thinking comes before its answer, so the blocks already shown are its first ones.
      const thinking = (shown?.content ?? []).filter((p) => p.type === "thinking");
      const diagnostic = { type: FALLBACK_DIAGNOSTIC, timestamp: Date.now(), details: { why, from: `${id}/${opts.modelId}` } };
      const after = <M extends AssistantMessage>(m: M, marked = false): M => ({
        ...m,
        content: [...thinking, ...m.content],
        ...(marked ? { diagnostics: [...(m.diagnostics ?? []), diagnostic] } : {}),
      });
      try {
        opts.onFallback?.(why);
        for await (const e of fallback(context, options)) {
          if (e.type === "start" && shown) continue;
          const moved = "contentIndex" in e ? { ...e, contentIndex: e.contentIndex + thinking.length } : { ...e };
          if ("partial" in moved) moved.partial = after(moved.partial);
          if (moved.type === "done") moved.message = after(moved.message, true);
          if (moved.type === "error") moved.error = after(moved.error, true);
          out.push(moved as AssistantMessageEvent);
        }
      } catch (error) {
        // the replacement failed too: end the turn with an error the caller can retry, never an open stream
        out.push(errorTurn(model, `${why}; the fallback failed: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        out.end();
      }
    })();
    return out;
  };
  return createProvider({
    id,
    name: opts.name ?? id,
    auth: { apiKey: { name: `${id} endpoint key`, resolve: async () => ({ auth: { apiKey: current().apiKey } }) } },
    models: [
      {
        id: opts.modelId,
        name: opts.modelName ?? opts.modelId,
        api: "openai-completions",
        provider: id,
        baseUrl: "http://endpoint.invalid/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: opts.contextWindow ?? 65_536,
        maxTokens: opts.maxTokens ?? 4_096,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "qwen-chat-template",
          thinkingTokenBudgetField: "thinking_token_budget",
        },
      },
    ],
    api: {
      stream: (model, context, options) => checked(model, live(model, () => api.stream(at(model), seen(context), keyed(options))), context, options as SimpleStreamOptions | undefined),
      streamSimple: (model, context, options) => checked(model, live(model, () => api.streamSimple(at(model), seen(context), keyed(options))), context, options),
    },
  });
}

export type Readiness = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly reason: string };

export interface UseModelOptions {
  readonly provider: string;
  readonly modelId: string;
  /** Asked before anything changes: is the endpoint up and serving the model the tool promises? Not ok leaves every model as it was. */
  readonly ready: (context: Context) => Promise<Readiness>;
  /** Other fields configured with the model, such as `thinkingLevel` or `tools`. */
  readonly agent?: Omit<AgentChange, "model">;
  /** The switch's result, which the new model reads first; default "You are now running on <model>. <ready.detail>". */
  readonly result?: (details: UseModelDetails, detail: string) => string;
  /** Also configure the conversations the caller's tasks own (its threads), and theirs, in the same commit. */
  readonly threads?: boolean;
  /** The tool's description; default says what the switch does. */
  readonly description?: string;
  /** Told after the switch committed, with what changed. */
  readonly onSwitched?: (details: UseModelDetails, context: Context) => Promise<void>;
}

export type UseModelDetails = { provider: string; modelId: string; conversations: number[] };

/** The conversations owned by `root`'s tasks, and theirs, in scan order. */
async function owned(tx: Tx, root: ConversationId): Promise<ConversationId[]> {
  const out: ConversationId[] = [];
  const queue: ConversationId[] = [root];
  const seen = new Set<string>([String(root)]);
  while (queue.length > 0) {
    const owner = queue.shift()!;
    let cursor: Parameters<Tx["scanConversations"]>[2];
    do {
      const page = await tx.scanConversations({ ownerConversationId: owner }, 100, cursor);
      for (const c of page.items) {
        if (seen.has(String(c.id))) continue;
        seen.add(String(c.id));
        out.push(c.id);
        queue.push(c.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return out;
}

export function useModelExtension(opts: UseModelOptions): Extension {
  const change: AgentChange = { ...(opts.agent ?? {}), model: { provider: opts.provider, modelId: opts.modelId } };
  return defineExtension({
    name: "gg-use-model",
    tools: [
      defineTool({
        name: USE_MODEL_TOOL,
        description:
          opts.description ??
          `Switch your own brain to ${opts.modelId}, served on your GPU box. From your next message on, every word you write comes from that model, in this same conversation; call it once the model is served.`,
        parameters: Type.Object({
          reason: Type.Optional(Type.String({ description: "One sentence: why you are switching." })),
        }),
        // A rerun configures the same model again: the same end state, so an interrupted call may run twice.
        replay: "safe",
        async execute(_args, api, context) {
          const ready = await opts.ready(context);
          if (!ready.ok) return { isError: true, content: [{ type: "text" as const, text: `Your model was not changed: ${ready.reason}` }] };
          const conversations = await api.commit(async (tx) => {
            const ids = [api.conversationId, ...(opts.threads ? await owned(tx, api.conversationId) : [])];
            for (const id of ids) await configure(tx, id, change);
            return ids;
          }, context);
          const details: UseModelDetails = { provider: opts.provider, modelId: opts.modelId, conversations: conversations.map(Number) };
          await opts.onSwitched?.(details, context);
          const threads = conversations.length > 1 ? `, and so are ${conversations.length - 1} of your threads` : "";
          const text = opts.result ? opts.result(details, ready.detail) : `You are now running on ${opts.modelId}${threads}. ${ready.detail}`.trim();
          return {
            content: [{ type: "text" as const, text }],
            details,
          };
        },
      }),
    ],
  });
}
