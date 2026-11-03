// What a run is told of its workspace: one line after its first message naming the files given to it (`file_ids`,
// copied into its work/inputs/, uploads.ts), so a model asked about "the attached file" knows where it is. On every
// harness: it rides in the first message itself, which runs.ts sends to the run's door. Bounded: at most
// MANIFEST_ENTRIES files, then how many more, and never past what the door takes in one message (FIRST_MESSAGE_BYTES):
// a message that fits at the run's creation still fits with its line.
import { join } from "node:path";
import { INPUTS_DIR } from "./uploads.js";
import { walkWork } from "./workspace.js";

/** The most files the line names; the rest are counted. */
export const MANIFEST_ENTRIES = 20;

/** The most the first message may take, as the JSON string the run's door is sent: pi-durable-disk's door takes a body of
 *  at most 1 MiB (serve.ts), and this leaves room for the request's other fields. */
export const FIRST_MESSAGE_BYTES = (1 << 20) - 4096;

/** `bytes` as a person reads a size: `32 B`, `1.5 KB`, `2.0 MB`. */
export const sizeOf = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** A file the line names: its path as the run's tools take it, and its size. */
export type ManifestFile = { path: string; size: number };

/** What a name never shows as is: a control character, or a line or paragraph separator. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** `label: a (1 B), b (2 B).`, at most `entries` (MANIFEST_ENTRIES) of `files` and then `and N more`, or with none
 *  named `label: N files.`; undefined for no file. A control character or a line or paragraph separator in a name is
 *  shown as `?`, so a name never breaks the line. */
export function filesLine(label: string, files: readonly ManifestFile[], entries = MANIFEST_ENTRIES): string | undefined {
  if (files.length === 0) return undefined;
  const named = files.slice(0, Math.min(entries, MANIFEST_ENTRIES)).map((file) => `${file.path.replace(BREAKS, "?")} (${sizeOf(file.size)})`);
  const more = files.length - named.length;
  if (named.length === 0) return `${label}: ${files.length} ${files.length === 1 ? "file" : "files"}.`;
  return `${label}: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/** The size of `text` as the door is sent it: a JSON string, in UTF-8 bytes. */
const sentBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** How deep the walk of work/inputs/ goes: an upload's path is at most 1024 characters, so at most 512 folders deep. */
const INPUTS_DEPTH = 512;

/** The regular files under the run's work/inputs/, by their path from work/, in order, as deep as an upload's path
 *  goes; reached through no link, a dot-name left out. None when there is no inputs/ or it cannot be read. */
export async function inputFiles(work: string): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];
  await walkWork(join(work, INPUTS_DIR), (path, stats) => void (stats.isFile() && files.push({ path: `${INPUTS_DIR}/${path}`, size: stats.size })), {
    skip: (name) => name.startsWith("."),
    depth: INPUTS_DEPTH,
  }).catch(() => undefined);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The run's first message: `content`, then, after a blank line, the files given to it, when it has any: as many named
 *  as keep the message within `budget` (FIRST_MESSAGE_BYTES), else only how many, else no line at all, so the line never
 *  turns a message the run took into one its door refuses. */
export async function firstMessage(content: string, work: string, budget = FIRST_MESSAGE_BYTES): Promise<string> {
  const files = await inputFiles(work);
  for (let entries = Math.min(files.length, MANIFEST_ENTRIES); entries >= 0 && files.length > 0; entries--) {
    const message = `${content}\n\n${filesLine("Files for this run", files, entries)}`;
    if (sentBytes(message) <= budget) return message;
  }
  return content;
}
