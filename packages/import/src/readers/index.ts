// The sources this package reads, one Reader each. A new source is a file beside these that exports its Reader, and
// one line here; nothing else names a source.
import type { Reader } from "../reader.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { pi } from "./pi.js";

export const READERS = {
  "claude-code": claudeCode,
  codex,
  pi,
  copilot,
} as const satisfies Record<string, Reader<string, any>>;

export type Source = keyof typeof READERS;
export const SOURCES = Object.keys(READERS) as Source[];
/** The harness of serve that runs what each source ran. */
export const HARNESS_OF = Object.fromEntries(SOURCES.map((source) => [source, READERS[source].harness])) as Record<Source, string>;
/** Each source's name as a person reads it. */
export const SOURCE_NAMES = Object.fromEntries(SOURCES.map((source) => [source, READERS[source].name])) as Record<Source, string>;

