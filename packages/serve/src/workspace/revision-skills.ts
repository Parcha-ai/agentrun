// A revision's skills laid in a run's folder, through the run's Workspace: what a run's harness reads its skills from.
import { relativeSegments } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Where a run's skills are, from its folder's root. */
export const RUN_SKILLS_DIR = ".agents/skills";

/** Lays `skills` (each skill file's path under `.agents/skills/` to its text) in the run's Workspace, fresh: what the
 *  folder held before goes, then each file is written at its path. Every path is checked first, by the Workspace's own
 *  rule: one that would leave `.agents/skills/` (absolute, "..", an empty segment, a backslash, or none) is ESCAPE, and
 *  nothing is written. A link on the way is ESCAPE too, and nothing is written through it. Safe to run again on a half
 *  laid folder. */
export async function layRevisionSkills(work: Workspace, skills: Readonly<Record<string, string>>): Promise<void> {
  const files = Object.entries(skills);
  for (const [path] of files) {
    if (relativeSegments(path).length === 0) throw new WorkspaceError("ESCAPE", `the skill path ${JSON.stringify(path)} names no file under ${RUN_SKILLS_DIR}/`, { path });
  }
  await work.remove(RUN_SKILLS_DIR, { recursive: true, force: true });
  await work.mkdir(RUN_SKILLS_DIR);
  for (const [path, text] of files) await work.write(`${RUN_SKILLS_DIR}/${path}`, text);
}
