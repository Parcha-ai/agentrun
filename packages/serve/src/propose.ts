// Learning, after a run: the notes its end-of-run turn answered with, and a skill or a workflow draft beside them, are read
// by the host (learn/reflect.ts parseReflection), checked against the commit the run started from (learn/check.ts
// checkProposal), and kept in the run's own directory as its proposal (`learning-proposal.json`), or dropped. The answer
// is read from what the run's directory kept as the run settled (learning.ts keepTurn), never from the run's work or its
// rows, which a follow-up may change; and no file the run wrote is read at all, in `.learning/` or anywhere. In the
// agent's queue. Nothing is written to git here, and nothing is written at all before the checks pass: what they refuse
// (a note holding a secret among them) is never kept anywhere.
import { join } from "node:path";
import { type Change, checkProposal, draftFiles, GRADE_CAPS, parseReflection, type Problem, redactSecrets, SKILLS_DIR, WORKFLOWS_DIR } from "./learn/index.js";
import { homeOf, writeDurable } from "./files.js";
import { activeOf, agentFolder, git, type Proposal, PROPOSAL, readBlobs, readSeed, type Turn, withAgentRepo } from "./learning.js";

export type Proposed =
  | { state: "proposed"; notes: number; skills: number; workflows: number }
  | { state: "dropped"; reason: "empty" }
  | { state: "dropped"; reason: "unparsed"; detail: string }
  | { state: "dropped"; reason: "checker"; problems: Problem[] };

/** `text`'s first `max` UTF-16 units, never half a character. */
const cut = (text: string, max: number) => (text.length <= max ? text : [...text].reduce((out, ch) => (out.length + ch.length > max ? out : out + ch), ""));
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The skills and drafts on the seed `sha`: every path under skills/ and workflows/, and the text of each regular file of
 *  them `wanted` names (one that is not UTF-8 is left out, so an answer that gives it is a change). */
async function seedFiles(home: string, repo: string, sha: string, wanted: readonly string[]): Promise<{ files: string[]; texts: Map<string, string> }> {
  const listed = (await git(home, repo, ["ls-tree", "-r", "-z", sha, "--", SKILLS_DIR, WORKFLOWS_DIR])).toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
    return { mode, type, oid: oid!, path: entry.slice(entry.indexOf("\t") + 1) };
  });
  const read = listed.filter((entry) => entry.mode === "100644" && entry.type === "blob" && wanted.includes(entry.path));
  const blobs = await readBlobs(home, repo, read.map((entry) => entry.oid));
  const texts = new Map<string, string>();
  read.forEach((entry, i) => {
    try {
      texts.set(entry.path, utf8.decode(blobs[i]!));
    } catch {
      // Not UTF-8: no text the answer can give again.
    }
  });
  return { files: listed.map((entry) => entry.path), texts };
}

/** What a run's end-of-run turn answered (`turn`, as its directory kept it), parsed, checked against its seed `seed` (its
 *  pin) and kept in `runDir` as its proposal, with what the user said in the run as the grader reads it (each message
 *  cut of the host's secrets, then to GRADE_CAPS.askedMessage); or `empty` when it gave nothing, `unparsed` when its
 *  answer is out of format, or `checker` with the problems, printable. A note, skill or draft the answer gives with the
 *  very text the seed holds is no change, and `MEMORY.md` is the host's (the checker ignores it). A skill is laid at
 *  `skills/<name>/SKILL.md`; a draft at `workflows/<name>/workflow.json`, with the README.md the host writes from the
 *  description its block gives. `outcome`, how the run's job ended (only a completed run adds or changes a skill);
 *  `tools`, those a draft may name (tools.ts learnedWorkflowTools); `refuse`: this host's secrets. In the agent's
 *  queue. */
export const proposeRun = (input: { data: string; agentId: string; runDir: string; seed: string; turn: Turn; refuse: readonly string[]; outcome?: string; tools?: readonly string[] }): Promise<Proposed> => withAgentRepo(input.data, input.agentId, async () => {
  const home = homeOf(input.data, input.agentId);
  const repo = await agentFolder(input.data, input.agentId);
  const seed = await readSeed(home, repo, input.seed);
  const parsed = parseReflection(input.turn.answer);
  if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
  // Each skill and draft as the folder would hold it; a draft is its two files, given together or not at all.
  const given = [
    ...(parsed.skills ?? []).map(({ name, text }) => [{ file: `${SKILLS_DIR}/${name}/SKILL.md`, text }]),
    ...(parsed.workflows ?? []).map(({ name, text }) => {
      const { json, readme } = draftFiles(name, text);
      return [{ file: `${WORKFLOWS_DIR}/${name}/workflow.json`, text: json }, { file: `${WORKFLOWS_DIR}/${name}/README.md`, text: readme }];
    }),
  ];
  const held = given.length ? await seedFiles(home, repo, input.seed, given.flat().map(({ file }) => file)) : { files: [], texts: new Map<string, string>() };
  const files = given.filter((group) => group.some(({ file, text }) => held.texts.get(file) !== text)).flat();
  const changes: Change[] = [
    ...parsed.notes.filter(({ file, text }) => seed.notes[file] !== text).map(({ file, text }): Change => ({ path: file, status: seed.files.includes(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) })),
    ...files.map(({ file, text }): Change => ({ path: file, status: held.files.includes(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) })),
  ];
  // The workflow DSL reads a draft, and is loaded only when there is one to read.
  const dsl = files.some(({ file }) => file.endsWith("/workflow.json")) ? await import("@parcha/agentrun-dsl") : undefined;
  const checked = checkProposal({ base: { files: [...seed.files, ...held.files], active: activeOf(seed) }, changes, refuseValues: input.refuse, ...(input.outcome === undefined ? {} : { outcome: input.outcome }), ...(input.tools ? { tools: input.tools } : {}), ...(dsl ? { dsl } : {}) });
  if (checked.problems.length) return { state: "dropped", reason: "checker", problems: checked.problems };
  if (!checked.notes.length && !files.length) return { state: "dropped", reason: "empty" };
  // Each message cut of the host's secrets whole first, and only then shortened: a secret the cut fell inside would
  // leave a part of itself that no longer matches. The whole message is read, however long (a message is bounded by
  // the run's own request limits), so a long one is not lost to the grader as one "[redacted]".
  const asked = input.turn.asked.map((message) => cut(redactSecrets(message, input.refuse, Number.POSITIVE_INFINITY), GRADE_CAPS.askedMessage));
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })), ...(files.length ? { files } : {}), asked };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  const count = (suffix: string) => files.filter(({ file }) => file.endsWith(suffix)).length;
  return { state: "proposed", notes: proposal.notes.length, skills: count("/SKILL.md"), workflows: count("/workflow.json") };
});
