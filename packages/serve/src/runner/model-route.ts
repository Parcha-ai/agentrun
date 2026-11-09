// The runner's model route: where a model's requests go, on which id, at what price. A model is resolved as main
// resolves a run's (model.ts chooseModel and runModels: the faux module under --faux, the gateway, or each provider on
// its own key), and every route speaks Anthropic's Messages API, the shape the kernel's model proxy forwards (the pi
// adapter's path and the learning grader's):
// - an Anthropic model goes to Anthropic itself (its catalog origin, ANTHROPIC_BASE_URL's when set), its key read by
//   name when a request goes, never held by the route;
// - any other model answers through the route's own fetch: the Messages request runs on pi-ai's model of it (the faux
//   core under --faux, never the network; another provider's or the gateway's on its key from `env`), and its events
//   come back as a Messages stream.
// Its price is pi-ai's calculateCost on the catalog's cost, tiers included (a request past a model's tier is priced at
// the tier, as its provider bills it), and its cost is that catalog entry, tiers included, for the cap's judgement.
import { calculateCost } from "@earendil-works/pi-ai";
import { chooseModel, runModels, type Tier } from "../model.js";

/** What a request on a model costs, USD per million tokens, as pi-ai's catalog lists it (tiers included). */
export type RouteCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly { readonly inputTokensAbove: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }[];
};

/** A request's token usage, as the proxy's booking prices it. */
export type RouteUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Where a model's requests go: Anthropic's Messages API at `origin` (the shape the kernel's model proxy forwards), for
 *  `model`, priced by `price`; `fetch`, the route's own upstream when its model does not speak Messages. The fields of the
 *  learning grader's route (learning-ask.ts GraderRoute), and `cost` beside them. */
export interface ModelRoute {
  readonly provider: { readonly api: "anthropic-messages"; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>> };
  readonly model: string;
  /** A request's price from its usage (the proxy's booking reads it): pi-ai's calculateCost, tiers included. */
  readonly price?: (model: string, usage: RouteUsage) => number | null;
  /** The upstream fetch: the route's own, for a model that does not speak Messages. Absent: the network. */
  readonly fetch?: typeof fetch;
  /** The catalog's cost of the model, tiers included: what the cap prices a request at before it leaves. */
  readonly cost?: RouteCost;
  /** The model's most completion tokens (the catalog's maxTokens): the cap's output ceiling, so a priced-output request
   *  has a bounded cost. Absent when the catalog gives none. */
  readonly outputCeiling?: number;
}

/** The origin a route with its own fetch names: nothing is ever sent there, its fetch answers every request. */
export const ROUTE_ORIGIN = "https://model-route.invalid";

type PiModel = { id: string; provider: string; api: string; baseUrl?: string; cost: RouteCost; maxTokens?: number };
type PiModels = { getModel(provider: string, id: string): unknown; streamSimple(model: never, context: never, options?: never): AsyncIterable<PiEvent> };
type PiEvent = { type: string; contentIndex?: number; delta?: string; partial?: { content?: { type: string; id?: string; name?: string }[] }; toolCall?: { id: string; name: string; arguments: unknown }; reason?: string; message?: PiMessage; error?: PiMessage };
type PiMessage = { usage?: RouteUsage; stopReason?: string; errorMessage?: string };

/** The route of `model` ("provider/model-id"; undefined for the host's model of `tier`), resolved from `env` as main
 *  resolves a run's model. Refuses, in main's words, a model this host cannot run. */
export async function routeOf(model: string | undefined, env: NodeJS.ProcessEnv = process.env, tier: Tier = "default"): Promise<ModelRoute> {
  const chosen = await chooseModel(env, model, tier);
  if ("why" in chosen) throw new Error(chosen.why);
  const { models } = await runModels(env, tier === "default" ? model : undefined, [tier]);
  const target = models.getModel(chosen.model.provider, chosen.model.modelId) as unknown as PiModel | undefined;
  if (!target) throw new Error(`no model ${chosen.model.provider}/${chosen.model.modelId} here`);
  const price = (_model: string, used: RouteUsage): number => {
    const usage = { ...used, totalTokens: used.input + used.output + used.cacheRead + used.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return calculateCost(target as never, usage as never).total;
  };
  const route = { model: chosen.model.modelId, price, cost: target.cost, ...(typeof target.maxTokens === "number" ? { outputCeiling: target.maxTokens } : {}) };
  // An Anthropic model speaks Messages itself: the network, at its catalog origin, its key read by name per request.
  if (chosen.model.provider === "anthropic") {
    return { ...route, provider: { api: "anthropic-messages", origin: target.baseUrl ?? "https://api.anthropic.com", credential: () => env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? "" } };
  }
  return { ...route, provider: { api: "anthropic-messages", origin: ROUTE_ORIGIN, credential: () => "model-route" }, fetch: messagesFetch(models as unknown as PiModels, target) };
}

/** A fetch that answers Anthropic Messages requests on `target`, through pi-ai's `models`. */
export function messagesFetch(models: PiModels, target: PiModel): typeof fetch {
  // A tool call's id as Messages carries it (letters, digits, _ and -), and back to the provider's own on its result.
  const providerIds = new Map<string, string>();
  const messagesId = (id: string): string => {
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
    providerIds.set(safe, id);
    return safe;
  };
  return (async (_url: unknown, init: { body?: unknown; signal?: AbortSignal } = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as MessagesRequest;
    const context = contextOf(body, target, (id) => providerIds.get(id) ?? id);
    const events = models.streamSimple(target as never, context as never, { ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}), ...(init.signal ? { signal: init.signal } : {}) } as never);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: { type: string; [key: string]: unknown }) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        send({ type: "message_start", message: { id: `msg_${Date.now().toString(36)}`, type: "message", role: "assistant", model: body.model ?? target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        // Messages blocks are numbered as sent; a thinking block of pi-ai's is not sent (it carries no signature here).
        const blockOf = new Map<number, number>();
        const sentJson = new Set<number>();
        let blocks = 0;
        const open = (at: number | undefined) => {
          const index = blocks++;
          blockOf.set(at ?? -1, index);
          return index;
        };
        try {
          for await (const event of events) {
            const at = event.contentIndex;
            if (event.type === "text_start") send({ type: "content_block_start", index: open(at), content_block: { type: "text", text: "" } });
            else if (event.type === "text_delta") send({ type: "content_block_delta", index: blockOf.get(at ?? -1), delta: { type: "text_delta", text: event.delta ?? "" } });
            else if (event.type === "toolcall_start") {
              const call = event.partial?.content?.[at ?? -1];
              send({ type: "content_block_start", index: open(at), content_block: { type: "tool_use", id: messagesId(call?.id ?? `call_${blocks}`), name: call?.name ?? "", input: {} } });
            } else if (event.type === "toolcall_delta" && event.delta) {
              sentJson.add(blockOf.get(at ?? -1)!);
              send({ type: "content_block_delta", index: blockOf.get(at ?? -1), delta: { type: "input_json_delta", partial_json: event.delta } });
            } else if (event.type === "toolcall_end") {
              const index = blockOf.get(at ?? -1);
              if (index === undefined) {
                // A call that came whole, with no start: opened and filled here.
                const opened = open(at);
                send({ type: "content_block_start", index: opened, content_block: { type: "tool_use", id: messagesId(event.toolCall?.id ?? `call_${opened}`), name: event.toolCall?.name ?? "", input: {} } });
                send({ type: "content_block_delta", index: opened, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolCall?.arguments ?? {}) } });
                send({ type: "content_block_stop", index: opened });
              } else {
                if (!sentJson.has(index)) send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolCall?.arguments ?? {}) } });
                send({ type: "content_block_stop", index });
              }
            } else if (event.type === "text_end") send({ type: "content_block_stop", index: blockOf.get(at ?? -1) });
            else if (event.type === "done" || event.type === "error") {
              const message = (event.type === "done" ? event.message : event.error) ?? {};
              if (event.type === "error") {
                send({ type: "error", error: { type: event.reason === "aborted" ? "request_aborted" : "api_error", message: message.errorMessage ?? event.reason ?? "the model's request failed" } });
                break;
              }
              const used = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
              send({ type: "message_delta", delta: { stop_reason: stopReasonOf(event.reason ?? message.stopReason), stop_sequence: null }, usage: { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead, cache_creation_input_tokens: used.cacheWrite } });
              send({ type: "message_stop" });
            }
          }
        } catch (error) {
          send({ type: "error", error: { type: "api_error", message: (error as Error)?.message ?? String(error) } });
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** pi-ai's stop reason as Messages says it. */
const stopReasonOf = (reason: string | undefined): string => (reason === "toolUse" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn");

type MessagesBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | MessagesBlock[]; is_error?: boolean; source?: { type?: string; media_type?: string; data?: string } };
type MessagesRequest = {
  model?: string;
  max_tokens?: number;
  system?: string | MessagesBlock[];
  messages?: { role: "user" | "assistant"; content: string | MessagesBlock[] }[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
};

/** A part of a pi-ai message, as the context carries it. */
type Part = { readonly type: string; readonly [key: string]: unknown };

const textOf = (content: string | MessagesBlock[] | undefined): string => (typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"));

/** A Messages request as pi-ai's context on `target`: its system prompt, tools and turns (a tool_result as its own
 *  toolResult message, naming the tool its call named; `providerId` maps a call id back to the provider's). */
function contextOf(body: MessagesRequest, target: PiModel, providerId: (id: string) => string): unknown {
  const named = new Map<string, string>();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: unknown[] = [];
  for (const message of body.messages ?? []) {
    const blocks: MessagesBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "assistant") {
      const content = blocks.flatMap((block): Part[] => {
        if (block.type === "text") return [{ type: "text", text: block.text ?? "" }];
        if (block.type === "tool_use") {
          named.set(block.id ?? "", block.name ?? "");
          return [{ type: "toolCall", id: providerId(block.id ?? ""), name: block.name ?? "", arguments: (block.input ?? {}) as object }];
        }
        return [];
      });
      messages.push({ role: "assistant", content, api: target.api, provider: target.provider, model: target.id, usage: zero, stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() });
      continue;
    }
    const said = blocks.flatMap((block): Part[] =>
      block.type === "text" ? [{ type: "text", text: block.text ?? "" }] : block.type === "image" && block.source?.data ? [{ type: "image", data: block.source.data, mimeType: block.source.media_type ?? "image/png" }] : [],
    );
    for (const block of blocks.filter((each) => each.type === "tool_result")) {
      const id = block.tool_use_id ?? "";
      messages.push({ role: "toolResult", toolCallId: providerId(id), toolName: named.get(id) ?? "", content: [{ type: "text", text: textOf(block.content) }], isError: block.is_error === true, timestamp: Date.now() });
    }
    if (said.length) messages.push({ role: "user", content: said, timestamp: Date.now() });
  }
  const system = typeof body.system === "string" ? body.system : textOf(body.system);
  return {
    ...(system ? { systemPrompt: system } : {}),
    messages,
    ...(body.tools?.length ? { tools: body.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.input_schema ?? { type: "object", properties: {} } })) } : {}),
  };
}
