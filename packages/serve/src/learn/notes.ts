// What an agent has learned, in Claude Code's auto-memory format: a folder of notes, one per file, and `MEMORY.md`, the
// index a run reads, one line per active note. A note is `<slug>.md`: front matter with `name`, `description` and `type`
// (Claude Code's four), optionally `supersedes: [old.md]` (the notes it replaces), and what only the host sets:
// `status: superseded | retired | pending` with `superseded_by` (absent, it is active; pending, it waits for its owner's
// OK) and `origin: you | run` (a note kept from what the user asked, or one the run worked out; absent, the run's). Then
// its body. The host builds the index from the active notes' front matter; nothing else writes it.

/** The index: what a run reads. */
export const INDEX_FILE = "MEMORY.md";
/** How much of the index a run reads, as Claude Code loads its own: the first 200 lines, and no more than 25 KB. */
export const INDEX_LINES = 200;
export const INDEX_BYTES = 25_000;
export const NOTE_TYPES = Object.freeze(["user", "feedback", "project", "reference"] as const);
export const NOTE_STATUSES = Object.freeze(["active", "superseded", "retired", "pending"] as const);
/** Where a note came from: `you`, what the user asked in their own words; `run`, what the run worked out. */
export const NOTE_ORIGINS = Object.freeze(["you", "run"] as const);
export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type NoteOrigin = (typeof NOTE_ORIGINS)[number];
/** A note's file name: in the folder itself, never under a directory or hidden, and never the index. */
export const NOTE_FILE = /^(?!MEMORY\.md$)[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;

/** `supersedes`: the notes it replaces, by file name; `keys`: every key its front matter sets. */
export type LearnedNote = { file: string; name: string; description: string; type: NoteType; status: NoteStatus; origin: NoteOrigin; superseded_by: string | null; supersedes: string[]; keys: string[]; body: string };

/** A value as front matter writes it: bare, or in one pair of quotes. */
const unquoted = (value: string) => (/^"[^"]*"$|^'[^']*'$/.test(value) ? value.slice(1, -1) : value);
/** The front matter, between its two `---` lines, and what follows it. */
const FRONT = /^---\n([\s\S]*?)\n?^---$\n?/m;
/** A list as front matter writes it, `[a.md, b.md]`, or one bare value. */
const listOf = (value: string) => (/^\[.*\]$/.test(value) ? value.slice(1, -1).split(",") : [value]).map((item) => unquoted(item.trim())).filter(Boolean);

/** The note in `file`, or why it is out of shape. Keys it does not know are left alone: a note may carry more. */
export function parseNoteFile(file: string, text: string): LearnedNote | string[] {
  const out: string[] = [];
  if (!NOTE_FILE.test(file)) out.push(`${JSON.stringify(file)} is not a note's file name`);
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return [...out, "it does not start with front matter"];
  const head = FRONT.exec(lf);
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
  // No type is a project note (Claude Code's memory reads one the same way); a type it does not know is refused.
  const type = fields.has("type") ? fields.get("type") : "project";
  if (!(NOTE_TYPES as readonly string[]).includes(type ?? "")) out.push(`type is not ${NOTE_TYPES.join(", ")}`);
  const status = fields.get("status") || "active";
  if (!(NOTE_STATUSES as readonly string[]).includes(status)) out.push(`status is not ${NOTE_STATUSES.slice(1, -1).join(", ")} or ${NOTE_STATUSES.at(-1)}`);
  const origin = fields.get("origin") || "run";
  if (!(NOTE_ORIGINS as readonly string[]).includes(origin)) out.push(`origin is not ${NOTE_ORIGINS.join(" or ")}`);
  const by = fields.get("superseded_by") || null;
  if (by !== null && !NOTE_FILE.test(by)) out.push("superseded_by is not a note's file name");
  const supersedes = listOf(fields.get("supersedes") ?? "");
  if (supersedes.some((old) => !NOTE_FILE.test(old))) out.push("supersedes is not a list of notes' file names");
  else if (new Set(supersedes).size < supersedes.length) out.push("supersedes names a note twice");
  if (out.length) return out;
  return { file, name: fields.get("name")!, description: fields.get("description")!, type: type as NoteType, status: status as NoteStatus, origin: origin as NoteOrigin, superseded_by: by, supersedes, keys: [...fields.keys()], body: lf.slice(head[0].length) };
}

/** `text`, a note's file, with `lines` in its front matter in place of any it had of the keys `replaced` (`status` and
 *  `superseded_by` unless named); the rest as it was, with LF line ends. */
function marked(text: string, lines: readonly string[], replaced: readonly string[] = ["status", "superseded_by"]): string {
  const lf = text.replace(/\r\n/g, "\n");
  const head = FRONT.exec(lf);
  if (!head || head.index !== 0) throw new Error("the note has no front matter");
  const kept = head[1]!.split("\n").filter((line) => !replaced.some((key) => line.startsWith(`${key}:`)));
  return `---\n${[...kept, ...lines].join("\n")}\n---\n${lf.slice(head[0].length)}`;
}

/** `text`, a run's new note, as the host merges it: `origin: you` for one kept from the user's own words (a note the run
 *  worked out carries none, which reads as `run`) and, for a note that waits for its owner's OK, `status: pending`, in
 *  place of any of the three it had. */
export function mergedNote(text: string, as: { origin: NoteOrigin; pending?: boolean }): string {
  if (!(NOTE_ORIGINS as readonly string[]).includes(as.origin)) throw new Error(`origin is ${NOTE_ORIGINS.join(" or ")}`);
  // The run's own `risky` mark is read by the grade (runMarkedRisky) and never kept: a held note says so by its status.
  return marked(text, [...(as.origin === "you" ? ["origin: you"] : []), ...(as.pending ? ["status: pending"] : [])], ["status", "superseded_by", "origin", "risky"]);
}

/** `text`, a run's new note, without the mark its end-of-run turn may set (`risky:`), as the grader reads it: the grader
 *  judges each note on its own, and the mark holds only what it keeps (parseVerdict). A text with no front matter is
 *  as it is. */
export function withoutRiskyMark(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  const head = FRONT.exec(lf);
  return head && head.index === 0 ? marked(lf, [], ["risky"]) : text;
}

/** Whether `text`, a run's new note, carries the mark its end-of-run turn sets on a risky rule: a `risky` key in its
 *  front matter (reflectPrompt asks for `risky: true`), read as parseNoteFile reads a value (bare, or in one pair of
 *  quotes). It fails closed: any value but an explicit no (`false`, `no`, `0`, or none) is a mark. */
export function runMarkedRisky(text: string | undefined): boolean {
  const head = text === undefined ? null : FRONT.exec(text.replace(/\r\n/g, "\n"));
  if (!head || head.index !== 0) return false;
  for (const line of head[1]!.split("\n")) {
    const match = /^risky:(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const value = unquoted((match[1] ?? "").trim()).trim().toLowerCase();
    if (!["", "false", "no", "0"].includes(value)) return true;
  }
  return false;
}

/** `text`, a pending note's file, as the host leaves it when its owner approves it: active, no status; its origin kept. */
export const approve = (text: string): string => marked(text, []);

/** `text`, a note's file, as the host leaves it when note `by` supersedes it: `status: superseded` and `superseded_by`. */
export function supersede(text: string, by: string): string {
  if (!NOTE_FILE.test(by)) throw new Error("superseded_by must be a note's file name");
  return marked(text, ["status: superseded", `superseded_by: ${by}`]);
}

/** `text`, a note's file, as the host leaves it when a person retires it: `status: retired`, and no `superseded_by`. */
export const retire = (text: string): string => marked(text, ["status: retired"]);

/** The active ones of `notes`, by file name. */
export function activeNotes(notes: Iterable<LearnedNote>): LearnedNote[] {
  return [...notes].filter((note) => note.status === "active").sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** A note's line in the index, `- [name](file.md) — description`, each run of whitespace one space. */
export function indexLine(note: Pick<LearnedNote, "file" | "name" | "description">): string {
  const one = (text: string) => text.replace(/\s+/g, " ").trim();
  return `- [${one(note.name)}](${note.file}) — ${one(note.description)}`;
}

/** `MEMORY.md` as the host writes it: one line per active note, by file name (indexLine); empty when none is active.
 *  The one builder of the index. */
export function buildIndex(notes: Iterable<LearnedNote>): string {
  return activeNotes(notes).map((note) => `${indexLine(note)}\n`).join("");
}

/** What a run reads of `index`: its first INDEX_LINES lines, cut to whole lines within INDEX_BYTES. */
export function loadedIndex(index: string): string {
  const lines = index.replace(/\r\n/g, "\n").split("\n").slice(0, INDEX_LINES);
  let bytes = 0;
  const kept = lines.findIndex((line) => (bytes += Buffer.byteLength(line) + 1) > INDEX_BYTES);
  return (kept < 0 ? lines : lines.slice(0, kept)).join("\n");
}
