// A learning run's seed laid in its work at the claim, the one read of its learning folder both spec builders make
// (adapter-run-spec.ts for pi, cli-run-spec.ts for the CLI harnesses), as main's start laid it (learning.ts pinSeed),
// minus the pin: the seed the run's learning start pinned, read once (seedFrom over the folder's read); its index and
// active notes into `.learning/`, made fresh and cut of the server's secrets (layLearned); then its learned skills the run
// gets beside the revision's own (chooseSkills) into `.agents/skills/` (laySkills); and the learned workflows its
// learned_workflow tool runs (chooseWorkflows), handed back to the spec, never written. Mode 1 and Mode 2 alike, through
// the run's Workspace and the agent's learning folder where the run's place keeps them. A learning fault never fails a
// run: a seed that cannot be read, or a lay that fails part way, leaves nothing laid (what was laid is taken back), says
// so in one line, and the claim goes on; the notes still reach the run through its # Learned section.
import type { LearningFolder } from "../learn/folder.js";
import { chooseSkills, chooseWorkflows, type LearnedWorkflow, layLearned, LEARNED_DIR, laySkills, readerOf, seedFrom, type Seed, type Shown, takeSkills } from "../learning.js";
import type { Workspace } from "../workspace/index.js";

export interface LearningSeedLay {
  /** The run's Workspace: its work, where `.learning/` and `.agents/skills/` are. */
  readonly work: Workspace;
  /** The commit the run's learning start pinned (null: the folder had no main yet, an empty seed). */
  readonly seed: string | null;
  /** The agent's learning folder where the run's place keeps it, opened for this one read and ended after it. */
  readonly folder: () => LearningFolder;
  /** The revision's own skill files, by their paths under `.agents/skills/` (laid already): a learned skill named like
   *  one of them is the revision's and is not laid. */
  readonly own: readonly string[];
  /** The server's secrets as a reader cuts them, read at the claim. */
  readonly shown: () => Promise<Shown>;
  /** One line of the run's log. */
  readonly log: (line: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the claim laid of the run's seed: the seed it read, the learned skills' files it laid, by their paths under
 *  `.agents/skills/`, for the skill list the run's harness is handed beside the revision's own, and the learned workflows
 *  the run's learned_workflow tool runs, cut of the server's secrets as the skills are (none of either when the lay
 *  failed part way and was taken back). */
export type LaidSeed = { readonly seed: Seed; readonly skills: readonly string[]; readonly workflows: readonly LearnedWorkflow[] };

/** What a claim laid of a run's learning seed, by name, as the adapter loop records it (KINDS.learningLaid): each learned
 *  skill whose files it laid, and each learned workflow it handed the tool; none when nothing was laid. */
export const laidOf = (laid: LaidSeed | undefined): { skills: string[]; workflows: string[] } => ({
  skills: [...new Set((laid?.skills ?? []).map((path) => path.split("/")[0]!))],
  workflows: (laid?.workflows ?? []).map(({ name }) => name),
});

/** Lays the run's learning seed (see the file's head). Undefined when the seed could not be read: nothing was laid.
 *  Never throws. */
export async function layLearningSeed(lay: LearningSeedLay): Promise<LaidSeed | undefined> {
  let seed: Seed;
  const folder = lay.folder();
  try {
    seed = await seedFrom(lay.seed, readerOf(folder.workspace), { warn: lay.log });
  } catch (error) {
    lay.log(`the run starts with nothing learned laid in its work: ${message(error)}`);
    return undefined;
  } finally {
    await folder.end().catch(() => undefined);
  }
  const made: string[] = [];
  try {
    const shown = await lay.shown();
    await layLearned(lay.work, seed, shown);
    const { taken, left } = await chooseSkills(lay.work, seed, lay.own, shown);
    await laySkills(lay.work, taken, made);
    for (const path of seed.skipped) lay.log(`its learning folder's ${path} was not read`);
    for (const name of left) lay.log(`starts without the skill ${name} its agent learned: it is over what is left of the learned skills' budget, or holds a secret`);
    const workflows = chooseWorkflows(seed, shown);
    for (const name of workflows.left) lay.log(`starts without the learned workflow ${name} its agent learned: it is over what is left of the learned workflows' budget, or holds a secret`);
    return { seed, skills: taken.flatMap(({ name, files = {} }) => Object.keys(files).sort().map((path) => `${name}/${path}`)), workflows: workflows.flows };
  } catch (error) {
    // Nothing half laid: the notes' copy and every learned skill laid so far go, as pinSeed takes them back. The seed was
    // read all the same, and is answered with no skills and no learned workflows.
    await lay.work.remove(LEARNED_DIR, { recursive: true, force: true }).catch(() => undefined);
    await takeSkills(lay.work, made).catch(() => undefined);
    lay.log(`the run starts with nothing learned laid in its work: ${message(error)}`);
    return { seed, skills: [], workflows: [] };
  }
}
