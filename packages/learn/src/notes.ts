// What an agent has learned, in Claude Code's auto-memory format: a folder of notes, one per file, and `MEMORY.md`, the
// index a run reads, one line per active note. A note is `<slug>.md`: front matter with `name`, `description` and `type`
// (Claude Code's four), and optionally `status: superseded | retired` with `superseded_by` (absent, it is active), then
// its body. The host builds the index from the active notes' front matter; nothing else writes it.

/** The index: what a run reads. */
export const INDEX_FILE = "MEMORY.md";
/** How much of the index a run reads, as Claude Code loads its own: the first 200 lines, and no more than 25 KB. */
export const INDEX_LINES = 200;
export const INDEX_BYTES = 25_000;
export const NOTE_TYPES = Object.freeze(["user", "feedback", "project", "reference"] as const);
export const NOTE_STATUSES = Object.freeze(["active", "superseded", "retired"] as const);
export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
/** A note's file name: in the folder itself, never under a directory or hidden, and never the index. */
export const NOTE_FILE = /^(?!MEMORY\.md$)[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;

export type LearnedNote = { file: string; name: string; description: string; type: NoteType; status: NoteStatus; superseded_by: string | null; body: string };

/** A value as front matter writes it: bare, or in one pair of quotes. */
const unquoted = (value: string) => (/^"[^"]*"$|^'[^']*'$/.test(value) ? value.slice(1, -1) : value);

/** The note in `file`, or why it is out of shape. Keys it does not know are left alone: a note may carry more. */
export function parseNoteFile(file: string, text: string): LearnedNote | string[] {
  const out: string[] = [];
  if (!NOTE_FILE.test(file)) out.push(`${JSON.stringify(file)} is not a note's file name`);
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return [...out, "it does not start with front matter"];
  const head = /^---\n([\s\S]*?)\n?^---$\n?/m.exec(lf);
  if (!head) return [...out, "its front matter is not closed"];
  const fields = new Map<string, string>();
  for (const line of head[1]!.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) {
      out.push(`the front matter line ${JSON.stringify(line.slice(0, 40))} is not "key: value"`);
      continue;
    }
    if (fields.has(match[1]!)) out.push(`${match[1]} appears twice`);
    fields.set(match[1]!, unquoted((match[2] ?? "").trim()));
  }
  for (const key of ["name", "description"]) if (!fields.get(key)) out.push(`${key} is missing`);
  const type = fields.get("type");
  if (!(NOTE_TYPES as readonly string[]).includes(type ?? "")) out.push(`type is not ${NOTE_TYPES.join(", ")}`);
  const status = fields.get("status") || "active";
  if (!(NOTE_STATUSES as readonly string[]).includes(status)) out.push(`status is not ${NOTE_STATUSES.slice(1).join(" or ")}`);
  const by = fields.get("superseded_by") || null;
  if (by !== null && !NOTE_FILE.test(by)) out.push("superseded_by is not a note's file name");
  if (out.length) return out;
  return { file, name: fields.get("name")!, description: fields.get("description")!, type: type as NoteType, status: status as NoteStatus, superseded_by: by, body: lf.slice(head[0].length) };
}

/** The active ones of `notes`, by file name. */
export function activeNotes(notes: Iterable<LearnedNote>): LearnedNote[] {
  return [...notes].filter((note) => note.status === "active").sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** `MEMORY.md` as the host writes it: one line per active note, by file name, `- [name](file.md) — description`; empty
 *  when none is active. The one builder of the index. */
export function buildIndex(notes: Iterable<LearnedNote>): string {
  const one = (text: string) => text.replace(/\s+/g, " ").trim();
  return activeNotes(notes).map((note) => `- [${one(note.name)}](${note.file}) — ${one(note.description)}\n`).join("");
}

/** What a run reads of `index`: its first INDEX_LINES lines, cut to whole lines within INDEX_BYTES. */
export function loadedIndex(index: string): string {
  const lines = index.replace(/\r\n/g, "\n").split("\n").slice(0, INDEX_LINES);
  let bytes = 0;
  const kept = lines.findIndex((line) => (bytes += Buffer.byteLength(line) + 1) > INDEX_BYTES);
  return (kept < 0 ? lines : lines.slice(0, kept)).join("\n");
}
