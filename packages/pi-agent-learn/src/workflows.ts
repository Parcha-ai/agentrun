import { constants, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectWorkflow, resolveSchemaForWorkflow, workflowSha256 } from "@parcha/agentrun-dsl";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Session } from "@earendil-works/pi-durable";
import { recordingLines } from "@parcha/agentrun-pi/durable";
import { WorkflowStore, WorkflowStoreError } from "@parcha/agentrun-pi/workflows";
import type { Repo } from "@parcha/pi-git-remote";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { LearnError } from "./errors.js";
import { CAPS, LAYOUT, RUN_ID } from "./layout.js";
import { type Admission, admitRevision, type Decision, foldUses, type IgnoredUse, promotionDecision, type Thresholds } from "./promotion.js";
import type { UsesSource } from "./propose.js";
import { MAX_WORKFLOW_HINTS, type WorkflowHint } from "./section.js";
import { readSeed } from "./seed.js";
import type { AdmitWorkflow, AdmitWorkflowInput, AdmitWorkflowResult, RepoRead, SettleUses, SettleUsesInput, SettleUsesResult, WorkflowUse } from "./types.js";
import {
  checkPreconditions, currentRevision, deriveWhen, fitTrial, matches, MAX_NAME, parseTrial, type Precondition, readTrial, renderTrial, skillName, skillPath, type Trial, trialPath,
  type Use, type UseOutcome, workflowDir, WORKFLOW_SKILL_NAME,
} from "./trial.js";

const SHA256 = /^[0-9a-f]{64}$/;
const RECORD = /^[0-9a-f]{64}\.json$/;
const SKILL_PATH = new RegExp(`^${LAYOUT.skills.replaceAll(".", "\\.")}/([a-z0-9][a-z0-9-]{0,63})/(SKILL\\.md|trial\\.json)$`);
const DIGEST_PATH = new RegExp(`^${LAYOUT.workflows.replaceAll(".", "\\.")}/([a-z0-9][a-z0-9_-]{0,63})/([0-9a-f]{64})\\.json$`);
/** Workflows one run may hand over: two files each stay inside the guard's file cap with the inbox and uses files. */
export const MAX_RUN_WORKFLOWS = 8;
export const MAX_RUN_USES = 32;

export type Files = Readonly<Record<string, string | null>>;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const reasonOf = (error: unknown) => (error instanceof WorkflowStoreError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "unreadable");

// ---------------------------------------------------------------- files

/** A regular file's text, read without following a link; undefined when absent. */
async function readRegular(file: string, cap = CAPS.file): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new LearnError("invalid", `${path.basename(file)} is not a regular file`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LearnError("invalid", `${path.basename(file)} is not a regular file`);
    if (stat.size > cap) throw new LearnError("too_large", `${path.basename(file)} is ${stat.size} bytes; the cap is ${cap}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Writes `rel` under `root` as a new regular file through real directories only, replacing what was there by rename. */
async function writeRegular(root: string, rel: string, text: string): Promise<void> {
  const parts = rel.split("/");
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    await mkdir(at, { mode: 0o755 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    if (!(await lstat(at)).isDirectory()) throw new LearnError("invalid", `${rel} would pass through something that is not a directory`);
  }
  const file = path.join(at, parts.at(-1)!);
  const held = await lstat(file).catch((error) => { if (isMissing(error)) return undefined; throw error; });
  if (held && !held.isFile()) throw new LearnError("invalid", `${rel} is not a regular file`);
  const pending = path.join(at, `.pending-${randomUUID()}`);
  const handle = await open(pending, "wx", 0o644);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await rename(pending, file).catch(async (error) => { await unlink(pending).catch(() => undefined); throw error; });
}

const absolute = (dir: string, what: string) => {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new LearnError("invalid", `${what} is an absolute directory`);
  return dir;
};

async function scratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-agent-learn-wf-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the skill

/** `.agents/skills/<name>/SKILL.md` for a workflow: pi reads its name and description, and the description is the "when". */
export function renderSkill(name: string, description: string): string {
  skillName(name);
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description.trim())}`,
    "---",
    `# ${name}`,
    "",
    "A saved workflow that earlier runs of this agent wrote. It is being tried on inputs it fits.",
    "",
    `Run it with the agentrun tool: load the workflow named ${name}, then run it with this case's input.`,
    "If it escalates, fails, or its answer does not fit the case, continue the task yourself. The workflow never decides how the case ends.",
    "",
  ].join("\n");
}

/** The description a skill file written by `renderSkill` holds. */
function skillDescription(text: string): string | undefined {
  const line = /^description: (".*")$/m.exec(text)?.[1];
  if (line === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- what a run hands over

export type FoundWorkflow = {
  readonly name: string;
  readonly sha256: string;
  /** The DSL's records, byte for byte, by name under `inbox/<run id>/workflows/<name>/`: `<sha256>.json` and `latest`. */
  readonly files: Readonly<Record<string, string>>;
};
export type SkippedWorkflow = { readonly name?: string; readonly reason: string };
export type CollectedWorkflows = {
  readonly found: readonly FoundWorkflow[];
  /** `found` as `proposeLearning`'s `workflows` takes it: per name, the files by name. */
  readonly records: Readonly<Record<string, { readonly files: Readonly<Record<string, string>> }>>;
  readonly skipped: readonly SkippedWorkflow[];
};

export type CollectWorkflowsOptions = {
  /** The agent repository: only `list` is used, at the seeded commit. */
  readonly repo: Pick<Repo, "list">;
  /** The run's working directory: the project directory of the run's own workflow store. */
  readonly workDir: string;
  /** The commit the run was seeded from. Default: the one `seedLearning` recorded in `target`. */
  readonly seedSha?: string;
  /** The run's pi-durable store, for the seeded commit when `seedSha` is not given. */
  readonly target?: Pick<Session, "snapshot">;
};

/**
 * Host step at a run's terminal: the workflows the run saved that the agent repository did not hold at the seeded
 * commit, as the files its inbox carries. Only the revision each name ends on is handed over (what `latest` names), and
 * only when the repository does not already hold that digest, so a workflow the run was seeded with and did not change
 * is not proposed. The records are read through the DSL's store, which refuses a damaged one, then copied as they
 * are; a name the store refuses, one over the file cap, and anything past `MAX_RUN_WORKFLOWS` is left out and named in `skipped`.
 * Never throws for what the agent left in its workflow store.
 */
export async function collectWorkflows(options: CollectWorkflowsOptions): Promise<CollectedWorkflows> {
  const workDir = absolute(options.workDir, "workDir");
  const seedSha = options.seedSha ?? (options.target ? (await readSeed(options.target))?.sha : undefined);
  if (typeof seedSha !== "string" || seedSha === "") throw new LearnError("invalid", "collectWorkflows needs the seeded commit: pass seedSha, or the run's store holding a seed");
  const held = new Set<string>();
  for (const entry of await options.repo.list(LAYOUT.workflows, seedSha)) {
    const match = DIGEST_PATH.exec(entry.path);
    if (match) held.add(`${match[1]}/${match[2]}`);
  }
  const store = new WorkflowStore(workDir);
  const found: FoundWorkflow[] = [];
  const skipped: SkippedWorkflow[] = [];
  let names: string[];
  try {
    names = [...new Set((await store.list()).map((revision) => revision.name))].sort();
  } catch (error) {
    return { found, records: {}, skipped: [{ reason: `the run's workflow store could not be read: ${reasonOf(error)}` }] };
  }
  for (const name of names) {
    try {
      if (!WORKFLOW_SKILL_NAME.test(name) || name.length > 64) {
        skipped.push({ name, reason: "not a skill name: use lowercase letters and digits in words joined by single hyphens" });
        continue;
      }
      const { digest } = await store.load(name);
      if (held.has(`${name}/${digest}`)) continue;
      if (found.length >= MAX_RUN_WORKFLOWS) {
        skipped.push({ name, reason: `over the ${MAX_RUN_WORKFLOWS} workflows one run hands over` });
        continue;
      }
      const record = await readRegular(path.join(workDir, LAYOUT.workflows, name, `${digest}.json`));
      if (record === undefined) throw new LearnError("missing", "the record is gone");
      found.push({ name, sha256: digest, files: { [`${digest}.json`]: record, latest: `${digest}\n` } });
    } catch (error) {
      skipped.push({ name, reason: reasonOf(error) });
    }
  }
  return { found, records: Object.fromEntries(found.map((w) => [w.name, { files: w.files }])), skipped };
}

/** The proposal's files for what `collectWorkflows` found: `inbox/<run id>/workflows/<name>/<file>`. */
export function inboxWorkflowFiles(runId: string, found: readonly FoundWorkflow[]): Record<string, string> {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new LearnError("invalid", "the run id is not valid");
  const out: Record<string, string> = {};
  for (const workflow of found) for (const [file, text] of Object.entries(workflow.files)) out[`${LAYOUT.inbox}/${runId}/workflows/${skillName(workflow.name)}/${file}`] = text;
  return out;
}

// ---------------------------------------------------------------- uses

/** One use in `uses/<run id>.json`: the curator's `WorkflowUse`. */
export type RunUse = WorkflowUse;
/** `uses/<run id>.json`. */
export type RunUses = { readonly version: 1; readonly run: string; readonly uses: readonly RunUse[] };

const RunUsesSchema = Type.Object({
  version: Type.Literal(1),
  run: Type.String({ pattern: RUN_ID.source }),
  uses: Type.Array(Type.Object({
    name: Type.String({ pattern: WORKFLOW_SKILL_NAME.source, maxLength: 64 }),
    sha256: Type.String({ pattern: SHA256.source }),
    outcome: Type.Union([Type.Literal("frozen"), Type.Literal("escalated"), Type.Literal("failed")]),
    at: Type.String({ pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$" }),
  }, { additionalProperties: false }), { maxItems: MAX_RUN_USES }),
}, { additionalProperties: false });
const usesChecker = Compile(RunUsesSchema);

/** Reads `uses/<run id>.json` as `collectUses` writes it. With `run`, the file must be that run's. */
export function parseRunUses(text: string, run?: string): RunUses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LearnError("format", "the uses file is not JSON");
  }
  if (!usesChecker.Check(parsed)) throw new LearnError("format", "the uses file does not match its schema");
  const uses = parsed as RunUses;
  if (run !== undefined && uses.run !== run) throw new LearnError("format", "the uses file names another run");
  if (uses.uses.some((use) => Number.isNaN(Date.parse(use.at)) || new Date(use.at).toISOString() !== use.at)) throw new LearnError("format", "a use's at is not a time");
  return uses;
}

export type ReadUsesOptions = {
  /** The run's working directory: the project directory of its workflow store, which names what a digest was saved as. */
  readonly workDir: string;
  readonly run: string;
} & (
  /** The run's pi-durable store file, read only: once the run's Harness has closed it, or while it is open. */
  | { readonly store: string }
  /** The run's open Session, read without writing: a commit that only scans the workflow tasks. */
  | { readonly target: Pick<Session, "commit"> }
);
export type ReadSessionUsesOptions = {
  /** The entries of the pi session the run's `agentrun` tool ran in (`sessionEntries` reads them from the session file). */
  readonly entries: readonly unknown[];
  readonly workDir: string;
  readonly run: string;
};

type TaskRecord = {
  id?: unknown; kind?: unknown; endedAt?: unknown; startedAt?: unknown;
  input?: { key?: unknown; workflow?: unknown };
  state?: { status?: unknown; outcome?: { status?: unknown; result?: { status?: unknown } } };
};

/** How a finished workflow task ended as a use, or why it is not one. */
function outcomeOf(task: TaskRecord): UseOutcome | { skip: string } {
  const state = task.state;
  if (state?.status !== "terminal") return { skip: "not finished" };
  const outcome = state.outcome;
  if (outcome?.status === "completed") {
    if (outcome.result?.status === "complete") return "frozen";
    if (outcome.result?.status === "escalated") return "escalated";
    return { skip: "an outcome this reader does not know" };
  }
  if (outcome?.status === "failed" || outcome?.status === "faulted") return "failed";
  return { skip: `ended ${String(outcome?.status)}, which says nothing about the workflow` };
}

export type ReadUses = { readonly doc: RunUses | undefined; readonly skipped: readonly SkippedWorkflow[] };

/** The run's workflow tasks from an open Session: one commit that only reads, which writes nothing. */
async function liveTasks(target: Pick<Session, "commit">): Promise<TaskRecord[]> {
  return target.commit(async (tx) => {
    const out: TaskRecord[] = [];
    let cursor: Awaited<ReturnType<typeof tx.scanTasks>>["next"];
    do {
      const page = await tx.scanTasks({ kind: "agentrun.workflow" }, 100, cursor);
      out.push(...(page.items as unknown as TaskRecord[]));
      cursor = page.next;
    } while (cursor !== undefined);
    return out;
  }, BACKGROUND_CONTEXT);
}

/** What the run's own workflow store holds: the names a digest was saved under. Undefined, with why, when it cannot be read. */
async function savedNames(workDir: string): Promise<{ byDigest: Map<string, string[]> } | { error: string }> {
  const byDigest = new Map<string, string[]>();
  try {
    for (const revision of await new WorkflowStore(absolute(workDir, "workDir")).list()) byDigest.set(revision.digest, [...(byDigest.get(revision.digest) ?? []), revision.name]);
  } catch (error) {
    if (error instanceof LearnError) throw error;
    return { error: `the run's workflow store could not be read: ${reasonOf(error)}` };
  }
  return { byDigest };
}

/** The uses document, without any use of a name curate could not read back: the store accepts names the skill folder and the
 *  uses file do not, so such a use is named in `skipped`, never a reason the whole file is refused. */
function usesDoc(run: string, found: RunUse[], skipped: SkippedWorkflow[]): ReadUses {
  const uses: RunUse[] = [];
  for (const use of found) {
    if (WORKFLOW_SKILL_NAME.test(use.name) && use.name.length <= 64) uses.push(use);
    else skipped.push({ name: use.name, reason: "not a skill name, so its use cannot be read back" });
  }
  if (uses.length > MAX_RUN_USES) {
    skipped.push({ reason: `${uses.length - MAX_RUN_USES} uses over the ${MAX_RUN_USES} one run hands over` });
    uses.length = MAX_RUN_USES;
  }
  return { doc: uses.length ? { version: 1, run, uses } : undefined, skipped };
}

const checkRun = (run: string) => {
  if (typeof run !== "string" || !RUN_ID.test(run)) throw new LearnError("invalid", "the run id is not valid");
};

/**
 * What the run did with saved workflows, read from its store and never written: each `agentrun.workflow` task the DSL's
 * durable host committed (`recordingLines` of `@parcha/agentrun-pi/durable`, one read transaction) is a use when its
 * workflow's digest is one the run's workflow store holds under a name. A run key that was started again after a failure
 * counts once, by its last task. The task's end is the use's `at`. The outcome is `frozen` when the workflow completed,
 * `escalated` when a gate fired and the host's ladder took over, and `failed` when the task failed or faulted; a task that
 * is not finished, was cancelled or was orphaned says nothing about the workflow and is left out.
 */
export async function readUses(options: ReadUsesOptions): Promise<ReadUses> {
  checkRun(options.run);
  if ("store" in options && (typeof options.store !== "string" || !existsSync(options.store))) throw new LearnError("missing", "the run's store file is not there");
  if (!("store" in options) && typeof options.target?.commit !== "function") throw new LearnError("invalid", "readUses needs a store file or an open Session");
  const saved = await savedNames(options.workDir);
  if ("error" in saved) return { doc: undefined, skipped: [{ reason: saved.error }] };
  const skipped: SkippedWorkflow[] = [];
  const last = new Map<string, TaskRecord>();
  const tasks = "store" in options
    ? recordingLines(options.store).lines.filter((line) => line.kind === "agentrun.workflow").map((line) => line.data as TaskRecord)
    : await liveTasks(options.target);
  for (const task of tasks) {
    const key = task.input?.key;
    if (typeof key !== "string") continue;
    const held = last.get(key);
    if (!held || Number(task.id) > Number(held.id)) last.set(key, task);
  }
  const uses: RunUse[] = [];
  for (const [key, task] of [...last].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let digest: string;
    try {
      digest = workflowSha256(task.input?.workflow as never);
    } catch {
      skipped.push({ reason: `run ${key} holds a workflow document that does not hash` });
      continue;
    }
    const names = saved.byDigest.get(digest);
    if (!names) continue;
    const how = outcomeOf(task);
    if (typeof how !== "string") {
      skipped.push({ name: names[0]!, reason: `run ${key}: ${how.skip}` });
      continue;
    }
    const ended = typeof task.endedAt === "number" ? task.endedAt : typeof task.startedAt === "number" ? task.startedAt : undefined;
    if (ended === undefined || !Number.isFinite(ended)) {
      skipped.push({ name: names[0]!, reason: `run ${key} has no end time` });
      continue;
    }
    for (const name of [...names].sort()) uses.push({ name, sha256: digest, outcome: how, at: new Date(ended).toISOString() });
  }
  return usesDoc(options.run, uses, skipped);
}

const SNAPSHOT = "agentrun:snapshot";
const STATUS_USE: Readonly<Record<string, UseOutcome | undefined>> = { complete: "frozen", escalated: "escalated", failed: "failed" };
const isStamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** The entries of a pi session file: one JSON object per line, a line that is not one left out. */
export function sessionEntries(jsonl: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of String(jsonl).split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* a torn last line is not an entry */ }
  }
  return entries;
}

/**
 * The same uses, from the receipts the `agentrun` pi tool leaves in its session: the last `agentrun:snapshot` entry of a run
 * id says how it stands, and one that carries a report is its end (a run resumed after a failure carries none until it ends). `complete` is `frozen`; `escalated` and `failed` are themselves;
 * an `interrupted` run says nothing about the workflow. The name is the one the tool saved or loaded the workflow under when
 * the run's store holds that digest under it, else the names the store holds the digest under; a workflow run unsaved is no
 * use. The snapshot's time is the use's `at`. Entries are read, never trusted: only the fields used here are checked.
 */
export async function readSessionUses(options: ReadSessionUsesOptions): Promise<ReadUses> {
  checkRun(options.run);
  if (!Array.isArray(options.entries)) throw new LearnError("invalid", "entries is a list of session entries");
  const saved = await savedNames(options.workDir);
  if ("error" in saved) return { doc: undefined, skipped: [{ reason: saved.error }] };
  type Snapshot = { runId?: unknown; savedName?: unknown; createdAt?: unknown; report?: { digest?: unknown; status?: unknown } };
  const ends = new Map<string, Snapshot>();
  options.entries.forEach((entry, index) => {
    const e = entry as { type?: unknown; customType?: unknown; data?: Snapshot & { version?: unknown } } | null;
    if (e === null || typeof e !== "object" || e.type !== "custom" || e.customType !== SNAPSHOT) return;
    const data = e.data;
    if (data === null || typeof data !== "object" || data.version !== 1) return;
    ends.set(typeof data.runId === "string" ? data.runId : `entry:${index}`, data);
  });
  const skipped: SkippedWorkflow[] = [];
  const uses: RunUse[] = [];
  for (const [id, snapshot] of [...ends].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // The last snapshot of a run decides: a run resumed after a failure has no report until it ends again.
    if (snapshot.report === null || typeof snapshot.report !== "object") continue;
    const digest = snapshot.report?.digest;
    if (typeof digest !== "string" || !SHA256.test(digest)) continue;
    const held = saved.byDigest.get(digest);
    if (!held) continue;
    const named = typeof snapshot.savedName === "string" && held.includes(snapshot.savedName) ? [snapshot.savedName] : held;
    const status = String(snapshot.report?.status);
    const outcome = STATUS_USE[status];
    if (outcome === undefined) {
      skipped.push({ name: named[0]!, reason: `run ${id}: ended ${status}, which says nothing about the workflow` });
      continue;
    }
    if (!isStamp(snapshot.createdAt)) {
      skipped.push({ name: named[0]!, reason: `run ${id} has no end time` });
      continue;
    }
    for (const name of [...named].sort()) uses.push({ name, sha256: digest, outcome, at: snapshot.createdAt });
  }
  return usesDoc(options.run, uses, skipped);
}

/** The run's uses as `uses/<run id>.json` holds them, or undefined when it used no saved workflow. */
export async function collectUses(options: ReadUsesOptions | ReadSessionUsesOptions): Promise<RunUses | undefined> {
  return (await ("entries" in options ? readSessionUses(options) : readUses(options))).doc;
}

/** `collectUses` as the hook `proposeLearning` takes. */
export const usesSource = (options: ReadUsesOptions | ReadSessionUsesOptions): UsesSource => () => collectUses(options);

// ---------------------------------------------------------------- admitting a workflow

export type AdmitInDirInput = {
  /** A project directory holding main's files for this name (`trial.json`, `SKILL.md`): absolute, written into. */
  readonly dir: string;
  readonly runId: string;
  readonly name: string;
  /** The `workflow` learning's text: when to use it. Without one the revision is admitted but stays out of `<learned>`. */
  readonly description?: string;
  /** The run's files for this name, as `collectWorkflows` made them: `<sha256>.json` and `latest`. Absent or empty: only the description is new. */
  readonly records?: Readonly<Record<string, string>>;
  /** The preconditions to try it under, a check on the run's input each, or a function of the workflow document. Default: none,
   *  and the model decides from the description. */
  readonly when?: readonly Precondition[] | ((workflow: unknown) => readonly Precondition[]);
  /** Admit a workflow with a code node or a shell or executor call. Default: refuse it, since nothing a person reviewed runs it. */
  readonly allowExecutableCode?: boolean;
  readonly now?: () => Date;
};
export type AdmitRefusal = "name" | "description" | "records" | "code" | "demoted" | "limit" | "unknown" | "when";
export type AdmitInDirResult =
  /** `admitted`: a new revision is the live trial. `described`: only the skill was written. `unchanged`: nothing was new. `files`
   *  are every repository path this call changed, as text, or null where it deleted one: commit exactly these. */
  | { readonly status: "admitted" | "described" | "unchanged"; readonly name: string; readonly sha256?: string; readonly files: Files }
  | { readonly status: "refused"; readonly name: string; readonly reason: AdmitRefusal; readonly detail: string };

const refuse = (name: string, reason: AdmitRefusal, detail: string): AdmitInDirResult => ({ status: "refused", name, reason, detail });

/** The preconditions a workflow's own input schema states about the top level of its input (`deriveWhen`, with the document's
 *  schema references resolved): a ready `when` for `workflowAdmitter` and `usesSettler`, for a host whose workflows name their
 *  input fields as its runs' inputs do. */
export const schemaWhen = (workflow: unknown): Precondition[] => deriveWhen(workflow, (schema) => resolveSchemaForWorkflow(workflow as never, schema));

export async function readTrialIn(dir: string, name: string): Promise<Trial | undefined> {
  const text = await readRegular(path.join(absolute(dir, "dir"), trialPath(name)));
  return text === undefined ? undefined : parseTrial(text, name);
}

/**
 * The step under `workflowAdmitter`: validate the run's records through the DSL's store in a scratch directory,
 * refuse code nodes unless the host admits them, save the revision the run ended on into the checkout through the
 * store, write `.agents/skills/<name>/SKILL.md` (name and description, and a body that says to run the workflow with the
 * agentrun tool and to continue itself if it escalates) and `trial.json`. The new revision is the live trial and the one
 * it replaces is superseded, or retired when it had never proved itself. Idempotent: the same revision again changes
 * nothing, and a demoted one is refused. Returns the changed files for curate's one commit; never commits itself.
 */
export async function admitInDir(input: AdmitInDirInput): Promise<AdmitInDirResult> {
  const dir = absolute(input.dir, "dir");
  const { name, runId } = input;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new LearnError("invalid", "the run id is not valid");
  if (typeof name !== "string" || !WORKFLOW_SKILL_NAME.test(name) || name.length > 64) {
    return refuse(String(name).slice(0, 64), "name", "a workflow name is lowercase letters and digits in words joined by single hyphens, at most 64 characters, so pi can load it as a skill");
  }
  const description = typeof input.description === "string" ? input.description.trim() : undefined;
  if (input.description !== undefined && (description === undefined || description === "" || bytes(description) > CAPS.text)) {
    return refuse(name, "description", `a description is text of 1 to ${CAPS.text} bytes`);
  }
  const at = (input.now?.() ?? new Date()).toISOString();
  const held = await readTrialIn(dir, name);
  const records = input.records ?? {};
  const files: Record<string, string | null> = {};
  let trial = held;
  let status: "admitted" | "described" | "unchanged" = "unchanged";
  let sha256: string | undefined;

  if (Object.keys(records).length) {
    const latest = records.latest;
    const names = Object.keys(records).filter((file) => file !== "latest");
    if (typeof latest !== "string" || !/^[0-9a-f]{64}\n$/.test(latest)) return refuse(name, "records", "the records name no latest revision");
    if (!names.length || names.some((file) => !RECORD.test(file)) || !names.includes(`${latest.slice(0, 64)}.json`)) return refuse(name, "records", "the records are not DSL records for the revision latest names");
    sha256 = latest.slice(0, 64);
    const record = records[`${sha256}.json`]!;
    if (typeof record !== "string" || bytes(record) > CAPS.file) return refuse(name, "records", `a record is text of at most ${CAPS.file} bytes`);
    let stored;
    try {
      stored = await scratch(async (tmp) => {
        await writeRegular(tmp, `${workflowDir(name)}/${sha256}.json`, record);
        return new WorkflowStore(tmp).load(name, sha256);
      });
    } catch (error) {
      return refuse(name, "records", `the store refuses the record: ${reasonOf(error)}`);
    }
    if (!input.allowExecutableCode && inspectWorkflow(stored.workflow).requires.executableCode) {
      return refuse(name, "code", "the workflow runs code (a code node, or a shell or executor call), and nothing a person reviewed admits it");
    }
    const when = typeof input.when === "function" ? input.when(stored.workflow) : input.when ?? [];
    try {
      checkPreconditions(when);
    } catch (error) {
      if (!(error instanceof LearnError)) throw error;
      return refuse(name, "when", `the preconditions do not fit what a trial keeps: ${error.message}`);
    }
    const skillText = await readRegular(path.join(dir, skillPath(name)));
    const admitted: Admission = admitRevision(held, { name, sha256, run: runId, at, when, ...(skillText === undefined ? {} : { replacedDescription: skillDescription(skillText) }) });
    if (admitted.status === "refused") return refuse(name, admitted.reason, admitted.detail);
    if (admitted.status === "admitted") {
      const saved = await new WorkflowStore(dir).save(name, stored.workflow);
      if (saved.digest !== sha256) throw new LearnError("invalid", "the store saved another digest than the one admitted");
      trial = admitted.trial;
      status = "admitted";
      for (const file of [`${sha256}.json`, "latest"]) {
        const text = await readRegular(path.join(dir, workflowDir(name), file));
        if (text === undefined) throw new LearnError("missing", "the store's record is not in the checkout");
        files[`${workflowDir(name)}/${file}`] = text;
      }
      // A description belongs to the revision it was written for: the new one is offered under its own, or not at all.
      if (description === undefined && skillText !== undefined) {
        await unlink(path.join(dir, skillPath(name)));
        files[skillPath(name)] = null;
      }
    }
  } else if (!held) {
    return refuse(name, "unknown", "there is no trial under this name to describe, and the run handed over no records");
  }

  if (description !== undefined && trial && currentRevision(trial)) {
    const skill = renderSkill(name, description);
    if ((await readRegular(path.join(dir, skillPath(name)))) !== skill) {
      await writeRegular(dir, skillPath(name), skill);
      files[skillPath(name)] = skill;
      if (status === "unchanged") status = "described";
    }
  }
  if (trial && trial !== held) {
    const text = renderTrial(fitTrial(trial));
    await writeRegular(dir, trialPath(name), text);
    files[trialPath(name)] = text;
  }
  return { status, name, ...(sha256 === undefined ? {} : { sha256 }), files };
}

// ---------------------------------------------------------------- folding uses at curate

export type SettleOptions = {
  /** A project directory holding main's files for the names used: `trial.json`, and the records of superseded revisions. */
  readonly dir: string;
  /** One run's `uses/<run id>.json`, parsed. */
  readonly uses: RunUses;
  readonly thresholds?: Partial<Thresholds>;
};
export type SettledDecision = { readonly name: string; readonly at: string; readonly decision: Exclude<Decision, { action: "hold" }> };
export type Settled = {
  readonly files: Files;
  readonly decisions: readonly SettledDecision[];
  /** Each name no decision was made for, and why: what its uses did not add up to, or that they were left out. */
  readonly held: readonly { readonly name: string; readonly reason: string }[];
  readonly ignored: readonly (IgnoredUse & { readonly name: string })[];
};

/**
 * The step under `usesSettler`, for a run's `uses/<run id>.json`: append each use to its workflow's `trial.json` and settle
 * after each one by the ported promotion rules (`foldUses`). A promotion changes `trial.json`. When a demotion hands the
 * name to another revision, the store's `latest` is pointed at it through the store, and its preconditions and the description
 * of its skill, which it kept while superseded, come back with it; with none to restore, the skill is deleted, so the agent is
 * no longer told about the workflow, and `trial.json` stays, so the revision is never tried again. Uses of a name with no
 * trial, or of a revision it does not hold, are left out and named in `ignored`. Returns the changed files for one commit.
 */
export async function settleWorkflowUses(options: SettleOptions): Promise<Settled> {
  const dir = absolute(options.dir, "dir");
  const files: Record<string, string | null> = {};
  const decisions: SettledDecision[] = [];
  const held: { name: string; reason: string }[] = [];
  const ignored: (IgnoredUse & { name: string })[] = [];
  const byName = new Map<string, Use[]>();
  for (const use of options.uses.uses) byName.set(use.name, [...(byName.get(use.name) ?? []), { run: options.uses.run, sha256: use.sha256, outcome: use.outcome, at: use.at }]);
  const store = new WorkflowStore(dir);
  for (const [name, incoming] of [...byName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const trial = await readTrialIn(dir, name);
    if (!trial) {
      for (const use of incoming) ignored.push({ name, use, reason: "unknown_revision" });
      held.push({ name, reason: "no workflow is tried under this name, so its uses were left out" });
      continue;
    }
    const unrunnable = new Set<string>();
    const restorable = new Map<string, Awaited<ReturnType<WorkflowStore["load"]>>>();
    for (const revision of trial.revisions.filter((r) => r.status === "superseded")) {
      try {
        restorable.set(revision.sha256, await store.load(name, revision.sha256));
      } catch {
        unrunnable.add(revision.sha256);
      }
    }
    const rules = { ...(options.thresholds ? { thresholds: options.thresholds } : {}), unrunnable };
    const folded = foldUses(trial, incoming, rules);
    for (const skip of folded.ignored) ignored.push({ name, ...skip });
    for (const { decision, at } of folded.applied) decisions.push({ name, at, decision });
    if (!folded.applied.length) {
      const left = folded.ignored.length ? `; ${folded.ignored.length} use${folded.ignored.length === 1 ? "" : "s"} left out (${[...new Set(folded.ignored.map((i) => i.reason))].join(", ")})` : "";
      held.push({ name, reason: `${promotionDecision(folded.trial, rules).reason}${left}` });
    }
    const before = currentRevision(trial);
    const now = currentRevision(folded.trial);
    if (now?.sha256 !== before?.sha256) {
      // The live revision changed hands: a rollback to a superseded revision, or no revision left.
      const back = now ? trial.revisions.find((r) => r.sha256 === now.sha256) : undefined;
      if (now && back) {
        await store.save(name, restorable.get(now.sha256)!.workflow);
        files[`${workflowDir(name)}/latest`] = (await readRegular(path.join(dir, workflowDir(name), "latest")))!;
      }
      if (back?.description !== undefined) {
        const skill = renderSkill(name, back.description);
        await writeRegular(dir, skillPath(name), skill);
        files[skillPath(name)] = skill;
      } else {
        await unlink(path.join(dir, skillPath(name))).catch((error) => { if (!isMissing(error)) throw error; });
        files[skillPath(name)] = null;
      }
    }
    if (folded.trial !== trial) {
      const text = renderTrial(fitTrial(folded.trial));
      await writeRegular(dir, trialPath(name), text);
      files[trialPath(name)] = text;
    }
  }
  return { files, decisions, held, ignored };
}

// ---------------------------------------------------------------- tried on a run's input

export type RepoAt = { readonly repo: Pick<Repo, "list" | "read">; readonly sha: string };

/**
 * The workflows to try first for a run's input, at the commit it is seeded from: each name whose skill and `trial.json` are
 * there, whose live revision is a trial or active, whose record is in the store, and whose preconditions hold on `input`.
 * Active before trial, then by name, at most `MAX_WORKFLOW_HINTS`: the list `seedLearning` takes. A name whose `trial.json`
 * does not parse is left out, never an error for the run.
 */
export async function workflowsToTry(source: RepoAt, input: unknown): Promise<WorkflowHint[]> {
  const { repo, sha } = source;
  const skills = new Set<string>();
  const trials = new Set<string>();
  for (const entry of await repo.list(LAYOUT.skills, sha)) {
    const match = SKILL_PATH.exec(entry.path);
    if (match) (match[2] === "SKILL.md" ? skills : trials).add(match[1]!);
  }
  const records = new Set<string>();
  for (const entry of await repo.list(LAYOUT.workflows, sha)) {
    const match = DIGEST_PATH.exec(entry.path);
    if (match) records.add(`${match[1]}/${match[2]}`);
  }
  const hints: WorkflowHint[] = [];
  for (const name of [...skills].filter((n) => trials.has(n)).sort()) {
    let trial: Trial | undefined;
    try {
      trial = await readTrial(repo, name, sha);
    } catch (error) {
      if (!(error instanceof LearnError)) throw error;
    }
    const live = trial && currentRevision(trial);
    if (!trial || !live || !records.has(`${name}/${live.sha256}`) || !matches(trial.when, input)) continue;
    hints.push({ name, status: live.status as "trial" | "active" });
  }
  return hints.sort((a, b) => (a.status === b.status ? (a.name < b.name ? -1 : 1) : a.status === "active" ? -1 : 1)).slice(0, MAX_WORKFLOW_HINTS);
}

export type SeedWorkflowsOptions = RepoAt & {
  /** The run's working directory: the project directory the agentrun tool's store reads. */
  readonly into: string;
  /** What `workflowsToTry` found. */
  readonly workflows: readonly WorkflowHint[];
};
export type SeededWorkflows = {
  readonly loaded: readonly { readonly name: string; readonly sha256: string }[];
  readonly skipped: readonly SkippedWorkflow[];
};

/**
 * Host step at run start, after `seedLearning`: puts each workflow to try into the run's own workflow store so the
 * agentrun tool finds it by name. The live revision's record is read at the commit and loaded through the DSL's store in a
 * scratch directory, which refuses a damaged one, then saved into the run's directory through the store, so `latest` names it.
 */
export async function seedWorkflows(options: SeedWorkflowsOptions): Promise<SeededWorkflows> {
  const into = absolute(options.into, "into");
  const loaded: { name: string; sha256: string }[] = [];
  const skipped: SkippedWorkflow[] = [];
  for (const { name } of options.workflows) {
    try {
      const trial = await readTrial(options.repo, name, options.sha);
      const live = trial && currentRevision(trial);
      if (!live) throw new LearnError("missing", "no live revision");
      const record = await options.repo.read(`${workflowDir(name)}/${live.sha256}.json`, options.sha);
      if (record === undefined) throw new LearnError("missing", "the record is not in the repository");
      // A host that starts again, after the agent saved a better revision, must not put the old one back as `latest`.
      const present = await new WorkflowStore(into).list();
      if (present.some((r) => r.name === name && r.digest === live.sha256)) {
        loaded.push({ name, sha256: live.sha256 });
        continue;
      }
      const stored = await scratch(async (tmp) => {
        await writeRegular(tmp, `${workflowDir(name)}/${live.sha256}.json`, record);
        return new WorkflowStore(tmp).load(name, live.sha256);
      });
      await new WorkflowStore(into).save(name, stored.workflow);
      loaded.push({ name, sha256: live.sha256 });
    } catch (error) {
      skipped.push({ name, reason: reasonOf(error) });
    }
  }
  return { loaded, skipped };
}

// ---------------------------------------------------------------- the curator's ports

/** Copies `paths` at main into a fresh directory under `root`, as regular files, and hands it to `use`; removes it after. */
async function staged<T>(root: string | undefined, from: RepoRead, paths: (dir: string) => Promise<readonly string[]>, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(root ?? tmpdir(), "pi-agent-learn-stage-"));
  try {
    for (const file of await paths(dir)) {
      const text = await from.read(file, from.main);
      if (text !== undefined) await writeRegular(dir, file, text);
    }
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type WorkflowAdmitterOptions = {
  /** Where the scratch directory goes: a real directory. Default: the system's. */
  readonly tmpRoot?: string;
  /** The preconditions of each revision, from its document (`schemaWhen` is one). Default: none, and the model decides from
   *  the description. Give `usesSettler` nothing: a revision keeps the preconditions it was admitted with. */
  readonly when?: (workflow: unknown) => readonly Precondition[];
  /** Admit a workflow with a code node or a shell or executor call. Default: hold it. */
  readonly allowExecutableCode?: boolean;
  readonly now?: () => Date;
};

/**
 * The curator's `admitWorkflow` port, over `admitInDir`: it copies main's `trial.json` and skill for the name into a scratch
 * directory, validates the run's records through the DSL's store there, saves the revision the run ended on, and writes the
 * skill (from `description`, the agent's when-to-use text) and `trial.json`. `admitted` carries every path changed, text or
 * null, for the one commit. A workflow with code in it, or one with no trial to describe, is `held`; a name pi cannot load, a
 * record the store refuses, a demoted revision and the limits are `refused`. The curator's judgments of the `untrusted` text
 * have already been made when the port is called, so the flag changes nothing here.
 */
export function workflowAdmitter(options: WorkflowAdmitterOptions = {}): AdmitWorkflow {
  return async (input: AdmitWorkflowInput): Promise<AdmitWorkflowResult> => {
    const { workflow } = input;
    if (typeof workflow?.name !== "string" || !WORKFLOW_SKILL_NAME.test(workflow.name) || workflow.name.length > MAX_NAME) {
      return { status: "refused", reason: "a workflow name is lowercase letters and digits in words joined by single hyphens, so pi can load it as a skill" };
    }
    const name = workflow.name;
    const result = await staged(options.tmpRoot, input, async () => [trialPath(name), skillPath(name)], (dir) => admitInDir({
      dir, runId: workflow.run, name, records: workflow.records,
      ...(workflow.description === undefined ? {} : { description: workflow.description }),
      ...(options.when ? { when: options.when } : {}), ...(options.allowExecutableCode ? { allowExecutableCode: true } : {}), ...(options.now ? { now: options.now } : {}),
    }));
    if (result.status === "refused") return { status: result.reason === "code" || result.reason === "unknown" ? "held" : "refused", reason: `${result.reason}: ${result.detail}` };
    if (result.status === "unchanged") return { status: "unchanged", reason: "the same revision and description are already on main" };
    return { status: "admitted", files: { ...result.files }, reason: result.status === "described" ? `${name}: its skill was written from the description` : `${name}: ${result.sha256!.slice(0, 12)} is the live trial` };
  };
}

export type UsesSettlerOptions = {
  /** Where the scratch directory goes: a real directory. Default: the system's. */
  readonly tmpRoot?: string;
  readonly thresholds?: Partial<Thresholds>;
};

/**
 * The curator's `settleUses` port, over `settleWorkflowUses`: for the run's uses it copies main's `trial.json` of each name,
 * and the records of its superseded revisions, into a scratch directory, folds the uses in by the promotion rules, and
 * returns the changed files and one decision per promotion, demotion or name held, each with a reason that names no value from
 * the case. A trial.json that does not parse holds its name, never the curation.
 */
export function usesSettler(options: UsesSettlerOptions = {}): SettleUses {
  return async (input: SettleUsesInput): Promise<SettleUsesResult> => {
    const decisions: { name: string; action: "promote" | "demote" | "hold"; reason: string; rollbackTo?: string }[] = [];
    let uses: RunUses;
    try {
      uses = parseRunUses(JSON.stringify({ version: 1, run: input.run, uses: input.uses }), input.run);
    } catch {
      return { files: {}, decisions: [{ name: "uses", action: "hold", reason: "the uses file is not well formed, so none were folded" }] };
    }
    const result = await staged(options.tmpRoot, input, async () => [], async (dir) => {
      for (const name of [...new Set(uses.uses.map((use) => use.name))].sort()) {
        const text = await input.read(trialPath(name), input.main);
        if (text === undefined) continue;
        try {
          const trial = parseTrial(text, name);
          await writeRegular(dir, trialPath(name), text);
          for (const revision of trial.revisions.filter((r) => r.status === "superseded")) {
            const record = await input.read(`${workflowDir(name)}/${revision.sha256}.json`, input.main);
            if (record !== undefined) await writeRegular(dir, `${workflowDir(name)}/${revision.sha256}.json`, record);
          }
        } catch (error) {
          if (!(error instanceof LearnError)) throw error;
          decisions.push({ name, action: "hold", reason: `its trial.json does not parse (${error.code}), so its uses were left out` });
          uses = { ...uses, uses: uses.uses.filter((use) => use.name !== name) };
        }
      }
      return settleWorkflowUses({ dir, uses, ...(options.thresholds ? { thresholds: options.thresholds } : {}) });
    });
    for (const { name, decision } of result.decisions) {
      decisions.push({ name, action: decision.action, reason: decision.reason, ...(decision.action === "demote" && decision.rollbackTo ? { rollbackTo: decision.rollbackTo } : {}) });
    }
    for (const { name, reason } of result.held) decisions.push({ name, action: "hold", reason });
    return { files: { ...result.files }, decisions };
  };
}
