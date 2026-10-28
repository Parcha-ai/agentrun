// A skill's own files, read by the model through a host tool. Written for AgentRun.
//
// A host that gives a harness skills writes each skill's files under one root (`<root>/<skill>/<path>`). The model reads
// what SKILL.md points it at through `read_skill_file`, a read-only host tool, and nothing else of the disk: the skill
// and its directory come from the host's own list, never from the request; the path must be one of that skill's listed
// files, exactly, and is refused before any filesystem call when it is absolute or climbs (`..`); no link is followed
// anywhere in it (each part is checked, the file is opened without following one, and the opened file is checked to
// be the expected one after the open, so a link swapped in between is caught).
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HostTool } from "./types.js";

/** A skill, as the tool knows it: its name, and the paths of its files. */
export interface SkillFileList {
  name: string;
  files: readonly string[];
}

/** The tool's name, as the model calls it. */
export const READ_SKILL_FILE = "read_skill_file";
const MAX_BYTES = 1024 * 1024;

/** Why `path` of `skill` is not readable, or undefined: the checks made before any filesystem call. */
function refusedBeforeDisk(skills: ReadonlyMap<string, ReadonlySet<string>>, skill: unknown, path: unknown): string | undefined {
  if (typeof skill !== "string" || typeof path !== "string") return "give a skill's name and a file's path, both as text";
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) return `the path ${JSON.stringify(path.slice(0, 120))} is absolute or climbs (..): give a path inside the skill, as its SKILL.md names it`;
  const files = skills.get(skill);
  if (!files) return `${JSON.stringify(skill.slice(0, 80))} is not one of your skills`;
  if (!files.has(path)) return `${JSON.stringify(path.slice(0, 120))} is not one of the skill ${skill}'s files`;
  return undefined;
}

/** The file's text, read without following a link anywhere in its path; throws a reason a model can read. */
function readNoFollow(root: string, skill: string, path: string): string {
  // The root is resolved (its own path may pass through a link, as /tmp does on some machines); the skill's directory under
  // it is not: a link there would make its target the trusted base.
  const dir = join(realpathSync(root), skill);
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`the skill ${skill}'s directory is a link, which is not followed`);
  let at = dir;
  for (const part of path.split("/")) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink()) throw new Error(`the skill ${skill}'s ${path} goes through a link, which is not followed`);
  }
  const fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // After the open: the file opened is the one checked, not a link swapped in between.
    if (process.platform === "linux") {
      if (readlinkSync(`/proc/self/fd/${fd}`) !== at) throw new Error(`the skill ${skill}'s ${path} is not the file it was`);
    } else {
      const opened = fstatSync(fd);
      const expected = lstatSync(at);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error(`the skill ${skill}'s ${path} is not the file it was`);
    }
    if (!fstatSync(fd).isFile()) throw new Error(`the skill ${skill}'s ${path} is not a file`);
    if (fstatSync(fd).size > MAX_BYTES) throw new Error(`the skill ${skill}'s ${path} is larger than ${MAX_BYTES} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** The host tool that reads the skills' files under `root` (`<root>/<skill>/<path>`): replay-safe, read-only. */
export function readSkillFileTool(root: string, skills: readonly SkillFileList[]): HostTool {
  const known = new Map(skills.map((skill) => [skill.name, new Set(skill.files)] as const));
  return {
    name: READ_SKILL_FILE,
    description: "Read a file of one of your skills: the skill's name and the file's path inside it, as its SKILL.md names it.",
    inputSchema: { type: "object", properties: { skill: { type: "string", enum: [...known.keys()] }, path: { type: "string" } }, required: ["skill", "path"], additionalProperties: false },
    replay: "safe",
    async call(args) {
      const { skill, path } = (args ?? {}) as { skill?: unknown; path?: unknown };
      const refused = refusedBeforeDisk(known, skill, path);
      if (refused) return { text: `Not read: ${refused}.`, isError: true };
      try {
        return { text: readNoFollow(root, skill as string, path as string) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return { text: `Not read: ${code === "ELOOP" ? `the skill ${String(skill)}'s ${String(path)} is a link, which is not followed` : (error as Error).message}.`, isError: true };
      }
    },
  };
}
