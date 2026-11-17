// A run is a process of its own (design: option A). The runner claims as it always did and runs no loop itself: at each
// claim it starts the run's own process (run-child.ts) and hands it, on two inherited descriptors, the run's own keys
// (fd 3: secrets.ts reads and closes it as the process loads) and a channel (fd 4: run-channel.ts). Over the channel the
// run's process asks for what it would otherwise hold: its journal, under the claim's fence (the runner's own journal
// of the claim, LoopDeps.journal); the store reads its loop makes, bound to the claim's run and agent; and what the seal key
// opens for the claim (held.ts), never the key. The runner keeps the claim, its renewals, its commands and its end.
//
// Where the image's helper can switch (agentrun-runas, root:node 0750 with file capabilities), each of the runner's claim
// slots runs as a uid of its own (1001 + slot), in folders of the slot's group (2770) the server's user reads through its
// membership of every slot group: one run can read neither another run's folder nor, being another uid, its memory. A
// slot is reaped at each run's end (every process of its uid killed, its files in /tmp removed, what it left readable to
// the server), and its folders are given back to the server's group.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readdir } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { encode, SECRET_NAMES, SECRETS_FD_ENV, SECRETS_LEN_ENV, withoutSecrets } from "../secrets.js";
import { putLiveViewer, dropLiveViewer } from "../browser-live.js";
import { CALENDAR_EVENTS } from "../calendar/names.js";
import { openCalendar } from "../calendar/address.js";
import { openAccount } from "../email/account.js";
import { harnessOf } from "../harness-table.js";
import { installDirOf, installForClaim } from "../harness-install.js";
import { loadArchilSettings } from "../archil-settings.js";
import { planOf } from "../chatgpt-plan.js";
import { forgottenSignIns, handedSignInReadsBack, peekSignIn, runSignIn, signInReads, verifyRunSignIn } from "../sign-ins-store.js";
import { vendorsOver } from "../sign-ins.js";
import { decisionProvidersIn, fauxFetch } from "../decisions.js";
import { DECISION_PROVIDER_KEYS } from "../tool-plane.js";
import { learningEndOfRun } from "./learning-end.js";
import { runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";
import { FAUX_ENV } from "../model.js";
import { FAUX_VENDOR_API_ENV } from "../tools.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { LEARNING_SCRIPT, learningWorkspace } from "../learn/folder.js";
import { learningFolderOf } from "../learning.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { archilClaim, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { agentDirName, recordingsFolder, runFolder, scratchFolder } from "../workspace/paths.js";
import type { Workspace } from "../workspace/workspace.js";
import { claimSecrets, hostDecisionKeys, savedModelKeys, tierModelKeys } from "./claim-secrets.js";
import { githubAppAccess } from "./github-app.js";
import { heldMcpOf, mcpForClaim } from "./mcp-run.js";
import { mcpReachOf, type AdapterSpecDeps } from "./adapter-run-spec.js";
import { createDispatchLoop } from "./dispatch.js";
import { resolveRunnerLoop } from "./harness-loops.js";
import type { Held, HeldComputerAsk } from "./held.js";
import { type Claim, type Command, type CommandOutcome, type HeldState, type Loop, type LoopDeps, type LoopEnd, type LoopFactory, type StopReason, ClaimRefused } from "./loop-contract.js";
import { Channel, ChannelClosed } from "./run-channel.js";
import { registerRunErrors } from "./run-errors.js";
import { readLaunchBody, type RunLaunch } from "../run-launch.js";
import { SUBAGENT_TOOL } from "./subagent.js";
import type { AlsoRow, JournalReads, Store } from "../store/store.js";
import type { Tier } from "../model.js";

/** The image's helper that starts a run's process as its slot's uid (packages/serve/runas). */
export const RUNAS_HELPER = "/usr/local/bin/agentrun-runas";
/** `same`: every run runs as the runner's own user, the helper unused, said in the runner's log. */
export const RUN_USER_ENV = "AGENTRUN_RUN_USER";
/** The first of this runner's slots (0 by default): two runners on one data directory take ranges of their own. */
export const RUN_SLOT_FIRST_ENV = "AGENTRUN_RUN_SLOT_FIRST";
/** The helper's compiled range: slot s runs as uid and gid FIRST_RUN_ID + s. */
export const FIRST_RUN_ID = 1001;
export const RUN_SLOTS = 256;
/** How long a run's process has to end once its loop was told to stop, before the runner ends it. */
const STOP_GRACE_MS = 30_000;
/** How long a run's process has to exit once its loop ended. */
const EXIT_GRACE_MS = 5_000;

/** How this runner's runs are kept apart: each a process of its own, and with the helper each a uid of its own. */
export type RunIsolation =
  | { readonly kind: "process"; readonly why: string }
  | { readonly kind: "uid"; readonly helper: string; readonly first: number; readonly slots: number };

/** The isolation this host gives a run, as the capabilities document says it: `uid` with the helper, else `process`. */
export const runIsolationName = (isolation: RunIsolation): "uid" | "process" => isolation.kind;

/** A runner that cannot keep its runs apart as the image promises: said in words that name the setting. */
export class RunIsolationRefused extends Error {
  override name = "RunIsolationRefused";
}

const execText = (file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
    });
  });

/** This host's isolation for `loops` runs at once, by `env` and the helper: the helper's own check that it can switch
 *  (its effective set holds what it needs) decides `uid`; none installed (a local install), `process`; `same`, `process`
 *  said in the log. A helper that cannot switch is refused in words naming the setting, never a quiet fall back. */
export async function runIsolationOf(env: NodeJS.ProcessEnv, loops: number, log: (line: string) => void, helper: string = RUNAS_HELPER): Promise<RunIsolation> {
  const asked = env[RUN_USER_ENV];
  if (asked !== undefined && asked !== "" && asked !== "same" && asked !== "slot") throw new RunIsolationRefused(`${RUN_USER_ENV}=${asked} is not a setting this runner knows: unset it (each run as a user of its own, where the image's helper can switch) or set it to "same" (every run as the runner's own user).`);
  if (asked === "same") {
    log(`${RUN_USER_ENV}=same: every run runs as this runner's own user, in a process of its own; one run's tools can read another's folder and the data directory`);
    return { kind: "process", why: `${RUN_USER_ENV}=same` };
  }
  if (!existsSync(helper)) {
    if (asked === "slot") throw new RunIsolationRefused(`${RUN_USER_ENV}=slot asks for a user of its own for each run, and this host has no ${helper}: run the image, or unset ${RUN_USER_ENV}.`);
    return { kind: "process", why: "no helper on this host" };
  }
  const checked = await execText(helper, ["check"], 10_000);
  if (checked.code !== 0) {
    throw new RunIsolationRefused(
      `This runner will not claim runs: it cannot start a run as a user of its own (${checked.stderr.trim() || `${helper} check exited ${checked.code}`}). ` +
        `The platform strips the image's file capabilities, or starts the container with no-new-privileges (Docker's security_opt no-new-privileges:true, Kubernetes' allowPrivilegeEscalation: false). ` +
        `Allow them, or set ${RUN_USER_ENV}=same to run every run as the runner's own user.`,
    );
  }
  const firstText = env[RUN_SLOT_FIRST_ENV];
  const first = firstText === undefined || firstText === "" ? 0 : Number(firstText);
  if (!Number.isSafeInteger(first) || first < 0 || first >= RUN_SLOTS) throw new RunIsolationRefused(`${RUN_SLOT_FIRST_ENV}=${firstText} is not a slot 0..${RUN_SLOTS - 1}.`);
  const slots = Math.min(loops, RUN_SLOTS - first);
  if (slots < 1) throw new RunIsolationRefused(`${RUN_SLOT_FIRST_ENV}=${first} leaves this runner no slot of the ${RUN_SLOTS} the helper reaches.`);
  if (slots < loops) log(`each run runs as a user of its own, and the helper reaches ${slots} from slot ${first}: this runner holds at most ${slots} runs at once`);
  return { kind: "uid", helper, first, slots };
}

/** The runs a runner holds at once, as `uid` isolation lets it: its slots. */
export const isolationLoops = (isolation: RunIsolation, loops: number): number => (isolation.kind === "uid" ? Math.min(loops, isolation.slots) : loops);

/** The slots of a uid runner, each held by one run at a time. */
export class Slots {
  readonly #free: number[];
  constructor(first: number, count: number) {
    this.#free = Array.from({ length: count }, (_, i) => first + count - 1 - i);
  }
  take(): number {
    const slot = this.#free.pop();
    if (slot === undefined) throw new Error("every run slot of this runner is held: it claimed more runs than it has slots");
    return slot;
  }
  give(slot: number): void {
    this.#free.push(slot);
  }
}

/** A slot's uid (and gid). */
export const slotId = (slot: number): number => FIRST_RUN_ID + slot;

// ---------------------------------------------------------------------------------------------------------------------
// The folders of a run, by the slot that runs it.

/** The run's own top folders: its folder (work and recordings beneath it) and its scratch folder. */
export const runTops = (data: string, agentId: string, runId: string): string[] => [dirname(runFolder(data, agentId, runId)), scratchFolder(data, agentId, runId)];

/** The parents a run's process crosses to reach its own folders, each traverse-only (0711) for it. */
const runParents = (data: string, agentId: string, runId: string): string[] => {
  const top = dirname(runFolder(data, agentId, runId));
  const scratch = scratchFolder(data, agentId, runId);
  return [data, join(data, "disk"), join(data, "disk", "agents"), join(data, "disk", "agents", agentDirName(agentId)), dirname(top), join(data, "scratch"), dirname(scratch)];
};

/** Before the run's process starts on `slot`: its parents traverse-only, its top folders the slot group's (2770), and
 *  what an earlier claim's slot left in them given to this slot (the helper's reown). */
async function layRunFolders(isolation: Extract<RunIsolation, { kind: "uid" }>, data: string, agentId: string, runId: string, slot: number): Promise<void> {
  for (const parent of runParents(data, agentId, runId)) {
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o711);
  }
  const gid = slotId(slot);
  for (const top of runTops(data, agentId, runId)) {
    await mkdir(top, { recursive: true });
    await chown(top, process.getuid!(), gid);
    await chmod(top, 0o2770);
    // An earlier claim of this run on another slot left its files that slot's: given to this one, so the run reads and
    // writes what it wrote before.
    for (const other of await slotsUnder(top, slot)) {
      const moved = await execText(isolation.helper, ["reown", String(other), String(slot), top], 120_000);
      if (moved.code !== 0) throw new Error(`the run's folder could not be given to its slot: ${moved.stderr.trim()}`);
    }
  }
  // The folders the run's process opens first, made here in the slot's group (setgid): its folder, its recordings and its
  // temporary folder (its TMPDIR), each one the server reads through the group as the run writes it.
  for (const folder of [runFolder(data, agentId, runId), recordingsFolder(data, agentId, runId), join(scratchFolder(data, agentId, runId), "tmp")]) {
    await mkdir(folder, { recursive: true });
    const stat = await lstat(folder);
    if (stat.uid !== process.getuid!()) continue;
    await chown(folder, process.getuid!(), gid);
    await chmod(folder, 0o2770);
  }
}

/** The other slots that own entries at the top of `dir` or one level down. */
async function slotsUnder(dir: string, slot: number): Promise<number[]> {
  const found = new Set<number>();
  const look = async (at: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      const stat = await lstat(path).catch(() => undefined);
      if (!stat) continue;
      const other = stat.uid - FIRST_RUN_ID;
      if (other >= 0 && other < RUN_SLOTS && other !== slot) found.add(other);
      if (stat.isDirectory() && depth > 0) await look(path, depth - 1);
    }
  };
  await look(dir, 1);
  return [...found];
}

/** After the run's process ended: every process of the slot's uid killed, its files in the shared temporary folders
 *  removed, what it left in its folders readable and removable by the server's group, and its top folders the server's
 *  own again (0770), which the slot's next run cannot enter. */
export async function reapSlot(isolation: Extract<RunIsolation, { kind: "uid" }>, slot: number, tops: readonly string[], log: (line: string) => void): Promise<void> {
  const args = ["reap", String(slot), "--sweep", "/tmp", "--sweep", "/var/tmp", "--sweep", "/dev/shm", ...tops.flatMap((top) => ["--fix", top])];
  const reaped = await execText(isolation.helper, args, 120_000);
  if (reaped.code !== 0) log(`slot ${slot}'s reap said: ${reaped.stderr.trim()}`);
  for (const top of tops) {
    try {
      await chown(top, process.getuid!(), process.getgid!());
      await chmod(top, 0o770);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`the run's folder ${top} was not given back to the server: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What crosses: data alone.

/** `value` as data: every function, symbol and class's method left out, so nothing the runner holds is handed by
 *  reference to the run's process unless a target hands it on purpose. */
export function dataOnly(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => dataOnly(item, seen));
    if (value instanceof Map) return new Map([...value].map(([k, v]) => [dataOnly(k, seen), dataOnly(v, seen)]));
    if (value instanceof Set) return new Set([...value].map((v) => dataOnly(v, seen)));
    if (value instanceof Error) return Object.assign(new Error(value.message), { name: value.name });
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const member = (value as Record<string, unknown>)[key];
      if (typeof member === "function" || typeof member === "symbol") continue;
      Object.defineProperty(out, key, { value: dataOnly(member, seen), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Every string inside `value` cut by `cut`: what the run's process writes, as the runner's redactor would cut it in a
 *  loop of its own (rule three: no secret the runner holds is written). */
export function cutDeep<T>(value: T, cut: (text: string) => string): T {
  if (typeof value === "string") return cut(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map((item) => cutDeep(item, cut)) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, cutDeep(v, cut)])) as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) Object.defineProperty(out, key, { value: cutDeep((value as Record<string, unknown>)[key], cut), enumerable: true, writable: true, configurable: true });
  return out as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// The store, as the run's process reads it: bound to the claim.

/** What the store target knows of the claim: its run and the run's agent and revision. */
export interface Bound {
  readonly claim: Claim;
  readonly agentId: string;
  readonly revisionId: string;
}

type Check = (args: readonly unknown[], bound: Bound) => boolean;
const ownRun: Check = (args, bound) => args[0] === bound.claim.runId;
const ownAgent: Check = (args, bound) => args[0] === bound.agentId;
const ownClaim: Check = (args, bound) => {
  const claim = args[0] as Partial<Claim> | undefined;
  return claim?.runId === bound.claim.runId && claim.epoch === bound.claim.epoch;
};
const agentQuery: Check = (args, bound) => {
  const query = args[0] as { agentId?: unknown } | undefined;
  return typeof query === "object" && query !== null && query.agentId === bound.agentId;
};
const always: Check = () => true;

/** The store's methods a run's loop calls, each with what binds it to the claim. A method not here is refused, and the
 *  refusal is said on the runner's log. Reads of the claim's run, its launch, its commands and its agent's revisions;
 *  of the agent's own runs (its learning reads its past runs); the settings its tools read (no sealed value is a setting:
 *  sealed rows are refused whole). Writes only under the claim. */
const STORE_CALLS: ReadonlyMap<string, Check> = new Map<string, Check>([
  ["flush", always],
  ["runs.get", ownRun],
  ["runs.launch", ownRun],
  ["runs.list", agentQuery],
  ["runs.ofAgent", ownAgent],
  ["runs.update", ownClaim],
  ["runs.metrics", ownRun],
  ["runs.children", ownRun],
  ["commands", ownRun],
  ["answerOf", ownRun],
  ["take", ownClaim],
  ["retry", ownClaim],
  ["agents.get", ownAgent],
  ["agents.revision", always],
  ["agents.revisions", ownAgent],
  ["settings.get", always],
  ["settings.all", always],
  ["mcp.pin", ownRun],
  ["readJournal", ownRun],
  ["learning.proposal", ownRun],
  ["learning.proposals", ownAgent],
  ["learning.list", ownAgent],
  ["learning.get", always],
  ["channels.get", always],
  ["computerLedger.book", ownClaim],
  ["computerLedger.list", ownRun],
  ["live.put", ownClaim],
]);

/** After a call: an answer that names another agent is refused (a revision is read by its id alone). */
const answerBound = (method: string, answer: unknown, bound: Bound): boolean => {
  if (method !== "agents.revision" || answer === undefined || answer === null) return true;
  return (answer as { agentId?: unknown }).agentId === bound.agentId;
};

/** The store target: a call of `method` (`a.b`) with `args`, bound to the claim. */
export async function storeCall(store: object, method: string, args: unknown[], bound: Bound, log: (line: string) => void): Promise<unknown> {
  const check = STORE_CALLS.get(method);
  if (!check || !check(args, bound)) {
    log(`run ${bound.claim.runId}: its process asked the store for ${method}, which a run's process may not`);
    throw new ClaimRefused(`a run's process may not call the store's ${method}${check ? " of another run or agent" : ""}`);
  }
  if (method === "readJournal") return journalRead(store as Store, args);
  const path = method.split(".");
  let target: unknown = store;
  for (const part of path.slice(0, -1)) target = (target as Record<string, unknown>)[part];
  const fn = (target as Record<string, unknown> | undefined)?.[path.at(-1)!];
  if (typeof fn !== "function") throw new ClaimRefused(`the store has no ${method}`);
  const answer = await (fn as (...a: unknown[]) => unknown).apply(target, args);
  if (!answerBound(method, answer, bound)) {
    log(`run ${bound.claim.runId}: its process asked for another agent's revision`);
    throw new ClaimRefused("a run's process may read only its own agent's revisions");
  }
  return dataOnly(answer);
}

/** One read of the run's own journal (Store.readJournal of the claim's run, checked above), as the run's process asks
 *  it: `[runId, read, args]`. Store.readJournal is synchronous, so the process's reader (run-child.ts readerOf) is its
 *  own, each read of it one call here, on a reader opened for it and closed after. */
async function journalRead(store: Store, args: readonly unknown[]): Promise<unknown> {
  const [runId, read, rest] = args;
  if (typeof runId !== "string" || !Array.isArray(rest)) throw new ClaimRefused("a run's process reads its journal by a run, a read and its arguments");
  const reads = store.readJournal(runId);
  try {
    return await readOf(reads, read, rest);
  } finally {
    await reads.close(BACKGROUND_CONTEXT);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The journal, as the run's process writes it: the runner's own of the claim.

/** The journal target: the claim's journal (LoopDeps.journal, behind the runner's fence). Its records are kept as the run
 *  wrote them, as a runner's own loop keeps them (every read that shows one cuts it as it is served, and the run's
 *  learning end reads them whole to refuse a secret in them); what a stage writes beside them (the run's row, its
 *  summary, the rows a person is shown) is cut by the runner's redactor, which holds the server's secrets the process's
 *  own does not. A stage whose apply throws is held and fails the next commit, as the store would have. */
function journalTarget(journal: ReturnType<LoopDeps["journal"]>, cut: (text: string) => string) {
  let staged: unknown;
  return async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "commit": {
        if (staged !== undefined) {
          const error = staged;
          staged = undefined;
          throw error;
        }
        const seqs: [number, unknown][] = [];
        const result = await journal.commit(args[0] as never, (index, seq) => void seqs.push([index, seq]), BACKGROUND_CONTEXT);
        return { result: dataOnly(result), seqs };
      }
      case "stage":
        try {
          journal.stage(cutDeep(args[0] as never, cut));
        } catch (error) {
          staged = error;
        }
        return undefined;
      case "mintId":
        return journal.mintId();
      case "close":
        return undefined;
      default:
        return readOf(journal, method, args);
    }
  };
}

/** One of a journal's reads, `method` with the arguments the run's process passed (it passes no context: the read is made
 *  with the runner's own), its answer data alone. Anything but a read is refused. */
async function readOf(reads: JournalReads, method: unknown, args: readonly unknown[]): Promise<unknown> {
  switch (method) {
    case "conversation":
    case "task":
    case "submission":
      return dataOnly(await (reads[method] as (id: unknown, context: unknown) => Promise<unknown>)(args[0], BACKGROUND_CONTEXT));
    case "entry":
      return dataOnly(args.length >= 2 ? await reads.entry(args[0] as never, args[1] as never, BACKGROUND_CONTEXT) : await reads.entry(args[0] as never, BACKGROUND_CONTEXT));
    case "findLatestHeadMarker":
      return dataOnly(await reads.findLatestHeadMarker(args[0] as never, args[1] as never, BACKGROUND_CONTEXT));
    case "scanConversations":
    case "scanEntries":
    case "scanTasks":
    case "scanSubmissions":
    case "scanDocuments":
      return dataOnly(await (reads[method] as (q: unknown, l: unknown, c: unknown, x: unknown) => Promise<unknown>)(args[0], args[1], args[2], BACKGROUND_CONTEXT));
    case "submissionByRequest":
      return dataOnly(await reads.submissionByRequest(args[0] as never, args[1] as never, BACKGROUND_CONTEXT));
    case "findDocument":
    case "document":
      return dataOnly(await (reads[method] as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(args[0], args[1], BACKGROUND_CONTEXT));
    case "commitsAfter":
      return dataOnly(await reads.commitsAfter(args[0] as never, args[1] as never, BACKGROUND_CONTEXT));
    default:
      throw new ClaimRefused(`a run's journal has no read ${String(method)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the seal key opens, for the one claim.

/** The claim as the runner read it, for heldFor. */
interface ClaimReads {
  readonly claim: Claim;
  readonly run: { readonly agentId: string; readonly revisionId: string; readonly signInHanded: readonly string[] | null };
  readonly launch: import("../run-launch.js").RunLaunch;
  readonly revision: { readonly kind: string; readonly body: Record<string, unknown> };
  readonly claimed: NodeJS.ProcessEnv;
}

/** The email tools a revision may grant. */
const grantsEmail = (granted: readonly string[]): boolean => granted.some((tool) => tool.startsWith("email_"));

/** Held (held.ts) for one claim, on the runner: each answer the claim's own, read with the runner's seal key from the
 *  runner's own reads of the claim; every argument from the run's process is checked or ignored. */
export function heldFor(deps: AdapterSpecDeps & { readonly sealKey: Buffer }, reads: ClaimReads, cut: (text: string) => string, log: (line: string) => void): { held: Held; release(): Promise<void> } {
  const { claim, run, launch, revision, claimed } = reads;
  const sealKey = deps.sealKey;
  const store = deps.store;
  const granted = ((revision.body as { tools?: unknown }).tools as readonly string[] | undefined) ?? [];
  const keys = { store, sealKey, env: deps.env };
  const releases: (() => Promise<void> | void)[] = [];
  const fromGitHub = launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github";
  const github = () => githubAppAccess(store, sealKey, launch.input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub, ...(launch.repo !== undefined ? { repo: launch.repo } : {}) });
  /** Mode 2's Archil claim, made once for the claim on the runner, its folder the run's. */
  let archil: Promise<Awaited<ReturnType<typeof archilClaim>> | undefined> | undefined;
  const archilOf = () =>
    (archil ??= (async () => {
      const settings = await loadArchilSettings(store, deps.env);
      if (settings === undefined) return undefined;
      const made = await archilClaim({ settings, keys: store.sealedKeys, sealKey, signal: new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, run: { agentId: run.agentId, ...(launch.archilDisk ? { launch: launch.archilDisk } : {}), store }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
      releases.push(() => made.release());
      return made;
    })());
  const learningFolder = async () => {
    const made = await archilOf();
    return made === undefined ? learningFolderOf(deps.data, run.agentId) : learningWorkspace({ mode: "archil", agentId: run.agentId, archil: made });
  };
  const held: Held = {
    plan: async () => {
      const plan = planOf(claimed);
      if (!plan) return undefined;
      return { state: plan.state, models: [...plan.models], token: () => plan.token(), refused: (sent: string) => plan.refused(sent), watch: (listener: (tokens: string[]) => void) => plan.watch(listener) };
    },
    signInReadsBack: () => handedSignInReadsBack(store, sealKey, run),
    runSignIn: (resolution) => {
      const vendorFetch = async () => (claimed[FAUX_ENV] ? fauxFetch(claimed, FAUX_VENDOR_API_ENV) : fetch);
      return runSignIn(store, sealKey, claim, String(resolution), { vendors: vendorsOver(() => claimed, vendorFetch), log });
    },
    verifySignIn: (kept, at) => verifyRunSignIn(store, sealKey, claim, kept, Number(at)),
    mcp: async (ask) => {
      const reach = await mcpReachOf(deps);
      const harness = { commit: (change: (tx: unknown) => Promise<unknown>) => change({ appendEntry: async (_conversation: number, entry: unknown) => void (await ask.appendRoot(dataOnly(entry))) }) };
      const made = await mcpForClaim({ claim, store, sealKey, grants: granted, harness: harness as never, work: () => runFolder(deps.data, run.agentId, claim.runId), launchInput: launch.input, githubAppAccess: () => github(), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}), ...reach });
      if (!made) return undefined;
      releases.push(() => made.release());
      return heldMcpOf(made, cut);
    },
    githubAppAccess: async () => {
      const access = await github();
      if (!access) return undefined;
      return { api: access.api, target: dataOnly(access.target) as never, mint: access.mint, ...(access.revoke ? { revoke: access.revoke } : {}), ...(access.same ? { same: access.same } : {}) };
    },
    savedModelKeys: async () => {
      // Only a run whose routes have no revision to scope their keys by: a subagent's tiers, a learning run's grade, an SDK
      // run's grade.
      const reads = granted.includes(SUBAGENT_TOOL) || launch.harness === "learning" || launch.sdk !== undefined;
      return reads ? stringsOf(await savedModelKeys(keys)) : {};
    },
    tierModelKeys: async (tiers) => {
      const got = await tierModelKeys(keys, (tiers as readonly unknown[]).filter((tier): tier is Tier => typeof tier === "string"));
      const plan = planOf(got);
      return { keys: stringsOf(got), ...(plan ? { plan: { state: plan.state, models: [...plan.models], token: () => plan.token(), refused: (sent: string) => plan.refused(sent), watch: (listener: (tokens: string[]) => void) => plan.watch(listener) } } : {}) };
    },
    decisionKeys: (providers) => hostDecisionKeys(keys, (providers as readonly unknown[]).filter((one): one is string => typeof one === "string")),
    liveViewerPut: (handover) => putLiveViewer(store, sealKey, claim, handover),
    liveViewerDrop: (tag) => dropLiveViewer(store, claim, tag),
    handOn: async (from, id) => {
      if (from !== claim.runId || typeof id !== "string") return undefined;
      const sealed = await store.runs.launch(from).then((one) => one.sealed ?? null, () => null);
      const handed = sealed === null ? undefined : openRunMcpAuth(sealKey, from, sealed);
      return handed && Object.keys(handed).length ? sealRunMcpAuth(sealKey, id, handed) : undefined;
    },
    signInPeek: (resolution) => peekSignIn(store, sealKey, run.agentId, String(resolution)),
    signInForgotten: (resolution) => forgottenSignIns(store, sealKey, run.agentId, String(resolution)),
    emailAccount: async () => (grantsEmail(granted) ? openAccount(store, sealKey) : undefined),
    calendar: async () => (granted.includes(CALENDAR_EVENTS) ? openCalendar(store, sealKey) : undefined),
    learning: async (method, args) => learningCall(await learningFolder(), method, args),
    install: async (name, signal) => {
      const harness = launch.harness ?? (revision.body as { harness?: string }).harness;
      const entry = harness === undefined ? undefined : harnessOf(deps.env, harness);
      if (!harness || !entry?.installs || !entry.pins || entry.installs.id !== name) throw new ClaimRefused(`the run's harness installs no ${JSON.stringify(name)}`);
      const lock = deps.harnessLocks?.[harness];
      await (deps.installForClaim ?? installForClaim)(entry.installs, installDirOf(deps.data, harness), entry.pins, { ...(lock ? { lock } : {}), ...(signal ? { signal } : {}) });
    },
    computer: async (ask: HeldComputerAsk) => {
      const made = await archilOf();
      const mode: 1 | 2 = made === undefined ? 1 : 2;
      const ws = made === undefined
        ? await openRunWorkspace({ mode: 1, agentId: run.agentId, runId: claim.runId, data: deps.data, log })
        : await openRunWorkspace({ mode: 2, agentId: run.agentId, runId: claim.runId, archil: made, log });
      const say = typeof ask.say === "function" ? ask.say : undefined;
      const got = await deps.computerForClaim(
        { runId: claim.runId, epoch: claim.epoch, claim, agentId: run.agentId, revisionId: run.revisionId, place: launch.place } as never,
        store,
        {
          ...deps.computerDeps, mode, workspace: ws.workspace, sealKey,
          recordings: { folder: recordingsFolder(deps.data, run.agentId, claim.runId), say: (words: string) => say?.(cut(words)) },
          hadComputer: async () => (await ask.hadComputer()) === true,
          ...(ask.signal instanceof AbortSignal ? { signal: ask.signal } : {}),
          ...(made ? { revokeMount: () => made.revoke(), inheritMount: () => made.inherit() } : {}),
          ...(typeof ask.onImageWait === "function" ? { onImageWait: ask.onImageWait } : {}),
          ...(typeof ask.onStarting === "function" ? { onStarting: ask.onStarting } : {}),
          ...(typeof ask.onConnected === "function" ? { onConnected: ask.onConnected } : {}),
          ...(typeof ask.onComputerNote === "function" ? { onComputerNote: ask.onComputerNote } : {}),
        } as never,
      );
      releases.push(() => ws.end());
      return got;
    },
    archil: async () => {
      const made = await archilOf();
      if (made === undefined) return undefined;
      const ws = await openRunWorkspace({ mode: 2, agentId: run.agentId, runId: claim.runId, archil: made, log });
      releases.push(() => ws.end());
      return { workspace: ws.workspace, revoke: () => made.revoke(), inherit: async () => made.inherit(), release: async () => {} };
    },
    endOfRun: async (input) => {
      // The step as the run's spec builds it in a runner (adapter-run-spec.ts), over the runner's reads of the claim: what
      // the run must never learn is every secret this runner holds, the keys its claim handed it, every secret the server
      // keeps sealed and its sign-in's pointers, none of which the run's process is given.
      const made = await archilOf();
      const step = learningEndOfRun(launch, {
        store,
        data: deps.data,
        ...(deps.env ? { env: deps.env } : {}),
        signIns: signInReads(store, sealKey),
        handed: runnerSecrets(claimed),
        stored: () => storeSecrets(store, sealKey, deps.data),
        log,
        decisionProviders: async () => decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys(keys, DECISION_PROVIDER_KEYS)) }),
        learningFolder: made === undefined ? (agentId: string) => learningFolderOf(deps.data, agentId) : (agentId: string) => learningWorkspace({ mode: "archil", agentId, archil: made }),
      });
      if (!step) return undefined;
      // keptOf is the run's process's, asked over the channel: read once, for the round learningEndOfRun reads (the
      // round after the newest the run kept), before the step reads it at once.
      const prior = await store.learning.proposal(claim.runId);
      const round = prior ? prior.round + 1 : 1;
      const kept = typeof input.keptOf === "function" ? await input.keptOf(round) : undefined;
      const ask = input.ask;
      const rows = await step({
        runId: claim.runId,
        agentId: run.agentId,
        claim,
        outcome: input.outcome === "failed" ? "failed" : "completed",
        ...(input.cut === "stopped" || input.cut === "stopped-looking" || input.cut === "faulted" ? { cut: input.cut } : {}),
        ask: (prompt, opts) => ask(prompt, opts),
        keptOf: (asked) => (asked === round ? kept : undefined),
        signal: input.signal,
      });
      return rows === undefined ? undefined : { also: dataOnly(rows.also ?? []) as AlsoRow[] };
    },
  };
  return {
    held,
    release: async () => {
      for (const release of releases.reverse()) await Promise.resolve(release()).catch((error: unknown) => log(`run ${claim.runId}: a release on its runner failed: ${(error as Error)?.message ?? error}`));
    },
  };
}

/** `env`'s string values. */
const stringsOf = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.getOwnPropertyNames(env).flatMap((name) => (typeof env[name] === "string" ? [[name, env[name]!]] : [])));

/** The learning-script ops a run's process may run (learn/folder.ts): its reads alone. The folder's writers (the
 *  end-of-run step's check, the learning run's merge, a repair) are the runner's. */
const LEARNING_OPS = new Set(["read", "show", "has", "log", "diff", "status"]);

/** A call of the learning folder a run's process asks (Held.learning), on the runner's own Workspace of the claim's
 *  agent's folder: reads pass, and the learning script runs its reads, with the script's own environment (the script
 *  laid by the runner as the folder's own); nothing the process asks writes there. */
export async function learningCall(folder: { readonly workspace: Workspace; end(): Promise<void> }, method: string, args: readonly unknown[]): Promise<unknown> {
  const ws = folder.workspace;
  try {
    switch (method) {
      case "read":
        return await ws.read(String(args[0]), args[1] as never);
      case "stat":
        return dataOnly(await ws.stat(String(args[0])));
      case "list":
        return dataOnly(await ws.list(String(args[0])));
      case "grep":
        return dataOnly(await ws.grep(String(args[0]), args[1] as never));
      case "write":
        // The learning script laid as learn/folder.ts lays it (ensureScript, before a script run): the runner's own text.
        if (args[0] === LEARNING_SCRIPT.file()) return await LEARNING_SCRIPT.ensure(ws);
        throw new ClaimRefused(`a run's process may not write ${JSON.stringify(args[0])} in its learning folder`);
      case "append":
      case "remove":
      case "mkdir":
        throw new ClaimRefused(`a run's process may not ${method} ${JSON.stringify(args[0])} in its learning folder`);
      case "exec": {
        const argv = args[0] as unknown[];
        const options = (args[1] ?? {}) as { stdin?: unknown };
        if (!Array.isArray(argv) || argv[0] !== "sh" || argv[1] !== LEARNING_SCRIPT.file() || !LEARNING_OPS.has(String(argv[2])) || !argv.every((part) => typeof part === "string")) throw new ClaimRefused("a run's process runs no program in its learning folder but its learning script");
        await LEARNING_SCRIPT.ensure(ws);
        return dataOnly(await ws.exec(argv as string[], { env: LEARNING_SCRIPT.env(), timeoutMs: LEARNING_SCRIPT.timeoutMs(), ...(options.stdin instanceof Uint8Array ? { stdin: options.stdin } : {}) }));
      }
      default:
        throw new ClaimRefused(`a run's learning folder has no ${method} in its process`);
    }
  } finally {
    await folder.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The run's process.

/** What the runner's child loops share: its deps (its seal key), its isolation, its slots, its log. */
export interface ChildLoopsOptions {
  readonly deps: AdapterSpecDeps & { readonly sealKey: Buffer };
  readonly isolation: RunIsolation;
  readonly log: (line: string) => void;
  /** The program a run's process starts with (default this Node and dist/runner/run-child.js under dist/secrets.js). */
  readonly argv?: readonly string[];
}

/** The node and module a run's process starts with. */
export const childArgv = (): string[] => [process.execPath, "--import", new URL("../secrets.js", import.meta.url).pathname, new URL("./run-child.js", import.meta.url).pathname];

/** The runner's loop factory where each run is a process of its own: a ChildLoop per claim. A built-in learning run (its
 *  launch names harness "learning") stays in the runner: it runs no agent's code or tool (its grade is one ask through
 *  the runner's model route), and its one write is the merge into the agent's learning folder, which no run's process
 *  may write. */
export function childLoops(options: ChildLoopsOptions): LoopFactory {
  const slots = options.isolation.kind === "uid" ? new Slots(options.isolation.first, options.isolation.slots) : undefined;
  const own: LoopFactory = (loopDeps) => childLoop(options, slots, loopDeps);
  const here = resolveRunnerLoop(options.deps);
  return createDispatchLoop({
    launchOf: (runId) => options.deps.store.runs.launch(runId),
    resolve: (harness, launch, runId) => (harness === "learning" ? here(harness, launch, runId) : own),
  });
}

registerRunErrors();

/** The environment a run's process starts with: the runner's run environment's plain values (runEnv: its secrets are
 *  not enumerable, so none is here), no key-shaped name, and where its keys come from. */
function childEnv(base: NodeJS.ProcessEnv, keys: Buffer, extra: Record<string, string>): NodeJS.ProcessEnv {
  const plain: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(base)) if (typeof base[name] === "string") plain[name] = base[name];
  const env = withoutSecrets(plain);
  for (const name of SECRET_NAMES) delete env[name];
  return { ...env, ...extra, [SECRETS_FD_ENV]: "3", [SECRETS_LEN_ENV]: String(keys.length) };
}

function childLoop(options: ChildLoopsOptions, slots: Slots | undefined, loopDeps: LoopDeps): Loop {
  const { deps, isolation } = options;
  const cut: (text: string) => string = loopDeps.redact ?? ((text) => text);
  const log = (line: string) => options.log(cut(line));
  let channel: Channel | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let stopping: StopReason | undefined;
  let keeps = false;
  let latest: HeldState | undefined;
  let started: Promise<LoopEnd> | undefined;
  /** Resolved once the run's process has its channel (or its start failed first): a command or a stop handed over
   *  before then waits for it, as the dispatch buffers what comes before its inner loop is chosen. */
  let ready!: () => void;
  const up = new Promise<void>((resolve) => (ready = resolve));
  /** The slot the run's process runs on (uid isolation), from its spawn to its reap. */
  let slotHeld: number | undefined;
  /** Kills the run's process and every process it started: its group (process isolation; a program that left the group
   *  with setsid escapes it, a local install's limit), or every process of its slot's uid (uid isolation). */
  const kill = async (): Promise<void> => {
    if (isolation.kind === "uid" && slotHeld !== undefined) {
      const reaped = await execText(isolation.helper, ["reap", String(slotHeld)], 120_000);
      if (reaped.code !== 0) log(`slot ${slotHeld}'s kill said: ${reaped.stderr.trim()}`);
      return;
    }
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  /** Ends the run's process: its channel closed (its loop ended), a grace to exit, then everything it left killed and, on
   *  a slot, the slot reaped. */
  const end = async (slot: number | undefined, tops: readonly string[]): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const gone = exited ? Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, EXIT_GRACE_MS)))]) : Promise.resolve();
    channel?.close();
    await gone;
    clearTimeout(timer);
    if (isolation.kind === "uid" && slot !== undefined) await reapSlot(isolation, slot, tops, log);
    else await kill();
    await exited?.catch(() => undefined);
  };
  return {
    start(claim) {
      return (started ??= (async (): Promise<LoopEnd> => {
        const runRow = await deps.store.runs.get(claim.runId);
        if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
        const launch = readLaunchBody((await deps.store.runs.launch(claim.runId)).body);
        if (!launch) throw new Error(`run ${claim.runId}: its launch record could not be read as a launch`);
        const revisionRow = await deps.store.agents.revision(runRow.revisionId);
        if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
        const revision = { kind: revisionRow.kind, body: (revisionRow.body ?? {}) as Record<string, unknown> };
        // The run's own keys: those its claim opens (claim-secrets.ts), the one list its loop in this process read.
        const claimed = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as never, launch);
        // With them, its revision's own model's (a launch pinned at its start to another model, a --faux start's, is still
        // handed its agent's model's key, as a run's own process was handed it before: run-secrets.ts secretsFor).
        const ofRevision = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as never, { ...(launch.plane ? { plane: launch.plane } : {}) });
        const handed = (name: string): string | undefined => [claimed[name], ofRevision[name]].find((value): value is string => typeof value === "string" && value !== "");
        const keys = encode(SECRET_NAMES.flatMap((name) => {
          const value = handed(name);
          return value === undefined ? [] : [[name, value] as const];
        }));
        const slot = slots?.take();
        slotHeld = slot;
        const tops = runTops(deps.data, runRow.agentId, claim.runId);
        const heldSide = heldFor(deps, { claim, run: runRow, launch, revision, claimed }, cut, log);
        try {
          let extra: Record<string, string> = {};
          let argv = [...(options.argv ?? childArgv())];
          if (isolation.kind === "uid" && slot !== undefined) {
            await layRunFolders(isolation, deps.data, runRow.agentId, claim.runId, slot);
            const scratch = scratchFolder(deps.data, runRow.agentId, claim.runId);
            const tmp = join(scratch, "tmp");
            extra = { TMPDIR: tmp, HOME: scratch };
            argv = [isolation.helper, "run", String(slot), "--keep-fd", "3", "--keep-fd", "4", "--", ...argv];
          }
          const env = childEnv(deps.env, keys, extra);
          const [program, ...rest] = argv;
          child = spawn(program!, rest, { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"], env, detached: true });
          exited = new Promise((resolve) => {
            child!.once("exit", (code, signal) => resolve({ code, signal }));
            // A process that never started has no exit to wait for.
            child!.once("error", (error) => {
              log(`run ${claim.runId}: its process did not start: ${error.message}`);
              resolve({ code: null, signal: null });
            });
          });
          const keyPipe = child.stdio[3] as Socket;
          keyPipe.on("error", () => undefined);
          keyPipe.end(keys);
          const socket = child.stdio[4] as Socket;
          let broke: Error | undefined;
          channel = new Channel(socket, { onClose: (why) => void (broke ??= why) });
          const bound: Bound = { claim, agentId: runRow.agentId, revisionId: runRow.revisionId };
          channel.expose("store", (method, args) => storeCall(deps.store, method, args, bound, log));
          channel.expose("journal", journalTarget(loopDeps.journal(claim), cut));
          channel.expose("held", (method, args) => {
            const fn = (heldSide.held as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
            if (typeof fn !== "function") throw new ClaimRefused(`the runner holds no ${method} for a run`);
            return fn(...args);
          });
          channel.expose("runner", async (method, args) => {
            switch (method) {
              case "flush":
                return loopDeps.flush();
              case "delivered":
                return loopDeps.delivered;
              case "deliverNow":
                return loopDeps.deliverNow?.();
              case "live":
                latest = (args[0] ?? undefined) as HeldState | undefined;
                keeps = args[1] === true;
                return undefined;
              case "log":
                return void log(String(args[0]));
              default:
                throw new ClaimRefused(`the runner has no ${method} for a run`);
            }
          });
          loopDeps.live?.(() => latest);
          const reach = await mcpReachOf(deps);
          const init = {
            claim, data: deps.data, signal: loopDeps.signal, where: deps.store.where,
            ...(reach.loopback ? { mcpLoopback: true, mcpOwn: reach.own ?? [] } : {}),
            ...(deps.githubApi ? { githubApi: deps.githubApi } : {}),
            ...(deps.githubWeb ? { githubWeb: deps.githubWeb } : {}),
            ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}),
          };
          const ended = channel.call("loop", "start", [init]) as Promise<LoopEnd>;
          // From here a command or a stop goes to the run's process, after its start on the channel.
          ready();
          const died = exited.then((how) => {
            throw Object.assign(new ChannelClosed(`the run's process exited (${how.signal ?? `code ${how.code}`}) before its loop ended`), { died: true });
          });
          try {
            return (await Promise.race([ended, died])) as LoopEnd;
          } catch (error) {
            if (stopping?.kind === "claim-lost" || stopping?.kind === "shutdown") return { state: "interrupted" };
            // The run's process is gone with no end of its own written: thrown, so the runner writes the run's end, failed
            // with why (runner.ts: a loop that threw), as for a loop of its own that threw.
            if (error instanceof ChannelClosed || (error as { died?: boolean }).died) throw new Error(cut(`the run's process ended with its run: ${broke && !(error as { died?: boolean }).died ? `it broke its channel: ${broke.message}` : (error as Error).message}`));
            throw error;
          }
        } finally {
          ready();
          await end(slot, tops).catch((error: unknown) => log(`run ${claim.runId}: its process's end failed: ${(error as Error)?.message ?? error}`));
          await heldSide.release();
          if (slot !== undefined) slots?.give(slot);
          slotHeld = undefined;
        }
      })());
    },
    async command(command: Command): Promise<CommandOutcome> {
      // A row handed over before the run's process is up waits for it (never `later`: an approve that comes as the claim
      // starts is this claim's to answer).
      if (!started) return { later: "the run's loop has not started" };
      await up;
      if (!channel || channel.closed) return { later: "the run's process is not running" };
      return (await channel.call("loop", "command", [dataOnly(command)])) as CommandOutcome;
    },
    async stop(reason: StopReason): Promise<void> {
      stopping = reason;
      if (!started) return;
      await up;
      if (!channel || channel.closed) return;
      const told = channel.call("loop", "stop", [reason]).catch(() => undefined);
      const grace = reason.kind === "command" ? STOP_GRACE_MS : STOP_GRACE_MS / 3;
      let timer: NodeJS.Timeout | undefined;
      const late = await Promise.race([told.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), grace)))]);
      clearTimeout(timer);
      // A loop that did not stop in its grace: its process ends now (its group, or every process of its slot's uid), and
      // the run's start ends as its process's exit says.
      if (late) await kill();
    },
    keepsComputer(reason: StopReason): boolean {
      return reason.kind === "command" && reason.cancel !== true && keeps;
    },
  };
}
