// The names of the three host tools over a run's own tools (runner/meta-tools.ts), apart from them so the gate reads them
// without loading a script sandbox.

export const TOOLS_SEARCH = "tools_search";
export const TOOLS_CALL = "tools_call";
export const CODEMODE = "codemode";
/** The three, by name: none of them can be called through another, and none is searched for. */
export const META_TOOLS: ReadonlySet<string> = new Set([TOOLS_SEARCH, TOOLS_CALL, CODEMODE]);
