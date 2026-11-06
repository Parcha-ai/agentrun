// Known MCP meta tools: a tool that runs other actions by name (or by code the model writes), so a grant of it can't name
// the real action. Allow would cover every inner action, and deny could target none of them, so none is ever granted.
// The rule is this closed list, never a guess from a schema's shape. A name that only a provider uses matches on any
// host; a generic name matches only on its provider's host. A meta tool the list does not know stays an MCP tool like
// any other, asked by default at the tool gate. Each entry says where its name is documented (read 2026-11-05).

/** Why a meta tool is not granted: what the save's refusal, the launch's and the tool's `reason` say. */
export const META_REASON = "it runs other actions by name, so a grant can't name the real action. Use the server's direct tools instead.";

type MetaTool = {
  /** The tool's exact name, or, with `prefix`, the start of the names its server generates. */
  name: string;
  prefix?: true;
  /** For a generic name: the hosts it is a meta tool on (the host itself or a subdomain of it). */
  hosts?: readonly string[];
  /** Where the name is documented. */
  source: string;
};

export const MCP_META_TOOLS: readonly MetaTool[] = [
  // Composio's session MCP and Connect (ComposioHQ/composio@29698b7e5, ts/packages/cli/src/utils/meta-tool-slugs.ts and
  // docs/public/data/meta-tools.json): up to 50 tools by slug, Python in a remote workbench, a shell, raw HTTP to an app.
  ...["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_PROXY_EXECUTE"].map((name) => ({ name, source: "composio@29698b7e5 meta-tool-slugs.ts, meta-tools.json" })),
  // Klavis Strata (klavis@7cab53e94, open-strata/src/strata/tools.py and docs/concepts/strata.mdx): server_name + action_name.
  { name: "execute_action", hosts: ["klavis.ai"], source: "klavis@7cab53e94 open-strata tools.py, docs/concepts/strata.mdx" },
  // Zapier MCP's agentic mode (docs.zapier.com/mcp/overview/how-tools-work#meta-tools): an action by name, or generated code.
  { name: "execute_zapier_read_action", source: "docs.zapier.com/mcp/overview/how-tools-work#meta-tools" },
  { name: "execute_zapier_write_action", source: "docs.zapier.com/mcp/overview/how-tools-work#meta-tools" },
  { name: "write_code_action", hosts: ["mcp.zapier.com"], source: "docs.zapier.com/mcp/overview/how-tools-work#meta-tools" },
  // Arcade MCP gateways' tool recommendation (ArcadeAI/docs@dd84f015c, mcp-gateways/tool-recommendation/index.mdx).
  { name: "Arcade_UseTool", source: "ArcadeAI/docs@dd84f015c tool-recommendation/index.mdx" },
  // Docker's MCP gateway with dynamic tools (docker/mcp-gateway@7e0f34277, pkg/gateway/dynamic_mcps.go and
  // pkg/codemode/codemode.go): a session tool by name, and the code-mode tools it generates.
  { name: "mcp-exec", source: "docker/mcp-gateway@7e0f34277 pkg/gateway/dynamic_mcps.go" },
  // prefix: Docker generates these names; a non-Docker tool named code-mode-* is refused too, by design (code mode is
  // never granted, and a false match only refuses a grant).
  { name: "code-mode-", prefix: true, source: "docker/mcp-gateway@7e0f34277 pkg/codemode/codemode.go" },
  // Cloudflare MCP server portals (developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/):
  // search_and_execute's execute, and Code Mode's JavaScript.
  { name: "portal_execute", source: "developers.cloudflare.com mcp-portals#optimize-context" },
  { name: "portal_codemode_execute", source: "developers.cloudflare.com mcp-portals code mode" },
];

/** A URL's host as compared here: lowercase, and with no final dot (`klavis.ai.` names the same host as `klavis.ai`). */
const hostOf = (url: string): string | undefined => URL.parse(url)?.hostname.toLowerCase().replace(/\.$/, "");

/** The known meta tool `tool` of the server at `url` is, with why it is not granted; undefined for any other tool. */
export function metaToolOf(url: string, tool: string): { reason: string } | undefined {
  const host = hostOf(url);
  const known = MCP_META_TOOLS.find((meta) => (meta.prefix ? tool.startsWith(meta.name) && tool.length > meta.name.length : tool === meta.name) && (!meta.hosts || (host !== undefined && meta.hosts.some((at) => host === at || host.endsWith(`.${at}`)))));
  return known ? { reason: META_REASON } : undefined;
}
