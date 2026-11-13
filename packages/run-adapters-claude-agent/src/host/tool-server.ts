// The session's host tools, served to the CLI as an in-process MCP server. Written for AgentRun.
//
// The Agent SDK's own `tool(name, description, shape)` takes a zod shape and builds a closed object from it, so a tool's
// schema reached the model as whatever that zod gave back (an open object came out closed, `properties: {}`) and its
// arguments were parsed through it (an open object's keys arrived as `{}`). This server answers `tools/list` with each
// tool's JSON Schema as the host gave it, unchanged, and hands `tools/call`'s arguments to the tool as the model sent
// them: the host (its executor) validates them, as it does for every other harness. The CLI's tool_use id comes in the
// call's `_meta`, which the durable call record is keyed by.
//
// A host tool's result within the host's bound (HOST_RESULT_MAX_CHARS) reaches the model whole. The pinned CLI checks an
// MCP tool's result twice: past its character limit (50,000 by default, the tool's `anthropic/maxResultSizeChars` up to
// 500,000 where it gives one) it saves the result to tool-results/<tool_use_id>.json in its config dir and tells the
// model to read that file, which a confined session cannot; past MAX_MCP_OUTPUT_TOKENS (25,000 by default) it saves the
// result the same way, or cuts one that holds an image. Each tool is listed with the bound as its maxResultSizeChars,
// which also spares a text result the token check, and the harness sets MAX_MCP_OUTPUT_TOKENS from it (env.ts).
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";

/** A tool as the model is shown it. */
export interface ServedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call's result, in MCP's shape: text, and any images the tool answered with (base64). */
export type ServedResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

/** The CLI's tool_use id, in a call's `_meta`. */
export const TOOL_USE_ID = "claudecode/toolUseId";

/** The `_meta` key of a listed tool by which the CLI takes the most characters of its result it passes whole. */
export const RESULT_SIZE_KEY = "anthropic/maxResultSizeChars";
/**
 * MAX_MCP_OUTPUT_TOKENS: the host's bound, as tokens. The CLI estimates a result at a quarter of a token a character and
 * 1,600 an image, and counts it exactly only past half its limit, so a result within the bound (with up to fifteen
 * images) is never counted, let alone saved or cut.
 */
export const MCP_OUTPUT_TOKENS = HOST_RESULT_MAX_CHARS;

/** `tools` as the server lists them to the CLI (`tools/list`): each as the host gave it, with the host's result bound as
 *  its result size. */
export const listedTools = (tools: readonly ServedTool[]) => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { [RESULT_SIZE_KEY]: HOST_RESULT_MAX_CHARS } }));

/** The MCP library the server is built with, as a host loaded it from where it installed the Agent SDK (its peer):
 *  `@modelcontextprotocol/sdk`'s `server/mcp.js` and `types.js`. */
export type ToolServerModules = { server: unknown; types: unknown };

/** The SDK's in-process server config for `tools`: `call(name, args, toolUseId)` answers each call. Built with `modules`,
 *  else with the MCP library imported by name, beside this package. */
export async function toolServer(name: string, tools: readonly ServedTool[], call: (tool: string, args: unknown, toolUseId: unknown) => Promise<ServedResult>, modules?: ToolServerModules) {
  type Server = typeof import("@modelcontextprotocol/sdk/server/mcp.js");
  type Types = typeof import("@modelcontextprotocol/sdk/types.js");
  const [{ McpServer }, { CallToolRequestSchema, ListToolsRequestSchema }] = modules
    ? [modules.server as Server, modules.types as Types]
    : await Promise.all([import("@modelcontextprotocol/sdk/server/mcp.js"), import("@modelcontextprotocol/sdk/types.js")]);
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const listed = listedTools(tools);
  const names = new Set(tools.map((t) => t.name));
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: tool, arguments: args, _meta } = request.params;
    if (!names.has(tool)) return { content: [{ type: "text" as const, text: `${tool} is not one of this session's tools` }], isError: true };
    return call(tool, args ?? {}, (_meta as Record<string, unknown> | undefined)?.[TOOL_USE_ID]);
  });
  return { type: "sdk" as const, name, instance: server };
}
