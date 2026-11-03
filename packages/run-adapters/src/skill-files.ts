// A host's skills, as every adapter that takes them checks them (`skillProblems`), and a skill's own files, read by the
// model through a host tool. Written for AgentRun.
//
// A host that gives a harness skills writes each skill's files under one root (`<root>/<skill>/<path>`). The model reads
// what SKILL.md points it at through `read_skill_file`, a read-only host tool, and nothing else of the disk: the skill
// and its directory come from the host's own list, never from the request; the path must be one of that skill's listed
// files, exactly, and is refused before any filesystem call when it is absolute or climbs (`..`); no link is followed
// anywhere in it (each part is checked, the file is opened without following one, and the opened file is checked to
// be the expected one after the open, so a link swapped in between is caught).
//
// A file is read in parts, as pi's read reads one: from `offset` (a line number, from 1), at most `limit` lines, and at
// most SKILL_READ_MAX_LINES lines or SKILL_READ_MAX_BYTES of UTF-8, whichever comes first; a part that stops short of the
// file's end says which lines of how many it holds and the offset that reads on, so a result stays under the host's
// bound (HOST_RESULT_MAX_CHARS). A file read whole is its exact text.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HostTool } from "./types.js";

/** A skill a host gives a harness, which the model may load: its name, and its files by path, `SKILL.md` among them. */
export interface HostSkill {
  /** Lowercase letters, digits and dashes; `SKILL.md`'s front matter names it the same. */
  name: string;
  /** Each file's text by its path inside the skill (`SKILL.md`, `reference/sources.md`). */
  files: Readonly<Record<string, string>>;
}

/** A skill, as the tool knows it: its name, and the paths of its files. */
export interface SkillFileList {
  name: string;
  files: readonly string[];
}

/** The tool's name, as the model calls it. */
export const READ_SKILL_FILE = "read_skill_file";
/** The most of a file one read holds, as pi's read holds it: lines, and bytes of UTF-8. */
export const SKILL_READ_MAX_LINES = 2000;
export const SKILL_READ_MAX_BYTES = 50 * 1024;
const MAX_BYTES = 1024 * 1024;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,4}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const SKILL_BYTES = 1024 * 1024;

/** The skills, checked, as every adapter that takes a host's skills checks them when it is made: each a name, a
 *  `SKILL.md` whose front matter has that name and a description, and files at plain relative paths, 1 MiB in all; or the
 *  problems. What one harness would refuse or rename (the Claude Agent CLI, Codex) is refused here for all of them. */
export function skillProblems(skills: readonly HostSkill[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const skill of skills) {
    const name = String(skill?.name ?? "");
    if (!SKILL_NAME.test(name)) { problems.push(`the skill name ${JSON.stringify(name.slice(0, 80))} is not lowercase letters, digits and dashes`); continue; }
    if (seen.has(name)) problems.push(`the skill ${name} is given twice`);
    seen.add(name);
    const files = skill.files ?? {};
    const md = files["SKILL.md"];
    const front = typeof md === "string" ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)?.[1] : undefined;
    if (front === undefined) problems.push(`the skill ${name} has no SKILL.md with front matter`);
    else {
      if (!new RegExp(`^name:\\s*(['"]?)${name}\\1\\s*$`, "m").test(front)) problems.push(`the skill ${name}'s SKILL.md names it otherwise`);
      if (!/^description:\s*\S/m.test(front)) problems.push(`the skill ${name}'s SKILL.md has no description`);
    }
    // A path that is another's folder (reference, and reference/sources.md) can't be written as both.
    const paths = new Set(Object.keys(files));
    for (const folder of new Set([...paths].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))) {
      if (paths.has(folder)) problems.push(`the skill ${name}'s ${folder} is both a file and a folder`);
    }
    for (const [path, text] of Object.entries(files)) {
      if (!SKILL_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) problems.push(`the skill ${name}'s file ${JSON.stringify(path.slice(0, 80))} is not a plain relative path`);
      if (typeof text !== "string") problems.push(`the skill ${name}'s file ${path} is not text`);
      else bytes += Buffer.byteLength(text);
    }
  }
  if (bytes > SKILL_BYTES) problems.push(`the skills hold ${bytes} bytes, more than ${SKILL_BYTES}`);
  return problems;
}

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

/** A size in KB as pi's read says one (`58.6KB`, `50KB`). */
const kb = (bytes: number) => `${Number((bytes / 1024).toFixed(1))}KB`;

/** The part of `text` (a file's) a read from line `offset` (from 1) of at most `limit` lines holds, with the note that
 *  says where it stops when it stops short of the file's end; or why it holds nothing. */
export function skillFilePart(text: string, offset = 1, limit?: number): { text: string } | { refused: string } {
  const lines = text.split("\n");
  // A trailing newline ends the last line; it starts no line of its own.
  const ended = text.endsWith("\n");
  if (ended) lines.pop();
  if (offset > Math.max(1, lines.length)) return { refused: `offset ${offset} is past the end of the file (${lines.length} lines)` };
  const start = offset - 1;
  const end = Math.min(lines.length, start + (limit ?? Infinity), start + SKILL_READ_MAX_LINES);
  const first = lines[start] ?? "";
  if (Buffer.byteLength(first, "utf8") > SKILL_READ_MAX_BYTES) {
    // One line past the bytes one read holds: its first bytes, cut at a character's end.
    const head = Buffer.from(first, "utf8").subarray(0, SKILL_READ_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "");
    const next = offset < lines.length ? ` Use offset=${offset + 1} to read on.` : "";
    return { text: `${head}\n\n[Line ${offset} is ${kb(Buffer.byteLength(first, "utf8"))}, past the ${kb(SKILL_READ_MAX_BYTES)} one read holds: showing its first ${kb(SKILL_READ_MAX_BYTES)}. The rest of the line cannot be read with this tool.${next}]` };
  }
  let stop = start;
  for (let bytes = 0; stop < end; stop++) {
    const more = Buffer.byteLength(lines[stop]!, "utf8") + (stop > start ? 1 : 0);
    if (bytes + more > SKILL_READ_MAX_BYTES) break;
    bytes += more;
  }
  const held = lines.slice(start, stop).join("\n");
  if (stop === lines.length) return { text: start === 0 ? text : `${held}${ended ? "\n" : ""}` };
  const byBytes = stop < end;
  const cut = stop < start + (limit ?? Infinity) || byBytes;
  const note = cut ? `Showing lines ${offset}-${stop} of ${lines.length}${byBytes ? ` (${kb(SKILL_READ_MAX_BYTES)} limit)` : ""}. Use offset=${stop + 1} to continue.` : `${lines.length - stop} more lines in the file. Use offset=${stop + 1} to continue.`;
  return { text: `${held}\n\n[${note}]` };
}

/** The host tool that reads the skills' files under `root` (`<root>/<skill>/<path>`), a part at a time: replay-safe,
 *  read-only. */
export function readSkillFileTool(root: string, skills: readonly SkillFileList[]): HostTool {
  const known = new Map(skills.map((skill) => [skill.name, new Set(skill.files)] as const));
  return {
    name: READ_SKILL_FILE,
    description: `Read a file of one of your skills: the skill's name and the file's path inside it, as its SKILL.md names it. A read holds at most ${SKILL_READ_MAX_LINES} lines or ${SKILL_READ_MAX_BYTES / 1024}KB, whichever comes first, and says where it stops; read on with offset (a line number, from 1), or fewer lines with limit.`,
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", enum: [...known.keys()] },
        path: { type: "string" },
        offset: { type: "integer", minimum: 1, description: "The line to start at, from 1 (default 1)." },
        limit: { type: "integer", minimum: 1, description: "The most lines to read." },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
    replay: "safe",
    async call(args) {
      const { skill, path, offset, limit } = (args ?? {}) as { skill?: unknown; path?: unknown; offset?: unknown; limit?: unknown };
      const refused = refusedBeforeDisk(known, skill, path);
      if (refused) return { text: `Not read: ${refused}.`, isError: true };
      if (offset !== undefined && !(Number.isInteger(offset) && (offset as number) >= 1)) return { text: "Not read: offset is a line number, 1 or more.", isError: true };
      if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1)) return { text: "Not read: limit is a number of lines, 1 or more.", isError: true };
      try {
        const part = skillFilePart(readNoFollow(root, skill as string, path as string), (offset as number | undefined) ?? 1, limit as number | undefined);
        return "refused" in part ? { text: `Not read: ${part.refused.replace("the file", `the skill ${skill as string}'s ${path as string}`)}.`, isError: true } : part;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return { text: `Not read: ${code === "ELOOP" ? `the skill ${String(skill)}'s ${String(path)} is a link, which is not followed` : (error as Error).message}.`, isError: true };
      }
    },
  };
}
