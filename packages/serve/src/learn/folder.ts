// The agent's learning folder through its Workspace: the one way serve reads and writes it. The folder is a git
// repository in the agent's own workspace (a local folder, or the owner's Archil disk), never touched with git here:
// - Every write to main is ONE exec of the checked-in script (learning.sh), one hold of the folder: a person's edit,
//   create, retire, approve or restore and a run's merge alike (commitChange; learn/commit.ts learningCommit is the
//   API callers use), and the folder's first commit
//   (learningInit). The script is written into the folder once per version, `.agentrun/learning-<sha8>.sh`, and run
//   there: an Archil exec takes one command line of bounded length, so its text never travels in argv.
// - This side computes everything it can: the tree's changes, the commit's message and time, the front matter, each
//   file's history and order, the log, and so the whole next snapshot (nextSnapshot), from the snapshot the write read
//   and the change. The script does the git plumbing, the file writes and the atomic swap: the commit by compare and
//   swap on main (a lost race exits 3 and writes nothing), the working tree brought in line, a merge's diff file, and
//   `.agentrun/snapshot.json` last, by a temporary name and a move.
// - Every read is `.agentrun/snapshot.json`, the working-tree bodies and `.agentrun/diffs/<run>.json` through the file
//   API: no git, no exec. A body is checked against the snapshot's oid (git's blob id of its bytes); a mismatch reads
//   the snapshot again and tries once more, and a second is FolderBusy (a write is in flight: try again).
// - A snapshot that is not main's (a write that stopped between its compare and swap and its snapshot, or a hand commit
//   in a local folder) is rebuilt from main whole (learningRepair: the script's read, then its snapshot op), the next
//   time a write finds main moved under it.
// The snapshot's shape is SNAPSHOT.md's, v1: what the learning routes and a run's seed read.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isWorkspaceError, type LearningPlace as OneLearningPlace, type LearningWorkspace as OneLearningWorkspace,
  learningWorkspace as oneLearningWorkspace, type Workspace, WorkspaceError,
} from "../workspace/index.js";
import { INDEX_FILE, type LearnedNote, NOTE_FILE, parseNoteFile } from "./notes.js";
import { learnedFront, learnedName, learnedPlace, learnedStatus, SKILLS_DIR, WORKFLOWS_DIR } from "./skills.js";

/** The host's folder inside the learning folder: the snapshot, the diffs and the script. Never a note's, never seeded. */
export const HOST_DIR = ".agentrun";
export const SNAPSHOT_FILE = `${HOST_DIR}/snapshot.json`;
export const DIFFS_DIR = `${HOST_DIR}/diffs`;
/** The most changes the snapshot's log keeps, newest first; `log_more` says older exist. */
export const LOG_KEEP = 200;
/** A file main holds over this is no note and no learned file: a note is at most 4 KB (check.ts CAPS.note). */
export const FILE_CAP = 1 << 20;
/** A diff's file whose patch is larger than this is withheld as too large (learning.sh PATCH_CAP). */
export const PATCH_CAP = 64 * 1024;
/** How long one script run may take: a hung git would hold the folder. Archil's own cap is 295 s. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** How many times a write is computed again on a main that moved under it, or a body that changed as it was read. */
const WRITE_TRIES = 3;
const IDENTITY = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The subject of the folder's first commit, the host's: neither a person's change nor a run's. */
const INIT_SUBJECT = "host: the agent's learning folder";
/** What stands for the new main in the snapshot the script writes: two U+0001, which JSON never writes raw. */
const PLACEHOLDER = "\u0001M\u0001";
const ESCAPED_PLACEHOLDER = JSON.stringify(PLACEHOLDER).slice(1, -1);
const PERSON_KINDS = ["approved", "edited", "created", "retired", "restored"] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// The snapshot (SNAPSHOT.md v1).

export type LastChange = { kind: "approved" | "edited" | "created" | "retired" | "restored" | "learned" | "superseded"; by: "person" | "run"; at: string };
export type SnapHistory = { at: string; last?: LastChange; retire?: LastChange; person?: LastChange };
export type SnapNote = {
  file: string; oid: string; bytes: number;
  name: string; description: string; type: string;
  status: "active" | "pending" | "superseded" | "retired";
  origin: "you" | "run";
  supersedes: string[];
  superseded_by: string | null;
  order: number;
  history: SnapHistory;
};
export type SnapFile = { path: string; oid: string; bytes: number };
export type SnapLearned = {
  name: string; file: string; description: string;
  status: "active" | "pending" | "retired";
  run: string | null;
  files: SnapFile[];
  oid: string; bytes: number;
  order: number;
  history: SnapHistory;
  /** Past SNAPSHOT.md v1, additive, present only when there are some: the paths of the tracked symbolic links (git mode
   *  120000) in the item's folder. A seed never lays such a skill (seed-check.ts readSeed's `refused`); `files` names
   *  regular files alone. */
  links?: string[];
};
export type SnapChange = { commit: string; at: string; by: { run: string } | { user: true; via?: string }; reason: string; files: string[] };
export type Snapshot = {
  v: 1; main: string; at: string;
  index: { oid: string; bytes: number };
  notes: SnapNote[]; skills: SnapLearned[]; workflows: SnapLearned[];
  log: SnapChange[]; log_more: boolean;
};
/** A run's merge as `.agentrun/diffs/<run>.json` keeps it: its commit, its parent, and each file's patch. */
export type RunDiff = {
  v: 1; run: string; merge: string; parent: string;
  files: ({ path: string; status: "added" | "modified" | "deleted"; patch: string } | { path: string; status: "added" | "modified" | "deleted"; withheld: "too_large" })[];
};

/** Git's blob id of `bytes`: the sha1 of "blob <length>\0" and the bytes. */
export const blobOid = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
};
const EMPTY_INDEX = { oid: blobOid(""), bytes: 0 };

/** A key file of a learned item: a skill's SKILL.md, a draft's README.md (which says whether it waits). The file the
 *  view names for it, which its `run` follows: a skill's SKILL.md, a draft's workflow.json. */
const keyFile = (kind: "skill" | "workflow", name: string) => (kind === "skill" ? `${SKILLS_DIR}/${name}/SKILL.md` : `${WORKFLOWS_DIR}/${name}/README.md`);
const viewFile = (kind: "skill" | "workflow", name: string) => (kind === "skill" ? `${SKILLS_DIR}/${name}/SKILL.md` : `${WORKFLOWS_DIR}/${name}/workflow.json`);
/** The learned folder a path is in, by kind and name: `skills/<name>/...` or `workflows/<name>/...`; else undefined. */
function folderOf(path: string): { kind: "skill" | "workflow"; name: string } | undefined {
  const [top, name, ...rest] = path.split("/");
  if (!name || !rest.length) return undefined;
  return top === SKILLS_DIR ? { kind: "skill", name } : top === WORKFLOWS_DIR ? { kind: "workflow", name } : undefined;
}
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A commit as the snapshot reads it: its time (git's %cI, as commitTime keeps it), subject, body and trailers. */
type CommitInfo = { at: string; subject: string; body: string; runId: string; changedBy: string; approvedVia: string };

/** What a commit's change was, as the view says it, or undefined for one that is neither: a person's names its kind in
 *  the fixed prefix of its subject, `learning: <kind> by a person: `; a run's merge carries its Run-Id trailer. */
function changeOf(commit: CommitInfo): LastChange | undefined {
  if (commit.runId.trim()) return { kind: "learned", by: "run", at: commit.at };
  for (const kind of PERSON_KINDS) if (commit.subject.startsWith(`learning: ${kind} by a person: `)) return { kind, by: "person", at: commit.at };
  return undefined;
}

/** `path`'s history once `commit` changed it, from what it was before (newest first walks give none, then fill in
 *  only what is missing: foldOlder). A person's action is the named file's alone; any other file their commit changed is
 *  a note it superseded. */
function changeFor(commit: CommitInfo, path: string): LastChange | undefined {
  const change = changeOf(commit);
  const named = change?.by === "person" ? commit.subject.slice(`learning: ${change.kind} by a person: `.length) : undefined;
  return named !== undefined && path !== named ? { kind: "superseded", by: "person", at: commit.at } : change;
}
function foldNewer(before: SnapHistory | undefined, commit: CommitInfo, path: string): SnapHistory {
  const change = changeFor(commit, path);
  const retire = change?.kind === "retired" ? change : before?.retire;
  const person = change?.by === "person" ? change : before?.person;
  return { at: commit.at, ...(change ? { last: change } : {}), ...(retire ? { retire } : {}), ...(person ? { person } : {}) };
}
function foldOlder(known: SnapHistory, commit: CommitInfo, path: string): void {
  const change = changeFor(commit, path);
  if (!known.retire && change?.kind === "retired") known.retire = change;
  if (!known.person && change?.by === "person") known.person = change;
}

/** A commit's entry in the log, or undefined when it is no change: a run's merge (Run-Id) or a person's (Changed-By:
 *  user), told by its trailers. A merge's reason is the grader's, the paragraphs before the trailers; a person's commit
 *  has none, so its subject says what it did. */
function changeEntry(commit: CommitInfo, sha: string, files: string[]): SnapChange | undefined {
  const runId = commit.runId.split(",")[0]!.trim();
  const via = commit.approvedVia.split(",")[0]!.trim();
  const by = runId ? { run: runId } : commit.changedBy.trim() === "user" ? { user: true as const, ...(via ? { via } : {}) } : undefined;
  if (!by || !sha || !Date.parse(commit.at)) return undefined;
  const paragraphs = commit.body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return { commit: sha, at: new Date(commit.at).toISOString(), by, reason: paragraphs.slice(0, -1).join(" ") || commit.subject.replace(/^learning: /, ""), files };
}
/** Whether a commit's message holds a line git's log of changes greps for: `Run-Id: ` or `Changed-By: user`. */
const isChange = (commit: CommitInfo) => `${commit.subject}\n${commit.body}`.split("\n").some((line) => line.startsWith("Run-Id: ") || line === "Changed-By: user");

/** The view's order of notes: active first, then by their newest change (the commit's place, 0 the newest), then by
 *  name. */
const noteOrder = (a: SnapNote, b: SnapNote) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || a.order - b.order || byBytes(a.file, b.file);
const byName = (a: SnapLearned, b: SnapLearned) => byBytes(a.name, b.name);

/** A note's entry, from its text, or undefined when it is no note (out of shape). */
function noteEntry(file: string, text: string, oid: string, bytes: number, order: number, history: SnapHistory): SnapNote | undefined {
  if (!NOTE_FILE.test(file) || bytes > FILE_CAP) return undefined;
  const note = parseNoteFile(file, text);
  if (Array.isArray(note)) return undefined;
  return { file, oid, bytes, name: note.name, description: note.description, type: note.type, status: note.status, origin: note.origin, supersedes: [...note.supersedes], superseded_by: note.superseded_by, order, history };
}

// ---------------------------------------------------------------------------------------------------------------------
// A snapshot from main whole (the script's `read`): a folder whose snapshot is not main's.

const utf8 = new TextDecoder("utf-8", { fatal: true });
const textOf = (bytes: Uint8Array | undefined): string | undefined => {
  if (!bytes) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** `git log -z --name-only`'s records, each its header (as the format wrote it) and the files it changed. */
const recordsOf = (out: string) => out.split("\x1e").slice(1).map((record) => {
  const end = record.indexOf("\0");
  return { head: record.slice(0, end < 0 ? undefined : end), files: end < 0 ? [] : record.slice(end + 1).split("\0").map((file) => file.replace(/^\n/, "")).filter(Boolean) };
});

type TreeEntry = { mode: string; type: string; oid: string; bytes: number; path: string };

/** What the script's `read` printed: main, its tree, its log and its blobs. Undefined main for a folder with none. */
/** A commit's time as git's %cI gives it (its own offset, "+00:00", "+02:00" or "Z", by git's version and the
 *  committer's zone), in the one form a snapshot keeps: UTC in whole seconds, ending "Z", as nextSnapshot writes it, so
 *  a snapshot rebuilt from git and one built incrementally agree. Text that is no time is kept as it is. */
export function commitTime(text: string): string {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseRead(out: Uint8Array): { main: string | undefined; tree: TreeEntry[]; records: { commit: CommitInfo; sha: string; files: string[] }[]; blobs: Map<string, Buffer> } {
  const buf = Buffer.from(out);
  const end = buf.indexOf(10);
  const head = /^agentrun-read 1 (none|[0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+) (\d+)$/.exec(buf.subarray(0, end < 0 ? 0 : end).toString("utf8"));
  if (!head) throw new Error("the learning script's read is not one this server reads");
  const [treeLen, logLen, blobLen] = [Number(head[2]), Number(head[3]), Number(head[4])];
  let at = end + 1;
  const part = (len: number) => {
    const slice = buf.subarray(at, at + len);
    if (slice.length !== len) throw new Error("the learning script's read is cut short");
    at += len;
    return slice;
  };
  const tree = part(treeLen).toString("utf8").split("\0").filter(Boolean).map((entry): TreeEntry => {
    const tab = entry.indexOf("\t");
    const [mode = "", type = "", oid = "", size = ""] = entry.slice(0, tab).split(/\s+/);
    return { mode, type, oid, bytes: Number(size) || 0, path: entry.slice(tab + 1) };
  });
  const records = recordsOf(part(logLen).toString("utf8")).map(({ head: line, files }) => {
    const [sha = "", cI = "", subject = "", body = "", runId = "", changedBy = "", approvedVia = ""] = line.split("\x1f");
    return { sha, files, commit: { at: commitTime(cI), subject, body, runId, changedBy, approvedVia } };
  });
  const blobs = new Map<string, Buffer>();
  const raw = part(blobLen);
  for (let i = 0; i < raw.length;) {
    const nl = raw.indexOf(10, i);
    if (nl < 0) break;
    const [oid = "", type = "", size = ""] = raw.subarray(i, nl).toString("utf8").split(" ");
    if (type === "missing") {
      i = nl + 1;
      continue;
    }
    const length = Number(size);
    blobs.set(oid, raw.subarray(nl + 1, nl + 1 + length));
    i = nl + 1 + length + 1;
  }
  return { main: head[1] === "none" ? undefined : head[1], tree, records, blobs };
}

/** The snapshot of main as the script's `read` shows it: every item from the tree and its blobs, each file's history
 *  and order from main's first-parent log, and the newest LOG_KEEP changes. */
export function snapshotOfRead(read: ReturnType<typeof parseRead>): Snapshot | undefined {
  const { main, tree, records, blobs } = read;
  if (!main || !records.length) return undefined;
  const order = new Map<string, number>();
  const history = new Map<string, SnapHistory>();
  const runs = new Map<string, string>();
  const log: SnapChange[] = [];
  let more = false;
  records.forEach(({ commit, sha, files }, i) => {
    const runId = commit.runId.split(",")[0]!.trim();
    for (const file of files) {
      if (!order.has(file)) order.set(file, i);
      const known = history.get(file);
      if (!known) history.set(file, foldNewer(undefined, commit, file));
      else foldOlder(known, commit, file);
      if (runId && !runs.has(file)) runs.set(file, runId);
    }
    if (!isChange(commit)) return;
    const entry = changeEntry(commit, sha, files);
    if (!entry) return;
    if (log.length < LOG_KEEP) log.push(entry);
    else more = true;
  });
  const at = records[0]!.commit.at;
  const regular = (entry: TreeEntry) => entry.type === "blob" && entry.mode === "100644";
  const orderOf = (path: string) => order.get(path) ?? Number.MAX_SAFE_INTEGER;
  const historyOf = (path: string) => history.get(path) ?? { at };
  const index = tree.find((entry) => entry.path === INDEX_FILE && regular(entry));
  const notes: SnapNote[] = [];
  const folders = new Map<string, { kind: "skill" | "workflow"; name: string; files: SnapFile[]; links: string[] }>();
  for (const entry of tree) {
    if (!entry.path.includes("/")) {
      const text = regular(entry) && entry.bytes <= FILE_CAP ? textOf(blobs.get(entry.oid)) : undefined;
      const note = text === undefined || entry.path === INDEX_FILE ? undefined : noteEntry(entry.path, text, entry.oid, entry.bytes, orderOf(entry.path), historyOf(entry.path));
      if (note) notes.push(note);
      continue;
    }
    const folder = folderOf(entry.path);
    if (!folder || entry.type !== "blob") continue;
    const key = `${folder.kind}/${folder.name}`;
    const known = folders.get(key) ?? folders.set(key, { ...folder, files: [], links: [] }).get(key)!;
    if (entry.mode === "120000") known.links.push(entry.path);
    else if (entry.mode === "100644" || entry.mode === "100755") known.files.push({ path: entry.path, oid: entry.oid, bytes: entry.bytes });
  }
  const skills: SnapLearned[] = [];
  const workflows: SnapLearned[] = [];
  for (const { kind, name, files, links } of folders.values()) {
    const item = learnedItem(kind, name, files, links, (path) => {
      const entry = tree.find((one) => one.path === path);
      return entry && regular(entry) && entry.bytes <= FILE_CAP ? textOf(blobs.get(entry.oid)) : undefined;
    }, {
      order: Math.min(...files.map(({ path }) => orderOf(path))),
      history: historyOf(keyFile(kind, name)),
      run: runs.get(viewFile(kind, name)) ?? null,
    });
    if (item) (kind === "skill" ? skills : workflows).push(item);
  }
  return { v: 1, main, at, index: index ? { oid: index.oid, bytes: index.bytes } : EMPTY_INDEX, notes: notes.sort(noteOrder), skills: skills.sort(byName), workflows: workflows.sort(byName), log, log_more: more };
}

/** A learned item from its folder's files: listed when its folder is well named, its key file (SKILL.md, a draft's
 *  README.md) is there and reads, and a draft has its workflow.json too, each of those a regular file under FILE_CAP
 *  (only those are given their texts by `text`). */
function learnedItem(kind: "skill" | "workflow", name: string, files: SnapFile[], links: readonly string[], text: (path: string) => string | undefined, at: { order: number; history: SnapHistory; run: string | null }, said?: { description: string; status: SnapLearned["status"] }): SnapLearned | undefined {
  if (!learnedName(kind, name)) return undefined;
  const key = files.find(({ path }) => path === keyFile(kind, name));
  const shown = files.find(({ path }) => path === viewFile(kind, name));
  if (!key || !shown || key.bytes > FILE_CAP || shown.bytes > FILE_CAP) return undefined;
  let fields = said;
  if (!fields) {
    const body = text(key.path);
    if (body === undefined) return undefined;
    fields = { description: learnedFront(body)?.description ?? "", status: learnedStatus(body) };
  }
  return { name, file: key.path, description: fields.description, status: fields.status, run: at.run, files: [...files].sort((a, b) => byBytes(a.path, b.path)), oid: key.oid, bytes: key.bytes, order: at.order, history: at.history, ...(links.length ? { links: [...links].sort(byBytes) } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The next snapshot, from the one a write read and its change: what the script writes once the commit lands.

/** A change to the folder's main: what a person or a run's merge writes. Each path is the folder's, relative, never
 *  under `.agentrun/`. `absent`: paths that must not be on main, as git holds it (any file, any mode); `same`: paths
 *  that must be on main as they are on another commit (a run's seed). The script checks both on main as it commits. */
export type FolderChange = {
  by: { person: PersonKind; file: string; approved?: boolean } | { run: string; reason: string };
  writes: readonly { path: string; text: string }[];
  deletes?: readonly string[];
  absent?: readonly string[];
  same?: readonly { commit: string; path: string }[];
};

/** A commit's message and trailers, as git keeps them: a person's names their action and the file, with Changed-By (and
 *  Approved-Via on an approval); a run's merge names the run, then the grader's reason, then its Run-Id. */
function messageOf(by: FolderChange["by"] | undefined): { message: string; subject: string; body: string; runId: string; changedBy: string; approvedVia: string } {
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  const paragraphs = (parts: string[]) => parts.map((part) => (part.endsWith("\n") ? part : `${part}\n`)).join("\n");
  if (!by) return { message: `${INIT_SUBJECT}\n`, subject: INIT_SUBJECT, body: "", runId: "", changedBy: "", approvedVia: "" };
  if ("run" in by) {
    const subject = `learning: ${by.run}: merged`;
    const reason = clean(by.reason).trim() || "merged";
    const body = paragraphs([reason, `Run-Id: ${by.run}`]);
    return { message: `${subject}\n\n${body}`, subject, body, runId: by.run, changedBy: "", approvedVia: "" };
  }
  const subject = `learning: ${by.person} by a person: ${by.file}`;
  const body = paragraphs([by.approved ? "Changed-By: user\nApproved-Via: console" : "Changed-By: user"]);
  return { message: `${subject}\n\n${body}`, subject, body, runId: "", changedBy: "user", approvedVia: by.approved ? "console" : "" };
}

/** A time in whole seconds as every snapshot says a commit's time: UTC, ending "Z" (commitTime's form). */
const isoSeconds = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Every path `snapshot` names a blob for: the index, each note, each learned folder's files. */
function oidsOf(snapshot: Snapshot | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!snapshot) return out;
  out.set(INDEX_FILE, snapshot.index.oid);
  for (const note of snapshot.notes) out.set(note.file, note.oid);
  for (const item of [...snapshot.skills, ...snapshot.workflows]) for (const file of item.files) out.set(file.path, file.oid);
  return out;
}

/** The snapshot once `change` is committed on `before` (none: the folder's first commit) at `seconds`, its main and its
 *  log entry's commit the placeholder the script puts the new main in. Also which paths changed, as git's diff of the
 *  commit lists them. */
export function nextSnapshot(before: Snapshot | undefined, change: Omit<FolderChange, "absent" | "same"> | undefined, seconds: number): { snapshot: Snapshot; changed: string[] } {
  const message = messageOf(change?.by);
  const commit: CommitInfo = { at: isoSeconds(seconds), ...message };
  const known = oidsOf(before);
  const writes = new Map((change?.writes ?? (change ? [] : [{ path: INDEX_FILE, text: "" }])).map(({ path, text }) => [path, { text, oid: blobOid(text), bytes: Buffer.byteLength(text, "utf8") }]));
  const deletes = new Set(change?.deletes ?? []);
  const changed = [...new Set([...[...writes].filter(([path, { oid }]) => known.get(path) !== oid).map(([path]) => path), ...[...deletes].filter((path) => !writes.has(path))])].sort(byBytes);
  const touched = new Set(changed);
  const runId = commit.runId;

  const notes: SnapNote[] = (before?.notes ?? []).filter((note) => !touched.has(note.file)).map((note) => ({ ...note, order: note.order + 1 }));
  for (const path of changed) {
    const written = writes.get(path);
    if (!written || path.includes("/") || path === INDEX_FILE) continue;
    const old = before?.notes.find((note) => note.file === path);
    const note = noteEntry(path, written.text, written.oid, written.bytes, 0, foldNewer(old?.history, commit, path));
    if (note) notes.push(note);
  }
  const index = writes.has(INDEX_FILE) ? { oid: writes.get(INDEX_FILE)!.oid, bytes: writes.get(INDEX_FILE)!.bytes } : (before?.index ?? EMPTY_INDEX);

  const learned = (kind: "skill" | "workflow", list: readonly SnapLearned[]): SnapLearned[] => {
    const hit = new Set(changed.map(folderOf).filter((folder) => folder?.kind === kind).map((folder) => folder!.name));
    const out = list.filter((item) => !hit.has(item.name)).map((item) => ({ ...item, order: item.order + 1 }));
    for (const name of hit) {
      const old = list.find((item) => item.name === name);
      const prefix = `${kind === "skill" ? SKILLS_DIR : WORKFLOWS_DIR}/${name}/`;
      const files = new Map((old?.files ?? []).map((file) => [file.path, file]));
      for (const path of changed.filter((one) => one.startsWith(prefix))) {
        const written = writes.get(path);
        if (written) files.set(path, { path, oid: written.oid, bytes: written.bytes });
        else files.delete(path);
      }
      const key = keyFile(kind, name);
      const keyText = writes.get(key)?.text;
      // A link the change writes a file over, or deletes, is a link no more.
      const links = (old?.links ?? []).filter((path) => !writes.has(path) && !deletes.has(path));
      const item = learnedItem(kind, name, [...files.values()], links, (path) => writes.get(path)?.text, {
        order: 0,
        history: touched.has(key) ? foldNewer(old?.history, commit, key) : (old?.history ?? { at: commit.at }),
        run: runId && touched.has(viewFile(kind, name)) ? runId : (old?.run ?? null),
      }, keyText === undefined && old ? { description: old.description, status: old.status } : undefined);
      if (item) out.push(item);
    }
    return out.sort(byName);
  };

  const entry = change && isChange(commit) ? changeEntry(commit, PLACEHOLDER, changed) : undefined;
  const log = [...(entry ? [entry] : []), ...(before?.log ?? [])];
  const snapshot: Snapshot = {
    v: 1, main: PLACEHOLDER, at: commit.at, index,
    notes: notes.sort(noteOrder), skills: learned("skill", before?.skills ?? []), workflows: learned("workflow", before?.workflows ?? []),
    log: log.slice(0, LOG_KEEP), log_more: Boolean(before?.log_more) || log.length > LOG_KEEP,
  };
  return { snapshot, changed };
}

/** The snapshot with its placeholder put for `main`: what the script wrote, for a caller that keeps going. */
const withMain = (snapshot: Snapshot, main: string): Snapshot => JSON.parse(JSON.stringify(snapshot).replaceAll(ESCAPED_PLACEHOLDER, main)) as Snapshot;

// ---------------------------------------------------------------------------------------------------------------------
// The folder's Workspace is the one learningWorkspace (workspace/learning-workspace.ts): the local folder under the
// data directory, made by the first write (a read makes nothing: a folder not made reads as no main yet, NOT_FOUND),
// each level on the way checked, a link there refused as ESCAPE naming it (folderFailure reads it as a link); or the
// claim's Archil disk at learningKey, whose end() sweeps the exec spill. folderTestHooks.workspace stands in for it in
// tests.

/** Where an agent's learning folder is: the local folder under the data directory, or the claim's Archil disk. */
export type LearningPlace = OneLearningPlace;
/** The folder's Workspace, and its end: called in a finally after every use (on Archil it sweeps the exec spill). */
export type LearningFolder = OneLearningWorkspace;

/** Agent `place.agentId`'s learning folder as a Workspace: the one learningWorkspace, or the test's stand-in. */
export function learningWorkspace(place: LearningPlace): LearningFolder {
  if (folderTestHooks.workspace) return folderTestHooks.workspace(place);
  return oneLearningWorkspace(place);
}

/** A learning folder this server cannot read or write: a link in it (`link`, its words naming it), or a backend that
 *  cannot answer. Fails closed: nothing learned is read, nothing is written. */
export class FolderUnreadable extends Error {
  readonly link: boolean;
  constructor(link: boolean, message: string) {
    super(message);
    this.name = "FolderUnreadable";
    this.link = link;
  }
}

/** A workspace failure as the folder's: ESCAPE (a link below the root, Local) or a read of a link (Archil's file API:
 *  UNAVAILABLE naming a symbolic link) in words that name the link; any other UNAVAILABLE as the folder unreadable. */
export function folderFailure(error: unknown): unknown {
  if (error instanceof FolderUnreadable) return error;
  if (isWorkspaceError(error, "ESCAPE") || (isWorkspaceError(error, "UNAVAILABLE") && /symbolic link/.test(error.message))) {
    return new FolderUnreadable(true, `a link in the learning folder at ${(error as WorkspaceError).path || "its root"} can't be followed, so nothing learned is read or written; remove the link`);
  }
  if (isWorkspaceError(error, "UNAVAILABLE")) return new FolderUnreadable(false, `the agent's learning folder can't be read right now: ${(error as WorkspaceError).message}`);
  return error;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading: the snapshot and the bodies it names, through the file API alone.

/** A body that was not the snapshot's blob as it was read twice: a write is in flight. Routes answer 503. */
export class FolderBusy extends Error {
  constructor() {
    super("the agent's learning folder is being written: try again");
    this.name = "FolderBusy";
  }
}
/** A body that is not the snapshot's blob: the snapshot is read again once. */
class Mismatch extends Error {}
/** Whether `error` is a body that was not the snapshot's blob (a reader holding an older snapshot meets it). */
export const isBodyMismatch = (error: unknown): boolean => error instanceof Mismatch;

const isOidField = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
/** The folder's snapshot, or undefined when there is none (no main yet: the agent never learned). One that does not
 *  read as v1 throws. */
export async function readSnapshot(ws: Workspace): Promise<Snapshot | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await ws.read(SNAPSHOT_FILE);
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) return undefined;
    throw folderFailure(error);
  }
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Snapshot;
  if (value?.v !== 1 || !isOidField(value.main) || !Array.isArray(value.notes) || !Array.isArray(value.skills) || !Array.isArray(value.workflows) || !Array.isArray(value.log) || !isOidField(value.index?.oid)) throw new Error("the learning folder's snapshot is not one this server reads (v1)");
  return value;
}

/** Bodies already checked, by blob id: an oid names its bytes, so one read is good for every snapshot naming it. */
const bodies = new Map<string, string>();
let bodyBytes = 0;
const BODY_CACHE = 16 << 20;
function keep(oid: string, text: string): void {
  if (text.length > FILE_CAP) return;
  bodies.set(oid, text);
  bodyBytes += text.length;
  for (const [old, held] of bodies) {
    if (bodyBytes <= BODY_CACHE) break;
    bodies.delete(old);
    bodyBytes -= held.length;
  }
}

/** Tests only: the bodies already checked, forgotten, so the next read of each goes to the folder. */
export function forgetBodies(): void {
  bodies.clear();
  bodyBytes = 0;
}

/** File `path`'s bytes, which must be blob `oid` (else Mismatch): through the file API, never git. */
async function bytesOf(ws: Workspace, path: string, oid: string): Promise<Buffer> {
  let bytes: Uint8Array;
  try {
    bytes = await ws.read(path);
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) throw new Mismatch();
    throw folderFailure(error);
  }
  if (blobOid(bytes) !== oid) throw new Mismatch();
  return Buffer.from(bytes);
}

/** File `path`'s text, which must be blob `oid` in UTF-8 (else Mismatch): through the file API, never git. */
async function bodyOf(ws: Workspace, path: string, oid: string): Promise<string> {
  const known = bodies.get(oid);
  if (known !== undefined) return known;
  const text = textOf(await bytesOf(ws, path, oid));
  if (text === undefined) throw new Mismatch();
  keep(oid, text);
  return text;
}

/** What a reader is given: the snapshot (undefined: no main yet) and the bodies it names, each checked against it, as
 *  text (`body`) or bytes (`bytes`). */
export type FolderRead = { snapshot: Snapshot | undefined; body: (path: string, oid: string) => Promise<string>; bytes: (path: string, oid: string) => Promise<Buffer> };
const folderRead = (ws: Workspace, snapshot: Snapshot | undefined): FolderRead => ({ snapshot, body: (path, oid) => bodyOf(ws, path, oid), bytes: (path, oid) => bytesOf(ws, path, oid) });

/** `read` over the folder's snapshot and its bodies: once, and on a body that is not the snapshot's, once more on the
 *  snapshot read again; a second mismatch is FolderBusy. No git and no exec: the file API alone. */
export async function readLearning<T>(ws: Workspace, read: (folder: FolderRead) => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    const snapshot = await readSnapshot(ws);
    try {
      return await read(folderRead(ws, snapshot));
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error;
      if (tries > 0) throw new FolderBusy();
    }
  }
}

/** Run `run`'s merge as its diff file keeps it, or undefined when the folder has none (it never merged here). */
export async function readRunDiff(ws: Workspace, run: string): Promise<RunDiff | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await ws.read(`${DIFFS_DIR}/${run}.json`);
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) return undefined;
    throw folderFailure(error);
  }
  const diff = JSON.parse(Buffer.from(bytes).toString("utf8")) as RunDiff;
  if (diff?.v !== 1 || diff.run !== run || !isOidField(diff.merge) || !isOidField(diff.parent) || !Array.isArray(diff.files)) throw new Error(`the learning folder's diff of ${run} is not one this server reads (v1)`);
  return diff;
}

/** The notes of a snapshot as the learning modules take them (buildIndex, mergeProblems): their front matter, no body. */
export const snapshotNotes = (snapshot: Snapshot | undefined): LearnedNote[] => (snapshot?.notes ?? []).map((note) => ({ file: note.file, name: note.name, description: note.description, type: note.type as LearnedNote["type"], status: note.status, origin: note.origin, superseded_by: note.superseded_by, supersedes: [...note.supersedes], keys: [], body: "" }));
/** Every name at main's top a snapshot knows: the index, the notes, and the learned folders' tops. */
export const topOf = (snapshot: Snapshot | undefined): string[] => (snapshot ? [INDEX_FILE, ...snapshot.notes.map((note) => note.file), ...(snapshot.skills.length ? [SKILLS_DIR] : []), ...(snapshot.workflows.length ? [WORKFLOWS_DIR] : [])] : []);

// ---------------------------------------------------------------------------------------------------------------------
// Writing: the script, one exec a write.

/** The script, as checked in (learning.sh beside this file), and the name it is written under in the folder. */
export const LEARNING_SH = readFileSync(new URL("./learning.sh", import.meta.url), "utf8");
export const SCRIPT_FILE = `${HOST_DIR}/learning-${createHash("sha256").update(LEARNING_SH).digest("hex").slice(0, 8)}.sh`;

/** Test seams, tests only: variables added to the script's environment (AGENTRUN_LEARNING_FAIL), each exec's argv, and
 *  the folder's Workspace in place of learningWorkspace's (a spy, or another backend). */
export const folderTestHooks: { env?: Record<string, string>; exec?: (argv: readonly string[]) => void; workspace?: (place: LearningPlace) => LearningFolder } = {};

/** The script's environment, whole: exec inherits nothing. */
const scriptEnv = (): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  ...folderTestHooks.env,
});

/** The script in the folder, written when this version of it is not there yet. */
async function ensureScript(ws: Workspace): Promise<void> {
  const there = await ws.read(SCRIPT_FILE).then((bytes) => Buffer.from(bytes).toString("utf8"), (error: unknown) => {
    if (isWorkspaceError(error, "NOT_FOUND")) return undefined;
    throw folderFailure(error);
  });
  if (there !== LEARNING_SH) await ws.write(SCRIPT_FILE, LEARNING_SH).catch((error: unknown) => { throw folderFailure(error); });
}

/** One run of the script: `op` and its arguments, `stdin`. Its exit code and output; a run that could not finish (its
 *  deadline, a signal) throws. */
async function runScript(ws: Workspace, args: readonly string[], stdin?: Uint8Array): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  await ensureScript(ws);
  const argv = ["sh", SCRIPT_FILE, ...args];
  folderTestHooks.exec?.(argv);
  const raw = await ws.exec(argv, { env: scriptEnv(), timeoutMs: SCRIPT_TIMEOUT_MS, ...(stdin ? { stdin } : {}) }).catch((error: unknown) => { throw folderFailure(error); });
  // The port's ExecResult, in one line (code is renamed exitCode).
  const result = { code: raw.code, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.timedOut, truncated: raw.truncated };
  if (result.timedOut || result.code === null) throw new Error(`the learning script's ${args[0]} did not finish${result.timedOut ? ` in ${SCRIPT_TIMEOUT_MS / 1000} s` : ""}: ${result.stderr.trim().slice(0, 500)}`);
  // A cut stdout is never parsed: the folder is unavailable for this call.
  if (result.truncated) throw new FolderUnreadable(false, `the learning script's ${args[0]} said more than this server reads`);
  return { code: result.code, stdout: Buffer.from(result.stdout), stderr: result.stderr };
}
const failed = (op: string, run: { code: number; stderr: string }) => new Error(`the learning script's ${op} failed (exit ${run.code}): ${run.stderr.trim().slice(0, 500)}`);

/** A path a change may name: the folder's, plain (letters, digits, ".", "_", "-" and "/"), never `.git` or `.agentrun`. */
function checkPath(path: string): string {
  const parts = path.split("/");
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || parts.some((part) => part === "" || part === "." || part === "..") || parts[0] === HOST_DIR || parts[0] === ".git") throw new Error(`${JSON.stringify(path)} is not a path a learning write names`);
  return path;
}

/** The fast-import stream of `change` on `parent` (none: the first commit), committed on `ref` at `seconds`. */
function importStream(ref: string, parent: string | undefined, writes: readonly { path: string; text: string }[], deletes: readonly string[], message: string, seconds: number): Buffer {
  const parts: Buffer[] = [];
  const add = (text: string) => parts.push(Buffer.from(text, "utf8"));
  writes.forEach(({ text }, i) => {
    const data = Buffer.from(text, "utf8");
    add(`blob\nmark :${i + 1}\ndata ${data.length}\n`);
    parts.push(data);
    add("\n");
  });
  const who = `${IDENTITY.name} <${IDENTITY.email}> ${seconds} +0000`;
  const body = Buffer.from(message, "utf8");
  add(`commit ${ref}\nauthor ${who}\ncommitter ${who}\ndata ${body.length}\n`);
  parts.push(body);
  add(`\n${parent ? `from ${parent}\n` : ""}`);
  for (const path of deletes) add(`D ${path}\n`);
  writes.forEach(({ path }, i) => add(`M 100644 :${i + 1} ${path}\n`));
  add("\ndone\n");
  return Buffer.concat(parts);
}

/** The script's stdin: its header lines, a blank line, then what follows. */
function stdinOf(header: readonly string[], rest: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from(`${header.join("\n")}\n\n`, "utf8"), rest]);
}

/** `snapshot` as one line of JSON for the script, its placeholder as the raw U+0001 pair the script replaces. */
function snapshotLine(snapshot: Snapshot, placeholders: number): string {
  const json = JSON.stringify(snapshot);
  if (json.split("\\u0001").length - 1 !== placeholders * 2) throw new Error("a learning text holds U+0001, which the folder's snapshot never keeps");
  return json.replaceAll(ESCAPED_PLACEHOLDER, PLACEHOLDER);
}

/** The most stdin one exec of the script is given: what both backends are verified to carry byte for byte. */
export const STDIN_MAX = 2 * 1024 * 1024;
/** A write whose exec would carry more than STDIN_MAX: refused whole, nothing run. */
export class FolderTooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`the write would hand the learning script ${bytes} bytes; one exec takes at most ${STDIN_MAX}`);
    this.name = "FolderTooLarge";
    this.bytes = bytes;
  }
}

/** What one commit did: landed (its main and the snapshot written), stale (main is `main`, not the one it read:
 *  nothing was written), refused (a precondition failed on main: nothing was written), or landed without its files
 *  brought in line (main moved, no snapshot written). */
export type Committed =
  | { landed: true; main: string; snapshot: Snapshot }
  | { stale: true; main: string | undefined }
  | { refused: { absent: string[]; same: string[] } }
  | { unaligned: true; main: string };

/**
 * One write to main, one exec of the script: `change` on the snapshot it was computed from (`base`: none for the
 * folder's first commit, `op` "init"). The commit moves main only from `base.main` (compare and swap); then the
 * working tree, a merge's diff file, and the next snapshot (nextSnapshot), last. Nothing is retried here: writeLearning
 * computes again on a main that moved.
 */
export async function commitChange(ws: Workspace, base: Snapshot | undefined, change: FolderChange | undefined): Promise<Committed> {
  const seconds = Math.floor(Date.now() / 1000);
  const { snapshot, changed } = nextSnapshot(base, change, seconds);
  // A change that changes nothing on main is no commit: main stays, and nothing is run.
  if (base && change && !changed.length) return { landed: true, main: base.main, snapshot: base };
  const writes = change?.writes ?? [{ path: INDEX_FILE, text: "" }];
  for (const { path } of writes) checkPath(path);
  for (const path of [...(change?.deletes ?? []), ...(change?.absent ?? []), ...(change?.same ?? []).map(({ path }) => path)]) checkPath(path);
  for (const { commit } of change?.same ?? []) if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  const ref = `refs/agentrun/import-${randomBytes(8).toString("hex")}`;
  const run = change && "run" in change.by ? change.by.run : undefined;
  const header = [
    `ref ${ref}`,
    `snapshot ${snapshotLine(snapshot, snapshot.log[0]?.commit === PLACEHOLDER ? 2 : 1)}`,
    ...(run ? changed.map((path) => `path ${path}`) : []),
    ...(change?.absent ?? []).map((path) => `absent ${path}`),
    ...(change?.same ?? []).map(({ commit, path }) => `same ${commit} ${path}`),
  ];
  const stream = importStream(ref, base?.main, writes, change?.deletes ?? [], messageOf(change?.by).message, seconds);
  const args = base ? ["commit", base.main, ...(run ? [run] : [])] : ["init"];
  const stdin = stdinOf(header, stream);
  if (stdin.length > STDIN_MAX) throw new FolderTooLarge(stdin.length);
  const result = await runScript(ws, args, stdin);
  const said = result.stdout.toString("utf8").trim();
  if (result.code === 0 && /^[0-9a-f]{40,64}$/.test(said)) return { landed: true, main: said, snapshot: withMain(snapshot, said) };
  if (result.code === 3) return { stale: true, main: said || undefined };
  if (result.code === 4) {
    const lines = said.split("\n");
    return { refused: { absent: lines.filter((line) => line.startsWith("absent ")).map((line) => line.slice(7)), same: lines.filter((line) => line.startsWith("same ")).map((line) => line.slice(5)) } };
  }
  if (result.code === 5 && /^[0-9a-f]{40,64}$/.test(said)) return { unaligned: true, main: said };
  throw failed(args[0]!, result);
}

/** The snapshot rebuilt from main whole, and the working tree brought in line: the script's `read`, then its `snapshot`
 *  op at the main it read. For a folder whose snapshot is not main's. Undefined for a folder with no main. */
/** The snapshot of `commit` as main would have it (the script's read at that commit), or undefined when the folder has
 *  no such commit. One exec, read-only: for a run's seed that is no longer main. */
export async function snapshotAt(ws: Workspace, commit: string): Promise<Snapshot | undefined> {
  return (await folderAt(ws, commit))?.snapshot;
}

/** `commit` as main would have it (snapshotAt) with the blobs its tree holds, by oid, as git gave them: one read-only
 *  exec. Undefined when the folder has no such commit. */
export async function folderAt(ws: Workspace, commit: string): Promise<{ snapshot: Snapshot; blobs: ReadonlyMap<string, Buffer> } | undefined> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  const read = await runScript(ws, ["read", commit]);
  if (read.code === 1) return undefined;
  if (read.code !== 0) throw failed("read", read);
  const parsed = parseRead(read.stdout);
  const snapshot = snapshotOfRead(parsed);
  return snapshot ? { snapshot, blobs: parsed.blobs } : undefined;
}

export async function learningRepair(ws: Workspace): Promise<Snapshot | undefined> {
  for (let tries = 0; tries < WRITE_TRIES; tries++) {
    const read = await runScript(ws, ["read"]);
    if (read.code !== 0) throw failed("read", read);
    const snapshot = snapshotOfRead(parseRead(read.stdout));
    if (!snapshot) return undefined;
    const written = await runScript(ws, ["snapshot", snapshot.main], stdinOf([`snapshot ${snapshotLine(snapshot, 0)}`]));
    if (written.code === 0) return snapshot;
    if (written.code !== 3) throw failed("snapshot", written);
  }
  throw new Error("the learning folder's main kept moving while its snapshot was rebuilt");
}

/** Main's text of `path` just before the newest person's retire of it on `main`'s line, or undefined (never retired by
 *  a person). A read through the script: git's history is not in the snapshot. */
export async function beforeRetire(ws: Workspace, main: string, path: string): Promise<string | undefined> {
  const result = await runScript(ws, ["before-retire", main, checkPath(path)]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw failed("before-retire", result);
  return textOf(result.stdout);
}

/** Whether `main` holds anything at `path`, as git stores it (any mode, any type): what the snapshot leaves out (a file
 *  that is no note) included. A read through the script. */
export async function heldOnMain(ws: Workspace, main: string, path: string): Promise<boolean> {
  const result = await runScript(ws, ["has", main, checkPath(path)]);
  if (result.code !== 0 && result.code !== 1) throw failed("has", result);
  return result.code === 0;
}

/** The folder's first commit when it has no main yet (an empty MEMORY.md, the host's), and main's commit: through the
 *  script's init, which makes the repository where there is none. A main with no snapshot (an init that stopped
 *  before it) is repaired. */
export async function learningInit(ws: Workspace): Promise<string> {
  const known = await readSnapshot(ws);
  if (known) return known.main;
  const result = await commitChange(ws, undefined, undefined);
  if ("landed" in result) return result.main;
  if ("stale" in result && result.main) {
    const repaired = await learningRepair(ws);
    if (repaired) return repaired.main;
  }
  if ("unaligned" in result) {
    const repaired = await learningRepair(ws);
    if (repaired) return repaired.main;
  }
  throw new Error("the learning folder could not be made");
}

/** A write's preconditions that failed on main as the script found it: nothing was written. */
export class FolderRefused extends Error {
  readonly absent: string[];
  readonly same: string[];
  constructor(refused: { absent: string[]; same: string[] }) {
    super(`the learning folder's main refused the write: ${[...refused.absent.map((path) => `${path} is there`), ...refused.same.map((path) => `${path} changed`)].join(", ")}`);
    this.name = "FolderRefused";
    this.absent = refused.absent;
    this.same = refused.same;
  }
}

/**
 * A write to the folder's main: `compute` reads the snapshot and the bodies it needs (as readLearning gives them) and
 * says what to write, or nothing (its result stands alone). Committed by commitChange; a main that moved under it, or
 * a body that changed as it was read, computes it again on the folder as it is then (WRITE_TRIES in all). A folder with
 * no main yet is made first (learningInit). A snapshot that is not main's is rebuilt (learningRepair). Throws
 * FolderRefused when a precondition fails on main.
 */
export async function writeLearning<T>(ws: Workspace, compute: (folder: FolderRead) => Promise<{ result: T; change?: FolderChange }>, maxTries = WRITE_TRIES): Promise<{ result: T; main?: string; snapshot?: Snapshot }> {
  for (let tries = 0; ; tries++) {
    // A folder that kept moving, or whose bodies kept changing as they were read: a write in flight elsewhere.
    if (tries >= maxTries) throw new FolderBusy();
    let snapshot = await readSnapshot(ws);
    let out: { result: T; change?: FolderChange };
    try {
      out = await compute(folderRead(ws, snapshot));
    } catch (error) {
      if (error instanceof Mismatch) continue;
      throw error;
    }
    if (!out.change) return { result: out.result };
    if (!snapshot) {
      await learningInit(ws);
      snapshot = await readSnapshot(ws);
      // Computed again on the folder just made.
      continue;
    }
    const done = await commitChange(ws, snapshot, out.change);
    if ("landed" in done) return { result: out.result, main: done.main, snapshot: done.snapshot };
    if ("refused" in done) throw new FolderRefused(done.refused);
    if ("unaligned" in done) {
      const repaired = await learningRepair(ws);
      return { result: out.result, main: done.main, ...(repaired ? { snapshot: repaired } : {}) };
    }
    // Stale: a write landed since the snapshot was read. A snapshot that names another main than the one that won is
    // not main's: rebuilt from main before the write is computed again.
    const now = await readSnapshot(ws);
    if (done.main && now?.main !== done.main) await learningRepair(ws);
  }
}
