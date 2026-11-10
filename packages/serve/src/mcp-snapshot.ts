// An agent's MCP tools pinned when it is saved, not at its run's first claim. The save (POST /agents, PUT /agents/{id}/definition,
// a template's apply) takes each granted `mcp:<server>/<tool>` from the registry's snapshot (the saved server's listed
// tools, mcp_servers.tools) and keeps it in the revision's own body as `mcpPin`: per server its URL, the granted tools as
// listed, the owner's prices for them, and the version of the server's whole listed snapshot. A run's claim uses that pin
// (runner/mcp-claim.ts), so a refresh of the server after the save never changes what the agent's runs may call; the
// agent's read says when a server's tools moved since (mcp_drift), and saving the agent again pins them as they are.
//
// The version is the tools source's rule (packages/tools snapshot.ts snapshotVersion), copied here because serve does not
// import that package yet: the canonical JSON of the tools in the MCP wire shape (name, title, description, inputSchema,
// outputSchema, annotations), sorted by name, hashed with SHA-256. The vector in both packages' tests holds the two copies
// to one answer.
import { createHash } from "node:crypto";
import { canonical } from "./mcp-probe.js";
import { type McpPin, mcpPinOf } from "./mcp-gateway.js";
import { boundTool, type McpTool } from "./mcp-probe.js";

/** A revision's pin: each granted server's URL at the save, the granted tools as its snapshot held them (the harnesses'
 *  shape, as a run's pin holds them), the owner's prices for them, and the version of the whole snapshot. */
export type McpRevisionPin = Record<string, McpPin[string] & { version: string }>;

/** One registry row as the pin and the drift read it. */
export type McpRegistryRow = { name: string; url: string; tools: unknown; prices?: unknown };

/** A registry tool (input_schema) in the MCP wire shape a version reads; marks the registry adds (grantable) are not read. */
const wireOf = (tool: McpTool): Record<string, unknown> => ({
  name: tool.name,
  ...(tool.title !== undefined ? { title: tool.title } : {}),
  ...(tool.description !== undefined ? { description: tool.description } : {}),
  inputSchema: tool.input_schema ?? {},
  ...(tool.output_schema !== undefined ? { outputSchema: tool.output_schema } : {}),
  ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
});

/** The version of a server's listed tools, as the registry keeps them: `sha256:` and the hex SHA-256 of their canonical
 *  JSON in the wire shape, sorted by name. The same tools listed in another order are one version. */
export function snapshotVersion(tools: readonly McpTool[]): string {
  const sorted = tools.map(wireOf).sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
  return `sha256:${createHash("sha256").update(canonical(sorted), "utf8").digest("hex")}`;
}

const toolsOf = (row: McpRegistryRow): McpTool[] => (Array.isArray(row.tools) ? (row.tools as McpTool[]) : []);

/** The pin a save of `grants` makes from the registry's `rows`: each MCP tool among them as its server's snapshot holds
 *  it, with that snapshot's version. Undefined when it grants none. A granted tool that cannot be pinned (its server not
 *  saved, the tool not listed, a meta tool, a header it cannot send) throws, naming it and why (mcpPinOf, the claim's own
 *  rule until now). */
export function revisionPinOf(grants: readonly string[], rows: ReadonlyMap<string, McpRegistryRow>): McpRevisionPin | undefined {
  const pin = mcpPinOf(grants, {
    server: (name) => {
      const row = rows.get(name);
      return row && { url: row.url, tools: toolsOf(row).map(boundTool), ...(row.prices && typeof row.prices === "object" ? { prices: row.prices as Record<string, number> } : {}) };
    },
    headers: () => undefined,
  });
  const servers = Object.keys(pin);
  if (!servers.length) return undefined;
  // Keyed by server name with no prototype, as every map of names here is.
  const out: McpRevisionPin = Object.create(null);
  for (const server of servers) out[server] = { ...pin[server]!, version: snapshotVersion(toolsOf(rows.get(server)!)) };
  return out;
}

/** Whether `value` reads as a revision's pin: each server a URL, a version and a list of named tools. */
export function isRevisionPin(value: unknown): value is McpRevisionPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((one) => !!one && typeof one === "object" && typeof (one as { url?: unknown }).url === "string" && typeof (one as { version?: unknown }).version === "string" && Array.isArray((one as { tools?: unknown }).tools) && ((one as { tools: unknown[] }).tools).every((tool) => typeof (tool as { name?: unknown })?.name === "string"));
}

/** A revision's pin as a run's (McpPin): the version dropped. */
export function runPinOf(pin: McpRevisionPin): McpPin {
  const out: McpPin = Object.create(null);
  for (const [server, { version: _version, ...rest }] of Object.entries(pin)) out[server] = rest;
  return out;
}

/** One pinned server whose registry entry moved since the save: its tools changed (tools_changed), its address changed
 *  (address_changed), or it is no longer saved (removed, current_version null). */
export type McpDrift = { server: string; pinned_version: string; current_version: string | null; reason: "tools_changed" | "address_changed" | "removed" };

/** Each server of `pin` whose registry row (`rows`) is not what the save pinned, by server name. */
export function mcpDriftOf(pin: unknown, rows: ReadonlyMap<string, McpRegistryRow>): McpDrift[] {
  if (!isRevisionPin(pin)) return [];
  return Object.entries(pin).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([server, pinned]): McpDrift[] => {
    const row = rows.get(server);
    if (!row) return [{ server, pinned_version: pinned.version, current_version: null, reason: "removed" }];
    const current = snapshotVersion(toolsOf(row));
    if (current !== pinned.version) return [{ server, pinned_version: pinned.version, current_version: current, reason: "tools_changed" }];
    if (row.url !== pinned.url) return [{ server, pinned_version: pinned.version, current_version: current, reason: "address_changed" }];
    return [];
  });
}
