// A revision's skills laid in a run's folder, through the run's Workspace, at each claim: what a run's harness reads its
// skills from. A run whose computer is a desktop or a phone gets that kind's skill beside them (kind-skills.ts). This
// is the one writer of the run's .agents/skills/: it only adds what is missing, so an earlier claim's folder and the
// run's own edits are never removed or written over.
import { kindSkillOf } from "./kind-skills.js";
import { relativeSegments } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Where a run's skills are, from its folder's root. */
export const RUN_SKILLS_DIR = ".agents/skills";

/** Lays the revision's own skills in the run's `.agents/skills/` at a claim, keeping what is there: each skill folder
 *  not there yet is written, one that is (laid at an earlier claim) is left as it is. Every path is checked first, by the Workspace's own rule: one that
 *  would leave `.agents/skills/` (absolute, "..", an empty segment, a backslash, or none) is ESCAPE, and nothing is
 *  written. A link on the way is ESCAPE too, and nothing is written through it.
 *
 *  `computer`: the run's computer kind. A desktop or a phone brings its kind's skill (desktop-computer, phone-computer),
 *  laid as `<name>/SKILL.md` beside the agent's own, unless one of the agent's skills has that name (the agent's stays,
 *  and the kind's is not laid), and only when that folder is not there yet.
 *
 *  Returns the skill files the run has beyond the revision's own: the kind's `<name>/SKILL.md` where the kind brings
 *  one (laid now or at an earlier claim), so the run's skill list (the prompt's, or a harness's own) names it as it
 *  names the revision's. */
export async function layOwnSkills(work: Workspace, skills: Readonly<Record<string, string>>, options: { readonly computer?: string } = {}): Promise<readonly string[]> {
  const files = Object.entries(skills);
  for (const [path] of files) {
    if (relativeSegments(path).length === 0) throw new WorkspaceError("ESCAPE", `the skill path ${JSON.stringify(path)} names no file under ${RUN_SKILLS_DIR}/`, { path });
  }
  const kind = kindSkillOf(options.computer);
  const own = new Set(files.map(([path]) => relativeSegments(path)[0]));
  const laysKind = kind !== undefined && !own.has(kind.name);
  const brought = laysKind ? [`${kind.name}/SKILL.md`] : [];
  if (laysKind) files.push([brought[0]!, kind.text]);
  if (!files.length) return brought;
  try {
    // What is there is asked with stat, which answers a fresh folder's missing .agents/skills/ with undefined: no error
    // is read as "not there", so no check of an error's class decides it (a run's own process gets its errors over its
    // channel, where beta.50 lost WorkspaceError's class and failed every new run that had a skill).
    const there = (await work.stat(RUN_SKILLS_DIR)) === undefined ? new Set<string>() : new Set((await work.list(RUN_SKILLS_DIR)).map((entry) => entry.name));
    const missing = files.filter(([path]) => !there.has(relativeSegments(path)[0]!));
    if (!missing.length) return brought;
    await work.mkdir(RUN_SKILLS_DIR);
    for (const [path, text] of missing) await work.write(`${RUN_SKILLS_DIR}/${path}`, text);
  } catch (error) {
    throw laidFailed(error);
  }
  return brought;
}

/** A lay's failure, saying it was the lay of the run's skills: a WorkspaceError keeps its code, its path and its words
 *  (the backend's, an Archil key and Archil's own included) after that. */
function laidFailed(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || error.name !== "WorkspaceError" || typeof code !== "string") return error;
  const path = (error as { path?: unknown }).path;
  return new WorkspaceError(code as WorkspaceError["code"], `laying the run's skills in ${RUN_SKILLS_DIR}/: ${error.message}`, { ...(typeof path === "string" ? { path } : {}), cause: error });
}
