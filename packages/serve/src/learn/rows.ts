// An agent's learning as the routes, a run's seed and a run's merge read and write it, over the store's learning rows
// (store/sqlite/learning-rows.ts). The rows keep items: each line of the owner's corrections.md a note, each learned
// workflow's folder a workflow (its files whole, by path). This module turns them into what a person and a run see:
// corrections.md's text, each workflow's files and what its README.md says (LearningView), the log of saves, a run's
// merge as a patch (runDiff); and a write of files into item versions (writeLearning), computed on the agent's newest
// version and saved by compare and swap on it, computed again when another write landed first.
import { createHash } from "node:crypto";
import type { LearningAt, LearningItem, LearningItemWrite, LearningSave, Store } from "../store/store.js";
import { CORRECTIONS_FILE } from "./corrections.js";
import { learnedFront, learnedStatus, retiredFrom, WORKFLOW_NAME, WORKFLOWS_DIR, workflowRunOf } from "./workflow-draft.js";

/** A diff's file whose patch is larger than this is withheld as too large. */
export const PATCH_CAP = 64 * 1024;
/** How many times a write is computed again on a newest version that moved under it. */
const WRITE_TRIES = 3;

/** The store's learning rows, as this module reads and writes them. */
export type LearningRows = Pick<Store["learning"], "seed" | "newest" | "itemsAt" | "saves" | "saveOf" | "versions" | "diff" | "save">;
/** One agent's learning: the rows and the agent. */
export type AgentLearning = { readonly rows: LearningRows; readonly agentId: string };
export const learningOf = (store: { readonly learning: LearningRows }, agentId: string): AgentLearning => ({ rows: store.learning, agentId });

/** A file's ETag: git's blob id of its bytes (the sha1 of "blob <length>\0" and the bytes), kept from when the folder was
 *  git, so an ETag a client holds keeps its meaning. */
export const blobOid = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
};
/** A workflow's digest: its workflow.json's (runner/workflow-first.ts workflowDigest), which its promotions name. */
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The workflow a path is in, by name: `workflows/<name>/...`; else undefined. */
export function folderOf(path: string): string | undefined {
  const [top, name, ...rest] = path.split("/");
  return top === WORKFLOWS_DIR && name && rest.length ? name : undefined;
}
const keyFile = (name: string) => `${WORKFLOWS_DIR}/${name}/README.md`;
const viewFile = (name: string) => `${WORKFLOWS_DIR}/${name}/workflow.json`;

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** The merge key of a run's round: the run's id for its first, `<run>.r<round>` for each later one (a follow-up's
 *  look-back), so each round merges once. */
export const runDiffKey = (runId: string, round = 1): string => (round > 1 ? `${runId}.r${round}` : runId);

// ---------------------------------------------------------------------------------------------------------------------
// The view.

export type PersonKind = "approved" | "edited" | "created" | "retired" | "restored";
export type LastChange = { kind: PersonKind | "learned"; by: "person" | "run"; at: string };
/** A workflow's history: when it last changed and how, its newest retire and its newest change by a person. */
export type ItemHistory = { at: string; last?: LastChange; retire?: LastChange; person?: LastChange };
export type ViewFile = { path: string; oid: string; bytes: number };
/** A learned workflow as the view lists it: its README.md (`file`, `oid`, `bytes`), what it says (description, status,
 *  the status a retire recorded), the run whose text it is (`run`), its files and its history. */
export type LearnedItem = {
  name: string; file: string; description: string;
  status: "active" | "pending" | "retired";
  retired_from?: "active" | "pending";
  run: string | null;
  files: ViewFile[];
  oid: string; bytes: number;
  history: ItemHistory;
};
/** A save as the log shows it: its version id, when, who (a run, or a person and how), why and the paths it changed. */
export type LogChange = { commit: string; at: string; by: { run: string } | { user: true; via?: string }; reason: string; files: string[] };
/** The agent's learning at one save: its version id (`main`), corrections.md (absent: no line), its workflows. */
export type LearningView = { main: string; version: number; at: string; corrections?: ViewFile; workflows: LearnedItem[] };
/** What a reader is given: the view (undefined: the agent has no save yet) and each file's text by path. */
export type LearningRead = { view: LearningView | undefined; text: (path: string) => string | undefined };

const fileOf = (path: string, text: string): ViewFile => ({ path, oid: blobOid(text), bytes: Buffer.byteLength(text, "utf8") });
const filesOf = (item: Pick<LearningItem, "body">): Record<string, string> => (item.body === null ? {} : (JSON.parse(item.body) as Record<string, string>));
const notesOf = (at: LearningAt | undefined) => (at?.items ?? []).filter((item) => item.kind === "note").sort((a, b) => a.pos - b.pos || byBytes(a.name, b.name));
const correctionsText = (at: LearningAt | undefined): string | undefined => {
  const notes = notesOf(at);
  return notes.length ? `${notes.map((note) => note.body ?? "").join("\n")}\n` : undefined;
};
/** corrections.md as its notes hold it: every line ends in a newline, the last one too, so no note is an empty line
 *  past the end (whose run's purge would change how the file ends). */
const asNotes = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** A version's change as the history says it. */
const lastOf = (item: Pick<LearningItem, "change" | "person" | "at">): LastChange => ({ kind: item.change, by: item.person ? "person" : "run", at: iso(item.at) });

/** What `at` holds, as a reader reads it. */
export function readOf(at: LearningAt | undefined): LearningRead {
  if (!at) return { view: undefined, text: () => undefined };
  const texts = new Map<string, string>();
  const corrections = correctionsText(at);
  if (corrections !== undefined) texts.set(CORRECTIONS_FILE, corrections);
  const workflows: LearnedItem[] = [];
  for (const item of at.items) {
    if (item.kind !== "workflow" || !WORKFLOW_NAME.test(item.name)) continue;
    const files = filesOf(item);
    for (const [path, text] of Object.entries(files)) texts.set(path, text);
    const readme = files[keyFile(item.name)];
    if (readme === undefined || files[viewFile(item.name)] === undefined) continue;
    const versions = at.history.filter((one) => one.kind === "workflow" && one.name === item.name).sort((a, b) => a.version - b.version);
    const newest = versions.at(-1) ?? item;
    const retire = versions.findLast((one) => one.change === "retired" && one.person);
    const person = versions.findLast((one) => one.person);
    const status = learnedStatus(readme);
    workflows.push({
      name: item.name, file: keyFile(item.name), description: learnedFront(readme)?.description ?? "", status,
      ...(status === "retired" ? { retired_from: retiredFrom(readme) } : {}),
      run: item.byRun,
      files: Object.entries(files).map(([path, text]) => fileOf(path, text)).sort((a, b) => byBytes(a.path, b.path)),
      ...(({ oid, bytes }) => ({ oid, bytes }))(fileOf(keyFile(item.name), readme)),
      history: { at: iso(newest.at), last: lastOf(newest), ...(retire ? { retire: lastOf(retire) } : {}), ...(person ? { person: lastOf(person) } : {}) },
    });
  }
  const view: LearningView = {
    main: at.save.id, version: at.save.version, at: iso(at.save.at),
    ...(corrections !== undefined ? { corrections: fileOf(CORRECTIONS_FILE, corrections) } : {}),
    workflows: workflows.sort((a, b) => byBytes(a.name, b.name)),
  };
  return { view, text: (path) => texts.get(path) };
}

/** `read` over the agent's learning at its newest save. */
export async function readLearning<T>(learning: AgentLearning, read: (folder: LearningRead) => T | Promise<T>): Promise<T> {
  return read(readOf(await learning.rows.newest(learning.agentId)));
}

/** The agent's learning at its newest save; undefined before its first. */
export const readView = async (learning: AgentLearning): Promise<LearningView | undefined> => readOf(await learning.rows.newest(learning.agentId)).view;

/** The agent's learning as save `id` left it, read now (a purged run's text gone from it); undefined when the agent's
 *  learning holds no such save. */
export async function readAt(learning: AgentLearning, id: string): Promise<LearningRead | undefined> {
  const at = await learning.rows.itemsAt(learning.agentId, id);
  return at ? readOf(at) : undefined;
}

/** Whether the agent's learning holds save `id`. */
export const holdsSave = async (learning: AgentLearning, id: string): Promise<boolean> => (await learning.rows.saveOf(learning.agentId, { id })) !== undefined;

/** A save as the log shows it; undefined for the host's (an init, a purged run's). */
export function logChange(save: LearningSave): LogChange | undefined {
  if ("host" in save.by) return undefined;
  const by = "run" in save.by ? { run: save.by.run } : { user: true as const, ...(save.by.approved ? { via: "console" } : {}) };
  return { commit: save.id, at: iso(save.at), by, reason: save.reason, files: [...save.files] };
}

/** A page of the agent's log, newest first: at most `limit`, below version `before` when given. */
export async function logOf(learning: AgentLearning, page: { limit: number; before?: number }): Promise<{ changes: { change: LogChange; version: number }[]; more: boolean; total: number }> {
  const { saves, more, total } = await learning.rows.saves(learning.agentId, page);
  return { changes: saves.flatMap((save) => { const change = logChange(save); return change ? [{ change, version: save.version }] : []; }), more, total };
}

// ---------------------------------------------------------------------------------------------------------------------
// A run's merge as a patch.

/** A run's merge: its version id, its parent's (null: none before it), and each file it changed with its patch. */
export type RunDiff = {
  run: string; merge: string; parent: string | null;
  files: { path: string; status: "added" | "modified" | "deleted"; patch: string }[];
};

/** The merge of the run's round `key` (runDiffKey), or undefined when it never merged, or its run was purged. */
export async function runDiff(learning: AgentLearning, key: string): Promise<RunDiff | undefined> {
  const save = await learning.rows.saveOf(learning.agentId, { mergeKey: key });
  if (!save || "host" in save.by) return undefined;
  const diff = await learning.rows.diff(learning.agentId, save.id);
  if (!diff) return undefined;
  const files: RunDiff["files"] = [];
  const add = (path: string, before: string | undefined, after: string | undefined) => {
    if (before === after) return;
    files.push({ path, status: before === undefined ? "added" : after === undefined ? "deleted" : "modified", patch: unifiedPatch(before ?? "", after ?? "") });
  };
  for (const item of diff.items) {
    if (item.kind !== "workflow") continue;
    const [before, after] = [filesOf({ body: item.before }), filesOf({ body: item.after })];
    for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byBytes)) add(path, before[path], after[path]);
  }
  if (diff.items.some((item) => item.kind === "note")) {
    const [before, after] = await Promise.all([diff.parent ? learning.rows.itemsAt(learning.agentId, diff.parent.id) : undefined, learning.rows.itemsAt(learning.agentId, save.id)]);
    add(CORRECTIONS_FILE, correctionsText(before), correctionsText(after));
  }
  return { run: key, merge: save.id, parent: diff.parent?.id ?? null, files: files.sort((a, b) => byBytes(a.path, b.path)) };
}

/** Run `runId`'s merge of `round` (runDiff), or undefined when it never merged. */
export const runMergeOf = (learning: AgentLearning, runId: string, round = 1): Promise<RunDiff | undefined> => runDiff(learning, runDiffKey(runId, round));

/** Lines of `text`, the last one marked when the text does not end in a newline (git's "\ No newline at end of file"). */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  else lines[lines.length - 1] = `${lines.at(-1)}\0`;
  return lines;
}
const NO_NEWLINE = "\\ No newline at end of file\n";
const lineOut = (mark: string, line: string) => (line.endsWith("\0") ? `${mark}${line.slice(0, -1)}\n${NO_NEWLINE}` : `${mark}${line}\n`);

/** `before` to `after` as git's unified diff writes a file's hunks (three lines of context, a hunk's count left out when
 *  it is one, the start the line before when it is none). Empty when they are the same. */
export function unifiedPatch(before: string, after: string): string {
  const a = linesOf(before);
  const b = linesOf(after);
  // The longest common subsequence, by lines; a pair of files too long for it is written as all removed, all added.
  type Op = { op: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  if (a.length * b.length <= 4_000_000) {
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    let [i, j] = [0, 0];
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ op: " ", line: a[i]!, ai: i++, bi: j++ });
      else if (j < b.length && (i >= a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) ops.push({ op: "+", line: b[j]!, ai: i, bi: j++ });
      else ops.push({ op: "-", line: a[i]!, ai: i++, bi: j });
    }
  } else {
    a.forEach((line, i) => ops.push({ op: "-", line, ai: i, bi: 0 }));
    b.forEach((line, j) => ops.push({ op: "+", line, ai: a.length, bi: j }));
  }
  const CONTEXT = 3;
  const changed = ops.flatMap((one, k) => (one.op === " " ? [] : [k]));
  let out = "";
  for (let c = 0; c < changed.length;) {
    // A hunk: CONTEXT lines around each change, changes closer than 2 * CONTEXT lines of context in one.
    let last = c;
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * CONTEXT + 1) last++;
    const hunk = ops.slice(Math.max(0, changed[c]! - CONTEXT), Math.min(ops.length, changed[last]! + CONTEXT + 1));
    const olds = hunk.filter((one) => one.op !== "+").length;
    const news = hunk.filter((one) => one.op !== "-").length;
    const range = (from: number, count: number) => (count === 1 ? `${from + 1}` : `${count ? from + 1 : from},${count}`);
    out += `@@ -${range(hunk[0]!.ai, olds)} +${range(hunk[0]!.bi, news)} @@\n`;
    for (const one of hunk) out += lineOut(one.op, one.line);
    c = last + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing.

/** A change to the agent's learning: what a person or a run's merge writes, as files (corrections.md, a workflow's
 *  `workflows/<name>/<file>`). `same`: paths that must be at the newest version as they are at another save (a run's
 *  seed, or the save a revision's text was read at). `seed`: a save the agent's learning must still hold (a run's seed:
 *  a reset removed it, and the whole merge is refused). */
export type LearningWrite = {
  by: { person: PersonKind; file: string; approved?: boolean } | { run: string; reason: string; round?: number };
  writes: readonly { path: string; text: string }[];
  deletes?: readonly string[];
  same?: readonly { at: string; path: string }[];
  seed?: string;
  /** The saves the write's text was read at (a run's seed, a revised workflow's base): refused whole when a run's purge
   *  came after one (Store.learning save's `readAt`). */
  readAt?: readonly string[];
};

/** A write that kept moving under its compute, WRITE_TRIES times: routes answer 503. */
export class LearningBusy extends Error {
  constructor() {
    super("the agent's learning kept changing under this write: try again");
    this.name = "LearningBusy";
  }
}
/** A write's preconditions that failed at the newest version: nothing was written. */
export class LearningRefused extends Error {
  readonly same: string[];
  /** A run's merge whose seed the agent's learning no longer holds: its learning was reset. */
  readonly seed: string | undefined;
  /** A run's merge read at a save (`purged`, its id) that a run's purge came after: purged since its seed. */
  readonly purged: string | undefined;
  constructor(refused: { same: string[]; seed?: string; purged?: string }) {
    super(`the agent's learning refused the write: ${[...(refused.seed !== undefined ? [`the run's seed ${refused.seed} is not held`] : []), ...(refused.purged !== undefined ? [`a run's purge came after save ${refused.purged}, which it was read at`] : []), ...refused.same.map((path) => `${path} changed`)].join(", ")}`);
    this.name = "LearningRefused";
    this.same = refused.same;
    this.seed = refused.seed;
    this.purged = refused.purged;
  }
}
/** A run's round that merged already (another call: a reclaimed run racing its first claim): its save. */
export class LearningMerged extends Error {
  readonly save: LearningSave;
  constructor(save: LearningSave) {
    super(`the run merged already, at ${save.id}`);
    this.name = "LearningMerged";
    this.save = save;
  }
}

/** The item versions `change` writes on `at` (version `version` once saved), and the paths whose text it changes. */
function itemsFor(at: LearningAt | undefined, read: LearningRead, change: LearningWrite, version: number): { items: LearningItemWrite[]; files: string[] } {
  const run = "run" in change.by ? change.by.run : undefined;
  const kind = "run" in change.by ? "learned" as const : change.by.person;
  const person = run === undefined;
  const writes = new Map(change.writes.map(({ path, text }) => [path, text]));
  const deletes = new Set(change.deletes ?? []);
  const items: LearningItemWrite[] = [];
  const files: string[] = [];
  for (const path of [...writes.keys(), ...deletes]) {
    if (path !== CORRECTIONS_FILE && folderOf(path) === undefined) throw new Error(`${path} is no learning file: corrections.md or a workflow's workflows/<name>/<file>`);
  }
  // corrections.md: one note a line, matched to the lines there by their longest common run; a line kept keeps its
  // item (moved when its place changed). A line the run left out whose words an old note left out also holds is that
  // note moved, matched one to one in order (a reorder moves a line outside the longest run): it keeps its writer, so
  // its run's purge still takes it. Only words no such note holds are a new item; a note left unmatched is ended.
  if (writes.has(CORRECTIONS_FILE) || deletes.has(CORRECTIONS_FILE)) {
    const text = asNotes(writes.get(CORRECTIONS_FILE) ?? "");
    if (text !== (read.text(CORRECTIONS_FILE) ?? "")) files.push(CORRECTIONS_FILE);
    const old = notesOf(at);
    const lines = text === "" ? [] : text.slice(0, -1).split("\n");
    const width = lines.length + 1;
    const lcs = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) for (let j = lines.length - 1; j >= 0; j--) lcs[i * width + j] = old[i]!.body === lines[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    // Each line's old note (undefined: none in the longest run), and the old notes the longest run left out.
    const kept: (LearningItem | undefined)[] = lines.map(() => undefined);
    const left: LearningItem[] = [];
    let [i, j] = [0, 0];
    while (i < old.length || j < lines.length) {
      if (i < old.length && j < lines.length && old[i]!.body === lines[j]) kept[j++] = old[i++]!;
      else if (j < lines.length && (i >= old.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) j++;
      else left.push(old[i++]!);
    }
    // A line outside the longest run takes the first old note left out with its words, in order.
    const leftBy = new Map<string, LearningItem[]>();
    for (const note of left) leftBy.set(note.body ?? "", [...(leftBy.get(note.body ?? "") ?? []), note]);
    lines.forEach((line, pos) => { kept[pos] ??= leftBy.get(line)?.shift(); });
    const moved = new Set(kept);
    lines.forEach((line, pos) => {
      const note = kept[pos];
      if (!note) items.push({ kind: "note", name: `${version}.${pos}`, body: line, byRun: run ?? null, change: kind, person, pos, digest: null, writers: null });
      else if (note.pos !== pos) items.push({ kind: "note", name: note.name, body: note.body, byRun: note.byRun, change: note.change, person: note.person, pos, digest: null, writers: null });
    });
    for (const note of left) if (!moved.has(note)) items.push({ kind: "note", name: note.name, body: null, byRun: note.byRun, change: kind, person, pos: note.pos, digest: null, writers: null });
  }
  // Each workflow touched: a run's merge writes it whole (its folder is the files the run gives); a person's change keeps
  // its files as they are, with the writes and deletes in its folder. Gone when none is left. Each file keeps its writer
  // (LearningItem.writers): the run whose merge changed it to its text. A file given as it is (a run's merge that copies
  // it unchanged), and a person's edit of a file, keep the writer before; a run's change of it is the run's; a person's
  // new file is no run's. So a purge takes back only the files the run wrote, each to its text before.
  const names = new Set([...writes.keys(), ...deletes].map(folderOf).filter((name): name is string => name !== undefined));
  for (const name of [...names].sort(byBytes)) {
    const now = at?.items.find((item) => item.kind === "workflow" && item.name === name);
    const files0 = now ? filesOf(now) : {};
    const next: Record<string, string> = run === undefined ? { ...files0 } : {};
    for (const path of Object.keys(next)) if (folderOf(path) === name && deletes.has(path)) delete next[path];
    for (const [path, text] of writes) if (folderOf(path) === name) next[path] = text;
    const paths = [...new Set([...Object.keys(files0), ...Object.keys(next)])].sort(byBytes);
    const changed = paths.filter((path) => files0[path] !== next[path]);
    if (!changed.length) continue;
    files.push(...changed);
    const kept = Object.keys(next).sort(byBytes);
    const json = next[viewFile(name)];
    const before = now?.writers ?? {};
    const writerOf = (path: string): string | null => {
      const was = Object.hasOwn(files0, path) ? (before[path] ?? null) : null;
      if (Object.hasOwn(files0, path) && files0[path] === next[path]) return was;
      return run ?? was;
    };
    const writers = Object.fromEntries(kept.map((path) => [path, writerOf(path)]));
    items.push({
      kind: "workflow", name, body: kept.length ? JSON.stringify(Object.fromEntries(kept.map((path) => [path, next[path]!]))) : null,
      // The workflow's run is its workflow.json's writer (what its promotions are of); its README.md's when it has none.
      byRun: workflowRunOf(name, writers), change: kind, person, pos: 0, digest: json === undefined ? null : digestOf(json),
      writers: kept.length ? writers : null,
    });
  }
  return { items, files: files.sort(byBytes) };
}

/**
 * A write to the agent's learning: `compute` reads it at its newest save and says what to write, or nothing (its result
 * stands alone). Saved by compare and swap on that version; another write landing first computes it again on the newest
 * (WRITE_TRIES in all, then LearningBusy). Throws LearningRefused when a precondition fails (a file changed since it was
 * read, a seed a reset removed, a run's purge since a save it was read at), LearningMerged when a run's round merged
 * already.
 */
export async function writeLearning<T>(learning: AgentLearning, compute: (folder: LearningRead) => Promise<{ result: T; change?: LearningWrite }>, maxTries = WRITE_TRIES): Promise<{ result: T; saved?: LearningSave }> {
  const { rows, agentId } = learning;
  for (let tries = 0; tries < maxTries; tries++) {
    const at = await rows.newest(agentId);
    const read = readOf(at);
    const out = await compute(read);
    if (!out.change) return { result: out.result };
    const change = out.change;
    // A seed the agent's learning no longer holds (a reset since) refuses the whole write as that, before any file is
    // compared with what it held.
    if (change.seed !== undefined && change.seed !== at?.save.id && !(await rows.saveOf(agentId, { id: change.seed }))) throw new LearningRefused({ same: [], seed: change.seed });
    const same: string[] = [];
    for (const { at: then, path } of change.same ?? []) {
      const was = then === at?.save.id ? read : await readAt(learning, then);
      if (!was || was.text(path) !== read.text(path)) same.push(path);
    }
    if (same.length) throw new LearningRefused({ same });
    const base = at?.save.version ?? 0;
    const { items, files } = itemsFor(at, read, change, base + 1);
    const by = change.by;
    const done = await rows.save(agentId, {
      base, files, items,
      by: "run" in by ? { run: by.run, ...(by.round !== undefined && by.round > 1 ? { round: by.round } : {}) } : { person: by.person, file: by.file, ...(by.approved ? { approved: true } : {}) },
      reason: "run" in by ? by.reason : `${by.person} by a person: ${by.file}`,
      ...("run" in by ? { mergeKey: runDiffKey(by.run, by.round) } : {}),
      ...(change.seed !== undefined ? { seed: change.seed } : {}),
      ...(change.readAt?.length ? { readAt: change.readAt } : {}),
    });
    if ("saved" in done) return { result: out.result, saved: done.saved };
    if ("already" in done) throw new LearningMerged(done.already);
    if ("refused" in done) throw new LearningRefused({ same: [], seed: done.refused.seed });
    if ("purged" in done) throw new LearningRefused({ same: [], purged: done.purged.readAt });
  }
  throw new LearningBusy();
}
