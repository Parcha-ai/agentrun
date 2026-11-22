// The agent's learning through its store (learn/store.ts LearningStore): the one way serve reads and writes it. The
// store is a git history of files on main (the local folder, or code.storage); this side computes everything on top:
// - Every write to main is ONE save on the store, by compare and swap on the main it read: a person's edit, create,
//   retire, approve or restore, a run's merge and the host's own book-keeping alike (commitChange; learn/commit.ts
//   learningCommit is the API callers use), and the store's first commit (learningInit).
// - This side computes the tree's changes, the commit's message and time, the front matter, each file's history and
//   order, the log, and so the whole next snapshot (nextSnapshot), from the snapshot the write read and the change. The
//   snapshot is committed with the change, `.agentrun/snapshot.json`, its own commit named by a placeholder (a commit
//   can't hold its own id) and its parent named outright.
// - Every read is at a commit: main's snapshot (read once a commit, then kept), and the bodies it names (read at that
//   commit, checked against the snapshot's blob id, then kept by it). A commit's snapshot that does not name its
//   commit's parent (a commit by a person's own hand in a local folder, which left the snapshot as it was) is rebuilt
//   from the commit whole and its history (snapshotOfRead).
// - A run's merge (its round) leaves its marker in its commit (.agentrun/runs/<key>), and its diff is that commit's
//   (runMergeOf): never written, never out of step.
// The snapshot's shape is v1: what the learning routes and a run's seed read. The store holds the owner's corrections
// (corrections.md, served whole), the compiled workflows (workflows/<name>/) and the host's audit ledger (audits.jsonl,
// never served to a run), nothing else but the host's folder.
import { createHash } from "node:crypto";
import { CORRECTIONS_FILE } from "./corrections.js";
import { COMMIT, HOST_DIR, type LearningStore, MARKER_KEY, runMarker, type StoreCommit, type StoreFile } from "./store.js";
import { learnedFront, learnedStatus, retiredFrom, WORKFLOW_NAME, WORKFLOWS_DIR } from "./workflow-draft.js";

export const SNAPSHOT_FILE = `${HOST_DIR}/snapshot.json`;
/** The audit ledger at the store's top (learn/audit.ts): one JSON row per line. */
export const AUDITS_FILE = "audits.jsonl";
/** The most changes the snapshot's log keeps, newest first; `log_more` says older exist. */
export const LOG_KEEP = 200;
/** A file main holds over this is no learned file: a workflow's file is at most 16 KB (check.ts CAPS.file). */
export const FILE_CAP = 1 << 20;
/** How many times a write is computed again on a main that moved under it. */
const WRITE_TRIES = 3;
/** The subject of the store's first commit, the host's: neither a person's change nor a run's. */
const INIT_SUBJECT = "host: the agent's learning folder";
/** What stands for the commit that holds a snapshot, in it: two U+0001, which JSON never writes raw. */
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
  /** The runs a purge's scrub marked on main (`.agentrun/purged/<key>`), by run id, sorted; absent when none: no history
   *  read serves their lines as another merge's context (learn/commit.ts purgedContextOut). */
  purged?: string[];
};
/** A run's merge (its round), as its commit holds it: its key, its commit, its parent, and each file's patch. */
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

/** The run a purge's scrub key names (runDiffKey's inverse): its id, a later round's `.r<round>` cut. */
export const purgedRunOf = (key: string): string => key.replace(/\.r\d+$/, "");
/** `log` with each change by a run of `purged` given no reason: a purged run's words are kept in no snapshot (the
 *  snapshot is a file of main's tree), its change itself kept for the history reads to leave out by its run. */
const purgedField = (purged: Iterable<string> | undefined): { purged?: string[] } => {
  const runs = [...new Set(purged ?? [])].sort();
  return runs.length ? { purged: runs } : {};
};
const reasonsOut = (log: SnapChange[], purged: ReadonlySet<string>): SnapChange[] => (purged.size ? log.map((change) => ("run" in change.by && purged.has(change.by.run) ? { ...change, reason: "" } : change)) : log);
/** Whether a commit's message holds a line git's log of changes greps for: `Run-Id: ` or `Changed-By: user`. */
const isChange = (commit: CommitInfo) => `${commit.subject}\n${commit.body}`.split("\n").some((line) => line.startsWith("Run-Id: ") || line === "Changed-By: user");

const byName = (a: SnapLearned, b: SnapLearned) => byBytes(a.name, b.name);

// ---------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------
// A snapshot from a commit whole: one whose committed snapshot is not its own.

const utf8 = new TextDecoder("utf-8", { fatal: true });
const textOf = (bytes: Uint8Array | undefined): string | undefined => {
  if (!bytes) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

type TreeEntry = { mode: string; type: string; oid: string; bytes: number; path: string };
/** A commit read whole: its tree (no host path), its first-parent history with the paths each commit changed (no host
 *  path), and its blobs by id. */
/** `purged`: the runs a scrub's marker on the commit names (`.agentrun/purged/<key>`). */
type WholeRead = { main: string | undefined; tree: TreeEntry[]; records: { commit: CommitInfo; sha: string; files: string[] }[]; blobs: Map<string, Buffer>; purged?: ReadonlySet<string> };

/** A commit's time as a store gives it (git's %cI, its own offset, "+00:00", "+02:00" or "Z"), in the one form a
 *  snapshot keeps: UTC in whole seconds, ending "Z", as nextSnapshot writes it, so a snapshot rebuilt from history and
 *  one built incrementally agree. Text that is no time is kept as it is. */
export function commitTime(text: string): string {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A commit as the snapshot reads it, from its message: its subject, its body and its last paragraph's trailers. */
function infoOf(commit: StoreCommit): CommitInfo {
  const message = commit.message.replace(/\r\n/g, "\n");
  const nl = message.indexOf("\n");
  const subject = (nl < 0 ? message : message.slice(0, nl)).trim();
  const body = nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, "");
  const last = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  const trailer = (key: string) => last.split("\n").filter((line) => line.startsWith(`${key}: `)).map((line) => line.slice(key.length + 2).trim()).join(",");
  return { at: commitTime(commit.at), subject, body, runId: trailer("Run-Id"), changedBy: trailer("Changed-By"), approvedVia: trailer("Approved-Via") };
}
const isHostPath = (path: string) => path === HOST_DIR || path.startsWith(`${HOST_DIR}/`);
const PURGED_DIR = `${HOST_DIR}/purged/`;

/** The snapshot of a commit read whole: every item from its tree and its blobs, each file's history and order from its
 *  first-parent log, and the newest LOG_KEEP changes. */
export function snapshotOfRead(read: WholeRead): Snapshot | undefined {
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
  // A run a scrub marked (`.agentrun/purged/<key>`) has no reason in the log rebuilt, as in the one its scrub wrote.
  return { v: 1, main, at, ...(corrections ? { corrections: { path: CORRECTIONS_FILE, oid: corrections.oid, bytes: corrections.bytes } } : {}), ...(audits ? { audits: { oid: audits.oid, bytes: audits.bytes } } : {}), workflows: workflows.sort(byName), log: reasonsOut(log, read.purged ?? new Set()), log_more: more, ...purgedField(read.purged) };
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
// The next snapshot, from the one a write read and its change: what is committed with the change.

/** A change to the store's main: what a person or a run's merge writes. Each path is the store's, relative, never
 *  under `.agentrun/`. `absent`: paths that must not be on main, as git holds it (any file, any mode); `same`: paths
 *  that must be on main as they are on another commit (a run's seed). The store checks both on main as it commits. */
export type FolderChange = {
  /** A run's merge names the run and its reason, and its `round` past the first (a follow-up's correction): its commit
   *  is marked with runDiffKey. The host's own book-keeping (an audit row) names what it kept. */
  by: { person: PersonKind; file: string; approved?: boolean } | { run: string; reason: string; round?: number } | { host: string };
  writes: readonly { path: string; text: string }[];
  deletes?: readonly string[];
  absent?: readonly string[];
  same?: readonly { commit: string; path: string }[];
  /** A run's merge: the commit the run was seeded from, which the folder must still hold, whatever the merge writes (a
   *  correction alone included), named only when this folder held it as the run's end began (commit.ts mustHold): one a
   *  reset of the agent's learning removed refuses the merge. */
  seed?: string;
  /** A purge's scrub of a run's text: the key it scrubs (runDiffKey), marked in its commit, so that key never merges
   *  after, and the scrub itself lands once. */
  purged?: string;
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
 *  log entry's commit the placeholder its commit is read back as. Also which paths changed, as git's diff of the
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
  // A purge's scrub takes its run's reasons off the log as it takes its lines off corrections.md.
  const log = reasonsOut([...(entry ? [entry] : []), ...(before?.log ?? [])], new Set(change?.purged !== undefined ? [purgedRunOf(change.purged)] : []));
  const snapshot: Snapshot = {
    v: 1, main: PLACEHOLDER, at: commit.at, ...(corrections ? { corrections } : {}), ...(audits ? { audits } : {}),
    workflows: workflows.sort(byName),
    log: log.slice(0, LOG_KEEP), log_more: Boolean(before?.log_more) || log.length > LOG_KEEP,
    ...purgedField([...(before?.purged ?? []), ...(change?.purged !== undefined ? [purgedRunOf(change.purged)] : [])]),
  };
  return { snapshot, changed };
}

/** The snapshot with its placeholder put for `main`: what the commit holds, as a reader reads it. */
const withMain = (snapshot: Snapshot, main: string): Snapshot => JSON.parse(JSON.stringify(snapshot).replaceAll(ESCAPED_PLACEHOLDER, main)) as Snapshot;

// ---------------------------------------------------------------------------------------------------------------------
// Reading: a commit's snapshot, and the bodies it names, at that commit.

/** A store that kept moving under a write (WRITE_TRIES writes in a row lost their compare and swap): try again. Routes
 *  answer 503. */
export class FolderBusy extends Error {
  constructor() {
    super("the agent's learning folder is being written: try again");
    this.name = "FolderBusy";
  }
}

const isOidField = (value: unknown) => typeof value === "string" && COMMIT.test(value);

/** Snapshots read, by store and commit: a commit's never changes. */
const snapshots = new Map<string, Snapshot>();
const SNAPSHOTS_KEPT = 256;
function keepSnapshot(key: string, snapshot: Snapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  for (const old of snapshots.keys()) {
    if (snapshots.size <= SNAPSHOTS_KEPT) break;
    snapshots.delete(old);
  }
}

/** Bodies already checked, by blob id: an oid names its bytes, so one read is good for every snapshot naming it. */
const bodies = new Map<string, string>();
let bodyBytes = 0;
const BODY_CACHE = 16 << 20;
function keep(oid: string, text: string): void {
  if (text.length > FILE_CAP || bodies.has(oid)) return;
  bodies.set(oid, text);
  bodyBytes += text.length;
  for (const [old, held] of bodies) {
    if (bodyBytes <= BODY_CACHE) break;
    bodies.delete(old);
    bodyBytes -= held.length;
  }
}

/** Tests only: the snapshots and bodies already read, forgotten, so the next read of each goes to the store. */
export function forgetBodies(): void {
  bodies.clear();
  bodyBytes = 0;
  snapshots.clear();
}

/** Blob `oid`'s body forgotten, when it was kept: a text a purge took off main is held in this process no longer. */
export function forgetBody(oid: string): void {
  const held = bodies.get(oid);
  if (held === undefined) return;
  bodies.delete(oid);
  bodyBytes -= held.length;
}

/** The snapshot `file` holds (committed with commit `commit`, whose parent is `parent`), or undefined when it is not
 *  that commit's: none, not v1, or written for another parent (a commit made by hand since). */
function keptSnapshot(file: StoreFile | undefined, commit: string, parent: string | null): Snapshot | undefined {
  if (!file) return undefined;
  let value: (Snapshot & { parent?: unknown }) | undefined;
  try {
    value = JSON.parse(file.body.toString("utf8").replaceAll(ESCAPED_PLACEHOLDER, commit)) as Snapshot & { parent?: unknown };
  } catch {
    return undefined;
  }
  if (value?.v !== 1 || value.parent !== parent || value.main !== commit || !Array.isArray(value.workflows) || !Array.isArray(value.log) || (value.corrections !== undefined && !isOidField(value.corrections?.oid)) || (value.audits !== undefined && !isOidField(value.audits?.oid)) || (value.purged !== undefined && !(Array.isArray(value.purged) && value.purged.every((run) => typeof run === "string")))) return undefined;
  return { v: 1, main: value.main, at: value.at, ...(value.corrections ? { corrections: value.corrections } : {}), ...(value.audits ? { audits: value.audits } : {}), workflows: value.workflows, log: value.log, log_more: value.log_more, ...purgedField(value.purged) };
}

/** Commit `commit` read whole from `store`: its tree and blobs, its history and what each commit changed. */
async function wholeRead(store: LearningStore, commit: string): Promise<WholeRead | undefined> {
  const [files, history] = await Promise.all([store.read(commit), store.log(commit)]);
  if (!files || !history) return undefined;
  const blobs = new Map<string, Buffer>();
  const tree: TreeEntry[] = [];
  const purged = new Set<string>();
  for (const file of files) {
    if (file.path.startsWith(PURGED_DIR)) purged.add(purgedRunOf(file.path.slice(PURGED_DIR.length)));
    if (isHostPath(file.path)) continue;
    const oid = blobOid(file.body);
    blobs.set(oid, file.body);
    tree.push({ mode: file.mode, type: "blob", oid, bytes: file.body.length, path: file.path });
  }
  const records = [];
  for (const one of history) {
    const changed = one.files ?? (await store.diff(one.sha))?.map((file) => file.path) ?? [];
    records.push({ commit: infoOf(one), sha: one.sha, files: changed.filter((path) => !isHostPath(path)) });
  }
  return { main: commit, tree, records, blobs, purged };
}

/** Commit `commit`'s snapshot in `store`: the one it holds when it is its own, else rebuilt from it whole. Undefined
 *  when the store does not hold the commit. Kept by commit. */
async function snapshotOf(store: LearningStore, commit: string): Promise<Snapshot | undefined> {
  const key = `${store.id}\0${commit}`;
  const known = snapshots.get(key);
  if (known) return known;
  const [kept, own] = await Promise.all([store.read(commit, [SNAPSHOT_FILE]), store.log(commit, { limit: 1 })]);
  if (!kept || !own?.[0]) return undefined;
  let snapshot = keptSnapshot(kept[0], commit, own[0].parent);
  if (!snapshot) {
    const whole = await wholeRead(store, commit);
    if (!whole) return undefined;
    for (const entry of whole.tree) {
      const text = entry.bytes <= FILE_CAP ? textOf(whole.blobs.get(entry.oid)) : undefined;
      if (text !== undefined && entry.path !== AUDITS_FILE) keep(entry.oid, text);
    }
    snapshot = snapshotOfRead(whole);
  }
  if (snapshot) keepSnapshot(key, snapshot);
  return snapshot;
}

/** The store's main snapshot, or undefined when it has none (no main yet: the agent never learned). */
export async function readSnapshot(store: LearningStore): Promise<Snapshot | undefined> {
  const main = await store.head();
  return main ? snapshotOf(store, main) : undefined;
}

/** What a reader is given: the snapshot (undefined: no main yet) and the bodies it names, at its commit, each checked
 *  against it, as text (`body`) or bytes (`bytes`). */
export type FolderRead = { snapshot: Snapshot | undefined; body: (path: string, oid: string) => Promise<string>; bytes: (path: string, oid: string) => Promise<Buffer> };

/** The bodies `snapshot` names (corrections.md and each draft's files, never the audit ledger), each under FILE_CAP. */
function namedBodies(snapshot: Snapshot): { path: string; oid: string }[] {
  const out: { path: string; oid: string }[] = [];
  if (snapshot.corrections && snapshot.corrections.bytes <= FILE_CAP) out.push(snapshot.corrections);
  for (const item of snapshot.workflows) for (const file of item.files) if (file.bytes <= FILE_CAP) out.push(file);
  return out;
}

function folderRead(store: LearningStore, snapshot: Snapshot | undefined): FolderRead {
  /** Every body the snapshot names that is not kept yet, read at once in one store read: what a reader of one mostly
   *  reads next. */
  let fetched: Promise<void> | undefined;
  const prefetch = () => (fetched ??= (async () => {
    if (!snapshot) return;
    const missing = namedBodies(snapshot).filter(({ oid }) => !bodies.has(oid));
    if (!missing.length) return;
    for (const file of (await store.read(snapshot.main, missing.map(({ path }) => path))) ?? []) {
      const text = textOf(file.body);
      if (text !== undefined) keep(blobOid(file.body), text);
    }
  })());
  const bytesOf = async (path: string, oid: string): Promise<Buffer> => {
    if (!snapshot) throw new Error(`the agent's learning holds no ${path}: it has no main yet`);
    const file = (await store.read(snapshot.main, [path]))?.find((one) => one.path === path);
    if (!file || blobOid(file.body) !== oid) throw new Error(`the agent's learning at ${snapshot.main} holds no ${path} as its snapshot names it`);
    return file.body;
  };
  return {
    snapshot,
    body: async (path, oid) => {
      const known = bodies.get(oid);
      if (known !== undefined) return known;
      await prefetch().catch(() => undefined);
      const fetchedNow = bodies.get(oid);
      if (fetchedNow !== undefined) return fetchedNow;
      const text = textOf(await bytesOf(path, oid));
      if (text === undefined) throw new Error(`the agent's learning holds ${path}, which is not UTF-8 text`);
      keep(oid, text);
      return text;
    },
    bytes: bytesOf,
  };
}

/** `read` over the store's main snapshot and its bodies. */
export async function readLearning<T>(store: LearningStore, read: (folder: FolderRead) => Promise<T>): Promise<T> {
  return read(folderRead(store, await readSnapshot(store)));
}

/** The key a run's merge (its round) marks its commit with (`.agentrun/runs/<key>`), and that tells a merge already
 *  made: the run's id for its first round, `<run>.r<round>` for each later one (a follow-up's look-back), so each round
 *  merges once. */
export const runDiffKey = (runId: string, round = 1): string => (round > 1 ? `${runId}.r${round}` : runId);

/** Merges' diffs, by store and commit: a commit's never changes. */
const diffs = new Map<string, RunDiff["files"]>();

/** Run `runId`'s merge of `round`: the commit that marked it on main, and that commit's diff (no host path). Undefined
 *  when it never merged in this store. */
export async function runMergeOf(store: LearningStore, runId: string, round = 1): Promise<RunDiff | undefined> {
  const key = runDiffKey(runId, round);
  if (!MARKER_KEY.test(key)) return undefined;
  const main = await store.head();
  if (!main) return undefined;
  const merge = (await store.log(main, { path: runMarker(key), limit: 1 }))?.[0];
  if (!merge) return undefined;
  const cached = `${store.id}\0${merge.sha}`;
  let files = diffs.get(cached);
  if (!files) {
    files = ((await store.diff(merge.sha)) ?? []).filter((file) => !isHostPath(file.path));
    diffs.set(cached, files);
    for (const old of diffs.keys()) {
      if (diffs.size <= SNAPSHOTS_KEPT) break;
      diffs.delete(old);
    }
  }
  return { v: 1, run: key, merge: merge.sha, parent: merge.parent ?? "", files };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing: one save a write.

/** A path a change may name: the store's, plain (letters, digits, ".", "_", "-" and "/"), never `.git` or `.agentrun`. */
function checkPath(path: string): string {
  const parts = path.split("/");
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || parts.some((part) => part === "" || part === "." || part === "..") || parts[0] === HOST_DIR || parts[0] === ".git") throw new Error(`${JSON.stringify(path)} is not a path a learning write names`);
  return path;
}
const checkCommit = (commit: string): string => {
  if (!COMMIT.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  return commit;
};

/** `snapshot` as committed with the change on `parent`: JSON, its own commit the placeholder. */
function snapshotText(snapshot: Snapshot, parent: string | null): string {
  const json = JSON.stringify({ ...snapshot, parent });
  const expected = (snapshot.main === PLACEHOLDER ? 1 : 0) + (snapshot.log[0]?.commit === PLACEHOLDER ? 1 : 0);
  if (json.split(ESCAPED_PLACEHOLDER).length - 1 !== expected) throw new Error("a learning text holds U+0001, which the learning snapshot never keeps");
  return json;
}

/** The most one write carries, its files and its snapshot together. */
export const WRITE_MAX = 2 * 1024 * 1024;
/** A write that would carry more than WRITE_MAX: refused whole, nothing saved. */
export class FolderTooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`the write would carry ${bytes} bytes; one write to the agent's learning takes at most ${WRITE_MAX}`);
    this.name = "FolderTooLarge";
    this.bytes = bytes;
  }
}

/** What one commit did: landed (its main and snapshot), stale (main is `main`, not the one it read: nothing was
 *  written), refused (a precondition failed on main: nothing was written), or merged (the run, this round, merged
 *  already, or its key was purged: that commit, nothing written). */
export type Committed =
  | { landed: true; main: string; snapshot: Snapshot }
  | { stale: true; main: string | undefined }
  | { refused: { absent: string[]; same: string[]; seed?: string } }
  | { merged: string };

/**
 * One write to main, one save on the store: `change` on the snapshot it was computed from (`base`: none for the
 * store's first commit), with the next snapshot (nextSnapshot) in the same commit. The commit moves main only from
 * `base.main` (compare and swap). Nothing is retried here: writeLearning computes again on a main that moved.
 */
export async function commitChange(store: LearningStore, base: Snapshot | undefined, change: FolderChange | undefined): Promise<Committed> {
  const seconds = Math.floor(Date.now() / 1000);
  const { snapshot, changed } = nextSnapshot(base, change, seconds);
  // A change that changes nothing on main is no commit: main stays, and nothing is saved. A purge's scrub always lands
  // (its marker is the change).
  if (base && change && !changed.length && change.purged === undefined) return { landed: true, main: base.main, snapshot: base };
  const writes = change?.writes ?? [];
  for (const { path } of writes) checkPath(path);
  for (const path of [...(change?.deletes ?? []), ...(change?.absent ?? []), ...(change?.same ?? []).map(({ path }) => path)]) checkPath(path);
  for (const commit of [...(change?.same ?? []).map(({ commit }) => commit), ...(change?.seed !== undefined ? [change.seed] : [])]) checkCommit(commit);
  const old = base?.main ?? null;
  const kept = snapshotText(snapshot, old);
  const bytes = writes.reduce((sum, { path, text }) => sum + Buffer.byteLength(path) + Buffer.byteLength(text, "utf8"), Buffer.byteLength(kept, "utf8"));
  if (bytes > WRITE_MAX) throw new FolderTooLarge(bytes);
  const run = change && "run" in change.by ? runDiffKey(change.by.run, change.by.round) : undefined;
  const saved = await store.save({
    old,
    message: messageOf(change?.by).message,
    at: seconds,
    writes: [...writes, { path: SNAPSHOT_FILE, text: kept }],
    ...(change?.deletes?.length ? { deletes: change.deletes } : {}),
    ...(change?.absent?.length ? { absent: change.absent } : {}),
    ...(change?.same?.length ? { same: change.same } : {}),
    ...(change?.seed !== undefined ? { seed: change.seed } : {}),
    ...(run ? { run } : {}),
    ...(change?.purged !== undefined ? { purged: change.purged } : {}),
  });
  if ("saved" in saved) {
    const landed = withMain(snapshot, saved.saved);
    keepSnapshot(`${store.id}\0${saved.saved}`, landed);
    for (const { text } of writes) keep(blobOid(text), text);
    return { landed: true, main: saved.saved, snapshot: landed };
  }
  if ("stale" in saved) return { stale: true, main: saved.stale ?? undefined };
  if ("refused" in saved) return { refused: saved.refused };
  if ("already" in saved) return { merged: saved.already };
  // The tree as main has it already (its snapshot differing only in time is not possible: nextSnapshot found a change).
  if (base) return { landed: true, main: base.main, snapshot: base };
  throw new Error("the learning store's first commit changed nothing");
}

/** The snapshot of `commit` (as main had it then), or undefined when the store does not hold it. */
export async function snapshotAt(store: LearningStore, commit: string): Promise<Snapshot | undefined> {
  return snapshotOf(store, checkCommit(commit));
}

/** `commit` as main had it (snapshotAt) with the blobs its snapshot names (no marker), by oid. Undefined when the store
 *  does not hold it. */
export async function folderAt(store: LearningStore, commit: string): Promise<{ snapshot: Snapshot; blobs: ReadonlyMap<string, Buffer> } | undefined> {
  const snapshot = await snapshotOf(store, checkCommit(commit));
  if (!snapshot) return undefined;
  // The files the snapshot names alone, never the markers: one more each merge, and code.storage reads each body in a
  // call of its own.
  const paths = [...(snapshot.corrections ? [snapshot.corrections.path] : []), ...(snapshot.audits ? [AUDITS_FILE] : []), ...snapshot.workflows.flatMap((workflow) => workflow.files.map((file) => file.path))];
  const files = await store.read(commit, paths);
  if (!files) return undefined;
  const blobs = new Map<string, Buffer>();
  for (const file of files) if (!isHostPath(file.path)) blobs.set(blobOid(file.body), file.body);
  return { snapshot, blobs };
}

/** The texts `commit` holds at `paths` (each a plain path, checkPath), and nothing else, so the read is bounded by what
 *  is asked. A path the commit holds no file at is not in it. Undefined when the store does not hold the commit. */
export async function textsAt(store: LearningStore, commit: string, paths: readonly string[]): Promise<Record<string, string> | undefined> {
  checkCommit(commit);
  const files = await store.read(commit, paths.map(checkPath));
  if (!files) return undefined;
  return Object.fromEntries(files.filter((file) => paths.includes(file.path)).map((file) => [file.path, file.body.toString("utf8")]));
}

/** Whether the store holds `commit`: false once a reset of the agent's learning removed it. */
export async function holdsCommit(store: LearningStore, commit: string): Promise<boolean> {
  return (await store.log(checkCommit(commit), { limit: 1 })) !== undefined;
}

/** The store's first commit when it has no main yet (an empty tree, the host's), and main's commit. */
export async function learningInit(store: LearningStore): Promise<string> {
  const main = await store.head();
  if (main) return main;
  const result = await commitChange(store, undefined, undefined);
  if ("landed" in result) return result.main;
  if ("stale" in result && result.main) return result.main;
  throw new Error("the agent's learning could not be made");
}

/** A write's preconditions that failed on main: nothing was written. */
export class FolderRefused extends Error {
  readonly absent: string[];
  readonly same: string[];
  /** A run's merge whose seed (FolderChange.seed) the store no longer holds: its agent's learning was reset. */
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
 *  a retry after a stop past its commit), or a key a purge scrubbed: `merge`, that commit. Nothing was written. */
export class FolderMerged extends Error {
  readonly merge: string;
  constructor(merge: string) {
    super(`the run merged on the learning folder's main already, at ${merge}`);
    this.name = "FolderMerged";
    this.merge = merge;
  }
}

/**
 * A write to the store's main: `compute` reads the snapshot and the bodies it needs (as readLearning gives them) and
 * says what to write, or nothing (its result stands alone). Committed by commitChange; a main that moved under it
 * computes it again on main as it is then (`maxTries` in all, then FolderBusy). A store with no main yet is made first
 * (learningInit). Throws FolderRefused when a precondition fails on main, and FolderMerged when a run's merge (its
 * round) is there already.
 */
export async function writeLearning<T>(store: LearningStore, compute: (folder: FolderRead) => Promise<{ result: T; change?: FolderChange }>, maxTries = WRITE_TRIES): Promise<{ result: T; main?: string; snapshot?: Snapshot }> {
  for (let tries = 0; ; tries++) {
    if (tries >= maxTries) throw new FolderBusy();
    const snapshot = await readSnapshot(store);
    const out = await compute(folderRead(store, snapshot));
    if (!out.change) return { result: out.result };
    if (!snapshot) {
      await learningInit(store);
      // Computed again on the store just made.
      continue;
    }
    const done = await commitChange(store, snapshot, out.change);
    if ("landed" in done) return { result: out.result, main: done.main, snapshot: done.snapshot };
    if ("refused" in done) throw new FolderRefused(done.refused);
    if ("merged" in done) throw new FolderMerged(done.merged);
  }
}
