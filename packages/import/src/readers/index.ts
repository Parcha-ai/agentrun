// The sources this package reads, one Reader each. A new source is a file beside these that exports its Reader, and
// one line here, or in line-readers.ts for one whose every session is one file of lines (the read pool's workers read
// those); nothing else names a source.
import type { Reader } from "../reader.js";
import { LINE_READERS } from "./line-readers.js";
import { opencode } from "./opencode.js";

export const READERS = {
  ...LINE_READERS,
  opencode,
} as const satisfies Record<string, Reader<string, any>>;

export type Source = keyof typeof READERS;
export const SOURCES = Object.keys(READERS) as Source[];
/** The harness of serve that runs what each source ran. */
export const HARNESS_OF = Object.fromEntries(SOURCES.map((source) => [source, READERS[source].harness])) as Record<Source, string>;
/** Each source's name as a person reads it. */
export const SOURCE_NAMES = Object.fromEntries(SOURCES.map((source) => [source, READERS[source].name])) as Record<Source, string>;

