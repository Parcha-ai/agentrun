// What OpenCode's model requests may carry through the session's model proxy (@parcha/agentrun-kernel/host), written for
// AgentRun. OpenCode's `openai` provider is the AI SDK's OpenAI Responses client: `POST <baseURL>/responses`, streamed,
// with the session's key as a bearer token (the provider's credential is added by the proxy). Of its headers only
// `accept` is forwarded.
//
// A refusal says what kind of thing it refused, never a value from the request (the proxy reports it to the client). A
// body may carry only the keys the pinned build sends (test/fixtures/responses-request-*.json, recorded behind a scripted
// gateway), `store` is always false, `include` may ask only for the encrypted reasoning a stateless request replays, and
// the model is the session's. `max_output_tokens` is clamped, and under a spend cap limited further to what is left of
// the cap can buy (the host's ticket, through `limitOutput`). No tool the provider runs on its own passes (one is
// refused), and a function tool that is not one of the session's (`hands_<host tool>`, OpenCode's name for the adapter's
// MCP tools) is dropped, so the model is offered exactly the host's tools.
//
// Usage is read from the stream's `response.completed` (or `response.incomplete`), each `data:` line parsed as JSON on
// its own, never matched as text (codex's reader, the same Responses API). OpenAI counts cached tokens inside
// `input_tokens`; they are booked apart. The watch reads each `function_call` item of an answer before OpenCode has it:
// its call id, name and arguments, which tie the MCP call OpenCode makes next (it carries no call id) to the model's own.
import type { IncomingHttpHeaders } from "node:http";
import { providerInputOverhead, ProxyRefusal, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-kernel/host";

/** The prefix OpenCode gives the adapter's MCP tools: the server is `hands`. */
export const TOOL_PREFIX = "hands_";

export const OPENCODE_RESPONSES_ROUTES: readonly ProxyRoute[] = Object.freeze([
  { method: "POST", path: "/v1/responses", headers: ["accept"] },
]);

/** The keys a Responses request from the pinned build may carry; anything else is refused. */
export const BODY_KEYS: ReadonlySet<string> = new Set(["model", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "include", "prompt_cache_key", "max_output_tokens", "text", "temperature", "top_p"]);
/** What `include` may ask for: the encrypted reasoning a stateless request sends back on the next one. */
const INCLUDE = new Set(["reasoning.encrypted_content"]);
const TEXT_KEYS = new Set(["format", "verbosity"]);
const VERBOSITY = new Set(["low", "medium", "high"]);

/** A function call an answer carries, as the watch reads it. */
export interface WatchedCall {
  callId: string;
  /** The model's name for the tool (`hands_<host tool>`). */
  name: string;
  /** The arguments' JSON text, as the model wrote it. */
  arguments: string;
}

export interface OpenCodePolicyOptions {
  /** The session's model: the body's model is set to it. */
  model: string;
  /** The session's own tool names (the host's): only `hands_<name>` function tools pass. */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** Told of each function call an answer carries, before OpenCode has that part of the answer. */
  onCall?: (call: WatchedCall) => void;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The session's own function tools, every other function dropped; a tool of any other kind is refused. */
function ownTools(tools: unknown, allowed: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(tools)) throw new ProxyRefusal(400, "tools is not a list");
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isPlain(tool)) throw new ProxyRefusal(400, "a tool definition is not an object");
    if (tool.type !== "function") throw new ProxyRefusal(403, "a provider-hosted or unknown kind of tool is not offered to this session's model");
    if (typeof tool.name === "string" && allowed.has(tool.name)) out.push(tool);
  }
  return out;
}

function toolChoice(choice: unknown, allowed: ReadonlySet<string>): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isPlain(choice) && choice.type === "function" && typeof choice.name === "string" && allowed.has(choice.name)) return choice;
  throw new ProxyRefusal(400, "tool_choice names a mode or tool this session does not offer");
}

function textOptions(text: unknown): Record<string, unknown> {
  const refuse = (): never => { throw new ProxyRefusal(400, "text carries something other than a format and a verbosity"); };
  if (!isPlain(text) || !Object.keys(text).every((key) => TEXT_KEYS.has(key))) refuse();
  const { format, verbosity } = text as Record<string, unknown>;
  if (verbosity !== undefined && !(typeof verbosity === "string" && VERBOSITY.has(verbosity))) refuse();
  if (format !== undefined && !(isPlain(format) && (format.type === "text" || format.type === "json_schema"))) refuse();
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

/** The object starting at `text[start]` (a `{`), as JSON text, or undefined when it does not close in `text`. */
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

// The content-filter stop, read as codex's policy reads it (run-adapters-codex host/policy.ts, the same Responses API),
// in its form that also reads a gateway's data-only events.
/**
 * Whether the provider stopped the answer on its content filter: the stream's terminal event (or a whole body) is an
 * `incomplete` response whose `incomplete_details.reason` is `content_filter`. Read by parsing each `data:` line on its
 * own, as usageOf reads the usage, never by matching text; an answer cut at its output limit (`max_output_tokens`) is not one.
 *
 * The terminal event carries the whole response (its output, encrypted reasoning included), so its line can be longer
 * than the proxy keeps of an answer; then the proxy's start of that line is read. The response's fields come in a fixed
 * order, `id`, `object`, `created_at`, `status`, `background`, `error`, `incomplete_details`, then `instructions`, the
 * tools and the output, so `incomplete_details` is near the line's start. It is read only on a line that is the event's
 * own: one the SSE `event: response.incomplete` names (OpenAI's API), or whose data says `"type":"response.incomplete"`
 * before its `"response":{` (a gateway that sends each event as its data alone: LiteLLM), as the first
 * `"incomplete_details":{` after `"response":{` (one JSON object), whatever the JSON's spacing.
 */
export function filtered(text: string, lineStarts: readonly string[] = []): boolean {
  let end = terminalResponse(text.split("\n"), false);
  if (end === undefined) {
    const whole = text.trimStart();
    if (whole.startsWith("{")) {
      try {
        const body = JSON.parse(whole) as unknown;
        if (isPlain(body) && body.object === "response") end = body;
      } catch {}
    }
  }
  end ??= terminalResponse(lineStarts, true);
  return isPlain(end) && end.status === "incomplete" && isPlain(end.incomplete_details) && end.incomplete_details.reason === "content_filter";
}

/** The response of the last terminal event in `lines` (`filtered`), each `data:` line parsed on its own; with `starts`,
 *  the lines are kept starts, and one that is a `response.incomplete` event's (by its name, or its data's type ahead of
 *  its response) is read from its start. */
function terminalResponse(lines: readonly string[], starts: boolean): unknown {
  let end: unknown;
  let named = false;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      named = line.slice(6).trim() === "response.incomplete";
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    const incomplete = named || ownIncomplete(data);
    named = false;
    if (!data.startsWith("{")) continue;
    try {
      const event: unknown = JSON.parse(data);
      if (isPlain(event) && typeof event.type === "string" && PAID_END.has(event.type)) end = event.response;
    } catch {
      // A line the window cut (skipped), or a kept start the event's name says is the stop's.
      if (starts && incomplete) end = startOfResponse(data) ?? end;
    }
  }
  return end;
}

const RESPONSE_KEY = /"response"\s*:\s*\{/;
const INCOMPLETE_TYPE = /"type"\s*:\s*"response\.incomplete"/;
const DETAILS_KEY = /"incomplete_details"\s*:\s*\{/;

/** Whether a kept start's data is a `response.incomplete` event's own: its `type` says so ahead of its `response` (a
 *  quote of it in an answer's text is escaped, so it never reads as one). */
function ownIncomplete(data: string): boolean {
  const type = data.search(INCOMPLETE_TYPE);
  const response = data.search(RESPONSE_KEY);
  return type >= 0 && (response < 0 || type < response);
}

/** The status and `incomplete_details` of the response a `response.incomplete` event's line starts with (`filtered`), or
 *  undefined when the line's kept start does not hold them. */
function startOfResponse(data: string): Record<string, unknown> | undefined {
  const response = data.search(RESPONSE_KEY);
  if (response < 0) return undefined;
  const found = DETAILS_KEY.exec(data.slice(response));
  if (!found) return undefined;
  const json = objectAt(data, response + found.index + found[0].length - 1);
  if (json === undefined) return undefined;
  try {
    return { status: "incomplete", incomplete_details: JSON.parse(json) as unknown };
  } catch {
    return undefined;
  }
}

/** The usage of the response an answer ends with: its `response.completed` (or `response.incomplete`) event, each `data:`
 *  line parsed on its own, or a whole JSON body's; for a line the proxy's 64 KiB window cut, the last `"usage":{` object
 *  in the text. Undefined, an unknown cost, when there is none. */
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
  const mark = "\"usage\":{";
  const at = text.lastIndexOf(mark);
  if (at < 0) return undefined;
  const json = objectAt(text, at + mark.length - 1);
  if (json === undefined) return undefined;
  try {
    return usageFrom(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** The items of `type` in `value`, at any depth. */
function itemsIn(value: unknown, type: string): number {
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + itemsIn(item, type), 0);
  if (!isPlain(value)) return 0;
  return (value.type === type ? 1 : 0) + Object.values(value).reduce((n: number, item) => n + itemsIn(item, type), 0);
}

/** The input tokens the provider bills for `body` that it does not carry (codex's figure: the same Responses API). A file
 *  input has no stated bound, so a body with one cannot be measured. */
export function responsesServerInputOverhead(body: Record<string, unknown>): number {
  if (itemsIn(body.input, "input_file") > 0) throw new Error("a file input's billed size has no stated bound");
  return providerInputOverhead("openai-responses", { tools: Array.isArray(body.tools) && body.tools.length > 0, images: itemsIn(body.input, "input_image") }) as number;
}

/** An event that is not whole by this many characters is not read. */
const EVENT_CAP = 4 * 1024 * 1024;

/** Reads an answer's server-sent events as they pass and tells `onCall` of each function call it carries. */
function watchCalls(onCall: (call: WatchedCall) => void): { chunk(text: string): void } {
  let line = "";
  let held = false;
  let data: string[] = [];
  let size = 0;
  let broken = false;
  const dispatch = () => {
    const text = data.join("\n");
    data = [];
    size = 0;
    if (!text.includes("function_call")) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const item = isPlain(event) && event.type === "response.output_item.done" && isPlain(event.item) ? event.item : undefined;
    if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      onCall({ callId: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" });
    }
  };
  const endLine = () => {
    const done = line;
    line = "";
    if (done === "") return dispatch();
    if (done.startsWith("data:")) {
      const value = done.slice(done.startsWith("data: ") ? 6 : 5);
      size += value.length + 1;
      if (size > EVENT_CAP) broken = true;
      else data.push(value);
    }
  };
  return {
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
          if (line.length > EVENT_CAP) broken = true;
        }
        if (broken) return;
      }
    },
  };
}

/** The tokens a request keeps for its answer when a spend cap limits its output. */
export const ANSWER_TOKENS_LEAST = 1024;
/** What a reasoning request at each effort is allowed for its reasoning beside its answer, when its output is limited:
 *  OpenAI's reasoning shares `max_output_tokens` and takes no budget, so a limit under its reasoning comes back
 *  incomplete with no answer. The figures are codex's (pi-ai's thinking budgets by level, xhigh at high's). */
export const REASONING_TOKENS_ALLOWED: Readonly<Record<string, number>> = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 });

/** The output tokens a Responses body asks for at most: its `max_output_tokens`, as `apply` clamped it. */
export function responsesOutputAsked(body: Record<string, unknown>): number | undefined {
  const asked = body.max_output_tokens;
  return typeof asked === "number" && Number.isSafeInteger(asked) && asked > 0 ? asked : undefined;
}

/** The least output a Responses body may be limited to and still answer: 1,024 tokens, plus its reasoning effort's
 *  allowance when it reasons. */
export function responsesOutputLeast(body: Record<string, unknown>): number {
  const effort = isPlain(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
  return ANSWER_TOKENS_LEAST + (effort === undefined ? 0 : (REASONING_TOKENS_ALLOWED[effort] ?? 0));
}

// What a stopped request counts, read as codex's policy reads it (run-adapters-codex host/policy.ts, the same Responses
// API): the reasoning its body lets it bill unseen, and the reasoning and the content each streamed event carries.

/** The reasoning tokens a Responses request may bill that its stream never shows (only a summary of its reasoning
 *  streams): its effort's budget; none at effort `none`; and with no effort the body says (the model then reasons at its
 *  own default, or not at all), its output limit, `fallback` when the body names none: the conservative side. An
 *  estimate, as the efforts' budgets are not limits the provider keeps: a stopped request counts the part of it that
 *  did not stream (less `responsesReasoningBytes` of what it sent), never past its hold. */
export function responsesReasoningHidden(body: Record<string, unknown>, fallback: number): number {
  const effort = isPlain(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
  if (effort === "none") return 0;
  const budget = effort === undefined ? undefined : REASONING_TOKENS_ALLOWED[effort];
  return budget ?? responsesOutputAsked(body) ?? fallback;
}

/** The Responses stream's events whose deltas are reasoning: its summary, and its reasoning text where a model sends it. */
const REASONING_DELTAS: ReadonlySet<string> = new Set(["response.reasoning_summary_text.delta", "response.reasoning_text.delta"]);

/** The bytes of reasoning one Responses stream event carries: a reasoning delta's text, UTF-8; 0 for answer text, a
 *  function call's arguments and every other event. */
export function responsesReasoningBytes(event: string): number {
  const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data.startsWith("{")) return 0;
  const parsed = JSON.parse(data) as { type?: unknown; delta?: unknown };
  return typeof parsed.type === "string" && REASONING_DELTAS.has(parsed.type) && typeof parsed.delta === "string" ? Buffer.byteLength(parsed.delta, "utf8") : 0;
}

/** The Responses stream's events whose deltas are content: answer text, reasoning, and a tool call's input. */
const CONTENT_DELTAS: ReadonlySet<string> = new Set([
  "response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta",
  "response.function_call_arguments.delta", "response.custom_tool_call_input.delta",
]);

/** The bytes of content one Responses stream event carries: a content delta's text, UTF-8, never the framing around it
 *  (its sequence number, item id, indexes, logprobs, obfuscation); 0 for every other event. */
export function responsesContentBytes(event: string): number {
  const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data.startsWith("{")) return 0;
  const parsed = JSON.parse(data) as { type?: unknown; delta?: unknown };
  return typeof parsed.type === "string" && CONTENT_DELTAS.has(parsed.type) && typeof parsed.delta === "string" ? Buffer.byteLength(parsed.delta, "utf8") : 0;
}

/** A Responses body with its output limited to `max` tokens, reasoning included: never raised, and never longer. */
export function limitResponsesOutput(body: Record<string, unknown>, max: number): Record<string, unknown> {
  const asked = responsesOutputAsked(body);
  return { ...body, max_output_tokens: asked === undefined ? max : Math.min(asked, max) };
}

export function openCodePolicy(options: OpenCodePolicyOptions): ProviderPolicy {
  const allowed = new Set(options.tools.map((name) => `${TOOL_PREFIX}${name}`));
  const maxOutputTokens = options.maxOutputTokens ?? 32_000;
  return {
    id: "opencode",
    routes: OPENCODE_RESPONSES_ROUTES,
    keyOf(headers: IncomingHttpHeaders) {
      const auth = String(headers.authorization ?? "");
      return auth.startsWith("Bearer ") ? auth.slice(7) : "";
    },
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply(body, _route, context) {
      if (!isPlain(body)) throw new ProxyRefusal(400, "the body is not a JSON object");
      // The host's own request beside OpenCode's (ProxyRequestContext.host) offers its own function tools (a learned
      // workflow node's `submit`); every other rule is the session's.
      const own: ReadonlySet<string> = context?.host !== undefined ? new Set(Array.isArray(body.tools) ? body.tools.filter((tool) => isPlain(tool) && tool.type === "function" && typeof tool.name === "string").map((tool) => (tool as { name: string }).name) : []) : allowed;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (!BODY_KEYS.has(key)) throw new ProxyRefusal(400, "the body has a field the OpenCode policy does not allow");
        out[key] = value;
      }
      if (out.include !== undefined && (!Array.isArray(out.include) || !out.include.every((item) => typeof item === "string" && INCLUDE.has(item)))) {
        throw new ProxyRefusal(400, "include asks for an item the OpenCode policy does not allow");
      }
      if (out.stream !== undefined && typeof out.stream !== "boolean") throw new ProxyRefusal(400, "stream is not a boolean");
      if (out.reasoning !== undefined && !isPlain(out.reasoning)) throw new ProxyRefusal(400, "reasoning is not an object");
      if (out.text !== undefined) out.text = textOptions(out.text);
      if (out.tools !== undefined) out.tools = ownTools(out.tools, own);
      if (Array.isArray(out.tools) && out.tools.length === 0) {
        // No tool of the session's left: none is offered, and no choice of one.
        delete out.tools;
        delete out.tool_choice;
      }
      if (out.tool_choice !== undefined) out.tool_choice = toolChoice(out.tool_choice, own);
      const asked = typeof out.max_output_tokens === "number" && out.max_output_tokens > 0 ? out.max_output_tokens : maxOutputTokens;
      return { ...out, model: options.model, store: false, max_output_tokens: Math.min(asked, maxOutputTokens) };
    },
    usageOf,
    filtered,
    watch: options.onCall ? () => watchCalls(options.onCall!) : undefined,
    modelOf: () => options.model,
    // Under a spend cap the host admits each request with what is left can buy, which goes into max_output_tokens.
    outputAsked: responsesOutputAsked,
    outputLeast: responsesOutputLeast,
    limitOutput: limitResponsesOutput,
    serverInputOverhead: responsesServerInputOverhead,
    // A stop counts the content it streamed, not the wire, and the part of its reasoning budget that did not stream.
    reasoningHidden: (body) => responsesReasoningHidden(body, maxOutputTokens),
    reasoningBytesOf: responsesReasoningBytes,
    contentBytesOf: responsesContentBytes,
  };
}
