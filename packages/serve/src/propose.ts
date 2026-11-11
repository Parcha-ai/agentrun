// Learning, after a run: the notes its end-of-run turn answered with, and a skill or a workflow draft beside them, are read
// by the host (learn/reflect.ts parseReflection), checked against the commit the run started from (learn/check.ts
// checkProposal), and kept as its proposal (`learning-proposal.json`, in the directory the caller gives), or dropped. The
// answer is what the runner's end-of-run turn read from the run's store (runner/learning-end.ts), never the run's work;
// and no file the run wrote is read at all, in `.learning/` or anywhere. The seed is
// read from the agent's learning folder through its Workspace, as the reflect hook's check reads it (learn/seed-check.ts):
// the snapshot and its bodies when main is the seed (no exec), else one read-only exec of the learning script at that
// commit. Nothing is written to git here, and nothing is written at all before the checks pass: what they refuse (a
// note holding a secret among them) is never kept anywhere.
import { join } from "node:path";
import { type Change, checkProposal, type DraftDryRun, draftDryRun, draftFiles, unstorable, parseReflection, type Problem, redactSecrets, shortMessage, SKILLS_DIR, WORKFLOWS_DIR } from "./learn/index.js";
import { folderAt, readLearning, readSnapshot, type Snapshot } from "./learn/folder.js";
import { baseOf } from "./learn/seed-check.js";
import { writeDurable } from "./files.js";
import { type Proposal, PROPOSAL, type Turn } from "./learning.js";
import type { Workspace } from "./workspace/index.js";

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
/** The text of `bytes`, or undefined when they are not UTF-8 (no text an answer can give again). */
const textOf = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** Each file of a snapshot by path, with its blob id: the notes, and the learned items' regular files. */
const oidsOf = (snapshot: Snapshot): Map<string, string> => new Map([
  ...snapshot.notes.map((note): [string, string] => [note.file, note.oid]),
  ...[...snapshot.skills, ...snapshot.workflows].flatMap((item) => item.files.map(({ path, oid }): [string, string] => [path, oid])),
]);

/** The seed `seed` of the folder `lw`, and the texts of the files of it `wanted` names (one it does not hold, or that is
 *  not UTF-8, is left out): from the snapshot and its bodies when its main is the seed (no exec); else ONE read-only
 *  exec of the learning script's `read` at that commit. Throws when the folder has no such commit. */
async function seedAt(lw: Workspace, seed: string, wanted: (snapshot: Snapshot) => readonly string[]): Promise<{ snapshot: Snapshot; texts: Map<string, string> }> {
  const now = await readSnapshot(lw);
  if (now?.main === seed) {
    const read = await readLearning(lw, async ({ snapshot, bytes }) => {
      // The folder moved on as it was read: read at the seed below.
      if (snapshot?.main !== seed) return undefined;
      const oids = oidsOf(snapshot);
      const texts = new Map<string, string>();
      for (const path of wanted(snapshot)) {
        const oid = oids.get(path);
        const text = oid === undefined ? undefined : textOf(await bytes(path, oid));
        if (text !== undefined) texts.set(path, text);
      }
      return { snapshot, texts };
    });
    if (read) return read;
  }
  const at = await folderAt(lw, seed);
  if (!at) throw new Error(`the learning folder has no commit ${seed}`);
  const oids = oidsOf(at.snapshot);
  const texts = new Map<string, string>();
  for (const path of wanted(at.snapshot)) {
    const blob = oids.has(path) ? at.blobs.get(oids.get(path)!) : undefined;
    const text = blob === undefined ? undefined : textOf(blob);
    if (text !== undefined) texts.set(path, text);
  }
  return { snapshot: at.snapshot, texts };
}

/** What a run's end-of-run turn answered (`turn`, as its directory kept it), parsed, checked against its seed `seed` (its
 *  pin) in the agent's learning folder `folder` (learningWorkspace; the caller ends it) and kept in `runDir` as its
 *  proposal, with what the user said in the run as the grader reads it (each message cut of the host's secrets, then
 *  shortened to its head and tail by shortMessage); or `empty` when it gave nothing, `unparsed` when its answer is out of
 *  format, or `checker` with the problems, printable. A note, skill or draft the answer gives with the very text the
 *  seed holds is no change, and `MEMORY.md` is the host's (the checker ignores it). A skill is laid at
 *  `skills/<name>/SKILL.md`; a draft at `workflows/<name>/workflow.json`, with the README.md the host writes from the
 *  description its block gives. `outcome`, how the run's job ended (only a completed run adds or changes a skill);
 *  `tools`, those a draft may name (tools.ts learnedWorkflowTools); `refuse`: this host's secrets. */
export const proposeRun = async (input: { folder: Workspace; runDir: string; seed: string; turn: Turn; refuse: readonly string[]; outcome?: string; tools?: readonly string[]; gated?: Readonly<Record<string, string>>; deniedBy?: Readonly<Record<string, "agent" | "server" | "default">> }): Promise<Proposed> => {
  const parsed = parseReflection(input.turn.answer);
  // Each skill and draft as the folder would hold it; a draft is its two files, given together or not at all.
  // A draft's `example:` line, by its workflow.json's path: the input its dry run runs on, never a file's (draftFiles
  // leaves it out of the README).
  const examples = new Map<string, string>();
  const given = parsed.ok ? [
    ...(parsed.skills ?? []).map(({ name, text }) => [{ file: `${SKILLS_DIR}/${name}/SKILL.md`, text }]),
    ...(parsed.workflows ?? []).map(({ name, text }) => {
      const { json, readme, example } = draftFiles(name, text);
      if (example !== undefined) examples.set(`${WORKFLOWS_DIR}/${name}/workflow.json`, example);
      return [{ file: `${WORKFLOWS_DIR}/${name}/workflow.json`, text: json }, { file: `${WORKFLOWS_DIR}/${name}/README.md`, text: readme }];
    }),
  ] : [];
  // The seed is read whatever the answer: a seed the folder does not hold fails the check.
  const { snapshot, texts } = await seedAt(input.folder, input.seed, () => (parsed.ok ? [...parsed.notes.map(({ file }) => file), ...given.flat().map(({ file }) => file)] : []));
  if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
  const { base, kept } = baseOf(snapshot);
  const held = new Set(base.files);
  const files = given.filter((group) => group.some(({ file, text }) => texts.get(file) !== text)).flat();
  const changes: Change[] = [
    ...parsed.notes.filter(({ file, text }) => texts.get(file) !== text).map(({ file, text }): Change => ({ path: file, status: held.has(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) })),
    ...files.map(({ file, text }): Change => ({ path: file, status: held.has(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) })),
  ];
  // The workflow DSL reads a draft, and is loaded only when there is one to read.
  const dsl = files.some(({ file }) => file.endsWith("/workflow.json")) ? await import("@parcha/agentrun-dsl") : undefined;
  // A draft's example: the run's own input, so read as every text the run gave is, for what must never be stored (a
  // held secret, a secret's shape): one that holds any refuses the whole answer, said at the draft's README, though it
  // is never written there.
  const exampled = files.filter(({ file }) => examples.has(file)).map(({ file }): Change => ({ path: file.replace(/workflow\.json$/, "README.md"), status: "added", mode: "100644", bytes: Buffer.from(examples.get(file)!) }));
  const leaky = unstorable(exampled, input.refuse);
  if (leaky.length) return { state: "dropped", reason: "checker", problems: leaky };
  // A skill or a draft whose seed text has a status is a person's call (retired, or waiting for their OK): never changed.
  const dryRuns: Record<string, DraftDryRun> = {};
  const check = (some: Change[]) => checkProposal({ base, changes: some, refuseValues: input.refuse, ...(kept.length ? { kept } : {}), ...(input.outcome === undefined ? {} : { outcome: input.outcome }), ...(input.tools ? { tools: input.tools } : {}), ...(input.gated ? { gated: input.gated } : {}), ...(input.deniedBy ? { deniedBy: input.deniedBy } : {}), ...(dsl ? { dsl, dryRuns } : {}) });
  // The static checks first, every one (validateWorkflow with executeCode: false, draftProblems' refusal of code nodes,
  // caps, secrets): a draft they refuse is never dry-run, nor is any when they refuse the answer whole. Then each draft
  // left is dry-run on its example, else on a synthesized input (learn/skills.ts draftDryRun): every model and tool
  // answer synthesized, nothing sent, paid or run, and no code it holds run in this process.
  if (dsl) {
    const statics = check(changes).problems;
    const whole = statics.some((problem) => WHOLE.has(problem.rule) || problem.path === undefined);
    const refused = new Set(statics.flatMap((problem) => (problem.path === undefined ? [] : [itemOf(problem.path)])));
    if (!whole) for (const { file, text } of files) if (file.endsWith("/workflow.json") && !refused.has(itemOf(file))) dryRuns[file] = await draftDryRun(dsl, text, examples.get(file));
  }
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
  // A trigger's input, apart from what the user said, cut and shortened the same way.
  const triggered = (input.turn.triggered ?? []).map(({ source, text }) => ({ source, text: shortMessage(redactSecrets(text, input.refuse, Number.POSITIVE_INFINITY)) }));
  // How each kept draft's dry run went, for the grader: passed, or not run and why.
  const ran = Object.fromEntries(passing.filter(({ file }) => dryRuns[file]).map(({ file }) => [file, dryRuns[file]!]));
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })), ...(passing.length ? { files: passing } : {}), ...(Object.keys(ran).length ? { dryRuns: ran } : {}), asked, ...(triggered.length ? { triggered } : {}) };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  const count = (suffix: string) => passing.filter(({ file }) => file.endsWith(suffix)).length;
  return { state: "proposed", notes: proposal.notes.length, skills: count("/SKILL.md"), workflows: count("/workflow.json"), ...(left.length ? { left } : {}) };
};
