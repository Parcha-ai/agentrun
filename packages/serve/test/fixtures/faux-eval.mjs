// A faux grader for the learning eval (learn-eval.test.mjs): it decides each note as the eval sets label it
// (fixtures/learn-eval.json and learn-eval-heldout.json, by the note's file name): keep, pending (kept, to wait for the
// owner's OK) or drop, and merges a proposal with no note to drop, in the verdict's shape.
// It also refuses to judge a prompt that does not fence what the user said in the run, so the eval proves the grader
// is given it. Each call is filed as a line in the file AGENTRUN_TEST_FAUX_CALLS names.
import { appendFileSync, readFileSync } from "node:fs";

const CASES = ["./learn-eval.json", "./learn-eval-heldout.json"].flatMap((file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")).cases);
/** Each labelled note's file, and its case's label. */
const LABELS = new Map(CASES.flatMap((c) => c.notes.map((n) => [n.file, c.label])));
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");

export default function reply(context, faux) {
  const prompt = textOf(context.messages.find((m) => m.role === "user")?.content);
  if (!prompt.startsWith("You grade what an agent proposes to remember.")) return faux.message("Job answer.");
  const files = /^Give one item for each of these files, each once, and for no other: (.*)\.$/m.exec(prompt)?.[1].split(", ") ?? [];
  const said = /----- begin (\w+): the user's messages -----\n([\s\S]*?)\n----- end \1 -----/.exec(prompt)?.[2];
  if (process.env.AGENTRUN_TEST_FAUX_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ kind: "grade", files, said: said ?? null })}\n`);
  if (said === undefined) return faux.message("I was not told what the user said.");
  // A case labelled pending is a risky rule the user asked for: kept, to wait for its owner's OK.
  const decision = (file) => (LABELS.get(file) === "keep" ? "keep" : LABELS.get(file) === "pending" ? "pending" : "drop");
  const merge = files.every((file) => decision(file) !== "drop");
  return faux.message(JSON.stringify({
    merge,
    reason: merge ? "Each note is the eval's keep or pending." : "A note is the eval's drop.",
    items: files.map((file) => ({ file, decision: decision(file), ...(decision(file) === "pending" ? { origin: "you", question: "Risky" } : decision(file) === "drop" ? { question: "General" } : {}), why: `Labelled ${decision(file)}.` })),
  }));
}
