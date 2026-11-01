// `agentrun-serve import`: the Claude Code, Codex and pi sessions under a person's own home, into this server's agent
// store, once, when asked. Each project directory is one agent; each harness seen in it one revision of that agent, its
// instructions the project's CLAUDE.md or AGENTS.md and its skills the project's skill folders; each session one run,
// ended as it ended, its transcript the run's timeline. An imported run is history: it takes no message, stop or cancel.
// Nothing leaves the machine, every string written has the environment's key values cut out, and every file written is
// the owner's only. Read again, it imports only the sessions it has not.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, ROOT_CONVERSATION_ID, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type AgentStore, type AgentStoreReader, type NewRevision, openStore, openStoreReader, type Revision, STORE_FILE, type StoredMetrics } from "@parcha/pi-durable-agent";
import { type EntryLike, type RunMetrics, runMetricsOf } from "@parcha/pi-durable-agent/timeline";
import { readJson, RUN_META } from "./files.js";
import { HARNESS_OF, readSession, type Session, SOURCES, type Source, sessionFiles, type Turn } from "./import-sources.js";
import { type Found, foundIn, hoursOf, summaryLines } from "./import-summary.js";
import { catalogPrices, type Listed } from "./model.js";
import { DEFAULT_PORT } from "./server.js";
import { secretCut } from "./secret-cut.js";
import { type RefusedReason, readWorkBytes, WorkRefused, walkWork } from "./workspace.js";

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
  /** The environment whose key-shaped values are cut out of everything written. */
  env: NodeJS.ProcessEnv;
  now?: number;
  /** The temp directory whose projects are left out (default the OS's). */
  temp?: string;
  /** Read each session's turns while planning, and measure it (`Plan.found`): what a dry run's summary counts. */
  measure?: boolean;
};
export type Skipped = { what: string; why: string };
export type ProjectPlan = {
  cwd: string;
  agentId: string;
  name: string;
  sessions: Session[];
};
/** `already`: the session files an earlier import took whole, left unread; `held`, the runs an import would not take
 *  again: theirs, and (when measuring) those of planned sessions the store holds already. `found`: each other planned
 *  session measured, when the plan was made to (`measure`). */
export type Plan = { projects: ProjectPlan[]; skipped: Skipped[]; already: number; held: string[]; found?: Found[] };
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
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
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
    const meta = (await readJson(join(store.dir, "runs", run.id, RUN_META))) as { source_file?: SourceFile } | null;
    const seen = meta?.source_file;
    if (seen && typeof seen.path_sha256 === "string" && typeof seen.size === "number" && typeof seen.mtime_ms === "number") out.set(seen.path_sha256, { ...seen, run: run.id });
  }
  return out;
}
const unread = (file: string, error: unknown): Skipped => ({ what: file, why: `not read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What an import would take: the sessions under `home`, by project, with what it leaves out and why. Keeps no turns
 *  (with `measure`, only until each session is measured), and reads no file `store`'s imports already read whole and
 *  that has not changed since. */
export async function planImport({ home, sources = SOURCES, all = false, now = Date.now(), temp: tempDir = tmpdir(), measure = false }: ImportOptions, store?: AgentStoreReader): Promise<Plan> {
  const skipped: Skipped[] = [];
  const seen = store ? await filesIn(store) : new Map<string, SourceFile & { run: string }>();
  let already = 0;
  const held: string[] = [];
  const found: Found[] = [];
  // A session the store holds already is counted from its run, as the import would count it, not from its file now.
  const heldBy = measure && store ? importedIn(store) : undefined;
  const projects = new Map<string, ProjectPlan>();
  const temps = [...new Set([tempDir, await realpath(tempDir).catch(() => tempDir)])];
  for (const source of sources) {
    for (const file of await sessionFiles(home, source)) {
      const stats = await stat(file).catch(() => null);
      if (!stats) continue;
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
        });
        continue;
      }
      if (stats.size > MAX_SESSION_BYTES) {
        skipped.push({ what: file, why: `over ${MAX_SESSION_BYTES} bytes` });
        continue;
      }
      // One file this user cannot read, or one gone since its stat, is named and passed over: the rest still import.
      const session = await readSession(file, source, { turns: measure }).catch((error: unknown) => void skipped.push(unread(file, error)));
      if (!session) continue;
      if (session.child) continue;
      if (!session.cwd) {
        skipped.push({ what: file, why: "no project directory in it" });
        continue;
      }
      if (!all && session.users === 0) {
        skipped.push({ what: file, why: "no message of the person's" });
        continue;
      }
      const cwd = session.cwd;
      if (!all) {
        const there = await lstat(cwd).catch(() => null);
        if (!there?.isDirectory()) {
          skipped.push({ what: file, why: `its project ${cwd} is gone` });
          continue;
        }
        if (temps.some((temp) => cwd === temp || cwd.startsWith(temp + sep))) {
          skipped.push({
            what: file,
            why: `its project ${cwd} is a temp directory`,
          });
          continue;
        }
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
      project.sessions.push(session);
      if (measure) {
        const run = heldBy?.get(`${source}:${session.id}`);
        if (run !== undefined) held.push(run);
        else found.push({ source, agent: project.agentId, ...measured(session) });
        session.turns = [];
      }
    }
  }
  for (const project of projects.values()) project.sessions.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  return {
    projects: [...projects.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)),
    skipped,
    already,
    held,
    ...(measure ? { found } : {}),
  };
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
  // A project kept by --all whose directory is gone has neither.
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
      if (decoded === undefined) skipped.push({ what: join(cwd, rel), why: "not text" });
      return decoded;
    } catch (error) {
      if (!(error instanceof WorkRefused)) throw error;
      if (error.reason !== "missing") skipped.push({ what: join(cwd, rel), why: why(error.reason) });
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
          refused: (path, reason) => skipped.push({ what: join(cwd, dir, path), why: why(reason) }),
        },
      );
    } catch (error) {
      // The folder itself is not read (unreadable to this user): named, and the project's other folders still are.
      if (!(error instanceof WorkRefused)) throw error;
      skipped.push({ what: join(cwd, dir), why: why(error.reason) });
      continue;
    }
    for (const [name, paths] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!paths.includes(`${name}/SKILL.md`)) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "no SKILL.md: not a skill",
        });
        continue;
      }
      if (Object.keys(skills).some((path) => path.startsWith(`${name}/`))) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "a skill of this name was already taken from another folder",
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
          });
          continue;
        }
        held[path] = found;
      }
      if (held[`${name}/SKILL.md`] === undefined) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "its SKILL.md was not read: not a skill",
        });
        continue;
      }
      Object.assign(skills, held);
    }
  }
  return { instructions, skills };
}

const message = (turn: Turn, model: string | undefined): { entry: typeof UserEntry; model: unknown; data?: unknown } => {
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

/** What a session read whole used, and when it asked: its metrics and time at work, and its requests by hour. */
function measured(session: Session): Pick<Found, "metrics" | "hours"> {
  return {
    metrics: { ...runMetricsOf(entriesOf(session)), activeMs: session.activeMs },
    hours: hoursOf(session.turns.flatMap((turn) => (turn.role === "assistant" ? [turn.at] : []))),
  };
}

/** The run's transcript, into a store file at `storePath`, each string with the environment's key values cut out; the
 *  entries written, read back as the run's own timeline reads them. */
async function writeTimeline(storePath: string, session: Session, cut: (value: unknown) => unknown): Promise<EntryLike[]> {
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
async function estimateOf(entries: readonly EntryLike[], metrics: RunMetrics, catalog: () => Promise<ReadonlyMap<string, readonly Listed[]>>): Promise<number | undefined> {
  if (metrics.unmetered > 0) return undefined;
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
  cut: (text: string) => string,
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
    skills: Object.fromEntries(Object.entries(files.skills).map(([path, text]) => [path, cut(text)])),
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
    title: clip(session.firstPrompt ?? `${session.source} session`, 120),
    created_at: session.startedAt ?? new Date(0).toISOString(),
    input: { content: session.firstPrompt ?? "" },
  }) as Record<string, unknown>;
  const metaPath = join(dir, RUN_META);
  await writeFile(metaPath, `${JSON.stringify({ ...meta, source_file: read })}\n`, { mode: 0o600 });
  await chmod(metaPath, 0o600);
}

/** The plan, into `store`: the agents it does not hold, and the runs it does not. A run an earlier import made whose
 *  transcript never landed (the process stopped between the two) has it written now. */
export async function runImport(store: AgentStore, plan: Plan, options: ImportOptions): Promise<ImportReport> {
  const { text, json } = secretCut(options.env);
  const report: ImportReport = { agents: [], skipped: [...plan.skipped], already: plan.already };
  let prices: Promise<Map<string, Listed[]>> | undefined;
  const catalog = () => (prices ??= catalogPrices());
  const held = importedIn(store);
  for (const project of plan.projects) {
    const created = !store.readAgent(project.agentId);
    if (created)
      store.createAgent({
        id: project.agentId,
        name: text(project.name),
        description: text(project.cwd),
      });
    const files = await projectFiles(project.cwd, report.skipped);
    const latest = project.sessions.at(-1)!;
    // The latest session's harness is the agent's current revision; its model, each harness's latest.
    const revisions = new Map<Source, Revision>();
    const order = [...new Set(project.sessions.map((s) => s.source))].sort((a, b) => (a === latest.source ? 1 : 0) - (b === latest.source ? 1 : 0));
    for (const source of order) revisions.set(source, await revisionFor(store, project.agentId, source, files, project.sessions.findLast((s) => s.source === source && s.model)?.model, text, created && source === latest.source));
    const line = { id: project.agentId, name: project.name, cwd: project.cwd, created, runs: 0, already: 0, finished: 0 };
    for (const listed of project.sessions) {
      const heldRun = held.get(`${listed.source}:${listed.id}`);
      if (heldRun !== undefined && existsSync(store.runStorePath(heldRun))) {
        line.already += 1;
        continue;
      }
      // Its size and time before the read: a file that changes during it is read again next time.
      const stats = await stat(listed.file).catch(() => null);
      const session = stats ? await readSession(listed.file, listed.source).catch((error: unknown) => void report.skipped.push(unread(listed.file, error))) : void report.skipped.push({ what: listed.file, why: "gone since it was listed" });
      if (!session || !stats) continue;
      const read: SourceFile = { path_sha256: hash(listed.file), size: stats.size, mtime_ms: stats.mtimeMs };
      // The transcript is whole before its run is: written beside the store, then moved into the run's directory.
      const pending = join(store.dir, `.import-${randomUUID()}.sqlite`);
      let started: { runId: string; dir: string; storePath: string } | undefined;
      try {
        const entries = await writeTimeline(pending, session, json);
        const metrics: StoredMetrics = { ...runMetricsOf(entries), activeMs: session.activeMs, ...(session.effort ? { effort: session.effort } : {}) };
        // A session its source did not price: the catalog's estimate, beside its cost (unknown), never written as it.
        const estimate = session.costUsd === undefined ? await estimateOf(entries, metrics, catalog) : undefined;
        if (estimate !== undefined) Object.assign(metrics, { costUsdEst: estimate, costBasis: "catalog" });
        if (heldRun !== undefined) {
          started = { runId: heldRun, dir: join(store.dir, "runs", heldRun), storePath: store.runStorePath(heldRun) };
          if ((await mkdir(dirname(started.storePath), { recursive: true })) !== undefined) for (const made of [started.dir, dirname(started.storePath)]) await chmod(made, 0o700);
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
  return report;
}

/** The plan as a person reads it: one line per project, then what is left out and why. */
export function describePlan(plan: Plan, store?: AgentStoreReader): string[] {
  const held = store ? importedIn(store) : undefined;
  const lines = plan.projects.map((project) => {
    const by = new Map<string, number>();
    for (const s of project.sessions) by.set(s.source, (by.get(s.source) ?? 0) + 1);
    const already = held ? project.sessions.filter((s) => held.has(`${s.source}:${s.id}`)).length : 0;
    const priced = project.sessions.filter((s) => s.costUsd !== undefined).length;
    return `${project.cwd}  ${[...by].map(([source, n]) => `${source} ${n}`).join(", ")}  cost known ${priced}/${project.sessions.length}${already ? `  already imported ${already}` : ""}`;
  });
  return [...lines, ...(plan.already ? [`already imported, unchanged: ${plan.already} session files`] : []), ...plan.skipped.map((s) => `skipped ${s.what}: ${s.why}`)];
}

/** `agentrun-serve import ARGS`: its exit code. */
export async function importCommand(
  args: string[],
  usage: string,
  {
    home = homedir(),
    env = process.env,
    out = console.log,
  }: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
  } = {},
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        data: { type: "string" },
        from: { type: "string" },
        "dry-run": { type: "boolean" },
        all: { type: "boolean" },
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
  const dir = values.data ?? join(env.XDG_DATA_HOME || join(home, ".local", "share"), "agentrun", "agents");
  const options: ImportOptions = {
    home,
    sources: sources as Source[],
    all: values.all === true,
    env,
  };
  if (values["dry-run"]) {
    // A dry run writes nothing, not even a store: one there already is only read.
    const reader = existsSync(join(dir, STORE_FILE)) ? openStoreReader(dir) : undefined;
    let plan: Plan;
    let found: Found[];
    try {
      plan = await planImport({ ...options, measure: true }, reader);
      for (const line of describePlan(plan, reader)) out(line);
      found = [...plan.found!, ...(reader ? await foundAll(reader, plan.held) : [])];
    } finally {
      reader?.close();
    }
    out(`${plan.projects.length} projects, ${plan.projects.reduce((n, p) => n + p.sessions.length, 0)} sessions; nothing was written (dry run)`);
    for (const line of summaryLines(found, open, { dryRun: true })) out(line);
    return 0;
  }
  const store = openStore(dir);
  try {
    const plan = await planImport(options, store);
    const report = await runImport(store, plan, options);
    for (const agent of report.agents) out(`${agent.cwd}  ${agent.created ? "new agent" : "agent held"} ${agent.id}  imported ${agent.runs}${agent.finished ? `, finished ${agent.finished}` : ""}${agent.already ? `, already imported ${agent.already}` : ""}`);
    if (report.already) out(`already imported, unchanged: ${report.already} session files (not read again)`);
    for (const s of report.skipped) out(`skipped ${s.what}: ${s.why}`);
    out(`${report.agents.length} agents, ${report.agents.reduce((n, a) => n + a.runs, 0)} runs imported into ${dir}`);
    // Every session found: those imported now, those held before, and those whose file an earlier import read whole.
    const held = importedIn(store);
    const runs = [...plan.projects.flatMap((p) => p.sessions.flatMap((s) => held.get(`${s.source}:${s.id}`) ?? [])), ...plan.held];
    for (const line of summaryLines(await foundAll(store, runs), open)) out(line);
    return 0;
  } finally {
    store.close();
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
