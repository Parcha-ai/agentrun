import { GitRemoteError } from "./errors.js";

export type Limits = {
  /** The largest file a commit may write, and checkout may copy, in bytes. */
  readonly maxFileBytes: number;
  /** The most paths one commit may write or delete. */
  readonly maxFiles: number;
  /** The most files a tree may hold for checkout to copy it; a larger tree is refused whole. */
  readonly maxTreeEntries: number;
};

export const DEFAULT_LIMITS: Limits = Object.freeze({ maxFileBytes: 1024 * 1024, maxFiles: 256, maxTreeEntries: 10_000 });

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

/** True when git, or a checkout of the tree on NTFS or HFS+, treats `segment` as `.git` (any case, Unicode characters
 *  HFS+ ignores, trailing dots or spaces, an NTFS stream suffix, the 8.3 short name), or when it reads as `.git` after
 *  compatibility normalization or case mapping (a fullwidth full stop, a dotless i). */
function isDotGit(segment: string): boolean {
  const bare = segment.replace(IGNORABLE, "");
  for (const form of [bare, bare.normalize("NFKC")]) {
    for (const cased of [form.toLowerCase(), form.toUpperCase().toLowerCase()]) {
      const name = cased.split(/[:/]/)[0]!.replace(/[. ]+$/, "");
      if (name === ".git" || /^git~\d+$/.test(name)) return true;
    }
  }
  return false;
}

/** Why `path` may not be written, read or checked out; undefined when it may. A path is relative, `/`-separated,
 *  canonical, free of control characters and backslashes, and has no `.git` segment in any spelling. */
export function pathRefusal(path: string): string | undefined {
  if (typeof path !== "string" || path === "") return "empty";
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return "too long";
  if (path.startsWith("/")) return "absolute";
  if (path.includes("\\")) return "a backslash";
  if (CONTROL.test(path)) return "a control character";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") return "not canonical";
    if (segment === "..") return "a .. segment";
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) return "a segment too long";
    if (isDotGit(segment)) return "a .git segment";
  }
  return undefined;
}

/** Why a tree entry of this mode may not be written or checked out; undefined for a regular file. */
export function modeRefusal(mode: string): string | undefined {
  if (mode === "100644" || mode === "100755") return undefined;
  if (mode === "120000") return "a symlink";
  if (mode === "160000") return "a submodule";
  if (mode === "040000") return "a directory";
  return `mode ${mode}`;
}

/** The key two paths share when a case-insensitive file system would make them one. */
export function foldPath(path: string): string {
  return path.replace(IGNORABLE, "").normalize("NFC").toLowerCase();
}

/** `a`, `a/b`, `a/b/c` for `a/b/c`. */
export function pathPrefixes(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Groups of paths (or directories) in `all` that differ only in case or Unicode form, limited to the groups that touch
 *  a path in `touched` when it is given. */
export function caseCollisions(all: Iterable<string>, touched?: Iterable<string>): string[][] {
  const spellings = new Map<string, Set<string>>();
  for (const path of all) {
    for (const prefix of pathPrefixes(path)) {
      const key = foldPath(prefix);
      let set = spellings.get(key);
      if (!set) spellings.set(key, (set = new Set()));
      set.add(prefix);
    }
  }
  const mine = touched ? new Set([...touched].flatMap(pathPrefixes)) : undefined;
  const groups: string[][] = [];
  for (const set of spellings.values()) {
    if (set.size < 2) continue;
    if (mine && ![...set].some((spelling) => mine.has(spelling))) continue;
    groups.push([...set].sort());
  }
  return groups;
}

export type FileContent = string | Uint8Array | null;

/** Refuses a commit's file set before anything is written: too many paths, a refused path, content that is not text or
 *  bytes, a file over the size cap, or a path that is both a file and a directory. */
export function checkCommitFiles(files: Readonly<Record<string, FileContent>>, limits: Limits): void {
  if (files === null || typeof files !== "object") throw new GitRemoteError("refused", "files must be an object of path to content");
  const paths = Object.keys(files);
  if (paths.length > limits.maxFiles) throw new GitRemoteError("refused", `a commit may write at most ${limits.maxFiles} paths, got ${paths.length}`);
  for (const path of paths) {
    const reason = pathRefusal(path);
    if (reason) throw new GitRemoteError("refused", `the path ${JSON.stringify(path)} is refused: ${reason}`, [path]);
    const content = files[path];
    if (content === null) continue;
    if (typeof content !== "string" && !(content instanceof Uint8Array)) throw new GitRemoteError("refused", `the content of ${JSON.stringify(path)} is not a string or bytes`, [path]);
    const size = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    if (size > limits.maxFileBytes) throw new GitRemoteError("refused", `${JSON.stringify(path)} is ${size} bytes, over the ${limits.maxFileBytes} byte cap`, [path]);
  }
  const set = new Set(paths);
  for (const path of paths) {
    const parents = pathPrefixes(path).slice(0, -1);
    const clash = parents.find((parent) => set.has(parent));
    if (clash) throw new GitRemoteError("refused", `${JSON.stringify(clash)} cannot be both a file and a directory`, [clash, path]);
  }
}
