// The one walk over a learned workflow's nodes (learn/workflow-draft.ts callNodes): only the
// workflow's node positions, never an object in a call's args, a schema or any other data, however it is shaped.

import { TIERED_KINDS } from "./check.js";

/** One node of a workflow document, with the prefix the DSL puts on its step's name when it runs: `parent/` for each
 *  `workflow` node it sits in (scopeDepsToChild), so a nested step's label reads `parent/child`, and its place in the
 *  document (`path`: a chain's step by its index, any other child by the field that holds it, dot-joined; "" the root). */
export type WorkflowNodeAt = { readonly node: Record<string, unknown>; readonly prefix: string; readonly path: string };

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

const asNode = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** Every node of `doc` (a parsed workflow.json), in document order: its root, a chain's steps, a parallel's branches, a
 *  map's and a loop's body, a route's branches' bodies, a nested workflow's root, as the DSL's inspection visits them.
 *  Walked with a stack of its own, never the call stack, so no draft's nesting can throw here. */
export function workflowNodes(doc: unknown): WorkflowNodeAt[] {
  const out: WorkflowNodeAt[] = [];
  const stack: { value: unknown; prefix: string; path: string }[] = [{ value: asNode(doc)?.root, prefix: "", path: "" }];
  while (stack.length) {
    const { value, prefix, path } = stack.pop()!;
    const node = asNode(value);
    if (!node) continue;
    out.push({ node, prefix, path });
    const children: [string, unknown][] =
      node.node === "chain" && Array.isArray(node.steps) ? node.steps.map((step, i) => [String(i), step])
        : node.node === "parallel" && Array.isArray(node.branches) ? node.branches.map((branch, i) => [`branches.${i}`, branch])
          : (node.node === "map" || node.node === "loop") ? [["body", node.body]]
            : node.node === "route" && asNode(node.branches) ? Object.entries(node.branches as Record<string, unknown>).map(([key, branch]) => [`branches.${key}.body`, asNode(branch)?.body])
              : node.node === "workflow" ? [["workflow.root", asNode(node.workflow)?.root]]
                : [];
    const inner = node.node === "workflow" && typeof node.label === "string" ? `${prefix}${node.label}/` : prefix;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ value: children[i]![1], prefix: inner, path: join(path, children[i]![0]) });
  }
  return out;
}

/** A check a node runs in code: on `when` (it runs only when the predicate holds) or `until` (a loop's stop). */
export type NodeCheck = { readonly on: "when" | "until"; readonly predicate: unknown };

/** A node of a learned workflow as a person reads it (GET /agents/{id}/learning/promotions `serving[].champion.nodes`):
 *  where it is (`path`, as workflowNodes gives it; "root" for a root that is no chain), its kind and label (its kind
 *  when it has none), the tier its model step runs on (`fast`, or `agent` for the agent's own model; null for a node
 *  that calls no model tier), and its checks in code. */
export type WorkflowNode = { readonly path: string; readonly kind: string; readonly label: string; readonly tier: "fast" | "agent" | null; readonly checks: readonly NodeCheck[] };

const CHECK_KEYS = ["when", "until"] as const;

/** Every node of workflow document `doc` (the one walk above), a chain left out (its steps are the nodes). Read off the
 *  document alone: nothing is run, and a document out of shape gives what of it is in shape. */
export function workflowNodesOf(doc: unknown): WorkflowNode[] {
  return workflowNodes(doc).flatMap(({ node, path }) => {
    const kind = typeof node.node === "string" ? node.node : "?";
    if (kind === "chain") return [];
    return [{
      path: path || "root",
      kind,
      label: typeof node.label === "string" ? node.label : kind,
      tier: TIERED_KINDS.has(kind) ? (node.tier === "fast" ? "fast" : "agent") : null,
      checks: CHECK_KEYS.filter((key) => asNode(node[key])).map((key) => ({ on: key, predicate: node[key] })),
    }];
  });
}

/** The labels of `doc` that name more than one node, each once, in document order, as the DSL names a step when it runs
 *  (`parent/child` in a child workflow). A label names one step: its events and its escalation read by it, and the durable runner refuses a workflow
 *  that repeats one (DUPLICATE_LABEL). */
export function repeatedLabels(doc: unknown): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const { node, prefix } of workflowNodes(doc)) {
    if (typeof node.label !== "string") continue;
    const name = `${prefix}${node.label}`;
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return [...twice];
}
