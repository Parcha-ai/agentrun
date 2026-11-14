// One discovery system. A run lists every tool to the model in full until its catalog tools (an MCP server's, a monid
// one) pass DEFER_CATALOG_OVER: then they are deferred, not listed, and the model finds them with tools_search and runs
// them with tools_call. Claude Code defers MCP tools itself (its ToolSearch), on under the same test, so it is offered
// neither of ours. Built-ins and a harness's own tools are always listed. A run under the threshold has no search or call:
// they would find tools the model already has, at about 640 tokens on every request.

export const TOOLS_SEARCH = "tools_search";
export const TOOLS_CALL = "tools_call";
export const CODEMODE = "codemode";
/** The three, by name: none of them can be called through another, and none is searched for. */
export const META_TOOLS: ReadonlySet<string> = new Set([TOOLS_SEARCH, TOOLS_CALL, CODEMODE]);

/** A run with more catalog tools than this is deferred them. */
export const DEFER_CATALOG_OVER = 20;

/** Whether a tool is a catalog tool, by the name a harness gives it: an MCP tool (`mcp__<server>__<tool>`) or a monid
 *  endpoint (`monid__<provider>__<endpoint>`). */
export const isCatalogName = (name: string): boolean => name.startsWith("mcp__") || name.startsWith("monid_");

/** Whether a run whose host tools are `names` has its catalog tools deferred: more than DEFER_CATALOG_OVER of them. */
export const defersCatalog = (names: readonly string[]): boolean => names.filter(isCatalogName).length > DEFER_CATALOG_OVER;
