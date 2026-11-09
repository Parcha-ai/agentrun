// The runner's model route: where a model's requests go, on which id, at what price. A model is resolved as main
// resolves a run's (model.ts chooseModel and runModels: the faux module under --faux, the gateway, or each provider on
// its own key), and a route speaks a wire its caller speaks (`wires`: the pi adapter speaks both of main's, provider.ts,
// and so do the learning grader and a workflow's model nodes, which take the route's wire as pi does):
// - an Anthropic model goes to Anthropic itself (its catalog origin, ANTHROPIC_BASE_URL's when set), its key read by
//   name when a request goes, never held by the route;
// - a model pi-ai speaks OpenAI's Responses to (OpenAI's own on its key, serve's gateway), for a caller that speaks
//   Responses, goes there itself, where provider.ts providerFor sends it (the origin, the key, the id on the wire);
// - any other model answers through the route's own fetch: the Messages request runs on pi-ai's model of it (the faux
//   core under --faux, never the network; another provider's or the gateway's on its key from `env`), and its events
//   come back as a Messages stream.
// Its price is pi-ai's calculateCost on the catalog's cost, tiers included (a request past a model's tier is priced at
// the tier, as its provider bills it), and its cost is that catalog entry, tiers included, for the cap's judgement.
import { calculateCost } from "@earendil-works/pi-ai";
import type { Wire } from "@parcha/agentrun-kernel";
import { chooseModel, runModels, type Tier } from "../model.js";
import { providerFor } from "../provider.js";
import { keepText, type Redact, runnerSecrets, secretRedactor } from "./redact.js";

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

/** Where a model's requests go: the API `provider.api` names at `origin` (the shape the kernel's model proxy forwards), its
 *  credential sent as `auth` says, for `model` (its id on that wire), priced by `price`; `fetch`, the route's own upstream
 *  when its model speaks no wire of the caller's. The fields of the learning grader's route (learning-ask.ts GraderRoute),
 *  and `cost` beside them. */
export interface ModelRoute {
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  readonly model: string;
  /** The catalog's entry for the model, as pi-ai's model of it takes it: on every wire, what it takes as input (whether it
   *  takes images) and its input limits (an image's most size), which pi's session and its read size an image by; on a
   *  wire that carries its reasoning (Responses), also whether it reasons, its window and its output ceiling. */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number; readonly input?: readonly string[]; readonly inputLimits?: unknown };
  /** A request's price from its usage (the proxy's booking reads it): pi-ai's calculateCost, tiers included. */
  readonly price?: (model: string, usage: RouteUsage) => number | null;
  /** The upstream fetch: the route's own, for a model that does not speak Messages. Absent: the network. */
  readonly fetch?: typeof fetch;
  /** The catalog's cost of the model, tiers included: what the cap prices a request at before it leaves. */
  readonly cost?: RouteCost;
  /** The model's most output tokens (its catalog ceiling): the cap's output bound, null when the catalog names none. */
  readonly outputCeiling?: number | null;
}

/** The origin a route with its own fetch names: nothing is ever sent there, its fetch answers every request. */
export const ROUTE_ORIGIN = "https://model-route.invalid";

type PiModel = { id: string; provider: string; api: string; baseUrl?: string; cost: RouteCost; maxTokens?: number; reasoning?: boolean; contextWindow?: number; input?: readonly string[]; inputLimits?: unknown };
/** The wires a caller of routeOf speaks when it names none: Anthropic's Messages alone. */
const MESSAGES_ONLY: readonly Wire[] = ["anthropic-messages"];
type PiModels = { getModel(provider: string, id: string): unknown; streamSimple(model: never, context: never, options?: never): AsyncIterable<PiEvent> };
type PiEvent = { type: string; contentIndex?: number; delta?: string; partial?: { content?: { type: string; id?: string; name?: string }[] }; toolCall?: { id: string; name: string; arguments: unknown }; reason?: string; message?: PiMessage; error?: PiMessage };
type PiMessage = { usage?: RouteUsage; stopReason?: string; errorMessage?: string };

/** The route of `model` ("provider/model-id"; undefined for the host's model of `tier`), resolved from `env` as main
 *  resolves a run's model, on a wire of `wires` (the caller's; default Messages alone). `upstream`: what the route's own
 *  translation sends with (a test's stand-in for the provider); absent, the network. `redact`: the runner's one redactor,
 *  which the translation's error text passes through (absent, one over every secret `env` holds). Refuses, in main's
 *  words, a model this host cannot run. */
export async function routeOf(model: string | undefined, env: NodeJS.ProcessEnv = process.env, tier: Tier = "default", wires: readonly Wire[] = MESSAGES_ONLY, upstream?: typeof fetch, redact?: Redact): Promise<ModelRoute> {
  const chosen = await chooseModel(env, model, tier);
  if ("why" in chosen) throw new Error(chosen.why);
  const { models } = await runModels(env, tier === "default" ? model : undefined, [tier]);
  const target = models.getModel(chosen.model.provider, chosen.model.modelId) as unknown as PiModel | undefined;
  if (!target) throw new Error(`no model ${chosen.model.provider}/${chosen.model.modelId} here`);
  const price = (_model: string, used: RouteUsage): number => {
    const usage = { ...used, totalTokens: used.input + used.output + used.cacheRead + used.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return calculateCost(target as never, usage as never).total;
  };
  // What the model takes as input and its input limits, on every wire: pi's session sends a model that takes no images
  // pi-ai's placeholder in place of one, and pi's read holds an image to the model's limits (port-models.ts sessionModel).
  const sees = { ...(target.input ? { input: target.input } : {}), ...(target.inputLimits ? { inputLimits: target.inputLimits } : {}) };
  const route = { model: chosen.model.modelId, price, cost: target.cost, outputCeiling: target.maxTokens ?? null, like: sees };
  // An Anthropic model speaks Messages itself: the network, at its catalog origin, its key read by name per request.
  if (chosen.model.provider === "anthropic") {
    return { ...route, provider: { api: "anthropic-messages", origin: target.baseUrl ?? "https://api.anthropic.com", credential: () => env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? "" } };
  }
  // A model pi-ai speaks Responses to, for a caller that speaks it: that wire itself, where main sends it (provider.ts).
  if (target.api === "openai-responses" && wires.includes("openai-responses")) {
    const to = providerFor("openai-responses", env, chosen.model, "pi");
    return {
      ...route, model: to.modelId,
      provider: { api: "openai-responses", origin: to.origin, credential: to.credential, auth: to.auth },
      like: { ...sees, ...(target.reasoning !== undefined ? { reasoning: target.reasoning } : {}), ...(target.contextWindow ? { contextWindow: target.contextWindow } : {}), ...(target.maxTokens ? { maxTokens: target.maxTokens } : {}) },
    };
  }
  return { ...route, provider: { api: "anthropic-messages", origin: ROUTE_ORIGIN, credential: () => "model-route" }, fetch: messagesFetch(models as unknown as PiModels, target, redact ?? secretRedactor(runnerSecrets(env)), upstream) };
}

/** A fetch that answers Anthropic Messages requests on `target`, through pi-ai's `models`. A provider's error text, which
 *  pi records, goes through `redact` (the runner's one redactor): a provider that echoes its key leaves none there.
 *  `upstream`: the route's own fetch, for a model that does not speak Messages (absent: the network). */
export function messagesFetch(models: PiModels, target: PiModel, redact: Redact = keepText, upstream?: typeof fetch): typeof fetch {
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
    const events = models.streamSimple(target as never, context as never, { ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}), ...(init.signal ? { signal: init.signal } : {}), ...(upstream ? { fetch: upstream } : {}) } as never);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: { type: string; [key: string]: unknown }) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        // A failed request's error event carries its words alone, one data line each: pi-ai's Messages client throws an
        // error event's data as the request's error, so the caller reads the model's own error as main's in-process pi
        // reports it ("500 {...}"), never this route's envelope around it.
        const sendError = (words: string) => controller.enqueue(encoder.encode(`event: error\n${words.split(/\r?\n/).map((line) => `data: ${line}`).join("\n")}\n\n`));
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
                sendError(redact(message.errorMessage ?? event.reason ?? "the model's request failed"));
                break;
              }
              const used = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
              send({ type: "message_delta", delta: { stop_reason: stopReasonOf(event.reason ?? message.stopReason), stop_sequence: null }, usage: { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead, cache_creation_input_tokens: used.cacheWrite } });
              send({ type: "message_stop" });
            }
          }
        } catch (error) {
          sendError(redact((error as Error)?.message ?? String(error)));
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
