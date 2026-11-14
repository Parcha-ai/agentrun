// The one walk over a learned workflow's nodes (learn/skills.ts callNodes, learn/promote.ts walkGuards): only the
// workflow's node positions, never an object in a call's args, a schema or any other data, however it is shaped.

/** One node of a workflow document, with the prefix the DSL puts on its step's name when it runs: `parent/` for each
 *  `workflow` node it sits in (scopeDepsToChild), so a nested step's label reads `parent/child`. */
export type WorkflowNodeAt = { readonly node: Record<string, unknown>; readonly prefix: string };

const asNode = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** Every node of `doc` (a parsed workflow.json), in document order: its root, a chain's steps, a parallel's branches, a
 *  map's and a loop's body, a route's branches' bodies, a nested workflow's root, as the DSL's inspection visits them.
 *  Walked with a stack of its own, never the call stack, so no draft's nesting can throw here. */
export function workflowNodes(doc: unknown): WorkflowNodeAt[] {
  const out: WorkflowNodeAt[] = [];
  const stack: { value: unknown; prefix: string }[] = [{ value: asNode(doc)?.root, prefix: "" }];
  while (stack.length) {
    const { value, prefix } = stack.pop()!;
    const node = asNode(value);
    if (!node) continue;
    out.push({ node, prefix });
    const children: unknown[] =
      node.node === "chain" && Array.isArray(node.steps) ? node.steps
        : node.node === "parallel" && Array.isArray(node.branches) ? node.branches
          : (node.node === "map" || node.node === "loop") ? [node.body]
            : node.node === "route" && asNode(node.branches) ? Object.values(node.branches as Record<string, unknown>).map((branch) => asNode(branch)?.body)
              : node.node === "workflow" ? [asNode(node.workflow)?.root]
                : [];
    const inner = node.node === "workflow" && typeof node.label === "string" ? `${prefix}${node.label}/` : prefix;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ value: children[i], prefix: inner });
  }
  return out;
}
