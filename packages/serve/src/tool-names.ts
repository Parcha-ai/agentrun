// A tool's catalog name, read and written in one place: the grammar every place that takes one holds it to (an agent's
// grant, the tool settings, a learned workflow, a template's manifest and evals, the API's schemas). A catalog name is
//   <tool>                       a tool of this server (`read`, `web_fetch`, `decisions.jev`)
//   <source>:<group>/<action>    one tool of a source: `mcp:<server>/<tool>`, `monid:<provider>/<endpoint>`
//   <source>:<group>/*           every tool of a group (a settings key, and a grant read against its listing)
// An MCP server's name is lowercase letters, digits and `-`, starting with a letter, at most 32 (no `_`, so
// `mcp__<server>__<tool>` splits one way). An MCP tool's own name is letters, digits, `_` and `-`, at most 64: the
// characters the model APIs take in a tool's name, so there is one charset, and a name one place takes no other refuses.
// A monid provider's slug and an endpoint's path are monid's own (its listing, GET /v1/endpoints): a slug is lowercase
// letters, digits, `.` and `-` (`apollo`, `api.strale.io`); an endpoint is its path less the leading `/`, in letters,
// digits and `-._:{}/` (`people/match`, `people/{id}`). Its wire name is catalog.ts wireName's, hashed when long.

import { WIRE_NAME } from "./catalog.js";

const SERVER = "[a-z][a-z0-9-]{0,31}";
const TOOL = "[A-Za-z0-9_-]{1,64}";
const PROVIDER = "[a-z0-9][a-z0-9.-]{0,63}";
const ENDPOINT = "[A-Za-z0-9_.:{}-][A-Za-z0-9_.:{}/-]{0,199}";
const PLAIN = `[a-z][a-z0-9_-]{0,63}(?:\\.${TOOL})?`;
const MCP_PREFIX = "mcp:";
const MONID_PREFIX = "monid:";
const ALL = "*";

/** An MCP server's name. */
export const MCP_SERVER_NAME = new RegExp(`^${SERVER}$`);
/** An MCP tool's own name, as its server lists it. */
export const MCP_TOOL_NAME = new RegExp(`^${TOOL}$`);
/** A catalog tool's name, as a JSON Schema pattern (openapi.ts): `mcp:<server>/<tool>`, `monid:<provider>/<endpoint>`,
 *  or either's wildcard. */
export const CATALOG_KEY_PATTERN = `^(?:mcp:${SERVER}/(?:\\*|${TOOL})|monid:${PROVIDER}/(?:\\*|${ENDPOINT}))$`;
const MCP_NAME = new RegExp(`^mcp:(${SERVER})/(\\*|${TOOL})$`);
const MONID_NAME = new RegExp(`^monid:(${PROVIDER})/(\\*|${ENDPOINT})$`);
const PLAIN_NAME = new RegExp(`^${PLAIN}$`);

/** A catalog name, read: a plain tool's, one MCP tool's or one monid endpoint's, or a group's wildcard (an MCP server's
 *  tools, a monid provider's endpoints). */
export type ToolName =
  | { kind: "plain"; name: string }
  | { kind: "mcp"; server: string; tool: string }
  | { kind: "mcp-server"; server: string }
  | { kind: "monid"; provider: string; endpoint: string }
  | { kind: "monid-provider"; provider: string };

/** Catalog name `name` read, or undefined for one outside the grammar. */
export function parseToolName(name: string): ToolName | undefined {
  if (isMonidName(name)) {
    const match = MONID_NAME.exec(name);
    if (!match) return undefined;
    return match[2] === ALL ? { kind: "monid-provider", provider: match[1]! } : { kind: "monid", provider: match[1]!, endpoint: match[2]! };
  }
  if (!isMcpName(name)) return PLAIN_NAME.test(name) ? { kind: "plain", name } : undefined;
  const match = MCP_NAME.exec(name);
  if (!match) return undefined;
  return match[2] === ALL ? { kind: "mcp-server", server: match[1]! } : { kind: "mcp", server: match[1]!, tool: match[2]! };
}

/** The catalog name of `name`: parseToolName's inverse. */
export function formatToolName(name: ToolName): string {
  if (name.kind === "plain") return name.name;
  if (name.kind === "monid" || name.kind === "monid-provider") return `${MONID_PREFIX}${name.provider}/${name.kind === "monid" ? name.endpoint : ALL}`;
  return `${MCP_PREFIX}${name.server}/${name.kind === "mcp" ? name.tool : ALL}`;
}

/** Whether `name` is in monid's namespace (`monid:`), well formed or not, as isMcpName is for MCP's. */
export const isMonidName = (name: string): boolean => name.startsWith(MONID_PREFIX);
/** Whether `name` is a third-party catalog's (MCP's or monid's), well formed or not: its default is ask. */
export const isCatalogName = (name: string): boolean => isMcpName(name) || isMonidName(name);
/** Why `name`, in monid's namespace, is refused as a grant by its name alone. */
export const MONID_NAME_WORDS = (name: string): string => `${name} is not a monid endpoint's name: monid:<provider>/<endpoint> or monid:<provider>/*, the provider's slug (lowercase letters, digits, . and -) and the endpoint's path without its first / (letters, digits and -._:{}/), as monid lists them.`;
/** One monid endpoint's catalog name read (`monid:<provider>/<endpoint>`), or undefined for any other name. */
export function monidNameOf(name: string): { provider: string; endpoint: string } | undefined {
  const parsed = parseToolName(name);
  return parsed?.kind === "monid" ? { provider: parsed.provider, endpoint: parsed.endpoint } : undefined;
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
  return parsed?.kind === "mcp" || parsed?.kind === "mcp-server" ? parsed.server : undefined;
}

/** Whether `name` is an MCP server's wildcard, `mcp:<server>/*`. */
export const isMcpWildcard = (name: string): boolean => parseToolName(name)?.kind === "mcp-server";

/** Why a grant of an MCP server's tool is refused by its name alone, said after the grant (`mcp:<server>/<tool> ...`): the
 *  one place the console's picker and the save's blockers (runnable.ts) both read it. `hands` is the harnesses' own tools'
 *  server. */
export const MCP_HANDS_WORDS = "names the MCP server hands, a name the harnesses keep for their own tools: save the server under another name.";
/** Why `mcp__<server>__<tool>`, the name every harness calls the tool by, is not within the budget their names share
 *  (52 characters of letters, digits, `_` and `-`), or undefined when it is. */
export function mcpWireProblem(server: string, tool: string): string | undefined {
  const wire = `mcp__${server}__${tool}`;
  return WIRE_NAME.test(wire) ? undefined : `is too long: ${wire} must be at most 52 characters, the budget every harness's tool names share.`;
}
/** MCP_HANDS_WORDS or mcpWireProblem's, whichever refuses the name; undefined when neither does. */
export const mcpGrantNameProblem = (server: string, tool: string): string | undefined => (server === "hands" ? MCP_HANDS_WORDS : mcpWireProblem(server, tool));
/** Why a harness's own MCP client drops or retypes `tool` of `server` (its facts' schemaProblems, `dropped` the first):
 *  the words a save's blocker and a saved server's read both say. */
export const mcpDroppedWords = (server: string, tool: string, harness: string, dropped: string): string => `The MCP server ${server}'s tool ${tool} cannot be offered on ${harness}: ${dropped.replace(/^mcp__\S+: /, "")}.`;
