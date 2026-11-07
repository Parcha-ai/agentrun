// `agentrun-serve import`: the Claude Code, Codex and pi sessions under a person's own home, into this server's agent
// store, once, when asked. Each project directory is one agent; each harness seen in it one revision of that agent, its
// instructions the project's CLAUDE.md or AGENTS.md and its skills the project's skill folders; each session one run,
// ended as it ended, its transcript the run's timeline. An imported run is history: it takes no message, stop or cancel.
// Nothing leaves the machine, every string written has the environment's key values cut out, and every file written is
// the owner's only. Read again, it imports only the sessions it has not.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { chmod, lstat, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, ROOT_CONVERSATION_ID, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type AgentStore, type AgentStoreReader, type NewRevision, openStore, openStoreReader, type Revision, STORE_FILE, type StoredMetrics } from "@parcha/pi-durable-agent";
import { type EntryLike, REQUEST_COST, type RunMetrics, runMetricsOf } from "@parcha/pi-durable-agent/timeline";
import { defaultData, readJson, RUN_META, writeDurable } from "./files.js";
import { childFiles, HARNESS_OF, mostEffortOf, readSession, type Session, SOURCES, type Source, sessionFiles, type Turn } from "./import-sources.js";
import { type Found, foundIn, hoursOf, summaryLines } from "./import-summary.js";
import { catalogPrices, type Listed } from "./model.js";
import { logLine } from "./print.js";
import { DEFAULT_PORT } from "./server.js";
import { REDACTED, secretCut, secretsIn } from "./secret-cut.js";
import { SECRET_NAMES, withSecrets } from "./secrets.js";
import { ToolKeys } from "./tool-keys.js";
import { openServerSecrets } from "./server-secrets.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { type RefusedReason, readWorkBytes, WorkRefused, walkWork } from "./workspace.js";
import { readRunDbSync } from "./run-db.js";

/** In the data directory while an import the owner asked for at setup has not ended: the server's next start goes on with it. */
export const IMPORT_ASKED = ".import-at-setup";
/** A session file written to this recently may still be running: it is left for a later import. */
export const LIVE_MS = 10 * 60_000;
/** The most of one session file read. */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;
/** The most of one instructions or skill file read, and of one agent's skill files together. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_BYTES = 1024 * 1024;
/** The project's skill folders, each `<dir>/<name>/` with its SKILL.md, by where each harness keeps them. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/skills"];
const INSTRUCTIONS: Record<string, string[]> = {
  "claude-agent": ["CLAUDE.md", "AGENTS.md"],
  codex: ["AGENTS.md", "CLAUDE.md"],
  pi: ["AGENTS.md", "CLAUDE.md"],
};

export type ImportOptions = {
  /** The home whose sessions are read (the person's own). */
  home: string;
  sources?: readonly Source[];
  /** Keep projects whose directory is gone or under the temp directory, and sessions with no message of the person's. */
  all?: boolean;
  /** Keep projects whose directory is gone (a deleted worktree's, a moved checkout's): each still its own agent, with no
   *  instructions or skills to read. */
  deleted?: boolean;
  /** The environment whose key-shaped values are cut out of everything written. */
  env: NodeJS.ProcessEnv;
  /** The tool keys saved through the settings API, opened (tool-keys.ts' `values`): cut out by the same rule. */
  stored?: Record<string, string>;
  /** The secrets this server made and keeps (`ownSecrets`), cut out by their values as the environment's are. */
  own?: readonly string[];
  now?: number;
  /** The temp directory whose projects are left out (default the OS's). */
  temp?: string;
  /** Stops the import between two session files, planned or taken (a server shutting down): what is written stays, and
   *  the next import goes on from there. */
  signal?: AbortSignal;
  /** Each key secretlint finds, as it finds it: for what the CLI prints, cut with the keys the import cuts. */
  onKeys?: (keys: readonly string[]) => void;
  /** Read each session file through secretlint for the cut (default). Setup's count sets it false: a count keeps no
   *  transcript, so it reads none, and a server's start never scans a whole history to say how many sessions it has. */
  keys?: boolean;
  /** Read each session's turns while planning, and measure it (`Plan.found`): what a dry run's summary counts. */
  measure?: boolean;
};
/** Why a session file or a project's file is left out, by kind, as the left-out counts group them (leftOutLines). */
export type LeftOut = "gone" | "temp" | "live" | "large" | "unread" | "no-project" | "no-words" | "copies" | "vanished" | "file";
/** `session`, when the file was read: the session it holds (`<source>:<id>`), so a session of two files (a resumed Codex
 *  thread) is counted once. */
export type Skipped = { what: string; why: string; kind: LeftOut; session?: string };
export type ProjectPlan = {
  cwd: string;
  agentId: string;
  name: string;
  sessions: Session[];
};
/** `already`: the session files an earlier import took whole, left unread; `held`, the runs an import would not take
 *  again: theirs, and (when measuring) those of planned sessions the store holds already. `children`: the files of each
 *  session's subagents, whose usage is its run's: Claude Code's by the session file beside them, Codex's by `source:thread`; `untied`, those of subagents whose file names
 *  no parent, counted in a summary's totals alone. `found`: each other planned session measured,
 *  when the plan was made to (`measure`). */
export type Plan = { projects: ProjectPlan[]; skipped: Skipped[]; already: number; held: string[]; children: Map<string, string[]>; untied: { file: string; source: Source }[]; found?: Found[]; secretsFound?: number };
export type ImportReport = {
  agents: {
    id: string;
    name: string;
    cwd: string;
    created: boolean;
    runs: number;
    already: number;
    /** Imports an earlier one left without their transcript, finished now. */
    finished: number;
  }[];
  skipped: Skipped[];
  already: number;
  /** Keys and tokens cut out of what it wrote (secret-cut.ts): the environment's values, the saved keys, and those of a
   *  known format secretlint found. */
  secretsRemoved?: number;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A session's id as an import keeps it: as it is, unless it holds one of the keys the import cuts, the environment's or
 *  one saved on the server (a session named after its file can), then `redacted-` and a hash of it, the same each time
 *  and different for each id, so two such sessions stay two runs and a later import finds each one's. The plan and the
 *  import keep it from the same keys, or a later import would not find the run an earlier one made. */
const redactedId = (id: string) => `redacted-${hash(id).slice(0, 16)}`;
/** A file's size and time, as an import read it: the same after means the same content was read. */
const stampOf = (stats: { size: number; mtimeMs: number }) => `${stats.size}:${stats.mtimeMs}`;
const keptId = (envs: readonly NodeJS.ProcessEnv[], own: readonly string[] = []) => {
  const { text, add } = secretCut(envs, SECRET_NAMES);
  add(own);
  // A key secretlint finds in the id itself (a session named after its file); a count, whose ids are kept by no run, asks
  // no scan.
  return async (id: string, scan = true) => (text(id) === id && !(scan && (await secretsIn(id)).length) ? id : redactedId(id));
};

/** The keys secretlint finds in what a run's import writes: its sessions as read (each file once, its path, every
 *  record's strings), in one pass, right before they are cut, so a key a session still being written added after the
 *  plan is found as well. */
async function keysInSessions(sessions: readonly Session[]): Promise<string[]> {
  if (!sessions.length) return [];
  const strings: string[] = [];
  const seen = new Set<object>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) value.forEach(collect);
      else if (value instanceof Map) for (const [name, inner] of value) (collect(name), collect(inner));
      else for (const [name, inner] of Object.entries(value)) (strings.push(name), collect(inner));
    }
  };
  sessions.forEach(collect);
  return secretsIn(strings.join("\n"));
}

/** Every key an import would cut, found before anything of it is written, across every project: each project's own text,
 *  and each run the import would write (its sessions, then its subagents, which the reader holds to MAX_SESSION_BYTES),
 *  read through secretlint once, findings only, into `add`. Each file's size and time as read, and each project's text
 *  as read, are kept: a write reads a run (or a project's text) through secretlint again only if it changed since. */
async function findKeys(plan: Plan, add: (keys: readonly string[]) => void, cut: (text: string) => string, held: (listed: Session) => boolean, signal?: AbortSignal): Promise<{ stamps: Map<string, string>; texts: Map<string, string> }> {
  const stamps = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const project of plan.projects) {
    if (signal?.aborted) break;
    const own = projectText(project.cwd, await projectFiles(project.cwd, []));
    texts.set(project.agentId, hash(own));
    add(await secretsIn(own));
  }
  for (const project of plan.projects) {
    for (const files of byRun(project.sessions)) {
      if (signal?.aborted) break;
      const listed = files[0]!;
      if (held(listed)) continue;
      // Its own count of records seen: the import's, shared across its files, is the write's to keep.
      const seen = new Set<string>();
      const parts: Session[] = [];
      for (const { file } of files) {
        const stats = await stat(file).catch(() => null);
        const part = stats ? await readSession(file, listed.source, { seen }).catch(() => undefined) : undefined;
        if (!part || !stats) continue;
        stamps.set(file, stampOf(stats));
        parts.push(part);
      }
      if (!parts.length) continue;
      add(await keysInSessions(parts));
      const session = merged(parts);
      const subagents = await readChildren(plan, { ...session, id: cut(session.id) === session.id ? session.id : redactedId(session.id) }, parts, seen);
      for (const child of subagents) {
        const stats = await stat(child.file).catch(() => null);
        if (stats) stamps.set(child.file, stampOf(stats));
      }
      add(await keysInSessions(subagents));
    }
  }
  return { stamps, texts };
}

/** A project's own text for secretlint: its path, its instructions, and its skills' paths and text. */
const projectText = (cwd: string, files: { instructions: Record<string, string>; skills: Record<string, string> }) =>
  [cwd, ...Object.values(files.instructions), ...Object.entries(files.skills).flat()].join("\n");
export const agentIdOf = (cwd: string) => `imp-${hash(`dir:${cwd}`).slice(0, 32)}`;
/** The sessions the store holds already, as `source:session`, to their run's id. */
const importedIn = (store: AgentStoreReader) => new Map(store.listRuns().flatMap((run) => (run.importedFrom ? [[`${run.importedFrom.source}:${run.importedFrom.session}`, run.id] as const] : [])));
/** A session file as an import read it: its size and its time, so an unchanged one is not parsed again. */
/** The file by the sha256 of its path, never the path: a path can hold what the cut takes out of everything written. */
type SourceFile = { path_sha256: string; size: number; mtime_ms: number };
const sameFile = (seen: SourceFile | undefined, stats: { size: number; mtimeMs: number }) => seen !== undefined && seen.size === stats.size && seen.mtime_ms === stats.mtimeMs;
/** The session files the store's imports read whole, by their path's sha256, with their run: each from a run whose
 *  transcript is there. */
async function filesIn(store: AgentStoreReader): Promise<Map<string, SourceFile & { run: string }>> {
  const out = new Map<string, SourceFile & { run: string }>();
  for (const run of store.listRuns()) {
    if (!run.importedFrom || !existsSync(store.runStorePath(run.id))) continue;
    const meta = (await readJson(join(store.runDir(run.id), RUN_META))) as { source_file?: SourceFile } | null;
    const seen = meta?.source_file;
    if (seen && typeof seen.path_sha256 === "string" && typeof seen.size === "number" && typeof seen.mtime_ms === "number") out.set(seen.path_sha256, { ...seen, run: run.id });
  }
  return out;
}
const unread = (file: string, error: unknown): Skipped => ({ what: file, why: `not read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, kind: "unread" });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What an import would take: the sessions under `home`, by project, with what it leaves out and why. Keeps no turns
 *  (with `measure`, only until each session is measured), and reads no file `store`'s imports already read whole and
 *  that has not changed since. */
export async function planImport({ home, sources = SOURCES, all = false, deleted = false, now = Date.now(), temp: tempDir = tmpdir(), measure = false, env, stored, own = [], signal, keys: scan = true, onKeys }: ImportOptions, store?: AgentStoreReader): Promise<Plan> {
  // A session's id that holds a key (one named after its file can) is kept as a hash of it: every lookup of an earlier
  // import's run then goes by the id as kept.
  const idOf = keptId([env, stored ?? {}], own);
  const skipped: Skipped[] = [];
  const seen = store ? await filesIn(store) : new Map<string, SourceFile & { run: string }>();
  let already = 0;
  const held: string[] = [];
  const found: Found[] = [];
  const children = new Map<string, string[]>();
  const child = (owner: string, file: string) => void children.set(owner, [...(children.get(owner) ?? []), file]);
  const untied: Plan["untied"] = [];
  const projects = new Map<string, ProjectPlan>();
  // Each listed session's place in the import's order (inOrder).
  const rank = new Map<Session, number>();
  const temps = [...new Set([tempDir, await realpath(tempDir).catch(() => tempDir)])];
  for (const source of sources) {
    for (const { file, stats } of await inOrder(await sessionFiles(home, source), source)) {
      if (signal?.aborted) break;
      const known = seen.get(hash(file));
      if (sameFile(known, stats)) {
        already += 1;
        held.push(known!.run);
        continue;
      }
      if (now - stats.mtimeMs < LIVE_MS) {
        skipped.push({
          what: file,
          why: "written in the last 10 minutes: it may still be running",
          kind: "live",
        });
        continue;
      }
      if (stats.size > MAX_SESSION_BYTES) {
        skipped.push({ what: file, why: `over ${MAX_SESSION_BYTES} bytes`, kind: "large" });
        continue;
      }
      // One file this user cannot read, or one gone since its stat, is named and passed over: the rest still import.
      const session = await readSession(file, source, { turns: false }).catch((error: unknown) => void skipped.push(unread(file, error)));
      if (!session) continue;
      session.id = await idOf(session.id, scan);
      if (session.parent) session.parent = await idOf(session.parent, scan);
      // A subagent's session is no run of its own: its usage is its parent's, when its file names the parent (a Codex
      // thread's, whichever of its files); else it counts in the totals alone, where its project would.
      if (session.child && session.parent) {
        child(`${source}:${session.parent}`, file);
        continue;
      }
      if (!session.cwd) {
        skipped.push({ what: file, why: "no project directory in it", kind: "no-project" });
        continue;
      }
      if (!all && session.users === 0 && !session.child) {
        skipped.push({ what: file, why: "no message of the person's", kind: "no-words", session: `${source}:${session.id}` });
        continue;
      }
      const cwd = session.cwd;
      if (!all) {
        // A temp folder first, gone or not: only --all brings it in, as the left-out line says.
        if (temps.some((temp) => cwd === temp || cwd.startsWith(temp + sep))) {
          skipped.push({
            what: file,
            why: `its project ${cwd} is a temp directory`,
            kind: "temp",
            session: `${source}:${session.id}`,
          });
          continue;
        }
        const there = await lstat(cwd).catch(() => null);
        if (!there?.isDirectory() && !deleted) {
          skipped.push({ what: file, why: `its project ${cwd} is gone`, kind: "gone", session: `${source}:${session.id}` });
          continue;
        }
      }
      if (session.child) {
        untied.push({ file, source });
        continue;
      }
      let project = projects.get(cwd);
      if (!project)
        projects.set(
          cwd,
          (project = {
            cwd,
            agentId: agentIdOf(cwd),
            name: basename(cwd) || cwd,
            sessions: [],
          }),
        );
      rank.set(session, rank.size);
      project.sessions.push(session);
    }
    if (source === "claude-code") for (const { file, of } of await childFiles(home)) child(of, file);
  }
  ownRuns(projects, rank);
  const plan: Plan = { projects: [...projects.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)), skipped, already, held, children, untied };
  if (!measure) return plan;
  const counting = secretCut(env, SECRET_NAMES);
  // Every key the import would cut, found first, as the import finds it before it writes anything: then the counts.
  const heldBy = store ? importedIn(store) : undefined;
  const foundKeys = (keys: readonly string[]) => (counting.add(keys), onKeys?.(keys));
  // This server's own secrets first, as the import takes them.
  foundKeys(own);
  await findKeys(plan, foundKeys, counting.text, (listed) => heldBy?.get(`${listed.source}:${listed.id}`) !== undefined, signal);
  // Measured in the import's own order, a record or response counted once across files, each session with its
  // subagents; a session the store holds already from its run, as the import counts it, not from its file now.
  for (const project of plan.projects) {
    const seen = await seenIn(store, project.agentId);
    for (const files of byRun(project.sessions)) {
      const run = heldBy?.get(`${files[0]!.source}:${files[0]!.id}`);
      if (run !== undefined) {
        held.push(run);
        continue;
      }
      // Each of its files read; those holding only copies add no records to it, but their subagents' folders are its
      // too, read through the same count (readChildren).
      const read: Session[] = [];
      for (const listed of files) {
        const part = await readSession(listed.file, listed.source, { seen: seen(listed.source) }).catch(() => undefined);
        if (part) read.push(part);
      }
      const parts = read.filter((part) => !ownless(part));
      if (!parts.length) continue;
      const session = merged(parts);
      // What the import's cut would take out of it (its turns, its first message): the dry run's count.
      counting.json(session.turns);
      if (session.firstPrompt) counting.text(session.firstPrompt);
      const subagents = await readChildren(plan, session, read, seen(session.source));
      found.push({ source: session.source, agent: project.agentId, ...measured(session, subagents) });
    }
  }
  // Each project's files read as the import reads them, held agent or new: each file it leaves out (a link, one over its
  // cap) is among what the dry run says it leaves out. A new agent's own text (its name, its path, its instructions and
  // skills) is the import's to cut too: counted here, after every key is known, as the import cuts it.
  for (const project of plan.projects) {
    const files = await projectFiles(project.cwd, skipped);
    if (store?.readAgent(project.agentId)) continue;
    counting.text(project.name);
    counting.text(project.cwd);
    for (const text of Object.values(files.instructions)) counting.text(text);
    for (const [path, text] of Object.entries(files.skills)) (counting.text(path), counting.text(text));
  }
  return { ...plan, found, secretsFound: counting.text.removed };
}

/** The subagents tied to no session: each one's tokens and tool calls, for a summary's totals, each response once. */
export async function untiedFound(plan: Plan): Promise<Found[]> {
  const seen = new Map<Source, Set<string>>();
  const counted = (source: Source) => seen.get(source) ?? seen.set(source, new Set()).get(source)!;
  // A thread resumed in a second file of the same id is one: its own subagents, which name it, count once with it.
  const threads = new Map<string, Session[]>();
  for (const { file, source } of plan.untied) {
    const stats = await stat(file).catch(() => null);
    if (!stats || stats.size > MAX_SESSION_BYTES) continue;
    const session = await readSession(file, source, { seen: counted(source) }).catch(() => undefined);
    if (session) threads.set(`${source}:${session.id}`, [...(threads.get(`${source}:${session.id}`) ?? []), session]);
  }
  const found: Found[] = [];
  for (const parts of threads.values()) {
    const session = merged(parts);
    found.push({ source: session.source, agent: "", untied: true, metrics: metricsOf(session, await readChildren(plan, session, parts, counted(session.source))) });
  }
  return found;
}

/** Each session's files in the project of its first file by start (the earliest-named of a tie), whichever project the
 *  others' records name: one run, in one agent, on every import. Each project's files in the import's order (`rank`); a
 *  project left with none is none. */
function ownRuns(projects: Map<string, ProjectPlan>, rank: ReadonlyMap<Session, number>): void {
  const files = new Map<string, { session: Session; project: ProjectPlan }[]>();
  for (const project of projects.values()) for (const session of project.sessions) files.set(`${session.source}:${session.id}`, [...(files.get(`${session.source}:${session.id}`) ?? []), { session, project }]);
  const first = (a: Session, b: Session) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.file.localeCompare(b.file);
  for (const run of files.values()) {
    if (run.length < 2) continue;
    const owner = run.reduce((one, other) => (first(other.session, one.session) < 0 ? other : one)).project;
    for (const { session, project } of run) if (project !== owner) (project.sessions.splice(project.sessions.indexOf(session), 1), owner.sessions.push(session));
  }
  for (const [cwd, project] of projects) {
    if (project.sessions.length) project.sessions.sort((a, b) => rank.get(a)! - rank.get(b)!);
    else projects.delete(cwd);
  }
}

/** A project's session files by the session they write, each session's in order, the sessions in their first files'
 *  order: a Codex thread resumed later writes a new file of the same id, and a Claude Code session resumed in another
 *  directory is copied into that project's folder under its id, then carried on. The store keeps one run of a session. */
function byRun(sessions: readonly Session[]): Session[][] {
  const runs = new Map<string, Session[]>();
  for (const session of sessions) runs.set(`${session.source}:${session.id}`, [...(runs.get(`${session.source}:${session.id}`) ?? []), session]);
  return [...runs.values()];
}

/** The sessions `files` write, as the import takes them: one per source and session id, however many files write it
 *  (`byRun`), with its cost known when each of its files' is (as `merged` prices it). What a dry run counts. */
export const sessionsOf = (files: readonly Session[]): { source: Source; key: `${Source}:${string}`; priced: boolean }[] =>
  byRun(files).map((parts) => ({ source: parts[0]!.source, key: `${parts[0]!.source}:${parts[0]!.id}` as const, priced: parts.every((s) => s.costUsd !== undefined) }));

/** A session's files, read in the import's order with its `seen` (which file keeps a copied record), as the one run the
 *  store keeps of it: their turns in the order they ran (each file's by its start; each answer with its own file's model
 *  when it names none), its state and model the file's that ended last. Its cost, when each file's is known: Claude Code
 *  writes the session's running total (a moved session's copy goes on from the original's), so the highest total
 *  written; another source's file prices its own requests, so their sum. */
function merged(parts: readonly Session[]): Session {
  if (parts.length === 1) return parts[0]!;
  const ordered = [...parts].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.file.localeCompare(b.file));
  const [first, last] = [ordered[0]!, ordered.reduce((one, other) => ((other.endedAt ?? "") >= (one.endedAt ?? "") ? other : one))];
  const turns = ordered.flatMap((part) => part.turns.map((turn): Turn => (turn.role === "assistant" && !turn.model && part.model ? { ...turn, model: part.model } : turn)));
  const sum = (key: "users" | "activeMs" | "copies") => parts.reduce((n, part) => n + part[key], 0);
  const effort = mostEffortOf(turns);
  const starts = parts.flatMap((part) => (part.startedAt ? [part.startedAt] : [])).sort();
  const priced = parts.flatMap((part) => (part.costUsd !== undefined ? [part.costUsd] : []));
  // Known only when each file's is: a file whose spending is unknown (an unpriced model, no cost written) leaves the
  // session's unknown, never a part of it stored as the whole.
  const costUsd = priced.length < parts.length ? undefined : first.source === "claude-code" ? Math.max(...priced) : priced.reduce((n, cost) => n + cost, 0);
  const { model: _model, startedAt: _start, endedAt: _end, costUsd: _cost, firstPrompt: _prompt, effort: _effort, ...rest } = first;
  const model = last.model ?? first.model;
  const firstPrompt = ordered.find((part) => part.firstPrompt !== undefined)?.firstPrompt;
  return {
    ...rest,
    ...(model ? { model } : {}),
    ...(starts[0] ? { startedAt: starts[0] } : {}),
    ...(last.endedAt ? { endedAt: last.endedAt } : {}),
    state: last.state,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    turns,
    users: sum("users"),
    activeMs: sum("activeMs"),
    copies: sum("copies"),
    ...(effort ? { effort } : {}),
  };
}

/** The files of `source`, each with its stats (one gone since it was listed is passed over), in the import's order:
 *  Claude Code's by project folder, oldest written first (the first file holding a copied record keeps it); Codex's and
 *  pi's as their dated names sort. */
async function inOrder(files: readonly string[], source: Source): Promise<{ file: string; stats: Stats }[]> {
  const out: { file: string; stats: Stats }[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (stats) out.push({ file, stats });
  }
  if (source === "claude-code") out.sort((a, b) => dirname(a.file).localeCompare(dirname(b.file)) || a.stats.mtimeMs - b.stats.mtimeMs || a.file.localeCompare(b.file));
  return out;
}

/** A session that holds only records an earlier file of the import holds (a resumed session's copy of them). */
const ownless = (session: Session) => session.copies > 0 && !session.turns.some((turn) => turn.role !== "note");

/** The records and responses an import has counted, by source, for one project: first those its runs in `store` hold
 *  already (each answer's response id and each entry's record ids, as its transcript keeps them), then each file's as it
 *  is read. */
async function seenIn(store: AgentStoreReader | undefined, agentId: string): Promise<(source: Source) => Set<string>> {
  const bySource = new Map<Source, Set<string>>();
  const seen = (source: Source) => bySource.get(source) ?? bySource.set(source, new Set()).get(source)!;
  if (!store?.readAgent(agentId)) return seen;
  const { DatabaseSync } = await import("node:sqlite");
  for (const run of store.listRuns({ agent: agentId })) {
    if (run.importedFrom?.source !== "claude-code" || !existsSync(store.runStorePath(run.id))) continue;
    readRunDbSync(store.runStorePath(run.id), false, (db) => {
      const rows = db.prepare("SELECT json_extract(record, '$.model[0].responseId') AS id, json_extract(record, '$.data.record_uuids') AS uuids FROM entries").all() as { id: unknown; uuids: unknown }[];
      for (const { id, uuids } of rows) {
        if (typeof id === "string" && id) seen("claude-code").add(`m:${id}`);
        if (typeof uuids === "string") for (const uuid of JSON.parse(uuids) as unknown[]) if (typeof uuid === "string") seen("claude-code").add(`u:${uuid}`);
      }
    });
  }
  return seen;
}

/** A run's subagents, theirs, and so on down, each file once, read with the import's `seen`: those beside each of its
 *  files (Claude Code's), and those naming its thread (Codex's, whichever of its files they ran under). Each within the cap
 *  and readable; another is passed over. */
async function readChildren(plan: Plan, session: Session, parts: readonly Session[], seen: Set<string>): Promise<Session[]> {
  const out: Session[] = [];
  const visited = new Set<string>();
  const under = async (owner: string): Promise<void> => {
    for (const file of plan.children.get(owner) ?? []) {
      if (visited.has(file)) continue;
      visited.add(file);
      const stats = await stat(file).catch(() => null);
      if (!stats || stats.size > MAX_SESSION_BYTES) continue;
      const child = await readSession(file, session.source, { seen }).catch(() => undefined);
      if (!child) continue;
      out.push(child);
      // A subagent's own subagents (Codex names each one's parent thread) are the run's too.
      await under(`${session.source}:${child.id}`);
    }
  };
  for (const part of parts) await under(part.file);
  await under(`${session.source}:${session.id}`);
  return out;
}

/** A subagent's requests in its session's transcript: each one a request with no answer of its own there, its usage and
 *  its cost (none known: null), as a request's cost is written with no answer (REQUEST_COST). The timeline shows none of
 *  them, and its usage row, the run's cost and runMetricsOf all count each one. */
const subagentMarks = (children: readonly Session[]): EntryLike[] =>
  children.flatMap((child) =>
    child.turns.flatMap((turn) => {
      if (turn.role !== "assistant") return [];
      const { input, output, cacheRead, cacheWrite } = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      // A failed request's counts are its own, zeros included, as its answer's are (entryOf).
      return [{ kind: REQUEST_COST, data: { request: "subagent", usd: turn.costUsd ?? null, usage: { input, output, cacheRead, cacheWrite }, ...(turn.error !== undefined ? { failed: true } : {}) } } as EntryLike];
    }),
  );

/** A session's entries as its transcript holds them, its subagents' requests with them (subagentMarks). */
const runEntries = (session: Session, children: readonly Session[]): EntryLike[] => [...entriesOf(session), ...subagentMarks(children)];

/** What a session used, its subagents' requests with it: runMetricsOf of its entries, and its subagents' models and tool
 *  calls, which their marks do not carry. */
function metricsOf(session: Session, children: readonly Session[]): RunMetrics {
  return withChildren(runMetricsOf(runEntries(session, children)), children.map((child) => runMetricsOf(entriesOf(child))));
}

/** A run's metrics with its subagents' models and tool calls in them (their requests and tokens are in its entries). The
 *  run's model stays its own. */
function withChildren(own: RunMetrics, children: readonly RunMetrics[]): RunMetrics {
  const sum = { ...own, models: { ...own.models }, tools: Object.fromEntries(Object.entries(own.tools).map(([name, tool]) => [name, { ...tool }])) };
  for (const child of children) {
    for (const [name, n] of Object.entries(child.models)) sum.models[name] = (sum.models[name] ?? 0) + n;
    for (const [name, tool] of Object.entries(child.tools)) {
      const into = (sum.tools[name] ??= { calls: 0, errors: 0 });
      into.calls += tool.calls;
      into.errors += tool.errors;
    }
  }
  if (sum.model === undefined) {
    for (const [name, n] of Object.entries(sum.models)) if (sum.model === undefined || n > sum.models[sum.model]!) sum.model = name;
  }
  return sum;
}

/** A project's instructions file and skill folders, read through no link and within their caps. Each file left out is
 *  in `skipped`, named, with why: a link, not text, over its cap, or a folder with no SKILL.md. */
export async function projectFiles(
  cwd: string,
  skipped: Skipped[],
): Promise<{
  instructions: Record<string, string>;
  skills: Record<string, string>;
}> {
  const instructions: Record<string, string> = {};
  const skills: Record<string, string> = {};
  // A project kept by --all or --include-deleted whose directory is gone has neither.
  if (!(await lstat(cwd).catch(() => null))?.isDirectory()) return { instructions, skills };
  const why = (reason: RefusedReason) => (reason === "over_cap" ? `over ${MAX_FILE_BYTES} bytes` : reason === "link" ? "a link: not followed" : reason.replace("_", " "));
  const text = async (rel: string): Promise<string | undefined> => {
    try {
      const bytes = await readWorkBytes(cwd, rel, { maxBytes: MAX_FILE_BYTES });
      const decoded = bytes.includes(0)
        ? undefined
        : (() => {
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              return undefined;
            }
          })();
      if (decoded === undefined) skipped.push({ what: join(cwd, rel), why: "not text", kind: "file" });
      return decoded;
    } catch (error) {
      if (!(error instanceof WorkRefused)) throw error;
      if (error.reason !== "missing") skipped.push({ what: join(cwd, rel), why: why(error.reason), kind: "file" });
      return undefined;
    }
  };
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const found = await text(name);
    if (found !== undefined) instructions[name] = found;
  }
  let total = 0;
  for (const dir of SKILL_DIRS) {
    // The folder itself is reached through no link: each component is a directory, not a link to one.
    const parts = dir.split("/");
    let reachable = true;
    for (let i = 1; i <= parts.length && reachable; i++) {
      const at = await lstat(join(cwd, ...parts.slice(0, i))).catch(() => null);
      if (!at) reachable = false;
      else if (!at.isDirectory()) {
        skipped.push({
          what: join(cwd, ...parts.slice(0, i)),
          why: at.isSymbolicLink() ? "a link: not followed" : "not a directory",
          kind: "file",
        });
        reachable = false;
      }
    }
    if (!reachable) continue;
    const files = new Map<string, string[]>();
    try {
      await walkWork(
        join(cwd, dir),
        (path, stats) => {
          if (stats.isFile()) {
            const name = path.split("/")[0]!;
            if (path.includes("/")) files.set(name, [...(files.get(name) ?? []), path]);
          }
        },
        {
          depth: 8,
          refused: (path, reason) => skipped.push({ what: join(cwd, dir, path), why: why(reason), kind: "file" }),
        },
      );
    } catch (error) {
      // The folder itself is not read (unreadable to this user): named, and the project's other folders still are.
      if (!(error instanceof WorkRefused)) throw error;
      skipped.push({ what: join(cwd, dir), why: why(error.reason), kind: "file" });
      continue;
    }
    for (const [name, paths] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!paths.includes(`${name}/SKILL.md`)) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "no SKILL.md: not a skill",
          kind: "file",
        });
        continue;
      }
      if (Object.keys(skills).some((path) => path.startsWith(`${name}/`))) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "a skill of this name was already taken from another folder",
          kind: "file",
        });
        continue;
      }
      // Every file is read again through the project, so a link anywhere on its way is refused, not followed.
      const held: Record<string, string> = {};
      for (const path of paths.sort()) {
        const found = await text(`${dir}/${path}`);
        if (found === undefined) continue;
        total += Buffer.byteLength(found);
        if (total > MAX_SKILL_BYTES) {
          skipped.push({
            what: join(cwd, dir, path),
            why: `the project's skill files are over ${MAX_SKILL_BYTES} bytes together`,
            kind: "file",
          });
          continue;
        }
        held[path] = found;
      }
      if (held[`${name}/SKILL.md`] === undefined) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "its SKILL.md was not read: not a skill",
          kind: "file",
        });
        continue;
      }
      Object.assign(skills, held);
    }
  }
  return { instructions, skills };
}

/** A turn's transcript entry, with the source's ids of the records it was read from (`record_uuids`): a later import counts
 *  a copy of them once. */
const message = (turn: Turn, model: string | undefined): { entry: typeof UserEntry; model: unknown; data?: unknown } => {
  const written = entryOf(turn, model);
  return turn.uuids?.length ? { ...written, data: { ...(written.data as object | undefined), record_uuids: turn.uuids } } : written;
};

const entryOf = (turn: Turn, model: string | undefined): { entry: typeof UserEntry; model: unknown; data?: unknown } => {
  if (turn.role === "user")
    return {
      entry: UserEntry,
      model: {
        role: "user",
        content: [{ type: "text", text: turn.text }],
        timestamp: turn.at,
      },
    };
  // The harness's own line, as an interrupt is written: a user's entry, by its author, so no request.
  if (turn.role === "note")
    return {
      entry: UserEntry,
      model: { role: "user", content: [{ type: "text", text: turn.text }], timestamp: turn.at },
      data: { author: turn.author },
    };
  if (turn.role === "toolResult")
    return {
      entry: ToolResultEntry as unknown as typeof UserEntry,
      model: {
        role: "toolResult",
        toolCallId: turn.callId,
        toolName: turn.name,
        content: [{ type: "text", text: turn.text }],
        isError: turn.isError,
        timestamp: turn.at,
      },
      data: { diagnostics: [] },
    };
  const [provider, ...id] = (turn.model ?? model ?? "imported/unknown").split("/");
  const cost = turn.costUsd;
  // A request the source gave no counts for keeps zeros, which a run's metrics read as unmetered, never as 0 tokens.
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    entry: AssistantEntry as unknown as typeof UserEntry,
    model: {
      role: "assistant",
      content: turn.error !== undefined ? [] : [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...turn.calls],
      api: "imported",
      provider,
      model: id.join("/") || provider,
      // The source's own id for the response: a later import counts it once, whichever file holds it.
      ...(turn.key ? { responseId: turn.key } : {}),
      // No total when the source did not price the request: the timeline's sum is then unknown, never this request at 0.
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: cost === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      // A failed request's zero counts are its counts, as a live run's failed request's are.
      ...(turn.error !== undefined ? { stopReason: "error", errorMessage: turn.error } : { stopReason: turn.calls.length ? "toolUse" : "stop" }),
      timestamp: turn.at,
    },
  };
};

/** The entries `message` makes of a session's turns, as a transcript holds them. */
const entriesOf = (session: Session): EntryLike[] =>
  session.turns.map((turn) => {
    const { entry, model, data } = message(turn, session.model);
    return { kind: entry.kind, model: [model], ...(data ? { data } : {}) } as EntryLike;
  });

/** What a session read whole used, its subagents' requests with it, and when it asked: its metrics and time at work,
 *  and its own requests by hour. */
function measured(session: Session, children: readonly Session[] = []): Pick<Found, "metrics" | "hours"> {
  return {
    metrics: { ...metricsOf(session, children), activeMs: session.activeMs },
    hours: hoursOf(session.turns.flatMap((turn) => (turn.role === "assistant" ? [turn.at] : []))),
  };
}

/** The run's transcript, into a store file at `storePath`, each string with the environment's key values cut out, its
 *  subagents' requests after its own turns (subagentMarks); the entries written, read back as the run's own timeline
 *  reads them. */
async function writeTimeline(storePath: string, session: Session, cut: (value: unknown) => unknown, children: readonly Session[] = []): Promise<EntryLike[]> {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const storage = await openNodeSqliteStorage(storePath);
  // No model is asked anything: the catalog is only what opening a Harness takes.
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, ctx);
  try {
    await harness.root(ctx);
    await harness.commit(async (tx) => {
      for (const turn of session.turns) {
        const { entry, model, data } = message(turn, session.model);
        await tx.appendEntry(entry, ROOT_CONVERSATION_ID, {
          model: [cut(model) as never],
          ...(data ? { data: data as never } : {}),
        });
      }
      for (const { kind, data } of subagentMarks(children)) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data: cut(data) as never });
    }, ctx);
  } finally {
    await harness.close(ctx);
  }
  // A rollback journal, not WAL: the transcript never changes again, and a reader of a WAL file leaves -wal and -shm
  // beside it, where nothing else may move.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(storePath);
  let entries: EntryLike[];
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    entries = (db.prepare("SELECT record FROM entries ORDER BY id").all() as { record: string }[]).map((row) => JSON.parse(row.record) as EntryLike);
  } finally {
    db.close();
  }
  // The owner's only, whatever the umask made it.
  for (const file of [storePath, `${storePath}-wal`, `${storePath}-shm`])
    await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  return entries;
}

/** What a run's requests cost at the catalog's list prices, each at its own provider's entry for its model: undefined when
 *  one request's tokens are unknown or its provider does not list its model (the request was served at a price no one
 *  lists here). A provider's $0 entry is $0. A request of no tokens costs nothing at any price. */
async function estimateOf(entries: readonly EntryLike[], catalog: () => Promise<ReadonlyMap<string, readonly Listed[]>>): Promise<number | undefined> {
  // Unknown when one answer priced here has unknown tokens (a failed one's counts are its own, as runMetricsOf reads them).
  if (runMetricsOf(entries.filter((entry) => entry.kind === "pi.assistant")).unmetered > 0) return undefined;
  const { calculateCost } = await import("@earendil-works/pi-ai");
  let total = 0;
  for (const entry of entries) {
    const answer = entry.kind === "pi.assistant" ? (entry.model?.[0] as { provider?: string; model?: string; usage?: Record<string, number> } | undefined) : undefined;
    if (!answer?.usage) continue;
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h } = answer.usage;
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const cost = answer.provider && answer.model ? (await catalog()).get(answer.model)?.find((entry) => entry.provider === answer.provider)?.cost : undefined;
    if (!cost) return undefined;
    const usage = { input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}), totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    total += calculateCost({ cost } as never, usage).total;
  }
  return Math.round(total * 1e6) / 1e6;
}

/** The revision of `harness` an earlier import made for the agent, else a new one (current when the agent is new). */
async function revisionFor(
  store: AgentStore,
  agentId: string,
  source: Source,
  files: {
    instructions: Record<string, string>;
    skills: Record<string, string>;
  },
  model: string | undefined,
  cut: Cut,
  current: boolean,
): Promise<Revision> {
  const note = `imported from ${source}`;
  const held = store.readAgent(agentId)?.revisions.find((r) => r.note === note);
  if (held) return held;
  const harness = HARNESS_OF[source];
  const instructions = INSTRUCTIONS[harness]!.map((name) => files.instructions[name]).find((text) => text !== undefined) ?? "";
  const revision: NewRevision = {
    kind: "agentic",
    instructions: cut(instructions),
    skills: keptSkills(files.skills, cut),
    tools: [],
    ...(model ? { model } : {}),
    ...(harness !== "pi" ? { harness } : {}),
    note,
  };
  return store.commitRevision(agentId, revision, { setCurrent: current });
}

/** A run's serve.json: its title and input, and the session file it was read from, as read. */
async function writeMeta(dir: string, session: Session, read: SourceFile, json: (value: unknown) => unknown): Promise<void> {
  const meta = json({
    // Cut before it is clipped: a key the clip cut short would match no rule.
    title: clip(json(session.firstPrompt ?? `${session.source} session`) as string, 120),
    created_at: session.startedAt ?? new Date(0).toISOString(),
    input: { content: session.firstPrompt ?? "" },
  }) as Record<string, unknown>;
  const metaPath = join(dir, RUN_META);
  // Whole or not there: a server that runs beside this import reads its runs' serve.json files.
  await writeDurable(metaPath, `${JSON.stringify({ ...meta, source_file: read })}\n`, 0o600, undefined, true);
}

/** The secrets this server made and keeps in data directory `data`, by value: its API token (`ar_local_...`) and its
 *  door token (server.ts), its sign-in sessions' secret (owner.ts), its webhook's signing secret (`whsec_...`;
 *  webhooks.ts) and every value a trigger source keeps sealed (sealed-settings.ts), opened with the seal key of `env`, so left out when that key is not there. One pasted into a session is
 *  this server's own, so an import cuts it wherever it is, as it cuts the environment's keys. Not among them: a run's own
 *  door token (one file a run; not read at each import), and a key-shaped value this server did not make (a `whsec_`
 *  from elsewhere). A webhook secret that does not open is said to `say`, as ToolKeys says a saved key that does not:
 *  the import goes on, and does not cut it. */
export function ownSecrets(data: string, env: NodeJS.ProcessEnv, say: (fields: Record<string, string>) => void = () => {}): string[] {
  return openServerSecrets(data, env, TRIGGER_ADAPTERS, say).secrets.values();
}

/** The plan, into `store`: the agents it does not hold, and the runs it does not. A run an earlier import made whose
 *  transcript never landed (the process stopped between the two) has it written now. */
export async function runImport(store: AgentStore, plan: Plan, options: ImportOptions): Promise<ImportReport> {
  const cut = secretCut([options.env, options.stored ?? {}], SECRET_NAMES);
  const { text, json } = cut;
  // Each key found is the import's to cut, and the CLI's to cut out of what it prints.
  const add = (keys: readonly string[]) => (cut.add(keys), options.onKeys?.(keys));
  // This server's own secrets, then every key the import finds.
  add(options.own ?? []);
  const report: ImportReport = { agents: [], skipped: [...plan.skipped], already: plan.already };
  let prices: Promise<Map<string, Listed[]>> | undefined;
  const catalog = () => (prices ??= catalogPrices());
  const held = importedIn(store);
  // Every key of the import is known before anything of it is written.
  const known = await findKeys(plan, add, text, (listed) => {
    const run = held.get(`${listed.source}:${listed.id}`);
    return run !== undefined && existsSync(store.runStorePath(run));
  }, options.signal);
  const scannedAs = known.stamps;
  for (const project of plan.projects) {
    if (options.signal?.aborted) break;
    const created = !store.readAgent(project.agentId);
    const files = await projectFiles(project.cwd, report.skipped);
    // Its own text read through secretlint again only if it changed since the pass above.
    const textNow = projectText(project.cwd, files);
    if (hash(textNow) !== known.texts.get(project.agentId)) add(await secretsIn(textNow));
    if (created)
      store.createAgent({
        id: project.agentId,
        name: keptName(project, text),
        description: text(project.cwd),
      });
    const byStart = [...project.sessions].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const latest = byStart.at(-1)!;
    // The latest session's harness is the agent's current revision; its model, each harness's latest.
    const revisions = new Map<Source, Revision>();
    const order = [...new Set(project.sessions.map((s) => s.source))].sort((a, b) => (a === latest.source ? 1 : 0) - (b === latest.source ? 1 : 0));
    for (const source of order) revisions.set(source, await revisionFor(store, project.agentId, source, files, byStart.findLast((s) => s.source === source && s.model)?.model, text, created && source === latest.source));
    const line = { id: project.agentId, name: project.name, cwd: project.cwd, created, runs: 0, already: 0, finished: 0 };
    // A record or response counted once across the import's files, those its runs here hold already included.
    const seen = await seenIn(store, project.agentId);
    for (const files of byRun(project.sessions)) {
      if (options.signal?.aborted) break;
      const listed = files[0]!;
      const heldRun = held.get(`${listed.source}:${listed.id}`);
      if (heldRun !== undefined && existsSync(store.runStorePath(heldRun))) {
        line.already += 1;
        continue;
      }
      // Each of its files, in order. The first's size and time before its read: a file that changes during it is read
      // again next time.
      const parts: Session[] = [];
      // Every file of it read: one holding only copies adds no records, but its subagents' folder is read with the rest.
      const searched: Session[] = [];
      let read: SourceFile | undefined;
      let changed = false;
      for (const { file } of files) {
        const stats = await stat(file).catch(() => null);
        const part = stats ? await readSession(file, listed.source, { seen: seen(listed.source) }).catch((error: unknown) => void report.skipped.push(unread(file, error))) : void report.skipped.push({ what: file, why: "gone since it was listed", kind: "vanished" });
        if (!part || !stats) continue;
        searched.push(part);
        // A file of it holding only copies adds nothing to it.
        if (heldRun === undefined && ownless(part)) {
          report.skipped.push({ what: file, why: "holds only records of sessions imported already", kind: "copies" });
          continue;
        }
        read ??= { path_sha256: hash(file), size: stats.size, mtime_ms: stats.mtimeMs };
        parts.push(part);
        if (scannedAs.get(file) !== stampOf(stats)) changed = true;
      }
      if (!read) continue;
      const session = merged(parts);
      // A file of it changed since the scan above (a session still being written): what it holds now, read through
      // secretlint again before any of it is cut.
      if (changed) add(await keysInSessions(parts));
      // Its id as the plan keeps it (a key in it is one secretlint finds in what was read, the id among it); one
      // holding a key counts among the keys removed.
      const keptAs = text(session.id) === session.id ? session.id : redactedId(session.id);
      session.id = keptAs;
      const subagents = await readChildren(plan, session, searched, seen(listed.source));
      const moved = await Promise.all(subagents.map(async (child) => scannedAs.get(child.file) !== stampOf((await stat(child.file).catch(() => null)) ?? { size: -1, mtimeMs: -1 })));
      if (moved.some(Boolean)) add(await keysInSessions(subagents));
      // The transcript is whole before its run is: written beside the store, then moved into the run's directory.
      const pending = join(store.dir, `.import-${randomUUID()}.sqlite`);
      let started: { runId: string; dir: string; storePath: string } | undefined;
      try {
        // Its subagents' requests are the run's too: marked in its transcript, so its timeline's usage row counts what its
        // metrics do, one number for the run.
        const entries = await writeTimeline(pending, session, json, subagents);
        const metrics: StoredMetrics = { ...withChildren(runMetricsOf(entries), subagents.map((child) => runMetricsOf(entriesOf(child)))), activeMs: session.activeMs, ...(session.effort ? { effort: session.effort } : {}) };
        // A session its source did not price: the catalog's estimate, beside its cost (unknown), never written as it.
        const estimate = session.costUsd === undefined ? await estimateOf([...entries, ...subagents.flatMap(entriesOf)], catalog) : undefined;
        if (estimate !== undefined) Object.assign(metrics, { costUsdEst: estimate, costBasis: "catalog" });
        if (heldRun !== undefined) {
          // Its folders as the store makes a run's: never through a link (a link there refuses the import).
          started = store.runFolders(heldRun);
        } else {
          const answer = session.turns.findLast((t) => t.role === "assistant" && t.text)?.text;
          started = await store.importRun({
            agent: project.agentId,
            revision: revisions.get(session.source)!.id,
            state: session.state,
            startedAt: session.startedAt ?? new Date(0).toISOString(),
            endedAt: session.endedAt ?? session.startedAt ?? new Date(0).toISOString(),
            ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
            ...((answer ?? session.firstPrompt) ? { summary: text(answer ?? session.firstPrompt!) } : {}),
            source: session.source,
            session: session.id,
            metrics,
          });
        }
        if (started) await rename(pending, started.storePath);
      } finally {
        await rm(pending, { force: true });
      }
      if (!started) {
        line.already += 1;
        continue;
      }
      await writeMeta(started.dir, session, read, json);
      if (heldRun !== undefined) line.finished += 1;
      else line.runs += 1;
    }
    report.agents.push(line);
  }
  report.secretsRemoved = text.removed;
  return report;
}

const counted = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
// What each kind of left-out file is, counted: sessions first by how many, a project's files apart.
const LEFT_OUT: Record<LeftOut, (n: number) => string> = {
  gone: (n) => `${counted(n, "session")} from folders that no longer exist`,
  temp: (n) => `${counted(n, "session")} from temp folders`,
  live: (n) => `${counted(n, "session")} still being written: ${n === 1 ? "it comes" : "they come"} in next time`,
  "no-words": (n) => `${counted(n, "session")} with no message of yours`,
  "no-project": (n) => `${counted(n, "file")} that ${n === 1 ? "is not a session" : "are not sessions"} (no project folder in ${n === 1 ? "it" : "them"})`,
  large: (n) => `${counted(n, "session")} over ${MAX_SESSION_BYTES / 1024 / 1024} MB`,
  unread: (n) => `${counted(n, "session file")} that could not be read`,
  vanished: (n) => `${counted(n, "session file")} gone since ${n === 1 ? "it was" : "they were"} counted`,
  copies: (n) => `${counted(n, "file")} holding only copies of sessions imported already`,
  file: (n) => `${counted(n, "project file")} not copied (a link, not text, over its size cap, or a folder with no SKILL.md)`,
};
/** What an import left out, by why: one group per kind, the most first (a project's files last), each counted in words
 *  ("84 sessions from folders that no longer exist"): a session by its id where the file was read, so one of two files
 *  counts once, else each file. */
export function leftOutOf(skipped: readonly Pick<Skipped, "kind" | "what" | "session">[]): { kind: LeftOut; count: number; label: string }[] {
  const seen = new Map<LeftOut, Set<string>>();
  for (const { kind, what, session } of skipped) seen.set(kind, (seen.get(kind) ?? new Set()).add(session ?? `file:${what}`));
  const by = new Map([...seen].map(([kind, ids]) => [kind, ids.size] as const));
  const order = Object.keys(LEFT_OUT) as LeftOut[];
  return [...by]
    .sort(([a, x], [b, y]) => Number(a === "file") - Number(b === "file") || y - x || order.indexOf(a) - order.indexOf(b))
    .map(([kind, count]) => ({ kind, count, label: LEFT_OUT[kind](count) }));
}
// How the CLI brings a kind in, when one of its flags does.
const BRING_IN: Partial<Record<LeftOut, string>> = { gone: "--include-deleted", temp: "--all", "no-words": "--all" };
/** The CLI's left-out lines: each group (leftOutOf), with the flag that imports it too. */
const leftOutLines = (skipped: readonly Skipped[]): string[] => leftOutOf(skipped).map(({ kind, count, label }) => `left out: ${label}${BRING_IN[kind] ? ` (${BRING_IN[kind]} imports ${count === 1 ? "it" : "them"} too)` : ""}`);

/** The plan as a person reads it: one line per project, its sessions counted as the import takes them, then (`verbose`)
 *  each file left out and why. */
export function describePlan(plan: Plan, store?: AgentStoreReader, { verbose = false }: { verbose?: boolean } = {}): string[] {
  const held = store ? importedIn(store) : undefined;
  const lines = plan.projects.map((project) => {
    const sessions = sessionsOf(project.sessions);
    const by = new Map<string, number>();
    for (const s of sessions) by.set(s.source, (by.get(s.source) ?? 0) + 1);
    const already = held ? sessions.filter((s) => held.has(s.key)).length : 0;
    const priced = sessions.filter((s) => s.priced).length;
    return `${project.cwd}  ${[...by].map(([source, n]) => `${source} ${n}`).join(", ")}  cost known ${priced}/${sessions.length}${already ? `  already imported ${already}` : ""}`;
  });
  return [...lines, ...(plan.already ? [`already imported, unchanged: ${plan.already} session files`] : []), ...(verbose ? plan.skipped.map((s) => `skipped ${s.what}: ${s.why}`) : [])];
}

/** `agentrun-serve import ARGS`: its exit code. */
export async function importCommand(
  args: string[],
  usage: string,
  {
    home = homedir(),
    // The folder whose projects are left out as temporary (the OS's temp directory).
    temp = tmpdir(),
    // The server's own keys, which its start moved out of process.env (secrets.ts), read back in: the import cuts them
    // out of what it keeps, as it cuts every other key in the environment.
    env = withSecrets(process.env),
    out = console.log,
  }: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
    temp?: string;
  } = {},
): Promise<number> {
  // What it prints goes through the cut what it keeps does, with the keys secretlint finds in the lines themselves: a
  // file or project named after a key is printed cut. The lines are held until the end, then scanned and printed.
  const printed = secretCut(env, SECRET_NAMES);
  const print = out;
  const lines: string[] = [];
  out = (line: string) => void lines.push(line);
  // What it says on stderr (a key or a secret that does not open here, its file named) is held and cut the same way, and
  // printed first.
  const warnings: string[] = [];
  const say = (event: string) => (fields: Record<string, string>) => void warnings.push(`agentrun-serve import: ${logLine(event, fields)}`);
  const flush = async () => {
    printed.add(await secretsIn([...warnings, ...lines].join("\n")));
    for (const line of warnings.splice(0)) console.error(printed.text(line));
    for (const line of lines.splice(0)) print(printed.text(line));
  };
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: {
          data: { type: "string" },
          from: { type: "string" },
          "dry-run": { type: "boolean" },
          all: { type: "boolean" },
          "include-deleted": { type: "boolean" },
          verbose: { type: "boolean" },
          port: { type: "string" },
        },
      }));
    } catch (error) {
      console.error(`${(error as Error).message}\n\n${usage}`);
      return 2;
    }
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      console.error(`--port takes a port number\n\n${usage}`);
      return 2;
    }
    const open = openAt(env, port);
    const sources = values.from === undefined ? SOURCES : values.from.split(",").map((s) => s.trim());
    const unknown = sources.filter((s) => !(SOURCES as readonly string[]).includes(s));
    if (unknown.length) {
      console.error(`--from takes ${SOURCES.join(", ")}: not ${unknown.join(", ")}\n\n${usage}`);
      return 2;
    }
    const dir = values.data ?? defaultData({ ...env, HOME: home });
    // The tool keys the server keeps in this directory, opened here on the host with the seal key this process was handed:
    // an imported transcript keeps none of them. One that does not open is not known here, so not cut: said, as the
    // server says it at its start.
    const keys = new ToolKeys(dir, env, say("tool_keys"));
    keys.view();
    const options: ImportOptions = {
      home,
      sources: sources as Source[],
      all: values.all === true,
      deleted: values["include-deleted"] === true,
      temp,
      env,
      stored: keys.values(),
      own: ownSecrets(dir, env, say("webhook_secret")),
    };
    // What it prints is cut with the saved keys too, and with every key the import (or the dry run) finds, as what it
    // keeps is.
    printed.add(Object.values(options.stored ?? {}));
    options.onKeys = (keys) => printed.add(keys);
    if (values["dry-run"]) {
      // A dry run writes nothing, not even a store: one there already is only read.
      const reader = existsSync(join(dir, STORE_FILE)) ? openStoreReader(dir) : undefined;
      let plan: Plan;
      let found: Found[];
      try {
        plan = await planImport({ ...options, measure: true }, reader);
        for (const line of describePlan(plan, reader, { verbose: values.verbose === true })) out(line);
        found = [...plan.found!, ...(reader ? await foundAll(reader, plan.held) : []), ...(await untiedFound(plan))];
      } finally {
        reader?.close();
      }
      out(`${plan.projects.length} projects, ${sessionsOf(plan.projects.flatMap((p) => p.sessions)).length} sessions; nothing was written (dry run)`);
      if (plan.secretsFound !== undefined) out(`${plan.secretsFound} secret${plan.secretsFound === 1 ? "" : "s"} would be removed`);
      for (const line of leftOutLines(plan.skipped)) out(line);
      for (const line of summaryLines(found, open, { dryRun: true })) out(line);
      return 0;
    }
    const store = openStore(dir);
    try {
      const plan = await planImport(options, store);
      const report = await runImport(store, plan, options);
      for (const agent of report.agents) out(`${agent.cwd}  ${agent.created ? "new agent" : "agent held"} ${agent.id}  imported ${agent.runs}${agent.finished ? `, finished ${agent.finished}` : ""}${agent.already ? `, already imported ${agent.already}` : ""}`);
      if (report.already) out(`already imported, unchanged: ${report.already} session files (not read again)`);
      if (values.verbose) for (const s of report.skipped) out(`skipped ${s.what}: ${s.why}`);
      out(`${report.agents.length} agents, ${report.agents.reduce((n, a) => n + a.runs, 0)} runs imported into ${dir}`);
      out(`${report.secretsRemoved ?? 0} secret${report.secretsRemoved === 1 ? "" : "s"} removed`);
      for (const line of leftOutLines(report.skipped)) out(line);
      // Every session found: those imported now, those held before, and those whose file an earlier import read whole.
      const held = importedIn(store);
      const runs = [...plan.projects.flatMap((p) => p.sessions.flatMap((s) => held.get(`${s.source}:${s.id}`) ?? [])), ...plan.held];
      for (const line of summaryLines([...(await foundAll(store, runs)), ...(await untiedFound(plan))], open)) out(line);
      return 0;
    } finally {
      store.close();
    }
  } finally {
    await flush();
  }
}

/** The imported runs `runIds` of `store`, each once, as found. */
async function foundAll(store: AgentStoreReader, runIds: readonly string[]): Promise<Found[]> {
  const found: Found[] = [];
  for (const id of new Set(runIds)) {
    const run = await foundIn(store, id);
    if (run) found.push(run);
  }
  return found;
}

/** The address the summary's Open line names on this machine: the one a local server listens on by default. */
const LOCAL = "127.0.0.1"; // key-gate: loopback-rule the default address a server on this machine listens on; a hint printed, the line dials nothing

/** Where a person opens the console: the server's public address when one is set (as the server takes it), else this
 *  machine's at `port`. A hint after an import, not a server setting. */
function openAt(env: NodeJS.ProcessEnv, port: number): string {
  const given = env.AGENTRUN_PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  const parsed = given && URL.canParse(given) ? new URL(given) : undefined;
  if (parsed && /^https?:$/.test(parsed.protocol)) return parsed.href.replace(/\/+$/, "");
  return `http://${LOCAL}:${port === 0 ? "<the port the server picks>" : port}`;
}

/** A cut as `secretCut` makes it: its `probe` cuts the same and counts nothing. */
type Cut = ((text: string) => string) & { probe?: (text: string) => string };

/** The "/"-segments of `path` a key touches (by their index): each whose blanking takes a key out of the path. Blanked
 *  with spaces, which end every shape and are in no environment's key; the blanked paths are never kept, so they go
 *  through the cut's probe, which counts nothing (a shorter value a blank leaves is no key removed). */
function touchedSegments(path: string, cut: Cut): number[] {
  const out = cut(path);
  if (out === path) return [];
  const probe = cut.probe ?? cut;
  const keys = (text: string) => probe(text).split(REDACTED).length;
  const held = out.split(REDACTED).length;
  const parts = path.split("/");
  return parts.flatMap((segment, at) => (keys([...parts.slice(0, at), " ".repeat(segment.length), ...parts.slice(at + 1)].join("/")) < held ? [at] : []));
}

/** A project's skills as an import keeps them: each file's text cut, and its path as it is when it holds no key. Else
 *  every segment a key touches (one, or several when an environment's value holds "/") is kept as `redacted-` and a hash
 *  of it (as `keptId` keeps a session's id), so two folders named after two keys stay two and no part of a key is left.
 *  A folder kept so is kept so for every file under it, so a skill's files stay one skill. */
function keptSkills(skills: Record<string, string>, cut: Cut): Record<string, string> {
  const redacted = (segment: string) => `redacted-${hash(segment).slice(0, 12)}`;
  // The folders (and files) a key touches, by their path from the skills' root.
  const touched = new Set<string>();
  for (const path of Object.keys(skills)) {
    const parts = path.split("/");
    for (const at of touchedSegments(path, cut)) touched.add(parts.slice(0, at + 1).join("/"));
  }
  return Object.fromEntries(
    Object.entries(skills).map(([path, text]) => {
      const parts = path.split("/");
      const kept = parts.map((segment, at) => (touched.has(parts.slice(0, at + 1).join("/")) ? redacted(segment) : segment)).join("/");
      return [cut(kept) === kept ? kept : redacted(path), cut(text)];
    }),
  );
}

/** A project's name as an import keeps it (its folder's name): cut, or kept as `redacted-` and a hash of it when a key
 *  touches it, one across the project's path ending in it among them, so no part of the key is left in the name. */
function keptName(project: { cwd: string; name: string }, cut: Cut): string {
  const parts = project.cwd.split("/");
  const last = parts.length - 1;
  return parts[last] === project.name && touchedSegments(project.cwd, cut).includes(last) ? `redacted-${hash(project.name).slice(0, 12)}` : cut(project.name);
}
