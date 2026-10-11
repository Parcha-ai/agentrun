// The interpreter's execution path, read and never built. The interpreter names every node instance it runs
// with a path (`/root`, then `/steps/<i>` in a chain, `/items/<i>/body` for a map item,
// `/branches/<i>` for a parallel branch, `/branches/<name>/body` for a route's branch,
// `/iterations/<i>/body` for a loop iteration, `/workflow/root` into a child workflow), each segment
// escaped as a JSON pointer (`~1` is `/`, `~0` is `~`). The interpreter is the only source of a path: this
// module splits one into its segments, slices a prefix of the string it was given, and resolves it
// against a document. It never concatenates a path.
import type { Workflow, WorkflowNode } from "../workflow.js";

/** A path's segments, unescaped, with the offset in the path where each segment's `/` sits, so a
 *  prefix of the interpreter's own string can be sliced. Null when the string is not a path. */
export function pathSegments(path: unknown): Array<{ segment: string; at: number }> | null {
  if (typeof path !== "string" || !path.startsWith("/root") || (path.length > 5 && path[5] !== "/")) return null;
  const out: Array<{ segment: string; at: number }> = [];
  let at = 0;
  for (const raw of path.slice(1).split("/")) {
    if (!raw) return null;
    out.push({ segment: raw.replace(/~1/g, "/").replace(/~0/g, "~"), at });
    at += raw.length + 1;
  }
  return out;
}

/** The prefix of `path` that ends before its segment `index` (the path of an ancestor). */
const prefix = (path: string, segments: Array<{ at: number }>, index: number) => path.slice(0, segments[index].at);

const INDEX = /^(0|[1-9][0-9]*)$/;

/** The node `path` names in the document the interpreter ran (a desugared view), or undefined when
 *  the path does not resolve. A step of a child workflow resolves inside the child's own root. */
export function nodeAt(workflow: Workflow, path: string): WorkflowNode | undefined {
  const segments = pathSegments(path)?.map(s => s.segment);
  if (!segments || segments[0] !== "root") return undefined;
  let node: WorkflowNode | undefined = workflow.root;
  for (let i = 1; node && i < segments.length;) {
    const [a, b, c] = segments.slice(i, i + 3);
    if (a === "steps" && node.node === "chain" && INDEX.test(b ?? "")) { node = node.steps[Number(b)]; i += 2; }
    else if (a === "items" && node.node === "map" && INDEX.test(b ?? "") && c === "body") { node = node.body; i += 3; }
    else if (a === "iterations" && node.node === "loop" && INDEX.test(b ?? "") && c === "body") { node = node.body; i += 3; }
    else if (a === "branches" && node.node === "parallel" && INDEX.test(b ?? "")) { node = node.branches[Number(b)]; i += 2; }
    else if (a === "branches" && node.node === "route" && typeof b === "string" && c === "body" && Object.hasOwn(node.branches, b)) { node = node.branches[b]?.body; i += 3; }
    else if (a === "workflow" && node.node === "workflow" && b === "root") { node = node.workflow.root; i += 2; }
    else return undefined;
  }
  return node;
}

/** Every chain `path` sits in, outermost first: the chain's own path and the index of the step on
 *  the way to `path`. A resume is answered by a chain's committed frontier when the frontier lies past
 *  that index. */
export function enclosingChains(path: string): Array<{ chain: string; index: number }> {
  const segments = pathSegments(path);
  if (!segments) return [];
  const out: Array<{ chain: string; index: number }> = [];
  for (let i = 1; i + 1 < segments.length; i += 1) {
    if (segments[i].segment === "steps" && INDEX.test(segments[i + 1].segment)) out.push({ chain: prefix(path, segments, i), index: Number(segments[i + 1].segment) });
  }
  return out;
}

/** The chain step `path` is, when it is one: its chain's path and its index. */
export function chainStep(path: string): { chain: string; index: number } | undefined {
  const segments = pathSegments(path);
  if (!segments || segments.length < 3) return undefined;
  const [steps, index] = segments.slice(-2);
  return steps.segment === "steps" && INDEX.test(index.segment) ? { chain: prefix(path, segments, segments.length - 2), index: Number(index.segment) } : undefined;
}

/** Every loop iteration `path` runs inside, outermost first: the loop's path and the iteration. */
export function enclosingIterations(path: string): Array<{ loop: string; index: number }> {
  const segments = pathSegments(path);
  if (!segments) return [];
  const out: Array<{ loop: string; index: number }> = [];
  for (let i = 1; i + 2 < segments.length; i += 1) {
    if (segments[i].segment === "iterations" && INDEX.test(segments[i + 1].segment) && segments[i + 2].segment === "body") out.push({ loop: prefix(path, segments, i), index: Number(segments[i + 1].segment) });
  }
  return out;
}

/** The loop iteration a commit at `path` completes, if any: `path` is the iteration's body, or the
 *  last committing step of a body that is a chain (a chain never commits itself, so its last step,
 *  descending through nested chains, is where the body ends). */
export function completedIteration(workflow: Workflow, path: string): { loop: string; index: number } | undefined {
  const segments = pathSegments(path);
  const innermost = enclosingIterations(path).at(-1);
  if (!segments || !innermost) return undefined;
  // The body's own path ends three segments past the loop's: iterations/<i>/body.
  const loopDepth = pathSegments(innermost.loop)!.length;
  let depth = loopDepth + 3;
  let node = nodeAt(workflow, path.slice(0, segments[depth]?.at ?? path.length));
  while (depth < segments.length) {
    if (node?.node !== "chain" || segments[depth].segment !== "steps") return undefined;
    const steps = (node as { steps: WorkflowNode[] }).steps;
    if (Number(segments[depth + 1]?.segment) !== steps.length - 1) return undefined;
    node = steps[steps.length - 1];
    depth += 2;
  }
  return node && node.node !== "chain" ? innermost : undefined;
}

/** Whether `inner` is `outer` or lies inside it, compared segment by segment. */
export function isWithin(inner: string, outer: string): boolean {
  const a = pathSegments(inner); const b = pathSegments(outer);
  return Boolean(a && b && b.length <= a.length && b.every((s, i) => s.segment === a[i].segment));
}

/** The top-level step whose completion `path`'s commit is, or undefined. A top-level step commits at
 *  its own path; a chain is never committed by the interpreter, so a top-level nested chain completes
 *  at a path that runs only through chain steps and is the last step of every nested chain below the
 *  document's root chain. A root that is not a chain completes at the root. Read from the path and
 *  the document, never built. */
export function topLevelCompletion(workflow: Workflow, path: string): number | undefined {
  const segments = pathSegments(path);
  if (!segments) return undefined;
  if (segments.length === 1) return workflow.root.node === "chain" ? undefined : 0;
  const chains = enclosingChains(path);
  // Every segment after the root is a chain step's pair: the path runs through chains only.
  if (chains.length * 2 + 1 !== segments.length || workflow.root.node !== "chain") return undefined;
  const nested = chains.slice(1).every(({ chain, index }) => {
    const node = nodeAt(workflow, chain);
    return node?.node === "chain" && index === node.steps.length - 1;
  });
  return nested ? chains[0].index : undefined;
}

/** The nodes directly inside `node`: a chain's steps, a parallel's branches, a map's or a loop's
 *  body, a route's branch bodies, a child workflow's root. */
export function childrenOf(node: WorkflowNode): WorkflowNode[] {
  switch (node.node) {
    case "chain": return node.steps ?? [];
    case "parallel": return node.branches ?? [];
    case "map": case "loop": return [node.body];
    case "route": return Object.values(node.branches ?? {}).map(branch => branch.body);
    case "workflow": return [node.workflow.root];
    default: return [];
  }
}
