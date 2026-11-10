// The grant rules an MCP tool is held to, copied from serve (src/mcp-meta.ts, src/mcp-gateway.ts mcpHeaderProblem and
// MCP_NAME) because an adapter cannot import serve. The two copies say the same; a change to one is made to the other.
//  - Known meta tools: a tool that runs other actions by name (or by code the model writes), so a grant of it can't name
//    the real action. The rule is this closed list, never a guess from a schema's shape. A name only a provider uses
//    matches on any host; a generic name matches only on its provider's host.
//  - Header declarations (x-mcp-header, the 2026-07-28 revision): a tool whose declarations the client cannot mirror
//    into Mcp-Param-* headers is not granted.
//  - Names: a server is 1 to 32 lowercase letters, digits and dashes, starting with a letter; a tool's name in an action
//    id is 1 to 64 letters, digits, `_` and `-`, so `mcp__<server>__<tool>` splits one way.

/** Why a meta tool is not granted. */
export const META_REASON = "it runs other actions by name, so a grant can't name the real action. Use the server's direct tools instead.";

type MetaTool = { name: string; prefix?: true; hosts?: readonly string[] };

/** The known meta tools (each documented by its provider; serve's copy names where). */
export const MCP_META_TOOLS: readonly MetaTool[] = [
  ...["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_PROXY_EXECUTE"].map((name) => ({ name })),
  { name: "execute_action", hosts: ["klavis.ai"] },
  { name: "execute_zapier_read_action" },
  { name: "execute_zapier_write_action" },
  { name: "write_code_action", hosts: ["mcp.zapier.com"] },
  { name: "Arcade_UseTool" },
  { name: "mcp-exec" },
  { name: "code-mode-", prefix: true },
  { name: "portal_execute" },
  { name: "portal_codemode_execute" },
];

/** A host name as compared here: lowercase, every final dot gone. */
function hostKey(hostname: string): string {
  const host = hostname.toLowerCase();
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") end--;
  return host.slice(0, end);
}

/** The known meta tool `tool` of the server at `url` is, with why it is not granted; undefined for any other tool. */
export function metaToolOf(url: string, tool: string): { reason: string } | undefined {
  const parsed = URL.parse(url)?.hostname;
  const host = parsed === undefined ? undefined : hostKey(parsed);
  const known = MCP_META_TOOLS.find((meta) => (meta.prefix ? tool.startsWith(meta.name) && tool.length > meta.name.length : tool === meta.name) && (!meta.hosts || (host !== undefined && meta.hosts.some((at) => host === at || host.endsWith(`.${at}`)))));
  return known ? { reason: META_REASON } : undefined;
}

export const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const HEADER_SCAN_NODES = 10_000;
const HEADER_SCAN_DEPTH = 64;
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set(["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "patternProperties", "dependentSchemas", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$defs", "definitions"]);
const OBJECT_VALUED: ReadonlySet<string> = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);

/** Why a tool's x-mcp-header declarations cannot be mirrored into Mcp-Param-* headers, by the rules the SDK client applies
 *  when it lists tools; undefined when they can, or there are none. Walks schema keywords alone, each object once, within
 *  HEADER_SCAN_NODES and HEADER_SCAN_DEPTH. */
export function mcpHeaderProblem(inputSchema: unknown): string | undefined {
  const seen = new Map<string, string>();
  const visited = new WeakSet<object>();
  const stack: { node: unknown; path: readonly string[]; reachable: boolean }[] = [{ node: inputSchema, path: [], reachable: true }];
  for (let nodes = 0; stack.length; ) {
    const { node, path, reachable } = stack.pop()!;
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    if (++nodes > HEADER_SCAN_NODES) return `its input schema is larger than ${HEADER_SCAN_NODES} parts, more than its headers are checked through`;
    if (path.length > HEADER_SCAN_DEPTH) return `its input schema nests deeper than ${HEADER_SCAN_DEPTH} levels, more than its headers are checked through`;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, path, reachable: false });
      continue;
    }
    const schema = node as Record<string, unknown>;
    const where = path.length ? path.join(".") : "the schema's root";
    if (Object.hasOwn(schema, "x-mcp-header")) {
      const name = schema["x-mcp-header"];
      if (!reachable || !path.length) return `${where}: x-mcp-header is only allowed on a property reached through properties alone`;
      if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return `${where}: x-mcp-header must be a header name (an RFC 9110 token)`;
      if (!["string", "integer", "boolean"].includes(schema.type as string)) return `${where}: x-mcp-header is only allowed on a string, integer or boolean`;
      const prior = seen.get(name.toLowerCase());
      if (prior !== undefined) return `x-mcp-header ${name} is declared twice (also as ${prior})`;
      seen.set(name.toLowerCase(), name);
    }
    for (const [key, child] of Object.entries(schema)) {
      if (!child || typeof child !== "object") continue;
      if (key === "properties") {
        if (!Array.isArray(child)) for (const [name, property] of Object.entries(child)) stack.push({ node: property, path: [...path, name], reachable });
      } else if (OBJECT_VALUED.has(key) && !Array.isArray(child)) {
        for (const sub of Object.values(child)) stack.push({ node: sub, path: [...path, `<${key}>`], reachable: false });
      } else if (SUBSCHEMA_KEYWORDS.has(key)) stack.push({ node: child, path: [...path, `<${key}>`], reachable: false });
    }
  }
  return undefined;
}
