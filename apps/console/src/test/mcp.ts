import type { McpServer } from "@/lib/mcp";

// A saved MCP server as the server sends it (generated), for a test: what a test names, the rest filled in as a server
// listed once and never changed reads (no server info, no instructions, no prices).

/** A served MCP server from what a test gives. */
export const mcpServer = (given: Pick<McpServer, "name" | "url" | "auth" | "credential"> & Partial<McpServer>): McpServer => ({
  tools: [], protocol: "2025-06-18", server_info: null, listed_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z",
  ...given,
});
