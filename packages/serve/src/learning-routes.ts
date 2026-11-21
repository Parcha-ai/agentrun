// What a person sees and controls of an agent's learning: this server's own routes under /v2 (learning/1).
// - Per agent: main, its corrections.md, its workflow drafts, its log of changes (a page), and how its runs' learning
//   fared; a draft's file as text with its ETag, its blob id on main; a learned workflow's revisions.
// - corrections.md, read whole and replaced whole by a person (If-Match on the version read; neither header is 428),
//   refused whole when it would hold what must never be stored or pass the cap (learn/corrections.ts).
// - A person's approval of a draft that waits for the owner's OK, its retire and its restore: a precondition on its
//   README.md's version (If-Match), then one commit on main by the learning script (learn/folder.ts writeLearning: one
//   exec, compare and swap) with a `Changed-By: user` trailer, the checked-out files brought in line and the snapshot
//   written.
// - Per run: its learning whole, and once merged its diff: its merge commit against its parent, as its merge's script
//   wrote it (`.agentrun/diffs/<run>.json`).
// Every read is the folder's snapshot (`.agentrun/snapshot.json`), the working-tree bodies it names, each checked against
// its blob id, and the diff files, through the folder's Workspace file API: no git and no exec (learn/folder.ts
// readLearning). A body that is not the snapshot's, twice, is a write in flight: 503. A page's cursor names the main it
// was read at; a later page is read at that main while this server still holds its snapshot, else as the first page of
// main now. A text that leaves holding one of the host's secrets as they are now (a value made secret after it was
// written) is cut of it, a file's name holding one reads "[redacted]" whole, and a diff's file holding one is withheld.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { CORRECTIONS_CAP, draftProblems, frontKeys, isHeld, LEARNED_KEYS, learnedPlace, learnedStatus, type Problem, printable, released, restorable, restoredLearned, retiredLearned, UNCLEAR_FRONT, unclearFront, unstorable, WORKFLOW_NAME, WORKFLOWS_DIR } from "./learn/index.js";
import { readmeProblems, type DraftDecisions } from "./learn/workflow-draft.js";
import { forgetRunText, putCorrections, readCorrections } from "./learn/commit.js";
import { blobOid, type FolderChange, FolderBusy, FolderRefused, FolderTooLarge, FolderUnreadable, type PersonKind, readLearning, PATCH_CAP, readRunDiff, readSnapshot, runDiffKey, type SnapChange, type SnapHistory, type SnapLearned, type Snapshot, textsAt, writeLearning } from "./learn/folder.js";
import { ApiError, invalid } from "./errors.js";
import type { ServingState } from "./learn/promote.js";
import { type ItemStatus, detailShown, filesView, type Learning, learningFolderOf, reasonShown, type Shown, withAgentRepo } from "./learning.js";
import type { Impact } from "./learning-run.js";
import { isObject } from "./validate.js";
import type { Workspace } from "./workspace/index.js";
import { launchOf } from "./handed-values.js";
import { learningStartOf } from "./run-launch.js";
import { type LearnedUse, runLearningEnd } from "./store-reads/learning.js";
import type { Store } from "./store/store.js";

/** The agent view's first page of its log, and the most a page holds. */
const LOG_PAGE = 20;
const PAGE_MAX = 200;

type Page<T> = { items: T[]; total: number; next_cursor: string | null };
/** Who retired a retired draft, and when, and `from`, the status its restore gives back; or, for one that reads retired
 *  only because its README.md can't be read (its front matter reads no way: unclearFront, read from its file as the view
 *  is made), that no one did: the host could not read it (`why`), with no `from`, since its restore waits for the file to
 *  be fixed. One closed shape. */
type Retired = { at: string; by: "person" | "run" | "host"; from?: "active" | "pending"; why?: "unreadable" };
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

/** Which of `runIds` are purged, by the store's purge mark (its row's purge time). */
export type PurgedOf = (runIds: readonly string[]) => Promise<ReadonlySet<string>>;

/** `snapshot` with its log's changes by a purged run left out: the folder's history reads serve none of its merges (a
 *  run's purge, agent-delete.ts purgeRun). Read at each read, so a log the folder rebuilds names them and still serves
 *  none. */
async function unpurged(snapshot: Snapshot, purgedOf: PurgedOf): Promise<Snapshot> {
  const runs = [...new Set(snapshot.log.flatMap(({ by }) => ("run" in by ? [by.run] : [])))];
  const purged = runs.length ? await purgedOf(runs) : new Set<string>();
  return purged.size ? { ...snapshot, log: snapshot.log.filter(({ by }) => !("run" in by && purged.has(by.run))) } : snapshot;
}

/** Run `runId`'s text taken off agent `agentId`'s learning folder's current files at its purge (learn/commit.ts
 *  forgetRunText), in the agent's queue, as every write of the folder is. */
export async function forgetRunLearning(data: string, agentId: string, runId: string): Promise<void> {
  await withAgentRepo(data, agentId, async () => {
    const { workspace: ws, end } = learningFolderOf(data, agentId);
    try {
      await forgetRunText(ws, runId);
    } catch (error) {
      throw routeFailure(error);
    } finally {
      await end();
    }
  });
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

/** A retired draft's `retired`: its newest retire by a person; else, one a person made retired another way, their
 *  newest change; else its newest change's time. `from`: the status its restore gives back (its retire recorded it,
 *  retired_from; none recorded reads pending). `unread`: the host could not read its README.md. */
const retiredOf = (history: SnapHistory, from: "active" | "pending" | undefined, unread = false): Retired => (unread ? { at: history.at, by: "host", why: "unreadable" } : { ...(history.retire ? { at: history.retire.at, by: "person" as const } : history.person ? { at: history.person.at, by: "person" as const } : { at: history.at, by: "run" as const }), from: from ?? "pending" });

/** A workflow draft as the view lists it: its folder's name, its workflow.json with its `readme`, its description, its
 *  status, the run whose merge last changed it, its size in bytes, and the ETag of its README.md (the file that says
 *  whether it waits, which an approval names); cut of the host's secrets (a name or a file holding one reads [redacted]).
 *  `status` is one word: its README.md's `pending` or `retired`, else where it stands as the promotions read says it
 *  (`stateOf`, learn/promote.ts servingStateOf): `serving`, `checking`, `held` or `stopped`. */
type WorkflowView = { name: string; file: string; readme: string; description: string; status: "pending" | "retired" | ServingState; run: string | null; bytes: number; etag: string; retired?: Retired; last_change?: SnapHistory["last"] };
function workflowView(item: SnapLearned, shown: Shown, stateOf: (workflow: string) => ServingState, unread = false): WorkflowView {
  const file = `${WORKFLOWS_DIR}/${item.name}/workflow.json`;
  const bytes = item.files.find(({ path }) => path === file)?.bytes ?? item.bytes;
  const status = item.status === "active" ? stateOf(item.name) : item.status;
  return {
    name: shown.name(item.name), file: shown.name(file), readme: shown.name(item.file), description: shown.text(item.description), status, run: item.run, bytes, etag: etagOf(item.oid),
    ...(item.history.last ? { last_change: item.history.last } : {}),
    ...(item.status === "retired" ? { retired: retiredOf(item.history, item.retired_from, unread) } : {}),
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

/** The snapshot a page reads: main now's, or the one its cursor names while this server holds it, else main now's from
 *  its first item. */
function pageAt(agentId: string, snapshot: Snapshot, at: { sha: string; offset: number } | undefined): { snapshot: Snapshot; offset: number } {
  if (!at) return { snapshot, offset: 0 };
  if (at.sha === snapshot.main) return { snapshot, offset: at.offset };
  const kept = seen.get(seenKey(agentId, at.sha));
  return kept ? { snapshot: kept, offset: at.offset } : { snapshot, offset: 0 };
}

/** A page of the changes on main, newest first, cut of the host's secrets. */
const logPage = (snapshot: Snapshot, offset: number, limit: number, shown: Shown): Page<Change> => ({ items: snapshot.log.slice(offset, offset + limit).map((change) => changeView(change, shown)), total: snapshot.log.length, next_cursor: offset + limit < snapshot.log.length ? cursorOf(snapshot.main, offset + limit) : null });

/** For tests: how many times a folder's statuses were read (once per commit of its main). */
export const pendingTestHooks = { reads: 0 };
/** By agent: its folder's main commit and each draft's status there. */
const statusBy = new Map<string, { sha: string; status: ReadonlyMap<string, ItemStatus> }>();

/** Each workflow draft's status on agent `agentId`'s folder's main, by its workflow.json (as its README.md says it):
 *  `active`, `pending` or `retired`. Built once per main (a list asks for many runs). A folder never made, or with no
 *  main, holds none; one whose snapshot cannot be read is undefined. */
export async function statusesOf(data: string, agentId: string): Promise<ReadonlyMap<string, ItemStatus> | undefined> {
  const folder = learningFolderOf(data, agentId);
  try {
    const snapshot = await readSnapshot(folder.workspace);
    if (!snapshot) return new Map();
    const known = statusBy.get(agentId);
    if (known?.sha === snapshot.main) return known.status;
    // Built at once, with no wait between the miss and the keep: requests that miss together build it once.
    pendingTestHooks.reads += 1;
    const status = new Map<string, ItemStatus>(snapshot.workflows.map((item): [string, ItemStatus] => [`${WORKFLOWS_DIR}/${item.name}/workflow.json`, { status: item.status }]));
    statusBy.set(agentId, { sha: snapshot.main, status });
    return status;
  } catch {
    return undefined;
  } finally {
    await folder.end();
  }
}

/** How many of agent `agentId`'s workflow drafts wait for its owner's OK on its folder's main (statusesOf). A folder
 *  never made has none waiting; one that cannot be read is undefined (the caller shows no count). */
export async function pendingCount(data: string, agentId: string): Promise<number | undefined> {
  const status = await statusesOf(data, agentId);
  return status === undefined ? undefined : [...status.values()].filter((value) => value.status === "pending").length;
}

/** GET /agents/{id}/learning: main, its corrections.md, its workflow drafts and the first page of its log, and how the
 *  agent's runs fared and what learning changed for them (`counts`, `impact`); an agent with no folder (its learning
 *  never on) has an empty one. `stateOf`: where each workflow neither pending nor retired stands, by its folder name (the
 *  promotions read's own word: learn/promote.ts servingStateOf over the agent's records). Its log serves no purged run's
 *  merge (`purgedOf`). */
type AgentView = { agent: string; main: string | null; corrections: string; workflows: WorkflowView[]; log: Page<Change>; counts: Counts; impact: Impact };
export async function agentLearning(data: string, agentId: string, shown: Shown, counts: Counts, impact: Impact, stateOf: (workflow: string) => ServingState, purgedOf: PurgedOf): Promise<AgentView> {
  return reading<AgentView>(data, agentId, async ({ snapshot: read, body }) => {
    const snapshot = await unpurged(read, purgedOf);
    const corrections = (await readCorrections(snapshot, body)).text;
    // A retired draft whose README.md can't be read is said so (unclearFront), read from its file now, as the snapshot's
    // status was: a few retired items, one read each.
    const unread = async (item: SnapLearned) => item.status === "retired" && unclearFront(await body(item.file, item.oid));
    return { agent: agentId, main: snapshot.main, corrections: shown.text(corrections), workflows: await Promise.all(snapshot.workflows.map(async (item) => workflowView(item, shown, stateOf, await unread(item)))), log: logPage(snapshot, 0, LOG_PAGE, shown), counts, impact };
  }, () => ({ agent: agentId, main: null, corrections: "", workflows: [], log: EMPTY, counts, impact }));
}

/** GET /agents/{id}/learning/log?cursor=&limit=: a page of the changes on main, newest first, a purged run's left out
 *  (`purgedOf`). */
export async function learningLog(data: string, agentId: string, query: URLSearchParams, shown: Shown, purgedOf: PurgedOf): Promise<Page<Change>> {
  const { limit, at } = pageRequest(query, LOG_PAGE);
  return reading(data, agentId, async ({ snapshot }) => {
    const page = pageAt(agentId, snapshot, at);
    return logPage(await unpurged(page.snapshot, purgedOf), page.offset, limit, shown);
  }, () => EMPTY);
}

/** GET /agents/{id}/learning/corrections: corrections.md on main as text (empty when main holds none), its ETag (its blob
 *  id; an empty file's when there is none) and the cap a PUT keeps to, cut of the host's secrets as every read is. */
export async function correctionsView(data: string, agentId: string, shown: Shown): Promise<{ text: string; etag: string; cap_bytes: number }> {
  const read = await reading(data, agentId, ({ snapshot, body }) => readCorrections(snapshot, body), () => ({ text: "", oid: blobOid("") }));
  return { text: shown.text(read.text), etag: etagOf(read.oid), cap_bytes: CORRECTIONS_CAP };
}

/** PUT /agents/{id}/learning/corrections: corrections.md replaced whole by a person (`text`), only over the version they
 *  read (`ifMatch`: its ETag; none, or `*`, is 428; another version is 412). Refused whole, nothing written, when it holds
 *  what must never be stored (a host secret, text shaped like one, a hidden character) or passes the cap (422 with the
 *  problems, printable). A text read cut of a secret and sent back replaces the secret with the cut: a person's write never
 *  puts a secret back. In the agent's queue, one commit on main. */
export async function correctionsWrite(data: string, agentId: string, input: { text: string; ifMatch?: string; refuse: readonly string[] }): Promise<{ text: string; etag: string; cap_bytes: number }> {
  const match = input.ifMatch?.trim();
  if (!match || match === "*") throw new ApiError("precondition_required", "A write names the version it read: If-Match with corrections.md's ETag, as GET answered it.");
  return withAgentRepo(data, agentId, async () => {
    const { workspace: ws, end } = learningFolderOf(data, agentId);
    try {
      const done = await putCorrections(ws, { text: input.text, ifMatch: match, refuseValues: input.refuse });
      if (done.ok) return { text: done.text, etag: etagOf(done.oid), cap_bytes: CORRECTIONS_CAP };
      if (done.reason === "conflict") throw new ApiError("precondition_failed", "corrections.md changed since it was read (a run's correction, or another edit): read it again.");
      const problems = done.problems.map((problem) => printable(problem, input.refuse));
      throw invalid(problems.map((problem) => ({ field: "text", reason: problem.rule, message: problem.detail })));
    } catch (error) {
      if (error instanceof FolderTooLarge) throw invalid([{ field: "text", reason: "too_large", message: error.message }]);
      throw routeFailure(error);
    } finally {
      await end();
    }
  });
}

/** The most revisions a workflow's history answers, and its default. */
const REVISIONS_MAX = 50;
const REVISIONS_DEFAULT = 20;
/** One revision of a learned workflow: a commit on main that changed its workflow.json, with that commit's text (null
 *  when the commit holds no such file: it was deleted there), cut of the host's secrets. */
type WorkflowRevision = { commit: string; at: string; by: Change["by"]; reason: string; text: string | null; digest: string | null };

/** GET /agents/{id}/learning/workflows/{name}/revisions?limit=: the latest revisions of learned workflow `name` (the
 *  commits on main's log that changed `workflows/<name>/workflow.json`), oldest first, each with the workflow's text at
 *  that commit, so a person can step through how it changed. One read-only exec per revision (textsAt), at most `limit`
 *  of them. `total` counts every such commit the log holds, `truncated` says the log itself is cut (it keeps the latest
 *  LOG_KEEP changes). A purged run's merge is no revision (`purgedOf`). A workflow no commit of the log changed is
 *  not_found. */
export async function workflowRevisions(data: string, agentId: string, name: string, query: URLSearchParams, shown: Shown, purgedOf: PurgedOf): Promise<{ name: string; revisions: WorkflowRevision[]; total: number; truncated: boolean }> {
  if (!WORKFLOW_NAME.test(name)) throw new ApiError("bad_request", "A workflow's folder is named with lowercase letters, digits, dashes and underscores.");
  const given = query.get("limit");
  const limit = given === null ? REVISIONS_DEFAULT : Number(given);
  if ((given !== null && !/^\d+$/.test(given)) || limit < 1 || limit > REVISIONS_MAX) throw new ApiError("bad_request", `limit is an integer from 1 to ${REVISIONS_MAX}`);
  const path = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  if (shown.name(path) !== path) throw new ApiError("not_found", "the agent's learning folder has no such workflow");
  const found = await reading(data, agentId, async ({ ws, snapshot }) => {
    const touched = (await unpurged(snapshot, purgedOf)).log.filter((change) => change.files.includes(path));
    const latest = touched.slice(0, limit).reverse();
    const revisions: WorkflowRevision[] = [];
    for (const change of latest) {
      const texts = await textsAt(ws, change.commit, [path]).catch((error: unknown) => { throw routeFailure(error); });
      const raw = texts?.[path];
      // Its digest, read from the text as it is (workflow-first.ts workflowDigest's): the one a run's metrics and the
      // promotion records name, so a revision's runs and promotion are found by it.
      revisions.push({ commit: change.commit, at: change.at, by: change.by, reason: shown.text(change.reason), text: raw === undefined ? null : shown.text(raw), digest: raw === undefined ? null : createHash("sha256").update(raw).digest("hex").slice(0, 16) });
    }
    return { revisions, total: touched.length, truncated: snapshot.log_more };
  }, () => undefined);
  if (!found || !found.total) throw new ApiError("not_found", "the agent's learning folder has no such workflow");
  return { name, ...found };
}

/** Learned workflow `name`'s text at `digest` (a champion's, as its promotion records name it), read by that digest and
 *  never by paging the workflow's history: at `commits` (the records' learning commits, newest first), then at main, the
 *  first commit whose workflow.json is that digest's text, with the commit it was read at. Undefined when none is (no
 *  main yet, or no commit read holds it). A purged run's merge is never read (`purgedOf`), known by the run its log names
 *  for it: a commit older than the log's newest LOG_KEEP changes is not known so. One read-only exec per commit tried
 *  (textsAt). */
export async function workflowAtDigest(data: string, agentId: string, name: string, digest: string, commits: readonly string[], purgedOf: PurgedOf): Promise<{ text: string; commit: string } | undefined> {
  if (!WORKFLOW_NAME.test(name)) return undefined;
  const path = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  return reading(data, agentId, async ({ ws, snapshot }) => {
    const kept = new Set((await unpurged(snapshot, purgedOf)).log.map(({ commit }) => commit));
    const purged = new Set(snapshot.log.map(({ commit }) => commit).filter((commit) => !kept.has(commit)));
    for (const commit of new Set([...commits, snapshot.main])) {
      if (purged.has(commit)) continue;
      const raw = (await textsAt(ws, commit, [path]).catch(() => undefined))?.[path];
      if (raw !== undefined && createHash("sha256").update(raw).digest("hex").slice(0, 16) === digest) return { text: raw, commit };
    }
    return undefined;
  }, () => undefined);
}

/** The blob of a draft's `file` on the snapshot's main; undefined when main holds no such file the snapshot names. */
function blobIn(snapshot: Snapshot | undefined, file: string): string | undefined {
  const place = learnedPlace(file);
  if (!snapshot || !place) return undefined;
  return snapshot.workflows.find((item) => item.name === place.name)?.files.find(({ path }) => path === file)?.oid;
}

/** The file a route names, decoded: a draft's workflow.json or README.md (`workflows/<name>/README.md`,
 *  percent-encoded); for an approve, a retire or a restore, its README.md, the file that says whether it waits. Anything
 *  else is 400. The name is never echoed. */
function fileOf(raw: string, use: "read" | "approve" | "retire" | "restore"): string {
  let file: string;
  try {
    file = decodeURIComponent(raw);
  } catch {
    throw new ApiError("bad_request", "the file name is not percent-encoded right");
  }
  const place = learnedPlace(file);
  if (!place) throw new ApiError("bad_request", "A learning file is a workflow draft's workflow.json or README.md (workflows/<name>/...); corrections.md has its own route.");
  if (!WORKFLOW_NAME.test(place.name)) throw new ApiError("bad_request", "A workflow's folder is named with lowercase letters, digits, dashes and underscores.");
  if (use !== "read" && place.kind !== "readme") throw new ApiError("bad_request", "A workflow is approved, retired and restored by its README.md, the file that says whether it is in use.");
  return file;
}

/** GET /agents/{id}/learning/files/{file}: a draft's file on main as text, its ETag, and its type (workflow.json is
 *  JSON). */
export async function readLearnedFile(data: string, agentId: string, raw: string, shown: Shown): Promise<{ text: string; etag: string; type?: string }> {
  const file = fileOf(raw, "read");
  const found = await reading(data, agentId, async ({ snapshot, body }) => {
    const oid = blobIn(snapshot, file);
    return oid === undefined ? undefined : { oid, text: await body(file, oid) };
  }, () => undefined);
  if (!found) throw new ApiError("not_found", "the agent's learning folder has no such file on main");
  return { text: shown.text(found.text), etag: etagOf(found.oid), ...(file.endsWith(".json") ? { type: "application/json; charset=utf-8" } : {}) };
}

/** A learning file as a text answer: its ETag, an explicit type (markdown unless it names one), nosniff, and a sandbox on
 *  whatever opens it. */
export function sendText(res: ServerResponse, status: number, file: { text: string; etag: string; type?: string }, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": file.type ?? "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", etag: file.etag, ...headers });
  res.end(file.text);
}

/** A PUT's body, read to its end (over `max` bytes is 413): the file's whole text, as `text/markdown` or `text/plain`, or
 *  as `application/json` `{text}`, the one form the console's page may send under its session (page.ts: a write from the
 *  page is JSON from its own origin). A JSON body that is not an object is 400; one whose `text` is missing or not text,
 *  or with another field, is 422 by field, as every JSON body here. A body that is not UTF-8 is 422. */
export async function textBody(req: IncomingMessage, max: number): Promise<string> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const json = type === "application/json";
  if (!json && type !== "text/markdown" && type !== "text/plain") throw new ApiError("unsupported_media_type", "the body is the file's whole text: text/markdown or text/plain, or application/json {text}");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) throw new ApiError("payload_too_large", `the body is over ${max} bytes`, { details: { limit: "max_body_bytes" } });
  const raw = Buffer.concat(chunks);
  if (!json) {
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) throw invalid([{ field: "text", reason: "wrong_type", message: "the body is not UTF-8 text" }]);
    return text;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8") || "null");
  } catch {
    throw new ApiError("bad_request", "the body is not JSON");
  }
  if (!isObject(value)) throw new ApiError("bad_request", "the body is not a JSON object");
  const issues = Object.keys(value).filter((key) => key !== "text").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
  // A lone surrogate is no text: UTF-8 would carry it as U+FFFD, a text other than the one sent.
  if (typeof value.text !== "string" || /\p{Cs}/u.test(value.text)) issues.push({ field: "text", reason: value.text === undefined ? "missing" : "wrong_type", message: "text is the file's whole text" });
  if (issues.length) throw invalid(issues);
  return value.text as string;
}

const refused = (problems: Problem[]) => new ApiError("bad_request", `The workflow does not pass the checks: ${[...new Set(problems.map((problem) => problem.rule))].join(", ")}.`, { problems });

/** The tools and gate a draft's workflow.json is checked against (learning-end.ts checkDraftOf's own). */
type DraftTools = () => Promise<{ tools: string[]; gated: Record<string, string>; deniedBy?: Record<string, "agent" | "server" | "default">; decisions?: DraftDecisions }>;

/** POST /agents/{id}/learning/files/{file}/approve, .../retire or .../restore, as a person, on a draft's README.md
 *  (`file`): If-Match on the version read (none, or `*`, is 428; another is 412), then one commit on main by the learning
 *  script (learn/folder.ts writeLearning), in the agent's queue, its message `learning: <approved|retired|restored> by a
 *  person: <file>` with a `Changed-By: user` trailer (and `Approved-Via: console` on an approval). An approval releases a
 *  held draft (status: pending) to every later run; a retire takes it out of every later run unchecked, so a leaking one
 *  can always be revoked; a restore brings it back to the status its retire recorded, checked again as a new draft is
 *  (secrets' shapes, the host's values, hidden characters, its README's format, its workflow.json against the agent's
 *  tools and gate). A retire of a retired draft commits nothing. `refuse`: the host's secrets. */
export async function changeWorkflow(data: string, agentId: string, raw: string, input: { action: "approve" | "retire" | "restore"; ifMatch?: string; refuse: readonly string[]; draftTools?: DraftTools }): Promise<{ status: 200; file: string; text: string; etag: string }> {
  const file = fileOf(raw, input.action);
  const place = learnedPlace(file)!;
  const match = input.ifMatch?.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (match?.includes("*")) throw new ApiError("precondition_required", "If-Match: * names no version: send the README's ETag, as GET answered it.");
  if (!match?.length) throw new ApiError("precondition_required", "A change names the version it read: If-Match with the README's ETag.");
  type Written = { status: 200; file: string; text: string; etag: string };
  return withAgentRepo(data, agentId, async () => {
    // The folder as a run's merge reaches it: a link in it is refused (an error naming it, nothing written), never
    // followed.
    const { workspace: ws, end } = learningFolderOf(data, agentId);
    try {
      const { result } = await writeLearning<Written>(ws, async ({ snapshot, body, bytes }) => {
        const oid = blobIn(snapshot, file);
        const current = oid === undefined ? undefined : { oid, text: await body(file, oid) };
        if (!current) throw new ApiError("not_found", "the agent's learning folder has no such workflow on main");
        if (!match.includes(etagOf(current.oid))) throw new ApiError("precondition_failed", "The workflow changed since it was read (a run's merge, or another change): read it again.");
        let text: string;
        if (input.action === "restore") {
          const status = learnedStatus(current.text);
          if (status !== "retired") throw new ApiError("bad_request", `The workflow is not retired: it is ${status}.`);
          // Read as retired since its front matter reads no way, or its status (or the retired_from its retire recorded) is
          // set on more than one line, which no writer edits: refused until it is written so.
          if (!restorable(current.text)) throw refused([printable({ rule: "workflow", path: file, detail: UNCLEAR_FRONT }, input.refuse)]);
          // Back to the status its retire recorded, never active unless it was active: a held draft waits for its owner's OK again.
          text = restoredLearned(current.text);
          const problems = readmeProblems(text, place.name).map((detail) => printable({ rule: "workflow", path: file, detail }, input.refuse));
          const extra = (frontKeys(text) ?? []).filter((key) => !LEARNED_KEYS.includes(key) && key !== "status");
          if (extra.length) problems.push(printable({ rule: "workflow", path: file, detail: `its front matter sets ${extra.join(", ")}: a learned workflow's README sets name and description alone` }, input.refuse));
          const others = snapshot!.workflows.find((item) => item.name === place.name)?.files.filter(({ path }) => path !== file) ?? [];
          const changes = [{ path: file, status: "modified" as const, bytes: Buffer.from(text, "utf8") }, ...(await Promise.all(others.map(async ({ path, oid: blob }) => ({ path, status: "modified" as const, bytes: await bytes(path, blob) }))))];
          problems.push(...unstorable(changes, input.refuse));
          // Its workflow.json passes the checks a run's draft passes (its tools and the gate's settings), so a restore never
          // brings back a draft no run could run.
          const draft = changes.find(({ path }) => path === `${WORKFLOWS_DIR}/${place.name}/workflow.json`);
          if (draft && input.draftTools) {
            const { tools, gated, deniedBy, decisions } = await input.draftTools();
            const dsl = await import("@parcha/agentrun-dsl");
            for (const { rule, detail } of draftProblems(dsl as never, draft.bytes.toString("utf8"), tools, gated, deniedBy ?? {}, decisions)) problems.push(printable({ rule, path: draft.path, detail }, input.refuse));
          }
          if (problems.length) throw refused(problems);
        } else if (input.action === "retire") {
          // One already retired is answered as it is; nothing else in the folder changes.
          if (learnedStatus(current.text) === "retired") return { result: { status: 200, file, text: current.text, etag: etagOf(current.oid) } };
          text = retiredLearned(current.text);
        } else {
          // Approved, it is no longer held: given to every later run. Nothing else in the folder changes.
          if (!isHeld(current.text)) throw new ApiError("bad_request", `The workflow is not waiting for an OK: it is ${learnedStatus(current.text)}.`);
          text = released(current.text);
        }
        const kind: PersonKind = input.action === "approve" ? "approved" : input.action === "restore" ? "restored" : "retired";
        // Who approved, and how, in the trailers; the commit's own date is when. Never the file's text.
        const change: FolderChange = { by: { person: kind, file, approved: input.action === "approve" }, writes: [{ path: file, text }] };
        return { result: { status: 200, file, text, etag: etagOf(blobOid(text)) }, change };
      });
      return result;
    } catch (error) {
      if (error instanceof FolderRefused) throw new ApiError("precondition_failed", "The folder's file by this name on main is no regular UTF-8 file, and a person's change never replaces it.");
      if (error instanceof FolderTooLarge) throw refused([{ rule: "too_large", path: file, detail: error.message }]);
      throw routeFailure(error);
    } finally {
      await end();
    }
  });
}

/** GET /runs/{id}/learning's body, from the run's learning as it reads now, the seed it started from and whether it
 *  settled: the one shape, read from the one store (store-reads/learning.ts runLearningOverStore). */
export function runLearningBody(input: { readonly id: string; readonly learning: Learning; readonly seed: string | null; readonly settled: boolean; readonly used?: LearnedUse }, shown: Shown, secrets: readonly string[]) {
  const { learning } = input;
  const { state, reason, at, problems, merged } = learning;
  return {
    run: input.id, state, reason: reasonShown(reason, shown), detail: detailShown(learning, shown), at,
    // The draft it merged, `pending` while it waits for its owner's OK.
    workflows: filesView(learning, shown).workflows ?? [],
    // How many lines of its owner's words its merge added to corrections.md.
    corrections: learning.corrections ?? 0,
    seed: input.seed,
    merged: merged ?? null,
    // Each cut of the host's secrets (printable), then as every served text is (`shown`: no loopback address).
    problems: (problems ?? []).map((problem) => printable(problem, secrets)).map(({ rule, path, detail }) => ({ rule: shown.text(rule) as typeof rule, ...(path === undefined ? {} : { path: shown.text(path) }), detail: shown.text(detail) })),
    // The compile turn's record (learn/compile.ts): the workflow it wrote and each attempt with what the checks refused,
    // its kept draft's digest and whether that serves (its promotion: true, held false, null while undecided); null when
    // the run compiled nothing. A draft that never passed is never silent: its errors are `draft_errors`. Each text cut of
    // the host's secrets.
    compiled: learning.compiled ? { workflow: shown.name(learning.compiled.workflow), attempts: learning.compiled.attempts.map(({ ok, errors }) => ({ ok, errors: errors.map((error) => shown.text(printable({ rule: "workflow", detail: error }, secrets).detail)) })), digest: learning.compiled.digest ?? null, promoted: learning.compiled.promoted ?? null } : null,
    draft_errors: (learning.draft_errors ?? []).map((error) => shown.text(printable({ rule: "workflow", detail: error }, secrets).detail)),
    // What the job did with the learned workflows it was offered (store-reads/learning.ts learnedUseOf), each name cut of
    // the host's secrets.
    used: { workflows: (input.used?.workflows ?? []).map(({ name, calls, failed }) => ({ name: shown.name(name), calls, failed })) },
  };
}

/** GET /runs/{id}/learning/diff over the one store: once merged (its learning end, store-reads/learning.ts
 *  runLearningEnd), its merge commit against its parent, as its merge's script wrote it (`.agentrun/diffs/<run>.json` in
 *  its agent's learning folder); a run that merged nothing, no file, against the seed its launch's learning start names. A
 *  run that does not learn (no learning start and no learning end) is not_found. A file's patch is withheld when too large
 *  (as the script wrote it), or when it holds one of the host's secrets now (`shown`); any other is served as every
 *  learning text is (`shown.text`: a loopback address reads "a local address"). */
export async function runDiffOverStore(data: string, store: Store, runId: string, shown: Shown) {
  const [end, kept, launch, row] = await Promise.all([runLearningEnd(store, runId), store.learning.proposal(runId), launchOf(store, runId), store.runs.get(runId)]);
  const start = launch ? learningStartOf(launch) : undefined;
  if (!row || (!end && !start)) throw new ApiError("not_found", "the run does not learn, so it merged nothing");
  const file = (name: string, status: string, patch: string) => {
    const path = shown.name(name);
    if (Buffer.byteLength(patch) > PATCH_CAP) return { path, status, withheld: "too_large" };
    if (shown.holds(patch)) return { path, status, withheld: "secret" };
    const served = shown.text(patch);
    return Buffer.byteLength(served) > PATCH_CAP ? { path, status, withheld: "too_large" } : { path, status, patch: served };
  };
  if (end?.merged) {
    const folder = learningFolderOf(data, row.agentId);
    const diff = await readRunDiff(folder.workspace, runDiffKey(runId, kept?.round)).catch((error: unknown) => Promise.reject(routeFailure(error))).finally(() => folder.end());
    if (!diff || diff.merge !== end.merged) throw new ApiError("not_found", "the run's merge is not in its agent's learning folder");
    return { base: diff.parent, head: diff.merge, files: diff.files.map((entry) => ("patch" in entry ? file(entry.path, entry.status, entry.patch) : { path: shown.name(entry.path), status: entry.status, withheld: entry.withheld })) };
  }
  return { base: start?.seed ?? null, head: null, files: [] };
}
