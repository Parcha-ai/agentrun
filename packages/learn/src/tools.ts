export type ToolPolicy = { shared: readonly string[]; harnesses: Readonly<Record<string, readonly string[]>> };
export function defaultTools(): ToolPolicy {
  return { shared: [], harnesses: { codex: [], pi: [] } };
}
