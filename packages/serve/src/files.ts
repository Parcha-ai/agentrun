// The small JSON files the server reads and writes beside the agent homes.
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Json } from "./validate.js";

/** The file parsed as JSON, or null when it is missing, unreadable, or not whole JSON (a half-written file). */
export const readJson = (path: string): Promise<Json | null> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as Json)
    .catch(() => null);

/** Writes `text` to `path` whole: through a temporary file and a rename, so a reader never sees half of it. */
export async function writeWhole(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}
