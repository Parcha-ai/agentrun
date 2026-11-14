// Whether a run is offered tools_search, tools_call and codemode (and Claude Code's own ToolSearch): one predicate, so
// every harness agrees. The three cost about 640 tokens on each model request; a run with a few built-in tools gains
// nothing from searching them. They earn it with a catalog (an MCP tool, `mcp__<server>__<tool>` on the wire, or a monid
// tool, `monid_discover`, `monid_inspect` or `monid_run` on the wire) or with more than META_TOOLS_OVER tools.

export const TOOLS_SEARCH = "tools_search";
export const TOOLS_CALL = "tools_call";
export const CODEMODE = "codemode";
/** The three, by name: none of them can be called through another, and none is searched for. */
export const META_TOOLS: ReadonlySet<string> = new Set([TOOLS_SEARCH, TOOLS_CALL, CODEMODE]);

/** A run with more tools than this (the three not counted) is offered them. */
export const META_TOOLS_OVER = 20;

/** Whether a run whose host tools are `names` is offered the three: a catalog tool among them, or more than META_TOOLS_OVER. */
export function offersMetaTools(names: readonly string[]): boolean {
  const own = names.filter((name) => !META_TOOLS.has(name));
  return own.length > META_TOOLS_OVER || own.some((name) => name.startsWith("mcp__") || name.startsWith("monid_"));
}
