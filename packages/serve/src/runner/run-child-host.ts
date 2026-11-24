// A run is a process of its own (design: option A). The runner claims as it always did and runs no loop itself: at each
// claim it starts the run's own process (run-child.ts) and hands it, on two inherited descriptors, the run's own keys
// (fd 3: secrets.ts reads and closes it as the process loads) and a channel (fd 4: run-channel.ts). Over the channel the
// run's process asks for what it would otherwise hold: its journal, under the claim's fence (the runner's own journal
// of the claim, LoopDeps.journal); the store reads its loop makes, bound to the claim's run and agent; and what the seal key
// opens for the claim (held.ts), never the key. The runner keeps the claim, its renewals, its commands and its end.
//
// Where the image's helper can switch (agentrun-runas, root:node 0750 with file capabilities), each of the runner's claim
// slots runs as a uid of its own (1001 + slot), in its own group alone. While a run holds its slot, its folders are the
// slot's uid's and the runner's group's (2770, setgid, the helper's `own <slot>`), which the server's user reads through
// that one group: the server's user is in no slot's group, and no slot is in the server's, so one run can read neither
// another run's folder nor, being another uid, its memory. A slot is reaped at each run's end (every process of its uid
// killed, its files in /tmp removed), and its folders are given back to the server's user (`own runner`), so the slot's
// next run reaches nothing of them.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { encode, SECRET_NAMES, SECRETS_FD_ENV, SECRETS_LEN_ENV, withoutSecrets } from "../secrets.js";
import { putLiveViewer, dropLiveViewer } from "../browser-live.js";
import { CALENDAR_EVENTS } from "../calendar/names.js";
import { openCalendar } from "../calendar/address.js";
import { openAccount } from "../email/account.js";
import { harnessOf, planRecipeOf, recipeHarness } from "../harness-table.js";
import { openHarnessKeys } from "../harness-keys.js";
import { installDirOf, installForClaim, shareInstall } from "../harness-install.js";
import { loadArchilSettings } from "../archil-settings.js";
import { planOf } from "../chatgpt-plan.js";
import { forgottenSignIns, handedSignInReadsBack, peekSignIn, runSignIn, signInReads, verifyRunSignIn } from "../sign-ins-store.js";
import { vendorsOver } from "../sign-ins.js";
import { decisionProvidersIn, fauxFetch } from "../decisions.js";
import { DECISION_PROVIDER_KEYS } from "../tool-plane.js";
import { learningEndOfRun } from "./learning-end.js";
import { cutDeep, runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";
import { FAUX_ENV, FAUX_PROVIDER, GATEWAY_KEY_ENV } from "../model.js";
import { SAVED_GATEWAY_ENV, savedGatewayIn } from "../model-gateway.js";
import { FAUX_VENDOR_API_ENV } from "../tools.js";
import { withinCarried } from "../paid-calls.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { runZone } from "../environment.js";
import { shadowRunId } from "../learn/audit.js";
import { LEARNING_SCRIPT, learningWorkspace } from "../learn/folder.js";
import { agreeOnOf } from "../learning-setting.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { archilClaim, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { agentDirName, recordingsFolder, runFolder, scratchFolder } from "../workspace/paths.js";
import type { Workspace } from "../workspace/workspace.js";
import { keptKeyOf } from "../workspace/computer-kept.js";
import { claimModelKey, claimSecrets, claimSpendOff, hostDecisionKeys, learnedDecisionKeys, openRunModelKey, savedModelKeys, serverKeyless, tierModelKeys, withoutModelKeys } from "./claim-secrets.js";
import { type GithubAppAccessAt, githubAppAccess } from "./github-app.js";
import { githubPullOf, githubTargetOf } from "../github.js";
import { isObject } from "../validate.js";
import { liveForRun, runnerLiveOf } from "../live-reach.js";
import { type LearnedWorkflow, learningFolderOf, secretsShown } from "../learning.js";
import { learningStartOf, seedFailed } from "../run-launch.js";
import { messageText } from "../run-manifest.js";
import { filesToCopy, placeRunInputs } from "../uploads.js";
import { withAudit } from "./audit.js";
import { compareEndOfRun } from "./compare-end.js";
import type { Compared } from "../learn/promote.js";
import { learnedFirst, type LearnedFirst } from "./learned-first.js";
import { workflowsAt } from "./learning-seed.js";
import { heldMcpOf, mcpForClaim } from "./mcp-run.js";
import { learnedTiers, learnsWorkflows, mcpReachOf, type AdapterSpecDeps } from "./adapter-run-spec.js";
import { createDispatchLoop } from "./dispatch.js";
import { refuseRecipeTriggerRun, resolveRunnerLoop, withSavedGatewayDeps } from "./harness-loops.js";
import { isWorkflowRevision } from "./workflow-loop.js";
import { loginForRun } from "../claude-login.js";
import type { Held, HeldComputerAsk } from "./held.js";
import { heardComputerHold } from "./computer-journal.js";
import { type Claim, type Command, type CommandOutcome, type HeldState, type Loop, type LoopDeps, type LoopEnd, type LoopFactory, type StopReason, ClaimRefused } from "./loop-contract.js";
import { Channel, ChannelClosed } from "./run-channel.js";
import { registerRunErrors } from "./run-errors.js";
import { exposeSaveSlots } from "./save-slots.js";
import { type RunBigWrites, runBigWrites } from "./big-writes.js";
import { type SaveSlots, SERVER_SLOTS } from "../web-save.js";
import { launchOnItsDisk, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { routedSubagentTiers, SUBAGENT_TOOL } from "./subagent.js";
import type { AlsoRow, JournalReads, Store } from "../store/store.js";
import type { Tier } from "../model.js";
import { sourceSyncOf } from "../source-sync/types.js";
import { sourceAuxiliaryAdmitter } from "../source-sync/auxiliary.js";
import { beginSourceIO, type SourceIOReceipt } from "../source-sync/io.js";
import type { ProjectCheckpoint, ProjectUncertain } from "../source-sync/checkpoints.js";
import type { ClaimComputer } from "../workspace/computer-for-claim.js";
import { runTools, type RunTools } from "../workspace/run-tools.js";
import { ProjectHostGate } from "./project-host.js";
import { runProjectCheckpoint } from "./project-checkpoint.js";

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

/** The helper run once: its exit code and output, never a rejection. A spawn error Node throws from execFile itself
 *  (EPERM, say, where a platform forbids the helper's file capabilities; only EACCES, EAGAIN, EMFILE, ENFILE and ENOENT
 *  come to the callback) is `code` -1 with the error's words as `stderr`, so every caller reads it as the failure it is. */
const execText = (file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: (error as Error)?.message ?? String(error) });
    }
  });

/** Whether runIsolationOf gives `env` on this host `process` (every run as the runner's own user), told before it is
 *  asked: `same`, or no helper and not `slot`. A helper that is there but cannot switch refuses the runner instead. */
export const runsAsOwnUser = (env: NodeJS.ProcessEnv, helper: string = RUNAS_HELPER): boolean =>
  env[RUN_USER_ENV] === "same" || (!existsSync(helper) && env[RUN_USER_ENV] !== "slot");

/** This host's isolation for `loops` runs at once, by `env` and the helper: the helper's own check that it can switch
 *  (its effective set holds what it needs) decides `uid`; none installed (a local install), `process`; `same`, `process`
 *  said in the log. A helper that cannot switch is refused in words naming the setting, never a quiet fall back. `loops`
 *  the runner was told (--loops, AGENTRUN_MAX_RUNS) past the helper's last slot from its first is refused too; none told
 *  (a host's memory's count, or no bound), it holds the slots from its first. */
export async function runIsolationOf(env: NodeJS.ProcessEnv, loops: number | undefined, log: (line: string) => void, helper: string = RUNAS_HELPER): Promise<RunIsolation> {
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
  const reach = RUN_SLOTS - first;
  if (loops !== undefined && loops > reach) {
    throw new RunIsolationRefused(
      `This runner will not claim runs: it holds ${loops} at once from ${RUN_SLOT_FIRST_ENV}=${first}, slots ${first}..${first + loops - 1}, and the helper's last slot is ${RUN_SLOTS - 1}. ` +
        `Hold at most ${reach} (--loops, AGENTRUN_MAX_RUNS) or start from a lower ${RUN_SLOT_FIRST_ENV}; runners on one data directory each take a range of their own.`,
    );
  }
  return { kind: "uid", helper, first, slots: loops ?? reach };
}

/** The runs a runner holds at once, as `uid` isolation lets it: its slots. */
export const isolationLoops = (isolation: RunIsolation, loops: number): number => (isolation.kind === "uid" ? Math.min(loops, isolation.slots) : loops);

/** The folder of the data directory where each slot's lock is (`<slot>.lock`, the server's user's alone). */
export const slotLocks = (data: string): string => join(data, "run-slots");

/** Slot `slot`'s lock under `dir`, taken for as long as the process it returns lives: an exclusive flock (util-linux's
 *  flock) its holder keeps until its stdin closes, which the runner's end closes too, so a runner that dies holds no
 *  slot. Undefined when another holds it. */
async function lockSlot(dir: string, slot: number): Promise<ChildProcess | undefined> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Its environment PATH alone: the holder lives as long as the slot is held, and needs none of the runner's.
  const holder = spawn("flock", ["-n", "-E", "75", join(dir, `${slot}.lock`), "sh", "-c", "echo held; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  holder.unref();
  for (const stream of [holder.stdin, holder.stdout, holder.stderr] as unknown as { unref?: () => void }[]) stream?.unref?.();
  let said = "";
  holder.stderr!.on("data", (chunk) => void (said += chunk));
  return new Promise((resolve, reject) => {
    holder.stdout!.once("data", () => resolve(holder));
    holder.once("error", (error) => reject(new Error(`slot ${slot}'s lock could not be taken: ${error.message}`)));
    holder.once("exit", (code) => (code === 75 ? resolve(undefined) : reject(new Error(`slot ${slot}'s lock could not be taken: flock exited ${code}${said ? `: ${said.trim()}` : ""}`))));
  });
}

/** Ends a slot's lock: its holder's stdin closed, and its exit waited for. */
async function unlockSlot(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) return;
  const gone = new Promise((resolve) => holder.once("exit", resolve));
  holder.stdin?.end();
  await gone;
}

/** The slots of a uid runner, each held by one run at a time. With `locks` (the data directory's slotLocks), each slot
 *  taken is locked there too, so runners on one data directory whose ranges overlap never run two runs on one slot: a
 *  slot another runner holds is skipped. */
export class Slots {
  readonly #free: number[];
  readonly #locks: string | undefined;
  readonly #held = new Map<number, ChildProcess>();
  readonly #retired = new Set<number>();
  constructor(first: number, count: number, locks?: string) {
    this.#free = Array.from({ length: count }, (_, i) => first + count - 1 - i);
    this.#locks = locks;
  }
  /** A free slot of this runner no other runner holds; undefined when another holds every free one, or every slot not
   *  held is retired. */
  async take(): Promise<number | undefined> {
    if (this.#free.length === 0 && this.#retired.size > 0) return undefined;
    if (this.#free.length === 0) throw new Error("every run slot of this runner is held: it claimed more runs than it has slots");
    if (this.#locks === undefined) return this.#free.pop();
    for (const slot of [...this.#free].reverse()) {
      if (!this.#free.includes(slot)) continue;
      const holder = await lockSlot(this.#locks, slot);
      if (!holder) continue;
      this.#free.splice(this.#free.indexOf(slot), 1);
      this.#held.set(slot, holder);
      return slot;
    }
    return undefined;
  }
  /** Never gives `slot` back: a slot whose reap did not hold (a process of its uid may still be alive) runs no run of
   *  this runner again, and its lock is kept, so no other runner on the data directory takes it either. */
  retire(slot: number): void {
    this.#retired.add(slot);
  }
  /** The slots retired (retire). */
  get retired(): readonly number[] {
    return [...this.#retired];
  }
  /** Gives `slot` back, its lock ended first. */
  async give(slot: number): Promise<void> {
    const holder = this.#held.get(slot);
    this.#held.delete(slot);
    if (holder) await unlockSlot(holder);
    this.#free.push(slot);
  }
}

/** A slot's uid (and gid). */
export const slotId = (slot: number): number => FIRST_RUN_ID + slot;

/** One run's hold on its slot, bound at its spawn: a kill reaps this slot alone, and only while the run holds it. Once
 *  settled, no kill starts, and the settle ends only when every kill already reaping has ended, so the slot goes back
 *  (and its next run starts) with no reap of this run still killing the slot's uid. */
export class SlotHold {
  #settled = false;
  readonly #kills = new Set<Promise<unknown>>();
  readonly slot: number;
  readonly #helper: string;
  readonly #log: (line: string) => void;
  constructor(slot: number, helper: string, log: (line: string) => void) {
    this.slot = slot;
    this.#helper = helper;
    this.#log = log;
  }
  async kill(): Promise<void> {
    if (this.#settled) return;
    const reaping = execText(this.#helper, ["reap", String(this.slot)], 120_000);
    this.#kills.add(reaping);
    try {
      const reaped = await reaping;
      if (reaped.code !== 0) this.#log(`slot ${this.slot}'s kill said: ${reaped.stderr.trim()}`);
    } finally {
      this.#kills.delete(reaping);
    }
  }
  async settle(): Promise<void> {
    this.#settled = true;
    await Promise.all(this.#kills);
  }
}

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

/** Before the run's process starts on `slot`: its parents traverse-only, the folders its process opens first made (its
 *  folder, its recordings and its temporary folder, its TMPDIR), and its top folders with everything in them given to the
 *  slot (the helper's `own <slot>`: the slot's uid, the runner's group, folders 2770). What an earlier claim's slot left,
 *  and what the server's user placed at this claim, is the slot's with the rest. */
async function layRunFolders(isolation: Extract<RunIsolation, { kind: "uid" }>, data: string, agentId: string, runId: string, slot: number): Promise<void> {
  for (const parent of runParents(data, agentId, runId)) {
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o711);
  }
  const tops = runTops(data, agentId, runId);
  for (const folder of [...tops, runFolder(data, agentId, runId), recordingsFolder(data, agentId, runId), join(scratchFolder(data, agentId, runId), "tmp")]) await mkdir(folder, { recursive: true });
  const given = await execText(isolation.helper, ["own", String(slot), ...tops], 120_000);
  if (given.code !== 0) throw new Error(`the run's folders could not be given to its slot: ${given.stderr.trim() || `${isolation.helper} own exited ${given.code}`}`);
}

/** The host's shared folders a slot's uid can leave a file in, each swept at its reap (/var/lock is /run/lock's link on
 *  Debian, swept as itself where it is a folder of its own). SysV IPC is not swept. */
const SWEPT = ["/tmp", "/var/tmp", "/dev/shm", "/run/lock", "/var/lock", "/dev/mqueue"] as const;

/** At a claim, before anything of the run is placed: its top folders and everything in them the server's user's again
 *  (the helper's `own runner`), whoever an earlier claim left them to. Throws, in words, when they could not be. */
export async function takeBackRunFolders(isolation: Extract<RunIsolation, { kind: "uid" }>, tops: readonly string[]): Promise<void> {
  const taken = await execText(isolation.helper, ["own", "runner", ...tops], 120_000);
  if (taken.code !== 0) throw new Error(`the run's folders could not be taken back from the slot an earlier claim left them to: ${taken.stderr.trim() || `${isolation.helper} own exited ${taken.code}`}`);
}

/** After the run's process ended: every process of the slot's uid killed, its files in the shared temporary folders
 *  removed, and its top folders with everything in them given back to the server's user (the helper's `own runner`:
 *  the server's uid and group, folders 2770), which the slot's next run cannot enter. Whether the reap held: the helper
 *  kills until no process of the uid is left, and says so, and the folders were given back; false when a process still
 *  is, or either step could not run (the slot is then never run on again by this runner). */
export async function reapSlot(isolation: Extract<RunIsolation, { kind: "uid" }>, slot: number, tops: readonly string[], log: (line: string) => void): Promise<boolean> {
  const reaped = await execText(isolation.helper, ["reap", String(slot), ...SWEPT.flatMap((dir) => ["--sweep", dir])], 120_000);
  if (reaped.code !== 0) log(`slot ${slot}'s reap said: ${reaped.stderr.trim()}`);
  // Given back whether or not the reap held: a process of the slot's uid still alive then reaches its folders no more.
  let back = true;
  if (tops.length) {
    const given = await execText(isolation.helper, ["own", "runner", ...tops], 120_000);
    if (given.code !== 0) {
      log(`slot ${slot}'s folders were not all given back to the server: ${given.stderr.trim()}`);
      back = false;
    }
  }
  return reaped.code === 0 && back;
}

/** After a reap that held: the run's scratch folder as a claim's end in the runner's own process leaves it (cli-run-spec.ts
 *  sweepScratch), with the temporary folder the runner laid for its process (its TMPDIR) gone too. The agent's folder
 *  above it stays: another run's start may be laying it (0711) at this moment, and the start sweep takes it once empty.
 *  Logged, never thrown. */
async function sweepRunScratch(data: string, agentId: string, claim: Claim, log: (line: string) => void): Promise<void> {
  const scratch = scratchFolder(data, agentId, claim.runId);
  const harnesses = join(scratch, "harness");
  try {
    await rm(join(scratch, "tmp"), { recursive: true, force: true });
    const { sweepScratch } = await import("./cli-run-spec.js");
    await sweepScratch(harnesses, claim.epoch, [harnesses, scratch]);
  } catch (error) {
    log(`run ${claim.runId}: its scratch folder could not be swept: ${(error as Error)?.message ?? error}`);
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
/** The claim's run, or its own audit's shadow run, whose spend its cap gates read beside it (learning-end.ts besideOf). */
const ownRunOrShadow: Check = (args, bound) => args[0] === bound.claim.runId || args[0] === shadowRunId(bound.claim.runId);
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

/** The settings a run's process may read, the server's own configuration its loop and tools read: its tool settings,
 *  its Archil settings (no credential), its MCP hosts and server names, its Claude-login mode and its approvers. */
const SHARED_SETTINGS: ReadonlySet<string> = new Set(["tool-settings", "archil", "mcp.private_oauth_hosts", "mcp.server_own", "claude_login", "approvers"]);

/** The settings of the claim's own run and agent a run's process may read: its run's Archil disk, SDK record, kept
 *  computer and browser wait, and its agent's Archil disk and promotions. Every other row (another run's or agent's) is
 *  not its to read. */
const ownSettings = (bound: Bound): ReadonlySet<string> => new Set([
  `archil.run.${bound.claim.runId}`,
  `sdk-run:${bound.claim.runId}`,
  keptKeyOf(bound.claim.runId),
  `browser_wait_ended:${bound.claim.runId}`,
  `archil.agent.${bound.agentId}`,
  `learning.promotions.${bound.agentId}`,
]);

/** Whether a run's process may read setting `key`. */
export const settingReadable = (key: unknown, bound: Bound): boolean => typeof key === "string" && (SHARED_SETTINGS.has(key) || ownSettings(bound).has(key));
const readableSetting: Check = (args, bound) => settingReadable(args[0], bound);

/** The store's methods a run's loop calls, each with what binds it to the claim. A method not here is refused, and the
 *  refusal is said on the runner's log. Reads of the claim's run, its launch, its commands and its agent's revisions;
 *  of what was spent beside it (its learning grades, its own audit's shadow run's row and launch, which its cap gates
 *  read); of the agent's own runs (its learning reads its past runs); the server's settings its tools read and the
 *  claim's own rows (settingReadable). Writes only under the claim. */
const STORE_CALLS: ReadonlyMap<string, Check> = new Map<string, Check>([
  ["flush", always],
  ["runs.get", ownRunOrShadow],
  ["runs.launch", ownRunOrShadow],
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
  ["settings.get", readableSetting],
  // Its rows filtered to the readable ones (storeCall).
  ["settings.all", always],
  ["mcp.pin", ownRun],
  ["readJournal", ownRun],
  ["learning.proposal", ownRun],
  ["learning.spentBeside", ownRun],
  ["learning.proposals", ownAgent],
  ["learning.list", ownAgent],
  ["learning.get", always],
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
  if (method === "settings.all") return dataOnly((answer as readonly { key: unknown }[]).filter((row) => settingReadable(row.key, bound)));
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
  readonly signal?: AbortSignal;
  /** The runner's presence incarnation (LoopDeps.incarnation): with the claim's runner, who keeps a computer a park pins. */
  readonly incarnation?: string;
}

/** The email tools a revision may grant. */
const grantsEmail = (granted: readonly string[]): boolean => granted.some((tool) => tool.startsWith("email_"));

/** Held (held.ts) for one claim, on the runner: each answer the claim's own, read with the runner's seal key from the
 *  runner's own reads of the claim; every argument from the run's process is checked or ignored. `bigs`: the run's pieced
 *  writes (big-writes.ts), let go at the claim's release and, by the caller, when the run's channel ends. */
export function heldFor(deps: AdapterSpecDeps & { readonly sealKey: Buffer }, reads: ClaimReads, cut: (text: string) => string, log: (line: string) => void, bigs: RunBigWrites = runBigWrites()): { held: Held; inputs(): Promise<void>; release(): Promise<void>; projectEnd?(): Promise<void> } {
  const { claim, run, launch, revision, claimed } = reads;
  const sealKey = deps.sealKey;
  const store = deps.store;
  const granted = ((revision.body as { tools?: unknown }).tools as readonly string[] | undefined) ?? [];
  const admitAuxiliary = sourceAuxiliaryAdmitter(store, { data: deps.data, sealKey, env: deps.env, control: { ...deps.mountControl, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } });
  const keys = { store, sealKey, env: deps.env };
  const releases: (() => Promise<void> | void)[] = [() => bigs.close()];
  const source = sourceSyncOf(revision.body), placed = launch.sourceProject;
  const moved = !!source && !!placed && source.id === placed.sourceId && source.project === placed.digest && placed.baselineRevision === run.revisionId;
  const projectGate = moved ? new ProjectHostGate() : undefined;
  const projectStop = new AbortController();
  const projectSignal = reads.signal ? AbortSignal.any([reads.signal, projectStop.signal]) : projectStop.signal;
  let projectIO: Promise<SourceIOReceipt> | undefined, projectCapture: Promise<ProjectCheckpoint> | undefined;
  let projectComputer: ClaimComputer | undefined, projectWorkspace: Workspace | undefined, projectMode: 1 | 2 = 1;
  let projectFailed = false, projectReleased = false, projectClosing = false, projectCaptureDone = false;
  let projectRelease: Promise<void> | undefined;
  let projectCleanup: Promise<unknown> | undefined;
  const projectOwns = async (settlingAudit = false): Promise<void> => {
    projectSignal.throwIfAborted();
    const row = await store.runs.get(claim.runId);
    // A never-waiting audit journals its Ask/cap as parked before terminalizing under this same claim. Only its
    // checkpoint may finish from that state; ordinary held calls still require running, and claim identity is exact.
    const settlingParkedAudit = settlingAudit && launch.audit !== undefined && row?.state === "parked";
    if (!row || row.agentId !== run.agentId || row.revisionId !== run.revisionId || row.epoch !== claim.epoch || row.runner !== claim.runner || row.state !== "running" && !settlingParkedAudit)
      throw new ClaimRefused("This project checkpoint no longer holds its original run claim.");
  };
  const ownProject = async (settlingAudit = false): Promise<void> => {
    if (!projectGate) return;
    await projectOwns(settlingAudit);
    await (projectIO ??= beginSourceIO(store, run.agentId, "snapshot"));
  };
  const projectCall = <T>(work: () => Promise<T>): Promise<T> => projectGate ? projectGate.run(async () => { await ownProject(); return work(); }) : work();
  const projectWorkSettled = async (): Promise<void> => { await projectCapture; await projectGate?.drain(); };
  const projectSettled = async (): Promise<void> => { await projectWorkSettled(); await projectCleanup?.catch(() => undefined); };
  /** Cleanup closes capture admission synchronously. A capture already admitted finishes first; one arriving later
   *  cannot use resources being relinquished. Cleanup itself remains owned and is awaited by the host's release. */
  const cleanProject = <T>(work: () => Promise<T>): Promise<T> => {
    if (!projectGate) return work();
    if (projectReleased) return Promise.reject(new ClaimRefused("This claim's project resources have already been released."));
    projectClosing = true; projectGate.close();
    const previous = projectCleanup;
    const pending = (async () => { await previous?.catch(() => undefined); await projectWorkSettled(); return work(); })();
    projectCleanup = pending;
    void pending.catch(() => { projectFailed = true; });
    return pending;
  };
  const fromGitHub = launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github";
  const github = () => githubAppAccess(store, sealKey, launch.input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub, ...(launch.repo !== undefined ? { repo: launch.repo } : {}) });
  /** Mode 2's Archil claim, made once for the claim on the runner, its folder the run's. */
  let archil: Promise<Awaited<ReturnType<typeof archilClaim>> | undefined> | undefined;
  const archilOf = () =>
    (archil ??= (async () => {
      const settings = await loadArchilSettings(store, deps.env);
      if (settings === undefined) return undefined;
      const made = await archilClaim({ settings, keys: store.sealedKeys, sealKey, signal: new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS }, ...(deps.mountControl ? { control: deps.mountControl } : {}), run: { agentId: run.agentId, ...(launch.archilDisk ? { launch: launch.archilDisk } : {}), store }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
      releases.push(() => made.release());
      return made;
    })());
  /** Whether the claim's run holds a model key of its own now (its launch, as this runner opens it): its process is then
   *  handed none of the server's (claim-secrets.ts keyedAtClaim, held here for the runner's answers). */
  const runKeyed = async () => (await openRunModelKey(keys, claim.runId)) !== undefined;
  /** Whether the claim's run is held, its model kept from running at its create (hold.refused): it routes no model, so
   *  whatever its process asks, the runner hands it no model key, answers it keyless and refuses it a learning step (its
   *  learned workflows and its end-of-run step), as its spec asks for none of them (adapter-run-spec.ts, cli-run-spec.ts). */
  const modelRefused = launch.hold?.refused !== undefined;
  const refusedSpend = (): ClaimRefused => new ClaimRefused("a held run its model kept from running asks its runner for no model spend: it routes no model and takes no learning step");
  const learningFolder = async () => {
    const made = await archilOf();
    return made === undefined ? learningFolderOf(deps.data, run.agentId) : learningWorkspace({ mode: "archil", agentId: run.agentId, archil: made });
  };
  /** The learning folder's reader, made once the claim's Archil claim is known (learnedFirst's folder is synchronous). */
  const folderNow = async () => {
    const made = await archilOf();
    return () => (made === undefined ? learningFolderOf(deps.data, run.agentId) : learningWorkspace({ mode: "archil", agentId: run.agentId, archil: made }));
  };
  /** What a learned workflow must never hold, as this runner sees it: every secret it holds (learning-seed.ts). */
  const shown = async () => secretsShown(runnerSecrets(deps.env, await storeSecrets(store, sealKey, deps.data)), { local: true });
  /** The workflows the claim's learned_workflow tool runs, as this runner chose them (held.learnedFirst): what scopes the
   *  tier and decision keys it hands. None until it chose. */
  let learnedFlows: readonly LearnedWorkflow[] = [];
  /** The claim's one learned first choice: its promotion's writes are made once, however often the process asks. */
  let chosen: Promise<LearnedFirst> | undefined;
  const held: Held = {
    projectCheckpoint: (...args: [AbortSignal?]) => {
      if (args.length > 1 || args[0] !== undefined && !(args[0] instanceof AbortSignal)) throw new ClaimRefused("A project checkpoint accepts only its cancellation signal.");
      if (!projectGate || !placed || !source) throw new ClaimRefused("This claim has no matching placed source project.");
      if (projectReleased) throw new ClaimRefused("This claim's project resources have already been released.");
      if (projectCapture) return projectCapture;
      if (projectClosing) throw new ClaimRefused("This claim's project resources are closing for cleanup.");
      projectGate.close();
      const signal = args[0] ? AbortSignal.any([projectSignal, args[0], AbortSignal.timeout(60_000)]) : AbortSignal.any([projectSignal, AbortSignal.timeout(60_000)]);
      const uncertain = (): ProjectUncertain => ({ version: 1, status: "uncertain", sourceId: source.id, runId: claim.runId, epoch: claim.epoch, reason: "project_not_settled", stage: "drain" });
      projectCapture = (async () => {
        let checkpoint: ReturnType<typeof runProjectCheckpoint> | undefined;
        let tools: RunTools | undefined;
        let result: ProjectCheckpoint;
        try {
          await projectGate.drain();
          await ownProject(true);
          signal.throwIfAborted(); await projectOwns(true);
          if (projectGate.uncertain) throw new ClaimRefused("An earlier project operation has an unresolved outcome.");
          if (!projectComputer || !projectWorkspace) throw new ClaimRefused("The project's held execution resources are unavailable.");
          checkpoint = runProjectCheckpoint({ store, agentId: run.agentId, claim, launch, computer: projectComputer, ioHeld: true,
            tools: { get workspace() { if (!tools) throw new ClaimRefused("Project settlement has not opened its workspace."); return tools.workspace; },
              settleProject: async () => { tools = await runTools(projectWorkspace!, projectComputer!.computer, { mode: projectMode, context: BACKGROUND_CONTEXT }); return tools.settleProject(); } },
            workspace: { data: deps.data, sealKey, env: deps.env, control: { ...deps.mountControl, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } },
            secrets: async () => runnerSecrets(deps.env, [...runnerSecrets(claimed), ...await storeSecrets(store, sealKey, deps.data)]),
          });
          result = await checkpoint.capture(signal);
          signal.throwIfAborted(); await projectOwns(true);
          if (result.status !== "candidate" && result.status !== "discarded" && !checkpoint.refusalSettled()) projectFailed = true;
        } catch {
          projectFailed = true;
          result = checkpoint?.uncertain() ?? uncertain();
        } finally {
          try { await tools?.end(); }
          catch { projectFailed = true; result = { ...uncertain(), reason: "project_capture_failed", stage: "cleanup" }; }
        }
        return result;
      })().finally(() => { projectCaptureDone = true; });
      return projectCapture;
    },
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
    mcp: (ask) => projectCall(async () => {
      const reach = await mcpReachOf(deps);
      const harness = { commit: (change: (tx: unknown) => Promise<unknown>) => change({ appendEntry: async (_conversation: number, entry: unknown) => void (await ask.appendRoot(dataOnly(entry))) }) };
      const made = await mcpForClaim({ claim, store, sealKey, grants: granted, harness: harness as never, work: () => runFolder(deps.data, run.agentId, claim.runId), launchInput: launch.input, githubAppAccess: () => github(), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}), ...(deps.composioMcpOrigin ? { composioMcpOrigin: deps.composioMcpOrigin } : {}), ...reach, capped: launch.maxCostUsd !== undefined, media: { env: deps.env, web: deps.evalFakes?.(run.agentId)?.web, slots: deps.saveSlots } });
      if (!made) return undefined;
      releases.push(() => made.release());
      const exposed = heldMcpOf(made, cut);
      return projectGate ? projectGate.capability(exposed) : exposed;
    }),
    githubAppAccess: async () => {
      // A run's process mints for one thing alone: its revision's pull-request checkout (pr-checkout.ts), of the pull
      // request its launch's payload names, contents read. Its MCP mints on the runner (mcp above). So the mint handed
      // here makes that token and no other, whatever repository or permissions the process names.
      // A repository checkout's is the repository the run names (its start's repo, else the first https://github.com
      // URL its owner's words name): the same one repository, contents read.
      if (revision.body.checkout !== "pull_request" && revision.body.checkout !== "repository") return undefined;
      const content = isObject(launch.input) ? launch.input.content : launch.input;
      const pull = revision.body.checkout === "pull_request" ? githubPullOf(content, { payload: fromGitHub }) : launch.repo !== undefined ? { repo: launch.repo } : githubTargetOf(content, { payload: fromGitHub });
      if (!pull) return undefined;
      const access = await github();
      if (!access) return undefined;
      const bound = { repo: pull.repo, ...("installation" in pull && pull.installation !== undefined ? { installation: pull.installation } : {}) };
      const mint: GithubAppAccessAt["mint"] = async (to) => {
        if (to?.repo !== bound.repo || to.installation !== bound.installation) {
          log(`run ${claim.runId}: its process asked for a GitHub token of another repository than its pull request's, which a run's process may not`);
          throw new ClaimRefused("a run's process mints a GitHub token only for its own pull request's repository");
        }
        return access.mint(bound, { contents: "read" });
      };
      return { api: access.api, target: bound, mint, ...(access.revoke ? { revoke: access.revoke } : {}), ...(access.same ? { same: access.same } : {}) };
    },
    subagentTierKeys: async () => {
      // A subagent's tiers alone: an agentic run granted the subagent tool routes each tier its revision's modelTiers or
      // the host's tier variable names, and no other (adapter-run-spec.ts), so its process is handed those tiers' models'
      // keys (tierModelKeys, the revision's model of a tier over the host's): never a provider's no tier of it reaches, nor
      // a key for a tier it routes no model on. A replay's or an audit's grade (adapter-run-spec.ts graderRouteOf) routes
      // the fast tier of that same answer, whose model may be another provider's than its agent's: its process is handed
      // that tier's model's key alone (through a gateway, the gateway's), none when the revision names agree_on (no
      // grader). A learning run's grade and an SDK run's compile turn stay in the runner (runsInRunner): their process
      // never asks, and gets none. And never for a run that holds a key of its own (its launch's, read now): the server's
      // keys are not its to spend, whatever its process asks; nor for a held run its model kept from running, which routes
      // no model and grades nothing.
      const subagent = !modelRefused && revision.kind === "agentic" && granted.includes(SUBAGENT_TOOL);
      const grades = !modelRefused && (launch.replay !== undefined || launch.audit !== undefined) && !agreeOnOf((revision.body as { readonly learning?: unknown }).learning)?.length;
      if (!subagent && !grades) return {};
      const { tiers, refs } = routedSubagentTiers(revision.body, keys.env ?? {});
      const keyed = await runKeyed();
      return stringsOf(keyed ? {} : await tierModelKeys(keys, subagent ? tiers : tiers.filter((tier) => tier === "fast"), refs));
    },
    tierModelKeys: async (tiers) => {
      // The tiers the claim's learned workflows name (learnedTiers), as this runner chose them (learnedFirst below): a
      // tier the process names beyond them gets no key, and none before the choice (a held run its model kept from running
      // makes none: its learnedFirst is refused).
      const asked = new Set((tiers as readonly unknown[]).filter((tier): tier is Tier => typeof tier === "string"));
      const named = !modelRefused && learnsWorkflows(revision.kind, learnedFlows) ? learnedTiers(learnedFlows).filter((tier) => asked.has(tier)) : [];
      const keyed = await runKeyed();
      const got = keyed ? {} : await tierModelKeys(keys, named);
      const plan = planOf(got);
      return { keys: stringsOf(got), ...(plan ? { plan: { state: plan.state, models: [...plan.models], token: () => plan.token(), refused: (sent: string) => plan.refused(sent), watch: (listener: (tokens: string[]) => void) => plan.watch(listener) } } : {}) };
    },
    // The decision providers the claim's learned workflows' questions name (learnedDecisionKeys), as this runner chose
    // them: of those, the ones the process asks for (its gate's allowed). Any other provider gets no key.
    decisionKeys: async (providers) => {
      const asked = new Set((providers as readonly unknown[]).filter((one): one is string => typeof one === "string"));
      return learnsWorkflows(revision.kind, learnedFlows) ? learnedDecisionKeys(keys, learnedFlows, (provider) => asked.has(provider)) : {};
    },
    // The claim's own run's key alone (its launch, as the runner reads it), whatever run the process would name.
    runModelKey: () => openRunModelKey(keys, claim.runId),
    // A held run its model kept from running is answered keyless, no saved key read: none of its spend is the server's.
    serverKeyless: async () => modelRefused || serverKeyless(keys),
    // The zone alone, from the claim's own launch's trigger: the process never reads a trigger's row.
    runZone: () => runZone(store, launch.inputOrigin),
    // The keys saved for the claim's own harness alone (harness-keys.ts), whatever the process names: none unless that
    // harness is a plan-billed recipe on this runner's table, and never another harness's. Opened for the recipe file
    // the process loaded (`digest`), never the one this runner's table read at its start: a file swapped for another
    // vendor's under the same id since then runs its own binary, and a key bound to the first file never opens for it.
    harnessKeys: async (digest) => {
      const harness = launch.harness ?? (revision.body as { harness?: string }).harness;
      const recipe = harness === undefined ? undefined : planRecipeOf(deps.env, harness);
      return recipe?.keys.length && typeof digest === "string" ? openHarnessKeys(store, sealKey, { ...recipe, digest }) : {};
    },
    liveViewerPut: (handover) => putLiveViewer(store, sealKey, claim, handover),
    liveViewerDrop: (tag) => dropLiveViewer(store, claim, tag),
    // The claim's own run, whatever the process names: its view on this runner hears the change.
    computerHold: async (change) => heardComputerHold(claim.runId, change, cut),
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
      // The run's process, a slot's user, loads the install itself: read and traverse for every user, never write, an
      // install from before installs were shared too.
      await shareInstall(installDirOf(deps.data, harness));
    },
    computer: (ask: HeldComputerAsk) => projectCall(async () => {
      const made = await archilOf();
      const mode: 1 | 2 = made === undefined ? 1 : 2;
      const ws = made === undefined
        ? await openRunWorkspace({ mode: 1, agentId: run.agentId, runId: claim.runId, data: deps.data, log })
        : await openRunWorkspace({ mode: 2, agentId: run.agentId, runId: claim.runId, archil: made, log });
      const say = typeof ask.say === "function" ? ask.say : undefined;
      const got = await deps.computerForClaim(
        { runId: claim.runId, epoch: claim.epoch, claim, agentId: run.agentId, revisionId: run.revisionId, place: launch.place, ...(reads.incarnation ? { holder: { runner: claim.runner, incarnation: reads.incarnation } } : {}) } as never,
        store,
        {
          ...deps.computerDeps, mode, workspace: ws.workspace, sealKey,
          recordings: { folder: recordingsFolder(deps.data, run.agentId, claim.runId), say: (words: string) => say?.(cut(words)) },
          hadComputer: async () => (await ask.hadComputer()) === true,
          ...(typeof ask.turnedOff === "string" ? { turnedOff: ask.turnedOff } : {}),
          ...(ask.signal instanceof AbortSignal ? { signal: ask.signal } : {}),
          ...(made ? { revokeMount: () => made.revoke(), inheritMount: () => made.inherit() } : {}),
          ...(typeof ask.onImageWait === "function" ? { onImageWait: ask.onImageWait } : {}),
          ...(typeof ask.onStarting === "function" ? { onStarting: ask.onStarting } : {}),
          ...(typeof ask.onConnected === "function" ? { onConnected: ask.onConnected } : {}),
          ...(typeof ask.onComputerNote === "function" ? { onComputerNote: ask.onComputerNote } : {}),
        } as never,
      );
      releases.push(() => ws.end());
      // The computer let go by this runner at the claim's release too, before its folder: a process that crashed or broke
      // its channel never calls its release. Idempotent with the process's own release and with its park (which keeps it).
      const claimed = got as { release?: (why?: "ended") => Promise<void> } | undefined;
      if (typeof claimed?.release === "function") releases.push(() => claimed.release!("ended"));
      if (projectGate) {
        projectComputer = got as ClaimComputer; projectWorkspace = ws.workspace; projectMode = mode;
        const { syncProject: _sync, ...exposed } = got as ClaimComputer;
        return { ...exposed, ...(exposed.computer ? { computer: projectGate.capability(exposed.computer) } : {}),
          release: (...args: Parameters<ClaimComputer["release"]>) => cleanProject(() => exposed.release(...args)),
          ...(exposed.park ? { park: (...args: Parameters<NonNullable<ClaimComputer["park"]>>) => cleanProject(() => exposed.park!(...args)) } : {}) };
      }
      return got;
    }),
    archil: () => projectCall(async () => {
      const made = await archilOf();
      if (made === undefined) return undefined;
      const ws = await openRunWorkspace({ mode: 2, agentId: run.agentId, runId: claim.runId, archil: made, log });
      releases.push(() => ws.end());
      // A write bigger than the channel's frame is pulled in pieces and written here, on this Workspace (big-writes.ts).
      return { workspace: projectGate ? projectGate.capability(ws.workspace) : ws.workspace, pieces: projectGate ? projectGate.capability(bigs.pieces(ws.workspace)) : bigs.pieces(ws.workspace),
        revoke: () => cleanProject(() => made.revoke()), inherit: () => projectCall(async () => made.inherit()), release: async () => {} };
    }),
    endOfRun: async (input) => {
      // None for a held run its model kept from running: its spec builds no end-of-run step, and its runner reads no saved
      // key and starts no audit for one, whatever its process asks.
      if (modelRefused) throw refusedSpend();
      // The step as the run's spec builds it in a runner (adapter-run-spec.ts), over the runner's reads of the claim: what
      // the run must never learn is every secret this runner holds, the keys its claim handed it, every secret the server
      // keeps sealed and its sign-in's pointers, none of which the run's process is given.
      // A replay run or an audit's shadow run learns nothing at its end, as the run's spec says (adapter-run-spec.ts): it
      // compares its answer with the other one through its grader, handed in by the run's process (runner/compare-end.ts).
      // This runner reads both answers and the learning ledger, which no run's process may.
      if (launch.replay || launch.audit) {
        const compare = compareEndOfRun(launch, { store, folder: await folderNow(), log, redact: cut });
        const grade = input.grade;
        const rows = compare && grade && typeof input.grader === "string"
          ? await compare({ runId: claim.runId, agentId: run.agentId, claim, outcome: input.outcome === "failed" ? "failed" : "completed", ...(input.cut === undefined ? {} : { cut: "faulted" as const }), grader: input.grader, grade: (request) => grade(request), ask: input.ask, signal: input.signal })
          : undefined;
        return rows?.compared ? { also: [], compared: dataOnly(rows.compared) as Compared } : undefined;
      }
      const made = await archilOf();
      // The audit's spend, skipped as the run's spec skips it (claim-secrets.ts claimSpendOff): over the claim's own key.
      const spendOff = await claimSpendOff(keys, await claimModelKey(keys, claim.runId));
      // The audit's start after the step (audit.ts withAudit) is this runner's too: it reads the run's journal and writes
      // the ledger and a run.
      const step = withAudit(learningEndOfRun(launch, {
        store,
        data: deps.data,
        ...(deps.env ? { env: deps.env } : {}),
        signIns: signInReads(store, sealKey),
        handed: runnerSecrets(claimed),
        stored: () => storeSecrets(store, sealKey, deps.data),
        log,
        decisionProviders: async () => decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys(keys, DECISION_PROVIDER_KEYS)) }),
        learningFolder: made === undefined ? (agentId: string) => learningFolderOf(deps.data, agentId) : (agentId: string) => learningWorkspace({ mode: "archil", agentId, archil: made }),
      }), { store, agentId: run.agentId, revisionId: run.revisionId, context: BACKGROUND_CONTEXT, folder: await folderNow(), shown, log, sealKey, spendOff, launch, redact: cut, admitAuxiliary });
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
        // A cut the runner does not know is a fault: never an end the run reached on its own, which starts an audit.
        ...(input.cut === undefined ? {} : { cut: input.cut === "stopped" || input.cut === "stopped-looking" ? input.cut : "faulted" }),
        ask: (prompt, opts) => ask(prompt, opts),
        keptOf: (asked) => (asked === round ? kept : undefined),
        signal: input.signal,
      });
      return rows === undefined ? undefined : { also: dataOnly(rows.also ?? []) as AlsoRow[] };
    },
    // None for a held run its model kept from running: it settles no audit, starts no replay run and serves no workflow.
    learnedFirst: (ask) => (modelRefused ? Promise.reject(refusedSpend()) : chosen ??= (async () => {
      // The workflows the claim's seed lays, read by this runner at the launch's seed (learning-seed.ts workflowsAt), as
      // the process's lay chose them: none where its lay laid none (`laid` false: a read that failed, a seed with no
      // workflows).
      const start = learningStartOf(launch);
      const folder = await folderNow();
      const laid = ask?.laid === true && start && !seedFailed(start) && !start.noWorkflows ?await workflowsAt({ folder, store, shown }, start.seed).catch(() => []) : [];
      const spendOff = await claimSpendOff(keys, await claimModelKey(keys, claim.runId));
      const outputSchema = (revision.body as { outputSchema?: unknown }).outputSchema;
      const got = await learnedFirst({ store, sealKey, agentId: run.agentId, runId: claim.runId, revisionId: run.revisionId, kind: revision.kind, ...(outputSchema !== undefined ? { outputSchema } : {}), launch, context: BACKGROUND_CONTEXT, log, folder, shown, spendOff, admitAuxiliary }, laid);
      learnedFlows = got.workflows;
      return cutDeep(dataOnly(got) as LearnedFirst, cut);
    })()),
    liveAt: async () => {
      const live = runnerLiveOf(deps.env ?? {}, sealKey);
      if (!live) return undefined;
      const own = liveForRun(live, claim.runId);
      return { host: own.host, bind: own.bind, key: new Uint8Array(own.key) };
    },
  };
  return {
    held,
    inputs: () => projectCall(async () => {
      // The run's uploads and its opening message (uploads.ts placeRunInputs), placed by this runner before the run's
      // process starts: their hold is the server's alone.
      const made = await archilOf();
      const ws = made === undefined
        ? await openRunWorkspace({ mode: 1, agentId: run.agentId, runId: claim.runId, data: deps.data, log })
        : await openRunWorkspace({ mode: 2, agentId: run.agentId, runId: claim.runId, archil: made, log });
      try {
        await placeRunInputs(deps.data, claim.runId, ws.workspace, filesToCopy(launch), messageText(launch.input));
      } finally {
        await ws.end();
      }
    }),
    release: () => projectRelease ??= (async () => {
      projectReleased = true; projectGate?.close();
      await projectSettled();
      let failed = false;
      for (const release of releases.reverse()) await Promise.resolve(release()).catch((error: unknown) => { failed = true; log(`run ${claim.runId}: a release on its runner failed: ${(error as Error)?.message ?? error}`); });
      if (projectIO && !failed && !projectFailed && !projectGate?.uncertain && !projectSignal.aborted) await (await projectIO).settled();
    })(),
    ...(projectGate ? { projectEnd: async () => {
      if (projectCapture && !projectCaptureDone) projectStop.abort(new Error("The project host is ending."));
      projectReleased = true;
      projectGate.close(); await projectSettled();
    } } : {}),
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

/** Whether a run stays in its runner's process rather than one of its own: one that runs no agent's code or tool here.
 *  A built-in learning run (its launch names harness "learning"): its grade is one ask through the runner's model route,
 *  and its one write is the merge into the agent's learning folder, which no run's process may write. An SDK backend
 *  run (launch.sdk): its agent runs in the caller's application, and its loop here reads the evidence it posts and closes
 *  its inbox. A CLI capture (launch.cli_learning) likewise only receives source evidence and serves owner corrections.
 *  A native run (launch.native): its agent is the source machine's own sign-in, reached through the server's
 *  connectors, whose rows are the server's. */
export const runsInRunner = (harness: string, launch: Pick<RunLaunch, "sdk" | "native" | "cli_learning">): boolean => harness === "learning" || Boolean(launch.sdk) || Boolean(launch.native) || Boolean(launch.cli_learning);

/** The words a run on Claude Code's login on this machine is refused in where each run is a user of its own. */
export const LOGIN_NEEDS_SERVER_USER = `A run on Claude Code's login on this machine needs runs under the server's own user, and this runner runs each run as a user of its own: set ${RUN_USER_ENV}=same, or give the run a model_key.`;
/** The words a run on a harness recipe is refused in where each run is a user of its own (harness-table.ts recipeHarness). */
export const RECIPE_NEEDS_SERVER_USER = `A run on a harness recipe needs runs under the server's own user, since its install, its check and its owner's sign-in are that user's alone, and this runner runs each run as a user of its own: set ${RUN_USER_ENV}=same on this runner.`;
export { RECIPE_SIGN_IN_PERSON_ONLY } from "./harness-loops.js";

/** Whether run `runId` stays in its runner's process: runsInRunner's, and a workflow run on a server with a documents
 *  directory (launch.documents), whose reads and writes (a pdf_pages call's pages) are rooted in a folder the server's
 *  user holds and no slot's user is given; its nodes run the server's own tools alone, no agent's code. A run on Claude
 *  Code's login on this machine (claude-login.ts loginForRun) needs the login in the server's own folder, which its CLI
 *  reads and refreshes: where runs are the runner's own user (`process`) it stays in the runner; where each run is a user
 *  of its own (`uid`) it is refused at its claim (ClaimRefused, the run failed in words naming the setting), never run as
 *  the server's user. A run its caller handed a model key (model_key) runs on that key and never on the login
 *  (cli-run-spec.ts), so it is a process of its own like any other. */
export async function staysInRunner(deps: Pick<AdapterSpecDeps, "store" | "data" | "env" | "sealKey">, harness: string, launch: RunLaunch, runId: string, isolation: RunIsolation): Promise<boolean> {
  // A recipe's harness reads its install, its check's note and its owner's sign-in, each the server user's alone: never
  // opened to a slot's user (the sign-in least of all), so where each run is a user of its own it is refused here. And a
  // plan-billed one's run that no person started (a schedule's, a trigger's) never runs on its owner's sign-in: only on
  // keys saved for its harness.
  if (isolation.kind === "uid" && recipeHarness(deps.env ?? {}, harness)) throw new ClaimRefused(RECIPE_NEEDS_SERVER_USER);
  await refuseRecipeTriggerRun(deps, harness, launch);
  if (runsInRunner(harness, launch)) return true;
  if (launch.documents !== undefined) {
    const run = await deps.store.runs.get(runId);
    const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
    if (revision && isWorkflowRevision(revision)) return true;
  }
  if ((await loginForRun(deps.store.settings, deps.data, deps.env ?? {}, harness, launch.place)) === undefined) return false;
  if ((await openRunModelKey({ store: deps.store, sealKey: deps.sealKey }, runId)) !== undefined) return false;
  if (isolation.kind === "uid") throw new ClaimRefused(LOGIN_NEEDS_SERVER_USER);
  return true;
}

/** The runner's loop factory where each run is a process of its own: a ChildLoop per claim, but for a run that stays in
 *  the runner (staysInRunner). */
export function childLoops(options: ChildLoopsOptions): LoopFactory {
  // Each slot locked on the data directory too: another runner on it whose range overlaps this one's never runs a run
  // on a slot this one holds.
  const slots = options.isolation.kind === "uid" ? new Slots(options.isolation.first, options.isolation.slots, slotLocks(options.deps.data)) : undefined;
  const own: LoopFactory = (loopDeps) => childLoop(options, slots, loopDeps);
  const here = resolveRunnerLoop(options.deps);
  return createDispatchLoop({
    launchOf: (runId) => options.deps.store.runs.launch(runId),
    resolve: async (harness, launch, runId) => ((await staysInRunner(options.deps, harness, launch, runId, options.isolation)) ? here(harness, launch, runId) : own),
  });
}

registerRunErrors();

/** `claimed` with the saved gateway's key beside its own (the runner's reads of what the run must never keep, heldFor):
 *  a copy, every property as it is (its non-enumerable keys and the sign-in's reader too), the key non-enumerable. */
function withGatewayKey(claimed: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const out = Object.defineProperties({}, Object.getOwnPropertyDescriptors(claimed)) as NodeJS.ProcessEnv;
  Object.defineProperty(out, GATEWAY_KEY_ENV, { value: key, enumerable: false, writable: false, configurable: false });
  return out;
}

/** The environment a run's process starts with: the runner's run environment's plain values (runEnv: its secrets are
 *  not enumerable, so none is here), no key-shaped name, and where its keys come from. */
function childEnv(base: NodeJS.ProcessEnv, keys: Buffer, extra: Record<string, string>): NodeJS.ProcessEnv {
  const plain: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(base)) if (typeof base[name] === "string") plain[name] = base[name];
  const env = withoutSecrets(plain);
  for (const name of SECRET_NAMES) delete env[name];
  return { ...env, ...extra, [SECRETS_FD_ENV]: "3", [SECRETS_LEN_ENV]: String(keys.length) };
}

/** The runner's side of a run's channel over `socket`. Each call of the run's process runs inside the ledger of the tool
 *  call it was made in (paid-calls.ts). web_save's slots are `gate`, this runner's one (save-slots.ts); the channel's end
 *  (the run's end, or its process gone) gives back every slot the run held or waited for, and lets go of every pieced write
 *  of the run's `bigs` (big-writes.ts), held or waiting. `maxFrame`: the channel's (a test's), default MAX_FRAME. */
export function runChannel(socket: Duplex, onClose: (why: Error) => void, gate: SaveSlots = SERVER_SLOTS, more: { readonly bigs?: RunBigWrites; readonly maxFrame?: number } = {}): Channel {
  let saves: (() => void) | undefined;
  const channel = new Channel(socket, { onClose: (why) => { onClose(why); saves?.(); more.bigs?.close(); }, within: withinCarried, ...(more.maxFrame ? { maxFrame: more.maxFrame } : {}) });
  saves = exposeSaveSlots(channel, gate);
  return channel;
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
  /** This run's hold on its slot (uid isolation), bound at its spawn and settled before the slot goes back. */
  let hold: SlotHold | undefined;
  /** Kills the run's process and every process it started: its group (process isolation; a program that left the group
   *  with setsid escapes it, a local install's limit), or every process of its own slot's uid while it holds the slot
   *  (uid isolation: never a slot it gave back, which another run may hold). */
  const kill = async (): Promise<void> => {
    if (isolation.kind === "uid") return hold?.kill();
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  /** Ends the run's process: its channel closed (its loop ended), a grace to exit, then everything it left killed and, on
   *  a slot, the slot reaped. */
  const end = async (slot: number | undefined, tops: readonly string[]): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const gone = exited ? Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, EXIT_GRACE_MS)))]) : Promise.resolve();
    channel?.close();
    await gone;
    clearTimeout(timer);
    let reaped = true;
    if (isolation.kind === "uid" && slot !== undefined) reaped = await reapSlot(isolation, slot, tops, log);
    else await kill();
    await exited?.catch(() => undefined);
    return reaped;
  };
  /** Gives the slot back where its reap held, else retires it (Slots.retire), said on the log. */
  const letGo = async (slot: number | undefined, reaped: boolean, runId: string): Promise<void> => {
    if (slot === undefined || !slots) return;
    if (reaped) return slots.give(slot);
    slots.retire(slot);
    log(`run ${runId}: slot ${slot} is retired: its reap did not end every process of its user, so no run of this runner runs on it again until the runner restarts`);
  };
  return {
    start(claim) {
      return (started ??= (async (): Promise<LoopEnd> => {
        const runRow = await deps.store.runs.get(claim.runId);
        if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
        // The launch as this run runs it: on a named disk, with nothing learned on another disk (launchOnItsDisk).
        const read = readLaunchBody((await deps.store.runs.launch(claim.runId)).body);
        const launch = read && launchOnItsDisk(read);
        if (!launch) throw new Error(`run ${claim.runId}: its launch record could not be read as a launch`);
        const revisionRow = await deps.store.agents.revision(runRow.revisionId);
        if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
        const revision = { kind: revisionRow.kind, body: (revisionRow.body ?? {}) as Record<string, unknown> };
        // The model gateway saved in the console, read from the store now and laid over this claim's environment, as a run
        // in this process has it laid (harness-loops.ts): the run's process reads no store row of it and holds no seal key.
        const claimDeps = await withSavedGatewayDeps(deps);
        const claimEnv = claimDeps.env ?? {};
        // Refuse before taking a slot: even a slot's final reap normalizes modes in its run folders.
        if (launch.sourceProject && isolation.kind === "uid" && !await loadArchilSettings(deps.store, claimEnv)) {
          ready();
          throw new ClaimRefused("project_mode_fidelity: This runner rewrites local project file permissions for per-user isolation. A moved project needs a destination that preserves its original permissions.");
        }
        const savedGateway = savedGatewayIn(claimEnv);
        // The run's own keys: those its claim opens (claim-secrets.ts), the one list its loop in this process read. Its model
        // keys are its pinned model's (claimSecrets scopes them by the launch's model), the one its route sends: never the
        // host's default's now, where its revision names no model and a key saved since moved that default.
        const claimed = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: claimEnv, redact: loopDeps.redact }, revisionRow as never, launch, claim.runId);
        // A --faux start alone is pinned to the faux model (model.ts chooseModel), which stands in for its revision's and
        // sends no key: its process is handed its revision's model's key with them, as a run of that model is handed it.
        // Only on a runner in faux mode too: a faux launch claimed where FAUX_ENV is unset gets no second claim. A held run its
        // model kept from running at its create (hold.refused) is laid no model key here either: its model runs nowhere.
        const ofRevision: NodeJS.ProcessEnv = launch.model?.provider === FAUX_PROVIDER && claimEnv[FAUX_ENV] ? await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: claimEnv, redact: loopDeps.redact }, revisionRow as never, { ...(launch.plane ? { plane: launch.plane } : {}), ...(launch.hold ? { hold: launch.hold } : {}) }) : {};
        // A run that holds a model key of its own (model_key, its launch's) spends that key alone: its process is handed
        // none of the server's model keys, as its spec drops them from its tools' (claim-secrets.ts withoutModelKeys).
        // Copies: the runner's own reads (heldFor's `claimed`: what the run's learning must never keep) stay whole.
        const keyed = (await openRunModelKey({ store: deps.store, sealKey: deps.sealKey }, claim.runId)) !== undefined;
        const toProcess = keyed ? [withoutModelKeys({ ...claimed }), withoutModelKeys({ ...ofRevision })] : [claimed, ofRevision];
        // The saved gateway's key, kept off the claim's tool keys (claimSecrets), is handed for the run's model routes alone,
        // read as the server's model keys are (savedModelKeys, over the claim's environment the gateway was laid over), as a
        // run in this process reads it from its environment by name; none to a run that brings its own key, and none to a
        // held run its model kept from running, which routes no model.
        const gatewayKey = savedGateway && !launch.hold?.refused ? (keyed ? {} : await savedModelKeys({ store: deps.store, sealKey: deps.sealKey, env: claimEnv }))[GATEWAY_KEY_ENV] || undefined : undefined;
        const handed = (name: string): string | undefined => (name === GATEWAY_KEY_ENV && savedGateway ? gatewayKey : toProcess.map((from) => from[name]).find((value): value is string => typeof value === "string" && value !== ""));
        const keys = encode(SECRET_NAMES.flatMap((name) => {
          const value = handed(name);
          return value === undefined ? [] : [[name, value] as const];
        }));
        const slot = await slots?.take();
        if (slots && slot === undefined) {
          // Every free slot of this runner is held by another runner on the data directory (ranges that overlap): the run
          // is handed back unstarted, for a runner with a slot to claim.
          log(`run ${claim.runId}: handed back unstarted: every free slot of this runner is held by another runner on this data directory; give each runner on one data directory a range of its own (${RUN_SLOT_FIRST_ENV}, --loops)`);
          ready();
          return { state: "interrupted" };
        }
        // A slot is reaped before its first run here too: a runner that died (its locks ended with it) may have left a
        // process of the slot's uid alive, which must never share a user with this run. A reap that does not hold
        // retires the slot, and the run is handed back unstarted.
        if (isolation.kind === "uid" && slot !== undefined && !(await reapSlot(isolation, slot, [], log))) {
          await letGo(slot, false, claim.runId);
          ready();
          return { state: "interrupted" };
        }
        if (isolation.kind === "uid" && slot !== undefined) hold = new SlotHold(slot, isolation.helper, log);
        const tops = runTops(deps.data, runRow.agentId, claim.runId);
        // The run's pieced writes (big-writes.ts): let go when its channel ends, or at the claim's release.
        const bigs = runBigWrites();
        const heldSide = heldFor({ ...deps, env: claimEnv }, { claim, run: runRow, launch, revision, claimed: gatewayKey ? withGatewayKey(claimed, gatewayKey) : claimed, signal: loopDeps.signal, ...(loopDeps.incarnation ? { incarnation: loopDeps.incarnation } : {}) }, cut, log, bigs);
        try {
          let extra: Record<string, string> = {};
          let argv = [...(options.argv ?? childArgv())];
          // A claim that resumes a run whose last runner ended before giving its folders back finds them its last slot's,
          // perhaps shut (a run's own chmod 700): taken back first, so the inputs and folders below are laid as the
          // server's, then given to this slot.
          if (isolation.kind === "uid" && slot !== undefined) await takeBackRunFolders(isolation, tops);
          // The run's uploads and opening message, placed by the runner before its process starts (their hold is the
          // server's alone), then given to the slot with its folders.
          await heldSide.inputs();
          if (isolation.kind === "uid" && slot !== undefined) {
            await layRunFolders(isolation, deps.data, runRow.agentId, claim.runId, slot);
            const scratch = scratchFolder(deps.data, runRow.agentId, claim.runId);
            const tmp = join(scratch, "tmp");
            extra = { TMPDIR: tmp, HOME: scratch };
            argv = [isolation.helper, "run", String(slot), "--keep-fd", "3", "--keep-fd", "4", "--", ...argv];
          }
          // The saved gateway's address and models go as plain variables (childEnv), and its mark says they are the saved one.
          const env = childEnv(claimEnv, keys, savedGateway ? { ...extra, [SAVED_GATEWAY_ENV]: "1" } : extra);
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
          channel = runChannel(socket, (why) => void (broke ??= why), SERVER_SLOTS, { bigs });
          const bound: Bound = { claim, agentId: runRow.agentId, revisionId: runRow.revisionId };
          channel.expose("store", (method, args) => storeCall(deps.store, method, args, bound, log));
          channel.expose("journal", journalTarget(loopDeps.journal(claim), cut));
          channel.expose("held", (method, args) => {
            // Its own members alone: a name of Object's prototype (constructor, toString) is no call of Held.
            const fn = Object.hasOwn(heldSide.held, method) ? (heldSide.held as unknown as Record<string, (...a: unknown[]) => unknown>)[method] : undefined;
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
            ...(deps.composioMcpOrigin ? { composioMcpOrigin: deps.composioMcpOrigin } : {}),
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
          await heldSide.projectEnd?.();
          const reaped = await end(slot, tops).catch((error: unknown) => {
            log(`run ${claim.runId}: its process's end failed: ${(error as Error)?.message ?? error}`);
            return false;
          });
          await heldSide.release();
          // The run's scratch folder, which its process may not remove (the folder above it is the server's): swept here
          // once the reap made what is in it the server's, as a run in the runner's own process sweeps it.
          if (reaped && isolation.kind === "uid" && slot !== undefined) await sweepRunScratch(deps.data, runRow.agentId, claim, log);
          // No kill of this run reaps the slot once it is given back: those still reaping end first.
          await hold?.settle();
          await letGo(slot, reaped, claim.runId);
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
