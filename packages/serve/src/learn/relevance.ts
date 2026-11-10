// Which of an agent's notes bear on a run, by a cheap lexical match and no model call (learning.ts byRelevance): each
// note's name, description and body scored against the run's input by BM25, with the words of the paths a code review's
// diff or file list names weighed PATH_WEIGHT times its prose's. A run's input is what it was started with: its first
// message, or a workflow's fields.

/** Words no note is told apart by. */
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "has", "have", "how", "if", "in", "into", "is", "it", "its",
  "not", "of", "on", "or", "so", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "was", "we", "what", "when",
  "where", "which", "while", "who", "will", "with", "you", "your", "use", "used", "using", "note", "notes", "run", "runs",
]);

/** A text's words: lowercase letters and digits, two characters or more, no stop word, and no bare number (a diff's
 *  line numbers, a note's "Step 46"): a number tells no topic apart, and a note's length never turns on one. A path's
 *  segments are words too (`src/learn/grade.ts` is src, learn, grade, ts). */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 1 && !/^\d+$/.test(word) && !STOP.has(word));
}

/** The paths a code review names: a unified diff's `diff --git a/x b/y`, `+++ b/x` and `--- a/x` lines, and a file list's
 *  lines that read as a path (a slash or a dot extension, no space). */
export function changedPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (git) {
      paths.add(git[1]!);
      paths.add(git[2]!);
      continue;
    }
    const side = /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/.exec(line);
    if (side && side[1] !== "/dev/null") {
      paths.add(side[1]!);
      continue;
    }
    const listed = line.trim().replace(/^[-*]\s+/, "");
    if (/^[\w.-]+(?:\/[\w.-]+)+$|^[\w-]+\.[a-z0-9]{1,8}$/i.test(listed)) paths.add(listed);
  }
  return [...paths];
}

/** The text a run's input holds: a string as it is, an object's `content`, else every string field, in order. */
export function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return "";
  const content = (input as { content?: unknown }).content;
  if (typeof content === "string") return content;
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(input);
  return out.join("\n");
}

/** How much a word of a code review's changed paths weighs in the query, against 1 for a word of its prose: the files a
 *  review touches say what it is about more than the words around them. */
export const PATH_WEIGHT = 3;

/** The words a run's input asks with, each with its weight: each word of its text once (1, however often it is said),
 *  and each word of a changed path's segments PATH_WEIGHT (a path's word the prose says too weighs as a path's). */
export function queryOf(input: unknown): Map<string, number> {
  const text = inputText(input);
  const query = new Map<string, number>();
  for (const word of wordsOf(text)) query.set(word, 1);
  for (const word of changedPaths(text).flatMap(wordsOf)) query.set(word, PATH_WEIGHT);
  return query;
}

/** A note as the match reads it: its name and description twice (what it is about), then its body. */
export type Scored = { readonly name: string; readonly description: string; readonly body: string };

/** BM25 (k1 1.2, b 0.75) of each of `docs` against `query`, over the docs as their own corpus, each query word's part
 *  times its weight (queryOf; a list weighs each word once): 0 for a doc that holds none of the query's words. */
export function bm25(docs: readonly Scored[], query: ReadonlyMap<string, number> | readonly string[]): number[] {
  const weights = Array.isArray(query) ? new Map(query.map((word) => [word, 1])) : new Map(query as ReadonlyMap<string, number>);
  const terms = [...weights.keys()];
  if (!terms.length || !docs.length) return docs.map(() => 0);
  const bags = docs.map(({ name, description, body }) => wordsOf(`${name} ${description} ${name} ${description} ${body}`));
  const avg = bags.reduce((sum, bag) => sum + bag.length, 0) / bags.length || 1;
  const counts = bags.map((bag) => bag.reduce((map, word) => map.set(word, (map.get(word) ?? 0) + 1), new Map<string, number>()));
  const idf = new Map(terms.map((term) => {
    const n = counts.filter((count) => count.has(term)).length;
    return [term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))];
  }));
  return counts.map((count, i) => terms.reduce((score, term) => {
    const tf = count.get(term) ?? 0;
    return tf ? score + weights.get(term)! * idf.get(term)! * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * bags[i]!.length) / avg))) : score;
  }, 0));
}
