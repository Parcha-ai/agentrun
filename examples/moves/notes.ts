// The root conversation's own file tools: read and write under the run's `work/` directory, and nothing else. They are not
// commands (no process is started) and they are not pi's `read`/`write`, which run through the Harness's environment: these
// check a path against `work/` themselves, so the instance's environment, /proc and every path outside `work/` are out of reach.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_BYTES = 256 * 1024;

export class NoteError extends Error {}

/** The absolute path of `name` under `work`, or a NoteError: a relative path of plain names, no link anywhere on it, inside `work`. */
export function notePath(work: string, name: string): string {
  if (typeof name !== "string" || name === "" || isAbsolute(name) || name.includes("\0")) throw new NoteError(`${JSON.stringify(name)} is not a path inside the workspace`);
  const base = realpathSync(work);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new NoteError(`${name} is outside the workspace`);
  // Every existing part of the path is a real file or directory: a link could lead out of `work/`.
  let at = base;
  for (const part of rel.split("/")) {
    at = join(at, part);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) throw new NoteError(`${name} goes through a link`);
  }
  return target;
}

export function writeNote(work: string, name: string, content: string): string {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new NoteError(`${name} is larger than ${MAX_BYTES} bytes`);
  const target = notePath(work, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

export function readNote(work: string, name: string): string {
  const target = notePath(work, name);
  try {
    const text = readFileSync(target, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new NoteError(`${name} is larger than ${MAX_BYTES} bytes`);
    return text;
  } catch (error) {
    if (error instanceof NoteError) throw error;
    throw new NoteError(`${name} cannot be read`);
  }
}
