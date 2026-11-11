// What a person sees and controls of an agent's learning: this server's own routes under /v2 (learning/1).
// - Per agent: main's index, its notes and its log of changes, each a page, its skills and workflow drafts, and how its
//   runs' learning fared; one note, a skill's SKILL.md or a draft's file as text with its ETag, its blob id on main.
// - A person's approval of a note, a skill or a draft that waits for the owner's OK, and their edit, create or retire of
//   one note (a skill or a draft is a run's to change): a precondition on the note's version (If-Match, or If-None-Match: * to
//   create; neither is 428), the structural checks a run's notes pass (learn/check.ts checkNote; a retire, the note's
//   format alone, so a leaking note can always be revoked) and no grader, then one commit on main by the learning
//   script (learn/folder.ts writeLearning: one exec, compare and swap), with MEMORY.md rebuilt and a `Changed-By: user`
//   trailer, the checked-out files brought in line and the snapshot written. MEMORY.md itself is never written here.
// - Per run: its learning whole, and its diff: what it proposed against its seed, or once merged, its merge commit against
//   its parent, as its merge's script wrote it (`.agentrun/diffs/<run>.json`).
// Every read is the folder's snapshot (`.agentrun/snapshot.json`), the working-tree bodies it names, each checked against
// its blob id, and the diff files, through the folder's Workspace file API: no git and no exec (learn/folder.ts
// readLearning). A body that is not the snapshot's, twice, is a write in flight: 503. A page's cursor names the main it
// was read at; a later page is read at that main while this server still holds its snapshot, else as the first page of
// main now. A text that leaves holding one of the host's secrets as they are now (a value made secret after it was
// written) is cut of it, a file's name holding one reads "[redacted]" whole, and a diff's file holding one is withheld.
import type { IncomingMessage, ServerResponse } from "node:http";
import { approve, buildIndex, CAPS, checkNote, draftProblems, frontKeys, INDEX_FILE, INDEX_LINES, isHeld, LEARNED_KEYS, type LearnedNote, learnedName, learnedPlace, learnedStatus, NOTE_FILE, NOTE_STATUSES, parseNoteFile, type Problem, printable, released, retire, retiredLearned, skillProblems, SKILLS_DIR, supersede, unstorable, WORKFLOWS_DIR } from "./learn/index.js";
import { beforeRetire, blobOid, type FolderChange, FolderBusy, FolderRefused, FolderTooLarge, FolderUnreadable, heldOnMain, isBodyMismatch, type PersonKind, readLearning, PATCH_CAP, readRunDiff, readSnapshot, type SnapChange, type SnapHistory, type SnapLearned, type SnapNote, type Snapshot, snapshotNotes, writeLearning } from "./learn/folder.js";
import { ApiError, invalid } from "./errors.js";
import { type ItemStatus, detailShown, type Learning, learningFolderOf, type NoteRuns, notesView, reasonShown, secretsShown, type Shown, withAgentRepo } from "./learning.js";
import type { Impact } from "./learning-run.js";
import { isObject } from "./validate.js";
import type { Workspace } from "./workspace/index.js";
import { launchOf } from "./handed-values.js";
import { learningStartOf } from "./run-launch.js";
import { runLearningEnd } from "./store-reads/learning.js";
import type { Store } from "./store/store.js";

/** The agent view's first pages, and the most a page holds. */
const NOTES_PAGE = 50;
const LOG_PAGE = 20;
const PAGE_MAX = 200;
/** What a retire adds to a note, on top of the note cap a retired note may fill (learn/notes.ts retire). */
const RETIRED_LINE = Buffer.byteLength("status: retired\n");

type Page<T> = { items: T[]; total: number; next_cursor: string | null };
type NoteView = { file: string; name: string; description: string; type: string; status: string; origin: string; superseded_by: string | null; text: string; etag: string; retired?: Retired; last_change?: LastChange; runs: { given: number; read: number } };
/** When a retired note, skill or draft was retired, and by whom: a person (its retire's commit), else a run. */
type Retired = { at: string; by: "person" | "run" };
/** The newest change to a note, skill or draft (its file: the note, a SKILL.md, a draft's README.md): what it was, by
 *  whom and when. A person's is named by its commit (`learning: <kind> by a person: <file>`); a run's merge is `learned`. */
type LastChange = { kind: "approved" | "edited" | "created" | "retired" | "restored" | "learned" | "superseded"; by: "person" | "run"; at: string };
type Change = { by: { run: string } | { user: true; via?: string }; commit: string; at: string; reason: string; files: string[] };
export type Counts = { merged: number; dropped: Record<string, number>; in_progress: number };
export { secretsShown, type Shown } from "./learning.js";

/** The few values last kept, by key, oldest dropped first: at most `entries` of them. */
class Recent<T> {
  private readonly held = new Map<string, T>();
  constructor(private readonly entries: number) {}
  get(key: string): T | undefined {
    const hit = this.held.get(key);
    if (hit === undefined) return undefined;
    this.held.delete(key);
    this.held.set(key, hit);
    return hit;
  }
  set(key: string, value: T): void {
    this.held.delete(key);
    this.held.set(key, value);
    while (this.held.size > this.entries) this.held.delete(this.held.keys().next().value!);
  }
}

/** The snapshots this server read last, by the folder's agent and main: a later page's cursor names one of them. */
const seen = new Recent<Snapshot>(16);
const seenKey = (agentId: string, main: string) => `${agentId}\0${main}`;

export const etagOf = (oid: string) => `"${oid}"`;
const EMPTY: Page<never> = { items: [], total: 0, next_cursor: null };

/** A folder failure as a route answers it, failing closed: a link in the folder is an error whose words name it, a
 *  backend that cannot answer (or a body that changed twice as it was read) is 503. */
function routeFailure(error: unknown): unknown {
  if (error instanceof FolderBusy) return new ApiError("unavailable", error.message);
  if (error instanceof FolderUnreadable) return error.link ? new Error(error.message) : new ApiError("unavailable", error.message);
  return error;
}

/** A read of agent `agentId`'s folder: `read` over its snapshot and the bodies it names (learn/folder.ts readLearning),
 *  `none` for a folder with no main yet; the folder ended after. */
async function reading<T>(data: string, agentId: string, read: (folder: { ws: Workspace; snapshot: Snapshot; body: (path: string, oid: string) => Promise<string> }) => Promise<T>, none: () => T): Promise<T> {
  const { workspace: ws, end } = learningFolderOf(data, agentId);
  try {
    return await readLearning(ws, async ({ snapshot, body }) => {
      if (!snapshot) return none();
      seen.set(seenKey(agentId, snapshot.main), snapshot);
      return read({ ws, snapshot, body });
    });
  } catch (error) {
    throw routeFailure(error);
  } finally {
    await end();
  }
}

/** A retired item's `retired`: its newest retire by a person; else, one a person made retired another way (an edit to
 *  status: retired, or created so), their newest change; else (retired by none of theirs) its newest change's time. */
const retiredOf = (history: SnapHistory): Retired => (history.retire ? { at: history.retire.at, by: "person" } : history.person ? { at: history.person.at, by: "person" } : { at: history.at, by: "run" });

/** A note as the view shows it, cut of the host's secrets: its name and the one that superseded it whole; with its
 *  ETag, the one its file's GET answers, so an edit or a retire from the card names the version it shows; its last
 *  change, and when and by whom it was retired on a retired one. */
const noteView = (note: SnapNote, text: string, shown: Shown, runs: NoteRuns): NoteView => ({
  file: shown.name(note.file), name: shown.text(note.name), description: shown.text(note.description), type: note.type, status: note.status, origin: note.origin, superseded_by: note.superseded_by === null ? null : shown.name(note.superseded_by), text: shown.text(text), etag: etagOf(note.oid), runs: { ...(runs.get(note.file) ?? { given: 0, read: 0 }) },
  ...(note.history.last ? { last_change: note.history.last } : {}),
  ...(note.status === "retired" ? { retired: retiredOf(note.history) } : {}),
});

/** A skill or a workflow draft as the view lists it: its folder's name, its file (a skill's SKILL.md, a draft's
 *  workflow.json, with its `readme`), its description, `pending` while it waits for its owner's OK, the run whose merge
 *  last changed it, its size in bytes, and the ETag of the file that says whether it waits (a SKILL.md, a README.md),
 *  which an approval names; cut of the host's secrets (a name or a file holding one reads [redacted]). */
type LearnedView = { name: string; file: string; readme?: string; description: string; status: "active" | "pending" | "retired"; run: string | null; bytes: number; etag: string; retired?: Retired; last_change?: LastChange };
function learnedView(item: SnapLearned, kind: "skill" | "workflow", shown: Shown): LearnedView {
  const file = kind === "skill" ? item.file : `${WORKFLOWS_DIR}/${item.name}/workflow.json`;
  const bytes = item.files.find(({ path }) => path === file)?.bytes ?? item.bytes;
  return {
    name: shown.name(item.name), file: shown.name(file), ...(kind === "workflow" ? { readme: shown.name(item.file) } : {}), description: shown.text(item.description), status: item.status, run: item.run, bytes, etag: etagOf(item.oid),
    ...(item.history.last ? { last_change: item.history.last } : {}),
    ...(item.status === "retired" ? { retired: retiredOf(item.history) } : {}),
  };
}

/** A change on main as the log shows it, cut of the host's secrets. */
const changeView = (change: SnapChange, shown: Shown): Change => ({ by: change.by, commit: change.commit, at: change.at, reason: shown.text(change.reason), files: change.files.map(shown.name) });

const cursorOf = (sha: string, offset: number) => Buffer.from(`${sha}.${offset}`).toString("base64url");

/** A page's request: its limit (1 to PAGE_MAX), and the main and offset its cursor names. */
function pageRequest(query: URLSearchParams, fallback: number): { limit: number; at?: { sha: string; offset: number } } {
  const given = query.get("limit");
  const limit = given === null ? fallback : Number(given);
  if ((given !== null && !/^\d+$/.test(given)) || limit < 1 || limit > PAGE_MAX) throw new ApiError("bad_request", `limit is an integer from 1 to ${PAGE_MAX}`);
  const cursor = query.get("cursor");
  if (cursor === null) return { limit };
  const named = /^([0-9a-f]{40}|[0-9a-f]{64})\.(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!named) throw new ApiError("bad_request", "cursor is not one this server gave");
  return { limit, at: { sha: named[1]!, offset: Number(named[2]) } };
}

/** The snapshot a page reads, and from where: main now's, or the one its cursor names while this server holds it
 *  (`older`), else main now's from its first item. */
function pageAt(agentId: string, snapshot: Snapshot, at: { sha: string; offset: number } | undefined): { snapshot: Snapshot; offset: number; older: boolean } {
  if (!at) return { snapshot, offset: 0, older: false };
  if (at.sha === snapshot.main) return { snapshot, offset: at.offset, older: false };
  const kept = seen.get(seenKey(agentId, at.sha));
  return kept ? { snapshot: kept, offset: at.offset, older: true } : { snapshot, offset: 0, older: false };
}

/** A page of `notes`, from `offset`, at most `limit`, each with its text (only the page's are read and cut of
 *  secrets). */
async function notesPage(notes: readonly SnapNote[], main: string, offset: number, limit: number, body: (path: string, oid: string) => Promise<string>, shown: Shown, runs: NoteRuns): Promise<Page<NoteView>> {
  const items = await Promise.all(notes.slice(offset, offset + limit).map(async (note) => noteView(note, await body(note.file, note.oid), shown, runs)));
  return { items, total: notes.length, next_cursor: offset + limit < notes.length ? cursorOf(main, offset + limit) : null };
}
/** A page of the changes on main, newest first, cut of the host's secrets. */
const logPage = (snapshot: Snapshot, offset: number, limit: number, shown: Shown): Page<Change> => ({ items: snapshot.log.slice(offset, offset + limit).map((change) => changeView(change, shown)), total: snapshot.log.length, next_cursor: offset + limit < snapshot.log.length ? cursorOf(snapshot.main, offset + limit) : null });

/** For tests: how many times a folder's statuses were read (once per commit of its main). */
export const pendingTestHooks = { reads: 0 };
/** By agent: its folder's main commit and each learned item's status there. */
const statusBy = new Map<string, { sha: string; status: ReadonlyMap<string, ItemStatus> }>();

/** Each learned item's status on agent `agentId`'s folder's main, by file (a note's; a skill's SKILL.md; a workflow
 *  draft's workflow.json, as its README.md says it), from its snapshot: `active`, `pending`, `superseded` or `retired`,
 *  with what a note supersedes. Built once per main (a list asks for many runs). A folder never made, or with no main,
 *  holds none; one whose snapshot cannot be read is undefined. */
export async function statusesOf(data: string, agentId: string): Promise<ReadonlyMap<string, ItemStatus> | undefined> {
  const folder = learningFolderOf(data, agentId);
  try {
    const snapshot = await readSnapshot(folder.workspace);
    if (!snapshot) return new Map();
    const known = statusBy.get(agentId);
    if (known?.sha === snapshot.main) return known.status;
    // Built at once, with no wait between the miss and the keep: requests that miss together build it once.
    pendingTestHooks.reads += 1;
    const status = new Map<string, ItemStatus>([
      ...snapshot.notes.map((note): [string, ItemStatus] => [note.file, { status: note.status, supersedes: note.supersedes }]),
      ...snapshot.skills.map((item): [string, ItemStatus] => [item.file, { status: item.status }]),
      ...snapshot.workflows.map((item): [string, ItemStatus] => [`${WORKFLOWS_DIR}/${item.name}/workflow.json`, { status: item.status }]),
    ]);
    statusBy.set(agentId, { sha: snapshot.main, status });
    return status;
  } catch {
    return undefined;
  } finally {
    await folder.end();
  }
}

/** How many of agent `agentId`'s learned items wait for its owner's OK on its folder's main (statusesOf): notes, skills
 *  and workflow drafts held with `status: pending`. A folder never made has none waiting; one that cannot be read is
 *  undefined (the caller shows no count). */
export async function pendingCount(data: string, agentId: string): Promise<number | undefined> {
  const status = await statusesOf(data, agentId);
  return status === undefined ? undefined : [...status.values()].filter((value) => value.status === "pending").length;
}

/** GET /agents/{id}/learning: main, its index, the first page of its notes and of its log, and how the agent's runs
 *  fared and what learning changed for them (`counts`, `impact`: learning-run.ts, from the runs' rows and the learning
 *  ledger); an agent with no folder (its learning never on) has an empty one. */
type AgentView = { agent: string; main: string | null; index: string; notes: Page<NoteView>; skills: LearnedView[]; workflows: LearnedView[]; log: Page<Change>; counts: Counts; impact: Impact };
export async function agentLearning(data: string, agentId: string, shown: Shown, counts: Counts, impact: Impact, runs: NoteRuns = new Map()): Promise<AgentView> {
  return reading<AgentView>(data, agentId, async ({ snapshot, body }) => {
    const index = snapshot.index.bytes ? await body(INDEX_FILE, snapshot.index.oid) : "";
    const notes = await notesPage(snapshot.notes, snapshot.main, 0, NOTES_PAGE, body, shown, runs);
    return { agent: agentId, main: snapshot.main, index: shown.text(index), notes, skills: snapshot.skills.map((item) => learnedView(item, "skill", shown)), workflows: snapshot.workflows.map((item) => learnedView(item, "workflow", shown)), log: logPage(snapshot, 0, LOG_PAGE, shown), counts, impact };
  }, () => ({ agent: agentId, main: null, index: "", notes: EMPTY, skills: [], workflows: [], log: EMPTY, counts, impact }));
}

/** GET /agents/{id}/learning/notes?cursor=&limit=&status=: a page of the notes, ordered as the view's. A page at an
 *  older main whose notes this server cannot read as they were any more is the first page of main now. */
export async function learningNotes(data: string, agentId: string, query: URLSearchParams, shown: Shown, runs: NoteRuns = new Map()): Promise<Page<NoteView>> {
  const status = query.get("status");
  if (status !== null && !(NOTE_STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${NOTE_STATUSES.join(", ")}`);
  const { limit, at } = pageRequest(query, NOTES_PAGE);
  return reading(data, agentId, async ({ snapshot: now, body }) => {
    const listed = (snapshot: Snapshot) => (status === null ? snapshot.notes : snapshot.notes.filter((note) => note.status === status));
    const page = pageAt(agentId, now, at);
    if (page.older) {
      try {
        return await notesPage(listed(page.snapshot), page.snapshot.main, page.offset, limit, body, shown, runs);
      } catch (error) {
        // A note of that main is not on the folder as it was: the first page of main now.
        if (!isBodyMismatch(error)) throw error;
      }
      return notesPage(listed(now), now.main, 0, limit, body, shown, runs);
    }
    return notesPage(listed(page.snapshot), page.snapshot.main, page.offset, limit, body, shown, runs);
  }, () => EMPTY);
}

/** GET /agents/{id}/learning/log?cursor=&limit=: a page of the changes on main, newest first. */
export async function learningLog(data: string, agentId: string, query: URLSearchParams, shown: Shown): Promise<Page<Change>> {
  const { limit, at } = pageRequest(query, LOG_PAGE);
  return reading(data, agentId, async ({ snapshot }) => {
    const page = pageAt(agentId, snapshot, at);
    return logPage(page.snapshot, page.offset, limit, shown);
  }, () => EMPTY);
}

/** The blob of `file` on the snapshot's main, as a route names it: the index, a note, a skill's SKILL.md, a draft's
 *  README.md or workflow.json; undefined when main holds no such file the snapshot names. */
function blobIn(snapshot: Snapshot | undefined, file: string): string | undefined {
  if (!snapshot) return undefined;
  if (file === INDEX_FILE) return snapshot.index.oid;
  const place = learnedPlace(file);
  if (!place) return snapshot.notes.find((note) => note.file === file)?.oid;
  const items = place.kind === "skill" ? snapshot.skills : snapshot.workflows;
  return items.find((item) => item.name === place.name)?.files.find(({ path }) => path === file)?.oid;
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
  const found = await reading(data, agentId, async ({ snapshot, body }) => {
    const oid = blobIn(snapshot, file);
    return oid === undefined ? undefined : { oid, text: await body(file, oid) };
  }, () => undefined);
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

/** A file main holds by this name that is no note (another mode, over the read cap, not UTF-8, out of shape) is never
 *  written over: a create of the name is refused, and an edit or a retire gives no hint to create it. */
const NOT_NOTE = "The folder's file by this name on main is no note (not a regular UTF-8 file of at most 1 MiB in a note's format), and a person's write never replaces it.";

/** PUT /agents/{id}/learning/files/{file} (`body`, the note's whole text), or POST .../retire or .../approve (`approve`;
 *  no body), as a person: the precondition, then the checks (a retire's and an approve's, the note's format alone: never
 *  its secrets), then one commit on main by the learning script (learn/folder.ts writeLearning), in the agent's queue,
 *  on the agent's learning folder: the note, and MEMORY.md rebuilt from main's notes with it, its message
 *  `learning: <edited|created|retired|approved> by a person: <file>` and a `Changed-By: user` trailer (and
 *  `Approved-Via: console` on an approval), main moved only from the main it read (computed again on a main that moved
 *  meanwhile), then the checked-out files and the snapshot. A note the checks refuse is never written to git. A retire
 *  of a note that is not active, and an edit that changes nothing, commit nothing. `refuse`: the host's secrets. */
export async function writeNote(data: string, agentId: string, raw: string, input: { ifMatch?: string; ifNoneMatch?: string; body?: Buffer; refuse: readonly string[]; approve?: boolean; restore?: boolean; draftTools?: () => Promise<{ tools: string[]; gated: Record<string, string> }> }): Promise<{ status: 200 | 201; file: string; text: string; etag: string }> {
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
  type Written = { status: 200 | 201; file: string; text: string; etag: string };
  return withAgentRepo(data, agentId, async () => {
    // The folder as a run's merge reaches it: a link in it is refused (an error naming it, nothing written), never
    // followed.
    const { workspace: ws, end } = learningFolderOf(data, agentId);
    try {
      const { result } = await writeLearning<Written>(ws, async ({ snapshot, body, bytes }) => {
        const main = snapshot?.main;
        const oid = blobIn(snapshot, file);
        const current = oid === undefined || file === INDEX_FILE ? undefined : { oid, text: await body(file, oid) };
        if (condition.match && !(current && condition.match.includes(etagOf(current.oid)))) {
          const held = !current && main !== undefined && (await heldOnMain(ws, main, file));
          throw new ApiError("precondition_failed", current ? "The note changed since it was read (a run's merge, or another edit): read it again." : held ? NOT_NOTE : "There is no such note on main: create it with If-None-Match: *.");
        }
        if (condition.absent && current) throw new ApiError("precondition_failed", "The folder has a note by this name: read it, then edit it with If-Match.");
        // A note whose text holds one of the host's secrets as they are now (a value made secret after it was written) is
        // read cut of it, under its own ETag: an edit of what was shown would write the cut over the hidden text. Only a
        // retire reaches it. So is one holding a loopback address, read as "a local address" (secretsShown).
        if (given !== undefined && current && secretsShown(input.refuse).holds(current.text)) {
          throw refused([{ rule: "secret_value", path: file, detail: "This note holds a value the server now keeps secret, so its text was shown with that value hidden, and saving would replace the hidden text. Retire it and write a new note instead." }]);
        }
        if (given !== undefined && current && secretsShown(input.refuse).text(current.text) !== current.text) {
          throw refused([{ rule: "note", path: file, detail: "This note holds a local address, so its text was shown with it hidden, and saving would replace it. Retire it and write a new note instead." }]);
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
        const notes = new Map(snapshotNotes(snapshot).map((note) => [note.file, note]));
        const noteOid = (name: string) => snapshot!.notes.find((note) => note.file === name)!.oid;
        const mark = async (superseded: readonly string[]) => {
          for (const old of superseded) if (notes.get(old)?.status === "active") also.set(old, supersede(await body(old, noteOid(old)), file));
        };
        let heldBefore = false;
        if (input.restore) {
          // Restored, a retired note, skill or draft is active again: given to every later run. It is checked again as a
          // new one is (secrets' shapes, the host's values, hidden characters, its format, every file of a skill's or a
          // draft's folder): a retire takes a leaking one out of every run unchecked, and a restore never brings it back.
          // One that waited for its owner's OK before its retire is recorded as their approval too (Approved-Via).
          const before = await beforeRetire(ws, main!, file);
          heldBefore = before !== undefined && (learned ? learnedStatus(before) === "pending" : ((note) => !Array.isArray(note) && note.status === "pending")(parseNoteFile(file, before)));
          if (learned) {
            const status = learnedStatus(current!.text);
            const kind = learned.kind === "skill" ? "skill" : "workflow";
            if (status !== "retired") throw new ApiError("bad_request", `The ${kind} is not retired: it is ${status}.`);
            text = released(current!.text);
            const problems = skillProblems(text, learned.name).map((detail) => printable({ rule: kind, path: file, detail }, input.refuse));
            const extra = (frontKeys(text) ?? []).filter((key) => !LEARNED_KEYS.includes(key) && key !== "status");
            if (extra.length) problems.push(printable({ rule: "skill_front_matter", path: file, detail: `its front matter sets ${extra.join(", ")}: a learned ${kind} sets name and description alone` }, input.refuse));
            const folder = `${learned.kind === "skill" ? SKILLS_DIR : WORKFLOWS_DIR}/${learned.name}/`;
            const others = (learned.kind === "skill" ? snapshot!.skills : snapshot!.workflows).find((item) => item.name === learned.name)?.files.filter(({ path }) => path !== file) ?? [];
            const changes = [{ path: file, status: "modified" as const, bytes: Buffer.from(text, "utf8") }, ...(await Promise.all(others.map(async ({ path, oid: blob }) => ({ path, status: "modified" as const, bytes: await bytes(path, blob) }))))];
            problems.push(...unstorable(changes, input.refuse));
            // A draft's workflow.json passes the learning checker as a run's would (its tools and the gate's settings), so
            // a restore never brings back a draft no run could run.
            const draft = changes.find(({ path }) => path === `${folder}workflow.json`);
            if (learned.kind !== "skill" && draft && input.draftTools) {
              const { tools, gated } = await input.draftTools();
              const dsl = await import("@parcha/agentrun-dsl");
              for (const { rule, detail } of draftProblems(dsl as never, draft.bytes.toString("utf8"), tools, gated)) problems.push(printable({ rule, path: draft.path, detail }, input.refuse));
            }
            if (problems.length) throw refused(problems);
          } else {
            const note = parseNoteFile(file, current!.text);
            if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
            if (note.status !== "retired") throw new ApiError("bad_request", `The note is not retired: it is ${note.status}.`);
            text = approve(current!.text);
            const { problems } = checkNote(file, Buffer.from(text, "utf8"), input.refuse);
            if (problems.length) throw refused(problems);
            // What it supersedes, and is active still, is superseded now, as an approval marks it.
            await mark(note.supersedes);
          }
        } else if (text === undefined && learned && !input.approve) {
          // Retired, as a note is: no later run is given it. One already retired is answered as it is; nothing else in
          // the folder changes.
          if (learnedStatus(current!.text) === "retired") return { result: { status: 200, file, text: current!.text, etag: etagOf(current!.oid) } };
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
          await mark(note.supersedes);
        } else if (text === undefined) {
          const note = parseNoteFile(file, current!.text);
          if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
          // A pending note is retired too: a person who will never approve it takes it out of the folder's waiting list.
          if (note.status !== "active" && note.status !== "pending") return { result: { status: 200, file, text: current!.text, etag: etagOf(current!.oid) } };
          // A retire is how a person takes a note out of every later run's prompt, a leaking one above all, so it always
          // can: only the note's format is checked as retired (its front matter parses, and it fits the note cap with the
          // status line added), never a secret in its name or text. Every answer cuts those as any read does.
          text = retire(current!.text);
          const retired = parseNoteFile(file, text);
          if (Array.isArray(retired)) throw refused(retired.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
          const size = Buffer.byteLength(text);
          if (size > CAPS.note + RETIRED_LINE) throw refused([printable({ rule: "too_large", path: file, detail: `${size} bytes as retired; the cap is ${CAPS.note}, and the status line a retire adds` }, input.refuse)]);
        }
        if (current && text === current.text) return { result: { status: 200, file, text, etag: etagOf(current.oid) } };
        const after = learned ? [...notes.values()] : [...[...notes.values()].filter((note) => note.file !== file && !also.has(note.file)), parseNoteFile(file, text!) as LearnedNote, ...[...also].map(([old, marked]) => parseNoteFile(old, marked) as LearnedNote)];
        const lines = after.filter((note) => note.status === "active").length;
        if (lines > INDEX_LINES) throw refused([{ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so retire a note first` }]);
        const kind: PersonKind = input.approve ? "approved" : input.restore ? "restored" : given === undefined ? "retired" : current ? "edited" : "created";
        const change: FolderChange = {
          // Who approved, and how, in the trailers; the commit's own date is when. Never the note's text.
          by: { person: kind, file, approved: Boolean(input.approve || heldBefore) },
          writes: [{ path: file, text: text! }, { path: INDEX_FILE, text: buildIndex(after) }, ...[...also].map(([path, marked]) => ({ path, text: marked }))],
          // A create takes a name main holds nothing by, as git holds it: a file the notes leave out included.
          ...(current ? {} : { absent: [file] }),
        };
        return { result: { status: current ? 200 : 201, file, text: text!, etag: etagOf(blobOid(text!)) }, change };
      });
      return result;
    } catch (error) {
      if (error instanceof FolderRefused) throw new ApiError("precondition_failed", NOT_NOTE);
      if (error instanceof FolderTooLarge) throw refused([{ rule: "too_large", path: file, detail: error.message }]);
      throw routeFailure(error);
    } finally {
      await end();
    }
  });
}

/** GET /runs/{id}/learning's body, from the run's learning as it reads now, the seed it started from and whether it
 *  settled: the one shape, read from the one store (store-reads/learning.ts
 *  runLearningOverStore). */
export function runLearningBody(input: { readonly id: string; readonly learning: Learning; readonly seed: string | null; readonly settled: boolean }, shown: Shown, secrets: readonly string[]) {
  const { learning } = input;
  const { state, reason, at, verdict, problems, merged, cost_usd, tokens, pending } = learning;
  return {
    run: input.id, state, reason: reasonShown(reason, shown), detail: detailShown(learning, shown), at,
    // Once it settled (a run that runs again for a follow-up is still reading).
    ...notesView(learning, shown, input.settled),
    seed: input.seed,
    merged: merged ?? null,
    // The merge's notes that wait for a person's OK: on main as `status: pending`, read by no run until approved.
    pending: (pending ?? []).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })),
    // The grader's, with its item for each new note: a name holding one of the host's secrets reads [redacted], and
    // each text is cut of them, its origin too (a kept row read back is untrusted).
    verdict: verdict ? { merge: verdict.merge, reason: shown.text(verdict.reason), items: (verdict.items ?? []).map(({ file, keep, pending: waits, origin, question, why }) => ({ file: shown.name(file), keep, ...(waits ? { pending: true } : {}), ...(origin ? { origin: shown.text(origin) as typeof origin } : {}), ...(question ? { question: shown.text(question) } : {}), why: shown.text(why) })) } : null,
    // Each cut of the host's secrets (printable), then as every served text is (`shown`: no loopback address).
    problems: (problems ?? []).map((problem) => printable(problem, secrets)).map(({ rule, path, detail }) => ({ rule: shown.text(rule) as typeof rule, ...(path === undefined ? {} : { path: shown.text(path) }), detail: shown.text(detail) })),
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

/** GET /runs/{id}/learning/diff over the one store: once merged (its learning end, store-reads/learning.ts
 *  runLearningEnd), its merge commit against its parent, as its merge's script wrote it (`.agentrun/diffs/<run>.json` in
 *  its agent's learning folder); before, its kept proposal (new notes only, from its learning_proposals row) against its
 *  seed; a run that proposed nothing, no file, against the seed its launch's learning start names. A run that does not
 *  learn (no learning start and no learning end) is not_found. A file's patch is withheld when too large (as the script
 *  wrote it), or when it holds one of the host's secrets now (`shown`); any other is served as every learning text is
 *  (`shown.text`: a loopback address reads "a local address"). */
export async function runDiffOverStore(data: string, store: Store, runId: string, shown: Shown) {
  const [end, kept, launch, row] = await Promise.all([runLearningEnd(store, runId), store.learning.proposal(runId), launchOf(store, runId), store.runs.get(runId)]);
  const start = launch ? learningStartOf(launch) : undefined;
  if (!row || (!end && !start)) throw new ApiError("not_found", "the run does not learn, so it proposed nothing");
  const file = (name: string, status: string, patch: string) => {
    const path = shown.name(name);
    if (Buffer.byteLength(patch) > PATCH_CAP) return { path, status, withheld: "too_large" };
    if (shown.holds(patch)) return { path, status, withheld: "secret" };
    const served = shown.text(patch);
    return Buffer.byteLength(served) > PATCH_CAP ? { path, status, withheld: "too_large" } : { path, status, patch: served };
  };
  if (end?.merged) {
    const folder = learningFolderOf(data, row.agentId);
    const diff = await readRunDiff(folder.workspace, runId).catch((error: unknown) => Promise.reject(routeFailure(error))).finally(() => folder.end());
    if (!diff || diff.merge !== end.merged) throw new ApiError("not_found", "the run's merge is not in its agent's learning folder");
    return { base: diff.parent, head: diff.merge, files: diff.files.map((entry) => ("patch" in entry ? file(entry.path, entry.status, entry.patch) : { path: shown.name(entry.path), status: entry.status, withheld: entry.withheld })) };
  }
  const kept_ = isObject(kept?.proposal) ? kept.proposal.proposal : undefined;
  const proposal = isObject(kept_) && typeof kept_.seed === "string" && Array.isArray(kept_.notes) ? { seed: kept_.seed, notes: kept_.notes } : undefined;
  if (proposal) {
    const notes = proposal.notes.filter((note): note is { file: string; text: string } => isObject(note) && typeof note.file === "string" && NOTE_FILE.test(note.file) && typeof note.text === "string");
    return { base: proposal.seed, head: null, files: notes.map((note) => file(note.file, "added", addedPatch(note.text))) };
  }
  return { base: start?.seed ?? null, head: null, files: [] };
}
