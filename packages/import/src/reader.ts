// What a source's reader is: where its sessions are under a home (locators), and how it reads one locator into sessions,
// from a cursor of its own. A new source is one file that exports a Reader and one line in readers/index.ts. The JSONL
// sources build theirs with lineReader (lines.ts); a source of another shape (a SQLite database of many sessions)
// implements discover and read itself.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { personsWords } from "./text.js";
import type { Answer, SessionOf, Turn } from "./types.js";

/** The environment a reader may look in for its source's own directories (CLAUDE_CONFIG_DIR, CODEX_HOME). */
export type Env = Readonly<Record<string, string | undefined>>;

/** A session's identity: the file it is in, and its id in that file where one file holds many (OpenCode's database). */
export type Locator = { file: string; id?: string };

/** A locator as one string: the file, with `#id` after it when it names one. */
export const locatorKey = ({ file, id }: Locator): string => (id === undefined ? file : `${file}#${id}`);

/** One session a read found: where it is, what it is, and every request read (each counted once), whether turns are kept
 *  or not: what a total counts. */
export type SessionRead<S extends string = string> = { locator: Locator; session: SessionOf<S>; requests: Answer[] };

export type ReadResult<S extends string = string, C = unknown> = {
  /** The locator's sessions: one for a file of one session; each in the file, or the one its id names, for a file of
   *  many. */
  sessions: SessionRead<S>[];
  /** Where a later read goes on from. The reader's own: hand it back to the same reader's read, nothing else. */
  cursor: C;
  /** The bytes this read took. */
  read: number;
  /** Whether it went on from the cursor it was handed (false: it read the locator from its start). */
  resumed: boolean;
};

export type ReadOptions = {
  /** false keeps only what a listing shows: no turns, nor a request's text or call arguments. */
  turns?: boolean;
  /** The records and requests an import has read already, across its files: a record in it (a copy a resumed session's
   *  file carries) adds nothing, and this read's are added to it. A cursor read with one is resumed with the same one. */
  seen?: Set<string>;
};

export type Reader<S extends string = string, C = unknown> = {
  source: S;
  /** The source's name as a person reads it. */
  name: string;
  /** The harness of serve that runs what the source ran. */
  harness: string;
  /** The candidate locators of the source under `home`, any order (`env`: where the source's own directory is named). */
  discover: (home: string, env?: Env) => Promise<Locator[]>;
  /** One locator read, from its start or from `cursor` (one this reader returned for the same locator). A cursor that no
   *  longer fits (the file replaced, truncated, rewritten) is read from the start, `resumed` false. */
  read: (locator: Locator, cursor?: C, options?: ReadOptions) => Promise<ReadResult<S, C>>;
  /** The import's order of the listed locators, when not their path's (a record copied into two files is the first's). */
  order?: (a: { file: string; mtimeMs: number }, b: { file: string; mtimeMs: number }) => number;
  /** Subagents' sessions that name no parent themselves, each with the session it ran under (`of`). */
  children?: (home: string, env?: Env) => Promise<{ locator: Locator; of: Locator }[]>;
};

/** A directory's entries, none when it cannot be read. */
export const entries = async (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => []);

/** A user turn counted in `session`: its users, its first prompt, and the person's first words. */
export function rememberUser(session: SessionOf, turn: Turn): void {
  if (turn.role !== "user") return;
  session.users += 1;
  session.firstPrompt ??= turn.text;
  session.titleText ??= personsWords(turn.text);
}
