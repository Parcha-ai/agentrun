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
import type { Api, Message, Model, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";

export const STEERED_PROVIDER = "steered";
export const USE_MODEL_TOOL = "use_model";

/** Where the endpoint is now: `baseUrl` ends in `/v1`. Undefined while there is none. */
export type Endpoint = { readonly baseUrl: string; readonly apiKey: string };

export interface SteeredProviderOptions {
  readonly id?: string;
  readonly modelId: string;
  /** Read at every request, so a box created after the Harness opened is reachable without re-registering. */
  readonly endpoint: () => Endpoint | undefined;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** What of the conversation the model is shown; default all of it. */
  readonly window?: (context: TranscriptContext) => TranscriptContext;
  /** A replacement for the HTTP fetch (to record the exact requests). */
  readonly fetch?: typeof globalThis.fetch;
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
      if (m.role === "assistant" && m.provider !== provider) at = i;
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
  const keyed = <T extends StreamOptions | undefined>(options: T): T => ({ ...(options ?? {}), apiKey: current().apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) as T;
  const seen = (context: TranscriptContext) => (opts.window ? opts.window(context) : context);
  return createProvider({
    id,
    name: opts.name ?? id,
    auth: { apiKey: { name: `${id} endpoint key`, resolve: async () => ({ auth: { apiKey: current().apiKey } }) } },
    models: [
      {
        id: opts.modelId,
        name: opts.modelId,
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
      stream: (model, context, options) => api.stream(at(model), seen(context), keyed(options)),
      streamSimple: (model, context, options) => api.streamSimple(at(model), seen(context), keyed(options)),
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
  /** Also configure the conversations the caller's tasks own (its threads), and theirs, in the same commit. */
  readonly threads?: boolean;
  /** The tool's description; default says what the switch does. */
  readonly description?: string;
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
          const threads = conversations.length > 1 ? `, and so are ${conversations.length - 1} of your threads` : "";
          return {
            content: [{ type: "text" as const, text: `You are now running on ${opts.modelId}${threads}. ${ready.detail}`.trim() }],
            details,
          };
        },
      }),
    ],
  });
}
