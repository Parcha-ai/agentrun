// Learning. An agentic revision with `learning: auto` or `approve` gives its agent one bare git repository beside the agent
// store, `<data>/agents/<id>/learning.git`, opened through @parcha/pi-git-remote's local remote. The revision holds what a
// person wrote; the repository holds what the agent learned (notes, INDEX.md, the skills it wrote, workflow drafts, memos).
// Its main carries AGENTS.md and agent.json, which the host writes for the agent's current revision, so a clone made
// outside this server still reads as the agent's. Each run starts from main at one commit, which it journals in its own
// store, and gets a working copy of main at that commit, `<work>/.agent/repo`, which it changes with its own file tools.
// Once the run's end is carried back and its process has ended, the server harvests that copy into one commit on
// `runs/<run id>` (harvest.ts), recording it in `<data>/agents/<id>/learning/runs/<run id>.json`. Every write to an agent's
// repository goes through one queue per agent in this process; a run's process only reads, through a clone of its own.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentStoreReader, LearningMode, Revision, RunRow } from "@parcha/pi-durable-agent";
import type { AppContext, BeforeResume } from "@parcha/pi-durable-disk";
import { processAlive } from "@parcha/agentrun-adapters/host";
import type { GitIdentity, Repo } from "@parcha/pi-git-remote";
import { type AgentEntry, definitionOf, whenFree } from "./agents.js";
import { type HarvestResult, harvestWorktree } from "./harvest.js";
import { readJson, RUN_META } from "./files.js";
import { forModel } from "./result.js";
import { isObject } from "./validate.js";

const REPO = "learning.git";
/** The server's own clone of an agent's repository: under the agent's directory, never reachable from a run's work. */
const HOST_CLONE = "host.git";
/** A run's own clone, beside its store and outside its work, so no tool of the run can reach it. */
const RUN_CLONE = "learning.git";
const IDENTITY: GitIdentity = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The tools whose calls bring nothing from outside the run into it. Any other tool (`fetch_page`, the browser's, or one
 *  this list does not know) is external, and a run that called one is untrusted. `read` is here only because this
 *  server takes no uploads (capabilities `files.upload: false`), so a run has no input file to read: the change that
 *  turns uploads on must make a run that reads an input file untrusted. */
const TRUSTED_TOOLS = new Set(["read", "write", "edit", "ask_person"]);
/** The file tools of a learning run, whatever its revision names: every one works on the run's working copy only. */
export const LEARNING_TOOLS: readonly string[] = ["read", "write", "edit"];
/** The run's working copy of its agent's repository, under its work. */
export const WORKING_COPY = join(".agent", "repo");
/** The notes the run was seeded with, which its `<learned>` section points at: `read` reaches them too. */
const SEEDED_NOTES = join(".agent", "learnings");
/** Why a learning run's file tool `tool` may not take `path`, or undefined: it works on the run's working copy only
 *  (`read` on the seeded notes too). `path` is read as the tool reads it, against `work`; a link anywhere on the way is
 *  refused, never followed, so a link inside the copy cannot lead out of it. */
export async function copyRefusal(work: string, tool: string, path: string): Promise<string | undefined> {
  const roots = tool === "read" ? [WORKING_COPY, SEEDED_NOTES] : [WORKING_COPY];
  const refusal = `${tool} is the learning copy's only here: ${path} is outside ${roots.join(" and ")}`;
  const target = resolve(work, path);
  const rest = relative(work, target).split(sep);
  const inside = roots.some((root) => {
    const parts = root.split(sep);
    return rest.length > parts.length && parts.every((part, at) => rest[at] === part);
  });
  if (!inside) return refusal;
  for (let at = 1; at <= rest.length; at++) {
    const step = await lstat(join(work, ...rest.slice(0, at))).catch(() => undefined);
    if (!step) break;
    if (step.isSymbolicLink()) return refusal;
  }
  return undefined;
}

/** `tool`, refusing by name any call whose path is outside the run's working copy (`copyRefusal`), and run alone in its
 *  round. The check and the tool's own open are two steps. pi-durable runs a round's calls at once by default (1.1.0:
 *  `toolExecution` "parallel" at dist/harness/agent.js:46; startToolRound at dist/harness/generation.js:436-457), and one
 *  sequential tool makes its whole round sequential, so no other call of the round runs between the check and the open.
 *  That window is why the mode is here, not speed: it stays until these tools resolve their path on held directory
 *  handles (pi-durable-disk's confinement). No tool a learning run gets can make a link or start a process: a revision
 *  naming one is refused at save (runnable.ts). */
export function onCopyOnly<T extends ToolRegistration>(tool: T, work: string): T {
  return {
    ...tool,
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const path = isObject(args) && typeof args.path === "string" ? args.path : "";
      const refused = await copyRefusal(work, tool.name, path);
      if (refused) return forModel(refused, { isError: true });
      return tool.execute(args, api, context);
    },
  };
}

/** What a learning run is told about saving what it learned: where its working copy is, its memo, and the paths a
 *  harvest takes (agentrun-learn's layout). */
export function learningInstructions(runId: string): string {
  return [
    "<saving-learning>",
    `Your learning repository is checked out at ${WORKING_COPY}. Save what you learned there with your file tools, which work there only (read reaches ${SEEDED_NOTES} too). Once this run ends, the server commits what you changed there to the branch runs/${runId} for review; nothing else is kept.`,
    `- Your memo: ${WORKING_COPY}/memos/${runId}.md. Keep its front matter (the server writes it) and add, in this order, ## What happened, ## What I learned, ## What could be better, and ## Proposed changes, which lists every path you changed. A memo you leave as it is proposes nothing.`,
    `- A note: ${WORKING_COPY}/learnings/L-<12 lowercase hex digits>.md, one general rule. Its front matter holds id, type (lesson, fact or correction), status (active), runs ([${runId}]) and supersedes ([] or the notes it replaces); the rule follows it. Add one line for it to ${WORKING_COPY}/learnings/INDEX.md: - L-<id>: <the rule>.`,
    `- A skill: ${WORKING_COPY}/.agents/skills/<name>/SKILL.md. A workflow draft: ${WORKING_COPY}/workflows/<name>/workflow.json with its README.md.`,
    "- AGENTS.md and agent.json are your rules and definition, never changed here; any other path is left out.",
    "Never put names, ids or data from this case, or any key, token or password, in these files: a change that holds one is refused whole.",
    "</saving-learning>",
  ].join("\n");
}

/** A name a learning revision could give before learning had file tools: accepted there, and binds nothing. */
export const LEARN_NAME = "learn";
/** Beside the run's work, written before its working copy is laid out: a run with it and no copy lost the copy, one
 *  without it ended before working copies existed. */
const COPY_MARK = "learning.copy";
/** A skill the agent wrote, at `.agents/skills/<name>/SKILL.md` on main. */
const LEARNED_SKILL = /^\.agents\/skills\/([a-z0-9][a-z0-9._-]{0,63})\/SKILL\.md$/;
/** The variables whose values are this host's secrets, which no learning may hold. */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;
/** A value under 8 characters is not checked: it is a placeholder or no secret (a gateway's `AGENT_MODEL_API_KEY=none`),
 *  checking it would refuse ordinary words such as "none", and the guard refuses every write while it is given one. 8 is
 *  pi-browser's redaction floor too. */
const MIN_SECRET = 8;

/** pi-git-remote's floor. */
const MIN_GIT = [2, 40] as const;
const gitChecks = new Map<string, Promise<string | undefined>>();

/** Why this host cannot keep a learning repository, or undefined when it can: git `MIN_GIT` or later on `env`'s PATH. */
export function learningBlocker(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const key = env.PATH ?? "";
  let check = gitChecks.get(key);
  if (!check) {
    const floor = MIN_GIT.join(".");
    check = promisify(execFile)("git", ["--version"], { env }).then(
      ({ stdout }) => {
        const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(stdout) ?? []).slice(1).map(Number);
        return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]) ? undefined : `Learning needs git ${floor} or later, and this host has ${stdout.trim()}.`;
      },
      () => `Learning needs git ${floor} or later on PATH, and this host has none.`,
    );
    gitChecks.set(key, check);
  }
  return check;
}

/** How a revision's runs learn: only an agentic revision learns, and a revision without the field does not. */
export const learningOf = (revision: Revision | null | undefined): LearningMode => (revision?.kind === "agentic" ? (revision.body.learning ?? "off") : "off");

export const repoOf = (data: string, agentId: string): string => join(data, "agents", agentId, REPO);
const agentDir = (data: string, agentId: string): string => join(data, "agents", agentId);

/** How a run ended in the store, as its memo says it. */
export const outcomeOf = (state: RunRow["state"]): "completed" | "failed" | "stopped" => (state === "completed" ? "completed" : state === "stopped" ? "stopped" : "failed");

/** Whether a tool brings content from outside the run into it. */
export const isExternal = (tool: string): boolean => !TRUSTED_TOOLS.has(tool);

/** Whether the run in `storeFile` called an external tool: every tool call its conversations hold, whatever it answered.
 *  pi-durable writes one message per entry (`model` is `[AssistantMessage]`), and every message of every entry is read
 *  anyway, so an entry that ever carries more cannot hide a call. */
export function externalUsed(storeFile: string): boolean {
  const db = new DatabaseSync(storeFile, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT record FROM entries").iterate()) {
      const entry = JSON.parse(String((row as { record: string }).record)) as { model?: unknown };
      for (const message of Array.isArray(entry.model) ? entry.model : []) {
        const content = isObject(message) ? message.content : undefined;
        if (Array.isArray(content) && content.some((block) => isObject(block) && block.type === "toolCall" && typeof block.name === "string" && isExternal(block.name))) return true;
      }
    }
    return false;
  } finally {
    db.close();
  }
}

/** The values of `env`'s keys, tokens, secrets and passwords. */
export const secretsOf = (env: NodeJS.ProcessEnv): string[] =>
  [...new Set(Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value ?? ""))].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);

/** Input values too plain to be the case's own: a yes or a no. */
const PLAIN = /^(?:yes|no|true|false)$/i;
/** The run's input values, trimmed: a learning states the rule, and never repeats the case. An agentic run's input keeps
 *  any field beside `content`, of any shape, so nested objects and lists are walked; a finite number counts as its
 *  decimal text. A value under 4 characters once trimmed, or a bare yes, no, true or false in any case, is no refused
 *  value: it would refuse every harvest. Every other value is, a number of 4 or more digits included. */
export function caseValuesOf(input: unknown): string[] {
  const values: string[] = [];
  const left: unknown[] = [input];
  while (left.length) {
    const value = left.pop();
    if (Array.isArray(value) || isObject(value)) {
      const inner = Object.values(value);
      for (let at = inner.length - 1; at >= 0; at--) left.push(inner[at]);
      continue;
    }
    const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    if (text.length >= 4 && !PLAIN.test(text)) values.push(text);
  }
  return values;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every write queued before it for the agent's repository has finished: one at a time per agent, in
 *  this process. The host commit and the proposals go through it, and so must anything else that writes the repository. */
export function withAgentRepo<T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> {
  const key = agentDir(data, agentId);
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return next;
}

/** The agent's repository, made empty and bare on first use, through a clone of the caller's in `clone`. A writer calls
 *  it inside `withAgentRepo`. */
export async function openAgentRepo(data: string, agentId: string, clone: string): Promise<Repo> {
  const { local, openRepo } = await import("@parcha/pi-git-remote");
  const bare = repoOf(data, agentId);
  if (!existsSync(bare)) {
    await mkdir(dirname(bare), { recursive: true, mode: 0o700 });
    await promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", "init", "-q", "--bare", "--template=", "-b", "main", bare]);
  }
  return openRepo({ dir: clone, remote: local(bare), identity: IDENTITY });
}

/** The host's commit on main of the agent's current revision, read by `current` when its turn in the queue comes:
 *  AGENTS.md (its instructions) and agent.json (its definition). Nothing for an agent that does not learn or on a host
 *  that cannot, and no commit when main holds both already. Main's other files stay. */
export async function hostCommit(data: string, agentId: string, current: () => AgentEntry | null | Promise<AgentEntry | null>): Promise<{ sha: string; created: boolean } | undefined> {
  if (await learningBlocker(process.env)) return undefined;
  return withAgentRepo(data, agentId, async () => {
    const entry = await current();
    const revision = entry?.revision;
    if (!entry || revision?.kind !== "agentic" || learningOf(revision) === "off") return undefined;
    const repo = await openAgentRepo(data, agentId, join(agentDir(data, agentId), HOST_CLONE));
    const files = { "AGENTS.md": `${revision.body.instructions.trim()}\n`, "agent.json": `${JSON.stringify(definitionOf(entry.agent, revision, entry.version), null, 2)}\n` };
    const made = await repo.commitTo("main", { files, message: `host: revision ${entry.version} of ${agentId}`, trailers: { Revision: revision.id } });
    if (made.created) await repo.push(made.sha, "main");
    return made;
  });
}

/** Before a run of `revision` (number `version`) of `entry`'s agent starts: when it learns, main holds the current
 *  revision's host commit, or the run's own when the current one does not learn and main has none yet. */
export async function readyToRun(data: string, entry: AgentEntry, current: () => AgentEntry | null | Promise<AgentEntry | null>, revision: Revision, version: number): Promise<void> {
  if (learningOf(revision) === "off") return;
  const id = entry.agent.id;
  if (learningOf(entry.revision) !== "off") return void (await hostCommit(data, id, current));
  const bare = repoOf(data, id);
  const main = existsSync(bare) ? await promisify(execFile)("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", "main^{commit}"]).then(() => true, () => false) : false;
  if (!main) await hostCommit(data, id, () => ({ ...entry, revision, version }));
}

/** What the server recorded for a run of a learning agent once it proposed it, or `waiting` while its process outlives
 *  its end and its working copy is not read yet. D extends it with what review did. */
export type RunState = { state: "proposed" | "empty" | "refused" | "waiting"; branch?: string; base?: string; sha?: string; reasons?: string[]; reason?: string };

const runStateFile = (data: string, agentId: string, runId: string) => join(agentDir(data, agentId), "learning", "runs", `${runId}.json`);

export async function readRunState(data: string, agentId: string, runId: string): Promise<RunState | undefined> {
  const text = await readFile(runStateFile(data, agentId, runId), "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as RunState);
}

/** Written whole: a reader sees the old state or the new one. */
export async function writeRunState(data: string, agentId: string, runId: string, state: RunState): Promise<void> {
  const file = runStateFile(data, agentId, runId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.partial`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(`${file}.partial`, file);
}

/** A run's released store: each document's latest value, read-only. */
function releasedStore(file: string) {
  return {
    snapshot: async (doc: { definition: { kind: string } }) => {
      const { recordingLines } = await import("@parcha/agentrun-pi/durable");
      return recordingLines(file).lines.findLast((line) => line.kind === doc.definition.kind)?.data?.value;
    },
  };
}

/** The agent store and how a read of it waits for another writer: `Agents`, or a caller's own `request`. */
export type StoreAccess = { readonly store: Pick<AgentStoreReader, "readRun" | "readRevision" | "listRuns">; request<T>(act: () => T | Promise<T>): Promise<T> };

/** A process's start in clock ticks after boot (field 22 of /proc/<pid>/stat), as pi-durable-disk records its own in
 *  the run's holder (`startTicks`): null when there is no such process, undefined when it cannot be read. */
function startTicksOf(pid: number): number | null | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isSafeInteger(ticks) ? ticks : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync("/proc/self/stat") ? null : undefined;
  }
}

const bootId = (): string | undefined => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Whether the process the run's record names (or, later, its box) is still alive: one that is may still write the
 *  working copy, which is then not read. A missing run.json reads not live only because a run writes it before any work.
 *  The holder's boot and start ticks tell it from a later process given the same pid; a start that cannot be read is
 *  read live, so an unknown never lets the copy be read under a writer.
 *  TODO: the box record of the run's confinement replaces this pid check once runs have boxes. */
function processLive(runDir: string): boolean {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  } catch {
    return false;
  }
  const holder = isObject(record) && isObject(record.holder) ? record.holder : undefined;
  const pid = holder?.pid;
  if (!(Number.isSafeInteger(pid) && pid !== process.pid && processAlive(pid as number))) return false;
  if (typeof holder?.bootId === "string" && bootId() !== undefined && holder.bootId !== bootId()) return false;
  if (typeof holder?.startTicks !== "number") return true;
  const ticks = startTicksOf(pid as number);
  return ticks === undefined || ticks === holder.startTicks;
}

/** A harvest refused because the run's process is still live: its learning state says `waiting`. */
export class StillLive extends Error {}

/** What the ended run `runId` left in its working copy, harvested into one commit on `runs/<run id>` from the commit it was
 *  seeded from (harvest.ts), with the host's memo: its outcome and cost as the carry back wrote them, and `untrusted` when
 *  it called an external tool. Undefined for a run whose revision does not learn. A run whose end is not in the store yet,
 *  or whose process is still live, is refused. A harvest again is the same commit, read as `already`. */
export async function harvestFor(data: string, agents: StoreAccess, runId: string): Promise<HarvestResult | undefined> {
  const { store } = agents;
  const row = await agents.request(() => store.readRun(runId));
  const revision = row ? await agents.request(() => store.readRevision(row.revision)) : undefined;
  if (!row || learningOf(revision) === "off") return undefined;
  // Only an ended run is harvested: its outcome and cost are the carry back's. A call before the end is written is a
  // caller's mistake, said, never a silent no-op.
  if (row.state === "running") throw new Error(`the run ${runId} has not ended in the agent store yet, so it is not harvested`);
  const dir = join(data, "runs", runId);
  if (processLive(dir)) {
    const reason = `the run ${runId}'s process is still live, so its working copy is not harvested yet`;
    await writeRunState(data, row.agent, runId, { state: "waiting", reason });
    throw new StillLive(reason);
  }
  const storeFile = join(dir, "store", "run.sqlite");
  const copy = join(dir, "work", WORKING_COPY);
  const { SeedDoc } = await import("@parcha/pi-agent-learn");
  const seed = existsSync(storeFile) ? ((await releasedStore(storeFile).snapshot(SeedDoc as never)) as { sha?: string } | undefined)?.sha : undefined;
  // A run that never reached its seed has nothing to harvest. One that did has a working copy: its absence is an error,
  // said by the harvest, never read as an empty run.
  if (!seed) {
    await writeRunState(data, row.agent, runId, { state: "empty" });
    return { status: "empty", deleted: [], ignored: [] };
  }
  if (!existsSync(copy) && !existsSync(join(dir, COPY_MARK))) {
    await writeRunState(data, row.agent, runId, { state: "empty", reason: "the run ended before working copies" });
    return { status: "empty", deleted: [], ignored: [] };
  }
  const harness = revision?.kind === "agentic" ? (revision.body.harness ?? "pi") : "pi";
  // This host's secrets and the run's input values: a harvest that holds one is refused whole, so no ref holds it.
  const refuse = [...secretsOf(process.env), ...caseValuesOf((await readJson(join(dir, RUN_META)))?.input)];
  return withAgentRepo(data, row.agent, async () => {
    const repo = await openAgentRepo(data, row.agent, join(agentDir(data, row.agent), HOST_CLONE));
    const result = await harvestWorktree({
      repo, runId, seed, dir: copy, date: new Date(row.endedAt ?? row.startedAt), refuse,
      head: { harness, outcome: outcomeOf(row.state), ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }), untrusted: externalUsed(storeFile) },
    });
    await writeRunState(data, row.agent, runId, result.status === "empty" ? { state: "empty" } : result.status === "refused" ? { state: "refused", reasons: result.refused ?? [] } : { state: "proposed", branch: `runs/${runId}`, base: seed, sha: result.sha! });
    return result;
  });
}

/** How often a run whose process outlives its end is looked at again. */
export const HARVEST_POLL_MS = 2_000;

/** `harvestFor` once the run's process has ended: a run whose process outlives its end is recorded `waiting` and looked
 *  at every `everyMs` until its process is gone, then harvested once. Undefined when `signal` stops it first: the run
 *  stays `waiting`, and the next start's catch-up harvests it. */
export async function harvestOnExit(data: string, agents: StoreAccess, runId: string, signal: AbortSignal, everyMs: number = HARVEST_POLL_MS): Promise<HarvestResult | undefined> {
  try {
    return await harvestFor(data, agents, runId);
  } catch (error) {
    if (!(error instanceof StillLive)) throw error;
  }
  const dir = join(data, "runs", runId);
  while (processLive(dir)) {
    if (signal.aborted) return undefined;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, everyMs);
      signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
    });
    if (signal.aborted) return undefined;
  }
  return harvestFor(data, agents, runId);
}

/** How long the start-time catch-up waits for a busy agent store, step by step: it answers no request, so it waits
 *  longer than one does, and past the last step leaves the rest to the next start. */
export const CATCH_UP_BUSY_MS: readonly number[] = [50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000];

/** At start: every ended run of a learning revision that has no recorded proposal, or is still `waiting`, is proposed,
 *  so a server that stopped between a carry back and its proposal loses nothing. The store is read when it is free (`CATCH_UP_BUSY_MS`); each
 *  wait, and a store that stays busy, is said in `log`. Returns the runs it proposed. */
export async function catchUp(data: string, agents: StoreAccess, log: (line: string) => void, delaysMs: readonly number[] = CATCH_UP_BUSY_MS): Promise<string[]> {
  const { store } = agents;
  const free = <T>(act: () => T | Promise<T>) =>
    whenFree(act, delaysMs, (attempt, delay) => delay !== undefined && log(`learning catch-up: the agent store is busy; trying again in ${delay} ms (${attempt + 1} of ${delaysMs.length})`));
  const learns = new Map<string, boolean>();
  const done: string[] = [];
  let rows: Awaited<ReturnType<typeof store.listRuns>>;
  try {
    rows = await free(() => store.listRuns());
  } catch (error) {
    log(`learning catch-up: the agent store stayed busy (${(error as Error).message}); the next start proposes what is left`);
    return done;
  }
  for (const row of rows) {
    if (row.state === "running") continue;
    try {
      if (!learns.has(row.revision)) learns.set(row.revision, learningOf(await free(() => store.readRevision(row.revision))) !== "off");
      if (!learns.get(row.revision) || ((await readRunState(data, row.agent, row.id))?.state ?? "waiting") !== "waiting") continue;
      if (await harvestFor(data, { store, request: free }, row.id)) done.push(row.id);
    } catch (error) {
      log(`run ${row.id}: not proposed: ${(error as Error).message}`);
    }
  }
  return done;
}

/** What a learning run's process adds: the `<learned>` section, the skills the agent wrote (their files, under the
 *  run's work), and the hook that journals the seed and lays out the working copy before the run resumes. */
export type RunLearning = { extension: Extension; skillFiles: string[]; beforeResume(run: BeforeResume): Promise<void> };

/**
 * For the run in `where`, of agent `agentId`: the commit it starts from, which is the one its store journaled when it
 * was seeded before, else main now. The skills the agent wrote at that commit are copied into the run's work, except
 * those named like one of `ownSkills` (the revision's, which win). `beforeResume` journals the commit, copies the active
 * notes to `<work>/.agent/learnings/`, and checks the commit out as the run's working copy, `<work>/.agent/repo`, once:
 * a run that resumes keeps the copy it has.
 */
export async function runLearning(where: AppContext, agentId: string, ownSkills: readonly string[], storeFile: string): Promise<RunLearning> {
  const [learn, { modeRefusal }] = await Promise.all([import("@parcha/pi-agent-learn"), import("@parcha/pi-git-remote")]);
  const bare = repoOf(resolve(where.root, "..", ".."), agentId);
  if (!existsSync(bare)) throw new Error(`the agent ${agentId} learns, and its repository ${REPO} is not there`);
  const repo = await openAgentRepo(resolve(where.root, "..", ".."), agentId, join(where.root, RUN_CLONE));
  await repo.fetch();
  const journaled = existsSync(storeFile) ? ((await releasedStore(storeFile).snapshot(learn.SeedDoc as never)) as { sha?: string } | undefined)?.sha : undefined;
  const sha = journaled || (await repo.resolve("main"));
  if (!sha) throw new Error(`the agent ${agentId}'s repository has no main`);
  const skillFiles: string[] = [];
  for (const entry of await repo.list(".agents/skills", sha)) {
    const name = LEARNED_SKILL.exec(entry.path)?.[1];
    if (!name || ownSkills.includes(name) || entry.type !== "blob" || modeRefusal(entry.mode) || (entry.size ?? 0) > learn.CAPS.file) continue;
    const text = await repo.read(entry.path, sha);
    if (text === undefined) continue;
    await mkdir(join(where.work, ".agents", "skills", name), { recursive: true });
    await writeFile(join(where.work, ".agents", "skills", name, "SKILL.md"), text);
    skillFiles.push(`${name}/SKILL.md`);
  }
  const extension = learn.agentLearn({ guard: learn.guard }) as unknown as Extension;
  const runId = basename(where.root);
  const copy = join(where.work, WORKING_COPY);
  return {
    extension,
    skillFiles,
    beforeResume: async ({ harness }) => {
      await learn.seedLearning({ repo, ref: sha, target: harness as never, into: where.work });
      if (existsSync(copy)) return;
      await writeFile(join(where.root, COPY_MARK), `${sha}\n`);
      // Laid out beside it and renamed: a process that dies part way leaves no half copy for the run to keep.
      const partial = `${copy}.partial`;
      await rm(partial, { recursive: true, force: true });
      await mkdir(partial, { recursive: true });
      await repo.checkout(sha, { into: partial });
      await mkdir(join(partial, "memos"), { recursive: true });
      await writeFile(join(partial, "memos", `${runId}.md`), `---\nrun: ${runId}\nbase: ${sha}\n---\n`, { flag: "wx" }).catch(() => undefined);
      await rename(partial, copy);
    },
  };
}
