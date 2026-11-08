// The proposal check for the runner's reflect hook (COMMIT-API.md, tl-jobs' createReflectHook `check` dep): a run's
// proposed changes checked (check.ts checkProposal) against the seed it started from, read from the learning folder
// through its Workspace: the snapshot when its main is the run's seed (no exec), else one read-only exec of the
// learning script at that commit.
import { type Base, type Change, checkProposal, type Problem } from "./check.js";
import { type DraftReader } from "./skills.js";
import { readSnapshot, type Snapshot, snapshotAt, snapshotNotes, topOf } from "./folder.js";
import type { Workspace } from "../workspace/index.js";

/** What the seed holds as the checker reads it: every path at its top and in its learned folders, and its active notes.
 *  `kept`: the skills' and drafts' files whose text there has a status (a person's call), which a run never changes. */
function baseOf(snapshot: Snapshot): { base: Base; kept: string[] } {
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
