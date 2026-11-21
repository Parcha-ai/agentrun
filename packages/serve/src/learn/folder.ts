// The agent's learning folder through its Workspace: the one way serve reads and writes it. The folder is a git
// repository in the server's data directory (workspace/learning-workspace.ts, in either mode: never on an Archil disk),
// never touched with git here:
// - Every write to main is ONE exec of the checked-in script (learning.sh), one hold of the folder: a person's edit,
//   create, retire, approve or restore and a run's merge alike (commitChange; learn/commit.ts learningCommit is the
//   API callers use), and the folder's first commit
//   (learningInit). The script is written into the folder once per version, `.agentrun/learning-<sha8>.sh`, and run
//   there. The server and each runner beside it on the same data directory write the one folder: the script's compare
//   and swap on main, and its lock on the first commit, keep two writers from losing or breaking either's work.
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
// The snapshot's shape is v1: what the learning routes and a run's seed read. The folder holds the owner's
// corrections (corrections.md, served whole), the compiled workflows (workflows/<name>/) and the host's audit ledger
// (audits.jsonl, never served to a run), nothing else.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isWorkspaceError, type LearningPlace as OneLearningPlace, type LearningWorkspace as OneLearningWorkspace,
  learningWorkspace as oneLearningWorkspace, type Workspace, WorkspaceError,
} from "../workspace/index.js";
import { CORRECTIONS_FILE } from "./corrections.js";
import { learnedFront, learnedStatus, retiredFrom, WORKFLOW_NAME, WORKFLOWS_DIR } from "./workflow-draft.js";
import { held, heldLearningFolder } from "../runner/held.js";

/** The host's folder inside the learning folder: the snapshot, the diffs and the script. Never learned, never seeded. */
export const HOST_DIR = ".agentrun";
export const SNAPSHOT_FILE = `${HOST_DIR}/snapshot.json`;
export const DIFFS_DIR = `${HOST_DIR}/diffs`;
/** The audit ledger at the folder's top (learn/audit.ts): one JSON row per line. */
export const AUDITS_FILE = "audits.jsonl";
/** The most changes the snapshot's log keeps, newest first; `log_more` says older exist. */
export const LOG_KEEP = 200;
/** A file main holds over this is no learned file: a workflow's file is at most 16 KB (check.ts CAPS.file). */
export const FILE_CAP = 1 << 20;
/** A diff's file whose patch is larger than this is withheld as too large (learning.sh PATCH_CAP). */
export const PATCH_CAP = 64 * 1024;
/** How long one script run may take: a hung git would hold the folder. */
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
// The snapshot (v1).

export type LastChange = { kind: "approved" | "edited" | "created" | "retired" | "restored" | "learned"; by: "person" | "run"; at: string };
export type SnapHistory = { at: string; last?: LastChange; retire?: LastChange; person?: LastChange };
export type SnapFile = { path: string; oid: string; bytes: number };
export type SnapLearned = {
  name: string; file: string; description: string;
  status: "active" | "pending" | "retired";
  /** On a retired draft alone: the status its restore gives back (workflow-draft.ts retiredFrom). */
  retired_from?: "active" | "pending";
  run: string | null;
  files: SnapFile[];
  oid: string; bytes: number;
  order: number;
  history: SnapHistory;
  /** Present only when there are some: the paths of the tracked symbolic links (git mode 120000) in the item's folder;
   *  `files` names regular files alone. */
  links?: string[];
};
export type SnapChange = { commit: string; at: string; by: { run: string } | { user: true; via?: string }; reason: string; files: string[] };
export type Snapshot = {
  v: 1; main: string; at: string;
  /** corrections.md's blob, present only when main holds it. */
  corrections?: SnapFile;
  /** The audit ledger (learn/audit.ts AUDITS_FILE), once a row was written: the host's, never laid into a run. */
  audits?: { oid: string; bytes: number };
  workflows: SnapLearned[];
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
/** A draft's key file, its README.md (which says whether it waits), and the file the view names for it, which its `run`
 *  follows: its workflow.json. */
const keyFile = (name: string) => `${WORKFLOWS_DIR}/${name}/README.md`;
const viewFile = (name: string) => `${WORKFLOWS_DIR}/${name}/workflow.json`;
/** The draft a path is in, by name: `workflows/<name>/...`; else undefined. */
function folderOf(path: string): string | undefined {
  const [top, name, ...rest] = path.split("/");
  return top === WORKFLOWS_DIR && name && rest.length ? name : undefined;
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

/** A file's history once `commit` changed it, from what it was before (newest first walks give none, then fill in
 *  only what is missing: foldOlder). */
function foldNewer(before: SnapHistory | undefined, commit: CommitInfo): SnapHistory {
  const change = changeOf(commit);
  const retire = change?.kind === "retired" ? change : before?.retire;
  const person = change?.by === "person" ? change : before?.person;
  return { at: commit.at, ...(change ? { last: change } : {}), ...(retire ? { retire } : {}), ...(person ? { person } : {}) };
}
function foldOlder(known: SnapHistory, commit: CommitInfo): void {
  const change = changeOf(commit);
  if (!known.retire && change?.kind === "retired") known.retire = change;
  if (!known.person && change?.by === "person") known.person = change;
}

/** A commit's entry in the log, or undefined when it is no change: a run's merge (Run-Id) or a person's (Changed-By:
 *  user), told by its trailers. A merge's reason is what it kept, the paragraphs before the trailers; a person's commit
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

const byName = (a: SnapLearned, b: SnapLearned) => byBytes(a.name, b.name);

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
      if (!known) history.set(file, foldNewer(undefined, commit));
      else foldOlder(known, commit);
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
  const corrections = tree.find((entry) => entry.path === CORRECTIONS_FILE && regular(entry));
  const audits = tree.find((entry) => entry.path === AUDITS_FILE && regular(entry));
  const folders = new Map<string, { files: SnapFile[]; links: string[] }>();
  for (const entry of tree) {
    const name = folderOf(entry.path);
    if (!name || entry.type !== "blob") continue;
    const known = folders.get(name) ?? folders.set(name, { files: [], links: [] }).get(name)!;
    if (entry.mode === "120000") known.links.push(entry.path);
    else if (entry.mode === "100644" || entry.mode === "100755") known.files.push({ path: entry.path, oid: entry.oid, bytes: entry.bytes });
  }
  const workflows: SnapLearned[] = [];
  for (const [name, { files, links }] of folders) {
    const item = learnedItem(name, files, links, (path) => {
      const entry = tree.find((one) => one.path === path);
      return entry && regular(entry) && entry.bytes <= FILE_CAP ? textOf(blobs.get(entry.oid)) : undefined;
    }, {
      order: Math.min(...files.map(({ path }) => orderOf(path))),
      history: historyOf(keyFile(name)),
      run: runs.get(viewFile(name)) ?? null,
    });
    if (item) workflows.push(item);
  }
  return { v: 1, main, at, ...(corrections ? { corrections: { path: CORRECTIONS_FILE, oid: corrections.oid, bytes: corrections.bytes } } : {}), ...(audits ? { audits: { oid: audits.oid, bytes: audits.bytes } } : {}), workflows: workflows.sort(byName), log, log_more: more };
}

/** A draft from its folder's files: listed when its folder is well named and its README.md and workflow.json are there,
 *  each a regular file under FILE_CAP (only those are given their texts by `text`), and its README.md reads. */
function learnedItem(name: string, files: SnapFile[], links: readonly string[], text: (path: string) => string | undefined, at: { order: number; history: SnapHistory; run: string | null }, said?: { description: string; status: SnapLearned["status"]; retired_from?: SnapLearned["retired_from"] }): SnapLearned | undefined {
  if (!WORKFLOW_NAME.test(name)) return undefined;
  const key = files.find(({ path }) => path === keyFile(name));
  const shown = files.find(({ path }) => path === viewFile(name));
  if (!key || !shown || key.bytes > FILE_CAP || shown.bytes > FILE_CAP) return undefined;
  let fields = said;
  if (!fields) {
    const body = text(key.path);
    if (body === undefined) return undefined;
    const status = learnedStatus(body);
    fields = { description: learnedFront(body)?.description ?? "", status, ...(status === "retired" ? { retired_from: retiredFrom(body) } : {}) };
  }
  return { name, file: key.path, description: fields.description, status: fields.status, ...(fields.retired_from ? { retired_from: fields.retired_from } : {}), run: at.run, files: [...files].sort((a, b) => byBytes(a.path, b.path)), oid: key.oid, bytes: key.bytes, order: at.order, history: at.history, ...(links.length ? { links: [...links].sort(byBytes) } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The next snapshot, from the one a write read and its change: what the script writes once the commit lands.

/** A change to the folder's main: what a person or a run's merge writes. Each path is the folder's, relative, never
 *  under `.agentrun/`. `absent`: paths that must not be on main, as git holds it (any file, any mode); `same`: paths
 *  that must be on main as they are on another commit (a run's seed). The script checks both on main as it commits. */
export type FolderChange = {
  /** A run's merge names the run and its reason, and its `round` past the first (a follow-up's correction): its diff is
   *  kept under runDiffKey. The host's own book-keeping (an audit row) names what it kept. */
  by: { person: PersonKind; file: string; approved?: boolean } | { run: string; reason: string; round?: number } | { host: string };
  writes: readonly { path: string; text: string }[];
  deletes?: readonly string[];
  absent?: readonly string[];
  same?: readonly { commit: string; path: string }[];
  /** A run's merge: the commit the run was seeded from, which the folder must still hold, whatever the merge writes (a
   *  correction alone included), named only when this folder held it as the run's end began (commit.ts mustHold): one a
   *  reset of the agent's learning removed refuses the merge. */
  seed?: string;
};

/** A commit's message and trailers, as git keeps them: a person's names their action and the file, with Changed-By (and
 *  Approved-Via on an approval); a run's merge names the run, then what it kept, then its Run-Id. */
function messageOf(by: FolderChange["by"] | undefined): { message: string; subject: string; body: string; runId: string; changedBy: string; approvedVia: string } {
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  const paragraphs = (parts: string[]) => parts.map((part) => (part.endsWith("\n") ? part : `${part}\n`)).join("\n");
  if (!by) return { message: `${INIT_SUBJECT}\n`, subject: INIT_SUBJECT, body: "", runId: "", changedBy: "", approvedVia: "" };
  // The host's own book-keeping (an audit row): no trailer, so no change in the log a person reads.
  if ("host" in by) {
    const subject = `host: ${clean(by.host).trim() || "kept"}`;
    return { message: `${subject}\n`, subject, body: "", runId: "", changedBy: "", approvedVia: "" };
  }
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

/** Every path `snapshot` names a blob for: corrections.md, the audit ledger and each draft's files. */
function oidsOf(snapshot: Snapshot | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!snapshot) return out;
  if (snapshot.corrections) out.set(CORRECTIONS_FILE, snapshot.corrections.oid);
  if (snapshot.audits) out.set(AUDITS_FILE, snapshot.audits.oid);
  for (const item of snapshot.workflows) for (const file of item.files) out.set(file.path, file.oid);
  return out;
}

/** The snapshot once `change` is committed on `before` (none: the folder's first commit) at `seconds`, its main and its
 *  log entry's commit the placeholder the script puts the new main in. Also which paths changed, as git's diff of the
 *  commit lists them. */
export function nextSnapshot(before: Snapshot | undefined, change: Omit<FolderChange, "absent" | "same"> | undefined, seconds: number): { snapshot: Snapshot; changed: string[] } {
  const message = messageOf(change?.by);
  const commit: CommitInfo = { at: isoSeconds(seconds), ...message };
  const known = oidsOf(before);
  const writes = new Map((change?.writes ?? []).map(({ path, text }) => [path, { text, oid: blobOid(text), bytes: Buffer.byteLength(text, "utf8") }]));
  const deletes = new Set(change?.deletes ?? []);
  const changed = [...new Set([...[...writes].filter(([path, { oid }]) => known.get(path) !== oid).map(([path]) => path), ...[...deletes].filter((path) => !writes.has(path))])].sort(byBytes);
  const touched = new Set(changed);
  const runId = commit.runId;

  const written = writes.get(CORRECTIONS_FILE);
  const corrections = written ? { path: CORRECTIONS_FILE, oid: written.oid, bytes: written.bytes } : deletes.has(CORRECTIONS_FILE) ? undefined : before?.corrections;
  const ledger = writes.get(AUDITS_FILE);
  const audits = ledger ? { oid: ledger.oid, bytes: ledger.bytes } : deletes.has(AUDITS_FILE) ? undefined : before?.audits;

  const list = before?.workflows ?? [];
  const hit = new Set(changed.map(folderOf).filter((name): name is string => name !== undefined));
  const workflows = list.filter((item) => !hit.has(item.name)).map((item) => ({ ...item, order: item.order + 1 }));
  for (const name of hit) {
    const old = list.find((item) => item.name === name);
    const prefix = `${WORKFLOWS_DIR}/${name}/`;
    const files = new Map((old?.files ?? []).map((file) => [file.path, file]));
    for (const path of changed.filter((one) => one.startsWith(prefix))) {
      const write = writes.get(path);
      if (write) files.set(path, { path, oid: write.oid, bytes: write.bytes });
      else files.delete(path);
    }
    const key = keyFile(name);
    const keyText = writes.get(key)?.text;
    // A link the change writes a file over, or deletes, is a link no more.
    const links = (old?.links ?? []).filter((path) => !writes.has(path) && !deletes.has(path));
    const item = learnedItem(name, [...files.values()], links, (path) => writes.get(path)?.text, {
      order: 0,
      history: touched.has(key) ? foldNewer(old?.history, commit) : (old?.history ?? { at: commit.at }),
      run: runId && touched.has(viewFile(name)) ? runId : (old?.run ?? null),
    }, keyText === undefined && old ? { description: old.description, status: old.status, ...(old.retired_from ? { retired_from: old.retired_from } : {}) } : undefined);
    if (item) workflows.push(item);
  }

  const entry = change && isChange(commit) ? changeEntry(commit, PLACEHOLDER, changed) : undefined;
  const log = [...(entry ? [entry] : []), ...(before?.log ?? [])];
  const snapshot: Snapshot = {
    v: 1, main: PLACEHOLDER, at: commit.at, ...(corrections ? { corrections } : {}), ...(audits ? { audits } : {}),
    workflows: workflows.sort(byName),
    log: log.slice(0, LOG_KEEP), log_more: Boolean(before?.log_more) || log.length > LOG_KEEP,
  };
  return { snapshot, changed };
}

/** The snapshot with its placeholder put for `main`: what the script wrote, for a caller that keeps going. */
const withMain = (snapshot: Snapshot, main: string): Snapshot => JSON.parse(JSON.stringify(snapshot).replaceAll(ESCAPED_PLACEHOLDER, main)) as Snapshot;

// ---------------------------------------------------------------------------------------------------------------------
// The folder's Workspace is the one learningWorkspace (workspace/learning-workspace.ts): the local folder under the
// data directory, made by the first write (a read makes nothing: a folder not made reads as no main yet, NOT_FOUND),
// each level on the way checked, a link there refused as ESCAPE naming it (folderFailure reads it as a link).
// folderTestHooks.workspace stands in for it in tests.

/** Whose learning folder, under which data directory. */
export type LearningPlace = OneLearningPlace;
/** The folder's Workspace, and its end: called in a finally after every use. */
export type LearningFolder = OneLearningWorkspace;

/** Agent `place.agentId`'s learning folder as a Workspace: the one learningWorkspace, or the test's stand-in. */
export function learningWorkspace(place: LearningPlace): LearningFolder {
  if (folderTestHooks.workspace) return folderTestHooks.workspace(place);
  // A run's own process never opens a learning folder itself: its runner does, the claim's agent's (held.ts).
  if (held()) return heldLearningFolder();
  return oneLearningWorkspace(place);
}

/** What a learning folder's script run is, as a runner checks one a run's process asks of it (run-child-host.ts): its
 *  argv, the script's own environment, its deadline. */
export const LEARNING_SCRIPT = { file: (): string => SCRIPT_FILE, env: (): Record<string, string> => scriptEnv(), timeoutMs: (): number => SCRIPT_TIMEOUT_MS, ensure: (ws: Workspace): Promise<void> => ensureScript(ws) };

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

/** A workspace failure as the folder's: ESCAPE (a link below the root) or a read of a link (UNAVAILABLE naming a
 *  symbolic link) in words that name the link; any other UNAVAILABLE as the folder unreadable. */
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
  if (value?.v !== 1 || !isOidField(value.main) || !Array.isArray(value.workflows) || !Array.isArray(value.log) || (value.corrections !== undefined && !isOidField(value.corrections?.oid)) || (value.audits !== undefined && !isOidField(value.audits?.oid))) throw new Error("the learning folder's snapshot is not one this server reads (v1)");
  return { v: 1, main: value.main, at: value.at, ...(value.corrections ? { corrections: value.corrections } : {}), ...(value.audits ? { audits: value.audits } : {}), workflows: value.workflows, log: value.log, log_more: value.log_more };
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
/** The key a run's merge keeps its diff under (`.agentrun/diffs/<key>.json`), and that tells a merge already made: the run's
 *  id for its first round, `<run>.r<round>` for each later one (a follow-up's look-back), so each round merges once. */
export const runDiffKey = (runId: string, round = 1): string => (round > 1 ? `${runId}.r${round}` : runId);

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

/** Run `runId`'s merge of `round` (readRunDiff), or undefined when it never merged here. A stop between a merge's commit
 *  and its diff file leaves main and the run's ref moved with no diff: when main's log names the run and the round has no
 *  diff, the script's `merged` writes the diff from the run's ref (one exec), and it is read. */
export async function runMergeOf(ws: Workspace, runId: string, round = 1): Promise<RunDiff | undefined> {
  const key = runDiffKey(runId, round);
  const kept = await readRunDiff(ws, key);
  if (kept || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return kept;
  const named = (await readSnapshot(ws))?.log.some(({ by }) => "run" in by && by.run === runId);
  if (!named) return undefined;
  const done = await runScript(ws, ["merged", key]);
  if (done.code === 1) return undefined;
  if (done.code !== 0) throw failed("merged", done);
  return readRunDiff(ws, key);
}

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
 *  nothing was written), refused (a precondition failed on main: nothing was written), landed without its files
 *  brought in line (main moved, no snapshot written), or merged (the run, this round, merged already: its merge commit,
 *  nothing written). */
export type Committed =
  | { landed: true; main: string; snapshot: Snapshot }
  | { stale: true; main: string | undefined }
  | { refused: { absent: string[]; same: string[]; seed?: string } }
  | { unaligned: true; main: string }
  | { merged: string };

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
  const writes = change?.writes ?? [];
  for (const { path } of writes) checkPath(path);
  for (const path of [...(change?.deletes ?? []), ...(change?.absent ?? []), ...(change?.same ?? []).map(({ path }) => path)]) checkPath(path);
  for (const commit of [...(change?.same ?? []).map(({ commit }) => commit), ...(change?.seed !== undefined ? [change.seed] : [])]) if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  const ref = `refs/agentrun/import-${randomBytes(8).toString("hex")}`;
  const run = change && "run" in change.by ? runDiffKey(change.by.run, change.by.round) : undefined;
  const header = [
    `ref ${ref}`,
    `snapshot ${snapshotLine(snapshot, snapshot.log[0]?.commit === PLACEHOLDER ? 2 : 1)}`,
    ...(run ? changed.map((path) => `path ${path}`) : []),
    ...(change?.absent ?? []).map((path) => `absent ${path}`),
    ...(change?.same ?? []).map(({ commit, path }) => `same ${commit} ${path}`),
    ...(change?.seed !== undefined ? [`seed ${change.seed}`] : []),
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
    const seed = lines.find((line) => line.startsWith("seed "))?.slice(5);
    return { refused: { absent: lines.filter((line) => line.startsWith("absent ")).map((line) => line.slice(7)), same: lines.filter((line) => line.startsWith("same ")).map((line) => line.slice(5)), ...(seed !== undefined ? { seed } : {}) } };
  }
  if (result.code === 5 && /^[0-9a-f]{40,64}$/.test(said)) return { unaligned: true, main: said };
  if (result.code === 6 && run && /^[0-9a-f]{40,64}$/.test(said)) return { merged: said };
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

/** The texts `commit` holds at `paths` (each a plain path, checkPath), each read alone with one read-only exec (the
 *  script's show: git cat-file over each `<commit>:<path>`), never the whole tree, its blobs or its log, so the read is
 *  bounded by what is asked, whatever the folder holds. A path the commit holds no file at is not in it. Undefined when
 *  the folder has no such commit. */
export async function textsAt(ws: Workspace, commit: string, paths: readonly string[]): Promise<Record<string, string> | undefined> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  if (!paths.length) return {};
  const result = await runScript(ws, ["show", commit, ...paths.map(checkPath)]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw failed("show", result);
  // git cat-file --batch: per path, `<oid> <type> <size>\n<content>\n`, or `<name> missing\n`.
  const out: Record<string, string> = {};
  const bytes = result.stdout;
  let at = 0;
  for (const path of paths) {
    const end = bytes.indexOf(10, at);
    if (end < 0) throw failed("show", { code: result.code, stderr: "its answer ended early" });
    const header = bytes.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header.at(-1) === "missing" || header.length !== 3) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") out[path] = bytes.subarray(at, at + size).toString("utf8");
    at += size + 1;
  }
  return out;
}

/** Whether the folder holds `commit`: one read-only exec of the script's show with no path, which reads nothing but
 *  that. False once a reset of the agent's learning removed it (or the folder is not a repository). */
export async function holdsCommit(ws: Workspace, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  const result = await runScript(ws, ["show", commit]);
  if (result.code === 1) return false;
  if (result.code !== 0) throw failed("show", result);
  return true;
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

/** The folder's first commit when it has no main yet (an empty tree, the host's), and main's commit: through the
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
  /** A run's merge whose seed (FolderChange.seed) the folder no longer holds: its agent's learning was reset. */
  readonly seed: string | undefined;
  constructor(refused: { absent: string[]; same: string[]; seed?: string }) {
    super(`the learning folder's main refused the write: ${[...(refused.seed !== undefined ? [`the run's seed ${refused.seed} is not in the folder`] : []), ...refused.absent.map((path) => `${path} is there`), ...refused.same.map((path) => `${path} changed`)].join(", ")}`);
    this.name = "FolderRefused";
    this.absent = refused.absent;
    this.same = refused.same;
    this.seed = refused.seed;
  }
}

/** A run's merge (its round) that is on main already, made by another call (a reclaimed run racing its first claim, or
 *  a retry after a stop past its commit): `merge`, its commit. Nothing was written. */
export class FolderMerged extends Error {
  readonly merge: string;
  constructor(merge: string) {
    super(`the run merged on the learning folder's main already, at ${merge}`);
    this.name = "FolderMerged";
    this.merge = merge;
  }
}

/**
 * A write to the folder's main: `compute` reads the snapshot and the bodies it needs (as readLearning gives them) and
 * says what to write, or nothing (its result stands alone). Committed by commitChange; a main that moved under it, or
 * a body that changed as it was read, computes it again on the folder as it is then (WRITE_TRIES in all). A folder with
 * no main yet is made first (learningInit). A snapshot that is not main's is rebuilt (learningRepair). Throws
 * FolderRefused when a precondition fails on main, and FolderMerged when a run's merge (its round) is there already.
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
    if ("merged" in done) throw new FolderMerged(done.merged);
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
