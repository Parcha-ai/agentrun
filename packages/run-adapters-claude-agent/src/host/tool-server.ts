// The session's host tools, served to the CLI as an in-process MCP server. Written for AgentRun.
//
// The Agent SDK's own `tool(name, description, shape)` takes a zod shape and builds a closed object from it, so a tool's
// schema reached the model as whatever that zod gave back (an open object came out closed, `properties: {}`) and its
// arguments were parsed through it (an open object's keys arrived as `{}`). This server answers `tools/list` with each
// tool's JSON Schema as the host gave it, unchanged, and hands `tools/call`'s arguments to the tool as the model sent
// them: the host (its executor) validates them, as it does for every other harness. The CLI's tool_use id comes in the
// call's `_meta`, which the durable call record is keyed by.

/** A tool as the model is shown it. */
export interface ServedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call's result, in MCP's shape. */
export type ServedResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** The CLI's tool_use id, in a call's `_meta`. */
export const TOOL_USE_ID = "claudecode/toolUseId";

/** The SDK's in-process server config for `tools`: `call(name, args, toolUseId)` answers each call. */
export async function toolServer(name: string, tools: readonly ServedTool[], call: (tool: string, args: unknown, toolUseId: unknown) => Promise<ServedResult>) {
  const [{ McpServer }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const names = new Set(tools.map((t) => t.name));
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: tool, arguments: args, _meta } = request.params;
    if (!names.has(tool)) return { content: [{ type: "text" as const, text: `${tool} is not one of this session's tools` }], isError: true };
    return call(tool, args ?? {}, (_meta as Record<string, unknown> | undefined)?.[TOOL_USE_ID]);
  });
  return { type: "sdk" as const, name, instance: server };
}
