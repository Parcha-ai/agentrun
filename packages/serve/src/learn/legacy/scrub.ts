// A run's purge on the learning kept from before learning moved to the store's rows (changes/learning-store-rows.md):
// nothing reads that learning any more, and the purge alone touches it, so DELETE /runs still takes the run's text off
// it as it did before. Two places, each as the purge did then:
//   - the agent's learning folder under the data directory (legacy/folder.ts, the git folder and its script): the run's
//     learned workflows put back as they stood before it, its corrections.md lines dropped, its diff files deleted
//     (forgetRunText). Its merges stay in the folder's git history until the agent's purge deletes the
//     folder whole.
//   - the settings keys learning.grades.<agent> (its grades dropped) and learning.promotions.<agent> (its copies in the
//     promotion records blanked).
// On an Archil disk the run's launch named, the purge deletes the agent's folder there whole (archil-routes.ts
// removeLearningFolder), and an agent's purge removes its folder here and both keys (server.ts forgetAgent), each as
// before. Nothing else of it is removed, and no reader opens it.
import { join } from "node:path";
import { ApiError } from "../../errors.js";
import { purgedRows } from "../../purged-workflow.js";
import { agentFolderOf, serialBy } from "../../server-fs.js";
import type { Settings, Store } from "../../store/index.js";
import { isWorkspaceError, type Workspace } from "../../workspace/index.js";
import { CORRECTIONS_FILE } from "../corrections.js";
import { forgetRunIn } from "../forget-run.js";
import type { Grade, PromotionRecord } from "../promote.js";
import { DIFFS_DIR, folderAt, folderFailure, FolderBusy, FolderMerged, FolderUnreadable, forgetBody, learningRepair, learningWorkspace, readRunDiff, readSnapshot, type RunDiff, writeLearning } from "./folder.js";

/** The legacy settings keys a purge scrubs: the agent's kept grades and its promotion records. */
export const legacyGradesKey = (agentId: string): string => `learning.grades.${agentId}`;
export const legacyPromotionsKey = (agentId: string): string => `learning.promotions.${agentId}`;

const queues = new Map<string, Promise<unknown>>();

/** Run `runId`'s text off agent `agentId`'s legacy learning: its folder under `data` (forgetRunText: a workflow it
 *  changed last goes back to the version before it that no purged run of `store` wrote), in the agent's queue, then its
 *  copies in the legacy settings keys. A folder that can't be read or written now is 503 unavailable (the next DELETE
 *  does it again); a folder never made is no work. */
export async function forgetLegacyRunLearning(data: string, agentId: string, runId: string, store: Pick<Store, "runs" | "settings">): Promise<void> {
  const repo = join(agentFolderOf(data, agentId), "learning");
  await serialBy(queues, repo, async () => {
    const { workspace: ws, end } = learningWorkspace({ mode: "local", agentId, data });
    try {
      await forgetRunText(ws, runId, async (run) => (await purgedRows(store, [run])).has(run));
    } catch (error) {
      if (isWorkspaceError(error, "NOT_FOUND")) return;
      if (error instanceof FolderBusy) throw new ApiError("unavailable", error.message);
      if (error instanceof FolderUnreadable) throw error.link ? new Error(error.message) : new ApiError("unavailable", error.message);
      throw error;
    } finally {
      await end();
    }
  });
  await forgetLegacyRunCopies(store.settings, agentId, runId);
}

type Kept<T> = { items: T[] };
const itemsOf = <T>(value: unknown): T[] => (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? [...((value as Kept<T>).items)] : []);

/** `key`'s kept list replaced by `update` of it under compare-and-swap, tried again while another write won. */
async function updateKept<T>(settings: Pick<Settings, "get" | "replaceIf">, key: string, update: (items: T[]) => T[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const before = await settings.get(key);
    if (before === undefined || before === null) return;
    const after = { ...(before as object), items: update(itemsOf<T>(before)) };
    if (await settings.replaceIf(key, before, after)) return;
  }
  throw new ApiError("unavailable", `the legacy learning setting ${key} kept changing under the purge: send the DELETE again`);
}

/** What the legacy settings keys copied from run `runId`, gone: its kept grades dropped, its promotion records'
 *  disagreements naming it blanked (forget-run.ts forgetRunIn), each record's decision, numbers and run ids kept. No write
 *  when nothing names it. */
export async function forgetLegacyRunCopies(settings: Pick<Settings, "get" | "replaceIf">, agentId: string, runId: string): Promise<void> {
  if (itemsOf<Grade>(await settings.get(legacyGradesKey(agentId))).some((one) => one?.run === runId)) {
    await updateKept<Grade>(settings, legacyGradesKey(agentId), (items) => items.filter((one) => one?.run !== runId));
  }
  if (itemsOf<PromotionRecord>(await settings.get(legacyPromotionsKey(agentId))).some((one) => forgetRunIn(one, runId) !== one)) {
    await updateKept<PromotionRecord>(settings, legacyPromotionsKey(agentId), (items) => items.map((one) => forgetRunIn(one, runId)));
  }
}

/**
 * Run `runId`'s text taken off the folder's current files, at its purge (agent-delete.ts purgeRun): first its learned
 * workflows (forgetRunWorkflows; `purged`: whether another run is purged), whether or not it left a diff file; then the
 * lines each of its merges added to corrections.md, as its diff file keeps them, dropped from main in one host commit
 * per merge (a line a person edited since is theirs and stays); each other merge's diff that shows such a line as
 * context written without it; then the run's diff files deleted, last, so a call stopped part way finds what it has
 * left to do. Its merges stay in the folder's git history until its agent's purge deletes the
 * folder. Idempotent: each merge's scrub lands once, nothing left to drop makes no commit, and a run with no diff file
 * and no workflow here is no work.
 * `commit`: the host's last commit, when one was made.
 */
export async function forgetRunText(ws: Workspace, runId: string, purged: (run: string) => Promise<boolean>): Promise<{ commit?: string }> {
  let commit = await forgetRunWorkflows(ws, runId, async (run) => run === runId || (await purged(run)));
  const names = await diffNames(ws);
  const own = new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.r\\d+)?\\.json(\\..+)?$`);
  const mine = names.filter((name) => own.test(name));
  if (!mine.length) return commit ? { commit } : {};
  const lines: string[] = [];
  for (const name of mine.filter(isDiffFile)) {
    const added = ((await diffOrNone(ws, name))?.files ?? []).flatMap((file) => (file.path === CORRECTIONS_FILE && "patch" in file ? addedLines(file.patch) : []));
    if (!added.length) continue;
    lines.push(...added);
    // Lands once, by the merge's diff key (the folder's ref for its scrub): a call that stopped after it finds it landed
    // and takes no line again, so another run's same line stays; a merge of the run made since (a purge that stopped
    // before the run's tombstone left it open to a grade) is a key of its own, scrubbed in its turn.
    const done = await writeLearning<string | undefined>(ws, async ({ snapshot, body }) => {
      if (!snapshot?.corrections) return { result: undefined };
      const before = await body(CORRECTIONS_FILE, snapshot.corrections.oid);
      const after = withoutLines(before, added);
      if (after === before) return { result: undefined };
      const write = after ? { writes: [{ path: CORRECTIONS_FILE, text: after }] } : { writes: [], deletes: [CORRECTIONS_FILE] };
      return { result: snapshot.corrections.oid, change: { by: { host: "a purged run's corrections removed" }, purged: name.slice(0, -".json".length), ...write } };
    }).catch((error: unknown) => (error instanceof FolderMerged ? { result: undefined, main: undefined } : Promise.reject(error)));
    if (done.result !== undefined) {
      forgetBody(done.result);
      commit = done.main;
    }
  }
  if (lines.length) {
    const gone = new Set(lines);
    for (const name of names.filter((one) => isDiffFile(one) && !own.test(one))) {
      const diff = await diffOrNone(ws, name);
      if (!diff) continue;
      let changed = false;
      const files = diff.files.map((file) => {
        if (file.path !== CORRECTIONS_FILE || !("patch" in file)) return file;
        const patch = withoutContext(file.patch, gone);
        if (patch === file.patch) return file;
        changed = true;
        return { ...file, patch };
      });
      if (!changed) continue;
      await ws.write(`${DIFFS_DIR}/${name}`, `${JSON.stringify({ ...diff, files })}\n`).catch((error: unknown) => { throw folderFailure(error); });
    }
  }
  for (const name of mine) await ws.remove(`${DIFFS_DIR}/${name}`, { force: true }).catch((error: unknown) => { throw folderFailure(error); });
  return commit ? { commit } : {};
}

/** Each learned workflow on main whose workflow.json run `runId` wrote last (SnapLearned.run, the rule purged-workflow.ts
 *  reads) put back in one host commit as it stood at the newest commit where its writer was no purged run (`purged`,
 *  `runId` among them), every file of its `workflows/<name>/` folder, its writer that run again (the commit's
 *  `Written-By` line: folder.ts writerOf); taken off main whole when the purged runs wrote every version of it. So a
 *  purge takes off main only what purged runs put there, and a version another run wrote, a champion included, stays
 *  served. The commit, or undefined when main holds none of the run's (a repeat finds its own put back, and one another
 *  run wrote since names that run). The snapshot is rebuilt from main first (two execs and a checkout): a merge that
 *  moved main and stopped before its snapshot leaves one that names none of that merge's workflows, and finding no work
 *  commits nothing that would show it stale. One more read-only exec of main's history when the run wrote one, and one
 *  per version put back; either read finding nothing refuses (FolderUnreadable), so no guess takes a folder off. */
async function forgetRunWorkflows(ws: Workspace, runId: string, purged: (run: string) => Promise<boolean>): Promise<string | undefined> {
  if (await readSnapshot(ws)) await learningRepair(ws);
  const done = await writeLearning<boolean>(ws, async ({ snapshot }) => {
    const mine = (snapshot?.workflows ?? []).filter((item) => item.run === runId);
    if (!mine.length) return { result: false };
    // No history read, no guess: a purge that can't tell what came before the run's version refuses (503, sent again
    // later), and never takes the whole folder off main.
    const unread = () => new FolderUnreadable(false, "the learning folder's history at main can't be read, so a purge puts nothing back and takes nothing off: send the DELETE again");
    const history = await folderAt(ws, snapshot!.main);
    if (!history) throw unread();
    const writes: { path: string; text: string }[] = [];
    const deletes: string[] = [];
    const written: Record<string, string | null> = {};
    for (const item of mine) {
      // Newest first: the first writer no purged run is the version to put back, as it stood just before the next
      // writer took the file over.
      const writers = history.writers(item.name);
      let back: { path: string; text: string }[] = [];
      for (let i = 1; i < writers.length; i++) {
        const { run } = writers[i]!;
        if (run !== null && (await purged(run))) continue;
        const before = writers[i - 1]!.before;
        const at = before ? await folderAt(ws, before) : undefined;
        if (!at) throw unread();
        const files = at.snapshot.workflows.find((one) => one.name === item.name)?.files ?? [];
        back = files.map(({ path, oid }) => ({ path, text: at.blobs.get(oid)!.toString("utf8") }));
        // Named even when `back` is main's bytes already, so the writer still moves (folder.ts writtenIn).
        if (back.length) written[item.name] = run;
        break;
      }
      writes.push(...back);
      deletes.push(...[...item.files.map(({ path }) => path), ...(item.links ?? [])].filter((path) => !back.some((file) => file.path === path)));
    }
    const host = writes.length ? "a purged run's workflows put back as they were before it" : "a purged run's workflows removed";
    return { result: true, change: { by: { host, written }, writes, deletes } };
  });
  return done.result ? done.main : undefined;
}

/** The names in the folder's diffs directory; none when it is not there. */
const diffNames = (ws: Workspace): Promise<string[]> =>
  ws.list(DIFFS_DIR).then((entries) => entries.filter((entry) => entry.kind === "file").map((entry) => entry.name), (error: unknown) => (isWorkspaceError(error, "NOT_FOUND") ? [] : Promise.reject(folderFailure(error))));
/** A merge's diff file, `<key>.json`; not one a stopped write left half written (`.json.<suffix>`). */
const isDiffFile = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name);
/** Diff file `name` as readRunDiff reads it, or undefined when it does not read as one: a folder that can't be read
 *  throws. */
const diffOrNone = (ws: Workspace, name: string): Promise<RunDiff | undefined> =>
  readRunDiff(ws, name.slice(0, -".json".length)).catch((error: unknown) => (error instanceof FolderUnreadable ? Promise.reject(error) : undefined));

/** The lines a patch (git's hunks) adds and does not take away: what a merge appended. */
function addedLines(patch: string): string[] {
  const lines = patch.split("\n");
  const taken = new Map<string, number>();
  for (const line of lines) if (line.startsWith("-")) taken.set(line.slice(1), (taken.get(line.slice(1)) ?? 0) + 1);
  return lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).filter((line) => {
    const left = taken.get(line) ?? 0;
    if (left) taken.set(line, left - 1);
    return !left && line.trim() !== "";
  });
}

/** `text` with the last line equal to each of `lines` left out. */
function withoutLines(text: string, lines: readonly string[]): string {
  const kept = text.split("\n");
  for (const line of lines) {
    const at = kept.lastIndexOf(line);
    if (at >= 0) kept.splice(at, 1);
  }
  return kept.join("\n");
}

/** `patch` (git's hunks) with each context line that is one of `gone` left out, a hunk that lost one given the header
 *  of what it keeps: the start moved past the lines it lost at its top (git names the line before when it keeps none
 *  on a side), each count less what it lost. */
function withoutContext(patch: string, gone: ReadonlySet<string>): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  const dropped = (line: string) => line.startsWith(" ") && gone.has(line.slice(1));
  for (let i = 0; i < lines.length;) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]!);
    if (!head) {
      out.push(lines[i++]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@")) end++;
    const body = lines.slice(i + 1, end);
    const kept = body.filter((line) => !dropped(line));
    const lost = body.length - kept.length;
    if (!lost) out.push(lines[i]!, ...body);
    else {
      const top = body.findIndex((line) => !dropped(line));
      const lead = top < 0 ? lost : top;
      const [olds, news] = [Number(head[2] ?? 1) - lost, Number(head[4] ?? 1) - lost];
      const at = (start: string, count: number) => Number(start) + lead - (count ? 0 : 1);
      out.push(`@@ -${at(head[1]!, olds)},${olds} +${at(head[3]!, news)},${news} @@${head[5]}`, ...kept);
    }
    i = end;
  }
  return out.join("\n");
}
