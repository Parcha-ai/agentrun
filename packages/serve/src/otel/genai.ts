// The one mapping from a run's events to OpenTelemetry GenAI spans (semantic-conventions-genai v0.1.0): its names, its
// attributes and its renames. No @opentelemetry module is imported here, so the mapping loads (and is tested) with
// tracing off; tracer.ts makes spans of what it says.
//
// A run is one trace:
//   invoke_agent {agent name}    INTERNAL  the claim's run of its agent; no usage, so a backend's sum never counts twice
//   ├─ chat {request.model}      CLIENT    one per model request through the session's proxy, with its usage
//   └─ execute_tool {tool.name}  INTERNAL  one per tool call (a nested call under the call that made it)
// A plan-billed harness (its wire `plan`: its requests never reach the host) has a chat span per turn, with no usage
// attributes at all and agentrun.billing=plan, never zeros; so does a request a plan billed (ModelUsage.billing).
// Content (messages, prompts, tool arguments and results) is never on a span here: no attribute below carries any. Nor
// is a name the model wrote, as written: a refused call is unnamed, and any other name is cut (tracedEvent, tracedModel).
import { normalizeUsage, otelUsage, type OtelUsage } from "@parcha/agentrun-import";
import type { AdapterEvent, Ended, ModelUsage } from "@parcha/agentrun-kernel";
import { redactSecrets } from "../learn/secrets.js";

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

/** The agent a run is of, as its spans name it (gen_ai.agent.id, gen_ai.agent.name): its id, and its name as the person
 *  named it where it has one. Each already cut (tracedAgent). */
export interface TracedAgent {
  readonly id: string;
  readonly name?: string;
}

/** What a run's spans say of it, known once its spec is: its id, its agent, its harness, and the model route its
 *  requests take (AdapterRunSpec.trace), each where known. */
export interface TracedRun {
  readonly runId: string;
  /** The agent it is a run of: absent, its spans name none (never the harness in its place). */
  readonly agent?: TracedAgent;
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

/** What a run's trace hears of its session's events: a tool call's start, by the name its span carries (none: unnamed),
 *  whether it is an MCP server's, and whether its harness refused it (a tool the session does not have: never named); a
 *  call's end; a turn's end; any other event, only as the fact that one came. No content: no text, no argument, no
 *  result, and no name the model wrote that the session does not have. A call's `callId` matches its end and its
 *  children (`parent`); `shownId`, where given, is the id its span carries in its place (a run's process's post: its
 *  id cut, the raw one kept only to match). */
export type TraceEvent =
  | { readonly type: "tool_start"; readonly callId: string; readonly shownId?: string; readonly name?: string; readonly mcp?: boolean; readonly refused?: boolean; readonly parent?: string }
  | { readonly type: "tool_end"; readonly callId: string; readonly isError: boolean }
  | { readonly type: "turn_end"; readonly status: string }
  | { readonly type: "other" };

/** The longest name the model wrote that a span carries (a tool's, a model's): cut past it. */
export const WRITTEN_MAX = 64;

/** A name the model wrote, as a span may carry it: through the runner's redactor (every secret it holds cut), then cut at
 *  WRITTEN_MAX. */
export function written(name: string, redact?: (text: string) => string): string {
  const cut = redact ? redact(name) : name;
  return cut.length > WRITTEN_MAX ? cut.slice(0, WRITTEN_MAX) : cut;
}

/** The agent a run is of, as its runner reads it from the store: its id (the run row's) and its name (the agent row's;
 *  none when the row is gone). Not yet cut: tracedAgent cuts it. */
export interface AgentOfRun {
  readonly id: string;
  readonly name?: string | null;
}

/** The agent of a run whose row names agent `agentId`, read from `agents` (a store's Agents). Every run has one: an
 *  inline run (POST /runs) writes its agent's row, with its name, before the run. A read that fails is the id alone: a
 *  trace's name never fails a run, nor keeps a claim from its cleanup. */
export async function agentOfRun(agents: { get(id: string): Promise<{ readonly name: string } | undefined> }, agentId: string): Promise<AgentOfRun> {
  let row: { readonly name: string } | undefined;
  try {
    row = await agents.get(agentId);
  } catch {
    // The store could not be read: the run's row still holds the id.
  }
  return { id: agentId, ...(row ? { name: row.name } : {}) };
}

/** A run's agent as its spans carry it: its id and its name, each through the runner's redactor, then with every
 *  secret-shaped run cut (redactSecrets over no value: a name written like a key is cut whatever the runner holds), then
 *  cut at WRITTEN_MAX. A blank name (a purged agent's) is none: the spans then name no agent, as the conventions ask of a
 *  run with no meaningful name, and never the harness in its place. */
export function tracedAgent(agent: AgentOfRun, redact?: (text: string) => string): TracedAgent {
  const cut = (text: string) => written(redactSecrets(redact ? redact(text) : text, []));
  const name = agent.name?.trim() ? cut(agent.name) : undefined;
  return { id: cut(agent.id), ...(name ? { name } : {}) };
}

/** How a trace names what its session's events name: `mcp`, whether a tool of that name is an MCP server's; `redact`, the
 *  runner's redactor. */
export interface EventNaming {
  readonly mcp: (name: string) => boolean;
  readonly redact?: (text: string) => string;
}

/** A session's event as its trace hears it (TraceEvent). A call its harness refused (a tool the session does not have)
 *  is never named: the name is the model's own words. Any other is named through the runner's redactor (written). */
export function tracedEvent(event: AdapterEvent, naming: EventNaming): TraceEvent {
  if (event.type === "tool_start") {
    const parent = event.parent === undefined ? {} : { parent: event.parent };
    if (event.refused) return { type: "tool_start", callId: event.callId, refused: true, ...parent };
    return { type: "tool_start", callId: event.callId, name: written(event.name, naming.redact), ...(naming.mcp(event.name) ? { mcp: true } : {}), ...parent };
  }
  if (event.type === "tool_end") return { type: "tool_end", callId: event.callId, isError: event.isError };
  if (event.type === "turn_end") return { type: "turn_end", status: event.status };
  return { type: "other" };
}

/** The model a request's span names: the one asked when the run knows it (`known`: a route's model, or one its price
 *  table names by that same id); else the model of the route it came by (`routed`); failing that, the one asked. Whichever
 *  it is goes through the runner's redactor and the cut (written): a model a request body names is the client's (the
 *  model's) words, and a run in the runner's own process has no other boundary that cleans it. */
export function tracedModel(asked: string | undefined, rule: { readonly known: (model: string) => boolean; readonly routed?: string; readonly redact?: (text: string) => string }): string | undefined {
  if (asked === undefined) return undefined;
  return written(rule.known(asked) ? asked : (rule.routed ?? asked), rule.redact);
}

/** Span names: low-cardinality, never an id, a command or an argument. The run's span is named by its agent's name, else
 *  `invoke_agent` alone (the conventions' span name). */
export const spanName = {
  agent: (run: TracedRun) => (run.agent?.name ? `invoke_agent ${run.agent.name}` : "invoke_agent"),
  chat: (model: string | undefined) => (model ? `chat ${model}` : "chat"),
  tool: (name: string | undefined) => (name ? `execute_tool ${name}` : "execute_tool"),
};

/** What every span of the run carries: the agent as the conventions name it (gen_ai.agent.name, the person's name for
 *  it; gen_ai.agent.id, its id), and the harness that ran it on agentrun.harness, which no GenAI attribute names. */
function common(run: TracedRun, operation: "invoke_agent" | "chat" | "execute_tool"): Attributes {
  return {
    "gen_ai.operation.name": operation,
    "gen_ai.conversation.id": run.runId,
    ...(run.agent ? { "gen_ai.agent.id": run.agent.id } : {}),
    ...(run.agent?.name ? { "gen_ai.agent.name": run.agent.name } : {}),
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
    // The model asked for. gen_ai.response.model is never set: no usage the host reads names the model that answered.
    ...(model ? { "gen_ai.request.model": model } : {}),
    ...(via.serverAddress ? { "server.address": via.serverAddress } : {}),
    ...(ended?.end === "answered" && ended.label === "filtered" ? { "gen_ai.response.finish_reasons": ["content_filter"] } : {}),
    ...(plan ? { "agentrun.billing": "plan" } : usage && error === undefined ? usageAttributes(usage) : {}),
    ...(error ? { "error.type": error } : {}),
  };
}

/** A tool call's span: its name (where it has one), its id, and whether it is an MCP server's (an extension, called with
 *  tools/call). */
export function toolAttributes(run: TracedRun, call: { readonly name?: string; readonly callId: string; readonly mcp?: boolean }): Attributes {
  return {
    ...common(run, "execute_tool"),
    ...(call.name ? { "gen_ai.tool.name": call.name } : {}),
    "gen_ai.tool.call.id": call.callId,
    "gen_ai.tool.type": call.mcp ? "extension" : "function",
    ...(call.mcp ? { "mcp.method.name": "tools/call" } : {}),
  };
}
