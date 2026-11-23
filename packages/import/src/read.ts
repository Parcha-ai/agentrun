// What a caller asks of the registry, whatever a source's shape: its locators under a home, in the import's order, its
// subagents' locators, and one session read.
import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import type { Env, Locator, Reader, ReadOptions } from "./reader.js";
import { READERS, type Source } from "./readers/index.js";
import type { SessionOf } from "./types.js";

export type Session = SessionOf<Source>;

/** The readers a call reads with: the registry's, or one a caller hands in (a test's, a source not yet registered). */
export type Readers = Readonly<Record<string, Reader<string, any>>>;

/** The reader of `source` among `readers`; one that is not there throws. */
export function readerOf(source: string, readers: Readers = READERS): Reader<string, unknown> {
  const reader = readers[source];
  if (!reader) throw new Error(`no reader for the source ${source}`);
  return reader;
}

/** The locators of `source` under `home`, by path, never through a link (a file that is not a regular file is dropped). */
export async function sessionLocators(home: string, source: string, { env, readers }: { env?: Env; readers?: Readers } = {}): Promise<Locator[]> {
  // A home whose source directory is itself a link is read as found (the person's own), but no file is a link.
  const out: Locator[] = [];
  const found = (await readerOf(source, readers).discover(home, env)).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.id ?? "").localeCompare(b.id ?? "")));
  for (const locator of found) if ((await lstat(locator.file).catch(() => null))?.isFile()) out.push(locator);
  return out;
}

/** The locators of `source`, each with its file's stats (one gone since it was listed is passed over), in the import's
 *  order: the reader's (Claude Code's by project folder, oldest written first: the first file holding a copied record
 *  keeps it), else as they were listed. */
export async function inOrder(locators: readonly Locator[], source: string, readers?: Readers): Promise<{ locator: Locator; stats: Stats }[]> {
  const out: { locator: Locator; stats: Stats }[] = [];
  for (const locator of locators) {
    const stats = await stat(locator.file).catch(() => null);
    if (stats) out.push({ locator, stats });
  }
  const order = readerOf(source, readers).order;
  if (order) out.sort((a, b) => order({ file: a.locator.file, mtimeMs: a.stats.mtimeMs }, { file: b.locator.file, mtimeMs: b.stats.mtimeMs }));
  return out;
}

/** The subagents' sessions of `source` under `home` that name no parent themselves, each with the session it ran under
 *  (Claude Code's <session id>/subagents/). */
export async function childrenOf(home: string, source: string, { env, readers }: { env?: Env; readers?: Readers } = {}): Promise<{ locator: Locator; of: Locator }[]> {
  return (await readerOf(source, readers).children?.(home, env)) ?? [];
}

/** The one session at `locator` (a file alone is its first session), read whole; `turns: false` keeps only what a
 *  listing shows. A locator whose session is not there throws. */
export async function readSession(locator: Locator | string, source: string, { readers, ...options }: ReadOptions & { readers?: Readers } = {}): Promise<Session> {
  const at = typeof locator === "string" ? { file: locator } : locator;
  const { sessions } = await readerOf(source, readers).read(at, undefined, { ...options, keepsCursor: false });
  const found = at.id === undefined ? sessions[0] : sessions.find(({ locator }) => locator.id === at.id);
  if (!found) throw new Error(`no session ${at.id ?? ""} in ${at.file}`);
  const session = found.session as Session;
  if (found.locator.id !== undefined) session.within = found.locator.id;
  return session;
}

/** Where a session read by readSession is: its file, and its id there when the file holds many. */
export const locatorOf = ({ file, within }: Pick<Session, "file" | "within">): Locator => (within === undefined ? { file } : { file, id: within });
