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

/** The most skill files read at once, so a run with many skill files stays under a low open-file limit. */
export const READS_AT_ONCE = 16;

/** `path` under the run's skills directory, as the workspace reads it. */
const skillPath = (path: string) => [".agents", "skills", path].join("/");

/** Each of `paths` under the run's skills directory as text, in order, READS_AT_ONCE at a time. Through no link
 *  (workspace.ts): a skill directory or file linked out of the workspace is refused, and the read fails. */
async function readSkillFiles(work: string, paths: readonly string[]): Promise<string[]> {
  const texts: string[] = [];
  for (let at = 0; at < paths.length; at += READS_AT_ONCE) {
    texts.push(...(await Promise.all(paths.slice(at, at + READS_AT_ONCE).map((path) => readWorkText(work, skillPath(path))))));
  }
  return texts;
}

/** The instructions, then each skill's SKILL.md, by name. */
function promptWith(instructions: string, skills: readonly { name: string; files: Readonly<Record<string, string>> }[]): string {
  const blocks = skills.map(({ name, files }) => `<skill name="${name}">\n${(files["SKILL.md"] ?? "").trim()}\n</skill>`);
  return [instructions.trim(), ...(blocks.length ? ["Your skills follow. Use the one that fits the step you are on.", ...blocks] : [])].join("\n\n");
}

/** The revision's instructions, then each skill's `<name>/SKILL.md` from the run's workspace, by name. */
export async function promptOf(instructions: string, skillFiles: Iterable<string>, work: string): Promise<string> {
  const names = skillNames(skillFiles);
  const texts = await readSkillFiles(work, names.map((name) => `${name}/SKILL.md`));
  return promptWith(instructions, names.map((name, i) => ({ name, files: { "SKILL.md": texts[i]! } })));
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
  const texts = await readSkillFiles(work, owned.map(({ path }) => path));
  const entries = new Map(names.map((name) => [name, [] as [string, string][]]));
  owned.forEach(({ name, path }, i) => entries.get(name)!.push([path.slice(name.length + 1), texts[i]!]));
  // Each file an own property of a plain object: assigned, a file named __proto__ would set the prototype instead.
  return names.map((name) => ({ name, files: Object.fromEntries(entries.get(name)!) }));
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
