// What the Codex CLI's model requests may carry through the session's model proxy (@parcha/agentrun-adapters/host),
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
// adds whatever its config says, is dropped, and any other provider-hosted tool is refused. A session with Codex's own web
// search on (`webSearch: "live"`) is the one exception: the live search tool the pinned CLI sends then passes, exactly as
// recorded (any other web search tool is refused), and each search the provider ran is booked at its per-call price
// (`withWebSearches`). A function or custom tool
// that is not one of the session's names is dropped, so the model is offered exactly the host's tools. A code-mode
// model's request carries Codex's own `exec` and `wait` in an `additional_tools` item; those pass, and nothing else in
// the item does (the sub-agent and user-input tools it also lists are dropped), so the model is offered exactly the
// host's tools, called from `exec` as nested ones.
//
// Usage is read from the stream's `response.completed` (or `response.incomplete`, a paid response cut at its output
// limit), each `data:` line parsed as JSON on its own, never matched as text. OpenAI counts cached and cache-write tokens
// inside `input_tokens`; they are booked apart (as pi-ai books them), and reasoning tokens inside `output_tokens`. The
// searches a response ran are read from the same event, its `tool_usage.web_search.num_requests`.
import type { IncomingHttpHeaders } from "node:http";
import { providerInputOverhead, ProxyRefusal, type ModelProxyOptions, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-adapters/host";

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
/** The web search tool the pinned CLI sends with `web_search = "live"` through the session's provider, recorded
 *  (test/fixtures/responses-request-web-search-live.json): its keys and their values, and nothing else. */
const LIVE_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({ type: "web_search", external_web_access: true });
const isLiveSearch = (tool: Record<string, unknown>) => Object.keys(tool).length === Object.keys(LIVE_SEARCH).length && Object.entries(LIVE_SEARCH).every(([key, value]) => tool[key] === value);

/**
 * OpenAI's price of one web search call by model: "Web search (all models)", $10.00 / 1k calls, with its search content
 * tokens billed at the model's rates in the response's own usage (https://developers.openai.com/api/docs/pricing, Tools).
 * gpt-4o-mini and gpt-4.1-mini bill each call's search content as a fixed block of 8,000 input tokens instead, so they are
 * not listed: their searches, like any model's not listed here (a gateway's own id, say), are an unknown cost, never $0.
 */
const WEB_SEARCH_USD: readonly (readonly [RegExp, number])[] = [
  [/^(?:gpt-5|o3|o4-mini)(?:[-.][a-z0-9.-]+)?$/, 0.01],
  [/^gpt-4(?:o|\.1)(?:-\d{4}-\d{2}-\d{2})?$/, 0.01],
];

/** The price of one web search call on `model`, or undefined when it is not known. */
export function webSearchUsd(model: string): number | undefined {
  return WEB_SEARCH_USD.find(([pattern]) => pattern.test(model))?.[1];
}

/** A response's usage, with the web searches it ran when the session's web search is on (null: the response did not say). */
export interface CodexUsage extends ProxyUsage {
  webSearches?: number | null;
}

/** `price` with each web search a response ran added at its model's per-call price. Unknown (null) when the tokens' price
 *  is, when the response did not say how many searches it ran, or when the model's search price is not known; a response
 *  that ran none costs what its tokens do. */
export function withWebSearches(price: NonNullable<ModelProxyOptions["price"]>): NonNullable<ModelProxyOptions["price"]> {
  return (model, usage) => {
    const tokens = price(model, usage);
    const searches = (usage as CodexUsage).webSearches;
    if (searches === 0 || tokens === null) return tokens;
    const each = webSearchUsd(model);
    return typeof searches === "number" && each !== undefined ? tokens + searches * each : null;
  };
}

export interface CodexPolicyOptions {
  /** The session's model: the body's model is set to it. */
  model: string;
  /** The session's own tool names: every other tool definition is dropped. */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** Codex's own web search, live: the live search tool the pinned CLI sends passes, and a `tool_choice` naming it. Each
   *  response's usage then carries the searches it ran (`webSearches`), which `withWebSearches` prices. Default off. */
  webSearch?: "live";
  /** Told, before Codex has the piece of an answer, what the answer carries: `response()` when an answer starts, and
   *  `exec(callId)` for each code-mode `exec` call it holds. The session ties a script's nested calls to the `exec` of the
   *  latest answer, which is known here before Codex can run anything of it. */
  announce?: { response(): void; exec(callId: string): void; failed(): void; end(): void };
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of tool definitions with no provider-hosted tool but the live web search when `search` is on, less any not the
 *  session's own. */
function ownTools(tools: unknown, allowed: ReadonlySet<string>, search = false): unknown[] {
  if (!Array.isArray(tools)) throw new ProxyRefusal(400, "tools is not a list");
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isPlain(tool)) throw new ProxyRefusal(400, "a tool definition is not an object");
    const type = typeof tool.type === "string" ? tool.type : "";
    const name = typeof tool.name === "string" ? tool.name : "";
    if (search && type === "web_search") {
      if (!isLiveSearch(tool)) throw new ProxyRefusal(403, "a web search tool other than the live one this session offers is not offered to its model");
      out.push(tool);
      continue;
    }
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

/** `tool_choice` as the provider gets it: a mode, a function of the session's own, or the web search when it is on. */
function toolChoice(choice: unknown, allowed: ReadonlySet<string>, search = false): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isPlain(choice) && choice.type === "function" && typeof choice.name === "string" && allowed.has(choice.name)) return choice;
  if (search && isPlain(choice) && choice.type === "web_search" && Object.keys(choice).length === 1) return choice;
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

/**
 * The value of `key` in the response an answer ends with: a stream's `response.completed` (or `response.incomplete`),
 * each `data:` line parsed on its own, or a whole JSON body's. The proxy keeps only the first and last 64 KiB of a long
 * answer, and the completed event carries the whole response (its tools and encrypted reasoning), so its line can be cut
 * at the window's start: then the last `"<key>":{` in the text (the response's, which a JSON string cannot contain
 * unescaped) is read as one JSON object. No completed event, or no `key` in it, is undefined.
 */
function endValue(text: string, key: "usage" | "tool_usage"): unknown {
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
      found = isPlain(event.response) ? event.response[key] : undefined;
    }
  }
  if (ended) return found;
  const whole = text.trimStart();
  if (whole.startsWith("{")) {
    try {
      const body = JSON.parse(whole) as unknown;
      if (isPlain(body) && body.object === "response") return body[key];
    } catch {}
  }
  const mark = `"${key}":{`;
  const at = text.lastIndexOf(mark);
  if (at < 0) return undefined;
  const json = objectAt(text, at + mark.length - 1);
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The usage a Responses answer reports at its end (`endValue`), or undefined, an unknown cost, when it reports none. */
export function usageOf(text: string): ProxyUsage | undefined {
  return usageFrom(endValue(text, "usage"));
}

/** The web searches a Responses answer ran, as its end reports them (`tool_usage.web_search.num_requests`, what OpenAI
 *  bills per call), or undefined when it does not say. */
export function webSearchesOf(text: string): number | undefined {
  const used = endValue(text, "tool_usage");
  const search = isPlain(used) ? used.web_search : undefined;
  const count = isPlain(search) ? search.num_requests : undefined;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
}

/** The items of `type` in `value`, at any depth (a tool's output holds them). */
function itemsIn(value: unknown, type: string): number {
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + itemsIn(item, type), 0);
  if (!isPlain(value)) return 0;
  return (value.type === type ? 1 : 0) + Object.values(value).reduce((n: number, item) => n + itemsIn(item, type), 0);
}

/**
 * The input tokens the provider bills for `body` that it does not carry (`providerInputOverhead`, with its sources). The
 * Responses API documents no prompt of its own that it adds on these routes (no hosted tool passes the policy but a
 * session's live web search, below), and the framing it puts around each input item and tool definition is a few tokens
 * each, fewer than the bytes of the JSON keys that item already spends in the body. An image is billed by its area, not
 * its bytes: each adds the most it can be billed as. A file input (a PDF, billed by its pages) has no stated bound, so a
 * body with one cannot be measured: this throws, and the request's input is unknown.
 */
export function responsesServerInputOverhead(body: Record<string, unknown>): number {
  if (itemsIn(body.input, "input_file") > 0) throw new Error("a file input's billed size has no stated bound");
  return providerInputOverhead("openai-responses", { tools: Array.isArray(body.tools) && body.tools.length > 0, images: itemsIn(body.input, "input_image") }) as number;
}

/** The text of a tool output item: a string, or the text of each of its parts. */
/** Codex's status header of a tool output: the text it starts with (its first part), never what the script printed after it. */
function statusText(item: Record<string, unknown>): string {
  if (typeof item.output === "string") return item.output;
  const first = Array.isArray(item.output) ? item.output[0] : undefined;
  return isPlain(first) && typeof first.text === "string" ? first.text : "";
}

/** Whether a script of code mode is still running, from the request's input alone: an `exec` whose output said "Script running
 *  with cell ID N" (it yielded and went on), and no later `wait` on N whose output says the script ended. */
function cellRunning(input: readonly unknown[]): boolean {
  const execs = new Set<string>();
  const waits = new Map<string, string>();
  const cells = new Set<string>();
  for (const item of input) {
    if (!isPlain(item) || typeof item.call_id !== "string") continue;
    const running = /^Script running with cell ID (\S+)/.exec(statusText(item));
    if (item.type === "custom_tool_call" && item.name === "exec") execs.add(item.call_id);
    else if (item.type === "custom_tool_call_output" && execs.has(item.call_id) && running) cells.add(running[1]!);
    else if (item.type === "function_call" && item.name === "wait" && typeof item.arguments === "string") {
      try {
        const cell = (JSON.parse(item.arguments) as { cell_id?: unknown }).cell_id;
        if (cell !== undefined) waits.set(item.call_id, String(cell));
      } catch {}
    } else if (item.type === "function_call_output" && waits.has(item.call_id) && !running) cells.delete(waits.get(item.call_id)!);
  }
  return cells.size > 0;
}

/** The code-mode runtime a request may carry: Codex's `exec` (a custom tool) and `wait` (a function), in the `functions`
 *  namespace of an `additional_tools` item. Every other tool the item lists is dropped, and an item of any other shape is
 *  refused. Other input items pass as they are. */
const CODE_MODE_TOOLS = new Map([["exec", "custom"], ["wait", "function"]]);
function codeModeCarrier(item: unknown, offerExec: boolean): unknown {
  if (!isPlain(item) || item.type !== "additional_tools") return item;
  if (!Array.isArray(item.tools)) throw new ProxyRefusal(400, "an additional_tools item has no tools list");
  const kept: unknown[] = [];
  for (const namespace of item.tools) {
    if (!isPlain(namespace) || namespace.type !== "namespace" || !Array.isArray(namespace.tools)) throw new ProxyRefusal(400, "an additional_tools item holds something other than a namespace");
    if (namespace.name !== "functions") continue;
    const own = namespace.tools.filter((tool) => isPlain(tool) && typeof tool.name === "string" && CODE_MODE_TOOLS.get(tool.name) === tool.type && (offerExec || tool.name !== "exec"));
    kept.push({ ...namespace, tools: own });
  }
  return { ...item, tools: kept };
}

/** An event that is not whole by this many characters is not read: the answer is then reported as not watched. */
const EVENT_CAP = 4 * 1024 * 1024;

/** Reads an answer's server-sent events as they pass (lines end in LF, CRLF or a bare CR; an event is its `data:` lines joined
 *  with LF, ended by a blank line), and tells `announce` of each code-mode `exec` call it holds. One that cannot be read to its
 *  end (an event over the cap) is reported as failed. `end` closes the answer. */
function watchResponse(announce: NonNullable<CodexPolicyOptions["announce"]>): { chunk(text: string): void; failed(): void; end(): void } {
  announce.response();
  let line = "";
  let held = false; // a CR ended the last piece: an LF that starts the next belongs to it
  let data: string[] = [];
  let size = 0;
  let broken = false;
  const fail = () => {
    if (broken) return;
    broken = true;
    announce.failed();
  };
  const dispatch = () => {
    const text = data.join("\n");
    data = [];
    size = 0;
    if (!text.includes("custom_tool_call")) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const item = isPlain(event) && event.type === "response.output_item.done" && isPlain(event.item) ? event.item : undefined;
    if (item?.type === "custom_tool_call" && item.name === "exec" && typeof item.call_id === "string") announce.exec(item.call_id);
  };
  const endLine = () => {
    const done = line;
    line = "";
    if (done === "") return dispatch();
    if (done.startsWith("data:")) {
      const value = done.slice(done.startsWith("data: ") ? 6 : 5);
      size += value.length + 1;
      if (size > EVENT_CAP) return fail();
      data.push(value);
    }
  };
  return {
    failed: () => fail(),
    end: () => announce.end(),
    chunk(text) {
      if (broken) return;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (held) {
          held = false;
          if (ch === "\n") continue;
        }
        if (ch === "\n") endLine();
        else if (ch === "\r") {
          endLine();
          held = true;
        } else {
          line += ch;
          if (line.length > EVENT_CAP) return fail();
        }
        if (broken) return;
      }
    },
  };
}

export function codexPolicy(options: CodexPolicyOptions): ProviderPolicy {
  const allowed = new Set(options.tools);
  const maxOutputTokens = options.maxOutputTokens ?? 32_000;
  const search = options.webSearch === "live";
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
      if (out.tools !== undefined) out.tools = ownTools(out.tools, allowed, search);
      if (out.tool_choice !== undefined) out.tool_choice = toolChoice(out.tool_choice, allowed, search);
      if (Array.isArray(out.input) && out.input.some((item) => isPlain(item) && item.type === "additional_tools")) {
        // While a script that yielded still runs, the model is offered `wait` and not `exec`: one script is live at a time.
        const offerExec = !cellRunning(out.input);
        out.input = out.input.map((item) => codeModeCarrier(item, offerExec));
        // One `exec` is open at a time (the session's barrier for a code-mode call rests on it): a code-mode request that allows
        // parallel calls is refused, and one that says nothing is sent with them off. A classic request is as the CLI sent it.
        if (out.parallel_tool_calls !== undefined && typeof out.parallel_tool_calls !== "boolean") throw new ProxyRefusal(400, "parallel_tool_calls is not a boolean");
        if (out.parallel_tool_calls === true) throw new ProxyRefusal(400, "parallel tool calls are not allowed in code mode: the model writes one exec at a time");
        out.parallel_tool_calls = false;
      }
      const asked = typeof out.max_output_tokens === "number" && out.max_output_tokens > 0 ? out.max_output_tokens : maxOutputTokens;
      return { ...out, model: options.model, store: false, max_output_tokens: Math.min(asked, maxOutputTokens) };
    },
    usageOf: search ? (text): CodexUsage | undefined => {
      const usage = usageOf(text);
      return usage && { ...usage, webSearches: webSearchesOf(text) ?? null };
    } : usageOf,
    watch: options.announce ? () => watchResponse(options.announce!) : undefined,
    unwatched: options.announce ? () => options.announce!.failed() : undefined,
    modelOf: (body) => (typeof body.model === "string" ? body.model : undefined),
    // The content a web search feeds the model is billed as input, and neither it nor the searches one response runs has a
    // stated bound: a body that offers web search cannot be measured, so its input is unknown.
    serverInputOverhead: search ? (body) => {
      if (Array.isArray(body.tools) && body.tools.some((tool) => isPlain(tool) && tool.type === "web_search")) throw new Error("a web search's content and calls have no stated bound");
      return responsesServerInputOverhead(body);
    } : responsesServerInputOverhead,
  };
}
