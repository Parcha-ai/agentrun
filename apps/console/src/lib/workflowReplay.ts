import { graphDiff, workflowGraph, type WorkflowGraph } from "@dsl/graph";
import { drawnNodeCount, type GraphMarks, nodesWord } from "@/lib/wfGraph";
import { metaOf } from "@/lib/runGraph";
import type { WorkflowRevision } from "@/lib/v2";

// A learned workflow's replay: each revision of its workflow.json (GET /agents/{id}/learning/workflows/{name}/revisions)
// as the graph it draws, marked against the revision before it: a node that first appears in a revision is NEW, one whose
// own fields changed (its prompt, code, inputs, tier, model: the DSL's changeCheck over everything the node says of
// itself, children left out) or whose kind or label changed is EDITED, one that only moved (a node inserted before it) is
// MOVED. The first revision has nothing before it: every node is new in it.

/** One step of the replay: a revision that reads as a workflow, its graph, its marks and what changed in a line. */
export type ReplayStep = {
  commit: string;
  at: string;
  /** The run whose merge made it, or null for a person's change. */
  run: string | null;
  /** The commit's own reason (the grader's, or what a person did). */
  reason: string;
  graph: WorkflowGraph;
  marks: GraphMarks;
  added: string[];
  edited: string[];
  removed: string[];
  /** The one line: what changed against the step before it. */
  line: string;
};

/** A node's name for a person: its label (a kind's own name when it has none). */
const names = (labels: string[]) => {
  const unique = [...new Set(labels)];
  const shown = unique.slice(0, 3).map((l) => `"${l}"`).join(", ");
  return unique.length > 3 ? `${shown} and ${unique.length - 3} more` : shown;
};
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What changed between two steps' graphs, as a line: "Added 2 nodes (…), edited "Classify", removed 1 node". A graph
 *  with no node added, edited, removed or moved reads "No node changed" (or "Nodes reordered" or "Connections changed"). */
export function changeLine(added: string[], edited: string[], removed: string[], moved: number, rewired: number): string {
  const parts = [
    added.length && `added ${count(added.length, "node")} (${names(added)})`,
    edited.length && `edited ${names(edited)}`,
    removed.length && `removed ${count(removed.length, "node")} (${names(removed)})`,
  ].filter(Boolean) as string[];
  if (!parts.length) return moved ? "Nodes reordered" : rewired ? "Connections changed" : "No node changed";
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The replay of `revisions` (oldest first): a step for each that reads as a workflow with a node to draw. `unreadable`
 *  counts those that do not (not JSON, no root node, or no file at that commit): a step is made of the next one that does,
 *  against the last that did, so a run of them never reads as a change. */
export function replaySteps(revisions: readonly WorkflowRevision[]): { steps: ReplayStep[]; unreadable: number } {
  const steps: ReplayStep[] = [];
  let before: WorkflowGraph | null = null;
  let unreadable = 0;
  for (const rev of revisions) {
    let doc: unknown = null;
    let graph: WorkflowGraph | null = null;
    try { doc = rev.text === null ? null : JSON.parse(rev.text); graph = doc === null ? null : workflowGraph(doc); } catch { graph = null; }
    if (!graph?.nodes.length) { unreadable += 1; continue; }
    const diff = before ? graphDiff(before, graph) : null;
    const added = diff ? diff.added.map((n) => n.path) : graph.nodes.map((n) => n.path);
    // A chain is no box of its own in the drawing (its steps are), so the line never names it.
    const drawn = (path: string) => graph!.nodes.find((n) => n.path === path)?.kind !== "chain";
    const edited = diff ? [...diff.changed.map((n) => n.next), ...diff.rewritten.map((n) => n.next)] : [];
    const moved = diff ? diff.moved.map((n) => n.next) : [];
    const labelAt = new Map(graph.nodes.map((n) => [n.path, n.label]));
    const removed = diff ? diff.removed.filter((n) => n.kind !== "chain").map((n) => n.label) : [];
    const rewired = diff ? diff.edges.added.length + diff.edges.removed.length : 0;
    steps.push({
      commit: rev.commit, at: rev.at, run: "run" in rev.by ? rev.by.run : null, reason: rev.reason, graph,
      marks: {
        meta: metaOf(doc, graph),
        diff: { added, edited, moved, removed: diff ? diff.removed.map(({ label, kind }) => ({ label, kind })) : [] },
      },
      added, edited, removed,
      line: diff
        ? changeLine(added.filter(drawn).map((p) => labelAt.get(p) ?? p), edited.filter(drawn).map((p) => labelAt.get(p) ?? p), removed, moved.length, rewired)
        : `First version: ${nodesWord(drawnNodeCount(graph))}`,
    });
    before = graph;
  }
  return { steps, unreadable };
}
