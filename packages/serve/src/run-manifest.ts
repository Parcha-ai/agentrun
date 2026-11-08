// What a run is told of its workspace: one line after its first message naming the files given to it (`file_ids`,
// copied into its work/inputs/, uploads.ts), so a model asked about "the attached file" knows where it is. On every
// harness: it rides in the first message itself, which runs.ts sends to the run's door. Bounded: at most
// MANIFEST_ENTRIES files, then how many more, and never past what the door takes in one message (FIRST_MESSAGE_BYTES):
// a message that fits at the run's creation still fits with its line.
import { INPUTS_DIR } from "./uploads.js";
import { type Entry, type Workspace, workspaceAt } from "./workspace/index.js";

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

/** What a quoted name never holds as itself: a control character, a format character (an RTL override, a zero-width
 *  space) or a line or paragraph separator, which JSON leaves as they are where it escapes no more than it must. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `name` as a JSON string, each character UNSEEN names as its `\uXXXX` escape: so a quote or a comma in it cannot end
 *  it and forge another entry, and nothing in it can break the line or reorder what is read. */
export const quoted = (name: string): string =>
  JSON.stringify(name).replace(UNSEEN, (found) => Array.from({ length: found.length }, (_, i) => `\\u${found.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));

/** `label: "a" (1 B), "b" (2 B).`, at most `entries` (MANIFEST_ENTRIES) of `files`, each name `quoted`, and then `and N
 *  more`, or with none named `label: N files.`; undefined for no file. */
export function filesLine(label: string, files: readonly ManifestFile[], entries = MANIFEST_ENTRIES): string | undefined {
  if (files.length === 0) return undefined;
  const named = files.slice(0, Math.min(entries, MANIFEST_ENTRIES)).map((file) => `${quoted(file.path)} (${sizeOf(file.size)})`);
  const more = files.length - named.length;
  if (named.length === 0) return `${label}: ${files.length} ${files.length === 1 ? "file" : "files"}.`;
  return `${label}: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/** The size of `text` as the door is sent it: a JSON string, in UTF-8 bytes. */
const sentBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** How deep the walk of work/inputs/ goes: an upload's path is at most 1024 characters, so at most 512 folders deep,
 *  and inputs/ is one more. */
const INPUTS_DEPTH = 513;

/** The files under the run's inputs/, by their path from its root, in order, as deep as an upload's path goes: walked
 *  through the run's Workspace listing, which follows no link, so a link at inputs/ or anywhere below it is never
 *  entered; a dot-name left out. None when there is no inputs/ or a folder of it cannot be read. The run's start still
 *  hands its folder's path. */
export async function inputFiles(given: Workspace | string): Promise<ManifestFile[]> {
  const work = workspaceAt(given);
  const files: ManifestFile[] = [];
  const into = async (dir: string, depth: number): Promise<void> => {
    const entries: Entry[] = await work.list(dir).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.kind === "file") files.push({ path, size: entry.size });
      else if (depth < INPUTS_DEPTH) await into(path, depth + 1);
    }
  };
  await into(INPUTS_DIR, 1);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The run's first message: `content`, then, after a blank line, the files given to it, when it has any: as many named
 *  as keep the message within `budget` (FIRST_MESSAGE_BYTES), else only how many, else no line at all, so the line never
 *  turns a message the run took into one its door refuses. */
export async function firstMessage(content: string, work: Workspace | string, budget = FIRST_MESSAGE_BYTES): Promise<string> {
  const files = await inputFiles(work);
  for (let entries = Math.min(files.length, MANIFEST_ENTRIES); entries >= 0 && files.length > 0; entries--) {
    const message = `${content}\n\n${filesLine("Files for this run", files, entries)}`;
    if (sentBytes(message) <= budget) return message;
  }
  return content;
}
