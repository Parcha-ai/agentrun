// What the server reads and writes beside the agent store: small JSON files, and a run store's entries, read-only.
import { readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Json } from "./validate.js";

/** The server's own file in each run's directory: the run's title, input and how it was asked to run. */
export const RUN_META = "serve.json";

/** The file parsed as JSON, or null when it is missing, unreadable, or not whole JSON (a half-written file). */
export const readJson = (path: string): Promise<Json | null> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as Json)
    .catch(() => null);

/** Each `record` that `sql` selects from a run store's entries, parsed; the store is opened read-only. */
export function storeRecords(file: string, sql: string): Json[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return [...db.prepare(sql).iterate()].map((row) => JSON.parse(String((row as { record: string }).record)) as Json);
  } finally {
    db.close();
  }
}

/** Writes `text` to `path` whole: through a temporary file and a rename, so a reader never sees half of it. */
export async function writeWhole(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}
