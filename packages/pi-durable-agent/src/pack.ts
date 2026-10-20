import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, readdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectForExport } from "./export.js";
import { AGENT_STORE_FILE, type AgentHome, type AgentHomeState, homeDir, readState, sha256 } from "./home.js";
import { DefinitionDoc, IdentityDoc, PromptsDoc, put, RunsDoc, SkillsDoc, SourceDoc } from "./kinds.js";
import {
  byName, documentKinds, type HomeManifest, invalid, isRunId, iso, MANIFEST_LIMIT, MAX_MEMBERS, memberProblem, PACK_FORMAT, refused, safeSegment, secretIn, SIDE_FILES, SQLITE_MAGIC,
} from "./pack-shared.js";
import { runPaths } from "./runs.js";
import { AgentHomeError, openStore, withHome } from "./store.js";
import { copyRange, readAt, tarSize, type TarEntry, writeTar } from "./tar.js";
import { readPack } from "./unpack.js";

export type PackOptions = {
  /** The file to write. */
  out: string;
  /** Refuse (`too_large`) before writing a pack over this many bytes. */
  maxBytes?: number;
  /** Refuse (`too_large`) a pack of more members than this; the reader's limit is 200,000 by default. */
  maxMembers?: number;
  /** Write a redacted copy of the run store at `storePath` to `outPath`. Without it no run store travels. */
  exportRunStore?: (storePath: string, outPath: string) => Promise<void>;
  now?: number;
  /** @internal Called just before a work file is opened, once when the pack is planned and once when it is written. */
  beforeOpen?: (file: string, phase: "plan" | "write") => void | Promise<void>;
};

/** A file the pack left out, and why. */
export type Skipped = { path: string; reason: string };

/** A new agent store holding only what a pack may carry, then VACUUM INTO one clean file: no -wal or -shm, no free
 *  page with an old row in it. Nothing is copied from the live file. */
async function buildAgentStore(state: AgentHomeState, scratch: string): Promise<string> {
  const built = path.join(scratch, "agent.build.sqlite");
  const store = await openStore(built);
  try {
    await store.session.commit(async (tx) => {
      const write = async (kind: string, value: object, doc: () => Promise<Parameters<typeof put>[0]>) => {
        const projected = projectForExport(kind, JSON.parse(JSON.stringify(value)));
        if (projected !== undefined) put(await doc(), projected as object);
      };
      await write("agent.identity", state.identity, () => tx.doc(IdentityDoc));
      await write("agent.definition", state.definition, () => tx.doc(DefinitionDoc));
      if (state.source) await write("agent.source", state.source, () => tx.doc(SourceDoc));
      for (const [key, skill] of Object.entries(state.skills)) await write("agent.skills", skill, () => tx.doc(SkillsDoc, key, null));
      for (const [key, prompt] of Object.entries(state.prompts)) await write("agent.prompts", prompt, () => tx.doc(PromptsDoc, key, null));
      for (const [key, run] of Object.entries(state.runs)) await write("agent.runs", run, () => tx.doc(RunsDoc, key, null));
    }, BACKGROUND_CONTEXT);
  } finally {
    await store.close();
  }
  const clean = path.join(scratch, AGENT_STORE_FILE);
  const db = new DatabaseSync(built);
  try {
    db.prepare("VACUUM INTO ?").run(clean);
  } finally {
    db.close();
  }
  return clean;
}

type Item = { path: string; abs: string; kind: "file" | "dir"; size: number; mode: number; dev: bigint; ino: bigint };
const overLimit = () => new AgentHomeError("too_large", "the pack would hold more members than the limit");
const unreadable = (rel: string, error: unknown) => refused(`${rel} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}), so the pack would hold less than the run has`);

/** The regular files and directories under a run's work directory, in order, as the reader would accept them. What the
 *  reader would refuse (a name it does not hold, a link, a hard link, a device) is `skipped` with the reason. A
 *  directory that cannot be read fails the pack: it is never taken for an empty one. */
async function walkWork(root: string, prefix: string, found: Item[], skipped: Skipped[], room: { left: number }): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(root)).sort(byName);
  } catch (error) {
    throw unreadable(prefix, error);
  }
  for (const name of names) {
    const rel = `${prefix}/${name}`;
    const abs = path.join(root, name);
    let info;
    try {
      info = await lstat(abs, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadable(rel, error);
      skipped.push({ path: rel, reason: "it was removed while the pack was planned" });
      continue;
    }
    const kind = info.isDirectory() ? "dir" : "file";
    const why = !safeSegment(name) ? 'its name starts with "." or holds a character a pack does not carry' : memberProblem(rel, kind);
    if (why) skipped.push({ path: rel, reason: why });
    else if (info.isSymbolicLink()) skipped.push({ path: rel, reason: "it is a symbolic link" });
    else if (info.isDirectory()) {
      if (--room.left < 0) throw overLimit();
      found.push({ path: rel, abs, kind: "dir", size: 0, mode: 0o755, dev: info.dev, ino: info.ino });
      await walkWork(abs, rel, found, skipped, room);
    } else if (!info.isFile()) skipped.push({ path: rel, reason: "it is not a regular file" });
    else if (info.nlink !== 1n) skipped.push({ path: rel, reason: "it is a hard link" });
    else {
      if (--room.left < 0) throw overLimit();
      found.push({ path: rel, abs, kind: "file", size: Number(info.size), mode: Number(info.mode) & 0o111 ? 0o755 : 0o644, dev: info.dev, ino: info.ino });
    }
  }
}

class Changed extends Error {}

/** Open a work file that was listed with `item`'s identity, without following a link: the file must be the same one
 *  (device, inode, size), alone, and its resolved path must be inside the run's work directory. A parent directory
 *  swapped for a link, or the file for one, is caught here and not at the read. */
async function openListed(item: Item, workReal: string): Promise<FileHandle> {
  const linux = process.platform === "linux";
  const before = linux ? undefined : await realpath(item.abs).catch(() => undefined);
  let handle: FileHandle;
  try {
    handle = await open(item.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Changed(`it could not be opened without following a link (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.dev !== item.dev || info.ino !== item.ino || Number(info.size) !== item.size) throw new Changed("it is not the file that was listed");
    const where = linux ? await readlink(`/proc/self/fd/${handle.fd}`) : await realpath(item.abs).catch(() => "");
    if (!linux && where !== before) throw new Changed("its path moved while it was opened");
    if (where !== workReal && !where.startsWith(`${workReal}${path.sep}`)) throw new Changed("it resolves outside the run's work directory");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Refuse a SQLite file that holds a sign-in kind or has a side file beside it. `needStore`: it must be a pi-durable store. */
function refuseUnclean(file: string, label: string, needStore: boolean): void {
  for (const suffix of SIDE_FILES) if (existsSync(`${file}${suffix}`)) throw refused(`${label} has a ${suffix} file beside it: close the database first`);
  let kinds: string[] | undefined;
  try {
    kinds = documentKinds(file);
  } catch (error) {
    throw refused(`${label} is not a readable SQLite database (${(error as Error).message})`);
  }
  if (needStore && kinds === undefined) throw refused(`${label} is not a pi-durable store`);
  const secret = secretIn(kinds);
  if (secret) throw refused(`${label} holds ${secret} documents, which never travel`);
}

/**
 * Write the pack of `home` to `options.out`: a tar of the members of the allowlist and nothing else, in a fixed order,
 * the manifest first. The home is read under its owner lock. A run that is still live travels as its index entry only.
 * Run stores travel only through `exportRunStore`; without it they are left out. Work files are regular files whose
 * names do not start with "."; whatever the reader would refuse (a link, a hard link, a name it does not hold, a file
 * named `.sqlite` that is not a database, a file swapped for a link while the pack was planned) is `skipped` with its
 * reason. A work directory that cannot be read fails the pack. Before it is published the pack is read back with
 * `readPack`, and a pack its own reader refuses is not written.
 */
export async function packHome(home: AgentHome, options: PackOptions): Promise<{ manifest: HomeManifest; skipped: Skipped[] }> {
  if (typeof options?.out !== "string" || options.out === "") throw invalid("out is not a path");
  if (options.maxBytes !== undefined && !(Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0)) throw invalid("maxBytes is not a positive integer");
  if (options.maxMembers !== undefined && !(Number.isSafeInteger(options.maxMembers) && options.maxMembers > 0)) throw invalid("maxMembers is not a positive integer");
  const dir = homeDir(home.dir);
  const now = options.now ?? Date.now();
  const maxMembers = options.maxMembers ?? MAX_MEMBERS;
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-pack-"));
  try {
    return await withHome(dir, async () => {
      const store = await openStore(path.join(dir, AGENT_STORE_FILE));
      let state: AgentHomeState;
      try { state = await readState(store); } finally { await store.close(); }
      const agentFile = await buildAgentStore(state, scratch);
      refuseUnclean(agentFile, AGENT_STORE_FILE, true);

      const skipped: Skipped[] = [];
      const entries: TarEntry[] = [];
      const room = { left: maxMembers - 2 };
      const mtime = Math.floor(now / 1000);
      const add = (entry: Omit<TarEntry, "mtime">) => entries.push({ ...entry, mtime });
      const runIds = Object.keys(state.runs).sort(byName);
      const live = runIds.filter((id) => state.runs[id]!.endedAt === undefined).length;
      add({ name: AGENT_STORE_FILE, kind: "file", size: (await stat(agentFile)).size, mode: 0o644, source: agentFile });
      for (const id of runIds) {
        if (state.runs[id]!.endedAt === undefined || !isRunId(id)) continue;
        const paths = runPaths(home, id);
        if (options.exportRunStore && existsSync(paths.storePath)) {
          const exported = path.join(scratch, `run-${runIds.indexOf(id)}.sqlite`);
          await options.exportRunStore(paths.storePath, exported);
          refuseUnclean(exported, `the exported store of run ${id}`, true);
          if (--room.left < 0) throw overLimit();
          add({ name: `runs/${id}/store/run.sqlite`, kind: "file", size: (await stat(exported)).size, mode: 0o644, source: exported });
        }
        const work = await lstat(paths.workspace).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw unreadable(`runs/${id}/work`, error);
        });
        if (!work?.isDirectory()) continue;
        const workReal = await realpath(paths.workspace);
        if (--room.left < 0) throw overLimit();
        add({ name: `runs/${id}/work`, kind: "dir", size: 0, mode: 0o755 });
        const found: Item[] = [];
        await walkWork(paths.workspace, `runs/${id}/work`, found, skipped, room);
        for (const item of found) {
          if (item.kind === "dir") {
            add({ name: item.path, kind: "dir", size: 0, mode: 0o755 });
            continue;
          }
          let handle: FileHandle;
          try {
            await options.beforeOpen?.(item.abs, "plan");
            handle = await openListed(item, workReal);
          } catch (error) {
            if (!(error instanceof Changed)) throw error;
            skipped.push({ path: item.path, reason: error.message });
            continue;
          }
          try {
            const sqlite = item.size >= SQLITE_MAGIC.length && (await readAt(handle, SQLITE_MAGIC.length, 0)).equals(SQLITE_MAGIC);
            if (!sqlite && item.path.endsWith(".sqlite")) {
              skipped.push({ path: item.path, reason: "it is named .sqlite but is not a SQLite database" });
              continue;
            }
            if (sqlite) {
              for (const suffix of SIDE_FILES) if (existsSync(`${item.abs}${suffix}`)) throw refused(`${item.path} has a ${suffix} file beside it: close the database first`);
              const probe = path.join(scratch, `work-${entries.length}`);
              const out = await open(probe, "wx", 0o600);
              try { await copyRange(handle, 0, item.size, out); } finally { await out.close(); }
              refuseUnclean(probe, item.path, false);
            }
          } finally {
            await handle.close();
          }
          add({
            name: item.path, kind: "file", size: item.size, mode: item.mode,
            open: async () => {
              try {
                await options.beforeOpen?.(item.abs, "write");
                return await openListed(item, workReal);
              } catch (error) {
                if (error instanceof Changed) throw refused(`${item.path} changed while the pack was written: ${error.message}`);
                throw error;
              }
            },
          });
        }
      }

      const manifest: HomeManifest = {
        format: PACK_FORMAT,
        agent_id: state.identity.id,
        definition: state.definition,
        source: state.source ? { sha: state.source.sha, refreshed_at: state.source.refreshedAt } : null,
        skills: Object.keys(state.skills).sort().map((file) => {
          const skill = state.skills[file]!;
          if (sha256(skill.content) !== skill.sha256) throw new AgentHomeError("format", `the skill ${file} does not match its sha256`);
          return { path: file, sha256: skill.sha256, size_bytes: Buffer.byteLength(skill.content) };
        }),
        sign_ins: Object.keys(state.profiles).sort().map((key) => ({ key, provider: state.profiles[key]!.provider })),
        vault: [],
        runs: { count: runIds.length, live },
        size_bytes: 0,
        created_at: iso(now),
      };
      const manifestEntry = (): TarEntry => {
        const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        if (data.length > MANIFEST_LIMIT) throw new AgentHomeError("too_large", `manifest.json would be ${data.length} bytes, over the limit of ${MANIFEST_LIMIT}`);
        return { name: "manifest.json", kind: "file", size: data.length, mode: 0o644, mtime, data };
      };
      for (let round = 0; round < 8; round++) {
        const size = tarSize([manifestEntry(), ...entries]);
        if (size === manifest.size_bytes) break;
        manifest.size_bytes = size;
      }
      if (options.maxBytes !== undefined && manifest.size_bytes > options.maxBytes) {
        throw new AgentHomeError("too_large", `the pack would be ${manifest.size_bytes} bytes, over the limit of ${options.maxBytes}`);
      }
      const part = `${options.out}.part-${randomBytes(4).toString("hex")}`;
      try {
        await writeTar(part, [manifestEntry(), ...entries]);
        const verdict = await readPack(part, { maxBytes: options.maxBytes, maxMembers });
        if (!verdict.ok) {
          const failed = verdict.checks.filter((check) => check.status === "fail");
          throw new AgentHomeError("check", `the pack was not written, because its own reader refuses it: ${failed[0]?.message ?? "it fails a check"}`, { checks: verdict.checks });
        }
        await rename(part, options.out);
      } catch (error) {
        await rm(part, { force: true });
        throw error;
      }
      return { manifest, skipped };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
