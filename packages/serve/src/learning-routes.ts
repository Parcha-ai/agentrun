// What a person sees and controls of an agent's learning: this server's own routes under /v2 (learning/1).
// - Per agent: main's index, its notes and its log of changes, each a page, and how its runs' learning fared; one note as
//   text with its ETag, the note's blob id on main.
// - A person's edit, create or retire of one note: a precondition on the note's version (If-Match, or If-None-Match: * to
//   create; neither is 428), the structural checks a run's notes pass (packages/learn checkNote) and no grader, then one
//   host commit on main in the agent's queue, compare and swap, with MEMORY.md rebuilt and a `Changed-By: user` trailer,
//   and the checked-out files brought in line. MEMORY.md itself is never written here.
// - Per run: its learning whole, and its diff: what it proposed against its seed, or once merged, its merge commit against
//   its parent.
// Every read is plumbing at one commit of main, outside the queue: a commit never changes, so a read needs no lock, and a
// page's cursor names the commit it was read at. A text that leaves holding one of the host's secrets as they are now (a
// value made secret after it was written) is cut of it, and a diff's file holding one is withheld.
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { buildIndex, checkNote, INDEX_FILE, INDEX_LINES, type LearnedNote, NOTE_FILE, NOTE_STATUSES, parseNoteFile, type Problem, printable, redactSecrets, retire, secretShapes, valueMatcher } from "@parcha/agentrun-learn";
import { ApiError, invalid } from "./errors.js";
import { readJson } from "./files.js";
import { agentFolder, checkOut, git, homeDir, learningRepo, line, mainOf, openAgentRepo, PROPOSAL, readBlobs, readPin, withAgentRepo } from "./learning.js";
import type { Run } from "./runs.js";
import { isObject } from "./validate.js";

/** A file on main larger than this is not read: a note is at most 4 KB (packages/learn CAPS.note). */
const FILE_CAP = 1 << 20;
/** A diff's file whose patch is larger than this is withheld as too large. */
const PATCH_CAP = 64 * 1024;
/** The agent view's first pages, and the most a page holds. */
const NOTES_PAGE = 50;
const LOG_PAGE = 20;
const PAGE_MAX = 200;
/** The trailer of a person's commit, as `Run-Id` is a run's merge's. */
const BY_USER = "Changed-By: user";
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Page<T> = { items: T[]; total: number; next_cursor: string | null };
type NoteView = { file: string; name: string; description: string; type: string; status: string; superseded_by: string | null; text: string };
type Change = { by: { run: string } | { user: true }; commit: string; at: string; reason: string; files: string[] };
export type Counts = { merged: number; dropped: Record<string, number>; in_progress: number };
/** What a text that leaves shows of the host's secrets now: none (secretsShown). */
export type Shown = { text: (text: string) => string; holds: (text: string) => boolean };

/** The host's secrets as a reader cuts them: a text holding a value or a shape is cut of it (whole when long: packages/learn
 *  redactSecrets); any other text is shown as it is. */
export function secretsShown(values: readonly string[]): Shown {
  const matches = valueMatcher(values);
  const holds = (text: string) => matches(text) || secretShapes(text).length > 0;
  return { holds, text: (text) => (holds(text) ? redactSecrets(text, values) : text) };
}

const placeOf = (data: string, agentId: string) => ({ home: homeDir(data, agentId), repo: learningRepo(data, agentId) });
export const etagOf = (oid: string) => `"${oid}"`;
const EMPTY: Page<never> = { items: [], total: 0, next_cursor: null };

/** The `.md` files at commit `sha`'s top (or the one `file`), by name: the index and notes' names, regular files under
 *  FILE_CAP only, each with its blob id. */
async function entriesAt(home: string, repo: string, sha: string, file?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of (await git(home, repo, ["ls-tree", "-l", "-z", sha, ...(file ? ["--", file] : [])])).toString("utf8").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if ((path === INDEX_FILE || NOTE_FILE.test(path)) && mode === "100644" && type === "blob" && oid && Number(size) <= FILE_CAP) out.set(path, oid);
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
async function readAt(home: string, repo: string, sha: string): Promise<{ index: string; notes: Map<string, LearnedNote & { text: string }> }> {
  const texts = await textsOf(home, repo, await entriesAt(home, repo, sha));
  const notes = new Map<string, LearnedNote & { text: string }>();
  for (const [file, { text }] of texts) {
    const note = file === INDEX_FILE ? [] : parseNoteFile(file, text);
    if (!Array.isArray(note)) notes.set(file, { ...note, text });
  }
  return { index: texts.get(INDEX_FILE)?.text ?? "", notes };
}

/** One file at commit `sha`: its blob id and text, or undefined. */
const fileAt = async (home: string, repo: string, sha: string, file: string) => (await textsOf(home, repo, await entriesAt(home, repo, sha, file))).get(file);

/** Every change on main to `sha`, newest first, told by its trailers: a run's merge (`Run-Id`) or a person's commit
 *  (`Changed-By: user`); the folder's first commit, the host's, is neither and is left out. With it, each file's newest
 *  change, by its place in that walk. A merge's reason is the grader's, its own paragraph before the trailers; a person's
 *  commit has none, so its subject says what it did. */
async function walk(home: string, repo: string, sha: string): Promise<{ log: Change[]; touched: Map<string, number> }> {
  const format = "%x1e%H%x1f%cI%x1f%s%x1f%b%x1f%(trailers:key=Run-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Changed-By,valueonly,separator=%x2C)";
  const out = (await git(home, repo, ["log", "--first-parent", "-z", "--name-only", `--format=${format}`, sha])).toString("utf8");
  const log: Change[] = [];
  const touched = new Map<string, number>();
  out.split("\x1e").slice(1).forEach((record, i) => {
    const end = record.indexOf("\0");
    const [commit = "", at = "", subject = "", body = "", run = "", by = ""] = record.slice(0, end < 0 ? undefined : end).split("\x1f");
    const files = end < 0 ? [] : record.slice(end + 1).split("\0").map((file) => file.replace(/^\n/, "")).filter(Boolean);
    for (const file of files) if (!touched.has(file)) touched.set(file, i);
    const runId = run.split(",")[0]!.trim();
    const who = runId ? { run: runId } : by.trim() === "user" ? { user: true as const } : undefined;
    if (!who || !commit || !Date.parse(at)) return;
    const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    log.push({ by: who, commit, at: new Date(at).toISOString(), reason: paragraphs.slice(0, -1).join(" ") || subject.replace(/^learning: /, ""), files });
  });
  return { log, touched };
}

/** Commit `sha`'s notes as the view shows them: active first, then by their newest change, newest first, then by name. */
function ordered(notes: Map<string, LearnedNote & { text: string }>, touched: Map<string, number>, shown: Shown): NoteView[] {
  const rank = (note: LearnedNote) => (note.status === "active" ? 0 : 1);
  return [...notes.values()]
    .sort((a, b) => rank(a) - rank(b) || (touched.get(a.file) ?? Infinity) - (touched.get(b.file) ?? Infinity) || (a.file < b.file ? -1 : 1))
    .map(({ file, name, description, type, status, superseded_by, text }) => ({ file, name: shown.text(name), description: shown.text(description), type, status, superseded_by, text: shown.text(text) }));
}

const cursorOf = (sha: string, offset: number) => Buffer.from(`${sha}.${offset}`).toString("base64url");
const pageOf = <T>(all: T[], sha: string, offset: number, limit: number): Page<T> => ({ items: all.slice(offset, offset + limit), total: all.length, next_cursor: offset + limit < all.length ? cursorOf(sha, offset + limit) : null });

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

/** GET /agents/{id}/learning: main, its index, the first page of its notes and of its log, and the runs' counts; an
 *  agent with no folder (its learning never on) has an empty one. */
export async function agentLearning(data: string, agentId: string, shown: Shown, counts: Counts) {
  const { home, repo } = placeOf(data, agentId);
  const sha = await mainOf(home, repo);
  if (!sha) return { agent: agentId, main: null, index: "", notes: EMPTY, log: EMPTY, counts };
  const [{ index, notes }, { log, touched }] = await Promise.all([readAt(home, repo, sha), walk(home, repo, sha)]);
  return { agent: agentId, main: sha, index: shown.text(index), notes: pageOf(ordered(notes, touched, shown), sha, 0, NOTES_PAGE), log: pageOf(log.map((change) => ({ ...change, reason: shown.text(change.reason) })), sha, 0, LOG_PAGE), counts };
}

/** GET /agents/{id}/learning/notes?cursor=&limit=&status=: a page of the notes, ordered as the view's. */
export async function learningNotes(data: string, agentId: string, query: URLSearchParams, shown: Shown): Promise<Page<NoteView>> {
  const status = query.get("status");
  if (status !== null && !(NOTE_STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${NOTE_STATUSES.join(", ")}`);
  const { home, repo } = placeOf(data, agentId);
  const { limit, at } = await pageRequest(home, repo, query, NOTES_PAGE);
  const sha = at?.sha ?? (await mainOf(home, repo));
  if (!sha) return EMPTY;
  const [{ notes }, { touched }] = await Promise.all([readAt(home, repo, sha), walk(home, repo, sha)]);
  return pageOf(ordered(notes, touched, shown).filter((note) => status === null || note.status === status), sha, at?.offset ?? 0, limit);
}

/** GET /agents/{id}/learning/log?cursor=&limit=: a page of the changes on main, newest first. */
export async function learningLog(data: string, agentId: string, query: URLSearchParams, shown: Shown): Promise<Page<Change>> {
  const { home, repo } = placeOf(data, agentId);
  const { limit, at } = await pageRequest(home, repo, query, LOG_PAGE);
  const sha = at?.sha ?? (await mainOf(home, repo));
  if (!sha) return EMPTY;
  const { log } = await walk(home, repo, sha);
  return pageOf(log.map((change) => ({ ...change, reason: shown.text(change.reason) })), sha, at?.offset ?? 0, limit);
}

/** The file a route names, decoded: a note's name, or MEMORY.md for a read. Anything else is 400: the folder holds only
 *  `.md` files at its top. The name is never echoed. */
function fileOf(raw: string, write: boolean): string {
  let file: string;
  try {
    file = decodeURIComponent(raw);
  } catch {
    throw new ApiError("bad_request", "the file name is not percent-encoded right");
  }
  if (file === INDEX_FILE && write) throw new ApiError("bad_request", "MEMORY.md is built by the server from the active notes, one line each, and is never written: edit, create or retire a note instead.");
  if (file !== INDEX_FILE && !NOTE_FILE.test(file)) throw new ApiError("bad_request", "A learning file is a note's name at the folder's top: letters, digits, dots, dashes and underscores, starting with a letter or digit, ending .md.");
  return file;
}

/** GET /agents/{id}/learning/files/{file}: the file on main as text, and its ETag. */
export async function readNote(data: string, agentId: string, raw: string, shown: Shown): Promise<{ text: string; etag: string }> {
  const file = fileOf(raw, false);
  const { home, repo } = placeOf(data, agentId);
  const sha = await mainOf(home, repo);
  const found = sha ? await fileAt(home, repo, sha, file) : undefined;
  if (!found) throw new ApiError("not_found", "the agent's learning folder has no such file on main");
  return { text: shown.text(found.text), etag: etagOf(found.oid) };
}

/** A note as a text answer: its ETag, an explicit type, nosniff, and a sandbox on whatever opens it. */
export function sendNote(res: ServerResponse, status: number, note: { text: string; etag: string }, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", etag: note.etag, ...headers });
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

/** PUT /agents/{id}/learning/files/{file} (`body`, the note's whole text) or POST .../retire (no body), as a person:
 *  the precondition, then the checks (a retire's note must parse), then one commit on main in the agent's queue, on the
 *  folder agentFolder checked: the note, and MEMORY.md rebuilt from main's notes with it, its message
 *  `learning: <edited|created|retired> by a person: <file>` and a `Changed-By: user` trailer, main moved only from the
 *  commit it was made on (once more on a main that moved meanwhile), then the checked-out files. A note the checks
 *  refuse is never written to git. A retire of a note that is not active, and an edit that changes nothing, commit
 *  nothing. `refuse`: the host's secrets. */
export async function writeNote(data: string, agentId: string, raw: string, input: { ifMatch?: string; ifNoneMatch?: string; body?: Buffer; refuse: readonly string[] }): Promise<{ status: 200 | 201; file: string; text: string; etag: string }> {
  const file = fileOf(raw, true);
  const condition = conditionOf(input.ifMatch, input.ifNoneMatch, input.body !== undefined);
  let given: string | undefined;
  if (input.body !== undefined) {
    const { problems, note } = checkNote(file, input.body, input.refuse);
    if (!note) throw refused(problems);
    given = note.text;
  }
  const home = homeDir(data, agentId);
  return withAgentRepo(data, agentId, async () => {
    // The folder through agentFolder, as a run's merge reaches it: a link at the agent's home, its learning/ or its
    // .git is refused (an error, nothing written), never followed. `check` checks again once a create has made .git.
    const check = () => agentFolder(data, agentId);
    const repo = await check();
    for (let tries = 0; ; tries++) {
      const main = await mainOf(home, repo);
      const current = main ? await fileAt(home, repo, main, file) : undefined;
      if (condition.match && !(current && condition.match.includes(etagOf(current.oid)))) throw new ApiError("precondition_failed", current ? "The note changed since it was read (a run's merge, or another edit): read it again." : "There is no such note on main: create it with If-None-Match: *.");
      if (condition.absent && current) throw new ApiError("precondition_failed", "The folder has a note by this name: read it, then edit it with If-Match.");
      let text = given;
      if (text === undefined) {
        const note = parseNoteFile(file, current!.text);
        if (Array.isArray(note)) throw refused(note.map((detail) => printable({ rule: "note", path: file, detail }, input.refuse)));
        if (note.status !== "active") return { status: 200, file, text: current!.text, etag: etagOf(current!.oid) };
        text = retire(current!.text);
      }
      if (current && text === current.text) return { status: 200, file, text, etag: etagOf(current.oid) };
      const notes = main ? (await readAt(home, repo, main)).notes : new Map<string, LearnedNote>();
      const after = [...[...notes.values()].filter((note) => note.file !== file), parseNoteFile(file, text) as LearnedNote];
      const lines = after.filter((note) => note.status === "active").length;
      if (lines > INDEX_LINES) throw refused([{ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so retire a note first` }]);
      const parent = main ?? (await openAgentRepo(home, repo, check));
      const subject = `learning: ${given === undefined ? "retired" : current ? "edited" : "created"} by a person: ${file}`;
      const env = { GIT_INDEX_FILE: join(repo, ".git", "person.index") };
      let commit: string;
      let oid: string;
      try {
        await rm(env.GIT_INDEX_FILE, { force: true });
        await git(home, repo, ["read-tree", parent], "", env);
        oid = line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], text));
        const index = line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], buildIndex(after)));
        await git(home, repo, ["update-index", "-z", "--index-info"], `100644 ${oid}\t${file}\x00100644 ${index}\t${INDEX_FILE}\x00`, env);
        const tree = line(await git(home, repo, ["write-tree"], "", env));
        commit = line(await git(home, repo, ["commit-tree", tree, "-p", parent, "-m", subject, "-m", BY_USER]));
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

/** GET /runs/{id}/learning: the run's learning whole, or null for a run that does not learn. */
export async function runLearning(run: Run, shown: Shown, secrets: readonly string[]) {
  const learning = run.meta.learning;
  if (!learning) return null;
  const pin = await readPin(run.dir).catch(() => undefined);
  const { state, reason, detail, at, verdict, problems, merged, cost_usd, tokens } = learning;
  return {
    run: run.id, state, reason, detail, at,
    seed: pin?.seed ?? null,
    merged: merged ?? null,
    verdict: verdict ? { merge: verdict.merge, reason: shown.text(verdict.reason) } : null,
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
  const file = (path: string, status: string, patch: string) =>
    Buffer.byteLength(patch) > PATCH_CAP ? { path, status, withheld: "too_large" } : shown.holds(patch) ? { path, status, withheld: "secret" } : { path, status, patch };
  if (learning.merged) {
    const { home, repo } = placeOf(data, run.agentId);
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
