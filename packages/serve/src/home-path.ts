// A path in an agent's home as its routes take it: decoded, checked as a run's file path is, made of plain segments, and
// never at or under a path only the host writes, by its name in any spelling a disk could take for it or, where both are
// on disk, by being the same entry.
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { ApiError } from "./errors.js";
import { HOME_HOST_OWNED } from "./files.js";
import { WALK_DEPTH } from "./workspace.js";

/** A file path as the URL sends it, each segment percent-decoded. */
export function decodedPath(raw: string): string {
  try {
    return raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new ApiError("invalid_file_path", "the path is not percent-encoded right");
  }
}

/** `rel`, refused unless it is a relative path of names; a segment that starts with . is `own`'s. */
export function checkedPath(rel: string, own: string): string {
  const parts = rel.split("/");
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) throw new ApiError("invalid_file_path", "the path has an empty, . or .. segment, a backslash, a NUL or a leading /");
  if (parts.some((p) => p.startsWith("."))) throw new ApiError("system_file_forbidden", `a path segment that starts with . is ${own}`);
  return rel;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/** Whether `segment` is plain text: its own NFC form, with no default-ignorable code point. A disk may take two
 *  spellings that differ only in such code points for one name; a plain segment is the one spelling. */
const plainSegment = (segment: string): boolean => segment === segment.normalize("NFC") && !IGNORABLE.test(segment);

const MARKS = /\p{M}/gu;
/** `name` as a disk that folds names could take it: its compatibility form, upper then lower case, and without combining
 *  marks, so ı, İ, ſ, the Kelvin sign and fullwidth letters fold as the ASCII letters they stand for. */
export const foldName = (name: string): string => name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFD").replace(MARKS, "");

/** The name of `owned` that `path` is at or under, if any: its first segment, on the path as normalized, folded. */
export function ownedBy(owned: readonly string[], path: string): string | undefined {
  const first = foldName(posix.normalize(path).replace(/^\/+/, "").split("/")[0]!);
  return owned.find((name) => foldName(name) === first);
}

/** The host-owned path of the home that `path` is at or under, if any (files.ts HOME_HOST_OWNED). */
export const hostOwnedOf = (path: string): string | undefined => ownedBy(HOME_HOST_OWNED, path);

/** The refusal of a read, write or delete at or under the host-owned path `owned`: its notes are read through the
 *  learning API alone, which redacts them, never raw here. */
export const hostOwnedRefusal = (owned: string, agentId: string, write: boolean): ApiError =>
  new ApiError("system_file_forbidden", write ? `${owned}/ is written by the server, not through the API` : `read it through /v2/agents/${agentId}/${owned}`, { details: { reason: "host_owned" } });

/** A path in an agent's home as its routes take it, checked as a run's file path is, made of plain segments, and at most
 *  1024 characters with no segment over 255 bytes. Anything at or under a host-owned path is refused, read or written,
 *  so `./learning/x`, `a/../LeArNiNg/x` and `Learning/x` are refused as learning/ is; and a write goes no deeper than the
 *  list does. */
export function homePath(raw: string, agentId: string, write: boolean): string {
  const rel = decodedPath(raw);
  if (!rel.split("/").every(plainSegment)) throw new ApiError("invalid_file_path", "a path segment must be plain text (NFC, no invisible characters)");
  const owned = hostOwnedOf(rel);
  if (owned) throw hostOwnedRefusal(owned, agentId, write);
  checkedPath(rel, "the server's own, not a file of the home");
  if (rel.length > 1024 || rel.split("/").some((p) => Buffer.byteLength(p) > 255)) throw new ApiError("invalid_file_path", "the path is over 1024 characters, or a segment of it over 255 bytes");
  if (write && rel.split("/").length - 1 > WALK_DEPTH) throw new ApiError("invalid_file_path", `a file is written at most ${WALK_DEPTH} directories deep, as deep as the list goes`);
  return rel;
}

/** Whether two stats are of one entry on disk: the same device and inode. */
const sameEntry = (a: Pick<BigIntStats, "dev" | "ino">, b: Pick<BigIntStats, "dev" | "ino">): boolean => a.dev === b.dev && a.ino === b.ino;

/** The host-owned path of `home` that the first segment of `rel` (a path homePath took) is on this disk, if any: both
 *  there, and one entry. A disk that takes another spelling for a host-owned name answers so, whatever the spelling. */
export async function ownedByIdentity(home: string, rel: string, owned: readonly string[] = HOME_HOST_OWNED, stat: (path: string) => Promise<Pick<BigIntStats, "dev" | "ino"> | null> = (path) => lstat(path, { bigint: true }).catch(() => null)): Promise<string | undefined> {
  const first = await stat(join(home, rel.split("/")[0]!));
  if (!first) return undefined;
  for (const name of owned) {
    const entry = await stat(join(home, name));
    if (entry && sameEntry(first, entry)) return name;
  }
  return undefined;
}
