// What a run's client may send a provider through the run's gateway (./gateway.ts), written for AgentRun. Each policy is a
// provider's own protocol as its clients speak it: pi-ai's Anthropic Messages and OpenAI Responses clients, and the session
// proxy of a claude-agent or codex run in the box. The run's token is where the protocol carries a key. They do not shape a
// harness's requests (pi, or the session proxy beside the CLI, does that in the box), so a client's new field or beta
// passes. They hold what the box must not get past serve:
//  - the run's models only: a body that names any other is refused, so serve's credential is spent on no model the run was
//    not given;
//  - nothing the provider would fetch or run for the box: a provider-hosted tool (web search or fetch, code execution, an
//    MCP connector, a container) or content it would fetch from a URL. A box with no network reaches no host through its
//    provider;
//  - nothing the provider holds under serve's credential, which another run may have left there: an uploaded file, an
//    earlier response or a conversation, named by id.
// A refusal says what kind of thing it refused, never a value from the request. Usage is not read: the gateway books
// nothing.
import type { IncomingHttpHeaders } from "node:http";
import { ProxyRefusal, type ProviderPolicy, type ProxyRoute } from "@parcha/agentrun-adapters/host";

export interface GatewayPolicyOptions {
  /** The model ids the run may name, as its client sends them. */
  models: readonly string[];
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (status: number, message: string): never => { throw new ProxyRefusal(status, message); };
const HOSTED_TOOL = "a provider-hosted tool is not offered through the run's gateway";
const FETCHED = "content the provider would fetch from a URL, or a file it holds, is not sent through the run's gateway";

/** The body, once it is an object that names one of the run's models. */
function ofTheRun(body: unknown, models: ReadonlySet<string>): Record<string, unknown> {
  if (!isPlain(body)) return refuse(400, "the body is not an object");
  if (typeof body.model !== "string" || !models.has(body.model)) refuse(403, "the model is not one this run was given");
  return body;
}

const bearer = (headers: IncomingHttpHeaders): string => {
  const auth = String(headers.authorization ?? "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};
const modelOf = (body: Record<string, unknown>) => (typeof body.model === "string" ? body.model : undefined);

const ANTHROPIC_HEADERS = ["anthropic-version", "anthropic-beta"] as const;
/** The Messages API's routes as the Anthropic SDK calls them (pi-ai's client, and the claude-agent CLI's session proxy). */
export const ANTHROPIC_GATEWAY_ROUTES: readonly ProxyRoute[] = Object.freeze([
  { method: "POST", path: "/v1/messages", query: ["beta=true"], headers: ANTHROPIC_HEADERS },
  { method: "POST", path: "/v1/messages/count_tokens", query: ["beta=true"], headers: ANTHROPIC_HEADERS, free: true },
]);
/** Keys of a Messages body that have the provider reach out on its own: an MCP connector's servers, a code-execution container. */
const ANTHROPIC_REACHING = ["mcp_servers", "container"] as const;

/** An Anthropic tool definition: the client's own (no type, or `custom`). */
function anthropicTool(tool: unknown): void {
  if (!isPlain(tool)) return refuse(400, "a tool must be an object");
  if (tool.type !== undefined && tool.type !== "custom") refuse(403, HOSTED_TOOL);
}

/** A Messages content list (the system prompt's, a message's, a tool result's): the blocks the provider reads. A block's
 *  source is where it would fetch from; a tool result's content and a document's own content are content lists too; a
 *  tool added as the conversation goes (pi-ai's `tool_addition`) is a definition like the list's. A tool call's input is
 *  the client's data, and is not read. */
function anthropicContent(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content as unknown[]) {
    if (!isPlain(block)) continue;
    const source = block.source;
    if (isPlain(source)) {
      if (source.type === "url" || source.type === "file") refuse(403, FETCHED);
      if (source.type === "content") anthropicContent(source.content);
    }
    if (block.type === "tool_result") anthropicContent(block.content);
    if (block.type === "tool_addition") anthropicTool(isPlain(block.tool) ? block.tool.definition : undefined);
  }
}

/** Anthropic's Messages API through the run's gateway. A client sends the run's token as `x-api-key` (the SDK, as pi-ai
 *  uses it) or as a bearer token; the provider gets serve's credential as `x-api-key`, or as a bearer token for a gateway
 *  that takes one (`auth`). */
export function anthropicGatewayPolicy(options: GatewayPolicyOptions & { auth?: "x-api-key" | "bearer" }): ProviderPolicy {
  const models = new Set(options.models);
  return {
    id: "gateway-anthropic",
    routes: ANTHROPIC_GATEWAY_ROUTES,
    keyOf: (headers) => (typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : bearer(headers)),
    authHeaders: (credential): Record<string, string> => (options.auth === "bearer" ? { authorization: `Bearer ${credential}` } : { "x-api-key": credential }),
    apply(input) {
      const body = ofTheRun(input, models);
      for (const key of ANTHROPIC_REACHING) if (body[key] !== undefined) refuse(403, "an MCP server or a container, which the provider would reach for the run, is not offered through the run's gateway");
      if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) refuse(400, "tools is not a list");
        for (const tool of body.tools as unknown[]) anthropicTool(tool);
      }
      anthropicContent(body.system);
      if (Array.isArray(body.messages)) for (const message of body.messages as unknown[]) if (isPlain(message)) anthropicContent(message.content);
      return body;
    },
    modelOf,
    usageOf: () => undefined,
  };
}

/** The Responses API's route as the OpenAI SDK calls it under a base that ends in `/v1` (pi-ai's client, and the codex
 *  CLI's session proxy). The provider's base is serve's without that `/v1`, as for codex (adapters.ts, gatewayBase). */
export const RESPONSES_GATEWAY_ROUTES: readonly ProxyRoute[] = Object.freeze([{ method: "POST", path: "/v1/responses", headers: ["accept"] }]);
/** Keys of a Responses body that name what the provider holds: an earlier response, a conversation. */
const RESPONSES_HELD = ["previous_response_id", "conversation"] as const;
const RESPONSES_CLIENT_TOOLS: ReadonlySet<unknown> = new Set(["function", "custom"]);

/** A Responses content list (a message's, a tool output's): an image or a file the provider would fetch or holds. */
function responsesContent(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const part of content as unknown[]) {
    if (!isPlain(part)) continue;
    if (part.type === "input_image" && (part.file_id !== undefined || (typeof part.image_url === "string" && !part.image_url.startsWith("data:")))) refuse(403, FETCHED);
    if (part.type === "input_file" && (part.file_id !== undefined || part.file_url !== undefined)) refuse(403, FETCHED);
  }
}

/** A list of Responses tool definitions: the client's own (`function`, `custom`), or a namespace of them. */
function responsesTools(tools: unknown): void {
  if (!Array.isArray(tools)) return refuse(400, "a tools list is not a list");
  for (const tool of tools as unknown[]) {
    if (!isPlain(tool)) return refuse(400, "a tool must be an object");
    if (tool.type === "namespace") responsesTools(tool.tools);
    else if (!RESPONSES_CLIENT_TOOLS.has(tool.type)) refuse(403, HOSTED_TOOL);
  }
}

/** OpenAI's Responses API, or a gateway's that speaks it, through the run's gateway: the run's token and serve's
 *  credential are both bearer tokens. */
export function responsesGatewayPolicy(options: GatewayPolicyOptions): ProviderPolicy {
  const models = new Set(options.models);
  return {
    id: "gateway-responses",
    routes: RESPONSES_GATEWAY_ROUTES,
    keyOf: bearer,
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply(input) {
      const body = ofTheRun(input, models);
      for (const key of RESPONSES_HELD) if (body[key] !== undefined) refuse(403, "an earlier response or a conversation the provider holds is not named through the run's gateway");
      if (body.tools !== undefined) responsesTools(body.tools);
      // Each input item: a message's content and a tool output's are content lists; the tools an item adds (pi-ai's
      // `additional_tools`, a client tool search's output) are definitions like the list's. A tool call's arguments are the
      // client's data, and are not read.
      if (Array.isArray(body.input)) {
        for (const item of body.input as unknown[]) {
          if (!isPlain(item)) continue;
          responsesContent(item.content);
          responsesContent(item.output);
          if (item.tools !== undefined) responsesTools(item.tools);
        }
      }
      return body;
    },
    modelOf,
    usageOf: () => undefined,
  };
}
