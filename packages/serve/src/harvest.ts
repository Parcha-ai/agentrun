// The harvest: what a run left in its working copy of the agent's learning repository becomes one commit on
// `runs/<run id>`, built by the host from the files alone. The tree is the seed's, with the layout's paths as they are on
// disk: what the agent wrote or changed, and a seed file under those paths gone from disk as a deletion. Everything else
// is left out and reported: a symlink (never followed), a path outside what a run may write, a file over its cap, and the
// agent's own `.git`, which is never read or run, so nothing the agent committed or configured counts. The memo's front
// matter is the host's facts; its sections are the agent's. The commit is dated the run's end, with a fixed message and
// the run's `Run-Id`, so a harvest again, on any host, is the same commit.
import { createHash } from "node:crypto";
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
  /** Values no harvested file or path may hold (this host's secrets, the run's input), as they are or encoded
   *  (`privateFormsOf`): one that does refuses the whole harvest, and nothing is committed or pushed. */
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

/** A value is looked for encoded only from this many bytes on: the base64 or hex of a shorter one is short enough to
 *  turn up in ordinary text. */
export const MIN_ENCODED = 12;

/** The base64 of `bytes` where they start at each of the three offsets in a longer encoded run, each cut to the
 *  characters only `bytes` decide, so a value inside a bigger blob is found whatever comes before or after it. */
function base64Cores(bytes: Buffer): string[] {
  return [0, 1, 2].map((lead) => Buffer.concat([Buffer.alloc(lead), bytes]).toString("base64").slice(Math.ceil((8 * lead) / 6), Math.floor((8 * (lead + bytes.length)) / 6)));
}

/** `bytes` percent-encoded as encodeURIComponent writes a string, lowercased: built from the bytes, so a string no URI
 *  encoder takes (a lone surrogate) never throws. */
const uriComponent = (bytes: Buffer) => [...bytes].map((byte) => (/[A-Za-z0-9\-_.!~*'()]/.test(String.fromCharCode(byte)) && byte < 0x80 ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`)).join("").toLowerCase();

/** How `value` may be written down: `exact` as it is or JSON-escaped; from `MIN_ENCODED` bytes on, `folded` (hex and
 *  percent-encoding, matched in any case) and `base64` (base64 and base64url at every offset, matched with whitespace
 *  taken out, so a wrapped blob is read whole). */
export function privateFormsOf(value: string): { exact: string[]; folded: string[]; base64: string[] } {
  const exact = [...new Set([value, JSON.stringify(value).slice(1, -1)])];
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < MIN_ENCODED) return { exact, folded: [], base64: [] };
  const hex = bytes.toString("hex");
  const folded = [...new Set([hex, hex.replace(/../g, "%$&"), uriComponent(bytes)])];
  const cores = base64Cores(bytes);
  return { exact, folded, base64: [...new Set([...cores, ...cores.map((core) => core.replace(/\+/g, "-").replace(/\//g, "_"))])] };
}

/** Whether `text` holds any form of any of `values`. */
function holdsPrivate(text: Buffer, values: readonly ReturnType<typeof privateFormsOf>[]): boolean {
  if (!values.length) return false;
  const latin = text.toString("latin1");
  const lower = latin.toLowerCase();
  const packed = latin.replace(/\s+/g, "");
  return values.some((forms) => forms.exact.some((form) => text.includes(form)) || forms.folded.some((form) => lower.includes(form)) || forms.base64.some((form) => packed.includes(form)));
}

/** A blob's git id: sha-1, or sha-256 in a repository whose ids are 64 digits. */
const blobId = (bytes: Buffer, idLength: number) => createHash(idLength === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Whether a memo says nothing past its front matter: the stub a run is seeded with, left as it was. */
const blankMemo = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim() === "";

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
  // The seed's files and directories: a path whose kind on disk is the other one would make a tree git cannot hold.
  const seedFiles = (await repo.list("", seed)).filter((entry) => entry.type === "blob");
  const files = new Set(seedFiles.map((entry) => entry.path));
  const dirs = new Set(seedFiles.flatMap((entry) => entry.path.split("/").slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join("/"))));
  const swapped = (path: string, what: string, seedHas: string) => new Error(`the working copy's ${path} is ${what} where the seed has ${seedHas}: nothing is harvested`);
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
      let stat;
      try {
        stat = await lstat(join(dir, path));
      } catch (error) {
        // Gone since its directory listed it: nothing to read. Anything else leaves what is there unknown.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`the working copy's ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}): nothing is harvested`);
      }
      if (stat.isSymbolicLink()) ignored.push({ path, reason: "a symbolic link: never followed" });
      else if (stat.isDirectory() && files.has(path)) throw swapped(path, "a directory", "a file");
      else if (stat.isFile() && dirs.has(path)) throw swapped(path, "a file", "a directory");
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
  const memo = `memos/${runId}.md`;
  const commit: Record<string, Uint8Array | string | null> = {};
  for (const [path, bytes] of found) commit[path] = path === memo ? withHostHead(bytes.toString("utf8"), runId, seed, head) : new Uint8Array(bytes);
  // A seed file the run may write that is gone from disk: deleted. One still there but left out (a link in its place) stays.
  const deleted: string[] = [];
  const left = new Set(ignored.map((i) => i.path));
  for (const entry of seedFiles) {
    if (!writable(entry.path, runId) || found.has(entry.path) || left.has(entry.path)) continue;
    const parent = dirname(entry.path);
    if (!read.has(parent === "." ? "" : parent)) continue;
    commit[entry.path] = null;
    deleted.push(entry.path);
  }
  // The memo stub every run is seeded with proposes nothing alone: a run that changed nothing else has nothing to propose.
  const seedIds = new Map(seedFiles.map((entry) => [entry.path, entry.oid]));
  const changed = deleted.length > 0 || [...found].some(([path, bytes]) => path !== memo && seedIds.get(path) !== blobId(bytes, seedIds.get(path)?.length ?? 40));
  if (!changed && (!found.has(memo) || blankMemo(found.get(memo)!.toString("utf8")))) return { status: "empty", deleted: [], ignored };
  // A refused value is found in every file and every path, a deleted one too, as it is or encoded, and named by the file
  // that holds it, or by a count for a path, never quoted.
  const values = (options.refuse ?? []).filter((value) => typeof value === "string" && value.trim() !== "").map(privateFormsOf);
  const inPaths = Object.keys(commit).filter((path) => holdsPrivate(Buffer.from(path, "utf8"), values));
  const holding = Object.entries(commit)
    .filter(([path, content]) => content !== null && !inPaths.includes(path) && holdsPrivate(Buffer.from(content), values))
    .map(([path]) => `${path} holds a value no learning may keep`);
  if (inPaths.length) holding.push(`${inPaths.length === 1 ? "a path" : `${inPaths.length} paths`} in the harvest ${inPaths.length === 1 ? "holds" : "hold"} a value no learning may keep`);
  if (holding.length) return { status: "refused", deleted: [], ignored, refused: holding };
  const branch = `runs/${runId}`;
  const sorted = Object.fromEntries(Object.keys(commit).sort().map((path) => [path, commit[path]!]));
  const made = await repo.commitTo(branch, { files: sorted, message: HARVEST_MESSAGE, trailers: { "Run-Id": runId }, parent: seed, date });
  if (!made.created && made.sha === (await repo.resolve(seed))) return { status: "empty", deleted: [], ignored };
  await repo.push(made.sha, branch);
  return { status: made.created ? "proposed" : "already", sha: made.sha, deleted, ignored };
}
