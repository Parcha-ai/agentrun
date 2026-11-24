// What a person sees and controls of an agent's learning: this server's own routes under /v2 (learning/1).
// - Per agent: its newest save (`main`), its corrections.md, its workflow drafts, its log of saves (a page), and how its
//   runs' learning fared; a draft's file as text with its ETag (its blob id); a learned workflow's revisions.
// - corrections.md, read whole and replaced whole by a person (If-Match on the version read; neither header is 428),
//   refused whole when it would hold what must never be stored or pass the cap (learn/corrections.ts).
// - A person's approval of a draft that waits for the owner's OK, its retire and its restore: a precondition on its
//   README.md's version (If-Match), then one save of the agent's learning (learn/rows.ts writeLearning: compare and swap
//   on its newest version).
// - Per run: its learning whole, and once merged its diff: its merge's save against the one before it.
// Every read is the store's learning rows (Store.learning, learn/rows.ts). A purged run's rows are deleted with it, so no
// read here ever meets its text. A page's cursor names the version it stopped at, so a later page starts below it however
// the log grew. A text that leaves holding one of the host's secrets as they are now (a value made secret after it was
// written) is cut of it, a file's name holding one reads "[redacted]" whole, and a diff's file holding one is withheld.
import type { IncomingMessage, ServerResponse } from "node:http";
import { CORRECTIONS_CAP, draftProblems, frontKeys, isHeld, LEARNED_KEYS, learnedPlace, learnedStatus, type Problem, printable, released, restorable, restoredLearned, retiredLearned, UNCLEAR_FRONT, unclearFront, unstorable, WORKFLOW_NAME, WORKFLOWS_DIR } from "./learn/index.js";
import { readmeProblems, type DraftDecisions } from "./learn/workflow-draft.js";
import { putCorrections, readCorrections } from "./learn/commit.js";
import { blobOid, type ItemHistory, type LearnedItem, LearningBusy, learningOf, type LearningRead, type LearningRows, type LearningWrite, type LogChange, logChange, logOf, PATCH_CAP, type PersonKind, readLearning, readView, runDiff, runDiffKey, writeLearning } from "./learn/rows.js";
import { ApiError, invalid } from "./errors.js";
import type { ServingState } from "./learn/promote.js";
import { type ItemStatus, detailShown, filesView, type Learning, reasonShown, type Shown } from "./learning.js";
import type { Impact } from "./learning-run.js";
import { isObject } from "./validate.js";
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
type Change = LogChange;
export type Counts = { merged: number; dropped: Record<string, number>; in_progress: number };
export { secretsShown, type Shown } from "./learning.js";
/** The store's learning, as these routes read and write it. */
type Rows = { readonly learning: LearningRows };

export const etagOf = (oid: string) => `"${oid}"`;
const EMPTY: Page<never> = { items: [], total: 0, next_cursor: null };

/** A write's failure as a route answers it: a write that kept moving under it is 503. */
function routeFailure(error: unknown): unknown {
  if (error instanceof LearningBusy) return new ApiError("unavailable", error.message);
  return error;
}

/** A retired draft's `retired`: its newest retire by a person; else, one a person made retired another way, their
 *  newest change; else its newest change's time. `from`: the status its restore gives back (its retire recorded it,
 *  retired_from; none recorded reads pending). `unread`: the host could not read its README.md. */
const retiredOf = (history: ItemHistory, from: "active" | "pending" | undefined, unread = false): Retired => (unread ? { at: history.at, by: "host", why: "unreadable" } : { ...(history.retire ? { at: history.retire.at, by: "person" as const } : history.person ? { at: history.person.at, by: "person" as const } : { at: history.at, by: "run" as const }), from: from ?? "pending" });

/** A workflow draft as the view lists it: its folder's name, its workflow.json with its `readme`, its description, its
 *  status, the run whose text it is, its size in bytes, and the ETag of its README.md (the file that says whether it
 *  waits, which an approval names); cut of the host's secrets (a name or a file holding one reads [redacted]).
 *  `status` is one word: its README.md's `pending` or `retired`, else where it stands as the promotions read says it
 *  (`stateOf`, learn/promote.ts servingStateOf): `serving`, `checking`, `held` or `stopped`. */
type WorkflowView = { name: string; file: string; readme: string; description: string; status: "pending" | "retired" | ServingState; run: string | null; bytes: number; etag: string; retired?: Retired; last_change?: ItemHistory["last"] };
function workflowView(item: LearnedItem, shown: Shown, stateOf: (workflow: string) => ServingState, unread = false): WorkflowView {
  const file = `${WORKFLOWS_DIR}/${item.name}/workflow.json`;
  const bytes = item.files.find(({ path }) => path === file)?.bytes ?? item.bytes;
  const status = item.status === "active" ? stateOf(item.name) : item.status;
  return {
    name: shown.name(item.name), file: shown.name(file), readme: shown.name(item.file), description: shown.text(item.description), status, run: item.run, bytes, etag: etagOf(item.oid),
    ...(item.history.last ? { last_change: item.history.last } : {}),
    ...(item.status === "retired" ? { retired: retiredOf(item.history, item.retired_from, unread) } : {}),
  };
}

/** A save as the log shows it, cut of the host's secrets. */
const changeView = (change: LogChange, shown: Shown): Change => ({ by: change.by, commit: change.commit, at: change.at, reason: shown.text(change.reason), files: change.files.map(shown.name) });

const cursorOf = (main: string, before: number) => Buffer.from(`${main}.${before}`).toString("base64url");

/** A page's request: its limit (1 to PAGE_MAX), and the version its cursor says the page starts below. */
function pageRequest(query: URLSearchParams, fallback: number): { limit: number; before?: number } {
  const given = query.get("limit");
  const limit = given === null ? fallback : Number(given);
  if ((given !== null && !/^\d+$/.test(given)) || limit < 1 || limit > PAGE_MAX) throw new ApiError("bad_request", `limit is an integer from 1 to ${PAGE_MAX}`);
  const cursor = query.get("cursor");
  if (cursor === null) return { limit };
  const named = /^[0-9a-f]{40}\.(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!named) throw new ApiError("bad_request", "cursor is not one this server gave");
  return { limit, before: Number(named[1]) };
}

/** A page of the agent's log, newest first, cut of the host's secrets: below version `before` when given. */
async function logPage(rows: Rows, agentId: string, main: string, page: { limit: number; before?: number }, shown: Shown): Promise<Page<Change>> {
  const { changes, more, total } = await logOf(learningOf(rows, agentId), page);
  const last = changes.at(-1);
  return { items: changes.map(({ change }) => changeView(change, shown)), total, next_cursor: more && last ? cursorOf(main, last.version) : null };
}

/** For tests: how many times an agent's statuses were read (once per save of its learning). */
export const pendingTestHooks = { reads: 0 };
/** By agent: its newest save and each draft's status there. */
const statusBy = new Map<string, { main: string; status: ReadonlyMap<string, ItemStatus> }>();

/** Each workflow draft's status at agent `agentId`'s newest save, by its workflow.json (as its README.md says it):
 *  `active`, `pending` or `retired`. Built once per save (a list asks for many runs). An agent with no save holds none;
 *  one whose learning cannot be read is undefined. */
export async function statusesOf(rows: Rows, agentId: string): Promise<ReadonlyMap<string, ItemStatus> | undefined> {
  try {
    const view = await readView(learningOf(rows, agentId));
    if (!view) return new Map();
    const known = statusBy.get(agentId);
    if (known?.main === view.main) return known.status;
    pendingTestHooks.reads += 1;
    const status = new Map<string, ItemStatus>(view.workflows.map((item): [string, ItemStatus] => [`${WORKFLOWS_DIR}/${item.name}/workflow.json`, { status: item.status }]));
    statusBy.set(agentId, { main: view.main, status });
    return status;
  } catch {
    return undefined;
  }
}

/** How many of agent `agentId`'s workflow drafts wait for its owner's OK at its newest save (statusesOf). An agent with
 *  no save has none waiting; one that cannot be read is undefined (the caller shows no count). */
export async function pendingCount(rows: Rows, agentId: string): Promise<number | undefined> {
  const status = await statusesOf(rows, agentId);
  return status === undefined ? undefined : [...status.values()].filter((value) => value.status === "pending").length;
}

/** GET /agents/{id}/learning: its newest save, its corrections.md, its workflow drafts and the first page of its log, and
 *  how the agent's runs fared and what learning changed for them (`counts`, `impact`); an agent with no save (its learning
 *  never on) has an empty one. `stateOf`: where each workflow neither pending nor retired stands, by its folder name (the
 *  promotions read's own word: learn/promote.ts servingStateOf over the agent's records). */
type AgentView = { agent: string; main: string | null; corrections: string; workflows: WorkflowView[]; log: Page<Change>; counts: Counts; impact: Impact };
export async function agentLearning(rows: Rows, agentId: string, shown: Shown, counts: Counts, impact: Impact, stateOf: (workflow: string) => ServingState): Promise<AgentView> {
  return readLearning(learningOf(rows, agentId), async (read) => {
    const { view } = read;
    if (!view) return { agent: agentId, main: null, corrections: "", workflows: [], log: EMPTY, counts, impact };
    const corrections = readCorrections(read).text;
    // A retired draft whose README.md can't be read is said so (unclearFront), read from its file as its status was.
    const unread = (item: LearnedItem) => item.status === "retired" && unclearFront(read.text(item.file) ?? "");
    return { agent: agentId, main: view.main, corrections: shown.text(corrections), workflows: view.workflows.map((item) => workflowView(item, shown, stateOf, unread(item))), log: await logPage(rows, agentId, view.main, { limit: LOG_PAGE }, shown), counts, impact };
  });
}

/** GET /agents/{id}/learning/log?cursor=&limit=: a page of the agent's log, newest first. */
export async function learningLog(rows: Rows, agentId: string, query: URLSearchParams, shown: Shown): Promise<Page<Change>> {
  const page = pageRequest(query, LOG_PAGE);
  const view = await readView(learningOf(rows, agentId));
  return view ? logPage(rows, agentId, view.main, page, shown) : EMPTY;
}

/** GET /agents/{id}/learning/corrections: corrections.md at the newest save as text (empty when it holds none), its ETag
 *  (its blob id; an empty file's when there is none) and the cap a PUT keeps to, cut of the host's secrets as every read
 *  is. */
export async function correctionsView(rows: Rows, agentId: string, shown: Shown): Promise<{ text: string; etag: string; cap_bytes: number }> {
  const read = await readLearning(learningOf(rows, agentId), readCorrections);
  return { text: shown.text(read.text), etag: etagOf(read.oid), cap_bytes: CORRECTIONS_CAP };
}

/** PUT /agents/{id}/learning/corrections: corrections.md replaced whole by a person (`text`), only over the version they
 *  read (`ifMatch`: its ETag; none, or `*`, is 428; another version is 412). Refused whole, nothing written, when it holds
 *  what must never be stored (a host secret, text shaped like one, a hidden character) or passes the cap (422 with the
 *  problems, printable). A text read cut of a secret and sent back replaces the secret with the cut: a person's write never
 *  puts a secret back. One save. */
export async function correctionsWrite(rows: Rows, agentId: string, input: { text: string; ifMatch?: string; refuse: readonly string[] }): Promise<{ text: string; etag: string; cap_bytes: number }> {
  const match = input.ifMatch?.trim();
  if (!match || match === "*") throw new ApiError("precondition_required", "A write names the version it read: If-Match with corrections.md's ETag, as GET answered it.");
  try {
    const done = await putCorrections(learningOf(rows, agentId), { text: input.text, ifMatch: match, refuseValues: input.refuse });
    if (done.ok) return { text: done.text, etag: etagOf(done.oid), cap_bytes: CORRECTIONS_CAP };
    if (done.reason === "conflict") throw new ApiError("precondition_failed", "corrections.md changed since it was read (a run's correction, or another edit): read it again.");
    const problems = done.problems.map((problem) => printable(problem, input.refuse));
    throw invalid(problems.map((problem) => ({ field: "text", reason: problem.rule, message: problem.detail })));
  } catch (error) {
    throw routeFailure(error);
  }
}

/** The most revisions a workflow's history answers, and its default. */
const REVISIONS_MAX = 50;
const REVISIONS_DEFAULT = 20;
/** One revision of a learned workflow: a save that changed its workflow.json, with its text there (null when the save
 *  deleted it), cut of the host's secrets. */
type WorkflowRevision = { commit: string; at: string; by: Change["by"]; reason: string; text: string | null; digest: string | null };

/** Learned workflow `name`'s workflow.json at each of its versions, oldest first, with the save that wrote it: one per
 *  version that changed its text. */
async function revisionsOf(rows: Rows, agentId: string, name: string): Promise<{ change: LogChange; text: string | null; digest: string | null }[]> {
  const path = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  const out: { change: LogChange; text: string | null; digest: string | null }[] = [];
  let before: string | null = null;
  // Store.learning.versions answers newest first; a revision is read against the one before it.
  for (const version of (await rows.learning.versions(agentId, "workflow", name)).reverse()) {
    const text = version.body === null ? null : (JSON.parse(version.body) as Record<string, string>)[path] ?? null;
    const change = logChange(version.save);
    if (text !== before && change) out.push({ change, text, digest: text === null ? null : version.digest });
    before = text;
  }
  return out;
}

/** GET /agents/{id}/learning/workflows/{name}/revisions?limit=: the latest revisions of learned workflow `name` (the
 *  saves that changed `workflows/<name>/workflow.json`), oldest first, each with the workflow's text there, so a person
 *  can step through how it changed: at most `limit` of them. `total` counts every such save; `truncated` is false, the
 *  rows keep every one. A purged run's save is no revision: its rows went with it. A workflow no save changed is
 *  not_found. */
export async function workflowRevisions(rows: Rows, agentId: string, name: string, query: URLSearchParams, shown: Shown): Promise<{ name: string; revisions: WorkflowRevision[]; total: number; truncated: boolean }> {
  if (!WORKFLOW_NAME.test(name)) throw new ApiError("bad_request", "A workflow's folder is named with lowercase letters, digits, dashes and underscores.");
  const given = query.get("limit");
  const limit = given === null ? REVISIONS_DEFAULT : Number(given);
  if ((given !== null && !/^\d+$/.test(given)) || limit < 1 || limit > REVISIONS_MAX) throw new ApiError("bad_request", `limit is an integer from 1 to ${REVISIONS_MAX}`);
  const path = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  if (shown.name(path) !== path) throw new ApiError("not_found", "the agent's learning has no such workflow");
  const all = await revisionsOf(rows, agentId, name);
  if (!all.length) throw new ApiError("not_found", "the agent's learning has no such workflow");
  // Its digest, read from the text as it is (workflow-first.ts workflowDigest's): the one a run's metrics and the
  // promotion records name, so a revision's runs and promotion are found by it.
  const revisions = all.slice(-limit).map(({ change, text, digest }) => ({ commit: change.commit, at: change.at, by: change.by, reason: shown.text(change.reason), text: text === null ? null : shown.text(text), digest }));
  return { name, revisions, total: all.length, truncated: false };
}

/** Learned workflow `name`'s text at `digest` (a champion's, as its promotion records name it), read by that digest and
 *  never by paging the workflow's history: its newest version whose workflow.json is that digest's, with the save it was
 *  written at. Undefined when none is. */
export async function workflowAtDigest(rows: Rows, agentId: string, name: string, digest: string): Promise<{ text: string; commit: string } | undefined> {
  if (!WORKFLOW_NAME.test(name)) return undefined;
  const found = (await revisionsOf(rows, agentId, name)).findLast((one) => one.digest === digest && one.text !== null);
  return found ? { text: found.text!, commit: found.change.commit } : undefined;
}

/** The text of a draft's `file` at the read's save; undefined when it holds no such file. */
function fileIn(read: LearningRead, file: string): string | undefined {
  const place = learnedPlace(file);
  if (!read.view || !place) return undefined;
  return read.view.workflows.some((item) => item.name === place.name && item.files.some(({ path }) => path === file)) ? read.text(file) : undefined;
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

/** GET /agents/{id}/learning/files/{file}: a draft's file at the newest save as text, its ETag, and its type
 *  (workflow.json is JSON). A purged run's workflow went with its rows, so its files are the 404 any missing file is. */
export async function readLearnedFile(rows: Rows, agentId: string, raw: string, shown: Shown): Promise<{ text: string; etag: string; type?: string }> {
  const file = fileOf(raw, "read");
  const text = await readLearning(learningOf(rows, agentId), (read) => fileIn(read, file));
  if (text === undefined) throw new ApiError("not_found", "the agent's learning has no such file");
  return { text: shown.text(text), etag: etagOf(blobOid(text)), ...(file.endsWith(".json") ? { type: "application/json; charset=utf-8" } : {}) };
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
 *  (`file`): If-Match on the version read (none, or `*`, is 428; another is 412), then one save of the agent's learning
 *  (learn/rows.ts writeLearning), its reason `<approved|retired|restored> by a person: <file>`, and an approval's said to
 *  come through the console. An approval releases a held draft (status: pending) to every later run; a retire takes it
 *  out of every later run unchecked, so a leaking one can always be revoked; a restore brings it back to the status its
 *  retire recorded, checked again as a new draft is (secrets' shapes, the host's values, hidden characters, its README's
 *  format, its workflow.json against the agent's tools and gate). A retire of a retired draft saves nothing. `refuse`:
 *  the host's secrets. */
export async function changeWorkflow(rows: Rows, agentId: string, raw: string, input: { action: "approve" | "retire" | "restore"; ifMatch?: string; refuse: readonly string[]; draftTools?: DraftTools }): Promise<{ status: 200; file: string; text: string; etag: string }> {
  const file = fileOf(raw, input.action);
  const place = learnedPlace(file)!;
  const match = input.ifMatch?.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (match?.includes("*")) throw new ApiError("precondition_required", "If-Match: * names no version: send the README's ETag, as GET answered it.");
  if (!match?.length) throw new ApiError("precondition_required", "A change names the version it read: If-Match with the README's ETag.");
  type Written = { status: 200; file: string; text: string; etag: string };
  try {
    const { result } = await writeLearning<Written>(learningOf(rows, agentId), async (read) => {
      const now = fileIn(read, file);
      if (now === undefined) throw new ApiError("not_found", "the agent's learning has no such workflow");
      const current = { oid: blobOid(now), text: now };
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
        const others = read.view!.workflows.find((item) => item.name === place.name)?.files.filter(({ path }) => path !== file) ?? [];
        const changes = [{ path: file, status: "modified" as const, bytes: Buffer.from(text, "utf8") }, ...others.map(({ path }) => ({ path, status: "modified" as const, bytes: Buffer.from(read.text(path) ?? "", "utf8") }))];
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
        // One already retired is answered as it is; nothing else changes.
        if (learnedStatus(current.text) === "retired") return { result: { status: 200, file, text: current.text, etag: etagOf(current.oid) } };
        text = retiredLearned(current.text);
      } else {
        // Approved, it is no longer held: given to every later run. Nothing else changes.
        if (!isHeld(current.text)) throw new ApiError("bad_request", `The workflow is not waiting for an OK: it is ${learnedStatus(current.text)}.`);
        text = released(current.text);
      }
      const kind: PersonKind = input.action === "approve" ? "approved" : input.action === "restore" ? "restored" : "retired";
      const change: LearningWrite = { by: { person: kind, file, approved: input.action === "approve" }, writes: [{ path: file, text }] };
      return { result: { status: 200, file, text, etag: etagOf(blobOid(text)) }, change };
    });
    return result;
  } catch (error) {
    throw routeFailure(error);
  }
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
 *  runLearningEnd), its merge's save against the one before it (learn/rows.ts runDiff); a run that merged nothing
 *  against the seed its launch's learning start names. A run that does not learn (no learning start and no learning
 *  end) is not_found, as a merge its agent's learning no longer holds is. A file's patch is withheld when too large, or
 *  when it holds one of the host's secrets now (`shown`); any other is served as every learning text is (`shown.text`:
 *  a loopback address reads "a local address"). */
export async function runDiffOverStore(store: Store, runId: string, shown: Shown) {
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
    const diff = await runDiff(learningOf(store, row.agentId), runDiffKey(runId, kept?.round));
    if (!diff || diff.merge !== end.merged) throw new ApiError("not_found", "the run's merge is not in its agent's learning");
    return { base: diff.parent, head: diff.merge, files: diff.files.map((entry) => file(entry.path, entry.status, entry.patch)) };
  }
  return { base: start?.seed ?? null, head: null, files: [] };
}
