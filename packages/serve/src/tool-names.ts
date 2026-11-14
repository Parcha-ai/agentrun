// A tool's catalog name, read and written in one place: the grammar every place that takes one holds it to (an agent's
// grant, the tool settings, a learned workflow, a template's manifest and evals, the API's schemas). A catalog name is
//   <tool>               a tool of this server (`read`, `web_fetch`) or of a catalog (`monid.discover`)
//   mcp:<server>/<tool>  one tool of a saved MCP server
//   mcp:<server>/*       every tool of a saved MCP server (a settings key, and a grant read against its listing)
// An MCP server's name is lowercase letters, digits and `-`, starting with a letter, at most 32 (no `_`, so
// `mcp__<server>__<tool>` splits one way). An MCP tool's own name is letters, digits, `_` and `-`, at most 64: the
// characters the model APIs take in a tool's name, so there is one charset, and a name one place takes no other refuses.

const SERVER = "[a-z][a-z0-9-]{0,31}";
const TOOL = "[A-Za-z0-9_-]{1,64}";
const PLAIN = `[a-z][a-z0-9_-]{0,63}(?:\\.${TOOL})?`;
const MCP_PREFIX = "mcp:";
const MCP_ALL = "*";

/** An MCP server's name. */
export const MCP_SERVER_NAME = new RegExp(`^${SERVER}$`);
/** An MCP tool's own name, as its server lists it. */
export const MCP_TOOL_NAME = new RegExp(`^${TOOL}$`);
/** A catalog tool's name, as a JSON Schema pattern (openapi.ts): `monid.<tool>`, `mcp:<server>/<tool>` or `mcp:<server>/*`. */
export const CATALOG_KEY_PATTERN = `^(?:monid\\.${TOOL}|mcp:${SERVER}/(?:\\*|${TOOL}))$`;
const MCP_NAME = new RegExp(`^mcp:(${SERVER})/(\\*|${TOOL})$`);
const PLAIN_NAME = new RegExp(`^${PLAIN}$`);

/** A catalog name, read: a plain tool's, one MCP tool's, or an MCP server's wildcard (all its tools). */
export type ToolName = { kind: "plain"; name: string } | { kind: "mcp"; server: string; tool: string } | { kind: "mcp-server"; server: string };

/** Catalog name `name` read, or undefined for one outside the grammar. */
export function parseToolName(name: string): ToolName | undefined {
  if (!isMcpName(name)) return PLAIN_NAME.test(name) ? { kind: "plain", name } : undefined;
  const match = MCP_NAME.exec(name);
  if (!match) return undefined;
  return match[2] === MCP_ALL ? { kind: "mcp-server", server: match[1]! } : { kind: "mcp", server: match[1]!, tool: match[2]! };
}

/** The catalog name of `name`: parseToolName's inverse. */
export function formatToolName(name: ToolName): string {
  if (name.kind === "plain") return name.name;
  return `${MCP_PREFIX}${name.server}/${name.kind === "mcp" ? name.tool : MCP_ALL}`;
}

/** One MCP tool's catalog name, `mcp:<server>/<tool>`: what the gate, the pin and the timeline key its calls by. */
export const mcpToolName = (server: string, tool: string): string => formatToolName({ kind: "mcp", server, tool });

/** Whether `name` is in MCP's namespace (`mcp:`), well formed or not: a name MCP's checks answer for, so one that does
 *  not parse is refused in MCP's words, and the gate's default for it is MCP's (ask), never a built-in's. */
export const isMcpName = (name: string): boolean => name.startsWith(MCP_PREFIX);

/** One MCP tool's catalog name read (`mcp:<server>/<tool>`), or undefined for any other name, a server's wildcard too. */
export function mcpNameOf(name: string): { server: string; tool: string } | undefined {
  const parsed = parseToolName(name);
  return parsed?.kind === "mcp" ? { server: parsed.server, tool: parsed.tool } : undefined;
}

/** The MCP server `name` names, one of its tools or its wildcard; undefined for any other name. */
export function mcpServerOf(name: string): string | undefined {
  const parsed = parseToolName(name);
  return parsed && parsed.kind !== "plain" ? parsed.server : undefined;
}

/** Whether `name` is an MCP server's wildcard, `mcp:<server>/*`. */
export const isMcpWildcard = (name: string): boolean => parseToolName(name)?.kind === "mcp-server";
