// Learning, after a run: the notes its end-of-run turn answered with are read by the host (learn/reflect.ts
// parseReflection), checked against the commit the run started from (learn/check.ts checkProposal), and kept in the
// run's own directory as its proposal (`learning-proposal.json`), or dropped. The answer is read from what the run's
// directory kept as the run settled (learning.ts keepTurn), never from the run's work or its rows, which a follow-up
// may change; and no file the run wrote is read at all, in `.learning/` or anywhere. In the agent's queue. Nothing is
// written to git here, and nothing is written at all before the checks pass: a note they refuse (one holding a secret
// among them) is never kept anywhere.
import { join } from "node:path";
import { type Change, checkProposal, GRADE_CAPS, parseReflection, type Problem, redactSecrets } from "./learn/index.js";
import { homeOf, writeDurable } from "./files.js";
import { activeOf, agentFolder, type Proposal, PROPOSAL, readSeed, type Turn, withAgentRepo } from "./learning.js";

export type Proposed =
  | { state: "proposed"; notes: number }
  | { state: "dropped"; reason: "empty" }
  | { state: "dropped"; reason: "unparsed"; detail: string }
  | { state: "dropped"; reason: "checker"; problems: Problem[] };

/** `text`'s first `max` UTF-16 units, never half a character. */
const cut = (text: string, max: number) => (text.length <= max ? text : [...text].reduce((out, ch) => (out.length + ch.length > max ? out : out + ch), ""));

/** What a run's end-of-run turn answered (`turn`, as its directory kept it), its notes parsed, checked against its seed
 *  `seed` (its pin) and kept in `runDir` as its proposal, with what the user said in the run as the grader reads it
 *  (each message cut of the host's secrets, then to GRADE_CAPS.askedMessage); or `empty` when it gave no note,
 *  `unparsed` when its notes are out of format, or `checker` with the problems, printable. A note the answer gives with
 *  the very text of one in the seed is no change, and `MEMORY.md` is the host's (the checker ignores it). `refuse`: this
 *  host's secrets. In the agent's queue. */
export const proposeRun = (input: { data: string; agentId: string; runDir: string; seed: string; turn: Turn; refuse: readonly string[] }): Promise<Proposed> => withAgentRepo(input.data, input.agentId, async () => {
  const seed = await readSeed(homeOf(input.data, input.agentId), await agentFolder(input.data, input.agentId), input.seed);
  const parsed = parseReflection(input.turn.answer);
  if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
  const changes: Change[] = parsed.notes
    .filter(({ file, text }) => seed.notes[file] !== text)
    .map(({ file, text }) => ({ path: file, status: seed.files.includes(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) }));
  const checked = checkProposal({ base: { files: seed.files, active: activeOf(seed) }, changes, refuseValues: input.refuse });
  if (checked.problems.length) return { state: "dropped", reason: "checker", problems: checked.problems };
  if (!checked.notes.length) return { state: "dropped", reason: "empty" };
  // Each message cut of the host's secrets whole first, and only then shortened: a secret the cut fell inside would
  // leave a part of itself that no longer matches. The whole message is read, however long (a message is bounded by
  // the run's own request limits), so a long one is not lost to the grader as one "[redacted]".
  const asked = input.turn.asked.map((message) => cut(redactSecrets(message, input.refuse, Number.POSITIVE_INFINITY), GRADE_CAPS.askedMessage));
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })), asked };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  return { state: "proposed", notes: proposal.notes.length };
});
