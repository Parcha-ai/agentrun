// A learning's notes as files: the notes a run was given and read (learning.ts Learning), each by its file, as the store's
// learning reads (store-reads/learning.ts) and a learning run (learning-run.ts) count them.
import { isObject } from "./validate.js";

/** The files of the notes a run was given and read; a list left with none is absent. */
export type NoteFiles = { given?: string[]; read?: string[] };
const filesOf = (source: { given?: unknown; read?: unknown }, fileOf: (entry: unknown) => unknown): NoteFiles => {
  const files = (list: unknown) => (Array.isArray(list) ? list.flatMap((entry) => { const file = fileOf(entry); return typeof file === "string" ? [file] : []; }) : []);
  const [given, read] = [files(source.given), files(source.read)];
  return { ...(given.length ? { given } : {}), ...(read.length ? { read } : {}) };
};
/** A learning's notes ({file, name}) as files: an entry without a string `file` is skipped, so a learning saved out of
 *  shape never stops a reader. */
export const notesOf = (learning: { given?: unknown; read?: unknown }): NoteFiles => filesOf(learning, (entry) => (isObject(entry) ? entry.file : undefined));
