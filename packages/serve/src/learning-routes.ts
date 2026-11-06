// What a person sees and controls of an agent's learning: this server's own routes under /v2 (learning/1).
// - Per agent: main's index, its notes and its log of changes, each a page, its skills and workflow drafts, and how its
//   runs' learning fared; one note, a skill's SKILL.md or a draft's file as text with its ETag, its blob id on main.
// - A person's approval of a note, a skill or a draft that waits for the owner's OK, and their edit, create or retire of
//   one note (a skill or a draft is a run's to change): a precondition on the note's version (If-Match, or If-None-Match: * to
//   create; neither is 428), the structural checks a run's notes pass (learn/check.ts checkNote; a retire, the note's
//   format alone, so a leaking note can always be revoked) and no grader, then one host commit on main in the agent's
//   queue, compare and swap, with MEMORY.md rebuilt and a `Changed-By: user` trailer, and the checked-out files brought
//   in line. MEMORY.md itself is never written here.
// - Per run: its learning whole, and its diff: what it proposed against its seed, or once merged, its merge commit against
//   its parent.
// Every read is plumbing at one commit of main, outside the queue: a commit never changes, so a read needs no lock, and
// a page's cursor names the commit it was read at. What a commit's notes are, parsed and in order, is kept for the few
// commits last read (Recent), so later pages and the view at the same commit read no note again; the log reads only
// its page's commits (skip and max-count). A read reaches the folder through readFolder, a write through agentFolder:
// the same link rule, so a link at the folder is an error on either, never followed. A text that leaves holding one of
// the host's secrets as they are now (a value made secret after it was written) is cut of it, a file's name holding
// one reads "[redacted]" whole, and a diff's file holding one is withheld.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { approve, buildIndex, CAPS, checkNote, frontKeys, INDEX_FILE, INDEX_LINES, isHeld, LEARNED_KEYS, type LearnedNote, learnedFront, learnedName, learnedPlace, learnedStatus, NOTE_FILE, NOTE_STATUSES, parseNoteFile, type Problem, printable, released, retire, retiredLearned, skillProblems, SKILLS_DIR, supersede, unstorable, WORKFLOWS_DIR } from "./learn/index.js";
import { ApiError, invalid } from "./errors.js";
import { homeOf, readJson } from "./files.js";
import { agentFolder, changedOrder, checkOut, detailShown, git, line, mainOf, type NoteRuns, notesView, openAgentRepo, PROPOSAL, readBlobs, readFolder, readPin, secretsShown, type Shown, withAgentRepo } from "./learning.js";
import type { Impact } from "./learning-run.js";
import type { Run } from "./runs.js";
import { isObject } from "./validate.js";

/** A file on main larger than this is not read: a note is at most 4 KB (learn/check.ts CAPS.note). */
const FILE_CAP = 1 << 20;
/** A diff's file whose patch is larger than this is withheld as too large. */
const PATCH_CAP = 64 * 1024;
/** The agent view's first pages, and the most a page holds. */
const NOTES_PAGE = 50;
const LOG_PAGE = 20;
const PAGE_MAX = 200;
/** The trailer of a person's commit, as `Run-Id` is a run's merge's. */
const BY_USER = "Changed-By: user";
/** The trailer an approval's commit carries beside BY_USER: it came from the owner's password session in the console. */
const APPROVED_VIA = "Approved-Via: console";
/** What a retire adds to a note, on top of the note cap a retired note may fill (learn/notes.ts retire). */
const RETIRED_LINE = Buffer.byteLength("status: retired\n");
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Page<T> = { items: T[]; total: number; next_cursor: string | null };
type NoteView = { file: string; name: string; description: string; type: string; status: string; origin: string; superseded_by: string | null; text: string; etag: string; retired?: Retired; last_change?: LastChange; runs: { given: number; read: number } };
/** When a retired note, skill or draft was retired, and by whom: a person (its retire's commit), else a run. */
type Retired = { at: string; by: "person" | "run" };
/** The newest change to a note, skill or draft (its file: the note, a SKILL.md, a draft's README.md): what it was, by
 *  whom and when. A person's is named by its commit (`learning: <kind> by a person: <file>`); a run's merge is `learned`. */
type LastChange = { kind: "approved" | "edited" | "created" | "retired" | "restored" | "learned"; by: "person" | "run"; at: string };
const PERSON_KINDS = ["approved", "edited", "created", "retired", "restored"] as const;
type Change = { by: { run: string } | { user: true; via?: string }; commit: string; at: string; reason: string; files: string[] };
/** A note on main: its text, and its blob id there, whose ETag its file's GET answers. */
type Note = LearnedNote & { text: string; oid: string };
export type Counts = { merged: number; dropped: Record<string, number>; in_progress: number };
export { secretsShown, type Shown } from "./learning.js";

/** The few values last kept, by key, oldest dropped first: at most `entries` of them, `bytes` in all by their sizes. */
class Recent<T> {
  private readonly held = new Map<string, { value: T; size: number }>();
  private size = 0;
  constructor(private readonly entries: number, private readonly bytes = Infinity) {}
  get(key: string): T | undefined {
    const hit = this.held.get(key);
    if (!hit) return undefined;
    this.held.delete(key);
    this.held.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T, size = 0): void {
    this.drop(key);
    if (size > this.bytes) return;
    this.held.set(key, { value, size });
    this.size += size;
    while (this.held.size > this.entries || this.size > this.bytes) this.drop(this.held.keys().next().value!);
  }
  private drop(key: string): void {
    const hit = this.held.get(key);
    if (!hit) return;
    this.held.delete(key);
    this.size -= hit.size;
  }
}

/** By the folder and the commit, which never changes: its index and notes in the view's order, for the 8 commits last
 *  read and 16 MiB at most (a note is 4 KB at most), and how many changes its log holds. Raw: each answer cuts them of
 *  the host's secrets as they are then. */
const parsedAt = new Recent<{ index: string; notes: Note[]; changes: Map<string, History> }>(8, 16 << 20);
const changesAt = new Recent<number>(64);

/** Where a read finds the agent's folder: through readFolder, so a link at its home, its `learning/` or its `.git` is
 *  an error, never followed, and a folder never made reads as empty. */
const placeOf = async (data: string, agentId: string) => ({ home: homeOf(data, agentId), repo: await readFolder(data, agentId) });
export const etagOf = (oid: string) => `"${oid}"`;
const EMPTY: Page<never> = { items: [], total: 0, next_cursor: null };

/** Whether `path` is a skill's SKILL.md or a draft's workflow.json or README.md, its folder well named. */
const isLearned = (path: string) => {
  const place = learnedPlace(path);
  return place !== undefined && learnedName(place.kind, place.name);
};

/** The `.md` files at commit `sha`'s top (or the one `file`, a skill's or a draft's too), by name: the index and notes'
 *  names, regular files under FILE_CAP only, each with its blob id. */
async function entriesAt(home: string, repo: string, sha: string, file?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of (await git(home, repo, ["ls-tree", "-l", "-z", sha, ...(file ? ["--", file] : [])])).toString("utf8").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if ((path === INDEX_FILE || NOTE_FILE.test(path) || (file !== undefined && isLearned(path))) && mode === "100644" && type === "blob" && oid && Number(size) <= FILE_CAP) out.set(path, oid);
  }
  return out;
}

/** The texts of `entries`, by file, read in one batch: one that is not UTF-8 is left out. */
async function textsOf(home: string, repo: string, entries: Map<string, string>): Promise<Map<string, { oid: string; text: string }>> {
  const files = [...entries.keys()];
  const blobs = await readBlobs(home, repo, files.map((file) => entries.get(file)!));
  const out = new Map<string, { oid: string; text: string }>();
  files.forEach((file, i) => {
    try {
      out.set(file, { oid: entries.get(file)!, text: utf8.decode(blobs[i]!) });
    } catch {
      // Not UTF-8: no note, and never shown as one.
    }
  });
  return out;
}

/** What commit `sha` holds: the index's text, and every note that parses, with its text, by file. */
async function readAt(home: string, repo: string, sha: string): Promise<{ index: string; notes: Map<string, Note> }> {
  const texts = await textsOf(home, repo, await entriesAt(home, repo, sha));
  const notes = new Map<string, Note>();
  for (const [file, { oid, text }] of texts) {
    const note = file === INDEX_FILE ? [] : parseNoteFile(file, text);
    if (!Array.isArray(note)) notes.set(file, { ...note, text, oid });
  }
  return { index: texts.get(INDEX_FILE)?.text ?? "", notes };
}

/** One file at commit `sha`: its blob id and text, or undefined. */
const fileAt = async (home: string, repo: string, sha: string, file: string) => (await textsOf(home, repo, await entriesAt(home, repo, sha, file))).get(file);

/** Whether commit `sha`'s tree holds anything at `file`, as git stores it: any mode or type, any size, any bytes. The
 *  notes leave out a file that is not a regular UTF-8 one under FILE_CAP, so a write asks this before it takes a name
 *  as free. */
const heldAt = async (home: string, repo: string, sha: string, file: string) =>
  (await git(home, repo, ["ls-tree", "-z", sha, "--", file])).toString("utf8").split("\0").some((entry) => entry.slice(entry.indexOf("\t") + 1) === file);

/** The commits on main that are changes: a run's merge (`Run-Id`) or a person's commit (`Changed-By: user`), by their
 *  trailers' lines; the folder's first commit, the host's, is neither. Every commit on main is the host's, so a line
 *  that matches is a trailer. */
const CHANGES = ["--first-parent", "--extended-regexp", "--grep=^Run-Id: ", "--grep=^Changed-By: user$"];
const CHANGE_FORMAT = "%x1e%H%x1f%cI%x1f%s%x1f%b%x1f%(trailers:key=Run-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Changed-By,valueonly,separator=%x2C)%x1f%(trailers:key=Approved-Via,valueonly,separator=%x2C)";

/** `git log -z --name-only`'s records, each its header (as the format wrote it) and the files it changed. */
const recordsOf = (out: Buffer) => out.toString("utf8").split("\x1e").slice(1).map((record) => {
  const end = record.indexOf("\0");
  return { head: record.slice(0, end < 0 ? undefined : end), files: end < 0 ? [] : record.slice(end + 1).split("\0").map((file) => file.replace(/^\n/, "")).filter(Boolean) };
});

/** The changes on main to `sha`, newest first, from the `offset`th, at most `limit`: only those commits read, each told
 *  by its trailers (a run's, or `{user: true}`). A merge's reason is the grader's, its own paragraph before the
 *  trailers; a person's commit has none, so its subject says what it did. */
async function changesFrom(home: string, repo: string, sha: string, offset: number, limit: number): Promise<Change[]> {
  const log: Change[] = [];
  for (const { head, files } of recordsOf(await git(home, repo, ["log", ...CHANGES, `--skip=${offset}`, `--max-count=${limit}`, "-z", "--name-only", `--format=${CHANGE_FORMAT}`, sha]))) {
    const [commit = "", at = "", subject = "", body = "", run = "", by = "", via = ""] = head.split("\x1f");
    const runId = run.split(",")[0]!.trim();
    const approvedVia = via.split(",")[0]!.trim();
    const who = runId ? { run: runId } : by.trim() === "user" ? { user: true as const, ...(approvedVia ? { via: approvedVia } : {}) } : undefined;
    if (!who || !commit || !Date.parse(at)) continue;
    const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    log.push({ by: who, commit, at: new Date(at).toISOString(), reason: paragraphs.slice(0, -1).join(" ") || subject.replace(/^learning: /, ""), files });
  }
  return log;
}

/** How many changes main holds to `sha`, counted once a commit: git reads commits alone, never a tree. */
async function changeCount(home: string, repo: string, sha: string): Promise<number> {
  const key = `${repo}\0${sha}`;
  const known = changesAt.get(key);
  if (known !== undefined) return known;
  const count = Number(line(await git(home, repo, ["rev-list", "--count", ...CHANGES, sha])));
  changesAt.set(key, count);
  return count;
}

/** A page of the changes on main to `sha`, cut of the host's secrets. */
async function logPage(home: string, repo: string, sha: string, offset: number, limit: number, shown: Shown): Promise<Page<Change>> {
  const [total, log] = await Promise.all([changeCount(home, repo, sha), changesFrom(home, repo, sha, offset, limit)]);
  return { items: log.map((change) => ({ ...change, reason: shown.text(change.reason), files: change.files.map(shown.name) })), total, next_cursor: offset + limit < total ? cursorOf(sha, offset + limit) : null };
}

/** Commit `sha`'s index and notes, its notes as the view shows them: active first, then by their newest change on
 *  main's first-parent log (their place in the walk, so two changes in one second keep their order), newest first, then
 *  by name. Read once a commit, then kept (parsedAt). */
async function notesAt(home: string, repo: string, sha: string): Promise<{ index: string; notes: Note[]; changes: Map<string, History> }> {
  const key = `${repo}\0${sha}`;
  const known = parsedAt.get(key);
  if (known) return known;
  const [{ index, notes }, { order: touched, changes }] = await Promise.all([readAt(home, repo, sha), historyAt(home, repo, sha)]);
  const rank = (note: LearnedNote) => (note.status === "active" ? 0 : 1);
  const parsed = { index, changes, notes: [...notes.values()].sort((a, b) => rank(a) - rank(b) || (touched.get(a.file) ?? Infinity) - (touched.get(b.file) ?? Infinity) || (a.file < b.file ? -1 : 1)) };
  parsedAt.set(key, parsed, 2 * parsed.notes.reduce((size, note) => size + note.text.length + 256, index.length));
  return parsed;
}

/** A skill or a workflow draft as the view lists it: its folder's name, its file (a skill's SKILL.md, a draft's
 *  workflow.json, with its `readme`), its description, `pending` while it waits for its owner's OK, the run whose merge
 *  last changed it, its size in bytes, and the ETag of the file that says whether it waits (a SKILL.md, a README.md),
 *  which an approval names. */
type LearnedView = { name: string; file: string; readme?: string; description: string; status: "active" | "pending" | "retired"; run: string | null; bytes: number; etag: string; retired?: Retired; last_change?: LastChange };
/** What a commit's change was, as the view says it (LastChange), or undefined for a commit that is neither: a person's
 *  names its kind in the fixed prefix of its subject, `learning: <kind> by a person: `; a run's merge carries its Run-Id
 *  trailer, `learned`. Nothing else is read (no other part of the subject, no body). */
function changeOf(at: string, subject: string, runId: string): LastChange | undefined {
  if (runId.trim()) return { kind: "learned", by: "run", at };
  for (const kind of PERSON_KINDS) if (subject.startsWith(`learning: ${kind} by a person: `)) return { kind, by: "person", at };
  return undefined;
}
/** The log fields changeOf reads (LAST_FORMAT), after the record separator: the commit's time, subject, Changed-By and Run-Id. */
const LAST_FORMAT = "%cI%x1f%s%x1f%(trailers:key=Run-Id,valueonly,separator=%x2C)";
/** A file's history as the view reads it: its newest commit's time and change (none when that commit is neither a
 *  person's nor a run's), and its newest retire by a person (a retired one's `retired`: an edit since moves it not). */
type History = { at: string; last?: LastChange; retire?: LastChange };
/** Folds one record of a LAST_FORMAT walk (newest first) into `out`, for the files it changed. */
function foldHistory(out: Map<string, History>, head: string, files: readonly string[]): void {
  const [at = "", subject = "", runId = ""] = head.split("\x1f");
  const change = changeOf(at, subject, runId);
  for (const file of files) {
    const known = out.get(file);
    if (!known) out.set(file, { at, ...(change ? { last: change } : {}), ...(change?.kind === "retired" ? { retire: change } : {}) });
    else if (!known.retire && change?.kind === "retired") known.retire = change;
  }
}
/** A retired item's `retired`: its newest retire by a person, else (retired some other way) its newest change's time. */
const retiredOf = (history: History | undefined): Retired | undefined => (history ? (history.retire ? { at: history.retire.at, by: "person" } : { at: history.at, by: "run" }) : undefined);

/** Commit `sha`'s first-parent history, read in one walk: each file's place by its newest change (0 for the newest
 *  commit's, as learning.ts changedOrder orders a run's notes) and that change (changeOf). */
async function historyAt(home: string, repo: string, sha: string): Promise<{ order: Map<string, number>; changes: Map<string, History> }> {
  const order = new Map<string, number>();
  const changes = new Map<string, History>();
  recordsOf(await git(home, repo, ["log", "--first-parent", "-z", "--name-only", `--format=%x1e${LAST_FORMAT}`, sha])).forEach(({ head, files }, i) => {
    for (const file of files) if (!order.has(file)) order.set(file, i);
    foldHistory(changes, head, files);
  });
  return { order, changes };
}

/** A note as the view shows it, with its last change, and when and by whom it was retired on a retired one. */
const withChanges = <T extends { status: string }>(view: T, history: History | undefined): T & { last_change?: LastChange; retired?: Retired } => ({
  ...view,
  ...(history?.last ? { last_change: history.last } : {}),
  ...(view.status === "retired" && history ? { retired: retiredOf(history)! } : {}),
});

/** By the folder and the commit: its skills and drafts, raw (each answer cuts them of the host's secrets as they are
 *  then), for the 8 commits last read. */
const learnedAtCache = new Recent<{ skills: LearnedView[]; workflows: LearnedView[] }>(8, 4 << 20);

/** The run whose merge last changed each of commit `sha`'s files under skills/ and workflows/: its first-parent log's
 *  commits with a Run-Id, newest first, read once (a person's approval, which names none, changes no answer). */
async function lastRuns(home: string, repo: string, sha: string): Promise<{ runs: Map<string, string>; changes: Map<string, History> }> {
  const runs = new Map<string, string>();
  const changes = new Map<string, History>();
  for (const { head, files } of recordsOf(await git(home, repo, ["log", "--first-parent", "-z", "--name-only", `--format=%x1e${LAST_FORMAT}`, sha, "--", SKILLS_DIR, WORKFLOWS_DIR]))) {
    const run = (head.split("\x1f")[2] ?? "").split(",")[0]!.trim();
    foldHistory(changes, head, files);
    if (run) for (const file of files) if (!runs.has(file)) runs.set(file, run);
  }
  return { runs, changes };
}

/** Commit `sha`'s skills and workflow drafts, by name: each skill's SKILL.md and each draft's workflow.json with its
 *  README.md, regular files under FILE_CAP, with what their front matter says. A draft without its README, or a file
 *  that is not UTF-8, is left out, as the checker never lets it in. Read once a commit, then kept. */
async function learnedAt(home: string, repo: string, sha: string): Promise<{ skills: LearnedView[]; workflows: LearnedView[] }> {
  const key = `${repo}\0${sha}`;
  const known = learnedAtCache.get(key);
  if (known) return known;
  const entries = new Map<string, { oid: string; size: number }>();
  for (const entry of (await git(home, repo, ["ls-tree", "-r", "-l", "-z", sha, "--", SKILLS_DIR, WORKFLOWS_DIR])).toString("utf8").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if (isLearned(path) && mode === "100644" && type === "blob" && oid && Number(size) <= FILE_CAP) entries.set(path, { oid, size: Number(size) });
  }
  const fronts = new Map([...entries].filter(([path]) => !path.endsWith("/workflow.json")).map(([path, { oid }]) => [path, oid]));
  // A folder with none reads no history for them.
  const [texts, { runs, changes }] = entries.size ? await Promise.all([textsOf(home, repo, fronts), lastRuns(home, repo, sha)]) : [new Map<string, { oid: string; text: string }>(), { runs: new Map<string, string>(), changes: new Map<string, History>() }];
  const skills: LearnedView[] = [];
  const workflows: LearnedView[] = [];
  for (const [path, { size }] of entries) {
    const place = learnedPlace(path)!;
    if (place.kind === "readme") continue;
    const held = place.kind === "skill" ? path : `${WORKFLOWS_DIR}/${place.name}/README.md`;
    const front = texts.get(held);
    if (!front) continue;
    const said = learnedFront(front.text);
    const item: LearnedView = { name: place.name, file: path, ...(place.kind === "workflow" ? { readme: held } : {}), description: said?.description ?? "", status: learnedStatus(front.text), run: runs.get(path) ?? null, bytes: size, etag: etagOf(front.oid) };
    const history = changes.get(held);
    if (history?.last) item.last_change = history.last;
    if (item.status === "retired") item.retired = retiredOf(history);
    (place.kind === "skill" ? skills : workflows).push(item);
  }
  const byName = (a: LearnedView, b: LearnedView) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const found = { skills: skills.sort(byName), workflows: workflows.sort(byName) };
  learnedAtCache.set(key, found, [...skills, ...workflows].reduce((n, item) => n + item.description.length + 512, 0));
  return found;
}

/** A skill or a draft as the view shows it, cut of the host's secrets: a name or a file holding one reads [redacted]. */
const learnedView = (item: LearnedView, shown: Shown): LearnedView => ({ ...item, name: shown.name(item.name), file: shown.name(item.file), ...(item.readme ? { readme: shown.name(item.readme) } : {}), description: shown.text(item.description) });

/** A note as the view shows it, cut of the host's secrets: its name and the one that superseded it whole; with its
 *  ETag, the one its file's GET answers, so an edit or a retire from the card names the version it shows. */
const noteView = ({ file, name, description, type, status, origin, superseded_by, text, oid }: Note, shown: Shown, runs: NoteRuns): NoteView => ({ file: shown.name(file), name: shown.text(name), description: shown.text(description), type, status, origin, superseded_by: superseded_by === null ? null : shown.name(superseded_by), text: shown.text(text), etag: etagOf(oid), runs: { ...(runs.get(file) ?? { given: 0, read: 0 }) } });

const cursorOf = (sha: string, offset: number) => Buffer.from(`${sha}.${offset}`).toString("base64url");
/** A page of `all`, from `offset`, at most `limit`, each shown by `view` (so only the page's are cut of secrets). */
const pageOf = <T, U>(all: readonly T[], sha: string, offset: number, limit: number, view: (item: T) => U): Page<U> => ({ items: all.slice(offset, offset + limit).map(view), total: all.length, next_cursor: offset + limit < all.length ? cursorOf(sha, offset + limit) : null });

/** A page's request: its limit (1 to PAGE_MAX), and the commit and offset its cursor names, a commit of the folder's. */
async function pageRequest(home: string, repo: string, query: URLSearchParams, fallback: number): Promise<{ limit: number; at?: { sha: string; offset: number } }> {
  const given = query.get("limit");
  const limit = given === null ? fallback : Number(given);
  if ((given !== null && !/^\d+$/.test(given)) || limit < 1 || limit > PAGE_MAX) throw new ApiError("bad_request", `limit is an integer from 1 to ${PAGE_MAX}`);
  const cursor = query.get("cursor");
  if (cursor === null) return { limit };
  const named = /^([0-9a-f]{40}|[0-9a-f]{64})\.(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  const known = named && (await git(home, repo, ["cat-file", "-e", `${named[1]}^{commit}`]).then(() => true, () => false));
  if (!named || !known) throw new ApiError("bad_request", "cursor is not one this server gave");
  return { limit, at: { sha: named[1]!, offset: Number(named[2]) } };
}

/** For tests: how many times a pending count was read from a folder (once per commit of its main). */
export const pendingTestHooks = { reads: 0 };
/** By agent: its folder's main commit and how many of its items wait for the owner's OK there. */
const pendingBy = new Map<string, { sha: string; pending: number }>();
const pendingReads = new Map<string, Promise<number>>();

/** How many of agent `agentId`'s learned items wait for its owner's OK on its folder's main: notes, skills and workflow
 *  drafts held with `status: pending`, as the learning view reads them (notesAt, learnedAt). Read once per commit of
 *  main (a list of agents asks for every agent): the commit is resolved each time, the folder only when it moved. A
 *  folder never made has none waiting; one that cannot be read is undefined (the caller shows no count). */
export async function pendingCount(data: string, agentId: string): Promise<number | undefined> {
  try {
    const { home, repo } = await placeOf(data, agentId);
    // A folder never made (no .git) holds nothing yet: 0. One whose .git git cannot read (an invalid repository, git
    // missing) is unknown: undefined, so the count is left out rather than shown as 0.
    if (existsSync(join(repo, ".git")) && !(await git(home, repo, ["rev-parse", "--git-dir"]).then(() => true, () => false))) return undefined;
    const sha = await mainOf(home, repo);
    if (!sha) return 0;
    const known = pendingBy.get(agentId);
    if (known?.sha === sha) return known.pending;
    // Requests that miss together share one read of the commit (cleared once it settles, so a failure is not kept).
    const key = `${agentId}\0${sha}`;
    let reading = pendingReads.get(key);
    if (!reading) {
      pendingTestHooks.reads += 1;
      reading = Promise.all([notesAt(home, repo, sha), learnedAt(home, repo, sha)]).then(([{ notes }, { skills, workflows }]) => {
        const pending = notes.filter((note) => note.status === "pending").length + [...skills, ...workflows].filter((item) => item.status === "pending").length;
        pendingBy.set(agentId, { sha, pending });
        return pending;
      });
      pendingReads.set(key, reading);
      void reading.finally(() => pendingReads.delete(key)).catch(() => undefined);
    }
    return await reading;
  } catch {
    return undefined;
  }
}

/** GET /agents/{id}/learning: main, its index, the first page of its notes and of its log, and how the agent's runs
 *  fared and what learning changed for them (`counts`, `impact`: learning-run.ts, from the runs' rows and the learning
 *  ledger); an agent with no folder (its learning never on) has an empty one. */
export async function agentLearning(data: string, agentId: string, shown: Shown, counts: Counts, impact: Impact, runs: NoteRuns = new Map()) {
  const { home, repo } = await placeOf(data, agentId);
  const sha = await mainOf(home, repo);
  if (!sha) return { agent: agentId, main: null, index: "", notes: EMPTY, skills: [], workflows: [], log: EMPTY, counts, impact };
  const [{ index, notes, changes }, { skills, workflows }, log] = await Promise.all([notesAt(home, repo, sha), learnedAt(home, repo, sha), logPage(home, repo, sha, 0, LOG_PAGE, shown)]);
  // Each note's last change, from the notes' walk; a skill's or a draft's is on it (learnedAt). A retired one says when
  // and by whom it was retired, from the same change.
  return { agent: agentId, main: sha, index: shown.text(index), notes: pageOf(notes, sha, 0, NOTES_PAGE, (note) => withChanges(noteView(note, shown, runs), changes.get(note.file))), skills: skills.map((item) => learnedView(item, shown)), workflows: workflows.map((item) => learnedView(item, shown)), log, counts, impact };
}

/** GET /agents/{id}/learning/notes?cursor=&limit=&status=: a page of the notes, ordered as the view's, from what the
 *  commit's first read kept. */
export async function learningNotes(data: string, agentId: string, query: URLSearchParams, shown: Shown, runs: NoteRuns = new Map()): Promise<Page<NoteView>> {
  const status = query.get("status");
  if (status !== null && !(NOTE_STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${NOTE_STATUSES.join(", ")}`);
  const { home, repo } = await placeOf(data, agentId);
  const { limit, at } = await pageRequest(home, repo, query, NOTES_PAGE);
  const sha = at?.sha ?? (await mainOf(home, repo));
  if (!sha) return EMPTY;
  const { notes, changes } = await notesAt(home, repo, sha);
  const listed = status === null ? notes : notes.filter((note) => note.status === status);
  return pageOf(listed, sha, at?.offset ?? 0, limit, (note) => withChanges(noteView(note, shown, runs), changes.get(note.file)));
}

/** GET /agents/{id}/learning/log?cursor=&limit=: a page of the changes on main, newest first, reading only its own. */
export async function learningLog(data: string, agentId: string, query: URLSearchParams, shown: Shown): Promise<Page<Change>> {
  const { home, repo } = await placeOf(data, agentId);
  const { limit, at } = await pageRequest(home, repo, query, LOG_PAGE);
  const sha = at?.sha ?? (await mainOf(home, repo));
  if (!sha) return EMPTY;
  return logPage(home, repo, sha, at?.offset ?? 0, limit, shown);
}

/** The file a route names, decoded, for its `use`: a note's name; for a read MEMORY.md too, and a skill's SKILL.md or a
 *  draft's workflow.json or README.md (`skills/<name>/SKILL.md`, percent-encoded); for an approval a skill's SKILL.md or
 *  a draft's README.md, the file that says it waits. Anything else is 400. The name is never echoed. */
function fileOf(raw: string, use: "read" | "write" | "approve" | "retire" | "restore"): string {
  let file: string;
  try {
    file = decodeURIComponent(raw);
  } catch {
    throw new ApiError("bad_request", "the file name is not percent-encoded right");
  }
  const place = learnedPlace(file);
  if (place) {
    if (!learnedName(place.kind, place.name)) throw new ApiError("bad_request", "A skill's folder is named with lowercase letters, digits and single dashes, a workflow's with lowercase letters, digits, dashes and underscores.");
    if (use === "write") throw new ApiError("bad_request", "A skill or a workflow is changed by a run's learning, approved by its owner, or retired: a person edits and creates notes.");
    if (use === "approve" && place.kind === "workflow") throw new ApiError("bad_request", "A workflow is approved by its README.md, the file that says it waits.");
    if (use === "retire" && place.kind === "workflow") throw new ApiError("bad_request", "A workflow is retired by its README.md, the file that says whether it is in use.");
    if (use === "restore" && place.kind === "workflow") throw new ApiError("bad_request", "A workflow is restored by its README.md, the file that says whether it is in use.");
    return file;
  }
  if (file === INDEX_FILE && use !== "read") throw new ApiError("bad_request", "MEMORY.md is built by the server from the active notes, one line each, and is never written: edit, create or retire a note instead.");
  if (file !== INDEX_FILE && !NOTE_FILE.test(file)) throw new ApiError("bad_request", "A learning file is a note's name at the folder's top: letters, digits, dots, dashes and underscores, starting with a letter or digit, ending .md.");
  return file;
}

/** GET /agents/{id}/learning/files/{file}: the file on main as text, its ETag, and its type (a draft's workflow.json is
 *  JSON). */
export async function readNote(data: string, agentId: string, raw: string, shown: Shown): Promise<{ text: string; etag: string; type?: string }> {
  const file = fileOf(raw, "read");
  const { home, repo } = await placeOf(data, agentId);
  const sha = await mainOf(home, repo);
  const found = sha ? await fileAt(home, repo, sha, file) : undefined;
  if (!found) throw new ApiError("not_found", "the agent's learning folder has no such file on main");
  return { text: shown.text(found.text), etag: etagOf(found.oid), ...(file.endsWith(".json") ? { type: "application/json; charset=utf-8" } : {}) };
}

/** A note (or a skill's or draft's file) as a text answer: its ETag, an explicit type (markdown unless it names one),
 *  nosniff, and a sandbox on whatever opens it. */
export function sendNote(res: ServerResponse, status: number, note: { text: string; etag: string; type?: string }, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": note.type ?? "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", etag: note.etag, ...headers });
  res.end(note.text);
}

/** A PUT's body, read to its end (over `max` bytes is 413): the note's whole text, as `text/markdown` or `text/plain`, or
 *  as `application/json` `{text}`, the one form the console's page may send under its session (page.ts: a write from
 *  the page is JSON from its own origin). A JSON body that is not an object is 400; one whose `text` is missing or not
 *  text, or with another field, is 422 by field, as every JSON body here. */
export async function noteBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const json = type === "application/json";
  if (!json && type !== "text/markdown" && type !== "text/plain") throw new ApiError("unsupported_media_type", "the body is the note's whole text, front matter included: text/markdown or text/plain, or application/json {text}");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) throw new ApiError("payload_too_large", `the body is over ${max} bytes`, { details: { limit: "max_body_bytes" } });
  if (!json) return Buffer.concat(chunks);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new ApiError("bad_request", "the body is not JSON");
  }
  if (!isObject(value)) throw new ApiError("bad_request", "the body is not a JSON object");
  const issues = Object.keys(value).filter((key) => key !== "text").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
  // A lone surrogate is no text: UTF-8 would carry it as U+FFFD, a note other than the one sent.
  if (typeof value.text !== "string" || /\p{Cs}/u.test(value.text)) issues.push({ field: "text", reason: value.text === undefined ? "missing" : "wrong_type", message: "text is the note's whole text, front matter included" });
  if (issues.length) throw invalid(issues);
  return Buffer.from(value.text as string, "utf8");
}

const refused = (problems: Problem[]) => new ApiError("bad_request", `The note does not pass the checks: ${[...new Set(problems.map((problem) => problem.rule))].join(", ")}.`, { problems });

/** What a write's headers ask (RFC 9110 13.1): If-Match, the ETags of the note as GET answered it, or for a PUT
 *  If-None-Match: *, only if the name is not taken. Neither, or If-Match: *, which names no version read, is 428. */
function conditionOf(ifMatch: string | undefined, ifNoneMatch: string | undefined, put: boolean): { match?: string[]; absent: boolean } {
  const match = ifMatch?.split(",").map((tag) => tag.trim()).filter(Boolean);
  const absent = put && ifNoneMatch?.trim() === "*";
  if (match?.includes("*")) throw new ApiError("precondition_required", "If-Match: * names no version: send the note's ETag, as GET answered it.");
  if (!match?.length && !absent) throw new ApiError("precondition_required", put ? "A write names the version it read: If-Match with the note's ETag to edit it, or If-None-Match: * to create it." : "A retire names the version it read: If-Match with the note's ETag.");
  return { ...(match?.length ? { match } : {}), absent };
}

/** Whether `file` waited for its owner's OK (status pending) just before a person last retired it on `main`'s line. */
async function heldBeforeRetire(home: string, repo: string, main: string, file: string, learned: boolean): Promise<boolean> {
  const retire = line(await git(home, repo, ["log", "--first-parent", "-1", "--format=%H", "--fixed-strings", `--grep=learning: retired by a person: ${file}`, main, "--", file]));
  if (!retire) return false;
  const before = await git(home, repo, ["cat-file", "blob", `${retire}^:${file}`]).then((out) => out.toString("utf8"), () => undefined);
  if (before === undefined) return false;
  if (learned) return learnedStatus(before) === "pending";
  const note = parseNoteFile(file, before);
  return !Array.isArray(note) && note.status === "pending";
}

/** PUT /agents/{id}/learning/files/{file} (`body`, the note's whole text), or POST .../retire or .../approve (`approve`;
 *  no body), as a person: the precondition, then the checks (a retire's and an approve's, the note's format alone: never
 *  its secrets), then one commit on main in the agent's queue, on the folder agentFolder checked: the note, and MEMORY.md
 *  rebuilt from main's notes with it, its message `learning: <edited|created|retired|approved> by a person: <file>` and
 *  a `Changed-By: user` trailer (and `Approved-Via: console` on an approval), main moved
 *  only from the commit it was made on (once more on a main that moved meanwhile), then the checked-out files. A note
 *  the checks refuse is never written to git. A retire of a note that is not active, and an edit that changes nothing,
 *  commit nothing. `refuse`: the host's secrets. */
export async function writeNote(data: string, agentId: string, raw: string, input: { ifMatch?: string; ifNoneMatch?: string; body?: Buffer; refuse: readonly string[]; approve?: boolean; restore?: boolean }): Promise<{ status: 200 | 201; file: string; text: string; etag: string }> {
  const file = fileOf(raw, input.approve ? "approve" : input.restore ? "restore" : input.body === undefined ? "retire" : "write");
  // A skill's SKILL.md or a draft's README.md: only ever approved or retired here.
  const learned = learnedPlace(file);
  const condition = conditionOf(input.ifMatch, input.ifNoneMatch, input.body !== undefined);
  let given: string | undefined;
  if (input.body !== undefined) {
    const { problems, note } = checkNote(file, input.body, input.refuse);
    if (!note) throw refused(problems);
    given = note.text;
  }
  const home = homeOf(data, agentId);
  return withAgentRepo(data, agentId, async () => {
    // The folder through agentFolder, as a run's merge reaches it: a link at the agent's home, its learning/ or its
    // .git is refused (an error, nothing written), never followed. `check` checks again once a create has made .git.
    const check = () => agentFolder(data, agentId);
    const repo = await check();
    for (let tries = 0; ; tries++) {
      const main = await mainOf(home, repo);
      const current = main ? await fileAt(home, repo, main, file) : undefined;
      // A file main holds by this name that is no note (another mode, over FILE_CAP, not UTF-8) is never written over:
      // a create of the name is refused, and an edit or a retire gives no hint to create it.
      const held = current !== undefined || (main !== undefined && (await heldAt(home, repo, main, file)));
      const notNote = "The folder's file by this name on main is no note (not a regular UTF-8 file of at most 1 MiB), and a person's write never replaces it.";
      if (condition.match && !(current && condition.match.includes(etagOf(current.oid)))) throw new ApiError("precondition_failed", current ? "The note changed since it was read (a run's merge, or another edit): read it again." : held ? notNote : "There is no such note on main: create it with If-None-Match: *.");
      if (condition.absent && held) throw new ApiError("precondition_failed", current ? "The folder has a note by this name: read it, then edit it with If-Match." : notNote);
      // A note whose text holds one of the host's secrets as they are now (a value made secret after it was written) is
      // read cut of it, under its own ETag: an edit of what was shown would write the cut over the hidden text. Only a
      // retire reaches it.
      if (given !== undefined && current && secretsShown(input.refuse).holds(current.text)) {
        throw refused([{ rule: "secret_value", path: file, detail: "This note holds a value the server now keeps secret, so its text was shown with that value hidden, and saving would replace the hidden text. Retire it and write a new note instead." }]);
      }
      let text = given;
      // A note that waits for its owner's OK is made active by an approval alone: an edit keeps it waiting, so one that
      // drops or changes its status is refused, whoever sends it.
      if (given !== undefined && current) {
        const was = parseNoteFile(file, current.text);
        const now = parseNoteFile(file, given);
        if (!Array.isArray(was) && was.status === "pending" && !Array.isArray(now) && now.status !== "pending") throw refused([printable({ rule: "status", path: file, detail: "it waits for its owner's OK: an edit keeps status: pending, only an approval makes it active, and a retire takes it out" }, input.refuse)]);
      }
      // Beside the note itself: what an approve marks of the notes the approved one supersedes.
      const also = new Map<string, string>();
      const notes = main ? (await readAt(home, repo, main)).notes : new Map<string, Note>();
      let heldBefore = false;
      if (input.restore) {
        // Restored, a retired note, skill or draft is active again: given to every later run. It is checked again as a
        // new one is (secrets' shapes, the host's values, hidden characters, its format, every file of a skill's or a
        // draft's folder): a retire takes a leaking one out of every run unchecked, and a restore never brings it back.
        // One that waited for its owner's OK before its retire is recorded as their approval too (Approved-Via).
        heldBefore = await heldBeforeRetire(home, repo, main!, file, Boolean(learned));
        if (learned) {
          const status = learnedStatus(current!.text);
          const kind = learned.kind === "skill" ? "skill" : "workflow";
          if (status !== "retired") throw new ApiError("bad_request", `The ${kind} is not retired: it is ${status}.`);
          text = released(current!.text);
          const problems = skillProblems(text, learned.name).map((detail) => printable({ rule: kind, path: file, detail }, input.refuse));
          const extra = (frontKeys(text) ?? []).filter((key) => !LEARNED_KEYS.includes(key) && key !== "status");
          if (extra.length) problems.push(printable({ rule: "skill_front_matter", path: file, detail: `its front matter sets ${extra.join(", ")}: a learned ${kind} sets name and description alone` }, input.refuse));
          const folder = `${learned.kind === "skill" ? SKILLS_DIR : WORKFLOWS_DIR}/${learned.name}/`;
          const others = (await git(home, repo, ["ls-tree", "-r", "-z", "--name-only", main!, "--", folder])).toString("utf8").split("\0").filter((path) => path && path !== file);
          const changes = [{ path: file, status: "modified" as const, bytes: Buffer.from(text, "utf8") }, ...(await Promise.all(others.map(async (path) => ({ path, status: "modified" as const, bytes: await git(home, repo, ["cat-file", "blob", `${main}:${path}`]) }))))];
          problems.push(...unstorable(changes, input.refuse));
          if (problems.length) throw refused(problems);
        } else {
          const note = parseNoteFile(file, current!.text);
          if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
          if (note.status !== "retired") throw new ApiError("bad_request", `The note is not retired: it is ${note.status}.`);
          text = approve(current!.text);
          const { problems } = checkNote(file, Buffer.from(text, "utf8"), input.refuse);
          if (problems.length) throw refused(problems);
          // What it supersedes, and is active still, is superseded now, as an approval marks it.
          for (const old of note.supersedes) if (notes.get(old)?.status === "active") also.set(old, supersede(notes.get(old)!.text, file));
        }
      } else if (text === undefined && learned && !input.approve) {
        // Retired, as a note is: no later run is given it. One already retired is answered as it is; nothing else in
        // the folder changes.
        if (learnedStatus(current!.text) === "retired") return { status: 200, file, text: current!.text, etag: etagOf(current!.oid) };
        text = retiredLearned(current!.text);
      } else if (text === undefined && learned) {
        // Approved, it is no longer held: given to every later run. Nothing else in the folder changes.
        if (!isHeld(current!.text)) throw new ApiError("bad_request", `The ${learned.kind === "skill" ? "skill" : "workflow"} is not waiting for an OK: it is ${learnedStatus(current!.text)}.`);
        text = released(current!.text);
      } else if (text === undefined && input.approve) {
        const note = parseNoteFile(file, current!.text);
        if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
        if (note.status !== "pending") throw new ApiError("bad_request", `The note is not waiting for an OK: it is ${note.status}.`);
        // Approved, it is active: in the index, and every later run reads it. What it supersedes, and is active still, is
        // superseded now, as a run's merge marks it.
        text = approve(current!.text);
        for (const old of note.supersedes) if (notes.get(old)?.status === "active") also.set(old, supersede(notes.get(old)!.text, file));
      } else if (text === undefined) {
        const note = parseNoteFile(file, current!.text);
        if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
        // A pending note is retired too: a person who will never approve it takes it out of the folder's waiting list.
        if (note.status !== "active" && note.status !== "pending") return { status: 200, file, text: current!.text, etag: etagOf(current!.oid) };
        // A retire is how a person takes a note out of every later run's prompt, a leaking one above all, so it always
        // can: only the note's format is checked as retired (its front matter parses, and it fits the note cap with the
        // status line added), never a secret in its name or text. Every answer cuts those as any read does.
        text = retire(current!.text);
        const retired = parseNoteFile(file, text);
        if (Array.isArray(retired)) throw refused(retired.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
        const size = Buffer.byteLength(text);
        if (size > CAPS.note + RETIRED_LINE) throw refused([printable({ rule: "too_large", path: file, detail: `${size} bytes as retired; the cap is ${CAPS.note}, and the status line a retire adds` }, input.refuse)]);
      }
      if (current && text === current.text) return { status: 200, file, text, etag: etagOf(current.oid) };
      const after = learned ? [...notes.values()] : [...[...notes.values()].filter((note) => note.file !== file && !also.has(note.file)), parseNoteFile(file, text) as LearnedNote, ...[...also].map(([old, marked]) => parseNoteFile(old, marked) as LearnedNote)];
      const lines = after.filter((note) => note.status === "active").length;
      if (lines > INDEX_LINES) throw refused([{ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so retire a note first` }]);
      const parent = main ?? (await openAgentRepo(home, repo, check));
      const subject = `learning: ${input.approve ? "approved" : input.restore ? "restored" : given === undefined ? "retired" : current ? "edited" : "created"} by a person: ${file}`;
      const env = { GIT_INDEX_FILE: join(repo, ".git", "person.index") };
      let commit: string;
      let oid: string;
      try {
        await rm(env.GIT_INDEX_FILE, { force: true });
        await git(home, repo, ["read-tree", parent], "", env);
        oid = line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], text));
        const index = line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], buildIndex(after)));
        let entries = `100644 ${oid}\t${file}\x00100644 ${index}\t${INDEX_FILE}\x00`;
        for (const [old, marked] of also) entries += `100644 ${line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], marked))}\t${old}\x00`;
        await git(home, repo, ["update-index", "-z", "--index-info"], entries, env);
        const tree = line(await git(home, repo, ["write-tree"], "", env));
        // Who approved, and how, in the trailers; the commit's own date is when. Never the note's text.
        const trailers = input.approve || heldBefore ? `${BY_USER}\n${APPROVED_VIA}` : BY_USER;
        commit = line(await git(home, repo, ["commit-tree", tree, "-p", parent, "-m", subject, "-m", trailers]));
      } finally {
        await rm(env.GIT_INDEX_FILE, { force: true });
      }
      try {
        await git(home, repo, ["update-ref", "-m", subject, "refs/heads/main", commit, parent]);
      } catch (error) {
        // Lost to a write since main was read: the precondition asked again of the main that won, never forced over it.
        if (tries === 0 && (await mainOf(home, repo)) !== parent) continue;
        throw error;
      }
      const failed = await checkOut(repo, commit);
      if (failed) process.stderr.write(`agentrun-serve: the agent ${agentId}'s learning files are not main's: ${failed.message}\n`);
      return { status: current ? 200 : 201, file, text, etag: etagOf(oid) };
    }
  });
}

/** GET /runs/{id}/learning: the run's learning whole, or null for a run that does not learn: its detail cut of the
 *  host's secrets now, and the notes it read and learned as its view shows them (learning.ts notesView). */
export async function runLearning(run: Run, shown: Shown, secrets: readonly string[]) {
  const learning = run.meta.learning;
  if (!learning) return null;
  const pin = await readPin(run.dir).catch(() => undefined);
  const { state, reason, at, verdict, problems, merged, cost_usd, tokens, pending } = learning;
  return {
    run: run.id, state, reason, detail: detailShown(learning, shown), at,
    // Once it settled (a run that runs again for a follow-up is still reading).
    ...notesView(learning, shown, run.settled),
    seed: pin?.seed ?? null,
    merged: merged ?? null,
    // The merge's notes that wait for a person's OK: on main as `status: pending`, read by no run until approved.
    pending: (pending ?? []).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })),
    // The grader's, with its item for each new note: a name holding one of the host's secrets reads [redacted], and
    // each text is cut of them.
    verdict: verdict ? { merge: verdict.merge, reason: shown.text(verdict.reason), items: (verdict.items ?? []).map(({ file, keep, pending: waits, origin, question, why }) => ({ file: shown.name(file), keep, ...(waits ? { pending: true } : {}), ...(origin ? { origin } : {}), ...(question ? { question: shown.text(question) } : {}), why: shown.text(why) })) } : null,
    problems: (problems ?? []).map((problem) => printable(problem, secrets)),
    // The grade's alone: the end-of-run turn's cost is in the run's own totals.
    cost_usd: { grade: cost_usd?.grade ?? null },
    tokens: { grade: tokens?.grade ?? null },
  };
}

/** `text`, an added file, as git's unified diff writes it, hunks only. */
function addedPatch(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  const last = lines.pop()!;
  const added = [...lines.map((one) => `+${one}\n`), ...(last ? [`+${last}\n\\ No newline at end of file\n`] : [])];
  return `@@ -0,0 +1${added.length === 1 ? "" : `,${added.length}`} @@\n${added.join("")}`;
}

/** GET /runs/{id}/learning/diff: once merged, its merge commit against its parent, as git diffs them; before, its proposal
 *  (new notes only) against its seed; a run that proposed nothing, no file. A file's patch is withheld when too large, or
 *  when it holds one of the host's secrets now. */
export async function runDiff(data: string, run: Run, shown: Shown) {
  const learning = run.meta.learning;
  if (!learning) throw new ApiError("not_found", "the run does not learn, so it proposed nothing");
  const file = (name: string, status: string, patch: string) => {
    const path = shown.name(name);
    return Buffer.byteLength(patch) > PATCH_CAP ? { path, status, withheld: "too_large" } : shown.holds(patch) ? { path, status, withheld: "secret" } : { path, status, patch };
  };
  if (learning.merged) {
    const { home, repo } = await placeOf(data, run.agentId);
    const head = learning.merged;
    const base = /^[0-9a-f]{40,64}$/.test(head) ? await git(home, repo, ["rev-parse", "--verify", "--quiet", `${head}^1`]).then(line, () => undefined) : undefined;
    if (!base) throw new ApiError("not_found", "the run's merge is not in its agent's learning folder");
    const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
    const listed = (await git(home, repo, [...diff, "--name-status", "-z", base, head])).toString("utf8").split("\0").filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < listed.length; i += 2) {
      const status = ({ A: "added", D: "deleted" } as Record<string, string>)[listed[i]![0]!] ?? "modified";
      const raw = (await git(home, repo, [...diff, "--text", "-U3", base, head, "--", listed[i + 1]!])).toString("utf8");
      const at = raw.search(/^@@/m);
      files.push(file(listed[i + 1]!, status, at < 0 ? "" : raw.slice(at)));
    }
    return { base, head, files };
  }
  const proposal = await readJson(join(run.dir, PROPOSAL));
  const notes = isObject(proposal) && typeof proposal.seed === "string" && Array.isArray(proposal.notes) ? proposal.notes.filter((note): note is { file: string; text: string } => isObject(note) && typeof note.file === "string" && NOTE_FILE.test(note.file) && typeof note.text === "string") : undefined;
  if (notes) return { base: proposal!.seed as string, head: null, files: notes.map((note) => file(note.file, "added", addedPatch(note.text))) };
  return { base: (await readPin(run.dir).catch(() => undefined))?.seed ?? null, head: null, files: [] };
}
