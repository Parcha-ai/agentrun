import { GitRemoteError } from "./errors.js";

const MAX_PATTERN_BYTES = 512;

export type Allowlist = {
  /** True when `path` (relative, `/`-separated) is named by a pattern. */
  readonly matches: (path: string) => boolean;
  /** True when some path below the directory `dir` could be named: a directory that cannot be need not be read. */
  readonly mayContain: (dir: string) => boolean;
};

/** `*` and `?` inside one segment, matched without backtracking blow-up: the classic last-star retry. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function checkPattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern === "") throw new GitRemoteError("refused", "an allowlist pattern must be a non-empty string");
  const shown = JSON.stringify(pattern);
  if (Buffer.byteLength(pattern, "utf8") > MAX_PATTERN_BYTES) throw new GitRemoteError("refused", `the allowlist pattern ${shown} is too long`);
  if (/[\u0000-\u001f\u007f\\[\]{}]/.test(pattern)) throw new GitRemoteError("refused", `the allowlist pattern ${shown} uses a character this matcher does not read: only * ? and ** are special`);
  if (pattern.startsWith("!")) throw new GitRemoteError("refused", `the allowlist pattern ${shown} negates: an allowlist only names paths`);
  if (pattern.startsWith("/")) throw new GitRemoteError("refused", `the allowlist pattern ${shown} is absolute: it is relative to the repository root`);
  for (const segment of pattern.split("/")) {
    if (segment === "") throw new GitRemoteError("refused", `the allowlist pattern ${shown} has an empty segment (a trailing slash names no file: use dir/**)`);
    if (segment === "." || segment === "..") throw new GitRemoteError("refused", `the allowlist pattern ${shown} has a ${segment} segment`);
    if (segment.includes("**") && segment !== "**") throw new GitRemoteError("refused", `the allowlist pattern ${shown} uses ** inside a segment: ** must be a whole segment`);
  }
  return pattern;
}

/**
 * A set of globs over git paths: `*` is any run of characters inside one segment, `?` one character, `**` a whole
 * segment standing for any number of segments. Dotfiles are matched like any file, and case counts. Nothing else is
 * special, and a pattern that tries (a bracket, a brace, a leading `!`) is refused rather than read as literal text.
 */
export function compileAllowlist(patterns: readonly string[]): Allowlist {
  if (!Array.isArray(patterns) || patterns.length === 0) throw new GitRemoteError("refused", "the allowlist is empty: name the paths that may be committed");
  const compiled = patterns.map((pattern) => checkPattern(pattern).split("/"));

  const walk = (pattern: readonly string[], parts: readonly string[], below: boolean): boolean => {
    const memo = new Map<number, boolean>();
    const at = (pi: number, si: number): boolean => {
      const key = pi * (parts.length + 1) + si;
      const known = memo.get(key);
      if (known !== undefined) return known;
      let result: boolean;
      if (si === parts.length) {
        // For "below", the directory itself is consumed and one more segment must still be nameable.
        result = below ? pi < pattern.length : pattern.slice(pi).every((s) => s === "**");
      } else if (pi === pattern.length) {
        result = false;
      } else if (pattern[pi] === "**") {
        result = at(pi + 1, si) || at(pi, si + 1);
      } else {
        result = matchSegment(pattern[pi]!, parts[si]!) && at(pi + 1, si + 1);
      }
      memo.set(key, result);
      return result;
    };
    return at(0, 0);
  };

  return Object.freeze({
    matches: (path: string) => compiled.some((pattern) => walk(pattern, path.split("/"), false)),
    mayContain: (dir: string) => compiled.some((pattern) => walk(pattern, dir === "" ? [] : dir.split("/"), true)),
  });
}
