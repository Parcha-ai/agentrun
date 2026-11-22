// A purged run's text taken out of its agent's learning, history and all (agent-delete.ts purgeRun, through the server's
// forgetCopies): main's whole history rebuilt without it, the same way on every store (learn/store.ts rewrite).
import { CORRECTIONS_FILE } from "./corrections.js";
import { blobOid, forgetHistory, hostCommitOf, isHostPath, rewrittenSnapshot, scrubbedMessage, SNAPSHOT_FILE, type Snapshot } from "./folder.js";
import { type ChainCommit, type LearningStore, MOVED_FILE, purgedMarker, type StoreCommit, type StoreFile } from "./store.js";
import { WORKFLOWS_DIR } from "./workflow-draft.js";

/** The host's words on the commit a purge ends with (its message reads `host: <these>`). */
const SCRUB = "a purged run's text removed";
/** How many times a purge starts over when main moved while it rebuilt. */
const ATTEMPTS = 4;

/**
 * Run `runId`'s text taken out of `store`: each commit of main's history, oldest first, rebuilt with corrections.md
 * without every line whose words the run's merges added (as the store diffs each merge) and no other run's merge did, the run's merge
 * commits kept with their reason cut (`learning: <run>: merged`, its Run-Id trailer) and so empty of its text, and
 * each commit's snapshot rebuilt (learn/folder.ts rewrittenSnapshot: the new commit ids, the run's reasons cut). A
 * commit left with nothing of its own is dropped. One host commit on top marks `.agentrun/purged/<run>`: no merge of the
 * run lands after (learn/store.ts save), and a purge run again finds it and does nothing. The store moves main to the
 * new chain by compare and swap and leaves no byte of the old one (learn/store.ts rewrite); a run merging meanwhile
 * finds main moved, as after a reset. Every commit id changes; every other run's history and diffs stay. `commit`: the
 * new main, when the purge rewrote it; `moved`: each old commit's new one, the commit whose tree it now is (one dropped
 * goes to the one before it), so a record naming an old commit (a promotion's) is moved to it. `nothing`: why no
 * rewrite was needed (Nothing).
 */
export async function forgetRunText(store: LearningStore, runId: string): Promise<Forgot> {
  for (let attempt = 1; ; attempt++) {
    const done = await purgeOnce(store, runId);
    if (done !== "stale") return done;
    if (attempt >= ATTEMPTS) throw new Error(`the agent's learning kept moving while run ${runId}'s text was taken out of it: send the purge again`);
  }
}

/** Why a purge rewrote nothing: `empty`, the agent has learned nothing (no main); `purged`, the run was purged
 *  already (its marker is at main); `unmerged`, no commit of main's history carries the run's Run-Id trailer. */
export type Nothing = "empty" | "purged" | "unmerged";
export type Forgot = { commit: string; moved: ReadonlyMap<string, string> } | { nothing: Nothing };

async function purgeOnce(store: LearningStore, runId: string): Promise<Forgot | "stale"> {
  const old = await store.head();
  if (!old) return { nothing: "empty" };
  const [marked, newestFirst] = await Promise.all([store.read(old, [purgedMarker(runId)]), store.log(old)]);
  if (!marked || !newestFirst) return "stale";
  // Purged already: what a rewrite stopped after moving main kept of the old history goes now, or this throws, retryable.
  if (marked.length) {
    await store.tidy();
    return { nothing: "purged" };
  }
  const runOf = (message: string): string | undefined => message.split("\n").find((line) => line.startsWith("Run-Id: "))?.slice("Run-Id: ".length);
  const merges = new Set(newestFirst.filter(({ message }) => runOf(message) === runId).map(({ sha }) => sha));
  if (!merges.size) return { nothing: "unmerged" };
  const history = [...newestFirst].reverse();
  // Who wrote a correction line is known only from the merges, the one place a run writes: the lines each merge's diff
  // adds. The run's lines go from every tree, unless another run's merge added the same words. A hand commit owns nothing.
  const purged = new Set<string>();
  const kept = new Set<string>();
  for (const one of newestFirst) {
    const run = runOf(one.message);
    if (!run) continue;
    const diff = await store.diff(one.sha);
    if (!diff) return "stale";
    for (const file of diff) if (file.path === CORRECTIONS_FILE && "patch" in file) for (const line of addedLines(file.patch)) (run === runId ? purged : kept).add(line);
  }
  const drop = new Set([...purged].filter((line) => !kept.has(line)));

  const rewritten = new Map<string, string | null>();
  const changed = new Map<string, string[]>();
  const moved = new Map<string, string>();
  const oldBodies = new Set<string>();
  // Each learned workflow's owner as the old history stood at the commit: the run whose merge last wrote its
  // workflow.json (SnapLearned.run's rule); a hand commit changes no owner. The run's own go from every tree.
  const owners = new Map<string, string>();
  let views = new Map<string, Buffer>();
  let tree: readonly StoreFile[] = [];
  let tip: string | null = null;
  let landed: Snapshot | undefined;
  const saved = await store.rewrite(old, async (commit) => {
    for (const one of history) {
      const files = await store.read(one.sha);
      if (!files) throw new Moved();
      // A store's fence (a rewrite cut short after it) adds nothing but MOVED_FILE: no history to keep.
      if (files.some(({ path }) => path === MOVED_FILE)) {
        rewritten.set(one.sha, null);
        if (tip) moved.set(one.sha, tip);
        continue;
      }
      const run = runOf(one.message);
      const now = new Map(files.flatMap(({ path, body }) => { const name = viewOf(path); return name ? [[name, body] as const] : []; }));
      if (run) for (const [name, body] of now) if (!views.get(name)?.equals(body)) owners.set(name, run);
      views = now;
      const gone = new Set([...owners].filter(([, owner]) => owner === runId).map(([name]) => name));
      const built = rebuilt(one, files, { drop, gone }, runId, { rewritten, changed, tree }, tip, oldBodies);
      // A commit with nothing of its own left (its tree the one before's) is no commit: a store refuses one that
      // changes nothing.
      if (!merges.has(one.sha) && sameTree(built.files, tree)) {
        rewritten.set(one.sha, null);
        if (tip) moved.set(one.sha, tip);
        continue;
      }
      tip = await commit(built.commit(tip));
      rewritten.set(one.sha, tip);
      moved.set(one.sha, tip);
      tree = built.files;
      landed = built.snapshot?.(tip);
    }
    const host = hostCommitOf(SCRUB, landed, tip!, Math.floor(Date.now() / 1000));
    const files = [...tree.filter(({ path }) => path !== SNAPSHOT_FILE), { path: purgedMarker(runId), mode: "100644" as const, body: Buffer.alloc(0) }, ...(host.snapshot ? [{ path: SNAPSHOT_FILE, mode: "100644" as const, body: Buffer.from(host.snapshot, "utf8") }] : [])];
    return commit({ parent: tip, message: host.message, at: Math.floor(Date.now() / 1000), files: sorted(files) });
  }).catch((error: unknown) => (error instanceof Moved ? ({ stale: null } as const) : Promise.reject(error)));
  if ("stale" in saved) return "stale";
  // What this process kept of the old history: its snapshots, and the bodies that held the run's lines.
  forgetHistory(store, oldBodies);
  return { commit: saved.saved, moved };
}

/** A commit read gone while its history was rebuilt: main moved. */
class Moved extends Error {}

/** Commit `one` (its files `files`) rebuilt on the chain so far (`rewritten`, `changed` and the tree of its tip, `tree`):
 *  corrections.md without the lines whose words are in `drop`, no file of a workflow folder named in `gone`, its message scrubbed when it is a merge of `runId`, the paths it changes now set in
 *  `changed`, its snapshot as rewrittenSnapshot rebuilds it on `parent`. `oldBodies` gains the blobs it no longer holds. */
function rebuilt(one: StoreCommit, files: readonly StoreFile[], { drop, gone }: { drop: ReadonlySet<string>; gone: ReadonlySet<string> }, runId: string, chain: { rewritten: ReadonlyMap<string, string | null>; changed: Map<string, string[]>; tree: readonly StoreFile[] }, parent: string | null, oldBodies: Set<string>) {
  const out: StoreFile[] = [];
  let corrections: { path: string; oid: string; bytes: number } | undefined;
  for (const file of files) {
    if (file.path === SNAPSHOT_FILE) continue;
    const folder = folderOf(file.path);
    if (folder && gone.has(folder)) {
      oldBodies.add(blobOid(file.body));
      continue;
    }
    const lines = file.path === CORRECTIONS_FILE ? file.body.toString("utf8").split("\n") : [];
    if (lines.some((line) => drop.has(line))) {
      const text = lines.filter((line) => !drop.has(line)).join("\n");
      const body = Buffer.from(text, "utf8");
      if (!body.equals(file.body)) oldBodies.add(blobOid(file.body));
      if (!text) continue;
      out.push({ ...file, body });
      corrections = { path: CORRECTIONS_FILE, oid: blobOid(body), bytes: body.length };
      continue;
    }
    if (file.path === CORRECTIONS_FILE) corrections = { path: CORRECTIONS_FILE, oid: blobOid(file.body), bytes: file.body.length };
    out.push(file);
  }
  const ownMerge = one.message.split("\n").includes(`Run-Id: ${runId}`);
  const was = new Map(chain.tree.map((file) => [file.path, file]));
  const now = new Set(out.map(({ path }) => path));
  chain.changed.set(one.sha, [...new Set([...out.filter((file) => !was.get(file.path)?.body.equals(file.body) || was.get(file.path)?.mode !== file.mode).map(({ path }) => path), ...[...was.keys()].filter((path) => !now.has(path))])].filter((path) => !isHostPath(path)).sort());
  const snapshot = rewrittenSnapshot(files.find(({ path }) => path === SNAPSHOT_FILE), one, chain.rewritten, chain.changed, runId, corrections, parent, gone);
  const all = sorted([...out, ...(snapshot ? [{ path: SNAPSHOT_FILE, mode: "100644" as const, body: Buffer.from(snapshot.text, "utf8") }] : [])]);
  return {
    files: all,
    snapshot: snapshot?.landed,
    commit: (on: string | null): ChainCommit => ({ parent: on, message: ownMerge ? scrubbedMessage(runId) : one.message, at: secondsOf(one.at), files: all }),
  };
}

/** The learned workflow a path is a file of (`workflows/<name>/...`), and the one whose workflow.json it is. */
const folderOf = (path: string): string | undefined => {
  const [top, name, ...rest] = path.split("/");
  return top === WORKFLOWS_DIR && name && rest.length ? name : undefined;
};
const viewOf = (path: string): string | undefined => {
  const [top, name, file, ...rest] = path.split("/");
  return top === WORKFLOWS_DIR && name && file === "workflow.json" && !rest.length ? name : undefined;
};
const sorted = (files: StoreFile[]): StoreFile[] => files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const sameTree = (a: readonly StoreFile[], b: readonly StoreFile[]): boolean => a.length === b.length && a.every((file, i) => file.path === b[i]!.path && file.mode === b[i]!.mode && file.body.equals(b[i]!.body));
const secondsOf = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
};

/** The lines a patch (git's hunks) adds and does not take away: what a merge appended. */
export function addedLines(patch: string): string[] {
  const lines = patch.split("\n");
  const taken = new Map<string, number>();
  for (const line of lines) if (line.startsWith("-")) taken.set(line.slice(1), (taken.get(line.slice(1)) ?? 0) + 1);
  return lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).filter((line) => {
    const left = taken.get(line) ?? 0;
    if (left) taken.set(line, left - 1);
    return !left && line.trim() !== "";
  });
}
