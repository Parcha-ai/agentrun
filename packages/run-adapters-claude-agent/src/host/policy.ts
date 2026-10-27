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
// is dropped, so the model is offered exactly the host's tools. Usage is read from the stream's `message_start` (input
// and cache tokens) and its last `message_delta` (output).
import { ProxyRefusal, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-adapters/host";

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

export interface AnthropicPolicyOptions {
  /** The session's model, and the one the CLI's small background calls use (default: the session's). */
  model: string;
  smallModel?: string;
  /** The session's own tool names (`spec.tools`): every other tool definition is dropped. */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 128 000, what the pinned CLI asks for on current models. */
  maxOutputTokens?: number;
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

/** A content list (a message's, the system prompt's, a tool result's): only the block types this session sends. */
function blocks(content: unknown, where: string): void {
  if (content === undefined || typeof content === "string") return;
  if (!Array.isArray(content)) refuse(400, `${where} must be a string or a list of blocks`);
  for (const block of content as unknown[]) {
    if (!isPlain(block) || typeof block.type !== "string") return refuse(400, `a block in ${where} must be an object with a type`);
    if (!CLAUDE_BLOCKS.has(block.type)) refuse(403, `${where} holds a block of a type this session does not send`);
    if (block.type === "tool_result") blocks(block.content, "a tool result's content");
  }
}

function outputConfig(config: unknown): void {
  if (config === undefined) return;
  if (!isPlain(config)) return refuse(400, "output_config must be an object");
  onlyKeys(config, OUTPUT_CONFIG_KEYS, "output_config");
}

/** The tools the provider gets: client tools of the session's own only; a provider-hosted one is refused. */
function ownTools(tools: unknown, allowed: ReadonlySet<string>): unknown[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return refuse(400, "tools is not a list");
  return tools.filter((tool) => {
    if (!isPlain(tool)) return refuse(400, "a tool must be an object");
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
  const allowed = new Set(options.tools.map((name) => `${OWN_TOOL_PREFIX}${name}`));
  const tools = ownTools(body.tools, allowed);
  const choice = body.tool_choice;
  if (isPlain(choice) && choice.type === "tool" && !(typeof choice.name === "string" && allowed.has(choice.name))) refuse(403, "tool_choice names a tool this session does not have");
  const small = options.smallModel ?? options.model;
  if (body.model !== options.model && body.model !== small) refuse(403, "the model is not this session's");
  const out: Record<string, unknown> = { ...body, ...(tools === undefined ? {} : { tools }) };
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

/** The usage a Messages response reports: the stream's `message_start` and last `message_delta`, or a whole body's. */
export function anthropicUsage(text: string): ProxyUsage | undefined {
  const number = (from: string, field: string) => {
    const m = new RegExp(`"${field}"\\s*:\\s*(\\d+)`).exec(from);
    return m ? Number(m[1]) : undefined;
  };
  // A whole (non-streamed) body.
  if (!/^\s*(?:event|data):/m.test(text)) {
    const usage = /"usage"\s*:\s*\{[^{}]*\}/.exec(text)?.[0];
    const input = usage ? number(usage, "input_tokens") : undefined;
    const output = usage ? number(usage, "output_tokens") : undefined;
    if (input === undefined || output === undefined) return undefined;
    return { input, output, cacheRead: number(usage!, "cache_read_input_tokens") ?? 0, cacheWrite: number(usage!, "cache_creation_input_tokens") ?? 0 };
  }
  // A stream counts only once it stopped: a cut one reports nothing.
  if (!/"type"\s*:\s*"message_stop"/.test(text)) return undefined;
  const start = /"type"\s*:\s*"message_start"[\s\S]*?"usage"\s*:\s*(\{[^{}]*\})/.exec(text)?.[1];
  if (!start) return undefined;
  const end = [...text.matchAll(/"type"\s*:\s*"message_delta"[\s\S]*?"usage"\s*:\s*(\{[^{}]*\})/g)].at(-1)?.[1];
  return {
    input: number(start, "input_tokens") ?? 0,
    output: (end ? number(end, "output_tokens") : undefined) ?? number(start, "output_tokens") ?? 0,
    cacheRead: number(start, "cache_read_input_tokens") ?? 0,
    cacheWrite: number(start, "cache_creation_input_tokens") ?? 0,
  };
}

/** The Claude Agent CLI's provider policy for one session. */
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
    usageOf: anthropicUsage,
  };
}
