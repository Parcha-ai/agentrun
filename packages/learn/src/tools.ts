import { readFileSync } from "node:fs";

/** `shared`: the tool names a workflow can bind on any harness. `harnesses`: each harness's built-in tool names, which a
 *  workflow draft never names. */
export type ToolPolicy = { shared: readonly string[]; harnesses: Readonly<Record<string, readonly string[]>> };

let defaults: ToolPolicy | undefined;

/** The package's `tools.json`. */
export function defaultTools(): ToolPolicy {
  defaults ??= JSON.parse(readFileSync(new URL("../tools.json", import.meta.url), "utf8")) as ToolPolicy;
  return { shared: [...defaults.shared], harnesses: Object.fromEntries(Object.entries(defaults.harnesses).map(([name, tools]) => [name, [...tools]])) };
}

export type ToolCheck = (tool: string) => { rule: "harness_tool"; harnesses: string[] } | { rule: "unknown_tool" } | undefined;

/** A host's `shared` replaces the default; its `harnesses` only add names. A built-in name is refused in any case, even
 *  when `shared` holds it. */
export function toolCheck(host: Partial<ToolPolicy> = {}): ToolCheck {
  const base = defaultTools();
  const shared = new Set(host.shared ?? base.shared);
  const builtIn = new Map<string, Set<string>>();
  for (const harnesses of [base.harnesses, host.harnesses ?? {}]) {
    for (const [harness, tools] of Object.entries(harnesses)) for (const tool of tools) builtIn.set(tool.toLowerCase(), (builtIn.get(tool.toLowerCase()) ?? new Set()).add(harness));
  }
  return (tool) => {
    const harnesses = builtIn.get(tool.toLowerCase());
    if (harnesses) return { rule: "harness_tool", harnesses: [...harnesses].sort() };
    return shared.has(tool) ? undefined : { rule: "unknown_tool" };
  };
}
