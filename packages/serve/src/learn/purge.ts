// A purged run's text taken out of its agent's learning, history and all (agent-delete.ts purgeRun, through the server's
// forgetCopies): main's whole history rebuilt without it, the same way on every store (learn/store.ts rewrite).
import { CORRECTIONS_FILE } from "./corrections.js";
import { blobOid, forgetHistory, hostCommitOf, isHostPath, type Restored, rewrittenSnapshot, scrubbedMessage, SNAPSHOT_FILE, type SnapLearned, type Snapshot } from "./folder.js";
import { type ChainCommit, FolderUnreadable, type LearningStore, MOVED_FILE, purgedMarker, runMarker, runMarkerText, runOfKey, type StoreCommit, type StoreFile, wroteOf } from "./store.js";
import { learnedStatus, statusFree, withStatusOf, WORKFLOWS_DIR } from "./workflow-draft.js";

/** The host's words on the commit a purge ends with (its message reads `host: <these>`). */
const SCRUB = "a purged run's text removed";
/** How many times a purge starts over when main moved while it rebuilt. */
const ATTEMPTS = 4;

/**
 * Run `runId`'s text taken out of `store`: each commit of main's history, oldest first, rebuilt with corrections.md
 * keeping, of each line text the run's merges added (as the store diffs each merge), only as many copies as the other
 * runs' merges added up to that commit (the first ones); each workflow file the run's merge wrote last there (as its
 * marker names the paths it wrote; a commit of no run that changes only its `status` and `retired_from` lines has them
 * replayed on what is given back where that makes it stricter, and one that changes any other line is its writer from then on) given back as the rebuilt parent of that merge held it, absent when it was absent there, so a
 * purge takes off only what the run's revisions put there and never another run's file; the run's merge commits kept
 * with their reason cut (`learning: <run>: merged`, its Run-Id trailer) and so empty of its text; and each commit's
 * snapshot rebuilt (learn/folder.ts rewrittenSnapshot: the new commit ids, the run's reasons cut, a given-back
 * workflow's entry its prior writer's). A commit left with nothing of its own is dropped. One host commit on top marks
 * `.agentrun/purged/<run>`, its body the commit map (`moved`, commit ids alone): no merge of the run lands after
 * (learn/store.ts save), and a purge run again finds it, rewrites nothing and hands the map back. The store moves main to the
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
export type Forgot = { commit: string; moved: ReadonlyMap<string, string> } | { nothing: Nothing; moved?: ReadonlyMap<string, string> };

/** The purge marker's body: the commit map its purge made (old commit id to new), commit ids alone, so a purge sent
 *  again after one that moved main and then failed (its cleanup) still hands it back and the records naming an old
 *  commit move (learning-routes.ts moveRecordCommits). */
const markerBody = (moved: ReadonlyMap<string, string>): Buffer => Buffer.from(`${JSON.stringify({ v: 1, moved: Object.fromEntries(moved) })}\n`, "utf8");
/** The commit map a purge marker holds (markerBody), or undefined for one without (an earlier release's, empty). */
function movedOf(body: Buffer): ReadonlyMap<string, string> | undefined {
  try {
    const held = JSON.parse(body.toString("utf8")) as { v?: unknown; moved?: unknown };
    if (held.v !== 1 || !held.moved || typeof held.moved !== "object") return undefined;
    const entries = Object.entries(held.moved as Record<string, unknown>);
    return entries.every(([from, to]) => SHA.test(from) && typeof to === "string" && SHA.test(to)) ? new Map(entries as [string, string][]) : undefined;
  } catch {
    return undefined;
  }
}
const SHA = /^[0-9a-f]{40}$/;

async function purgeOnce(store: LearningStore, runId: string): Promise<Forgot | "stale"> {
  const old = await store.head();
  if (!old) return { nothing: "empty" };
  const [marked, newestFirst] = await Promise.all([store.read(old, [purgedMarker(runId)]), store.log(old)]);
  if (!marked || !newestFirst) return "stale";
  // A history read that does not start at main is short (a listing cut, a backend that answered nothing): never
  // rebuilt from, so no tree loses a file on a guess. Retryable.
  // So is one whose commits do not chain, each the parent of the one before and the oldest the first (a commit left
  // out, a listing cut): rebuilt from, a merge of the run left out would keep its bytes and a commit left out would
  // lose another run's files.
  const chained = newestFirst.every(({ parent }, i) => parent === (newestFirst[i + 1]?.sha ?? null));
  if (newestFirst[0]?.sha !== old || !chained) throw new FolderUnreadable(false, `the agent's learning history could not be read whole: run ${runId}'s purge took nothing off, send it again`);
  // Purged already: what a rewrite stopped after moving main kept of the old history goes now, or this throws, retryable.
  if (marked.length) {
    await store.tidy();
    const moved = movedOf(marked[0]!.body);
    return { nothing: "purged", ...(moved ? { moved } : {}) };
  }
  const runOf = (message: string): string | undefined => message.split("\n").find((line) => line.startsWith("Run-Id: "))?.slice("Run-Id: ".length);
  const merges = new Set(newestFirst.filter(({ message }) => runOf(message) === runId).map(({ sha }) => sha));
  if (!merges.size) return { nothing: "unmerged" };
  const history = [...newestFirst].reverse();
  // Who wrote a correction line is known only from the merges, the one place a run writes: the lines each merge's diff
  // adds. Each text the run's merges added leaves every tree but for as many copies as other runs' merges added of it
  // up to that commit (a later run's copy of the same words keeps nothing older). A hand commit owns nothing.
  const purged = new Set<string>();
  const others = new Map<string, string[]>();
  for (const one of newestFirst) {
    const run = runOf(one.message);
    if (!run) continue;
    const diff = await store.diff(one.sha);
    if (!diff) return "stale";
    for (const file of diff) {
      if (file.path !== CORRECTIONS_FILE || !("patch" in file)) continue;
      const lines = addedLines(file.patch);
      if (run === runId) for (const line of lines) purged.add(line);
      else others.set(one.sha, [...(others.get(one.sha) ?? []), ...lines]);
    }
  }
  const keep = new Map([...purged].map((line) => [line, 0]));

  const rewritten = new Map<string, string | null>();
  const changed = new Map<string, string[]>();
  const moved = new Map<string, string>();
  const oldBodies = new Set<string>();
  // Each workflow file's owner as the old history stood at the commit, by path: the run whose merge last wrote it, as
  // that merge's own marker names the paths it wrote (written or deleted, whether or not its bytes changed: a rewrite
  // that makes a merge's write the bytes already there keeps its owner); a merge whose marker names none (an earlier
  // release's) owns what it changed the bytes (or mode) of, or took out. A commit of no run that changes such a file takes it, unless it
  // changes its status lines alone (replayed on what is given back, below). Where the purged run owns a file, the rebuilt tree
  // holds it as the rebuilt parent of the purged run's merge that took it held it (`back`; absent there, absent), so a
  // purge takes off only what the run's revisions put there: never another run's file. `prior`: the file's owner before
  // the purged run took it, whom a given-back workflow.json's entry names again; `entries`: each such workflow's entry
  // in that rebuilt parent's snapshot.
  const owners = new Map<string, string>();
  const back = new Map<string, { file: StoreFile | null; own: StoreFile | null; prior: string | null }>();
  const entries = new Map<string, SnapLearned | undefined>();
  let held = new Map<string, Buffer>();
  let markers = new Set<string>();
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
      for (const line of others.get(one.sha) ?? []) if (keep.has(line)) keep.set(line, keep.get(line)! + 1);
      const run = runOf(one.message);
      const now = new Map(files.flatMap(({ path, mode, body }) => (folderOf(path) ? [[path, Buffer.concat([Buffer.from(`${mode}\0`), body])] as const] : [])));
      // The run markers this commit adds: its merge's own (one a round).
      const added = files.filter(({ path }) => path.startsWith(RUNS_DIR) && !markers.has(path));
      markers = new Set(files.filter(({ path }) => path.startsWith(RUNS_DIR)).map(({ path }) => path));
      // A commit of no run (a person's approve, retire or restore; the host's) that changes a file the purged run owns:
      // a person's commit is a writer for put-back, and a purge never restores over it. A change of the file's `status`
      // and `retired_from` lines alone carries over to what the purge gives back only to make it stricter (statusReplay,
      // from the given-back file's own lines each time: the person's latest decision, where it ranks below them; the
      // purged run's text still goes; a file given back absent stays absent). Any other change makes that commit the
      // file's writer from then on: the purge leaves its copy.
      if (!run) {
        for (const [path, owner] of owners) {
          if (owner !== runId) continue;
          const [was, is] = [held.get(path), now.get(path)];
          if (was && is && was.equals(is)) continue;
          if (!was && !is) continue;
          const given = back.get(path)!;
          const replayed = was && is ? statusReplay(given.own, splitHeld(was), splitHeld(is)) : undefined;
          if (replayed === undefined) owners.delete(path);
          else back.set(path, { ...given, file: replayed });
        }
      }
      if (run) {
        const take = (path: string) => {
          // A file the purged run owns already keeps what it gives back (its rebuilt parent holds that now).
          if (run === runId && owners.get(path) !== runId) {
            const file = tree.find((one) => one.path === path) ?? null;
            back.set(path, { file, own: file, prior: owners.get(path) ?? null });
            const name = folderOf(path)!;
            entries.set(name, landed?.workflows.find((item) => item.name === name));
          }
          owners.set(path, run);
        };
        const lists = added.map(({ body }) => wroteOf(body));
        if (added.length && lists.every((list) => list !== undefined)) {
          for (const path of new Set(lists.flat() as string[])) if (folderOf(path)) take(path);
        } else {
          for (const [path, body] of now) if (!held.get(path)?.equals(body)) take(path);
          for (const path of held.keys()) if (!now.has(path)) take(path);
        }
      }
      held = now;
      const owned = new Map([...owners].filter(([, owner]) => owner === runId).map(([path]) => [path, back.get(path)!] as const));
      const built = rebuilt(one, files, { keep, owned, entries }, runId, { rewritten, changed, tree }, tip, oldBodies);
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
    const files = [...tree.filter(({ path }) => path !== SNAPSHOT_FILE), { path: purgedMarker(runId), mode: "100644" as const, body: markerBody(moved) }, ...(host.snapshot ? [{ path: SNAPSHOT_FILE, mode: "100644" as const, body: Buffer.from(host.snapshot, "utf8") }] : [])];
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
 *  corrections.md with at most `keep`'s count (as it stands at this commit) of copies of each text it names (its first ones), no workflow file named in `gone`, its message scrubbed when it is a merge of `runId`, the paths it changes now set in
 *  `changed`, its snapshot as rewrittenSnapshot rebuilds it on `parent`. `oldBodies` gains the blobs it no longer holds. */
function rebuilt(one: StoreCommit, files: readonly StoreFile[], { keep, owned, entries }: { keep: ReadonlyMap<string, number>; owned: ReadonlyMap<string, { file: StoreFile | null; prior: string | null }>; entries: ReadonlyMap<string, SnapLearned | undefined> }, runId: string, chain: { rewritten: ReadonlyMap<string, string | null>; changed: Map<string, string[]>; tree: readonly StoreFile[] }, parent: string | null, oldBodies: Set<string>) {
  const out: StoreFile[] = [];
  let corrections: { path: string; oid: string; bytes: number } | undefined;
  // The purged run's files given back as they were before its merge took them (none: absent then).
  for (const { file } of owned.values()) if (file) out.push(file);
  for (const file of files) {
    if (file.path === SNAPSHOT_FILE) continue;
    // The purged run's own markers name no path it wrote any more: its merges own nothing in the rewritten history.
    if (file.path.startsWith(RUNS_DIR) && runOfKey(file.path.slice(RUNS_DIR.length)) === runId) {
      if (!file.body.equals(WROTE_NOTHING)) oldBodies.add(blobOid(file.body));
      out.push({ ...file, body: WROTE_NOTHING });
      continue;
    }
    if (owned.has(file.path)) {
      if (!owned.get(file.path)!.file?.body.equals(file.body)) oldBodies.add(blobOid(file.body));
      continue;
    }
    const lines = file.path === CORRECTIONS_FILE ? file.body.toString("utf8").split("\n") : [];
    const seen = new Map<string, number>();
    const left = lines.filter((line) => {
      const most = keep.get(line);
      if (most === undefined) return true;
      seen.set(line, (seen.get(line) ?? 0) + 1);
      return seen.get(line)! <= most;
    });
    if (left.length < lines.length) {
      const text = left.join("\n");
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
  const restored: Restored = { files: new Map([...owned].map(([path, { prior }]) => [path, { owner: prior }])), tree: out, before: entries };
  const snapshot = rewrittenSnapshot(files.find(({ path }) => path === SNAPSHOT_FILE), one, chain.rewritten, chain.changed, runId, corrections, parent, restored);
  const all = sorted([...out, ...(snapshot ? [{ path: SNAPSHOT_FILE, mode: "100644" as const, body: Buffer.from(snapshot.text, "utf8") }] : [])]);
  return {
    files: all,
    snapshot: snapshot?.landed,
    commit: (on: string | null): ChainCommit => ({ parent: on, message: ownMerge ? scrubbedMessage(runId) : one.message, at: secondsOf(one.at), files: all }),
  };
}

/** Where the run markers are (learn/store.ts runMarker), and the body a purged run's markers are rewritten to. */
const RUNS_DIR = runMarker("");
const WROTE_NOTHING = Buffer.from(runMarkerText({ writes: [] }), "utf8");

/** The learned workflow a path is a file of (`workflows/<name>/...`). */
const folderOf = (path: string): string | undefined => {
  const [top, name, ...rest] = path.split("/");
  return top === WORKFLOWS_DIR && name && rest.length ? name : undefined;
};
const sorted = (files: StoreFile[]): StoreFile[] => files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const sameTree = (a: readonly StoreFile[], b: readonly StoreFile[]): boolean => a.length === b.length && a.every((file, i) => file.path === b[i]!.path && file.mode === b[i]!.mode && file.body.equals(b[i]!.body));
/** A file as the walk holds it (`<mode>\0<bytes>`): its mode and its bytes. */
const splitHeld = (held: Buffer): { mode: string; body: Buffer } => {
  const at = held.indexOf(0);
  return { mode: held.subarray(0, at).toString("utf8"), body: held.subarray(at + 1) };
};

/** How served a README's status is: a person's decision carries over a purge only to rank lower (stricter). */
const RANK = { retired: 0, pending: 1, active: 2 } as const;
/** What a purge gives back for a file the purged run owns, after a commit of no run changed it from `was` to `is`, where
 *  `given` is the file as the purge gives it back on its own: when the change is of its `status` and `retired_from`
 *  lines alone (statusFree reads both the same), `given` with `is`'s status lines in place of its own (withStatusOf)
 *  when `is`'s status ranks below `given`'s (active > pending > retired), so a purge never makes a text more served than
 *  its own record; otherwise, or when that reads no way (a README that reads no way reads retired, so nothing is given
 *  to a run), `given` as it is; null when nothing is given back (the purged run wrote it new: it stays absent).
 *  Undefined for any other change: that commit is the file's writer from then on. */
function statusReplay(given: StoreFile | null, was: { mode: string; body: Buffer }, is: { mode: string; body: Buffer }): StoreFile | null | undefined {
  if (was.mode !== is.mode) return undefined;
  const after = is.body.toString("utf8");
  const free = statusFree(after);
  if (free === undefined || free !== statusFree(was.body.toString("utf8"))) return undefined;
  if (!given) return null;
  const own = given.body.toString("utf8");
  if (RANK[learnedStatus(after)] >= RANK[learnedStatus(own)]) return given;
  const replayed = withStatusOf(own, after);
  return replayed === undefined ? given : { ...given, body: Buffer.from(replayed, "utf8") };
}
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
