// The type a file is served as, by its extension: a run's files, a home's, and an upload whose reservation names none.
import { extname } from "node:path";

/** A Map, so only its own extensions resolve: an object's would also give its prototype's (`.constructor`, `.__proto__`). */
const TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json", jsonl: "application/x-ndjson",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
}));
/** The types a file is served as in the page (every known type but PDF); any other is a download. */
export const INLINE_TYPES: ReadonlySet<string> = new Set([...TYPES.values()].filter((type) => type !== "application/pdf"));
/** The type of a file at `path`, by its extension; undefined for one the table does not know. */
export const typeOf = (path: string): string | undefined => TYPES.get(extname(path).slice(1).toLowerCase());
