// What the Claude Agent CLI's model requests may carry through the session's model proxy (@parcha/agentrun-adapters/host),
// written for AgentRun. The routes are the ones the pinned CLI calls:
//  - `HEAD /api/hello`, its connectivity check, answered by the proxy;
//  - `POST /v1/messages?beta=true`, a paid request;
//  - `POST /v1/messages/count_tokens?beta=true`, a free one;
// each with the headers that pick the API's version and betas (a beta not listed here is refused: a CLI that sends a new
// one is a CLI this adapter was not checked with).
// The CLI sends the session's key as a bearer token (`ANTHROPIC_AUTH_TOKEN`); the provider's credential is added by the
// proxy, as `x-api-key` for Anthropic's API or as a bearer token for a gateway that takes one.
//
// A refusal names the field or the kind of thing it refused, never a value from the request (the proxy reports it).
// A body may carry only the Messages API's own keys (no MCP server, container or service tier). Its model is the session's
// (or its small model, for the CLI's background calls); `max_tokens` is clamped, and a thinking budget kept below it.
// Nothing the provider would run or fetch on its own passes: a provider-hosted tool (web search or fetch, code execution,
// computer use, the server's bash or editor, a tool search) is refused, and a content block may only be of a type the
// pinned CLI sends (text, thinking, tool calls and results), so no server tool's block, MCP block, image or document
// passes. A tool of the session's own that is not one of its names (`mcp__hands__<name>`)
// is dropped, so the model is offered exactly the host's tools. With `webSearch`, one hosted tool passes: Anthropic's web
// search, exactly as the pinned CLI asks for it in the request its WebSearch tool makes. Usage is read from the stream's
// `message_start` (input and cache tokens) and its last `message_delta` (output, and the searches the provider ran).
import { providerInputOverhead, ProxyRefusal, type InputShape, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-adapters/host";

/** The prefix of the session's own tools, as the CLI names them (its in-process MCP server, `hands`). */
export const OWN_TOOL_PREFIX = "mcp__hands__";

const ANTHROPIC_HEADERS = ["anthropic-version", "anthropic-beta"] as const;
export const CLAUDE_MESSAGES_ROUTES: readonly ProxyRoute[] = Object.freeze([
  { method: "HEAD", path: "/api/hello", local: 200 },
  { method: "POST", path: "/v1/messages", query: ["beta=true"], headers: ANTHROPIC_HEADERS },
  { method: "POST", path: "/v1/messages/count_tokens", query: ["beta=true"], headers: ANTHROPIC_HEADERS, free: true },
]);

/** The `anthropic-beta` values the pinned CLI (2.1.286) sends, recorded per model behind this proxy (the real-CLI test
 *  and a probe of claude-sonnet-4-5, claude-sonnet-5-5, claude-opus-5-5 and claude-haiku-5-5): the set depends on the
 *  model. Any other is refused, so a CLI or a model that starts sending a new one is seen before it is trusted. */
export const CLAUDE_BETAS: ReadonlySet<string> = new Set([
  "claude-code-20250219",
  "context-management-2025-06-27",
  "effort-2025-11-24",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "mid-conversation-tool-changes-2026-07-01",
  "per-turn-control-2026-07-01",
  "prompt-caching-scope-2026-01-05",
  "thinking-token-count-2026-05-13",
]);

/** The keys a Messages request may carry, and a token count's. */
const MESSAGES_KEYS = new Set(["model", "messages", "system", "max_tokens", "metadata", "stop_sequences", "stream", "temperature", "top_k", "top_p", "tools", "tool_choice", "thinking", "context_management", "output_config"]);
const COUNT_TOKENS_KEYS = new Set(["model", "messages", "system", "tools", "tool_choice", "thinking", "context_management", "output_config"]);
const OUTPUT_CONFIG_KEYS = new Set(["effort", "format", "task_budget"]);
/** The content blocks the pinned CLI (2.1.286) sends in a session, recorded behind this proxy (the real-CLI test, with
 *  a model that thinks): any other type is refused, so a block the provider runs or resolves on its own (a server
 *  tool's call or result, an MCP block, a container upload, an image or document it would fetch) never passes, under
 *  whatever name the API gives it. A session's tools answer in text and its prompt is text, so it sends no image or
 *  document. */
export const CLAUDE_BLOCKS: ReadonlySet<string> = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);

/** Anthropic's web search server tool as the pinned CLI (2.1.286) asks for it: when the model calls the CLI's WebSearch,
 *  the CLI sends a request of its own on the session's model with this one tool (recorded behind a local server,
 *  test/fixtures/web-search-request-cli-2.1.286.json): its type and name, `max_uses: 8`, and the domains the model named.
 *  A later version (dynamic filtering runs code execution) or any other field is refused. */
export const CLAUDE_WEB_SEARCH_TOOL = "web_search_20250305";
const WEB_SEARCH_KEYS: ReadonlySet<string> = new Set(["type", "name", "max_uses", "allowed_domains", "blocked_domains"]);
/** The most searches one request may ask the provider for: the pinned CLI's `max_uses`. */
const WEB_SEARCH_MAX_USES = 8;
/** What one web search costs on Anthropic's API, in USD, beside the tokens: $10 per 1,000 searches, "Web search tool" in
 *  https://platform.claude.com/docs/en/about-claude/pricing (a search that errs is not billed). */
export const CLAUDE_WEB_SEARCH_USD = 0.01;

export interface AnthropicPolicyOptions {
  /** The session's model, and the one the CLI's small background calls use (default: the session's). */
  model: string;
  smallModel?: string;
  /** The session's own tool names (`spec.tools`): every other tool definition is dropped. */
  tools: readonly string[];
  /** The CLI's own tools the session has, offered by their own names beside its tools (`Skill`, when it has skills). */
  builtins?: readonly string[];
  /** The most output tokens one request may ask for. Default 128 000, what the pinned CLI asks for on current models. */
  maxOutputTokens?: number;
  /** Admit Anthropic's web search server tool (`CLAUDE_WEB_SEARCH_TOOL`), exactly as the pinned CLI asks for it; every
   *  other hosted tool stays refused, and so does every server tool's block (the CLI's WebSearch answers the model in
   *  text, so it never sends one back). Default off. */
  webSearch?: boolean;
  /** How the provider takes its credential. Default `x-api-key` (Anthropic's API). */
  auth?: "x-api-key" | "bearer";
  /** Told when a request on the session's main model carries no thinking and no effort: the model would answer without
   *  reasoning, which a session never asks for (the small model's background calls are not told). */
  onThinkingDisabled?: (request: { model: string }) => void;
}

/** Whether a Messages body asks the model to think: thinking on (adaptive, or a budget), or an effort level. */
export function thinks(body: Record<string, unknown>): boolean {
  const thinking = body.thinking;
  if (isPlain(thinking) && (thinking.type === "adaptive" || thinking.type === "enabled")) return true;
  const config = body.output_config;
  return isPlain(config) && typeof config.effort === "string" && config.effort.length > 0;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (status: number, message: string): never => { throw new ProxyRefusal(status, message); };

function onlyKeys(body: Record<string, unknown>, keys: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(body)) if (!keys.has(key)) refuse(403, `${what}: a key outside the API's own is not allowed`);
}

/** The image types the API takes, which a host tool's image may be. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** The note the CLI adds beside a tool's image: the file it kept in its own session directory. */
const LOCAL_IMAGE_NOTE = /^\[Image: source: [^\]\n]+\]$/;

/** A content list (a message's, the system prompt's, a tool result's): only the block types this session sends. An
 *  image only as a host tool answered it: inside its result, inline, of a type the API takes (never one the provider
 *  would fetch). */
function blocks(content: unknown, where: string, inResult = false): void {
  if (content === undefined || typeof content === "string") return;
  if (!Array.isArray(content)) refuse(400, `${where} must be a string or a list of blocks`);
  for (const block of content as unknown[]) {
    if (!isPlain(block) || typeof block.type !== "string") return refuse(400, `a block in ${where} must be an object with a type`);
    if (inResult && block.type === "image") {
      const source = block.source;
      if (!isPlain(source) || source.type !== "base64" || typeof source.media_type !== "string" || !IMAGE_TYPES.has(source.media_type) || typeof source.data !== "string") refuse(403, `${where} holds a block of a type this session does not send`);
      continue;
    }
    if (!CLAUDE_BLOCKS.has(block.type)) refuse(403, `${where} holds a block of a type this session does not send`);
    if (block.type === "tool_result") blocks(block.content, "a tool result's content", true);
  }
}

/** A message with the CLI's note of its own image file left out of each tool result that holds the image itself: the
 *  note names a path in the session's directory, which differs between a session and its resumption, and says nothing
 *  the image doesn't. */
function withoutImageNotes(message: unknown): unknown {
  if (!isPlain(message) || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as unknown[]).map((block) => {
    if (!isPlain(block) || block.type !== "tool_result" || !Array.isArray(block.content)) return block;
    const parts = block.content as unknown[];
    if (!parts.some((part) => isPlain(part) && part.type === "image")) return block;
    const kept = parts.filter((part) => !(isPlain(part) && part.type === "text" && typeof part.text === "string" && LOCAL_IMAGE_NOTE.test(part.text)));
    if (kept.length === parts.length) return block;
    changed = true;
    return { ...block, content: kept };
  });
  return changed ? { ...message, content } : message;
}

function outputConfig(config: unknown): void {
  if (config === undefined) return;
  if (!isPlain(config)) return refuse(400, "output_config must be an object");
  onlyKeys(config, OUTPUT_CONFIG_KEYS, "output_config");
}

/** Whether `tool` is the web search server tool as the pinned CLI asks for it: its type and name, at most
 *  `WEB_SEARCH_MAX_USES` searches, the domains as lists of names, and nothing else. */
function cliWebSearch(tool: Record<string, unknown>): boolean {
  const uses = tool.max_uses;
  const names = (domains: unknown) => domains === undefined || (Array.isArray(domains) && domains.every((d) => typeof d === "string"));
  return tool.type === CLAUDE_WEB_SEARCH_TOOL && tool.name === "web_search" && Object.keys(tool).every((key) => WEB_SEARCH_KEYS.has(key))
    && typeof uses === "number" && Number.isSafeInteger(uses) && uses >= 1 && uses <= WEB_SEARCH_MAX_USES && names(tool.allowed_domains) && names(tool.blocked_domains);
}

/** Whether a body offers the web search server tool. */
const offersWebSearch = (body: Record<string, unknown>): boolean => Array.isArray(body.tools) && body.tools.some((tool) => isPlain(tool) && tool.type === CLAUDE_WEB_SEARCH_TOOL);

/** The tools the provider gets: client tools of the session's own only; a provider-hosted one is refused, but for the
 *  web search tool as the pinned CLI asks for it, when the session has it. */
function ownTools(tools: unknown, allowed: ReadonlySet<string>, webSearch = false): unknown[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return refuse(400, "tools is not a list");
  return tools.filter((tool) => {
    if (!isPlain(tool)) return refuse(400, "a tool must be an object");
    if (webSearch && cliWebSearch(tool)) return true;
    if (tool.type !== undefined && tool.type !== "custom") refuse(403, "a provider-hosted tool is not offered to this session's model");
    return typeof tool.name === "string" && allowed.has(tool.name);
  });
}

/** Extended thinking's budget stays below `max_tokens` (as clamped); the provider takes no budget below 1024. */
function thinking(value: unknown, maxTokens: number): unknown {
  if (!isPlain(value) || value.type !== "enabled") return value;
  const budget = value.budget_tokens;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0) return refuse(400, "thinking.budget_tokens must be a positive integer");
  if (budget < maxTokens) return value;
  if (maxTokens <= 1024) return refuse(400, `thinking.budget_tokens must be below max_tokens (${maxTokens} once clamped) and at least 1024`);
  return { ...value, budget_tokens: maxTokens - 1 };
}

/** The body the provider gets for a request on `route`. */
export function applyAnthropic(body: unknown, route: ProxyRoute, options: AnthropicPolicyOptions): Record<string, unknown> {
  if (!isPlain(body)) return refuse(400, "the body is not an object");
  const count = route.path === "/v1/messages/count_tokens";
  onlyKeys(body, count ? COUNT_TOKENS_KEYS : MESSAGES_KEYS, count ? "count_tokens" : "messages");
  outputConfig(body.output_config);
  if (!Array.isArray(body.messages)) refuse(400, "messages must be a list");
  for (const message of body.messages as unknown[]) {
    if (!isPlain(message)) refuse(400, "a message must be an object");
    blocks((message as Record<string, unknown>).content, "a message's content");
  }
  blocks(body.system, "system");
  const allowed = new Set([...options.tools.map((name) => `${OWN_TOOL_PREFIX}${name}`), ...(options.builtins ?? [])]);
  const tools = ownTools(body.tools, allowed, options.webSearch);
  const choice = body.tool_choice;
  const chosen = isPlain(choice) && typeof choice.name === "string" && (allowed.has(choice.name) || (options.webSearch === true && choice.name === "web_search"));
  if (isPlain(choice) && choice.type === "tool" && !chosen) refuse(403, "tool_choice names a tool this session does not have");
  const small = options.smallModel ?? options.model;
  if (body.model !== options.model && body.model !== small) refuse(403, "the model is not this session's");
  const out: Record<string, unknown> = { ...body, messages: (body.messages as unknown[]).map(withoutImageNotes), ...(tools === undefined ? {} : { tools }) };
  if (count) return out;
  // A main-model request that would not think is said, never passed silently (it is still forwarded: the CLI decides
  // its own requests, and this is the record that one went without reasoning).
  if (body.model === options.model && !thinks(body)) {
    try { options.onThinkingDisabled?.({ model: options.model }); } catch { /* a host callback never breaks a request */ }
  }
  const most = options.maxOutputTokens ?? 128_000;
  const asked = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : most;
  const max = Math.min(asked, most);
  return { ...out, max_tokens: max, ...(body.thinking !== undefined ? { thinking: thinking(body.thinking, max) } : {}) };
}

/** A non-negative whole count, or undefined. */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** A Messages response's usage as the proxy books it: its tokens, and the web searches the provider ran for it
 *  (`usage.server_tool_use.web_search_requests`), only when there were any. */
export interface AnthropicUsage extends ProxyUsage {
  webSearches?: number;
}

/** A Messages `usage` object as the proxy books it, or undefined when it says no input or output count, or names web
 *  searches by a figure that is not a count (unknown, never zero). */
function bookedUsage(usage: unknown): AnthropicUsage | undefined {
  if (!isPlain(usage)) return undefined;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const said = isPlain(usage.server_tool_use) ? usage.server_tool_use.web_search_requests : undefined;
  const webSearches = said === undefined ? 0 : tokenCount(said);
  if (webSearches === undefined) return undefined;
  return { input, output, cacheRead: tokenCount(usage.cache_read_input_tokens) ?? 0, cacheWrite: tokenCount(usage.cache_creation_input_tokens) ?? 0, ...(webSearches ? { webSearches } : {}) };
}

/** `price` with each web search a response reports added at `CLAUDE_WEB_SEARCH_USD`: the host prices the tokens, the
 *  searches are Anthropic's flat rate. An unknown price stays unknown. */
export function withWebSearches(price: (model: string, usage: ProxyUsage) => number | null): (model: string, usage: ProxyUsage) => number | null {
  return (model, usage) => {
    const usd = price(model, usage);
    const count = (usage as AnthropicUsage).webSearches ?? 0;
    return usd === null || count === 0 ? usd : usd + count * CLAUDE_WEB_SEARCH_USD;
  };
}

/** The usage a Messages response reports, read by parsing it, never by matching its text (the API nests objects in
 *  `usage`): a whole body's `usage`, or a stream's `message_start` usage (input and cache tokens) with its last
 *  `message_delta` usage over it (the final counts, the web searches among them). Each SSE `data:` line is parsed on its
 *  own and one that does not parse is skipped (the proxy keeps only the head and tail of a long answer). A stream that
 *  never stopped, or an answer with no readable usage, is unknown. */
export function anthropicUsage(text: string): AnthropicUsage | undefined {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith("data:") || line.startsWith("event:"))) {
    let body: unknown;
    try { body = JSON.parse(text); } catch { return undefined; }
    return isPlain(body) ? bookedUsage(body.usage) : undefined;
  }
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const event: unknown = JSON.parse(line.slice(5));
      if (isPlain(event)) events.push(event);
    } catch { /* cut at the kept window's edge, or not JSON: skipped */ }
  }
  if (!events.some((e) => e.type === "message_stop")) return undefined;
  const started = events.find((e) => e.type === "message_start")?.message;
  const startUsage = isPlain(started) && isPlain(started.usage) ? started.usage : {};
  const lastDelta = events.filter((e) => e.type === "message_delta").at(-1)?.usage;
  return bookedUsage({ ...startUsage, ...(isPlain(lastDelta) ? lastDelta : {}) });
}

/** The Claude Agent CLI's provider policy for one session. */
/** The image blocks in `value`, at any depth (a tool's result holds them). */
function imagesIn(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + imagesIn(item), 0);
  if (!isPlain(value)) return 0;
  return (value.type === "image" ? 1 : 0) + Object.values(value).reduce((n: number, item) => n + imagesIn(item), 0);
}

/** The input tokens the provider bills for `body` that it does not carry (`providerInputOverhead`, with its sources): the
 *  tool-use system prompt when it has tools, and for each image the most it can be billed as, beyond its bytes. None
 *  can be said for a body with the web search tool: the provider bills the pages it finds as input, on each of its
 *  searches, so its input is unmeasured (undefined), never bounded by its bytes. */
export function anthropicServerInputOverhead(body: Record<string, unknown>): number | undefined {
  if (offersWebSearch(body)) return undefined;
  const choice = isPlain(body.tool_choice) ? body.tool_choice.type : undefined;
  const shape: InputShape = {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    ...(choice === "auto" || choice === "none" || choice === "any" || choice === "tool" ? { toolChoice: choice } : {}),
    images: imagesIn(body.messages),
  };
  return providerInputOverhead("anthropic-messages", shape) as number;
}

export function anthropicPolicy(options: AnthropicPolicyOptions): ProviderPolicy {
  return {
    id: "anthropic",
    routes: CLAUDE_MESSAGES_ROUTES,
    keyOf: (headers) => {
      const auth = String(headers.authorization ?? "");
      return auth.startsWith("Bearer ") ? auth.slice(7) : "";
    },
    authHeaders: (credential): Record<string, string> => (options.auth === "bearer" ? { authorization: `Bearer ${credential}` } : { "x-api-key": credential }),
    header: (name, value) => {
      if (name !== "anthropic-beta") return value;
      const unknown = value.split(",").map((v) => v.trim()).filter((v) => v && !CLAUDE_BETAS.has(v));
      if (unknown.length) refuse(403, "an anthropic-beta value is not one the pinned CLI sends");
      return value;
    },
    apply: (body, route) => applyAnthropic(body, route, options),
    // `apply` let through only the session's model or its small one.
    modelOf: (body) => (typeof body.model === "string" ? body.model : undefined),
    // Its undefined is no figure: the proxy reads it as an unmeasured input.
    serverInputOverhead: anthropicServerInputOverhead as (body: Record<string, unknown>) => number,
    usageOf: anthropicUsage,
  };
}
