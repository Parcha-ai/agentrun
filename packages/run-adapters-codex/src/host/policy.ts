// What the Codex CLI's model requests may carry through the session's model proxy (@parcha/agentrun-kernel/host),
// written for AgentRun. The routes are the ones the pinned CLI (0.164.0) calls, recorded behind a loopback proxy:
//  - `GET /`, a probe it sends without a key as it starts, answered here (never forwarded, never booked);
//  - `POST /v1/responses`, a paid request, streamed.
// The CLI sends the session's key as a bearer token; the provider's credential is added by the proxy. Of the CLI's own
// headers only `accept` is forwarded: its session, thread, window and request ids, its beta features and its originator
// stay here.
//
// A refusal says what kind of thing it refused, never a value from the request (the proxy reports it to the client).
// A body may carry only the keys the pinned CLI sends; `client_metadata` (its installation and session ids) is dropped,
// `store` is always false, `include` may ask only for the encrypted reasoning the CLI replays, `text` only for an output
// format (plain text, or the JSON schema a node's output schema becomes) and a verbosity, and the model is the session's.
// `max_output_tokens` is clamped. No tool the provider runs on its own passes: web search, which the CLI
// adds whatever its config says, is dropped, and any other provider-hosted tool is refused. A function or custom tool
// that is not one of the session's names is dropped, so the model is offered exactly the host's tools. This adapter
// runs classic function tools only: a code-mode request (its `additional_tools` carriers, exec and wait) is refused.
//
// Usage is read from the stream's `response.completed` (or `response.incomplete`, a paid response cut at its output
// limit), each `data:` line parsed as JSON on its own, never matched as text. OpenAI counts cached and cache-write tokens
// inside `input_tokens`; they are booked apart (as pi-ai books them), and reasoning tokens inside `output_tokens`.
import type { IncomingHttpHeaders } from "node:http";
import { ProxyRefusal, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-kernel/host";

export const CODEX_RESPONSES_ROUTES: readonly ProxyRoute[] = Object.freeze([
  { method: "GET", path: "/", local: 404 },
  { method: "POST", path: "/v1/responses", headers: ["accept"] },
]);

/** The keys a Responses request from the pinned CLI may carry; `client_metadata` is dropped, anything else refused. */
const BODY_KEYS = new Set(["model", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "include", "prompt_cache_key", "max_output_tokens", "text"]);
/** What `text` may say: the output's format (plain text, or the JSON schema a node's output schema becomes) and its
 *  verbosity. */
const TEXT_KEYS = new Set(["format", "verbosity"]);
const VERBOSITY = new Set(["low", "medium", "high"]);
const SCHEMA_FORMAT_KEYS = new Set(["type", "name", "schema", "strict"]);
const DROPPED_KEYS = new Set(["client_metadata"]);
/** What `include` may ask for: the encrypted reasoning the CLI sends back on its next request (`store` is false). */
const INCLUDE = new Set(["reasoning.encrypted_content"]);
/** Provider-hosted tools the CLI adds to every request whatever its config says: dropped, never offered. */
const DROPPED_TOOLS = new Set(["web_search", "web_search_preview"]);

export interface CodexPolicyOptions {
  /** The session's model: the body's model is set to it. */
  model: string;
  /** The session's own tool names: every other tool definition is dropped. */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of tool definitions with no provider-hosted tool, less any not the session's own. */
function ownTools(tools: unknown, allowed: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(tools)) throw new ProxyRefusal(400, "tools is not a list");
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isPlain(tool)) throw new ProxyRefusal(400, "a tool definition is not an object");
    const type = typeof tool.type === "string" ? tool.type : "";
    const name = typeof tool.name === "string" ? tool.name : "";
    if (DROPPED_TOOLS.has(type)) continue;
    if (type === "namespace") {
      // A namespace holds the tools of a built-in family: only the session's own ones stay, and an empty one goes.
      const kept = ownTools(tool.tools, allowed);
      if (kept.length) out.push({ ...tool, tools: kept });
      continue;
    }
    if (type !== "function" && type !== "custom") throw new ProxyRefusal(403, "a provider-hosted or unknown kind of tool is not offered to this session's model");
    if (allowed.has(name)) out.push(tool);
  }
  return out;
}

/** `tool_choice` as the provider gets it: a mode, or a function of the session's own. */
function toolChoice(choice: unknown, allowed: ReadonlySet<string>): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isPlain(choice) && choice.type === "function" && typeof choice.name === "string" && allowed.has(choice.name)) return choice;
  throw new ProxyRefusal(400, "tool_choice names a mode or tool this session does not offer");
}

/** `text` as the provider gets it: only a format (`{ type: "text" }`, or `{ type: "json_schema", name, schema, strict? }`)
 *  and a verbosity. */
function textOptions(text: unknown): Record<string, unknown> {
  const refuse = (): never => { throw new ProxyRefusal(400, "text carries something other than a plain-text or JSON-schema format and a verbosity"); };
  if (!isPlain(text) || !Object.keys(text).every((key) => TEXT_KEYS.has(key))) refuse();
  const { format, verbosity } = text as Record<string, unknown>;
  if (verbosity !== undefined && !(typeof verbosity === "string" && VERBOSITY.has(verbosity))) refuse();
  if (format !== undefined) {
    if (!isPlain(format)) refuse();
    const f = format as Record<string, unknown>;
    if (f.type === "text") {
      if (Object.keys(f).length !== 1) refuse();
    } else if (f.type === "json_schema") {
      if (!Object.keys(f).every((key) => SCHEMA_FORMAT_KEYS.has(key))) refuse();
      if (typeof f.name !== "string" || !isPlain(f.schema) || (f.strict !== undefined && typeof f.strict !== "boolean")) refuse();
    } else refuse();
  }
  return text as Record<string, unknown>;
}

/** A Responses usage object in the proxy's terms, or undefined when it is not one. */
function usageFrom(usage: unknown): ProxyUsage | undefined {
  if (!isPlain(usage)) return undefined;
  const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const details = isPlain(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const cacheRead = count(details.cached_tokens) ?? 0;
  const cacheWrite = count(details.cache_write_tokens) ?? 0;
  return { input: Math.max(0, input - cacheRead - cacheWrite), output, cacheRead, cacheWrite };
}

/** The object starting at `text[start]` (a `{`), as JSON text, or undefined when it does not close in `text`. Strings are
 *  skipped whole, so a brace inside one is not counted. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

const PAID_END = new Set(["response.completed", "response.incomplete"]);
const USAGE_KEY = "\"usage\":{";

/**
 * The usage a Responses answer reports, if it does: a stream's `response.completed` (or `response.incomplete`), each
 * `data:` line parsed on its own, or a whole JSON body's `usage`. The proxy keeps only the first and last 64 KiB of a long
 * answer, and the completed event carries the whole response (its tools and encrypted reasoning), so its line can be cut
 * at the window's start: then the last `"usage":{` key in the text (the response's, which a JSON string cannot contain
 * unescaped) is read as one JSON object. No completed event, or no usage in it, is undefined: an unknown cost.
 */
export function usageOf(text: string): ProxyUsage | undefined {
  let found: unknown;
  let ended = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue; // a line the window cut
    }
    if (isPlain(event) && typeof event.type === "string" && PAID_END.has(event.type)) {
      ended = true;
      found = isPlain(event.response) ? event.response.usage : undefined;
    }
  }
  if (ended) return usageFrom(found);
  const whole = text.trimStart();
  if (whole.startsWith("{")) {
    try {
      const body = JSON.parse(whole) as unknown;
      if (isPlain(body) && body.object === "response") return usageFrom(body.usage);
    } catch {}
  }
  const at = text.lastIndexOf(USAGE_KEY);
  if (at < 0) return undefined;
  const json = objectAt(text, at + USAGE_KEY.length - 1);
  if (json === undefined) return undefined;
  try {
    return usageFrom(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function codexPolicy(options: CodexPolicyOptions): ProviderPolicy {
  const allowed = new Set(options.tools);
  const maxOutputTokens = options.maxOutputTokens ?? 32_000;
  return {
    id: "codex",
    routes: CODEX_RESPONSES_ROUTES,
    keyOf(headers: IncomingHttpHeaders) {
      const auth = String(headers.authorization ?? "");
      return auth.startsWith("Bearer ") ? auth.slice(7) : "";
    },
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply(body) {
      if (!isPlain(body)) throw new ProxyRefusal(400, "the body is not a JSON object");
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (DROPPED_KEYS.has(key)) continue;
        if (!BODY_KEYS.has(key)) throw new ProxyRefusal(400, "the body has a field the Codex policy does not allow");
        out[key] = value;
      }
      if (out.include !== undefined && (!Array.isArray(out.include) || !out.include.every((item) => typeof item === "string" && INCLUDE.has(item)))) {
        throw new ProxyRefusal(400, "include asks for an item the Codex policy does not allow");
      }
      if (out.stream !== undefined && typeof out.stream !== "boolean") throw new ProxyRefusal(400, "stream is not a boolean");
      if (out.reasoning !== undefined && !isPlain(out.reasoning)) throw new ProxyRefusal(400, "reasoning is not an object");
      if (out.text !== undefined) out.text = textOptions(out.text);
      if (out.tools !== undefined) out.tools = ownTools(out.tools, allowed);
      if (out.tool_choice !== undefined) out.tool_choice = toolChoice(out.tool_choice, allowed);
      if (Array.isArray(out.input)) {
        if (out.input.some((item) => isPlain(item) && item.type === "additional_tools")) throw new ProxyRefusal(400, "code mode is not supported by this adapter yet: its tools run as classic function calls only");
      }
      const asked = typeof out.max_output_tokens === "number" && out.max_output_tokens > 0 ? out.max_output_tokens : maxOutputTokens;
      return { ...out, model: options.model, store: false, max_output_tokens: Math.min(asked, maxOutputTokens) };
    },
    usageOf,
    modelOf: (body) => (typeof body.model === "string" ? body.model : undefined),
  };
}
