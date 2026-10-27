/** The refusal for a draft that names a tool when the host gave no tool list: the checker fails closed. */
export const NO_TOOL_LIST = "no host tool list given: pass --tools <file> or run it under the host";

export type ToolCheck = (tools: readonly string[]) => { rule: "no_tool_list" | "unknown_tool"; detail: string }[];

/** Checks a draft's tool names against the host's one tool list, the names a workflow can bind on any harness. Without
 *  a list, a draft that names any tool is refused. */
export function toolCheck(hostTools?: readonly string[]): ToolCheck {
  const allowed = hostTools === undefined ? undefined : new Set(hostTools);
  return (tools) => {
    if (!tools.length) return [];
    if (!allowed) return [{ rule: "no_tool_list", detail: NO_TOOL_LIST }];
    return tools.filter((tool) => !allowed.has(tool)).map((tool) => ({ rule: "unknown_tool", detail: `names ${tool}, which is not in the host's tool list` }));
  };
}
