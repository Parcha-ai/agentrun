// The proposal check for the runner's reflect hook (COMMIT-API.md, tl-jobs' createReflectHook `check` dep): a run's
// proposed changes checked (check.ts checkProposal) against the seed it started from, read from the learning folder
// through its Workspace: the snapshot when its main is the run's seed (no exec), else one read-only exec of the
// learning script at that commit.
import { type Base, type Change, checkProposal, type Problem } from "./check.js";
import { type DraftReader } from "./skills.js";
import { FolderBusy, folderAt, readLearning, readSnapshot, type Snapshot, snapshotAt, snapshotNotes, topOf } from "./folder.js";
import { INDEX_FILE } from "./notes.js";
import type { Workspace } from "../workspace/index.js";

/** What the seed holds as the checker reads it: every path at its top and in its learned folders, and its active notes.
 *  `kept`: the skills' and drafts' files whose text there has a status (a person's call), which a run never changes.
 *  proposeRun takes it from the snapshot it read the seed's texts with, so the base costs no second read. */
export function baseOf(snapshot: Snapshot): { base: Base; kept: string[] } {
  const learned = [...snapshot.skills, ...snapshot.workflows];
  return {
    base: { files: [...topOf(snapshot), ...learned.flatMap((item) => item.files.map((file) => file.path))], active: snapshotNotes(snapshot).filter((note) => note.status === "active") },
    kept: learned.filter((item) => item.status !== "active").map((item) => item.file),
  };
}

/** The seed a run started from, as the checker's base: from the snapshot when its main is the run's seed (no exec); else
 *  ONE exec of the script's read-only `read` at that commit. `gone` when the folder has no such commit, `unavailable`
 *  when it cannot be read. */
export async function seedBase(lw: Workspace, seed: string): Promise<{ ok: true; base: Base; kept: string[] } | { ok: false; reason: "unavailable" | "gone"; detail: string }> {
  try {
    const now = await readSnapshot(lw);
    const at = now?.main === seed ? now : await snapshotAt(lw, seed);
    if (!at) return { ok: false, reason: "gone", detail: `the learning folder has no commit ${seed}` };
    return { ok: true, ...baseOf(at) };
  } catch (error) {
    return { ok: false, reason: "unavailable", detail: (error as Error)?.message ?? String(error) };
  }
}

/** The hook's `check`: checkProposal over the run's seed. `open` gives the agent's learning folder (learningWorkspace),
 *  ended once the check is done. `refuse`: the host's secrets, which a file or a name holding one is refused for. */
export function makeProposalCheck(deps: { open: (agentId: string) => { workspace: Workspace; end(): Promise<void> } }) {
  return async (input: { agentId: string; seed: string; changes: Change[]; outcome: string; tools: readonly string[]; dsl: DraftReader; gated?: Readonly<Record<string, string>>; refuse?: readonly string[] }): Promise<{ ok: true; problems: [] } | { ok: false; problems: Problem[] } | { ok: false; unavailable: string }> => {
    const { workspace, end } = deps.open(input.agentId);
    try {
      const seed = await seedBase(workspace, input.seed);
      if (!seed.ok) return { ok: false, unavailable: seed.detail };
      const checked = checkProposal({ base: seed.base, changes: input.changes, outcome: input.outcome, tools: input.tools, dsl: input.dsl, ...(input.gated ? { gated: input.gated } : {}), ...(input.refuse ? { refuseValues: input.refuse } : {}), ...(seed.kept.length ? { kept: seed.kept } : {}) });
      return checked.problems.length ? { ok: false, problems: checked.problems } : { ok: true, problems: [] };
    } finally {
      await end();
    }
  };
}

/** What a run is laid from at commit `seed` (a reopened run re-lays from its pin's): MEMORY.md, each active note and each
 *  active skill's files, by path, each body checked against its blob id. From the snapshot and its bodies when its
 *  main is `seed` (no exec); else one read-only exec of the script's `read` at that commit (git's tree and blobs).
 *  A skill whose folder holds a tracked link (git mode 120000) at the seed is left out whole and named in `refused`
 *  (always there, empty when nothing is). `null` (a run that learns from an empty folder, no main yet): nothing. `gone`
 *  when the folder has no such commit,
 *  `unavailable` when it cannot be read. */
export async function readSeed(lw: Workspace, seed: string | null): Promise<{ ok: true; files: { path: string; text: string }[]; refused: { skill: string; why: string }[] } | { ok: false; reason: "unavailable" | "gone"; detail: string }> {
  if (seed === null) return { ok: true, files: [], refused: [] };
  // An active skill whose folder holds a tracked link is left out whole, and named.
  const refusedOf = (snapshot: Snapshot) => snapshot.skills.filter((skill) => skill.status === "active" && skill.links?.length).map((skill) => ({ skill: skill.name, why: `a link at ${skill.links![0]}` }));
  const laid = (snapshot: Snapshot) => [
    ...(snapshot.index.bytes ? [{ path: INDEX_FILE, oid: snapshot.index.oid }] : []),
    ...snapshot.notes.filter((note) => note.status === "active").map((note) => ({ path: note.file, oid: note.oid })),
    ...snapshot.skills.filter((skill) => skill.status === "active" && !skill.links?.length).flatMap((skill) => skill.files.map(({ path, oid }) => ({ path, oid }))),
  ];
  try {
    const now = await readSnapshot(lw);
    if (now?.main === seed) {
      const files = await readLearning(lw, async ({ snapshot, body }) => {
        // The folder moved on as it was read: read at the seed below.
        if (snapshot?.main !== seed) return undefined;
        return Promise.all(laid(snapshot).map(async ({ path, oid }) => ({ path, text: await body(path, oid) })));
      }).catch((error: unknown) => {
        // A working tree whose bodies are not main's (a write in flight, or a hand edit): git's own read at the seed.
        if (error instanceof FolderBusy) return undefined;
        throw error;
      });
      if (files) return { ok: true, files: [...files, ...(now.index.bytes ? [] : [{ path: INDEX_FILE, text: "" }])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), refused: refusedOf(now) };
    }
    const at = await folderAt(lw, seed);
    if (!at) return { ok: false, reason: "gone", detail: `the learning folder has no commit ${seed}` };
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const files = laid(at.snapshot).map(({ path, oid }) => {
      const blob = at.blobs.get(oid);
      if (!blob) throw new Error(`the learning folder's read at ${seed} holds no blob for ${path}`);
      return { path, text: utf8.decode(blob) };
    });
    return { ok: true, files: [...files, ...(at.snapshot.index.bytes ? [] : [{ path: INDEX_FILE, text: "" }])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), refused: refusedOf(at.snapshot) };
  } catch (error) {
    return { ok: false, reason: "unavailable", detail: (error as Error)?.message ?? String(error) };
  }
}
