// A revision's skills laid in a run's folder, through the run's Workspace, at each claim: what a run's harness reads its
// skills from. A run whose computer is a desktop or a phone gets that kind's skill beside them (kind-skills.ts). This
// is the one writer of the run's .agents/skills/: it only adds what is missing, so a learned skill, an earlier claim's
// folder and the run's own edits are never removed or written over.
import { kindSkillOf } from "./kind-skills.js";
import { relativeSegments } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Where a run's skills are, from its folder's root. */
export const RUN_SKILLS_DIR = ".agents/skills";

/** Lays the revision's own skills in the run's `.agents/skills/` at a claim, keeping what is there: each skill folder
 *  not there yet is written, one that is (laid at an earlier claim, or a learned skill laid at the run's start under a
 *  name no revision skill takes) is left as it is. Every path is checked first, by the Workspace's own rule: one that
 *  would leave `.agents/skills/` (absolute, "..", an empty segment, a backslash, or none) is ESCAPE, and nothing is
 *  written. A link on the way is ESCAPE too, and nothing is written through it.
 *
 *  `computer`: the run's computer kind. A desktop or a phone brings its kind's skill (desktop-computer, phone-computer),
 *  laid as `<name>/SKILL.md` beside the agent's own, unless one of the agent's skills has that name (the agent's stays,
 *  and the kind's is not laid), and only when that folder is not there yet. */
export async function layOwnSkills(work: Workspace, skills: Readonly<Record<string, string>>, options: { readonly computer?: string } = {}): Promise<void> {
  const files = Object.entries(skills);
  for (const [path] of files) {
    if (relativeSegments(path).length === 0) throw new WorkspaceError("ESCAPE", `the skill path ${JSON.stringify(path)} names no file under ${RUN_SKILLS_DIR}/`, { path });
  }
  const kind = kindSkillOf(options.computer);
  const own = new Set(files.map(([path]) => relativeSegments(path)[0]));
  if (kind && !own.has(kind.name)) files.push([`${kind.name}/SKILL.md`, kind.text]);
  if (!files.length) return;
  const there = await work.list(RUN_SKILLS_DIR).then((entries) => new Set(entries.map((entry) => entry.name)), (error: unknown) => {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return new Set<string>();
    throw error;
  });
  const missing = files.filter(([path]) => !there.has(relativeSegments(path)[0]!));
  if (!missing.length) return;
  await work.mkdir(RUN_SKILLS_DIR);
  for (const [path, text] of missing) await work.write(`${RUN_SKILLS_DIR}/${path}`, text);
}
