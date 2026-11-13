// A claim's computer as an MCP server: the computer's tools (computer_observe, computer_act, computer_screenshot,
// computer_script, the hand-over, as its groups offer them) for a harness that speaks MCP and nothing of ours. The tools
// are the run's own bound ones (run-tools.ts RunTools.hostTools over its kindTools): the kernel registry's definitions,
// words and executors, on the run's held port, so an answer here is byte for byte the per-step tool's and the script's.
// Each answer is the tool's text, then its images as image blocks, and, when it did not fail, its value as
// structuredContent (the SDK wraps a value that is not an object as the client's protocol needs).
//
// Stateless Streamable HTTP through the official SDK: one McpServer per request (createMcpHandler), so nothing of one
// request is kept for the next. The route that serves it decides who may call it (the claim's own token) and goes
// through the run's gate before it hands a request here: this module checks nothing.
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { HostTool } from "@parcha/agentrun-kernel";

/** The MCP server's name and version, as a client's initialize reads them. */
export const COMPUTER_MCP_NAME = "agentrun-computer";
const VERSION = "1.0.0";

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** One tool's answer as MCP's CallToolResult. */
export type ComputerMcpAnswer = { content: Block[]; isError?: true; structuredContent?: unknown };

/** `tool`'s answer to `args` as an MCP client reads it: the same call a harness's session makes. */
export async function mcpAnswerOf(tool: HostTool, args: unknown, signal: AbortSignal, callId: string): Promise<ComputerMcpAnswer> {
  let given: Awaited<ReturnType<HostTool["call"]>>;
  try {
    given = await tool.call(args ?? {}, { callId, signal });
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error)?.message ?? String(error) }], isError: true };
  }
  const content: Block[] = [{ type: "text", text: given.text }, ...(given.images ?? []).map((image): Block => ({ type: "image", data: image.data, mimeType: image.mimeType }))];
  if (given.isError) return { content, isError: true };
  return { content, ...(given.structured !== undefined ? { structuredContent: given.structured } : {}) };
}

/** The MCP handler over `tools` (a claim's computer tools, bound to its run): `fetch` answers one Streamable HTTP
 *  request (POST of JSON-RPC; GET and DELETE as the SDK answers them statelessly). */
export function computerMcp(tools: readonly HostTool[]): { fetch(request: Request): Promise<Response> } {
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: COMPUTER_MCP_NAME, version: VERSION });
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]) }, (args: unknown, ctx) =>
        mcpAnswerOf(tool, args, ctx.mcpReq.signal, `mcp-${tool.name}-${++calls}`) as never);
    }
    return server;
  });
  return { fetch: (request) => handler.fetch(request) };
}
