// What a run's own process (run-child.ts) asks its runner for, in place of the seal key it never holds. The runner opens
// each for the one claim the process runs (run-child-host.ts heldFor), from its own reads of that claim's run, agent and
// revision: an argument from the run's process names nothing the runner then trusts (a run id, an agent, a path), and
// what comes back is the claim's own (its model's tier keys, its MCP tools, its GitHub token, its sign-in).
//
// It is set once per process, at the run's start, and read by the few functions that would open a sealed value: with no
// seal key (a run's process) they ask it; with one (a runner, a test's in-process runner) they never do.
import type { PlanReader } from "../chatgpt-plan.js";
import type { Tier } from "../model.js";
import type { RunSignIn } from "../sign-ins-store.js";
import type { LiveHandover } from "../browser-live.js";
import type { ApprovalPrice, ToolEffect } from "../tool-gate.js";
import type { OpenedAccount } from "../email/account.js";
import type { SavedCalendar } from "../calendar/address.js";
import type { Workspace } from "../workspace/workspace.js";
import type { GithubAppAccessAt } from "./github-app.js";
import type { HarnessInstallEntry, HarnessPins } from "../harness-install.js";
import type { AlsoRow } from "../store/store.js";
import type { RunModelKey } from "../store/seal.js";
import type { EndOfRunKept, EndOfRunTurn } from "./loop-contract.js";

/** One MCP tool of the claim, its call made by the runner (mcp-run.ts mcpForClaim), with what the gate reads of it. */
export interface HeldMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly catalog: string;
  readonly arguments?: readonly string[];
  readonly price?: ApprovalPrice;
  readonly effect?: ToolEffect;
  call(args: unknown, context: { readonly signal?: AbortSignal; readonly callId?: string }): Promise<{ text: string; isError?: true }>;
}

/** The claim's MCP as the runner holds it: its tools, and its credentials' refresh and release. */
export interface HeldMcp {
  readonly tools: readonly HeldMcpTool[];
  fresh(): Promise<void>;
  release(): Promise<void>;
}

/** What the run's process gives mcpForClaim on the runner: its grants and harness are its revision's, which the runner
 *  reads itself. */
export interface HeldMcpAsk {
  /** The run's journal commit, for a call's record on the run's root (mcp-gateway.ts commit): an entry appended. */
  readonly appendRoot: (entry: unknown) => Promise<void>;
}

/** What the run's process gives the runner's computerForClaim (workspace/computer-for-claim.ts): its callbacks only. The
 *  run, its epoch, its folder, its mode and its revision are the runner's own reads of the claim. */
export interface HeldComputerAsk {
  readonly hadComputer: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly say?: (words: string) => void;
  readonly onImageWait?: (making: boolean, image: string) => void;
  readonly onStarting?: (said: string) => void;
  readonly onConnected?: (said: string) => void;
  readonly onComputerNote?: (words: string) => void;
}

export interface Held {
  /** The ChatGPT sign-in's reader (chatgpt-plan.ts planReaderOf), for a run whose models reach the plan; else none. */
  plan(): Promise<PlanReader | undefined>;
  /** Whether a browser sign-in handed to the run reads back here (sign-ins-store.ts handedSignInReadsBack). */
  signInReadsBack(): Promise<boolean>;
  /** The run's browser sign-in for vendor `resolution` (sign-ins-store.ts runSignIn). */
  runSignIn(resolution: string): Promise<RunSignIn | undefined>;
  /** The run's kept sign-in marked verified at `at` (sign-ins-store.ts verifyRunSignIn). */
  verifySignIn(kept: RunSignIn, at: number): Promise<boolean>;
  /** The claim's MCP (mcp-run.ts mcpForClaim); none when its revision grants no MCP tool. */
  mcp(ask: HeldMcpAsk): Promise<HeldMcp | undefined>;
  /** The GitHub App's access for the run's launch (github-app.ts githubAppAccess). */
  githubAppAccess(): Promise<GithubAppAccessAt | undefined>;
  /** Every saved model key, for a run whose routes have no revision to scope them by (a subagent's tiers, a grade). */
  savedModelKeys(): Promise<Record<string, string>>;
  /** The model keys the host's models of `tiers` need (claim-secrets.ts tierModelKeys), the plan's reader with them. */
  tierModelKeys(tiers: readonly Tier[]): Promise<{ readonly keys: Record<string, string>; readonly plan?: PlanReader }>;
  /** The run's own model key, opened from the claim's run's launch (claim-secrets.ts claimModelKey): none where it holds
   *  none; throws, in words, where the launch does not open under the runner's seal key. Asked again for each message's
   *  key (ClaimModelKey.fresh). */
  runModelKey(): Promise<RunModelKey | undefined>;
  /** Whether the server has a gateway and holds no key for it (claim-secrets.ts serverKeyless): a boolean, never a key. */
  serverKeyless(): Promise<boolean>;
  /** The zone the claim's run's day is told in (environment.ts runZone): its trigger's, read by the runner from the
   *  claim's own launch, else the server's. A zone's name, never the trigger's row. */
  runZone(): Promise<string>;
  /** The host's keys of the decision providers `providers` (claim-secrets.ts hostDecisionKeys). */
  decisionKeys(providers: readonly string[]): Promise<Record<string, string>>;
  /** A browser session's viewer handed over, and taken back (browser-live.ts). */
  liveViewerPut(handover: LiveHandover): Promise<boolean>;
  liveViewerDrop(tag?: string): Promise<void>;
  /** The MCP credentials run `from` was handed, sealed again for run `id`, a run this one starts (promotion.ts,
   *  audit.ts): none unless `from` is the claim's own run. */
  handOn(from: string, id: string): Promise<Uint8Array | undefined>;
  /** The run's agent's live sign-in pointer for `resolution`, and its forgotten ones (sign-ins-store.ts signInReads): what
   *  its learning end holds to refuse a pointer in what the run learned. */
  signInPeek(resolution: string): Promise<unknown>;
  signInForgotten(resolution: string): Promise<unknown>;
  /** The server's email account, opened, for a run whose revision grants an email tool; else none. */
  emailAccount(): Promise<OpenedAccount | undefined>;
  /** The server's calendar, opened, for a run whose revision grants calendar_events; else none. */
  calendar(): Promise<SavedCalendar | undefined>;
  /** A call of the run's agent's learning folder (learn/folder.ts), the runner's own Workspace of it, held to what a
   *  run's learning does there (run-child-host.ts learningCall). */
  learning(method: string, args: readonly unknown[]): Promise<unknown>;
  /** The harness `name`'s install for the claim (harness-install.ts installForClaim), run by the runner. */
  install(name: string, signal?: AbortSignal): Promise<void>;
  /** The claim's computer (workspace/computer-for-claim.ts), made and held by the runner. */
  computer(ask: HeldComputerAsk): Promise<unknown>;
  /** A Mode 2 claim: the run's folder on its Archil disk, as the runner opens it; its mount credential's revoke. */
  archil(): Promise<{ readonly workspace: Workspace; revoke(): Promise<void>; inherit(): Promise<void>; release(): Promise<void> } | undefined>;
  /** The claim's end-of-run step (learning-end.ts learningEndOfRun), run by the runner over its own reads of the claim:
   *  what the run's learning must never keep is every secret the runner holds, which no run's process is given. Its
   *  turns are asked through `input.ask`, the run's own session; `input.keptOf` is read once, for the round the runner
   *  reads. */
  endOfRun(input: HeldEndOfRunInput): Promise<{ readonly also: readonly AlsoRow[] } | undefined>;
}

/** What a run's process hands its runner for the end-of-run step: EndOfRunTurn's input, its keptOf asked over the
 *  channel (so answered later). */
export type HeldEndOfRunInput = Omit<Parameters<EndOfRunTurn>[0], "keptOf"> & { readonly keptOf?: (round: number) => Promise<EndOfRunKept | undefined> };

let current: Held | undefined;

/** Sets this process's runner seam: run-child.ts, once, before the run's loop starts. */
export function setHeld(held: Held): void {
  current = held;
}

/** This process's runner seam: set in a run's own process, never in a runner or a server. */
export function held(): Held | undefined {
  return current;
}

/** This process's runner seam, where a caller with no seal key needs one: a runner or a server that reaches here with
 *  no key is a bug, said in words, never a quiet answer of nothing. */
export function heldOrThrow(what: string): Held {
  if (!current) throw new Error(`${what} needs the server's seal key, and this process has neither it nor a runner to ask`);
  return current;
}

/** signInReads (sign-ins-store.ts) in a run's own process: the claim's agent's, read by its runner. */
export function heldSignInReads(): { peek(agentId: string, resolution: string): Promise<never>; forgotten(agentId: string, resolution: string): Promise<never> } {
  const at = heldOrThrow("a run's sign-in reads");
  return {
    peek: (_agentId, resolution) => at.signInPeek(resolution) as Promise<never>,
    forgotten: (_agentId, resolution) => at.signInForgotten(resolution) as Promise<never>,
  };
}

/** The agent's learning folder in a run's own process (learn/folder.ts learningWorkspace): each call made by its runner on
 *  the folder of the claim's agent (Held.learning), whatever place this process names. No background program, mount or
 *  attach: a learning folder has none. */
export function heldLearningFolder(): { readonly workspace: Workspace; end(): Promise<void> } {
  const at = heldOrThrow("a run's learning folder");
  const call = (method: string) => (...args: unknown[]) => at.learning(method, args) as Promise<never>;
  const none = (what: string) => async (): Promise<never> => {
    throw new Error(`a learning folder has no ${what} in a run's own process`);
  };
  const workspace = {
    read: call("read"),
    write: call("write"),
    append: call("append"),
    stat: call("stat"),
    list: call("list"),
    mkdir: call("mkdir"),
    grep: call("grep"),
    remove: call("remove"),
    exec: call("exec"),
    process: { start: none("background program"), list: none("background program"), output: none("background program"), signal: none("background program"), wait: none("background program") },
    mountSpec: none("mount"),
    attach: none("attach"),
  } as unknown as Workspace;
  return { workspace, end: async () => {} };
}

/** A learning run's end-of-run step in a run's own process (learning-end.ts learningEndOfRun): its runner's
 *  (Held.endOfRun), whatever deps the process would have built it with. */
export function heldEndOfRun(): EndOfRunTurn {
  return async ({ keptOf, ...input }) => heldOrThrow("a run's end-of-run step").endOfRun({ ...input, ...(keptOf ? { keptOf: async (round: number) => keptOf(round) } : {}) });
}

/** A runner's install of a harness, as a run's process asks it (AdapterSpecDeps.installForClaim): the harness's name
 *  alone crosses; the runner reads its entry, folder and pins itself. */
export const heldInstall = async (entry: HarnessInstallEntry, _dir: string, _pins: () => Promise<HarnessPins>, given: { signal?: AbortSignal } = {}): Promise<void> =>
  heldOrThrow("a harness's install").install(entry.id, given.signal);
