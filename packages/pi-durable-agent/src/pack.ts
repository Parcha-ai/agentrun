import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXPORTABLE_KINDS, projectForExport, SECRET_KINDS } from "./export.js";
import { AGENT_STORE_FILE, type AgentHome, type AgentHomeState, checkDefinition, checkSha, homeDir, ID_PATTERN, isSkillPath, openAgentHome, readState, sha256 } from "./home.js";
import {
  AliasesDoc, BindingsDoc, DefinitionDoc, FORMAT_VERSION, IdentityDoc, ProfilesDoc, put, RunsDoc, SkillsDoc, SourceDoc, type AgentDefinition,
} from "./kinds.js";
import { runPaths } from "./runs.js";
import { copyRange, listTar, readAt, tarSize, type TarEntry, type TarMember, writeTar } from "./tar.js";
import { AgentHomeError, type HomeCheck, LOCK_FILE, openStore, withHome } from "./store.js";

export const PACK_FORMAT = `agentrun.home/${FORMAT_VERSION}`;

/** What a pack holds, without its bytes: the first member of every pack. */
export type HomeManifest = {
  format: string;
  agent_id: string;
  definition: AgentDefinition;
  skills: { path: string; sha256: string; size_bytes: number }[];
  /** What the source had. No sign-in travels: the target signs in again. */
  sign_ins: { key: string; provider: string }[];
  vault: { name: string }[];
  runs: { count: number; live: number };
  /** The size of the pack, in bytes. */
  size_bytes: number;
  created_at: string;
  /** The home's `agent.source`, in the contract's names; `null` for a home not tied to a repo. */
  source: { sha: string; refreshed_at: string } | null;
};

export type PackOptions = {
  /** The file to write. */
  out: string;
  /** Refuse (`too_large`) before writing a pack over this many bytes. */
  maxBytes?: number;
  /** Write a redacted copy of the run store at `storePath` to `outPath`. Without it no run store travels. */
  exportRunStore?: (storePath: string, outPath: string) => Promise<void>;
  now?: number;
};

const invalid = (message: string) => new AgentHomeError("invalid", message);
const refused = (message: string) => new AgentHomeError("check", message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (ms: number) => new Date(ms).toISOString();
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const MAX_MEMBERS = 200_000;
const SIDE_FILES = ["-wal", "-shm", "-journal"];
const isRunId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
const LOCK_FILES = [LOCK_FILE, `${LOCK_FILE}-journal`];

/** JSON with sorted keys: one text for one value. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

// --- what a pack may hold -------------------------------------------------------------------------------------------

const safeSegment = (segment: string): boolean =>
  segment !== "" && !segment.startsWith(".") && !/[\\\0\x01-\x1f\x7f]/.test(segment) && Buffer.byteLength(segment) <= 255;

/** Why `name` is not a member a pack may hold, or undefined. The allowlist: the manifest, the agent store, a run's
 *  store, and a run's work directory with the regular files and directories under it whose names do not start with ".". */
function memberProblem(name: string, kind: "file" | "dir"): string | undefined {
  if (Buffer.byteLength(name) > 4096) return "its name is too long";
  if (SIDE_FILES.some((suffix) => name.endsWith(`.sqlite${suffix}`))) return "a SQLite side file is never part of a pack";
  if (kind === "file" && (name === "manifest.json" || name === AGENT_STORE_FILE)) return undefined;
  const parts = name.split("/");
  if (parts[0] !== "runs" || parts.length < 3 || !isRunId(parts[1])) return "it is not a member a home pack holds";
  if (kind === "file" && parts.length === 4 && parts[2] === "store" && parts[3] === "run.sqlite") return undefined;
  if (parts[2] === "work" && parts.slice(3).every(safeSegment) && (kind === "dir" || parts.length > 3)) return undefined;
  return "it is not a member a home pack holds";
}

// --- reading a SQLite file --------------------------------------------------------------------------------------------

/** The store keeps a kind as JSON text (`"agent.runs"`, with its quotes); a file that keeps it bare is read the same. */
function kindName(stored: string): string {
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === "string" ? parsed : stored;
  } catch {
    return stored;
  }
}

/** The document kinds a pi-durable store holds, or undefined when the file has no `documents` table. Reads only. */
function documentKinds(file: string): string[] | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get()) return undefined;
    return (db.prepare("SELECT kind FROM documents GROUP BY kind ORDER BY kind").all() as { kind: string }[]).map((row) => kindName(row.kind));
  } finally {
    db.close();
  }
}

const secretIn = (kinds: string[] | undefined) => kinds?.find((kind) => SECRET_KINDS.includes(kind));

async function startsWithMagic(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    return (await readAt(handle, SQLITE_MAGIC.length, 0)).equals(SQLITE_MAGIC);
  } finally {
    await handle.close();
  }
}

// --- packing ----------------------------------------------------------------------------------------------------------

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

/** The regular files and directories under a run's work directory, sorted, as `[relative path, kind]`; what is not one
 *  of them, or starts with ".", is `skipped`. */
async function walkWork(root: string, prefix: string, found: { path: string; abs: string; kind: "file" | "dir"; size: number; mode: number }[], skipped: string[]): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(root)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return;
  }
  for (const name of names) {
    const rel = `${prefix}/${name}`;
    const abs = path.join(root, name);
    const info = await lstat(abs);
    if (!safeSegment(name) || Buffer.byteLength(rel) > 4096) skipped.push(rel);
    else if (info.isDirectory()) {
      found.push({ path: rel, abs, kind: "dir", size: 0, mode: 0o755 });
      await walkWork(abs, rel, found, skipped);
    } else if (info.isFile() && info.nlink === 1) found.push({ path: rel, abs, kind: "file", size: info.size, mode: info.mode & 0o111 ? 0o755 : 0o644 });
    else skipped.push(rel);
  }
}

/** Refuse a SQLite file that holds a sign-in kind or has a side file beside it. `needStore`: it must be a pi-durable store. */
async function refuseUnclean(file: string, label: string, needStore: boolean): Promise<void> {
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
 * names do not start with "." (symbolic links, hard links and everything else are `skipped`).
 */
export async function packHome(home: AgentHome, options: PackOptions): Promise<{ manifest: HomeManifest; skipped: string[] }> {
  if (typeof options?.out !== "string" || options.out === "") throw invalid("out is not a path");
  if (options.maxBytes !== undefined && !(Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0)) throw invalid("maxBytes is not a positive integer");
  const dir = homeDir(home.dir);
  const now = options.now ?? Date.now();
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-pack-"));
  try {
    return await withHome(dir, async () => {
      const store = await openStore(path.join(dir, AGENT_STORE_FILE));
      let state: AgentHomeState;
      try { state = await readState(store); } finally { await store.close(); }
      const agentFile = await buildAgentStore(state, scratch);
      await refuseUnclean(agentFile, AGENT_STORE_FILE, true);

      const skipped: string[] = [];
      const entries: TarEntry[] = [];
      const mtime = Math.floor(now / 1000);
      const add = (entry: Omit<TarEntry, "mtime">) => entries.push({ ...entry, mtime });
      const runIds = Object.keys(state.runs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const live = runIds.filter((id) => state.runs[id]!.endedAt === undefined).length;
      add({ name: AGENT_STORE_FILE, kind: "file", size: (await stat(agentFile)).size, mode: 0o644, source: agentFile });
      for (const id of runIds) {
        if (state.runs[id]!.endedAt === undefined || !isRunId(id)) continue;
        const paths = runPaths(home, id);
        if (options.exportRunStore && existsSync(paths.storePath)) {
          const exported = path.join(scratch, `run-${runIds.indexOf(id)}.sqlite`);
          await options.exportRunStore(paths.storePath, exported);
          await refuseUnclean(exported, `the exported store of run ${id}`, true);
          add({ name: `runs/${id}/store/run.sqlite`, kind: "file", size: (await stat(exported)).size, mode: 0o644, source: exported });
        }
        const found: Parameters<typeof walkWork>[2] = [];
        if ((await lstat(paths.workspace).catch(() => undefined))?.isDirectory()) {
          add({ name: `runs/${id}/work`, kind: "dir", size: 0, mode: 0o755 });
          await walkWork(paths.workspace, `runs/${id}/work`, found, skipped);
        }
        for (const item of found) {
          if (item.kind === "file" && (await startsWithMagic(item.abs))) {
            const probe = path.join(scratch, `work-${entries.length}`);
            await copyFile(item.abs, probe);
            for (const suffix of SIDE_FILES) if (existsSync(`${item.abs}${suffix}`)) throw refused(`${item.path} has a ${suffix} file beside it: close the database first`);
            await refuseUnclean(probe, item.path, false);
          }
          add({ name: item.path, kind: item.kind, size: item.size, mode: item.mode, source: item.kind === "file" ? item.abs : undefined });
        }
      }

      const manifest: HomeManifest = {
        format: PACK_FORMAT,
        agent_id: state.identity.id,
        definition: state.definition,
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
        source: state.source ? { sha: state.source.sha, refreshed_at: state.source.refreshedAt } : null,
      };
      const manifestEntry = (): TarEntry => {
        const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

// --- reading a pack ---------------------------------------------------------------------------------------------------

type Problem = { check: HomeCheck["name"]; message: string };
type Inspection = { manifest: HomeManifest | null; problems: Problem[]; state?: AgentHomeState; bytes: number };

const HEX64 = /^[0-9a-f]{64}$/;
const TOP_KEYS = ["format", "agent_id", "definition", "skills", "sign_ins", "vault", "runs", "size_bytes", "created_at", "source"];
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The manifest as typed, or the problems with it. A format above this version's is not judged further. */
function readManifest(raw: unknown): { manifest: HomeManifest | null; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (check: Problem["check"], message: string) => void problems.push({ check, message });
  if (!isObject(raw)) return bad("format", "manifest.json is not an object"), { manifest: null, problems };
  const match = typeof raw.format === "string" ? /^agentrun\.home\/(\d+)$/.exec(raw.format) : null;
  if (!match) return bad("format", `the pack's format ${JSON.stringify(raw.format)} is not agentrun.home/N`), { manifest: null, problems };
  if (Number(match[1]) > FORMAT_VERSION) return bad("format", `the pack is ${String(raw.format)}; this version reads ${PACK_FORMAT}`), { manifest: null, problems };
  const extra = Object.keys(raw).filter((key) => !TOP_KEYS.includes(key));
  if (extra.length) bad("format", `manifest.json has fields it does not keep: ${extra.join(", ")}`);
  const skillsOk = Array.isArray(raw.skills) && raw.skills.every((skill) => isObject(skill) && typeof skill.path === "string" && isSkillPath(skill.path) && typeof skill.sha256 === "string" && HEX64.test(skill.sha256) && count(skill.size_bytes));
  if (!skillsOk) bad("format", "manifest.json's skills are not {path, sha256, size_bytes}");
  if (!Array.isArray(raw.sign_ins) || !raw.sign_ins.every((entry) => isObject(entry) && typeof entry.key === "string" && typeof entry.provider === "string")) bad("format", "manifest.json's sign_ins are not {key, provider}");
  if (!Array.isArray(raw.vault) || !raw.vault.every((entry) => isObject(entry) && typeof entry.name === "string" && Object.keys(entry).length === 1)) bad("format", "manifest.json's vault entries are not {name}: never a value");
  if (!isObject(raw.runs) || !count(raw.runs.count) || !count(raw.runs.live) || raw.runs.live > raw.runs.count) bad("format", "manifest.json's runs are not {count, live}");
  if (!count(raw.size_bytes)) bad("format", "manifest.json's size_bytes is not a count");
  if (typeof raw.created_at !== "string" || Number.isNaN(Date.parse(raw.created_at))) bad("format", "manifest.json's created_at is not a timestamp");
  if (raw.source !== null && !(isObject(raw.source) && Object.keys(raw.source).length === 2 && typeof raw.source.sha === "string" && typeof raw.source.refreshed_at === "string" && !Number.isNaN(Date.parse(raw.source.refreshed_at)))) bad("format", "manifest.json's source is not null or {sha, refreshed_at}");
  else if (isObject(raw.source)) try { checkSha(raw.source.sha); } catch { bad("format", "manifest.json's source sha is not a commit sha"); }
  if (typeof raw.agent_id !== "string" || !ID_PATTERN.test(raw.agent_id)) bad("format", "manifest.json's agent_id is not an id: letters, digits, \".\", \"_\" or \"-\", at most 128");
  try {
    checkDefinition(raw.definition as never, String(raw.agent_id));
    if ((raw.definition as { id?: unknown }).id !== raw.agent_id) bad("definition", "the manifest's definition is not the agent's own: its id differs from agent_id");
  } catch (error) {
    bad("definition", `the manifest's definition is refused: ${(error as Error).message}`);
  }
  return { manifest: problems.length ? null : (raw as unknown as HomeManifest), problems };
}

/** Walk the pack: its members, its manifest and its stores. `extractTo` also writes every member but the manifest there,
 *  so what was judged is what was written. Nothing is written beside the pack otherwise except temporary files. */
async function inspectPack(file: string, options: { maxBytes?: number; extractTo?: string } = {}): Promise<Inspection> {
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new AgentHomeError("missing", `${file} does not exist`);
  if (!info.isFile()) throw invalid(`${file} is not a file`);
  const problems: Problem[] = [];
  const bad = (check: Problem["check"], message: string) => void problems.push({ check, message });
  if (options.maxBytes !== undefined && info.size > options.maxBytes) bad("size", `the pack is ${info.size} bytes, over the limit of ${options.maxBytes}`);
  const handle = await open(file, "r");
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-read-"));
  let manifest: HomeManifest | null = null;
  let state: AgentHomeState | undefined;
  try {
    const listed = await listTar(handle, info.size);
    for (const problem of listed.problems) bad("format", problem);
    const members: TarMember[] = listed.members;
    if (members.length > MAX_MEMBERS) bad("format", `the pack has more than ${MAX_MEMBERS} members`);
    const seen = new Set<string>();
    for (const member of members) {
      const why = memberProblem(member.name, member.kind);
      if (why) bad("format", `${member.name}: ${why}`);
      if (seen.has(member.name)) bad("format", `${member.name} appears twice`);
      seen.add(member.name);
    }
    const first = members[0];
    if (!first || first.name !== "manifest.json" || first.kind !== "file") bad("format", "the first member is not manifest.json");
    else if (first.size > MANIFEST_LIMIT) bad("format", "manifest.json is too large");
    else {
      try {
        const read = readManifest(JSON.parse((await readAt(handle, first.size, first.offset)).toString("utf8")));
        manifest = read.manifest;
        problems.push(...read.problems);
      } catch {
        bad("format", "manifest.json is not JSON");
      }
    }
    if (!seen.has(AGENT_STORE_FILE)) bad("format", `the pack has no ${AGENT_STORE_FILE}`);
    if (problems.some((problem) => problem.check !== "size") || !manifest || members.length > MAX_MEMBERS) return { manifest, problems, bytes: info.size };

    let probes = 0;
    const live = new Set<string>();
    for (const member of members) {
      if (member.name === "manifest.json") continue;
      const dest = options.extractTo && path.join(options.extractTo, ...member.name.split("/"));
      if (member.kind === "dir") {
        if (dest) await mkdir(dest, { recursive: true });
        continue;
      }
      let copy: string | undefined;
      const sqlite = member.size >= SQLITE_MAGIC.length && (await readAt(handle, SQLITE_MAGIC.length, member.offset)).equals(SQLITE_MAGIC);
      if (!sqlite && member.name.endsWith(".sqlite")) bad("format", `${member.name} is not a SQLite database`);
      if (sqlite) for (const suffix of SIDE_FILES) if (seen.has(`${member.name}${suffix}`)) bad("format", `${member.name} has a ${suffix} file beside it in the pack`);
      if (dest || sqlite) {
        const target = dest ?? path.join(scratch, `member-${probes++}`);
        await mkdir(path.dirname(target), { recursive: true });
        const out = await open(target, "wx", member.mode & 0o111 ? 0o755 : 0o644);
        try { await copyRange(handle, member.offset, member.size, out); } finally { await out.close(); }
        copy = target;
      }
      if (!sqlite || !copy) continue;
      const probe = dest ? path.join(scratch, `probe-${probes++}`) : copy;
      if (dest) await copyFile(copy, probe);
      let kinds: string[] | undefined;
      try {
        kinds = documentKinds(probe);
      } catch (error) {
        bad("format", `${member.name} is not a readable SQLite database (${(error as Error).message})`);
        continue;
      }
      const secret = secretIn(kinds);
      if (secret) bad("format", `${member.name} holds ${secret} documents, which never travel`);
      if (member.name === AGENT_STORE_FILE || member.name.endsWith("/run.sqlite")) {
        if (kinds === undefined) bad("format", `${member.name} is not a pi-durable store`);
      }
      if (member.name === AGENT_STORE_FILE && kinds) {
        const unknown = kinds.filter((kind) => !EXPORTABLE_KINDS.includes(kind) && !SECRET_KINDS.includes(kind));
        if (unknown.length) bad("format", `${AGENT_STORE_FILE} holds documents of kind ${unknown.join(", ")}, which a pack does not carry`);
        if (!secret && !unknown.length) {
          try {
            const agent = await openStore(probe);
            try { state = await readState(agent); } finally { await agent.close(); }
          } catch (error) {
            bad("format", `${AGENT_STORE_FILE} is not a readable agent store (${(error as Error).message})`);
          }
        }
      }
    }

    if (state) {
      const agent = state;
      if (agent.identity.id !== manifest.agent_id) bad("definition", `the pack is for agent ${manifest.agent_id}, but ${AGENT_STORE_FILE} holds agent ${agent.identity.id}`);
      if (canonical(agent.definition) !== canonical(manifest.definition)) bad("definition", `the manifest's definition is not the one in ${AGENT_STORE_FILE}`);
      const listedSkills = new Map(manifest.skills.map((skill) => [skill.path, skill]));
      const storedSkills = Object.keys(agent.skills);
      if (listedSkills.size !== manifest.skills.length || storedSkills.length !== listedSkills.size || storedSkills.some((key) => !listedSkills.has(key))) {
        bad("definition", `the manifest's skills are not the skills in ${AGENT_STORE_FILE}`);
      }
      for (const key of storedSkills) {
        const skill = agent.skills[key]!;
        const named = listedSkills.get(key);
        if (sha256(skill.content) !== skill.sha256 || (named && (named.sha256 !== skill.sha256 || named.size_bytes !== Buffer.byteLength(skill.content)))) bad("definition", `the skill ${key} does not match its sha256 or size`);
      }
      if (canonical(agent.source ? { sha: agent.source.sha, refreshed_at: agent.source.refreshedAt } : null) !== canonical(manifest.source)) bad("format", "the manifest's source is not the one in agent.sqlite");
      const runs = Object.entries(agent.runs);
      for (const [id, run] of runs) if (run.endedAt === undefined) live.add(id);
      if (manifest.runs.count !== runs.length || manifest.runs.live !== live.size) bad("format", "the manifest's run counts are not the runs in agent.sqlite");
      for (const member of members) {
        const id = member.name.split("/")[1];
        if (!member.name.startsWith("runs/") || id === undefined) continue;
        if (!agent.runs[id]) bad("format", `${member.name} belongs to run ${id}, which the pack's index does not list`);
        else if (live.has(id)) bad("format", `${member.name} belongs to run ${id}, which was live: a live run travels as its index entry only`);
      }
    }
    if (info.size !== manifest.size_bytes) bad("size", `the pack is ${info.size} bytes, not the ${manifest.size_bytes} its manifest says`);
    return { manifest, problems, state, bytes: info.size };
  } finally {
    await handle.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

function checksOf(manifest: HomeManifest | null, problems: Problem[], bytes: number): HomeCheck[] {
  const judge = (name: "format" | "definition" | "size", ok: string): HomeCheck => {
    const own = problems.filter((problem) => problem.check === name);
    if (!own.length) return { name, status: "ok", message: ok };
    return { name, status: "fail", message: own[0]!.message, ...(own.length > 1 ? { detail: { problems: own.map((problem) => problem.message) } } : {}) };
  };
  const live = manifest?.runs.live ?? 0;
  const signIns = (manifest?.sign_ins ?? []).map((entry) => entry.key);
  return [
    judge("format", manifest?.format ?? "readable"),
    judge("definition", manifest ? `agent ${manifest.agent_id}, ${manifest.skills.length} skills` : "readable"),
    signIns.length
      ? { name: "sign_ins", status: "warn", message: `${signIns.length} sign-in${signIns.length === 1 ? "" : "s"} to redo at the target: ${signIns.join(", ")}`, detail: { sign_ins: signIns } }
      : { name: "sign_ins", status: "ok", message: manifest ? "the source had none" : "unknown" },
    judge("size", `${bytes} bytes`),
    live > 0
      ? { name: "live_runs", status: "warn", message: `${live} of ${manifest!.runs.count} runs were live at the source; they travel as index entries only` }
      : { name: "live_runs", status: "ok", message: manifest ? `${manifest.runs.count} runs, none live` : "unknown" },
  ];
}

/**
 * Judge the pack in `file` without writing a home: the manifest first and in format, every member on the allowlist (no
 * "..", no absolute path, no link or device), every SQLite file free of sign-in kinds, the agent store's identity,
 * definition and skills as the manifest says, the size as the manifest says. Only temporary files are written, and removed.
 * The checks are the contract's names for what this package can judge: format, definition, size and live_runs.
 */
export async function readPack(file: string, options: { maxBytes?: number } = {}): Promise<{ ok: boolean; manifest: HomeManifest | null; checks: HomeCheck[] }> {
  const inspection = await inspectPack(file, options);
  const checks = checksOf(inspection.manifest, inspection.problems, inspection.bytes);
  return { ok: checks.every((check) => check.status !== "fail"), manifest: inspection.manifest, checks };
}

// --- importing a pack -------------------------------------------------------------------------------------------------

export type ImportReport = { ok: true; agent_id: string; checks: HomeCheck[]; written: true; replaces: boolean };

/**
 * Write the pack in `file` as the agent home in `dir`, under `dir`'s owner lock. The pack is judged first (`readPack`),
 * then extracted to a directory beside `dir`, then swapped in by two renames, so `dir` is never half written. A target
 * that is already a home needs `replace`; it must be the same agent and have no live run, and `ifRevision` must still be
 * its `homeRevision` (`stale`). What never travels stays: the target's sign-ins, aliases and bindings, and its `chrome/`
 * and `repo/` directories. Its runs the pack does not have stay too, entry and directory; for a run id in both, the pack's
 * wins. A run that was live at the source arrives as an ended entry (outcome `not_carried_back`).
 */
export async function importPack(file: string, dir: string, options: { replace?: boolean; ifRevision?: number; maxBytes?: number; now?: number } = {}): Promise<{ home: AgentHome; report: ImportReport }> {
  if (options.ifRevision !== undefined && !(Number.isSafeInteger(options.ifRevision) && options.ifRevision >= 0)) throw invalid(`ifRevision ${JSON.stringify(options.ifRevision)} is not a home revision (a non-negative integer)`);
  const target = path.resolve(dir);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, `.${path.basename(target)}.import-`));
  const incoming = path.join(scratch, "home");
  const backup = path.join(scratch, "replaced");
  let createdTarget = false;
  try {
    await mkdir(incoming);
    const inspection = await inspectPack(file, { maxBytes: options.maxBytes, extractTo: incoming });
    const checks = checksOf(inspection.manifest, inspection.problems, inspection.bytes);
    const failed = checks.filter((check) => check.status === "fail");
    if (failed.length || !inspection.manifest || !inspection.state) {
      throw new AgentHomeError("check", `the pack was refused: ${failed[0]?.message ?? "it holds no agent store"}`, { checks });
    }
    const { manifest, state } = inspection;
    if (!existsSync(target)) {
      await mkdir(target);
      createdTarget = true;
    } else if (!(await stat(target)).isDirectory()) throw invalid(`${dir} is not a directory`);
    else if (!existsSync(path.join(target, AGENT_STORE_FILE)) && (await readdir(target)).some((name) => !LOCK_FILES.includes(name))) {
      throw invalid(`${dir} is not empty and is not an agent home`);
    }

    const replaces = await withHome(target, async () => {
      const present = existsSync(path.join(target, AGENT_STORE_FILE));
      let current: AgentHomeState | undefined;
      let revision: number | undefined;
      if (present) {
        const store = await openStore(path.join(target, AGENT_STORE_FILE));
        try {
          current = await readState(store);
          revision = await store.head();
        } finally {
          await store.close();
        }
      } else if ((await readdir(target)).some((name) => !LOCK_FILES.includes(name))) {
        throw invalid(`${dir} is not empty and is not an agent home`);
      }
      if (options.ifRevision !== undefined && revision !== options.ifRevision) {
        throw new AgentHomeError("stale", `the home at ${dir} is ${revision === undefined ? "not there" : `at revision ${revision}`}, not ${options.ifRevision} as the import expected; nothing was written`);
      }
      if (current) {
        if (!options.replace) throw new AgentHomeError("exists", `${dir} already holds an agent home; replace it with replace`);
        if (current.identity.id !== manifest.agent_id) throw invalid(`${dir} holds agent ${current.identity.id}, not the pack's agent ${manifest.agent_id}`);
        const live = Object.entries(current.runs).filter(([, run]) => run.endedAt === undefined).map(([id]) => id);
        if (live.length) {
          const refusal: HomeCheck = { name: "live_runs", status: "fail", message: `the target has ${live.length} live run${live.length === 1 ? "" : "s"}: ${live.join(", ")}`, detail: { live } };
          throw new AgentHomeError("check", `the import was refused: ${refusal.message}`, { checks: checks.map((check) => (check.name === "live_runs" ? refusal : check)) });
        }
      }
      const now = options.now ?? Date.now();
      const kept = Object.entries(current?.runs ?? {}).filter(([id]) => !Object.hasOwn(state.runs, id));
      const store = await openStore(path.join(incoming, AGENT_STORE_FILE));
      try {
        await store.session.commit(async (tx) => {
          for (const [id, run] of Object.entries(state.runs)) {
            if (run.endedAt === undefined) put(await tx.doc(RunsDoc, id, null), { ...run, endedAt: iso(now), outcome: "not_carried_back" });
          }
          for (const [id, run] of kept) put(await tx.doc(RunsDoc, id, null), run);
          for (const [key, profile] of Object.entries(current?.profiles ?? {})) put(await tx.doc(ProfilesDoc, key, null), profile);
          for (const [key, alias] of Object.entries(current?.aliases ?? {})) put(await tx.doc(AliasesDoc, key, null), alias);
          for (const [key, bindings] of Object.entries(current?.bindings ?? {})) put(await tx.doc(BindingsDoc, key, null), bindings);
        }, BACKGROUND_CONTEXT);
      } finally {
        await store.close();
      }
      await mkdir(path.join(incoming, "runs"), { recursive: true });
      await rename(target, backup);
      try {
        await rename(incoming, target);
      } catch (error) {
        await rename(backup, target);
        throw error;
      }
      for (const stays of ["chrome", "repo"]) if (existsSync(path.join(backup, stays))) await rename(path.join(backup, stays), path.join(target, stays));
      for (const [id] of kept) if (isRunId(id) && existsSync(path.join(backup, "runs", id))) await rename(path.join(backup, "runs", id), path.join(target, "runs", id));
      return current !== undefined;
    });
    createdTarget = false;
    const home = await openAgentHome(target);
    const live = manifest.runs.live;
    const report: ImportReport = {
      ok: true, agent_id: manifest.agent_id, written: true, replaces,
      checks: checks.map((check) => (check.name === "live_runs" && live > 0 ? { ...check, message: `${live} runs were live at the source; they are ended index entries here` } : check)),
    };
    return { home, report };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (createdTarget) await rm(target, { recursive: true, force: true });
  }
}

