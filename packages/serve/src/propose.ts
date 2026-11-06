// Learning, after a run: the notes its end-of-run turn answered with, and a skill or a workflow draft beside them, are read
// by the host (learn/reflect.ts parseReflection), checked against the commit the run started from (learn/check.ts
// checkProposal), and kept in the run's own directory as its proposal (`learning-proposal.json`), or dropped. The answer
// is read from what the run's directory kept as the run settled (learning.ts keepTurn), never from the run's work or its
// rows, which a follow-up may change; and no file the run wrote is read at all, in `.learning/` or anywhere. In the
// agent's queue. Nothing is written to git here, and nothing is written at all before the checks pass: what they refuse
// (a note holding a secret among them) is never kept anywhere.
import { join } from "node:path";
import { type Change, checkProposal, draftFiles, unstorable, learnedStatus, parseReflection, type Problem, redactSecrets, shortMessage, SKILLS_DIR, WORKFLOWS_DIR } from "./learn/index.js";
import { agentFolderOf, writeDurable } from "./files.js";
import { activeOf, agentFolder, git, type Proposal, PROPOSAL, readBlobs, readSeed, type Turn, withAgentRepo } from "./learning.js";

export type Proposed =
  | { state: "proposed"; notes: number; skills: number; workflows: number; left?: Problem[] }
  | { state: "dropped"; reason: "empty" }
  | { state: "dropped"; reason: "unparsed"; detail: string }
  | { state: "dropped"; reason: "checker"; problems: Problem[] };

/** The rules that refuse a proposal whole, whatever item they name: its counts and caps, a path outside what a run may
 *  write, a deletion, the folder's index full, anything that must never be stored (a secret, a character a reader does
 *  not see), which says the run's answer is not to be trusted for any item, and text that is not UTF-8, which cannot be
 *  read for one. Every other problem is its item's alone; unstorable reads every item's text whole first. */
const WHOLE: ReadonlySet<Problem["rule"]> = new Set(["too_many_files", "too_many_notes", "too_many_skills", "too_many_workflows", "outside", "deleted", "index_full", "secret_value", "secret_shape", "invisible_unicode", "encoding"]);

/** The item a changed file belongs to: a draft's two files are one item (its folder), every other file is itself. */
const itemOf = (path: string) => (path.startsWith(`${WORKFLOWS_DIR}/`) ? path.split("/").slice(0, 2).join("/") : path);

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
 *  cut of the host's secrets, then shortened to its head and tail by shortMessage); or `empty` when it gave nothing, `unparsed` when its
 *  answer is out of format, or `checker` with the problems, printable. A note, skill or draft the answer gives with the
 *  very text the seed holds is no change, and `MEMORY.md` is the host's (the checker ignores it). A skill is laid at
 *  `skills/<name>/SKILL.md`; a draft at `workflows/<name>/workflow.json`, with the README.md the host writes from the
 *  description its block gives. `outcome`, how the run's job ended (only a completed run adds or changes a skill);
 *  `tools`, those a draft may name (tools.ts learnedWorkflowTools); `refuse`: this host's secrets. In the agent's
 *  queue. */
export const proposeRun = (input: { data: string; agentId: string; runDir: string; seed: string; turn: Turn; refuse: readonly string[]; outcome?: string; tools?: readonly string[]; gated?: Readonly<Record<string, string>>; deniedBy?: Readonly<Record<string, "agent" | "server" | "default">> }): Promise<Proposed> => withAgentRepo(input.data, input.agentId, async () => {
  const home = agentFolderOf(input.data, input.agentId);
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
  // A skill or a draft whose seed text has a status is a person's call (retired, or waiting for their OK): never changed.
  const kept = [...held.texts].filter(([file, text]) => (file.endsWith("/SKILL.md") || file.endsWith("/README.md")) && learnedStatus(text) !== "active").map(([file]) => file);
  const check = (some: Change[]) => checkProposal({ base: { files: [...seed.files, ...held.files], active: activeOf(seed) }, changes: some, refuseValues: input.refuse, ...(kept.length ? { kept } : {}), ...(input.outcome === undefined ? {} : { outcome: input.outcome }), ...(input.tools ? { tools: input.tools } : {}), ...(input.gated ? { gated: input.gated } : {}), ...(input.deniedBy ? { deniedBy: input.deniedBy } : {}), ...(dsl ? { dsl } : {}) });
  // A verdict per item from the checks too: the items a problem names are left out (a draft's two files together),
  // and the rest is checked again; a problem that names no item, or one that refuses the whole (WHOLE), drops it all,
  // as does a rest the checks still refuse.
  let checked = check(changes);
  let left: Problem[] = [];
  let passing = files;
  if (checked.problems.length) {
    const named = new Set(changes.map(({ path }) => itemOf(path)));
    if (checked.problems.some((problem) => WHOLE.has(problem.rule) || problem.path === undefined || !named.has(itemOf(problem.path)))) return { state: "dropped", reason: "checker", problems: checked.problems };
    // Before any item is kept from an answer the checks refuse: every name and text it gave, read whole. Something
    // that must never be stored anywhere in it (in an item the checks refused unread, too) refuses it all.
    const never = unstorable(changes, input.refuse);
    if (never.length) return { state: "dropped", reason: "checker", problems: [...checked.problems, ...never] };
    const out = new Set(checked.problems.map((problem) => itemOf(problem.path!)));
    const rest = changes.filter(({ path }) => !out.has(itemOf(path)));
    const again = rest.length ? check(rest) : undefined;
    // A rest the checks refuse again: its own problems are what keeps it out, said with the first pass's.
    if (!again || again.problems.length) return { state: "dropped", reason: "checker", problems: [...checked.problems, ...(again?.problems ?? [])] };
    left = checked.problems;
    checked = again;
    passing = files.filter(({ file }) => !out.has(itemOf(file)));
  }
  if (!checked.notes.length && !passing.length) return { state: "dropped", reason: "empty" };
  // Each message cut of the host's secrets whole first, and only then shortened: a secret the cut fell inside would
  // leave a part of itself that no longer matches. The whole message is read, however long (a message is bounded by
  // the run's own request limits), so a long one is not lost to the grader as one "[redacted]".
  const asked = input.turn.asked.map((message) => shortMessage(redactSecrets(message, input.refuse, Number.POSITIVE_INFINITY)));
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })), ...(passing.length ? { files: passing } : {}), asked };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  const count = (suffix: string) => passing.filter(({ file }) => file.endsWith(suffix)).length;
  return { state: "proposed", notes: proposal.notes.length, skills: count("/SKILL.md"), workflows: count("/workflow.json"), ...(left.length ? { left } : {}) };
});
