// A faux grader for the learning eval (learn-eval.test.mjs): it keeps a proposal exactly when every note in it is one the
// eval set labels `keep` (test/fixtures/learn-eval.json, by the note's file name), and answers in the verdict's shape.
// It also refuses to judge a prompt that does not fence what the user said in the run, so the eval proves the grader
// is given it. Each call is filed as a line in the file AGENTRUN_TEST_FAUX_CALLS names.
import { appendFileSync, readFileSync } from "node:fs";

const CASES = JSON.parse(readFileSync(new URL("./learn-eval.json", import.meta.url), "utf8")).cases;
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
  const keep = (file) => LABELS.get(file) === "keep";
  return faux.message(JSON.stringify({
    merge: files.every(keep),
    reason: files.every(keep) ? "Each note is the eval's keep." : "A note is the eval's drop.",
    items: files.map((file) => ({ file, keep: keep(file), ...(keep(file) ? {} : { question: "General" }), why: keep(file) ? "Labelled keep." : "Labelled drop." })),
  }));
}
