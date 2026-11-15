// A real stdio MCP server with one fixed, read-only fixture. It performs no filesystem or network operations.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STATUS } from './demo.mjs';

export function releaseMcpServer() {
  const server = new McpServer({ name: 'release', version: '1.0.0' });
  server.registerTool('release_status', {
    description: 'Read the current fictional release status. No side effects.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify(STATUS) }] }));
  return server;
}

if (import.meta.main) await releaseMcpServer().connect(new StdioServerTransport());
