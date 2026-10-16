// A replay's writer, and the one reader of a run's store. `writeReplay` writes the static layout that page/source.js's
// `staticSource` reads (see there for the layout); the playground's sync and this example's tests write a replay the
// same way, and the site computes nothing itself. Per run it reads the rows from the run's store (an exported store, or
// a released run's own `store/run.sqlite`) through `readRunEntries` and the timeline module, and the files from a
// recording's manifest or from what it is given. The runs server reads a released run's store with the same function.
// A replay acts on nothing and shows no live browser: every summary and run is written with `live: false` and no live
// view, whose address is a full-control token.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SECRET_KINDS } from "@parcha/pi-durable-agent/export";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { RUN_ID, safePath } from "./page/source.js";

/** Open a store read-only, run `read` on it, close it. node:sqlite loads on first use. */
async function readOnly(storePath, read) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The entries of a run's store, as pi committed them: the first conversation's (the root's), in order. Read-only. */
export function readRunEntries(storePath) {
  return readOnly(storePath, (db) => {
    const conversation = db.prepare("SELECT MIN(conversation_id) AS id FROM entries").get()?.id;
    return conversation == null ? [] : [...db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id").iterate(conversation)].map((row) => JSON.parse(row.record));
  });
}

/** The kinds of the documents a store holds that no export may carry (pi-durable-agent's SECRET_KINDS). Read-only. */
export function secretKindsIn(storePath) {
  return readOnly(storePath, (db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get()) return [];
    const kinds = db.prepare("SELECT DISTINCT kind FROM documents").all().map(({ kind }) => {
      try {
        return JSON.parse(kind);
      } catch {
        return kind;
      }
    });
    return kinds.filter((kind) => SECRET_KINDS.includes(kind));
  });
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * A recording's files for its replay: the manifest's result blob as `result.<ext>` and its job blob as `job.<ext>`, out of
 * the recording's `blobs/`, each checked against its SHA-256 name. Nothing else: no frame, screenshot or evidence blob.
 * The job blob names the job's input files; a recording does not keep their contents. Its `job` is the job blob parsed
 * (`{ workflow, input, files }`), so a replay can show the input the run was given; a job blob that is not JSON is refused.
 */
export async function recordingFiles(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "agentrun.recording/1") throw new Error(`${manifestPath} is not an agentrun.recording/1 manifest`);
  const blobs = join(dirname(manifestPath), "blobs");
  const names = await readdir(blobs).catch(() => []);
  const files = {};
  let job;
  for (const [name, ref] of [["result", manifest.result], ["job", manifest.job]]) {
    if (!ref) continue;
    if (!HASH.test(ref.blob ?? "")) throw new Error(`${manifestPath}: the ${name} blob is not a SHA-256`);
    const found = names.filter((file) => file.startsWith(`${ref.blob}.`) && /^\.[a-z0-9]+$/.test(file.slice(64)));
    if (found.length !== 1) throw new Error(`${manifestPath}: the ${name} blob ${ref.blob} is not in blobs/ once`);
    const bytes = await readFile(join(blobs, found[0]));
    if (createHash("sha256").update(bytes).digest("hex") !== ref.blob) throw new Error(`${manifestPath}: the ${name} blob does not match its SHA-256`);
    files[`${name}${found[0].slice(64)}`] = bytes;
    if (name === "job") {
      try {
        job = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error(`${manifestPath}: the job blob is not JSON`);
      }
      if (job === null || typeof job !== "object" || Array.isArray(job)) throw new Error(`${manifestPath}: the job blob is not a JSON object`);
    }
  }
  return { manifest, files, job };
}

/** A directory's files as path -> bytes: no dotfile, no symlink, nothing outside it. */
async function filesOf(dir, base = dir, out = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) await filesOf(at, base, out);
    else if (entry.isFile()) out[relative(base, at).split(sep).join("/")] = await readFile(at);
  }
  return out;
}

/**
 * @typedef {object} ReplayRun
 * @property {string} [id] the run's id (default: `summary.id`)
 * @property {string} [store] the run's store: an exported one, or a released run's own; its rows are read here
 * @property {object[]} [rows] ready rows in place of a store (tests)
 * @property {string} [manifest] a recording's manifest.json: the run's files and, unless the summary says, its title,
 *   times and cost; a cost only when its `providers` is "real", else none (null), and its usage rows then count model
 *   requests with no dollar figure
 * @property {string | Record<string, string | Uint8Array>} [files] without a manifest: a directory, or path -> content
 * @property {Partial<import("./page/source.js").RunSummary>} [summary] fields over the ones the replay works out
 * @property {Partial<import("./page/source.js").Run>} [run] as the run page heads it (default: the summary, and the
 *   recording's job `input` when its manifest has a job blob)
 */

/** A usage row with no dollar figure: what a replay shows when its run's cost is not known to be real. */
function countOnly(row) {
  if (row.kind !== "usage") return row;
  const requests = row.usage?.requests ?? 0;
  return { ...row, summary: `${requests} model request${requests === 1 ? "" : "s"}`, usage: { ...row.usage, usd: null } };
}

/** What a replay never carries: a live run's view and its state of the moment. */
function released(summary) {
  const { liveView: _view, liveNote: _note, busy: _busy, wakeAt: _wake, error: _error, ...kept } = summary;
  return { ...kept, live: false, liveView: null };
}

/** One run, read and checked: its rows and files, and its summary, worked out from them and the manifest, under the
 *  fields it was given. */
async function readRun(input) {
  const id = input.id ?? input.summary?.id;
  if (typeof id !== "string" || !RUN_ID.test(id)) throw new Error(`a replay run id must match ${RUN_ID}, not ${JSON.stringify(id)}`);
  if (input.run?.id !== undefined && input.run.id !== id) throw new Error(`the run ${id} has a run record for ${JSON.stringify(input.run.id)}`);
  if (input.summary?.id !== undefined && input.summary.id !== id) throw new Error(`the run ${id} has a summary for ${JSON.stringify(input.summary.id)}`);
  if ((input.store === undefined) === (input.rows === undefined)) throw new Error(`the run ${id} needs a store or ready rows, and not both`);
  let rows = input.rows;
  if (input.store !== undefined) {
    const secret = await secretKindsIn(input.store);
    if (secret.length) throw new Error(`the run ${id}'s store is not exported: it holds ${secret.join(", ")}, which no replay may carry. Export the run first.`);
    rows = timelineOf(await readRunEntries(input.store), { settled: true });
  }
  if (!Array.isArray(rows)) throw new Error(`the run ${id} has no rows`);
  const recording = input.manifest ? await recordingFiles(input.manifest) : null;
  const files = recording ? recording.files : typeof input.files === "string" ? await filesOf(input.files) : (input.files ?? {});
  for (const path of Object.keys(files)) {
    if (!safePath(path)) throw new Error(`the run ${id} has a file path a replay cannot hold: ${JSON.stringify(path)}`);
  }
  const paths = Object.keys(files);
  const clash = paths.find((path) => paths.some((other) => other.startsWith(`${path}/`)));
  if (clash) throw new Error(`the run ${id} has ${JSON.stringify(clash)} as a file and as a directory`);
  const m = recording?.manifest;
  const first = rows.find((r) => r.kind === "user_message");
  const summary = released({
    id,
    title: m?.title ?? String(first?.text ?? first?.summary ?? id).slice(0, 80),
    status: "done",
    state: "idle",
    startedAt: m?.recorded?.started ?? rows[0]?.timestamp ?? new Date(0).toISOString(),
    endedAt: m?.recorded?.ended ?? rows.at(-1)?.timestamp ?? null,
    // A dollar figure only for a recording whose every priced part called a real provider (its manifest's `providers`).
    costUsd: m?.providers === "real" ? (m.cost?.usd ?? null) : null,
    ...input.summary,
  });
  const given = recording?.job?.input;
  return { id, rows: summary.costUsd == null ? rows.map(countOnly) : rows, files, summary, run: released({ ...summary, ...(given == null ? {} : { input: given }), ...input.run }) };
}

/**
 * Write `runs` as a replay under `outDir`, replacing what a replay there held (its `runs.json` and `runs/`). Every run
 * is read and checked, and every path of the replay laid out, before anything on disk is touched, and nothing is
 * written when one is refused: a run id a run page could not ask for, a summary or run record for another id, a store
 * that is not exported (it holds a sign-in, a lease, a binding or an alias), a file path that is absolute, leaves the
 * run's files (`..`), is a dotfile or names a directory twice, and two runs whose paths collide (ids `a` and `a.json`:
 * `runs/a.json` as a file and a directory). The replay is written beside `outDir` and swapped in, so a failure leaves
 * the replay that was there whole.
 * @param {string} outDir
 * @param {ReplayRun[]} runs
 */
export async function writeReplay(outDir, runs) {
  const read = [];
  for (const input of runs) {
    const run = await readRun(input);
    if (read.some((other) => other.id === run.id)) throw new Error(`the run ${run.id} is in the replay twice`);
    read.push(run);
  }
  const summaries = read.map((run) => run.summary).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const out = new Map([["runs.json", `${JSON.stringify({ version: 1, runs: summaries })}\n`]]);
  for (const { id, rows, files, run } of read) {
    out.set(`runs/${id}.json`, `${JSON.stringify(run)}\n`);
    out.set(`runs/${id}/timeline.json`, `${JSON.stringify(rows)}\n`);
    const listed = Object.entries(files).map(([path, content]) => ({ path, size: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength })).sort((a, b) => a.path.localeCompare(b.path));
    out.set(`runs/${id}/files.json`, `${JSON.stringify(listed)}\n`);
    for (const [path, content] of Object.entries(files)) out.set(`runs/${id}/files/${path}`, content);
  }
  const dirs = new Set([...out.keys()].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const clash = [...out.keys()].find((path) => dirs.has(path));
  if (clash) throw new Error(`the replay would hold ${clash} as a file and as a directory: two runs name the same path (a run id and another run's file, as "a" and "a.json"). Nothing was written.`);

  const root = resolve(outDir);
  await mkdir(dirname(root), { recursive: true });
  const next = await mkdtemp(join(dirname(root), `.${basename(root)}.next-`));
  try {
    await mkdir(join(next, "runs"));
    for (const [path, content] of out) {
      const at = resolve(next, ...path.split("/"));
      const rel = relative(next, at);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is outside the replay`);
      await mkdir(dirname(at), { recursive: true });
      await writeFile(at, content);
    }
    await mkdir(root, { recursive: true });
    const old = join(next, "old-runs");
    const hadRuns = await rename(join(root, "runs"), old).then(() => true, (error) => (error.code === "ENOENT" ? false : Promise.reject(error)));
    try {
      await rename(join(next, "runs"), join(root, "runs"));
      await rename(join(next, "runs.json"), join(root, "runs.json"));
    } catch (error) {
      await rm(join(root, "runs"), { recursive: true, force: true });
      if (hadRuns) await rename(old, join(root, "runs"));
      throw error;
    }
  } finally {
    await rm(next, { recursive: true, force: true });
  }
}
