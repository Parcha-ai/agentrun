// The harvest: what a run left in its working copy of the agent's learning repository becomes one commit on
// `runs/<run id>`, built by the host from the files alone. The tree is the seed's, with the layout's paths as they are on
// disk: what the agent wrote or changed, and a seed file under those paths gone from disk as a deletion. Everything else
// is left out and reported: a symlink (never followed), a path outside what a run may write, a file over its cap, and the
// agent's own `.git`, which is never read or run, so nothing the agent committed or configured counts. The memo's front
// matter is the host's facts; its sections are the agent's. The commit is dated the run's end, with a fixed message and
// the run's `Run-Id`, so a harvest again, on any host, is the same commit.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CAPS, isHostOwned, isLocked, placeOf, RUN_ID } from "@parcha/agentrun-learn";
import type { Repo } from "@parcha/pi-git-remote";

export type HarvestHead = { harness: string; outcome: "completed" | "failed" | "stopped"; costUsd?: number; untrusted?: boolean };
export type HarvestOptions = {
  /** The host's clone of the agent's repository, through the agent's queue. */
  repo: Repo;
  runId: string;
  /** The commit the run was seeded from. */
  seed: string;
  /** The run's working copy. */
  dir: string;
  /** The run's end: the commit's date. */
  date: Date;
  head: HarvestHead;
  /** Values no harvested file may hold (this host's secrets, the run's input): one that does refuses the whole harvest,
   *  and nothing is committed or pushed. */
  refuse?: readonly string[];
};
export type Ignored = { path: string; reason: string };
export type HarvestResult = { status: "proposed" | "already" | "empty" | "refused"; sha?: string; deleted: string[]; ignored: Ignored[]; refused?: string[] };

export const HARVEST_MESSAGE = "harvest: the run's learning";

/** Whether a run may write `path`: a place in the layout, never locked or the host's, and a memo only as its own. */
function writable(path: string, runId: string): boolean {
  const place = placeOf(path);
  if (!place || place.kind === "uses" || (place.kind === "memo" && place.id !== runId)) return false;
  return !isLocked(path) && !isHostOwned(path);
}

const capOf = (path: string): number => {
  const kind = placeOf(path)?.kind;
  return kind === "note" ? CAPS.note : kind === "index" ? CAPS.index : kind === "memo" ? CAPS.memo : CAPS.file;
};

/** The file at `full`, read without following a link: undefined when it is not a regular file by then. */
async function readRegular(full: string, cap: number): Promise<Buffer | "over" | undefined> {
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > cap) return "over";
    const bytes = await handle.readFile();
    return bytes.length > cap ? "over" : bytes;
  } finally {
    await handle.close();
  }
}

/** The memo with the host's front matter in place of whatever the agent's file opens with. */
function withHostHead(text: string, runId: string, seed: string, head: HarvestHead): string {
  const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text) ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : text;
  const lines = [`run: ${runId}`, `base: ${seed}`, `harness: ${head.harness}`, `outcome: ${head.outcome}`];
  if (typeof head.costUsd === "number" && Number.isFinite(head.costUsd) && head.costUsd >= 0) lines.push(`cost_usd: ${head.costUsd}`);
  if (typeof head.untrusted === "boolean") lines.push(`untrusted: ${head.untrusted}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export async function harvestWorktree(options: HarvestOptions): Promise<HarvestResult> {
  const { repo, runId, seed, dir, date, head } = options;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("the run id is not one the learning layout accepts");
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("the harvest's date must be a valid Date");
  const ignored: Ignored[] = [];
  const found = new Map<string, Buffer>();
  // The directories read whole: a seed file is deleted only when its own directory was read and it was not there.
  const read = new Set<string>();
  const root = await lstat(dir).catch(() => undefined);
  if (!root?.isDirectory()) throw new Error(`no working copy at the run's ${dir}: nothing is harvested`);
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch (error) {
      // A directory gone since its parent listed it holds nothing to read and deletes nothing; one that cannot be read
      // stops the harvest, since what is in it is unknown.
      if (rel && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(rel ? `the working copy's ${rel} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}): nothing is harvested` : `no working copy at the run's ${dir}: nothing is harvested`);
    }
    read.add(rel);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && entry.name === ".git") {
        ignored.push({ path, reason: "the agent's own git directory: never read or run" });
        continue;
      }
      const stat = await lstat(join(dir, path)).catch(() => undefined);
      if (!stat) continue;
      if (stat.isSymbolicLink()) ignored.push({ path, reason: "a symbolic link: never followed" });
      else if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile()) ignored.push({ path, reason: "not a regular file" });
      else if (!writable(path, runId)) ignored.push({ path, reason: "outside the layout a run may write" });
      else {
        const bytes = await readRegular(join(dir, path), capOf(path));
        if (bytes === "over") ignored.push({ path, reason: "over its size cap" });
        else if (bytes === undefined) ignored.push({ path, reason: "not a regular file when read" });
        else found.set(path, bytes);
      }
    }
  };
  await walk("");
  const files: Record<string, Uint8Array | string | null> = {};
  for (const [path, bytes] of found) files[path] = path === `memos/${runId}.md` ? withHostHead(bytes.toString("utf8"), runId, seed, head) : new Uint8Array(bytes);
  // A seed file the run may write that is gone from disk: deleted. One still there but left out (a link in its place) stays.
  const deleted: string[] = [];
  const left = new Set(ignored.map((i) => i.path));
  for (const entry of await repo.list("", seed)) {
    if (entry.type !== "blob" || !writable(entry.path, runId) || found.has(entry.path) || left.has(entry.path)) continue;
    const parent = dirname(entry.path);
    if (!read.has(parent === "." ? "" : parent)) continue;
    files[entry.path] = null;
    deleted.push(entry.path);
  }
  // A refused value is named by the file that holds it, never quoted.
  const values = (options.refuse ?? []).filter((value) => typeof value === "string" && value.trim() !== "");
  const holding = values.length ? Object.entries(files).filter(([, content]) => content !== null && values.some((value) => Buffer.from(content).includes(value))).map(([path]) => path) : [];
  if (holding.length) return { status: "refused", deleted: [], ignored, refused: holding.map((path) => `${path} holds a value no learning may keep`) };
  const branch = `runs/${runId}`;
  const sorted = Object.fromEntries(Object.keys(files).sort().map((path) => [path, files[path]!]));
  const made = await repo.commitTo(branch, { files: sorted, message: HARVEST_MESSAGE, trailers: { "Run-Id": runId }, parent: seed, date });
  if (!made.created && made.sha === (await repo.resolve(seed))) return { status: "empty", deleted: [], ignored };
  await repo.push(made.sha, branch);
  return { status: made.created ? "proposed" : "already", sha: made.sha, deleted, ignored };
}
