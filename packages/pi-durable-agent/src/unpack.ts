import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXPORTABLE_KINDS } from "./export.js";
import { AGENT_STORE_FILE, type AgentHome, type AgentHomeState, checkDefinition, checkSha, ID_PATTERN, isSkillPath, openAgentHome, readState, sha256 } from "./home.js";
import { DefinitionDoc, FORMAT_VERSION, IdentityDoc, put, RunsDoc, SkillsDoc, SourceDoc } from "./kinds.js";
import {
  byName, canonical, documentKinds, type HomeManifest, invalid, isObject, isRunId, iso, MANIFEST_LIMIT, MAX_MEMBERS, memberProblem, PACK_FORMAT, SIDE_FILES,
  secretIn, SQLITE_MAGIC,
} from "./pack-shared.js";
import { SECRET_KINDS } from "./export.js";
import { AgentHomeError, type HomeCheck, IMPORT_JOURNAL, markCommitted, openStore, recoverImport, withHome, writeJournal } from "./store.js";
import { copyRange, listTar, readAt, type TarMember } from "./tar.js";

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
async function inspectPack(file: string, options: { maxBytes?: number; maxMembers?: number; extractTo?: string; inject?: (step: ImportStep) => void | Promise<void> } = {}): Promise<Inspection> {
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new AgentHomeError("missing", `${file} does not exist`);
  if (!info.isFile()) throw invalid(`${file} is not a file`);
  const problems: Problem[] = [];
  // Past fifty, more of the same says nothing new and costs memory.
  const bad = (check: Problem["check"], message: string) => void (problems.length < 50 && problems.push({ check, message }));
  if (options.maxBytes !== undefined && info.size > options.maxBytes) {
    // Not one byte of it is read: a pack over the limit is refused on its size.
    bad("size", `the pack is ${info.size} bytes, over the limit of ${options.maxBytes}`);
    return { manifest: null, problems, bytes: info.size };
  }
  const handle = await open(file, "r");
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-read-"));
  let manifest: HomeManifest | null = null;
  let state: AgentHomeState | undefined;
  try {
    await options.inject?.({ name: "parse", index: 0 });
    const listed = await listTar(handle, info.size, options.maxMembers ?? MAX_MEMBERS);
    for (const problem of listed.problems) bad("format", problem);
    const members: TarMember[] = listed.members;
    const seen = new Set<string>();
    const refusedNames = new Set<string>();
    for (const member of members) {
      const why = memberProblem(member.name, member.kind);
      if (why) {
        bad("format", `${member.name}: ${why}`);
        refusedNames.add(member.name);
      }
      if (seen.has(member.name)) bad("format", `${member.name} appears twice`);
      seen.add(member.name);
    }
    const files = new Set(members.filter((member) => member.kind === "file").map((member) => member.name));
    for (const member of members) {
      if (refusedNames.has(member.name)) continue;
      for (let end = member.name.lastIndexOf("/"); end > 0; end = member.name.lastIndexOf("/", end - 1)) {
        const ancestor = member.name.slice(0, end);
        if (files.has(ancestor)) {
          bad("format", `${member.name} is inside ${ancestor}, which is a file`);
          break;
        }
      }
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
    if (manifest && options.maxBytes !== undefined && manifest.size_bytes > options.maxBytes) bad("size", `the manifest says ${manifest.size_bytes} bytes, over the limit of ${options.maxBytes}`);
    // Nothing is extracted from a pack that already fails a check or is over the limit.
    if (!manifest || problems.some((problem) => problem.check !== "size" || options.extractTo)) return { manifest, problems, bytes: info.size };

    let probes = 0;
    let extracted = 0;
    const live = new Set<string>();
    for (const member of members) {
      if (member.name === "manifest.json") continue;
      extracted += member.size;
      if (options.extractTo && options.maxBytes !== undefined && extracted > options.maxBytes) {
        bad("size", `the pack holds more than the limit of ${options.maxBytes} bytes`);
        return { manifest, problems, bytes: info.size };
      }
      const dest = options.extractTo && path.join(options.extractTo, ...member.name.split("/"));
      if (dest) await options.inject?.({ name: "extract", index: probes });
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
export async function readPack(file: string, options: { maxBytes?: number; maxMembers?: number; /** @internal */ inject?: (step: ImportStep) => void | Promise<void> } = {}): Promise<{ ok: boolean; manifest: HomeManifest | null; checks: HomeCheck[] }> {
  const inspection = await inspectPack(file, options);
  const checks = checksOf(inspection.manifest, inspection.problems, inspection.bytes);
  return { ok: checks.every((check) => check.status !== "fail"), manifest: inspection.manifest, checks };
}


// --- importing a pack -------------------------------------------------------------------------------------------------

export type ImportReport = { ok: true; agent_id: string; checks: HomeCheck[]; written: true; replaces: boolean };
/** A point in a read or an import: the pack about to be parsed, a member about to be extracted, the target checked, a run
 *  directory moved, the store's commit made, the journal marked committed, the clean-up half done. */
export type ImportStep = { name: "parse" | "extract" | "checked" | "moved" | "committed" | "marked" | "cleaned"; index: number };
export type ImportOptions = {
  /** The target may already be a home. */
  replace?: boolean;
  /** The target's `homeRevision` the caller read; the import is refused (`stale`) when it has moved. */
  ifRevision?: number;
  maxBytes?: number;
  maxMembers?: number;
  now?: number;
  /** @internal Called at each step; a test throws from it. An error with `crash: true` stands for the process dying: nothing is settled. */
  inject?: (step: ImportStep) => void | Promise<void>;
};

/** Mark the runs that were live at the source as ended here: nothing will ever carry them back. */
const endedHere = (run: AgentHomeState["runs"][string], now: number) => (run.endedAt === undefined ? { ...run, endedAt: iso(now), outcome: "not_carried_back" } : run);

/**
 * Write the pack in `file` as an agent home in `dir`. The pack is judged first (`readPack`) and extracted to a directory
 * beside `dir`; nothing is extracted from a pack over `maxBytes`.
 *
 * A `dir` that is absent or empty becomes a new home: the extracted directory is renamed into place.
 *
 * A `dir` that is already a home needs `replace`, must hold the same agent, and must have no live run, and its
 * `ifRevision`, when given, must be its `homeRevision` (`stale`). It is changed in place, under its own owner lock, and
 * the lock, `agent.sqlite`, `chrome/`, `repo/`, its sign-ins, aliases and bindings, and its runs the pack does not have
 * stay where they are. One store commit replaces the definition, the skills, the source and the pack's runs, so
 * `homeRevision` only goes up. The pack's run directories move into place before it, each old one set aside first, in
 * the order of a journal in the home: a failure puts every one back, and a crash is settled by the next lock taker, which
 * keeps the new home when the commit landed and the old one when it did not. A run that was live at the source arrives
 * as an ended entry (outcome `not_carried_back`).
 */
export async function importPack(file: string, dir: string, options: ImportOptions = {}): Promise<{ home: AgentHome; report: ImportReport }> {
  if (options.ifRevision !== undefined && !(Number.isSafeInteger(options.ifRevision) && options.ifRevision >= 0)) throw invalid(`ifRevision ${JSON.stringify(options.ifRevision)} is not a home revision (a non-negative integer)`);
  const target = path.resolve(dir);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}.import-`));
  const extracted = path.join(staging, "home");
  let crashed = false;
  try {
    await mkdir(extracted);
    const inspection = await inspectPack(file, { maxBytes: options.maxBytes, maxMembers: options.maxMembers, extractTo: extracted, inject: options.inject });
    const checks = checksOf(inspection.manifest, inspection.problems, inspection.bytes);
    const failed = checks.filter((check) => check.status === "fail");
    if (failed.length || !inspection.manifest || !inspection.state) {
      throw new AgentHomeError("check", `the pack was refused: ${failed[0]?.message ?? "it holds no agent store"}`, { checks });
    }
    const { manifest, state } = inspection;
    const now = options.now ?? Date.now();
    if (existsSync(target) && !(await stat(target)).isDirectory()) throw invalid(`${dir} is not a directory`);
    const isHome = () => existsSync(path.join(target, AGENT_STORE_FILE));
    let replaces = false;

    if (!isHome()) {
      if (options.ifRevision !== undefined) throw new AgentHomeError("stale", `there is no home at ${dir}, so no revision ${options.ifRevision}; nothing was written`);
      const store = await openStore(path.join(extracted, AGENT_STORE_FILE));
      try {
        await store.session.commit(async (tx) => {
          for (const [id, run] of Object.entries(state.runs)) if (run.endedAt === undefined) put(await tx.doc(RunsDoc, id, null), endedHere(run, now));
        }, BACKGROUND_CONTEXT);
      } finally {
        await store.close();
      }
      await mkdir(path.join(extracted, "runs"), { recursive: true });
      await options.inject?.({ name: "checked", index: 0 });
      // The target is never deleted, whatever it holds: an empty directory goes by rmdir, and anything another process put
      // there since makes this refuse. The rename then fills the place or fails, and never replaces a directory that has files.
      const refuse = () => (existsSync(path.join(target, AGENT_STORE_FILE))
        ? new AgentHomeError("exists", `${dir} became a home while the pack was read; nothing was written`)
        : invalid(`${dir} is not empty and is not an agent home`));
      if (existsSync(target)) {
        try {
          await rmdir(target);
        } catch (error) {
          if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw refuse();
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        await rename(extracted, target);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw refuse();
        throw error;
      }
    } else {
      replaces = true;
      await withHome(target, async () => {
        if (!isHome()) throw invalid(`the home at ${dir} went away while the pack was read`);
        const file = path.join(target, AGENT_STORE_FILE);
        let current: AgentHomeState;
        let from: number;
        const reading = await openStore(file);
        try {
          current = await readState(reading);
          from = await reading.head();
        } finally {
          await reading.close();
        }
        if (options.ifRevision !== undefined && from !== options.ifRevision) {
          throw new AgentHomeError("stale", `the home at ${dir} is at revision ${from}, not ${options.ifRevision} as the import expected; nothing was written`);
        }
        if (!options.replace) throw new AgentHomeError("exists", `${dir} already holds an agent home; replace it with replace`);
        if (current.identity.id !== manifest.agent_id) throw invalid(`${dir} holds agent ${current.identity.id}, not the pack's agent ${manifest.agent_id}`);
        const live = Object.entries(current.runs).filter(([, run]) => run.endedAt === undefined).map(([id]) => id);
        if (live.length) {
          const refusal: HomeCheck = { name: "live_runs", status: "fail", message: `the target has ${live.length} live run${live.length === 1 ? "" : "s"}: ${live.join(", ")}`, detail: { live } };
          throw new AgentHomeError("check", `the import was refused: ${refusal.message}`, { checks: checks.map((check) => (check.name === "live_runs" ? refusal : check)) });
        }

        const runDir = (id: string) => path.join(target, "runs", id);
        const moves = Object.keys(state.runs).sort(byName).filter(isRunId)
          .map((id) => ({ id, hadOld: existsSync(runDir(id)), hasNew: existsSync(path.join(extracted, "runs", id)) }))
          .filter((move) => move.hadOld || move.hasNew);
        await mkdir(path.join(target, "runs"), { recursive: true });
        await mkdir(path.join(staging, "backup"));
        const journal = { version: 1 as const, staging, from, moves };
        if (moves.length) await writeJournal(target, journal);
        const step = async (name: ImportStep["name"], index: number) => { await options.inject?.({ name, index }); };
        try {
          for (const [index, move] of moves.entries()) {
            if (move.hadOld) await rename(runDir(move.id), path.join(staging, "backup", move.id));
            if (move.hasNew) await rename(path.join(extracted, "runs", move.id), runDir(move.id));
            await step("moved", index);
          }
          const writing = await openStore(file);
          try {
            await writing.session.commit(async (tx) => {
              put(await tx.doc(IdentityDoc), state.identity);
              put(await tx.doc(DefinitionDoc), state.definition);
              if (state.source) put(await tx.doc(SourceDoc), state.source);
              else if (current.source) await tx.retireDoc(SourceDoc);
              for (const key of Object.keys(current.skills)) if (!Object.hasOwn(state.skills, key)) await tx.retireDoc(SkillsDoc, key);
              for (const [key, skill] of Object.entries(state.skills)) put(await tx.doc(SkillsDoc, key, null), skill);
              for (const [id, run] of Object.entries(state.runs)) put(await tx.doc(RunsDoc, id, null), endedHere(run, now));
            }, BACKGROUND_CONTEXT);
          } finally {
            await writing.close();
          }
          await step("committed", moves.length);
          // The commit has returned. Say so on disk before anything is cleaned up: a crash from here on finishes the
          // clean-up and never rolls back, whether or not the commit changed a byte of the store.
          if (moves.length) await markCommitted(target, journal);
          await step("marked", moves.length);
          await rm(staging, { recursive: true, force: true });
          await step("cleaned", moves.length);
          await rm(path.join(target, IMPORT_JOURNAL), { force: true });
        } catch (error) {
          if ((error as { crash?: boolean }).crash) crashed = true;
          else if (moves.length) await recoverImport(target);
          throw error;
        }
      });
    }
    const home = await openAgentHome(target);
    const live = manifest.runs.live;
    const report: ImportReport = {
      ok: true, agent_id: manifest.agent_id, written: true, replaces,
      checks: checks.map((check) => (check.name === "live_runs" && live > 0 ? { ...check, message: `${live} runs were live at the source; they are ended index entries here` } : check)),
    };
    return { home, report };
  } finally {
    if (!crashed) await rm(staging, { recursive: true, force: true });
  }
}
