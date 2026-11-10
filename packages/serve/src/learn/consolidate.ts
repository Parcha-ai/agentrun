// Consolidation in the loop, before any model call: which of an agent's active notes say one rule (clustersOf), which of
// its skills and workflow drafts drifted apart (driftedPairs), when a consolidation is due (consolidationDue), how notes
// rank by evidence (rankOf, ranked), and the code check behind the grader's "keeps every rule, adds none"
// (replacementProblems). The consolidation run writes its replacements through the usual supersede path, the checks and
// the grader; these decide what it is asked to consolidate and hold it to its cluster.
import { wordsOf } from "./relevance.js";
import type { Problem } from "./check.js";
import { SKILLS_DIR, WORKFLOWS_DIR } from "./skills.js";

/** A consolidation is due after this many learning merges since the last one, once the active notes are past
 *  CONSOLIDATE_BUDGET. */
export const CONSOLIDATE_MERGES = 5;
/** The bytes of active notes past which they no longer fit a run whole (learning.ts LEARNING_BUDGET, the serve budget). */
export const CONSOLIDATE_BUDGET = 8000;
/** The most clusters one consolidation run consolidates. */
export const CLUSTERS = 6;
/** The most notes in one cluster. */
export const CLUSTER_NOTES = 6;
/** How alike two notes' words must be (TF-IDF cosine, 0 to 1) to say one rule. */
export const CLUSTER_SIMILARITY = 0.3;

/** A note as clustering reads it. */
export type ClusterNote = { readonly file: string; readonly name: string; readonly description: string; readonly body: string };

/** A word as clustering compares it: a plural or an -ing form is its stem ("invoices", "reconciling"). */
const stem = (word: string): string => (word.length > 5 && word.endsWith("ing") ? word.slice(0, -3) : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** Each note's TF-IDF vector over `notes` as its own corpus: its name, description and body. */
function vectors(notes: readonly ClusterNote[]): Map<string, number>[] {
  const bags = notes.map(({ name, description, body }) => wordsOf(`${name} ${description} ${body}`).map(stem));
  const df = new Map<string, number>();
  for (const bag of bags) for (const word of new Set(bag)) df.set(word, (df.get(word) ?? 0) + 1);
  return bags.map((bag) => {
    const tf = new Map<string, number>();
    for (const word of bag) tf.set(word, (tf.get(word) ?? 0) + 1);
    const vector = new Map<string, number>();
    for (const [word, count] of tf) vector.set(word, count * Math.log(1 + notes.length / df.get(word)!));
    return vector;
  });
}

const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  let dot = 0;
  for (const [word, weight] of a) dot += weight * (b.get(word) ?? 0);
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((sum, w) => sum + w * w, 0));
  const denominator = norm(a) * norm(b);
  return denominator ? dot / denominator : 0;
};

/** The clusters of `notes` (the agent's active notes, newest first) that say one rule: each seeded on the best-ranked note
 *  left (`rank`, else the order given), with the notes alike to it (CLUSTER_SIMILARITY or more), most alike first, at most
 *  CLUSTER_NOTES in all; a note alike to none is in no cluster. At most CLUSTERS clusters. */
export function clustersOf<T extends ClusterNote>(notes: readonly T[], rank: (note: T) => number = () => 0): T[][] {
  const vs = vectors(notes);
  const order = notes.map((note, i) => ({ note, i, rank: rank(note) })).sort((a, b) => b.rank - a.rank || a.i - b.i);
  const taken = new Set<number>();
  const clusters: T[][] = [];
  for (const seed of order) {
    if (clusters.length >= CLUSTERS) break;
    if (taken.has(seed.i)) continue;
    const alike = order
      .filter(({ i }) => i !== seed.i && !taken.has(i))
      .map((one) => ({ ...one, sim: cosine(vs[seed.i]!, vs[one.i]!) }))
      .filter(({ sim }) => sim >= CLUSTER_SIMILARITY)
      .sort((a, b) => b.sim - a.sim || b.rank - a.rank || a.i - b.i)
      .slice(0, CLUSTER_NOTES - 1);
    if (!alike.length) continue;
    taken.add(seed.i);
    for (const { i } of alike) taken.add(i);
    clusters.push([seed.note, ...alike.map(({ note }) => note)]);
  }
  return clusters;
}

/** A skill and a workflow draft of one job that a merge put out of step: it changed one (`changed`) and not the other. */
export type DriftedPair = { readonly skill: string; readonly workflow: string; readonly changed: "skill" | "workflow" };

/** The pairs `changed` (the paths a merge wrote) put out of step: partners are a skill and a draft of the same name, or a
 *  draft whose README names the skill as a word. A pair both of whose sides changed is in step. */
export function driftedPairs(learned: { readonly skills: readonly { readonly name: string }[]; readonly workflows: readonly { readonly name: string; readonly readme: string }[] }, changed: readonly string[]): DriftedPair[] {
  const touched = (dir: string, name: string) => changed.some((path) => path.startsWith(`${dir}/${name}/`));
  const named = (readme: string, skill: string) => new RegExp(`(^|[^A-Za-z0-9-])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`, "i").test(readme);
  const out: DriftedPair[] = [];
  for (const skill of learned.skills) {
    for (const workflow of learned.workflows) {
      if (workflow.name !== skill.name && !named(workflow.readme, skill.name)) continue;
      const [s, w] = [touched(SKILLS_DIR, skill.name), touched(WORKFLOWS_DIR, workflow.name)];
      if (s !== w) out.push({ skill: skill.name, workflow: workflow.name, changed: s ? "skill" : "workflow" });
    }
  }
  return out;
}

/** Why a consolidation is due after a merge, or undefined: `drift` when a pair drifted, `growth` after
 *  CONSOLIDATE_MERGES merges since the last consolidation with the active notes past CONSOLIDATE_BUDGET. Never while
 *  one is queued for the agent. */
export function consolidationDue(state: { readonly mergesSince: number; readonly activeBytes: number; readonly drifted: number; readonly queued: boolean }): "drift" | "growth" | undefined {
  if (state.queued) return undefined;
  if (state.drifted > 0) return "drift";
  return state.mergesSince >= CONSOLIDATE_MERGES && state.activeBytes > CONSOLIDATE_BUDGET ? "growth" : undefined;
}

/** A note's evidence: read·3 + min(given, 10)·0.1, from the runs that opened it and that were given it (the learning
 *  view's `runs`). */
export const rankOf = ({ read, given }: { readonly read: number; readonly given: number }): number => Math.round((read * 3 + Math.min(given, 10) * 0.1) * 1e9) / 1e9;

/** `files` (newest first) best evidence first (rankOf over `runs`); a tie keeps the newer note first. */
export function ranked(files: readonly string[], runs: ReadonlyMap<string, { readonly read: number; readonly given: number }>): string[] {
  const of = (file: string) => rankOf(runs.get(file) ?? { read: 0, given: 0 });
  return files.map((file, i) => ({ file, i, rank: of(file) })).sort((a, b) => b.rank - a.rank || a.i - b.i).map(({ file }) => file);
}

/** The code check behind the grader's "keeps every rule, adds none", for one cluster (`cluster`, its notes' files) and
 *  the replacements written for it: each replacement supersedes at least one note and only notes of its cluster
 *  (`consolidate` problems otherwise); a cluster note no replacement supersedes is no loss: it stays active
 *  (`stayActive`), never dropped unsaid. */
export function replacementProblems(cluster: readonly string[], replacements: readonly { readonly file: string; readonly supersedes: readonly string[] }[]): { problems: Problem[]; stayActive: string[] } {
  const members = new Set(cluster);
  const problems: Problem[] = [];
  const covered = new Set<string>();
  for (const { file, supersedes } of replacements) {
    if (!supersedes.length) {
      problems.push({ rule: "consolidate", path: file, detail: "a consolidation's note supersedes none of the notes it replaces" });
      continue;
    }
    const outside = supersedes.filter((name) => !members.has(name));
    if (outside.length) problems.push({ rule: "consolidate", path: file, detail: `a consolidation's note supersedes notes outside its cluster: ${outside.join(", ")}` });
    else for (const name of supersedes) covered.add(name);
  }
  return { problems, stayActive: cluster.filter((file) => !covered.has(file)) };
}
