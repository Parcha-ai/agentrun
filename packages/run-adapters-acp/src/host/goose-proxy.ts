// What Goose's model requests may carry through the session's model proxy (@parcha/agentrun-kernel/host), and the proxy
// each Goose process is pointed at. Written for AgentRun.
//
// Goose (1.59.2, provider `anthropic`) speaks Anthropic's Messages API to ANTHROPIC_HOST, with ANTHROPIC_API_KEY as its
// `x-api-key`. Measured behind a recording origin, with session naming off and its model catalog's fetch blocked (the
// recipe), it sends:
//  - `GET /v1/models` as it starts, headers accept, accept-encoding, anthropic-version and x-api-key: answered here with
//    the session's model alone, never forwarded (the provider's whole list is not the session's to read);
//  - then only the turn's `POST /v1/messages` (streamed), which adds anthropic-beta, content-type and `agent-session-id`,
//    Goose's own session id: that one is never forwarded.
// The one anthropic-beta value it sends (GOOSE_BETAS) passes; any other is refused, so a Goose that starts sending a new
// one is seen before it is trusted.
//
// A body may carry only the Messages API's own keys. Its model is the session's. The tools it offers are the session's
// own, as Goose names them (`agentrun__<name>`), and Goose's `load_skill`, which it always offers (GOOSE_OWN_TOOLS): any
// other tool is refused, never trimmed, so a Goose whose bundled extensions came back on fails loudly. A provider-hosted
// tool, or a content block the API would run or fetch on its own, is refused. `max_tokens` is clamped. Usage is read from
// the stream's `message_start` and its last `message_delta`.
//
// The proxy asks the session's booking (`AcpProxySession.models`, the runner's) before each paid request and books it
// once it answers, priced by the host's `price`: the same hooks every proxy-billed harness's proxy takes, so the run's
// cap and books hold for Goose as for the others.
import { randomBytes } from "node:crypto";
import { messagesImagesIn, messagesInputAfter, messagesLocalInputTokens, providerInputOverhead, ProxyRefusal, startModelProxy, type BilledRequest, type InputShape, type ModelProxyOptions, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-kernel/host";
import { MCP_SERVER } from "../calls.js";
import type { AcpProxy } from "../adapter.js";

/** Goose's own tools that stay on with every bundled extension off: `load_skill`, which its agent always offers and which
 *  reads skill files only. */
export const GOOSE_OWN_TOOLS: readonly string[] = Object.freeze(["load_skill"]);

/** A host tool's name as Goose offers it to its model: the MCP server's name, two underscores, the tool's. */
export const gooseToolName = (name: string): string => `${MCP_SERVER}__${name}`;

/** The `anthropic-beta` value Goose 1.59.2 sends with each Messages request, recorded behind a fake origin (the package's
 *  Goose test records it again on every run with the binary). */
export const GOOSE_BETAS: ReadonlySet<string> = new Set(["thinking-binding-controls-2026-08-01"]);

/** The request headers forwarded with a Messages request: the API's version and betas. Goose's `agent-session-id` is not
 *  among them. */
const MESSAGES_HEADERS = ["anthropic-version", "anthropic-beta"] as const;

/** The routes, the models list answered with `model` alone. */
export function gooseRoutes(model: string): readonly ProxyRoute[] {
  const listed = JSON.stringify({ data: [{ type: "model", id: model, display_name: model, created_at: "1970-01-01T00:00:00Z" }], has_more: false, first_id: model, last_id: model });
  return Object.freeze([
    { method: "GET", path: "/v1/models", local: 200, localJson: listed },
    { method: "POST", path: "/v1/messages", headers: MESSAGES_HEADERS },
  ]);
}

/** The keys a Messages request may carry: the API's own client-side ones. */
const MESSAGES_KEYS: ReadonlySet<string> = new Set(["model", "messages", "system", "max_tokens", "metadata", "stop_sequences", "stream", "temperature", "top_k", "top_p", "tools", "tool_choice", "thinking", "output_config"]);
const OUTPUT_CONFIG_KEYS: ReadonlySet<string> = new Set(["effort", "format"]);
/** The content blocks a Goose session sends: text, its model's thinking, tool calls and their results. */
const BLOCKS: ReadonlySet<string> = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);
/** The image types the API takes, which a host tool's image may be, inside its result. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** The tokens a request keeps for its answer when its output is limited, and the least thinking budget the provider takes. */
const ANSWER_TOKENS_LEAST = 1024;
const THINKING_BUDGET_LEAST = 1024;

export interface GoosePolicyOptions {
  /** The session's model. */
  model: string;
  /** The session's host tools, by their names (`spec.tools`). */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 128 000, what Goose asks for. */
  maxOutputTokens?: number;
  /** How the provider takes its credential. Default `x-api-key` (Anthropic's API). */
  auth?: "x-api-key" | "bearer";
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (status: number, message: string): never => {
  throw new ProxyRefusal(status, message);
};

/** A content list (a message's, the system prompt's, a tool result's): only the block types a Goose session sends, and an
 *  image only inline inside a tool result, of a type the API takes (never one the provider would fetch). */
function blocks(content: unknown, where: string, inResult = false): void {
  if (content === undefined || typeof content === "string") return;
  if (!Array.isArray(content)) return refuse(400, `${where} must be a string or a list of blocks`);
  for (const block of content as unknown[]) {
    if (!isPlain(block) || typeof block.type !== "string") return refuse(400, `a block in ${where} must be an object with a type`);
    if (inResult && block.type === "image") {
      const source = block.source;
      if (!isPlain(source) || source.type !== "base64" || typeof source.media_type !== "string" || !IMAGE_TYPES.has(source.media_type) || typeof source.data !== "string") refuse(403, `${where} holds a block of a type this session does not send`);
      continue;
    }
    if (!BLOCKS.has(block.type)) refuse(403, `${where} holds a block of a type this session does not send`);
    if (block.type === "tool_result") blocks(block.content, "a tool result's content", true);
  }
}

/** The output tokens a Messages body asks for at most: its `max_tokens`. */
const outputAsked = (body: Record<string, unknown>): number | undefined => (typeof body.max_tokens === "number" && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : undefined);

/** The body the provider gets: checked, its model the session's, its `max_tokens` clamped. */
export function applyGoose(body: unknown, options: GoosePolicyOptions): Record<string, unknown> {
  if (!isPlain(body)) return refuse(400, "the body is not an object");
  for (const key of Object.keys(body)) if (!MESSAGES_KEYS.has(key)) refuse(403, "messages: a key outside the API's own is not allowed");
  if (body.output_config !== undefined) {
    if (!isPlain(body.output_config)) refuse(400, "output_config must be an object");
    for (const key of Object.keys(body.output_config as object)) if (!OUTPUT_CONFIG_KEYS.has(key)) refuse(403, "output_config: a key outside the API's own is not allowed");
  }
  if (body.model !== options.model) refuse(403, "the model is not this session's");
  if (!Array.isArray(body.messages)) refuse(400, "messages must be a list");
  for (const message of body.messages as unknown[]) {
    if (!isPlain(message)) refuse(400, "a message must be an object");
    blocks((message as Record<string, unknown>).content, "a message's content");
  }
  blocks(body.system, "system");
  const allowed = new Set([...options.tools.map(gooseToolName), ...GOOSE_OWN_TOOLS]);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) refuse(400, "tools is not a list");
    for (const tool of body.tools as unknown[]) {
      if (!isPlain(tool)) refuse(400, "a tool must be an object");
      const t = tool as Record<string, unknown>;
      if (t.type !== undefined && t.type !== "custom") refuse(403, "a provider-hosted tool is not offered to this session's model");
      if (typeof t.name !== "string" || !allowed.has(t.name)) refuse(403, "a tool this session does not have is offered: Goose's own tools must stay off");
    }
  }
  const choice = body.tool_choice;
  if (isPlain(choice) && choice.type === "tool" && !(typeof choice.name === "string" && allowed.has(choice.name))) refuse(403, "tool_choice names a tool this session does not have");
  const most = options.maxOutputTokens ?? 128_000;
  const max = Math.min(outputAsked(body) ?? most, most);
  const out: Record<string, unknown> = { ...body, max_tokens: max };
  const thinking = body.thinking;
  // Extended thinking's budget stays below max_tokens (as clamped); the provider takes no budget below 1024.
  if (isPlain(thinking) && thinking.type === "enabled") {
    const budget = thinking.budget_tokens;
    if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0) refuse(400, "thinking.budget_tokens must be a positive integer");
    if ((budget as number) >= max) {
      if (max <= THINKING_BUDGET_LEAST) refuse(400, `thinking.budget_tokens must be below max_tokens (${max} once clamped) and at least ${THINKING_BUDGET_LEAST}`);
      out.thinking = { ...thinking, budget_tokens: max - 1 };
    }
  }
  return out;
}

/** The least output a Messages body may be limited to and still answer: 1,024 tokens, and with a thinking budget the
 *  provider's least budget beside them. */
const outputLeast = (body: Record<string, unknown>): number => (isPlain(body.thinking) && body.thinking.type === "enabled" ? ANSWER_TOKENS_LEAST + THINKING_BUDGET_LEAST : ANSWER_TOKENS_LEAST);

/** `body` with its output limited to `max` tokens, thinking included; only numbers get smaller, so it is never longer. */
export function limitGooseOutput(body: Record<string, unknown>, max: number): Record<string, unknown> {
  const asked = outputAsked(body);
  const limited = asked === undefined ? max : Math.min(asked, max);
  const out: Record<string, unknown> = { ...body, max_tokens: limited };
  const thought = body.thinking;
  if (isPlain(thought) && thought.type === "enabled" && typeof thought.budget_tokens === "number" && thought.budget_tokens > limited - ANSWER_TOKENS_LEAST) {
    const budget = Math.max(THINKING_BUDGET_LEAST, limited - ANSWER_TOKENS_LEAST);
    if (budget >= limited) refuse(400, `max_tokens ${limited} leaves no room for the least thinking budget (${THINKING_BUDGET_LEAST}) and an answer`);
    out.thinking = { ...thought, budget_tokens: budget };
  }
  return out;
}

/** The thinking tokens a request may bill that its stream never shows (Claude streams a summary of its thinking): its
 *  budget, or its `max_tokens` when its thinking is adaptive; none with thinking off. */
const reasoningHidden = (body: Record<string, unknown>): number => {
  const thinking = body.thinking;
  if (!isPlain(thinking)) return 0;
  if (thinking.type === "enabled") return typeof thinking.budget_tokens === "number" && thinking.budget_tokens > 0 ? thinking.budget_tokens : outputAsked(body) ?? 0;
  return thinking.type === "adaptive" ? outputAsked(body) ?? 0 : 0;
};

/** One stream event's data, parsed, or undefined. */
function eventData(event: string): Record<string, unknown> | undefined {
  const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isPlain(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The bytes of a delta's piece in one stream event: of thinking alone (`thinking`), or of text, thinking and tool input. */
function deltaBytes(event: string, thinkingOnly: boolean): number {
  const parsed = eventData(event);
  const delta = parsed?.type === "content_block_delta" && isPlain(parsed.delta) ? parsed.delta : undefined;
  if (!delta) return 0;
  const piece = delta.type === "thinking_delta" ? delta.thinking : thinkingOnly ? undefined : delta.type === "text_delta" ? delta.text : delta.type === "input_json_delta" ? delta.partial_json : undefined;
  return typeof piece === "string" ? Buffer.byteLength(piece, "utf8") : 0;
}

const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** A Messages `usage` object as the proxy books it, or undefined when it says no input or output count. */
function bookedUsage(usage: unknown): ProxyUsage | undefined {
  if (!isPlain(usage)) return undefined;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: tokenCount(usage.cache_read_input_tokens) ?? 0, cacheWrite: tokenCount(usage.cache_creation_input_tokens) ?? 0 };
}

/** The data lines of a stream, parsed; each on its own, one that does not parse skipped (the proxy keeps only the head
 *  and tail of a long answer). Undefined for a whole JSON body. */
function streamEvents(text: string): Record<string, unknown>[] | undefined {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith("data:") || line.startsWith("event:"))) return undefined;
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const event: unknown = JSON.parse(line.slice(5));
      if (isPlain(event)) events.push(event);
    } catch {
      /* cut at the kept window's edge, or not JSON */
    }
  }
  return events;
}

/** The usage a Messages answer reports: a whole body's `usage`, or a stream's `message_start` usage with its last
 *  `message_delta` usage over it. A stream that never stopped (no `message_stop` or `error`) is unknown. */
export function gooseUsage(text: string): ProxyUsage | undefined {
  const events = streamEvents(text);
  if (!events) {
    try {
      const body: unknown = JSON.parse(text);
      return isPlain(body) ? bookedUsage(body.usage) : undefined;
    } catch {
      return undefined;
    }
  }
  if (!events.some((e) => e.type === "message_stop" || e.type === "error")) return undefined;
  const started = events.find((e) => e.type === "message_start")?.message;
  const startUsage = isPlain(started) && isPlain(started.usage) ? started.usage : {};
  const lastDelta = events.filter((e) => e.type === "message_delta").at(-1)?.usage;
  return bookedUsage({ ...startUsage, ...(isPlain(lastDelta) ? lastDelta : {}) });
}

/** Whether a Messages answer ended on the provider's refusal (`stop_reason: "refusal"`). */
function filtered(text: string): boolean {
  const events = streamEvents(text);
  if (!events) {
    try {
      const body: unknown = JSON.parse(text);
      return isPlain(body) && body.stop_reason === "refusal";
    } catch {
      return false;
    }
  }
  const stop = events.filter((e) => e.type === "message_delta" && isPlain(e.delta) && "stop_reason" in e.delta).at(-1)?.delta as { stop_reason?: unknown } | undefined;
  return stop?.stop_reason === "refusal";
}

/** `body` with `text` as a note the model reads after everything Goose sent: a text block at the end of the last user
 *  message, or a user message of its own after a last message that is not one. It carries no cache marker. */
function addNote(body: Record<string, unknown>, text: string): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const note = { type: "text", text: `<system-reminder>${text}</system-reminder>` };
  const last = messages.at(-1);
  if (isPlain(last) && last.role === "user") {
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : Array.isArray(last.content) ? last.content : [];
    return { ...body, messages: [...messages.slice(0, -1), { ...last, content: [...content, note] }] };
  }
  return { ...body, messages: [...messages, { role: "user", content: [note] }] };
}

/** The input tokens the provider bills for `body` beyond its bytes: the tool-use system prompt when it has tools, and each
 *  image at what it is billed as in place of its base64. */
function serverInputOverhead(body: Record<string, unknown>): number {
  const choice = isPlain(body.tool_choice) ? body.tool_choice.type : undefined;
  const shape: InputShape = {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    ...(choice === "auto" || choice === "none" || choice === "any" || choice === "tool" ? { toolChoice: choice } : {}),
    images: messagesImagesIn(body.messages),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
  };
  return providerInputOverhead("anthropic-messages", shape) as number;
}

/** Goose's provider policy for one session. */
export function goosePolicy(options: GoosePolicyOptions): ProviderPolicy {
  return {
    id: "goose-anthropic",
    routes: gooseRoutes(options.model),
    keyOf: (headers) => String(headers["x-api-key"] ?? ""),
    authHeaders: (credential): Record<string, string> => (options.auth === "bearer" ? { authorization: `Bearer ${credential}` } : { "x-api-key": credential }),
    header: (name, value) => {
      if (name !== "anthropic-beta") return value;
      const unknown = value.split(",").map((v) => v.trim()).filter((v) => v && !GOOSE_BETAS.has(v));
      if (unknown.length) refuse(403, "an anthropic-beta value is not one the pinned Goose sends");
      return value;
    },
    apply: (body) => applyGoose(body, options),
    modelOf: (body) => (typeof body.model === "string" ? body.model : undefined),
    serverInputOverhead,
    countInputLocally: (body) => messagesLocalInputTokens(body),
    inputAfter: (earlier: BilledRequest, body) => messagesInputAfter(earlier, body),
    outputAsked,
    outputLeast,
    effortOf: (body) => (isPlain(body.output_config) && typeof body.output_config.effort === "string" && body.output_config.effort ? body.output_config.effort : undefined),
    reasoningHidden,
    reasoningBytesOf: (event) => deltaBytes(event, true),
    contentBytesOf: (event) => deltaBytes(event, false),
    limitOutput: limitGooseOutput,
    addNote,
    usageOf: gooseUsage,
    filtered,
  };
}

/** The provider Goose's requests go to through the proxy. */
export interface GooseProvider {
  /** Its base (`https://api.anthropic.com`, or a gateway's): the proxy forwards to its `/v1/messages` only. */
  origin: string;
  /** The provider key, read per request in this process. It never reaches Goose. */
  credential: () => Promise<string | undefined> | string | undefined;
  /** How the provider takes it. Default `x-api-key`. */
  auth?: "x-api-key" | "bearer";
  /** Headers sent with every model request (a gateway's spend tags): Goose can neither set nor override them. */
  headers?: Readonly<Record<string, string>>;
}

export interface GooseProxyOptions {
  /** The run's model, as the provider names it. */
  model: string;
  provider: GooseProvider;
  /** The price of a response; null (or no function) records its cost as unknown. */
  price?: ModelProxyOptions["price"];
  maxOutputTokens?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** For tests: the fetch the proxy forwards with. */
  fetch?: typeof fetch;
}

/** The proxy option for a Goose adapter (`acpAdapter`'s `proxy`): each Goose process gets a model proxy of its own, on the
 *  session's booking, and is pointed at it with ANTHROPIC_HOST (plain http on loopback) and ANTHROPIC_API_KEY, the
 *  proxy's own key for the session, never the provider's. A provider stop on its content filter ends the drive. */
export function gooseProxy(options: GooseProxyOptions): AcpProxy {
  return async (session) => {
    const proxy = await startModelProxy({
      policy: goosePolicy({ model: options.model, tools: session.tools, ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}), ...(options.provider.auth ? { auth: options.provider.auth } : {}) }),
      hooks: session.models,
      model: options.model,
      origin: options.provider.origin,
      credential: async () => (await options.provider.credential()) ?? "",
      ...(options.price ? { price: options.price } : {}),
      ...(options.provider.headers ? { headers: options.provider.headers } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onFiltered: (message) => session.halt(new Error(message)),
    }, randomBytes(32).toString("base64url"));
    return { env: { ANTHROPIC_HOST: proxy.url, ANTHROPIC_API_KEY: proxy.key }, close: () => proxy.close() };
  };
}
