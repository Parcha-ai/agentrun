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
import { type Change, checkProposal, draftFiles, NOTE_BLOCK, unstorable, parseReflection, type Problem, redactSecrets, shortMessage, SKILL_BLOCK, SKILLS_DIR, WORKFLOW_BLOCK, WORKFLOWS_DIR } from "./learn/index.js";
import { folderAt, readLearning, readSnapshot, type Snapshot } from "./learn/folder.js";
import { baseOf } from "./learn/seed-check.js";
import { parseNoteFile, ruleOf } from "./learn/notes.js";
import { writeDurable } from "./files.js";
import { type Proposal, PROPOSAL, type Turn } from "./learning.js";
import type { Workspace } from "./workspace/index.js";

export type Proposed =
  | { state: "proposed"; notes: number; skills: number; workflows: number; left?: Problem[] }
  | { state: "dropped"; reason: "empty" }
  | { state: "dropped"; reason: "unparsed"; detail: string }
  | { state: "dropped"; reason: "checker"; problems: Problem[] };

/** The rules that refuse a proposal whole, whatever item they name: a path outside what a run may write, a deletion,
 *  the folder's index full (the notes' total, which no one item is past), anything that must never be stored (a secret,
 *  a character a reader does not see), which says the run's answer is not to be trusted for any item, and text that is
 *  not UTF-8, which cannot be read for one. Every other problem is its item's alone: a count cap names the items past it
 *  (learn/check.ts), a size cap the item over it, and they are left out and the rest kept; unstorable reads every item's
 *  text whole first. */
const WHOLE: ReadonlySet<Problem["rule"]> = new Set(["outside", "deleted", "index_full", "secret_value", "secret_shape", "invisible_unicode", "encoding"]);

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
  // Each skill and draft as the folder would hold it, keyed by its block (kind and name) so the changes keep the
  // answer's order; a draft is its two files, given together or not at all.
  const fileGroups = new Map<string, { file: string; text: string }[]>();
  const keyOf = (kind: string, name: string) => `${kind}\u0000${name}`;
  for (const { name, text } of parsed.ok ? (parsed.skills ?? []) : []) fileGroups.set(keyOf(SKILL_BLOCK, name), [{ file: `${SKILLS_DIR}/${name}/SKILL.md`, text }]);
  for (const { name, text } of parsed.ok ? (parsed.workflows ?? []) : []) {
    const { json, readme } = draftFiles(name, text);
    fileGroups.set(keyOf(WORKFLOW_BLOCK, name), [{ file: `${WORKFLOWS_DIR}/${name}/workflow.json`, text: json }, { file: `${WORKFLOWS_DIR}/${name}/README.md`, text: readme }]);
  }
  const given = [...fileGroups.values()];
  // The seed is read whatever the answer: a seed the folder does not hold fails the check.
  // The seed's active notes are read too: a new note of the same rule as one (notes.ts ruleOf) is a duplicate.
  const activeOf = (seedSnapshot: Snapshot) => seedSnapshot.notes.filter((note) => note.status === "active").map((note) => note.file);
  const { snapshot, texts } = await seedAt(input.folder, input.seed, (seedSnapshot) => (parsed.ok ? [...parsed.notes.map(({ file }) => file), ...given.flat().map(({ file }) => file), ...activeOf(seedSnapshot)] : []));
  if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
  const { base: seedBase, kept } = baseOf(snapshot);
  const rules = new Map(activeOf(snapshot).flatMap((file): [string, string][] => {
    const note = texts.has(file) ? parseNoteFile(file, texts.get(file)!) : undefined;
    return note && !Array.isArray(note) ? [[ruleOf(note.body), file]] : [];
  }));
  const base = { ...seedBase, rules };
  const held = new Set(base.files);
  const files = given.filter((group) => group.some(({ file, text }) => texts.get(file) !== text)).flat();
  const changeOf = ({ file, text }: { file: string; text: string }): Change => ({ path: file, status: held.has(file) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) });
  // Each changed item in the order the answer gave its block, whatever its kind: a count cap names the items past it in
  // that order (learn/check.ts), so a skill the answer led with is never the one past the changed-path cap.
  const noteTexts = new Map(parsed.notes.map(({ file, text }) => [file, text]));
  const changed = new Set(files.map(({ file }) => file));
  const changes: Change[] = parsed.order.flatMap(({ kind, name }): Change[] => {
    if (kind === NOTE_BLOCK) {
      const text = noteTexts.get(name)!;
      return texts.get(name) !== text ? [changeOf({ file: name, text })] : [];
    }
    return (fileGroups.get(keyOf(kind, name)) ?? []).filter(({ file }) => changed.has(file)).map(changeOf);
  });
  // The workflow DSL reads a draft, and is loaded only when there is one to read.
  const dsl = files.some(({ file }) => file.endsWith("/workflow.json")) ? await import("@parcha/agentrun-dsl") : undefined;
  // A skill or a draft whose seed text has a status is a person's call (retired, or waiting for their OK): never changed.
  const check = (some: Change[]) => checkProposal({ base, changes: some, refuseValues: input.refuse, ...(kept.length ? { kept } : {}), ...(input.outcome === undefined ? {} : { outcome: input.outcome }), ...(input.tools ? { tools: input.tools } : {}), ...(input.gated ? { gated: input.gated } : {}), ...(input.deniedBy ? { deniedBy: input.deniedBy } : {}), ...(dsl ? { dsl } : {}) });
  // A verdict per item from the checks too: the items a problem names are left out (a draft's two files together),
  // and the rest is checked again, until it passes; a problem that names no item, or one that refuses the whole (WHOLE),
  // drops it all, as does a rest with nothing left. A later pass can name what an earlier one did not reach (the
  // supersedes count, asked only of a rest with no other problem); each pass leaves out at least one item, so it ends.
  let checked = check(changes);
  let left: Problem[] = [];
  const out = new Set<string>();
  if (checked.problems.length) {
    const named = new Set(changes.map(({ path }) => itemOf(path)));
    // Before any item is kept from an answer the checks refuse: every name and text it gave, read whole. Something
    // that must never be stored anywhere in it (in an item the checks refused unread, too) refuses it all.
    const never = unstorable(changes, input.refuse);
    for (;;) {
      if (checked.problems.some((problem) => WHOLE.has(problem.rule) || problem.path === undefined || !named.has(itemOf(problem.path)))) return { state: "dropped", reason: "checker", problems: [...left, ...checked.problems] };
      if (never.length) return { state: "dropped", reason: "checker", problems: [...left, ...checked.problems, ...never] };
      left = [...left, ...checked.problems];
      for (const problem of checked.problems) out.add(itemOf(problem.path!));
      const rest = changes.filter(({ path }) => !out.has(itemOf(path)));
      if (!rest.length) return { state: "dropped", reason: "checker", problems: left };
      checked = check(rest);
      if (!checked.problems.length) break;
    }
  }
  const passing = files.filter(({ file }) => !out.has(itemOf(file)));
  if (!checked.notes.length && !passing.length) return { state: "dropped", reason: "empty" };
  // Each message cut of the host's secrets whole first, and only then shortened: a secret the cut fell inside would
  // leave a part of itself that no longer matches. The whole message is read, however long (a message is bounded by
  // the run's own request limits), so a long one is not lost to the grader as one "[redacted]".
  const asked = input.turn.asked.map((message) => shortMessage(redactSecrets(message, input.refuse, Number.POSITIVE_INFINITY)));
  // A trigger's input, apart from what the user said, cut and shortened the same way.
  const triggered = (input.turn.triggered ?? []).map(({ source, text }) => ({ source, text: shortMessage(redactSecrets(text, input.refuse, Number.POSITIVE_INFINITY)) }));
  const proposal: Proposal = { seed: input.seed, notes: checked.notes.map(({ file, text }) => ({ file, text })), ...(passing.length ? { files: passing } : {}), asked, ...(triggered.length ? { triggered } : {}) };
  await writeDurable(join(input.runDir, PROPOSAL), `${JSON.stringify(proposal)}\n`);
  const count = (suffix: string) => passing.filter(({ file }) => file.endsWith(suffix)).length;
  return { state: "proposed", notes: proposal.notes.length, skills: count("/SKILL.md"), workflows: count("/workflow.json"), ...(left.length ? { left } : {}) };
};
