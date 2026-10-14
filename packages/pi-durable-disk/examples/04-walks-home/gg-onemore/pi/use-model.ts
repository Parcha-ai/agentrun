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
/** The diagnostic type on a pushback turn's message (the guard drew several replies and Jev picked one); its details are `SteeredDrafts`. */
export const DRAFTS_DIAGNOSTIC = "steered-drafts";

/**
 * A pushback turn's drafts: `of` of them; `blocks[k]` is the content index of draft k+1's thinking in the message, null when
 * the message does not hold it (once saved, only the picked one's); `picked` (1-based) once Jev picked, with its numbers
 * (`copies`, `topic`, `tries` 0-1, `funny` 0-1). The page labels the blocks from this; the model never reads it.
 */
export type SteeredDrafts = { of: number; blocks: (number | null)[]; picked?: number; copies?: number; topic?: number; tries?: number; funny?: number };

/** What the guard's pushback-turn stream said beside its choices: how many drafts, each thinking delta's draft in arrival order, the pick. */
type DraftsLog = { of?: number; segments: { draft: number; text: string }[]; pick?: Record<string, unknown> };

/**
 * The guard's pushback-turn stream (README, "The contrite loop") as pi-ai reads it: its `gg_drafts` and `gg_pick` events are
 * taken off into `log`, and each draft's thinking (its own choice index) moves onto choice 0, its draft recorded in arrival
 * order. Any other stream passes unchanged.
 */
function draftsFetch(inner: typeof globalThis.fetch, log: DraftsLog): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";
    const rewrite = (line: string): string | undefined => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
      let c: { gg_drafts?: unknown; gg_pick?: unknown; choices?: { index?: number; delta?: Record<string, unknown> }[] };
      try {
        c = JSON.parse(line.slice(6));
      } catch {
        return line;
      }
      if (typeof c.gg_drafts === "number") {
        log.of = c.gg_drafts;
        return undefined;
      }
      if (c.gg_pick && typeof c.gg_pick === "object") {
        log.pick = c.gg_pick as Record<string, unknown>;
        return undefined;
      }
      if (log.of === undefined || !Array.isArray(c.choices)) return line;
      for (const ch of c.choices) {
        const r = ch.delta?.reasoning_content ?? ch.delta?.reasoning;
        if (typeof r === "string" && r.length > 0) log.segments.push({ draft: ch.index ?? 0, text: r });
        ch.index = 0;
      }
      return `data: ${JSON.stringify(c)}`;
    };
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          buf += decoder.decode(chunk, { stream: true });
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            const line = rewrite(buf.slice(0, i).replace(/\r$/, ""));
            buf = buf.slice(i + 1);
            if (line !== undefined) out.enqueue(encoder.encode(`${line}\n`));
          }
        },
        flush(out) {
          const line = buf ? rewrite(buf) : undefined;
          if (line !== undefined) out.enqueue(encoder.encode(line));
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Each draft's thinking so far: pi-ai's one thinking block is the drafts' deltas in arrival order, cut where it has read to. */
function draftTexts(all: string, log: DraftsLog): string[] {
  const texts = Array.from({ length: log.of ?? 0 }, () => "");
  let n = 0;
  for (const s of log.segments) {
    if (n >= all.length) break;
    const part = s.text.slice(0, all.length - n);
    texts[s.draft] = (texts[s.draft] ?? "") + part;
    n += part.length;
  }
  return texts;
}

const pickNumbers = (pick: Record<string, unknown> | undefined): Partial<SteeredDrafts> => {
  if (!pick || typeof pick.draft !== "number") return {};
  const out: Partial<SteeredDrafts> = { picked: pick.draft };
  for (const k of ["copies", "topic", "tries", "funny"] as const) if (typeof pick[k] === "number") out[k] = pick[k] as number;
  return out;
};
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
 * its system prompt (none without them) and only the turns since another model last spoke there: the use_model result (or whatever results
 * that last turn got) opens the window as a user turn. It holds for every conversation configured onto this provider,
 * the caller and its threads alike, because the boundary is read from the turns themselves. With `maxChars`, a long chat
 * after the switch keeps its latest turns within that many characters (the server's own limit; the conversation is
 * measured against the base model's, so it is never compacted by the edited model): the oldest go first, the window
 * opening on a user turn.
 */
export function sinceSwitch(o: { instructions?: string; provider?: string; maxChars?: number }) {
  const provider = o.provider ?? STEERED_PROVIDER;
  const size = (m: Message) => JSON.stringify(m.content).length;
  return (context: TranscriptContext): TranscriptContext => {
    const real = context.messages.filter((m) => m.role !== "system");
    let at = -1;
    for (let i = real.length - 1; i >= 0 && at < 0; i--) {
      const m = real[i]!;
      if (m.role === "assistant" && m.provider !== provider && !(m.diagnostics ?? []).some((d) => d.type === FALLBACK_DIAGNOSTIC)) at = i;
    }
    let after = real.slice(at + 1);
    if (o.maxChars !== undefined) {
      let total = after.reduce((n, m) => n + size(m), 0);
      let from = 0;
      while (total > o.maxChars && from < after.length - 1) total -= size(after[from++]!);
      // once it drops a turn, the window opens on a user turn: never on the answer, or the results, of a turn it dropped
      if (from > 0) while (from < after.length - 1 && after[from]!.role !== "user") from++;
      after = after.slice(from);
    }
    // A pushback turn's message: the model sees the picked draft's thinking only, never the drafts not picked.
    after = after.map((m) => (m.role === "assistant" ? pickedOnly(m) : m));
    // Results whose call is outside the window cannot go as tool messages (the API needs the call), so they open it as one user turn.
    let lead = 0;
    while (lead < after.length && after[lead]!.role === "toolResult") lead++;
    const opening = after.slice(0, lead).flatMap((m) => (m.role === "toolResult" ? m.content.filter((p) => p.type === "text") : []));
    const messages: Message[] = [...(lead > 0 ? [{ role: "user" as const, content: opening, timestamp: after[0]!.timestamp }] : []), ...after.slice(lead)];
    return normalizeContext({ systemPrompt: o.instructions, messages, tools: getCurrentTools(context.messages) });
  };
}

/** A message with a steered-drafts diagnostic, with the thinking of every draft but the picked one taken out. */
function pickedOnly(m: AssistantMessage): AssistantMessage {
  const d = (m.diagnostics ?? []).find((x) => x.type === DRAFTS_DIAGNOSTIC)?.details as SteeredDrafts | undefined;
  if (!d || !Array.isArray(d.blocks)) return m;
  const drop = new Set(d.blocks.filter((b, k): b is number => typeof b === "number" && k + 1 !== d.picked));
  return drop.size === 0 ? m : { ...m, content: m.content.filter((_, i) => !drop.has(i)) };
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
  const keyed = <T extends StreamOptions | undefined>(options: T, log: DraftsLog): T =>
    ({ ...(opts.thinkingBudgets ? { thinkingBudgets: opts.thinkingBudgets } : {}), ...(options ?? {}), apiKey: current().apiKey, fetch: draftsFetch(opts.fetch ?? globalThis.fetch, log) }) as T;
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
  // A pushback turn's stream (the guard says so up front): each draft's thinking becomes its own block, labeled by a
  // steered-drafts diagnostic, while it streams; the answer follows the pick; the message keeps only the picked draft's
  // thinking. Any other stream passes as it came.
  const drafted = (model: Model<Api>, run: () => AssistantMessageEventStream, log: DraftsLog): (() => AssistantMessageEventStream) => () => {
    const out = createAssistantMessageEventStream();
    const started = Date.now();
    void (async () => {
      let sent: string[] = [];
      const view = (partial: AssistantMessage, final: boolean): AssistantMessage => {
        const thinking = partial.content.find((b) => b.type === "thinking");
        const texts = draftTexts(thinking && thinking.type === "thinking" ? thinking.thinking : "", log);
        const rest = partial.content.filter((b) => b.type !== "thinking");
        // the guard sends its pick between the drafts' thinking and the picked answer; the fetch may have read ahead, so the
        // pick counts from the answer's first block on
        const pick = final || rest.length > 0 ? pickNumbers(log.pick) : {};
        const kept = final ? texts.flatMap((t, k) => (k + 1 === pick.picked && t ? [k] : [])) : texts.map((_, k) => k);
        const details: SteeredDrafts = { of: log.of!, blocks: texts.map((_, k) => (kept.includes(k) ? kept.indexOf(k) : null)), ...pick };
        const diagnostics = [...(partial.diagnostics ?? []).filter((x) => x.type !== DRAFTS_DIAGNOSTIC), { type: DRAFTS_DIAGNOSTIC, timestamp: started, details }];
        return { ...partial, content: [...kept.map((k) => ({ type: "thinking" as const, thinking: texts[k]! })), ...rest.map((b) => ({ ...b }))], diagnostics };
      };
      try {
        for await (const e of run()) {
          if (log.of === undefined) {
            out.push(e);
            continue;
          }
          if (e.type === "done") out.push({ ...e, message: view(e.message, true) });
          else if (e.type === "error") out.push({ ...e, error: view(e.error, true) });
          else if (e.type === "thinking_start" || e.type === "thinking_end") continue;
          else if (e.type === "thinking_delta") {
            const partial = view(e.partial, false);
            const now = partial.content.slice(0, log.of).map((b) => (b.type === "thinking" ? b.thinking : ""));
            for (const [k, t] of now.entries()) {
              const before = sent[k] ?? "";
              if (t.length > before.length) out.push({ type: "thinking_delta", contentIndex: k, delta: t.slice(before.length), partial });
            }
            sent = now;
          } else if ("contentIndex" in e) {
            const thinkingFirst = e.partial.content[0]?.type === "thinking" ? 1 : 0;
            out.push({ ...e, contentIndex: log.of + e.contentIndex - thinkingFirst, partial: view(e.partial, false) } as AssistantMessageEvent);
          } else if ("partial" in e) out.push({ ...e, partial: view(e.partial, false) } as AssistantMessageEvent);
          else out.push(e);
        }
      } catch (error) {
        out.push(errorTurn(model, `the request threw: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        out.end();
      }
    })();
    return out;
  };
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
      // Qwen's thinking comes before its answer, so the blocks already shown are its first ones; a pushback turn's are its
      // drafts', none of which the model's answer is.
      const drafts = (shown?.diagnostics ?? []).some((d) => d.type === DRAFTS_DIAGNOSTIC);
      const thinking = drafts ? [] : (shown?.content ?? []).filter((p) => p.type === "thinking");
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
      stream: (model, context, options) => {
        const log: DraftsLog = { segments: [] };
        return checked(model, live(model, drafted(model, () => api.stream(at(model), seen(context), keyed(options, log)), log)), context, options as SimpleStreamOptions | undefined);
      },
      streamSimple: (model, context, options) => {
        const log: DraftsLog = { segments: [] };
        return checked(model, live(model, drafted(model, () => api.streamSimple(at(model), seen(context), keyed(options, log)), log)), context, options);
      },
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
