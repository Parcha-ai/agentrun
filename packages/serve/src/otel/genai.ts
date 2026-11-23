// The one mapping from a run's events to OpenTelemetry GenAI spans (semantic-conventions-genai v0.1.0): its names, its
// attributes and its renames. No @opentelemetry module is imported here, so the mapping loads (and is tested) with
// tracing off; tracer.ts makes spans of what it says.
//
// A run is one trace:
//   invoke_agent {harness}       INTERNAL  the claim's run of its agent; no usage, so a backend's sum never counts twice
//   ├─ chat {request.model}      CLIENT    one per model request through the session's proxy, with its usage
//   └─ execute_tool {tool.name}  INTERNAL  one per tool call (a nested call under the call that made it)
// A plan-billed harness (its wire `plan`: its requests never reach the host) has a chat span per turn, with no usage
// attributes at all and agentrun.billing=plan, never zeros; so does a request a plan billed (ModelUsage.billing).
// Content (messages, prompts, tool arguments and results) is never on a span here: no attribute below carries any.
import { normalizeUsage, otelUsage, type OtelUsage } from "@parcha/agentrun-import";
import type { Ended, ModelUsage } from "@parcha/agentrun-kernel";

/** The GenAI semantic conventions this mapping follows, stamped on every span until the spec has a schema URL. */
export const SEMCONV_VERSION = "genai-0.1.0";

export type Attributes = Record<string, string | number | boolean | string[]>;

/** The rename table: each of a request's counts, and every attribute name a backend reads it under. A cache write is
 *  sent under OpenTelemetry's name and Sentry's (`cache_creation`, the one its cost reads) until Sentry takes the other. */
export const USAGE_ATTRIBUTES: Readonly<Record<keyof OtelUsage, readonly string[]>> = Object.freeze({
  input: ["gen_ai.usage.input_tokens"],
  output: ["gen_ai.usage.output_tokens"],
  cacheRead: ["gen_ai.usage.cache_read.input_tokens"],
  cacheWrite: ["gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens"],
  reasoning: ["gen_ai.usage.reasoning.output_tokens"],
});

/** A model provider's name as gen_ai.provider.name has it, from the provider id a run names its model by: the plan and
 *  sign-in routes (chatgpt-plan.ts PLAN_PROVIDER, claude-login.ts CLAUDE_LOGIN_PROVIDER) are their vendor's API. Any
 *  other id is its own name. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({ chatgpt: "openai", "claude-login": "anthropic" });
export const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/** What a run's spans say of it, known once its spec is: its id, its harness, and the model route its requests take
 *  (AdapterRunSpec.trace), each where known. */
export interface TracedRun {
  readonly runId: string;
  readonly harness: string;
  /** The harness's model is billed to a plan (its wire `plan`): its turns are its chat spans, with no usage. */
  readonly plan?: boolean;
  /** The provider id its model is named by (`anthropic`, `openai`, `openrouter`). */
  readonly provider?: string;
  /** The host its requests go to (its route's origin). */
  readonly serverAddress?: string;
  /** The model it runs on, named on a plan turn's span (its requests are never seen). */
  readonly model?: string;
  /** The session's other routes (a subagent's tier, a grader's), by the name a request that came by one carries
   *  (ModelRequest.route): its provider and host, in place of the run's. */
  readonly routes?: ReadonlyMap<string, RouteTrace>;
}

/** A route as a trace names it: its provider id, its host, its model (routeTrace). */
export type RouteTrace = { readonly provider?: string; readonly serverAddress?: string; readonly model?: string };

/** A spec's route as its trace names it (AdapterRunSpec.trace): the provider id a `provider/model` name begins with, the
 *  host of the origin its requests go to, its model id. Each only where given and well formed. */
export function routeTrace(route: { readonly named?: string; readonly origin?: string; readonly model?: string }): RouteTrace {
  const slash = route.named?.indexOf("/") ?? -1;
  let host: string | undefined;
  try {
    host = route.origin ? new URL(route.origin).hostname || undefined : undefined;
  } catch {
    host = undefined;
  }
  return { ...(slash > 0 ? { provider: route.named!.slice(0, slash) } : {}), ...(host ? { serverAddress: host } : {}), ...(route.model ? { model: route.model } : {}) };
}

/** Span names: low-cardinality, never an id, a command or an argument. */
export const spanName = {
  agent: (run: TracedRun) => `invoke_agent ${run.harness}`,
  chat: (model: string | undefined) => (model ? `chat ${model}` : "chat"),
  tool: (name: string) => `execute_tool ${name}`,
};

/** What every span of the run carries. */
function common(run: TracedRun, operation: "invoke_agent" | "chat" | "execute_tool"): Attributes {
  return {
    "gen_ai.operation.name": operation,
    "gen_ai.conversation.id": run.runId,
    "gen_ai.agent.name": run.harness,
    "agentrun.harness": run.harness,
    "agentrun.run.id": run.runId,
    "session.id": run.runId,
    "agentrun.semconv.version": SEMCONV_VERSION,
  };
}

export const agentAttributes = (run: TracedRun): Attributes => common(run, "invoke_agent");

/** A request's counts on its span, by the rename table: gen_ai.usage.input_tokens INCLUSIVE of the cache (otelUsage, the
 *  import package's one reading of usage), never Anthropic's raw input. A request whose counts are not all counts has
 *  none. */
export function usageAttributes(usage: Pick<ModelUsage, "input" | "output" | "cacheRead" | "cacheWrite">): Attributes {
  const read = normalizeUsage("pi", { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
  if (!read) return {};
  const counts = otelUsage(read);
  const out: Attributes = {};
  for (const [key, names] of Object.entries(USAGE_ATTRIBUTES) as [keyof OtelUsage, readonly string[]][]) {
    const value = counts[key];
    if (value !== undefined) for (const name of names) out[name] = value;
  }
  return out;
}

/** Why a request did not answer, as error.type, or undefined when it did. */
export function requestError(ended: Ended | undefined, usage: Pick<ModelUsage, "cut">): string | undefined {
  if (!ended) return usage.cut ? "cut" : undefined;
  if (ended.end === "answered") return ended.label === "error" ? "provider_error" : undefined;
  if (ended.end === "stopped") return "stopped";
  return ended.label;
}

/** A model request's span: its route (the run's, or the one it came by: `route`, a name the run does not know naming
 *  none), the model asked, how it ended and, when it answered and is billed by the token, its counts. A plan's request
 *  has no counts at all, and says it is the plan's. */
export function chatAttributes(run: TracedRun, request: { readonly model?: string; readonly route?: string }, usage?: ModelUsage, ended?: Ended): Attributes {
  const model = request.model ?? run.model;
  const via: RouteTrace = request.route === undefined ? run : (run.routes?.get(request.route) ?? {});
  const plan = run.plan === true || usage?.billing === "plan";
  const error = usage ? requestError(ended, usage) : undefined;
  return {
    ...common(run, "chat"),
    ...(via.provider ? { "gen_ai.provider.name": providerName(via.provider) } : {}),
    ...(model ? { "gen_ai.request.model": model, "gen_ai.response.model": model } : {}),
    ...(via.serverAddress ? { "server.address": via.serverAddress } : {}),
    ...(ended?.end === "answered" && ended.label === "filtered" ? { "gen_ai.response.finish_reasons": ["content_filter"] } : {}),
    ...(plan ? { "agentrun.billing": "plan" } : usage && error === undefined ? usageAttributes(usage) : {}),
    ...(error ? { "error.type": error } : {}),
  };
}

/** A tool call's span: its name, its id, and whether it is an MCP server's (an extension, called with tools/call). */
export function toolAttributes(run: TracedRun, call: { readonly name: string; readonly callId: string; readonly mcp?: boolean }): Attributes {
  return {
    ...common(run, "execute_tool"),
    "gen_ai.tool.name": call.name,
    "gen_ai.tool.call.id": call.callId,
    "gen_ai.tool.type": call.mcp ? "extension" : "function",
    ...(call.mcp ? { "mcp.method.name": "tools/call" } : {}),
  };
}
