// A reason a miss gives names a file by what the caller called it. An error from the file system, a program or a model
// route carries the absolute path the host ran in, and a miss is read by the model, filed, told to the host and
// recorded; none of them may hold a machine's directories. An absolute path in a line is cut to its last part. A path
// is found the way a link is: a token that starts where a word, a quote or a bracket opens and parses as absolute, never
// a match on what the words mean. Internal: not exported from the package.

/** What may stand just before a path: a line's start, a space, a quote, an opening bracket, `=`, `,` or `;`. A `:` may not
 *  (it stands before the slashes of a link), nor may a letter (`and/or`, `3/4`, `offset/limit`). */
const BEFORE = " \t\r\n'\"`([{<=,;";
const QUOTES = "'\"`";
/** What ends an unquoted path: a space or a closing quote or bracket, or a comma or semicolon. */
const AFTER = " \t\r\n'\"`)]}>,;";
/** Punctuation that closes a sentence, not a name. */
const TRAIL = ".:!?";

const isDrive = (line: string, at: number) => /^[A-Za-z]:[\\/]/.test(line.slice(at, at + 3));
const isFileUrl = (line: string, at: number) => line.slice(at, at + 7).toLowerCase() === "file://";
const isSlash = (line: string, at: number) => line[at] === "/" && at + 1 < line.length && !/[\s/]/.test(line[at + 1]!);

const startsPath = (line: string, at: number) => (at === 0 || BEFORE.includes(line[at - 1]!)) && (isSlash(line, at) || isDrive(line, at) || isFileUrl(line, at));

/** Where the quote that opened the path at `at` closes: the first like quote that a word does not go on from, so an
 *  apostrophe inside a directory's name (`owner's-private`) does not end the path. -1 when none does. */
function closerOf(line: string, at: number, opener: string): number {
  for (let i = line.indexOf(opener, at); i >= 0; i = line.indexOf(opener, i + 1)) if (!/[A-Za-z0-9_]/.test(line[i + 1] ?? " ")) return i;
  return -1;
}

/** Where the path that starts at `at` ends: at the quote that opened it, else at the first space or closer. */
function endOf(line: string, at: number): number {
  const opener = at > 0 && QUOTES.includes(line[at - 1]!) ? line[at - 1]! : undefined;
  const closer = opener === undefined ? -1 : closerOf(line, at, opener);
  let end = closer >= 0 ? closer : line.length;
  if (closer < 0) for (let i = at; i < line.length; i++) if (AFTER.includes(line[i]!)) { end = i; break; }
  while (closer < 0 && end > at + 1 && TRAIL.includes(line[end - 1]!)) end--;
  return end;
}

/** The last part of a path, whichever way it separates its parts; nothing when it has none. */
const tail = (path: string) => path.replace(/^file:\/\/[^/]*/i, "").split(/[\\/]/).filter(Boolean).pop() ?? "";

/** The message with the exact paths an error names (its `path` and `dest`) cut to their last part, whatever characters
 *  the directories have; the rest of what `pathSafe` finds is found by its shape. */
export function hideDirs(message: string, ...named: readonly unknown[]): string {
  const absolute = named.filter((p): p is string => typeof p === "string" && p.length > 1 && (p.startsWith("/") || isDrive(p, 0)));
  return absolute.sort((a, b) => b.length - a.length).reduce((text, p) => text.split(p).join(tail(p) || "(a path)"), message);
}

/** The line with every absolute path (POSIX, drive-letter or `file:` URL) cut to its last part: `open '/srv/run/work/a.png'`
 *  is `open 'a.png'`. A relative path, a link and the slashes of `and/or` and `3/4` are left as they are. */
export function pathSafe(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; ) {
    if (!startsPath(line, i)) { out += line[i++]; continue; }
    const end = endOf(line, i);
    out += tail(line.slice(i, end)) || "(a path)";
    i = end;
  }
  return out;
}
