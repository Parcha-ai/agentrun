// A revision's skills as a run's harness gets them. pi and codex get every skill's SKILL.md inlined in the system prompt.
// claude-agent loads skills itself (its Skill tool, from a local plugin the adapter writes): it gets each skill whole, every
// file of it, and the prompt keeps only the skills its adapter would refuse. The adapter's own check (its exported
// skillProblems) says which: serve takes any <name>/SKILL.md, the adapter only a lowercase name, a SKILL.md whose front
// matter names the skill and describes it, plain file paths, and 1 MiB in all.
import { skillNames } from "./validate.js";
import { readWorkText } from "./workspace.js";

/** A skill: its name (its directory under `.agents/skills/`), and each of its files' text by its path inside that
 *  directory (`SKILL.md`, `reference/sources.md`). */
export type SkillFiles = { name: string; files: Record<string, string> };

/** A harness's check of the skills it would load: why it refuses them, or none. */
export type SkillCheck = (skills: readonly SkillFiles[]) => string[];

/** `path` under the run's skills directory, as the workspace reads it. */
const skillPath = (path: string) => [".agents", "skills", path].join("/");

/** The instructions, then each skill's SKILL.md, by name. */
function promptWith(instructions: string, skills: readonly { name: string; files: Readonly<Record<string, string>> }[]): string {
  const blocks = skills.map(({ name, files }) => `<skill name="${name}">\n${(files["SKILL.md"] ?? "").trim()}\n</skill>`);
  return [instructions.trim(), ...(blocks.length ? ["Your skills follow. Use the one that fits the step you are on.", ...blocks] : [])].join("\n\n");
}

/** The revision's instructions, then each skill's `<name>/SKILL.md` from the run's workspace, by name. */
export async function promptOf(instructions: string, skillFiles: Iterable<string>, work: string): Promise<string> {
  // Through no link (workspace.ts): a skill directory, or its SKILL.md, linked out of the workspace is refused.
  const skills = await Promise.all(skillNames(skillFiles).map(async (name) => ({ name, files: { "SKILL.md": await readWorkText(work, skillPath(`${name}/SKILL.md`)) } })));
  return promptWith(instructions, skills);
}

/**
 * The revision's skills, by name, each with its files' text from the run's workspace (`work`). A file goes to the nearest
 * skill above it (`team/review/checklist.md` to `team/review` when there is a `team/review/SKILL.md`, else to `team`); a
 * file under no skill is no skill's. Only the revision's own files are read, through no link (workspace.ts): a refused
 * read fails, as promptOf's does.
 */
export async function skillsOf(skillFiles: Iterable<string>, work: string): Promise<SkillFiles[]> {
  const paths = [...skillFiles].sort();
  const names = skillNames(paths);
  // The deepest first, so the first a path is under is the nearest.
  const deepest = [...names].sort((a, b) => b.length - a.length);
  const owned = paths.flatMap((path) => {
    const name = deepest.find((skill) => path.startsWith(`${skill}/`));
    return name === undefined ? [] : [{ name, path }];
  });
  const texts = await Promise.all(owned.map(({ path }) => readWorkText(work, skillPath(path))));
  const skills = new Map(names.map((name) => [name, {} as Record<string, string>]));
  owned.forEach(({ name, path }, i) => (skills.get(name)![path.slice(name.length + 1)] = texts[i]!));
  return names.map((name) => ({ name, files: skills.get(name)! }));
}

/** The skills a harness loads itself (`native`) and the ones that stay in the prompt (`inlined`), by its own check: each
 *  skill on its own, then the ones it takes as a set (the set has a size cap). A set it refuses is inlined whole. */
export function splitSkills(skills: readonly SkillFiles[], check: SkillCheck): { native: SkillFiles[]; inlined: SkillFiles[] } {
  const native = skills.filter((skill) => check([skill]).length === 0);
  if (native.length && check(native).length) return { native: [], inlined: [...skills] };
  return { native, inlined: skills.filter((skill) => !native.includes(skill)) };
}

/** A run's system prompt, and the skills its harness loads itself. With the harness's `check`, the skills it takes are
 *  its own and leave the prompt; with none, every skill's SKILL.md is in the prompt (promptOf). */
export async function systemOf(instructions: string, skillFiles: Iterable<string>, work: string, check?: SkillCheck): Promise<{ system: string; native: SkillFiles[] }> {
  if (!check) return { system: await promptOf(instructions, skillFiles, work), native: [] };
  const { native, inlined } = splitSkills(await skillsOf(skillFiles, work), check);
  return { system: promptWith(instructions, inlined), native };
}
