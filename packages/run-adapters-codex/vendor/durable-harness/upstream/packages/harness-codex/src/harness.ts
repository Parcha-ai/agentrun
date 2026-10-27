import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { type DriveContext, type EffectRecord, type Harness, type HostTool, type ReplayPolicy, type SessionState, type Submission, Unavailable, UNAVAILABLE_STEP } from 'harness-world';
import {
  type AcquireMachine,
  BuiltinCalls,
  type BuiltinStart,
  CODEX_ROUTES,
  failureText,
  type GatewayLedger,
  gatewayCredential,
  gatewayHandler,
  gatewayUrl,
  isBrandedMachine,
  type MachineTail,
  ModelSteps,
  Mutex,
  NativeJournal,
  placeSubmissions,
  recoveryNote,
  restartEvent,
  type SessionMachine,
  type SessionProcess,
  settleAbandonedModelSteps,
  type ToolResult,
  toolBridge,
  toolKey,
  transcriptOf,
  type TranscriptEntry,
} from 'harness-world-process';
import { acknowledgeInDrive, attachInDrive, cliPath, CODEX_CLI, DriveFiles, SANDBOX_DOC } from 'harness-world-sandbox/cli';
import { AppServer, type RpcNotification, type RpcServerRequest } from './app-server.ts';
import { BUILTINS_ON, checkConfig, codexConfig, type TomlValue, toToml } from './config.ts';
import {
  callIdOf,
  endsTurn,
  isRolloutPath,
  isSessionMeta,
  type RolloutCall,
  rolloutPathIn,
  rolloutStream,
  rolloutText,
  summarizeRollout,
  THREAD_STREAM,
  type ThreadRecord,
} from './rollout.ts';

/**
 * Codex on harness-world: a kernel `Harness` that drives `codex app-server
 * --stdio` (Codex's JSON-RPC protocol for IDEs) **in the session's Vercel
 * Sandbox VM**, never on the machine that drives the session
 * (docs/workspaces.md §1 decision 2, §5.6). Every drive acquires the
 * session's VM through the sandbox tier (`attachInDrive` with the session
 * factory's acquire, `machine.acquire`), and refuses a machine the factory
 * didn't brand: `Unavailable('sandbox_required')`.
 *
 * - **Where it runs.** app-server runs as the VM's unprivileged user, its
 *   stdio over the relay (`RemoteProcess`, a `LineChannel`), its working
 *   directory `/workspace` (the session's Drive, the same on every VM), its
 *   `HOME` and `CODEX_HOME` under `/var/lib/dh/s`, wiped before every spawn.
 *   `CODEX_HOME` is outside every writable root of Codex's own sandbox, so a
 *   command can't rewrite the rollout or `config.toml`.
 * - **Tools.** Tool-less by default: the app's `HostTool`s (`tools`) are
 *   app-server dynamic tools, run in the Function, each call the kernel's
 *   effect sandwich keyed by Codex's own `call_id` (`tool:<call_id>`), and
 *   they are its only tools (shell, `apply_patch` and images off, a
 *   `read-only` sandbox). With `builtins: true`, Codex's own shell and
 *   `apply_patch` are on, on `/workspace`, under Codex's own sandbox
 *   (`sandboxMode`: by default `workspace-write` when bubblewrap's self-test
 *   passes in the VM, else `danger-full-access`, the VM being the boundary;
 *   the first verdict is recorded in the log, `codex.sandbox`, and every
 *   later drive keeps it).
 *   Every command and patch asks the drive first (`approvalPolicy:
 *   'untrusted'`): its intent is committed once the rollout line that made
 *   the call is in the log, and only then approved, once. Anything else is
 *   declined: a second approval for the same call (Codex's "retry without
 *   sandbox?"), input to a running command, a sub-command, more
 *   permissions, network access. Its outcome is committed when Codex
 *   reports the item completed, after the Drive is flushed. Nothing reruns
 *   one after a crash: the Drive is durable, not transactional.
 * - **The rollout is mirrored into the log.** Codex keeps its thread as an
 *   append-only JSONL file; the relay tails it (`TAIL`, inode and size
 *   checked: a replaced or shrunk file stops the drive, and the third time
 *   in a turn ends the turn) and every line
 *   becomes a record of the session's native journal (`rollout:<threadId>`).
 *   Before every `replay: 'never'` call the drive drains the tail (`SYNC`)
 *   and checks the call's own line is there (a bounded number of times):
 *   without it, the call is declined, never run, and the model is told to
 *   try again.
 * - **Every drive restores from the log.** `CODEX_HOME` is wiped and gets a
 *   fresh `config.toml` and the mirrored rollout, byte for byte (`FILES`);
 *   app-server resumes the thread by id.
 * - **Recovery.** A turn a crash cut off is resumed natively: calls the
 *   rollout left without an output get one injected from the log
 *   (`thread/inject_items`), then a recovery note built from the log starts
 *   a turn. A link to the VM lost mid-drive is re-attached in the same
 *   invocation (a bounded number of times, and only while there is work
 *   left), once the app's tools still running have settled, and the drive
 *   resumes from the log.
 * - **The inbox.** Each submission is placed, then sent with its id as
 *   Codex's `clientUserMessageId`: `turn/start`, or `turn/steer` for a
 *   steer that arrives while a turn runs.
 *
 * Model traffic goes from the VM's loopback model port through the relay to
 * this drive's `gatewayHandler` (`CODEX_ROUTES`: the fixed path table, the
 * body policy, the model, the budget), which adds the credential: the VM
 * never holds it. Codex's provider key is the attach's model key
 * (`SessionMachine.modelKey`, which the relay checks with the caller's pid),
 * hidden from the model's commands
 * (`shell_environment_policy`). Each response's cost is a record in the log
 * (`codex.spend`), so the dollar caps hold over the turn and the session,
 * across invocations. app-server runs no git of the Drive's: `GIT_DIR`
 * points nowhere and no git config is read.
 */

export interface CodexHarnessOptions {
  /**
   * The app's tools, as app-server dynamic tools: each call a kernel effect
   * keyed by Codex's `call_id`, with the tool's replay policy, run where the
   * drive runs (the Function). Its only tools, or (with `builtins: true`)
   * next to the built-ins. Default none.
   */
  tools?: HostTool[];
  /**
   * Codex's own shell and `apply_patch` (and `view_image`), on `/workspace`
   * in the session's VM. Default false (tool-less: `tools` are its only
   * tools). Image generation, web search, sub-agents and plugins stay off
   * either way.
   */
  builtins?: boolean;
  /**
   * Codex's sandbox for its commands, in the VM (the Codex SDK's word; this
   * option was `sandbox`). Needs `builtins: true`. Default: `workspace-write`
   * (writes to `/workspace` and its home, network on) when bubblewrap's
   * self-test passes in the VM at attach, else `danger-full-access` (the VM
   * is the boundary, and holds no credential; the provider key's
   * placeholder is then readable by the model's commands, docs/workspaces.md
   * §5.5).
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** An AI Gateway model id. Default `openai/gpt-5.4-mini`. */
  model?: string;
  /** Developer instructions for the thread (`developerInstructions`). */
  instructions?: string;
  /** Replace Codex's own base instructions (they describe its built-in tools). */
  baseInstructions?: string;
  /** Reasoning effort per turn. Default Codex's. */
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** The Gateway credential, read per request in the Function. Default `gatewayCredential` (AI_GATEWAY_API_KEY, else the Vercel OIDC token). */
  credential?: () => Promise<string>;
  /** The Gateway's base URL. Default `gatewayUrl()`. */
  gatewayUrl?: string;
  /** The kernel name (its sessions' runs are `workflow//durable-harness@<version>//<name>`). Default `codex`. */
  name?: string;
  /** The model's context window (Gateway ids are unknown to Codex). Default 272,000. */
  contextWindow?: number;
  /** Extra `config.toml` settings, merged over the generated ones. The keys the harness sets itself (`RESERVED_CONFIG_KEYS`) throw. */
  config?: Record<string, TomlValue>;
  /** How often to read the inbox for steers while a turn runs, without hints. Default 500 ms (5 s with hints). */
  inboxPollMs?: number;
  /** Diagnostics (stderr noise, declined approvals, the sandbox's lifecycle). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * The session's VM (internal: durable-harness's `codex()` resolves
   * `workspace: sandbox()` into it). Without it, or with an acquire that
   * gives a machine the sandbox tier's session factory didn't brand, a
   * drive fails its turn with `Unavailable('sandbox_required')`.
   */
  machine?: CodexMachine;
  /**
   * The stand-in's seam (docs/workspaces.md §5.8): the command that speaks
   * app-server's protocol instead of the image's `codex`. Refused outside a
   * test run (`DH_TEST_LOCAL_SANDBOX=1` under a test runner, not on Vercel,
   * not in production).
   */
  test?: { command: string; args?: string[] };
}

/** The session's VM, as a `sandbox()` descriptor resolves it (durable-harness's `codex()` builds it). */
export interface CodexMachine {
  /** The sandbox tier's acquire: its session factory (`sandboxSession`), which brands the machines it gives. */
  acquire: AcquireMachine;
  /** `sandbox({ env })`: non-secret variables for app-server and for the model's commands (`shell_environment_policy.set`). */
  env?: Readonly<Record<string, string>>;
  /** `sandbox({ network })`: the gateway handler refuses what would reach past it through the provider. Default `allow-all`. */
  network?: 'allow-all' | 'deny-all' | { readonly allow: readonly string[] };
  /** `sandbox({ budget })`'s dollar caps, over the turn and the session (each response's cost is in the log). Default none (`Infinity`). */
  budget?: { readonly turnUsd?: number; readonly sessionUsd?: number };
  /** `sandbox({ commandTimeoutMs })`: a built-in command's longest run, within the time left in the invocation. */
  commandTimeoutMs?: number;
}

export const DEFAULT_MODEL = 'openai/gpt-5.4-mini';

/** Options this harness no longer takes, with what replaced them (docs/workspaces.md §3.4). */
const REMOVED: Readonly<Record<string, string>> = {
  sandbox: "`sandbox` is now `sandboxMode` (Codex's own sandbox for its commands; `sandbox()` is the session's environment, `workspace: sandbox()`)",
  host: "Codex runs only in the session's Vercel Sandbox VM: pass `workspace: sandbox()` (durable-harness/codex), not a host",
  cwd: "the working directory is always /workspace, the session's Drive",
  bin: 'the codex binary is the one the sandbox image pins',
  env: 'pass non-secret variables with sandbox({ env })',
  keepSessionDir: "CODEX_HOME is in the session's VM and is rebuilt from the log every drive",
  workspaceNote: "/workspace is the session's Drive, the same on every VM",
};

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/** Codex's command actions that only read: a command made of these alone is `safe` (the note says "safe to repeat"). */
const READ_ACTIONS = new Set(['read', 'listFiles', 'search']);

/** A Codex item's replay policy: a command whose every action reads is `safe`; any other command, and every patch, `never`. */
export function codexItemReplay(item: { type?: string; commandActions?: { type?: string }[] }): ReplayPolicy {
  if (item.type !== 'commandExecution') return 'never';
  const actions = item.commandActions ?? [];
  return actions.length > 0 && actions.every((a) => READ_ACTIONS.has(String(a.type))) ? 'safe' : 'never';
}

/**
 * The env var Codex reads its provider key from (`env_key`; it sends it as
 * `authorization: Bearer`). It holds the attach's model key
 * (`SessionMachine.modelKey`), never a credential: the gateway handler adds
 * that in the Function. Hidden from the
 * model's commands by `shell_environment_policy` (`HARNESS_*`), and exempt
 * from the spawn check's credential-name rule (harness-world-sandbox's
 * `PLACEHOLDER_NAMES`), never from its value rules.
 */
export const KEY_ENV = 'HARNESS_CODEX_GATEWAY_KEY';

/** How long the drive waits for a call's `function_call` line before it declines the call: `SYNC` and look again, this many times, with a growing pause. */
const BARRIER_TRIES = 5;
/** What the model is told when a call was declined because its line wasn't in the log yet. */
export const LAGGING_NOTE = "[harness] The previous tool call was not run: the session's log had not caught up with it yet. Nothing happened; make the same call again.";
/** A dynamic tool's result when its call was declined for the same reason. */
export const LAGGING_RESULT = "Not run: the session's log had not caught up with this call yet. Nothing happened; make the same call again.";
/** A command still running this close to the invocation's end is stopped, with a definite outcome (the kernel's 15 s margin, and time to record it). */
const COMMAND_MARGIN_MS = 25_000;
/** The kernel's own bound on an invocation when the World reports no deadline (`DriverOptions.maxInvocationMs`'s default). */
const DEFAULT_INVOCATION_MS = 10 * 60_000;
/** Re-attaches after a lost link within one invocation (the session factory has its own bound too). */
const MAX_RELINKS = 3;
/** The outcome of a command the invocation's deadline stopped. */
export const TIMEOUT_TEXT = 'The command ran out of time in this invocation and was stopped: it may have partly taken effect. Check the state it left before running it again.';
/** The outcome of a command approved too close to the invocation's end: declined, never run. */
export const NO_TIME_TEXT = 'Not run: too little time was left in this invocation to run it and record its outcome. Nothing happened; make the same call again.';
/** Rollout tail failures in one turn before the turn ends with an `Unavailable` instead of another redelivery. */
const MAX_TAIL_FAILURES = 3;
/** The journal stream of response costs: `{ usd, turn, estimated? }` (`turn`: the session turn it was spent in). */
export const SPEND_STREAM = 'codex.spend';
/** The journal stream of the bubblewrap self-test's verdict: `{ sandboxMode, reason? }`, the first one kept. */
export const SANDBOX_STREAM = 'codex.sandbox';
/** The journal stream of rollout tail failures: `{ turn, error }`. */
export const TAIL_STREAM = 'codex.tail';
/** Where app-server's git looks for a repository: nowhere (it would otherwise read `/workspace/.git`'s config, which the model writes, outside bwrap). */
const NO_GIT_DIR = '/nonexistent/dh-no-git';

/** How a Codex turn ended, as the transcript's `turn` entry says it. */
interface TurnOutcome {
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
}

interface ActiveTurn {
  id?: string;
  /** Completed agent messages since the last transcript entry. */
  said: string[];
  /** Agent messages still streaming (item id to text so far). */
  partial: Map<string, string>;
  error?: string;
  done: (turn: { status?: string; error?: { message?: string } | null }) => void;
  completed: Promise<{ status?: string; error?: { message?: string } | null }>;
}

/** A built-in call whose `function_call` line never reached the log: declined, never run. */
const LAGGING = Object.freeze({ run: false, lagging: true } as const);
type Begun = BuiltinStart | typeof LAGGING;

/** The rollout tail failed (the file shrank, was replaced, or is not the session user's): what the drive halts with. */
export class RolloutTailError extends Error {
  constructor(cause: unknown) {
    super(`harness-world-codex: the rollout can no longer be mirrored (${String((cause as Error)?.message ?? cause).slice(0, 200)}): the drive stops, and the next one rebuilds CODEX_HOME from the log`, { cause });
    this.name = 'RolloutTailError';
  }
}

/** The stand-in's guard (`test`), the same as harness-world-sandbox's. */
function testGuard(): void {
  if (process.env.DH_TEST_LOCAL_SANDBOX !== '1') throw new TypeError('harness-world-codex: codexHarness({ test }) needs DH_TEST_LOCAL_SANDBOX=1 (the stand-in, docs/workspaces.md §5.8)');
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') throw new TypeError('harness-world-codex: codexHarness({ test }) runs only under a test runner');
  if (process.env.VERCEL) throw new TypeError('harness-world-codex: codexHarness({ test }) refuses to run with VERCEL set');
  if (process.env.NODE_ENV === 'production') throw new TypeError('harness-world-codex: codexHarness({ test }) refuses to run in production');
}

/** When this invocation ends: the World's runtime deadline if it reports one, at most the kernel's default bound away. */
async function invocationDeadline(ctx: DriveContext): Promise<number> {
  const reported = await (ctx.world as { getRuntimeDeadline?: () => Promise<Date | undefined> }).getRuntimeDeadline?.().catch(() => undefined);
  const cap = Date.now() + DEFAULT_INVOCATION_MS;
  const at = reported instanceof Date ? reported.getTime() : NaN;
  return Number.isFinite(at) ? Math.min(at, cap) : cap;
}

function sandboxRequired(why: string): Unavailable {
  return new Unavailable(`Codex runs only in a Vercel Sandbox: ${why}`, {
    code: 'sandbox_required',
    hint: "Use durable-harness/codex's codex() or codexHarness() with workspace: sandbox() (the default).",
  });
}

/** The session turn the log is in: turns ended (a `turn` entry, or an `unavailable` fact), so the open turn's index. */
function turnIndex(state: SessionState): number {
  return transcriptOf(state).filter((r) => r.data?.type === 'turn').length + state.effectOrder.filter((e) => e.name === UNAVAILABLE_STEP).length;
}

/** A `codex.spend` record. */
interface SpendRecord {
  usd: number;
  turn: number;
  estimated?: true;
}

/**
 * The dollar ledger, from the log: every response's cost is a `codex.spend`
 * record tagged with its session turn, so the session's total and the open
 * turn's hold across invocations and redeliveries (docs/workspaces.md §5.5).
 * A crash can lose the costs of the last group commit's responses (a
 * couple of seconds), never more.
 */
function logLedger(journal: NativeJournal, turn: number): GatewayLedger & { turnEnded(): void; close(): void } {
  let session = 0;
  let thisTurn = 0;
  let open = true;
  for (const r of journal.records<SpendRecord>(SPEND_STREAM)) {
    const usd = Number(r.data?.usd);
    if (!Number.isFinite(usd) || usd < 0) continue;
    session += usd;
    if (r.data?.turn === turn) thisTurn += usd;
  }
  return {
    spent: () => ({ turnUsd: thisTurn, sessionUsd: session }),
    add: (usd, info) => {
      thisTurn += usd;
      session += usd;
      // A late response after the drive let go of the log: counted in memory only.
      if (open) journal.append(SPEND_STREAM, { usd, turn, ...(info.estimated ? { estimated: true } : {}) } satisfies SpendRecord);
    },
    turnEnded: () => {
      turn++;
      thisTurn = 0;
    },
    close: () => void (open = false),
  };
}

/** What the drives of one invocation share across a re-attach. */
interface Invocation {
  /** One app tool at a time, across re-attaches too. */
  fg: Mutex;
  /** The app's tool calls still running (in the Function): a re-attach waits for them. */
  inflight: Set<Promise<unknown>>;
  /** The sandbox's notes went to the model in a turn of this invocation (they are not sent again). */
  notesShown: boolean;
  /** What the notes the model saw described (`SessionMachine.notesKey` of the attach that carried them): only that loss is acknowledged. */
  notesKey?: string;
  /** And the record was told. */
  notesAcknowledged: boolean;
}

export function codexHarness(options: CodexHarnessOptions = {}): Harness {
  for (const [key, why] of Object.entries(REMOVED)) {
    if ((options as Record<string, unknown>)[key] !== undefined) throw new TypeError(`harness-world-codex: the ${key} option is gone: ${why}`);
  }
  const builtinsOn = options.builtins ?? false;
  if (options.sandboxMode !== undefined) {
    if (!SANDBOX_MODES.has(options.sandboxMode)) throw new TypeError(`harness-world-codex: sandboxMode must be 'read-only', 'workspace-write' or 'danger-full-access'`);
    if (!builtinsOn) throw new TypeError('harness-world-codex: sandboxMode needs builtins: true (with the built-ins off, Codex runs no command)');
  }
  checkConfig(options.config);
  if (options.test) testGuard();
  const model = options.model ?? DEFAULT_MODEL;
  const log = options.log ?? (() => {});
  const tools = options.tools ?? [];
  const spec = options.machine;
  const codex = options.test ? { command: options.test.command, args: options.test.args ?? [] } : { command: cliPath(CODEX_CLI), args: [] as string[] };
  const network = spec?.network === undefined || spec.network === 'allow-all' ? 'allow-all' : spec.network === 'deny-all' ? 'deny-all' : 'custom';
  const budget = { turnUsd: spec?.budget?.turnUsd ?? Infinity, sessionUsd: spec?.budget?.sessionUsd ?? Infinity };
  /** Nothing left to do: no turn a crash cut off, nothing in the inbox. */
  const idle = (ctx: DriveContext) => !recoveryNote(ctx.state()) && ctx.pending().length === 0;

  return {
    name: options.name ?? 'codex',
    // Each model request reaches Agent Runs from the Gateway proxy (`ModelSteps.request`).
    modelCalls: 'self',
    async drive(ctx: DriveContext) {
      // Nothing to do (an idle wake, a chaos arming): no VM. A model step a
      // crash left open after its turn ended is closed (no request will retry it).
      if (idle(ctx)) {
        await settleAbandonedModelSteps(ctx);
        return;
      }
      if (!spec) throw sandboxRequired('this harness was given no sandbox machine.');
      const deadline = await invocationDeadline(ctx);
      const invocation: Invocation = { fg: new Mutex(), inflight: new Set(), notesShown: false, notesAcknowledged: false };
      // A link to the VM lost mid-drive: the drive is rebuilt from the log on a re-attached machine, in this invocation.
      for (let relinks = 0; ; relinks++) {
        const held: { lost?: boolean } = {};
        try {
          return await driveOn(ctx, spec, deadline, invocation, held);
        } catch (err) {
          const lost = held.lost === true && !ctx.signal.aborted;
          if (!lost || relinks >= MAX_RELINKS) throw err;
          // The link dropped after the work was done (the last turn's end is in the log): nothing to re-attach for.
          await ctx.refresh();
          if (idle(ctx)) return;
          log('codex: the link to the sandbox was lost; re-attaching', { relinks: relinks + 1, error: String((err as Error)?.message ?? err).slice(0, 200) });
          // Notes shown in a turn that never committed may not be in the rollout the thread resumes from: shown again, until a turn that carried them is in the log.
          if (!invocation.notesAcknowledged) invocation.notesShown = false;
        }
      }
    },
  };

  /** One drive on one attach of the session's VM. */
  async function driveOn(ctx: DriveContext, spec: CodexMachine, deadline: number, invocation: Invocation, held: { lost?: boolean }): Promise<void> {
    const journal = new NativeJournal(ctx);
    // A rollout that keeps being tampered with (only possible under
    // danger-full-access): the turn ends, instead of a redelivery that boots
    // the VM and spends model calls again.
    const turnAt = turnIndex(ctx.state());
    const tailFailures = journal.records<{ turn?: number }>(TAIL_STREAM).filter((r) => r.data?.turn === turnAt).length;
    if (tailFailures >= MAX_TAIL_FAILURES) {
      throw new Unavailable(`The turn stopped: Codex's rollout in the session's sandbox was replaced or shrunk ${tailFailures} times, so the log can no longer mirror it.`, {
        code: 'unavailable',
        hint: 'Something in the VM rewrites $CODEX_HOME (possible only with sandboxMode danger-full-access): run the session with workspace-write.',
      });
    }
    // The handler asks for the credential per request, in this drive's async
    // context: on Vercel the OIDC token is read from the invocation's.
    const credential = options.credential ?? gatewayCredential;
    const inDrive = AsyncLocalStorage.snapshot();
    // Every model request, through the handler: the drive's model steps, written around a "Crash during: model" drill.
    const steps = new ModelSteps(ctx, { log });
    /** The spend cap a model call of this drive was refused for, if one was. */
    let capped: 'turnUsd' | 'sessionUsd' | undefined;
    const ledger = logLedger(journal, turnAt);
    const handler = gatewayHandler({
      routes: CODEX_ROUTES,
      models: { model },
      budget,
      ledger,
      network,
      credential: () => inDrive(credential),
      target: options.gatewayUrl ?? gatewayUrl(),
      track: steps.request,
      onCap: (cap) => {
        if (cap !== 'concurrency') capped = cap;
      },
      // Without the app's own log, the handler's default: a refused model call is a warning in the Function's logs, not silence.
      ...(options.log ? { log: (message: string, fields?: Record<string, unknown>) => log(`codex gateway: ${message}`, fields) } : {}),
    });
    let machine: SessionMachine;
    try {
      machine = await attachInDrive(ctx, spec.acquire, { model: handler, deadline });
    } catch (err) {
      ledger.close();
      await steps.close();
      throw err;
    }
    if (!isBrandedMachine(machine)) {
      ledger.close();
      await Promise.resolve((machine as { close?: () => Promise<void> } | undefined)?.close?.()).catch(() => {});
      await steps.close();
      throw sandboxRequired("the machine it was given is not one the sandbox tier's session factory made.");
    }
    const { dirs, root: cwd } = machine;
    const home = dirs.home;
    const codexHome = dirs['codex-home'];
    // The Drive's manifest (`hw.sandbox-files`): what the Files panel shows, kept in the log so it reads with no VM.
    const driveId = ctx.docs?.read(SANDBOX_DOC).value.driveId;
    const driveFiles = new DriveFiles(ctx, machine, { ...(typeof driveId === 'string' ? { driveId } : {}), log });

    // The session's thread and its rollout, as the log has them. A thread
    // whose first line (session_meta) never reached the log cannot be
    // resumed: the drive starts a new one. A path the log holds is checked
    // again: only a canonical one is ever uploaded or tailed.
    const thread = journal.records<ThreadRecord>(THREAD_STREAM).at(-1)?.data;
    const restored = thread ? (await journal.read<string>(rolloutStream(thread.threadId))).map((r) => r.data) : [];
    const resume = thread && isSessionMeta(restored[0]) && isRolloutPath(thread.path, thread.threadId) ? thread : undefined;
    const lines = resume ? restored : [];
    const rolloutBytes = new TextEncoder().encode(rolloutText(lines));

    // Codex's key: the attach's model key, which the relay checks (its hash armed the relay; only the attach's processes may use it). Never a credential: the handler adds that.
    const key = machine.modelKey;
    // A `never` tool waits for the journal: its call is in the log before its intent (the barrier ran first, below).
    const bridge = toolBridge(ctx, tools, { beforeNever: () => journal.flush() });
    /** What the model must hear about this attach (a lost Drive), once per invocation, with its first message; acknowledged after that turn. */
    let notes = machine.notes.length && !invocation.notesShown ? machine.notes.map((n) => `[Sandbox] ${n}`).join('\n') : undefined;
    let proc: SessionProcess | undefined;
    let tail: MachineTail | undefined;
    let tailBroken = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let builtins: BuiltinCalls | undefined;
    const clamps = new Map<string, ReturnType<typeof setTimeout>>();
    try {
      // The log wins: the VM's cache dirs are wiped, and CODEX_HOME rebuilt from the log.
      await machine.files.wipe();
      let sandboxMode: NonNullable<CodexHarnessOptions['sandboxMode']> = 'read-only';
      if (builtinsOn) sandboxMode = options.sandboxMode ?? (await sandboxVerdict(ctx, spec, machine, journal));
      const config = codexConfig({
        model,
        baseUrl: `${machine.modelUrl}/v1`,
        envKey: KEY_ENV,
        contextWindow: options.contextWindow ?? 272_000,
        cwd,
        ...(spec.env ? { commandEnv: spec.env } : {}),
        extra: {
          sandbox_mode: sandboxMode,
          ...(sandboxMode === 'workspace-write' ? { sandbox_workspace_write: { network_access: true, writable_roots: [cwd, home] } } : {}),
          ...(builtinsOn ? { features: { ...BUILTINS_ON } } : {}),
          ...(options.config ?? {}),
        },
      });
      await machine.files.upload('codex-home', [
        { path: 'config.toml', bytes: new TextEncoder().encode(toToml(config)) },
        ...(resume ? [{ path: resume.path, bytes: rolloutBytes }] : []),
      ]);
      proc = await machine.spawn({
        command: codex.command,
        args: [...codex.args, 'app-server', '--stdio'],
        cwd,
        signal: ctx.signal,
        env: {
          ...(spec.env ?? {}),
          HOME: home,
          CODEX_HOME: codexHome,
          TMPDIR: dirs.tmp,
          XDG_CONFIG_HOME: `${home}/.config`,
          XDG_DATA_HOME: `${home}/.local/share`,
          XDG_STATE_HOME: `${home}/.local/state`,
          XDG_CACHE_HOME: dirs.cache,
          NO_COLOR: '1',
          // app-server runs git itself, outside bwrap, with the key in its env:
          // no repository (the Drive's `.git/config` is the model's to write,
          // `core.fsmonitor` among it) and no global or system config (the
          // global one is under HOME, a writable root of the model's commands).
          // The commands' own env is the policy's, without these.
          GIT_DIR: NO_GIT_DIR,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          // Last: the provider key.
          [KEY_ENV]: key,
        },
        // With the built-ins off it runs no command. With them on, the model port's peer check rests on app-server not being
        // dumpable (its binary is execute-only in the base), never on a claim.
        ...(builtinsOn ? {} : { isolatedCommands: true }),
      });
      const child = proc;

      // Everything the drive waits on also ends when the child dies, the link is lost or the drive stops.
      const stopped = new Promise<never>((_, reject) => {
        const fail = () => reject(ctx.signal.reason ?? new Error('harness-world-codex: the drive stopped'));
        if (ctx.signal.aborted) fail();
        else ctx.signal.addEventListener('abort', fail, { once: true });
      });
      const lost = new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("harness-world-codex: the link to the session's sandbox was lost"));
        if (machine.signal.aborted) fail();
        else machine.signal.addEventListener('abort', fail, { once: true });
      });
      let rpc!: AppServer;
      let active: ActiveTurn | undefined;
      let turnEnds = 0;
      let stream = '';
      let threadId = '';
      /** The calls whose `function_call` (or `custom_tool_call`) line is in the log: what the barrier looks for. */
      const logged = new Set<string>();
      for (const line of lines) {
        const id = callIdOf(line);
        if (id) logged.add(id);
      }

      /**
       * The tail failed: the file was replaced or shrank (tampered with), or
       * is not the agent's. Nothing more is mirrored; the failure is in the
       * log (a turn ends after `MAX_TAIL_FAILURES`), then the drive stops.
       */
      const broken = (err: unknown) => {
        if (tailBroken) return;
        tailBroken = true;
        const error = String((err as Error)?.message ?? err).slice(0, 200);
        log('codex: the rollout tail failed: the drive stops', { error });
        journal.append(TAIL_STREAM, { turn: turnAt, error });
        void journal
          .flush()
          .catch(() => {})
          .finally(() => ctx.halt?.(new RolloutTailError(err)));
      };
      // The rollout, mirrored line by line: every 2 s while lines arrive
      // (group commit keeps that to a batch or so), and at every barrier
      // (a tool call, a turn's end), where it is drained (`SYNC`) and flushed.
      const mirror = () => {
        if (!tail || tailBroken || journal.poisoned || ctx.signal.aborted) return;
        let fresh: string[];
        try {
          fresh = tail.read();
        } catch (err) {
          if (!machine.signal.aborted) broken(err);
          return;
        }
        for (const line of fresh) {
          if (!line) continue;
          journal.append(stream, line);
          const id = callIdOf(line);
          if (id) logged.add(id);
          if (endsTurn(line)) turnEnds++;
        }
      };
      /** Drain the tail to the end of the file (`SYNC`), then mirror what came. */
      const synced = async () => {
        if (!tail) return;
        try {
          await tail.sync();
        } catch (err) {
          if (!machine.signal.aborted) broken(err);
          throw err;
        }
        mirror();
      };
      /**
       * The hard barrier before a `never` call (§5.6): its `function_call`
       * line in the log, flushed, before its intent. Codex's rollout writer is
       * asynchronous, so the line is looked for again after each drain, a
       * bounded number of times. False: it never came, and the call must be
       * declined (it never ran; the model is told to make it again).
       */
      const barrier = async (callId: string): Promise<boolean> => {
        for (let i = 0; ; i++) {
          await synced();
          if (logged.has(callId)) {
            await journal.flush();
            return true;
          }
          if (i + 1 >= BARRIER_TRIES) break;
          await sleep(50 * 2 ** i);
        }
        log('codex: declined a call whose function_call line is not in the log', { callId });
        return false;
      };
      /** After a declined call: the model hears it was not run and may try again (a steer into the running turn; in the transcript once Codex took it). */
      const retryNote = (callId: string) => {
        const t = active;
        if (!t?.id || !threadId) return;
        void rpc
          .request('turn/steer', { threadId, expectedTurnId: t.id, clientUserMessageId: `harness:retry:${callId}`, input: [{ type: 'text', text: LAGGING_NOTE, text_elements: [] }] })
          .then(
            () => void journal.message({ type: 'message', role: 'user', text: LAGGING_NOTE, synthetic: 'retry' }),
            () => {}
          );
      };
      const takeSaid = (t: ActiveTurn | undefined) => {
        if (!t) return '';
        // The model sometimes repeats a message verbatim (its commentary, then the same as its answer): say it once.
        const text = [...t.said, ...t.partial.values()].filter((m, i, all) => !!m && m !== all[i - 1]).join('\n\n');
        t.said = [];
        t.partial.clear();
        return text;
      };

      // The built-ins: each command and patch an intent before Codex runs it, its outcome when the item completes.
      const calls = (builtins = new BuiltinCalls(ctx, {
        live: true,
        // The barrier ran before `begin` (and declined the call without its line): flush what it mirrored.
        beforeNever: async () => {
          await journal.flush();
        },
      }));
      const starting = new Map<string, Promise<Begun>>();
      /** Items an approval was asked for: at most one approval per item. */
      const asked = new Set<string>();
      /** And those it was accepted for. */
      const accepted = new Set<string>();
      /** Commands the deadline stopped: their outcome says so. */
      const timedOut = new Set<string>();
      /** A running command past the time this invocation has left: its turn is interrupted, and its outcome (when the item completes) says it was stopped. */
      const clamp = (id: string, turnId: string | undefined) => {
        if (clamps.has(id)) return;
        const limit = Math.min(spec.commandTimeoutMs ?? Infinity, deadline - Date.now() - COMMAND_MARGIN_MS);
        clamps.set(
          id,
          setTimeout(
            () => {
              clamps.delete(id);
              // Not running: its call ended, or its approval is pending or was declined (the approval re-arms it when accepted).
              if (!calls.has(id) || (asked.has(id) && !accepted.has(id))) return;
              const t = active;
              // Only its own turn is interrupted: a command that outlived its turn (unified exec) is stopped with the drive.
              if (!t?.id || (turnId && t.id !== turnId)) {
                log('codex: a command ran out of time after its turn ended: it is stopped with the drive', { callId: id });
                return;
              }
              log('codex: a command ran out of time in this invocation: stopped', { callId: id });
              timedOut.add(id);
              void rpc.request('turn/interrupt', { threadId, turnId: t.id }).catch((err) => {
                timedOut.delete(id);
                log('codex: the turn could not be interrupted', { callId: id, error: String((err as Error)?.message ?? err).slice(0, 200) });
              });
            },
            Math.max(0, Math.min(limit, 2 ** 31 - 1))
          )
        );
      };
      /** An item of a built-in (a command or a patch): its intent, once, after its `function_call` line is in the log. */
      const beginItem = (item: Record<string, any>, turnId?: string): Promise<Begun> | undefined => {
        if (!builtinsOn || (item.type !== 'commandExecution' && item.type !== 'fileChange') || typeof item.id !== 'string') return undefined;
        let started = starting.get(item.id);
        if (!started) {
          const callId = item.id;
          started = (async (): Promise<Begun> => {
            const replay = codexItemReplay(item);
            if (replay === 'never' && !ctx.isMemoized(toolKey(callId)) && !(await barrier(callId))) return LAGGING;
            const name = item.type === 'commandExecution' ? 'shell' : 'apply_patch';
            const text = takeSaid(active);
            journal.message({ type: 'message', role: 'assistant', text, toolCalls: [{ id: callId, name }] });
            const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : { changes: item.changes };
            const start = await calls.begin({ callId, name, input, replay });
            // Every command that runs is bounded by the invocation, asked about or not (Codex runs a known-safe one without asking).
            if (start.run && item.type === 'commandExecution') clamp(callId, turnId);
            return start;
          })();
          started.catch(() => {});
          starting.set(item.id, started);
        }
        return started;
      };
      const endItem = async (item: Record<string, any>) => {
        const started = beginItem(item);
        if (!started) return;
        const start = await started.catch(() => undefined);
        if (!start?.run) return;
        clearTimeout(clamps.get(item.id));
        clamps.delete(item.id);
        // What the call wrote is on the Drive before its outcome is in the log (§5.6 FSYNC); a flush that can't run leaves the call open ("may have half-run").
        try {
          await machine.fsync();
        } catch (err) {
          log('codex: the Drive flush failed; the call is left open', { callId: item.id, error: String((err as Error)?.message ?? err).slice(0, 200) });
          return;
        }
        const failed = item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
        let text =
          item.type === 'commandExecution'
            ? `${typeof item.exitCode === 'number' ? `exit code ${item.exitCode}\n` : ''}${item.aggregatedOutput ?? ''}`.trim() || `(${item.status ?? 'no output'})`
            : (item.changes ?? []).map((c: { path?: string; kind?: { type?: string } }) => `${c.kind?.type ?? 'change'} ${c.path ?? ''}`).join('\n') || `(${item.status ?? 'no changes'})`;
        // The deadline stopped it: one writer of its outcome, here, once the item reports it ended.
        if (timedOut.has(item.id)) text = `${TIMEOUT_TEXT}\n\n${text}`;
        await calls.end(item.id, { text, isError: failed || timedOut.has(item.id) }).catch(() => {});
        // The Drive's manifest hears of it: a live event, and the paths a patch named (a command may have changed anything).
        const paths = item.type === 'fileChange' ? (item.changes ?? []).map((c: { path?: unknown }) => c.path).filter((p: unknown): p is string => typeof p === 'string') : [];
        driveFiles.changed({ tool: item.type === 'commandExecution' ? 'shell' : 'apply_patch', callId: item.id, ...(paths.length ? { paths } : {}) });
      };

      /** Built-in outcomes being recorded (after their Drive flush): a turn ends only once they are in the log. */
      const ending = new Set<Promise<void>>();
      const onNotification = (n: RpcNotification) => {
        const p = n.params ?? {};
        if (n.method === 'item/started' && p.item) void beginItem(p.item, typeof p.turnId === 'string' ? p.turnId : undefined);
        else if (n.method === 'item/completed' && p.item) {
          const done = endItem(p.item).catch(() => {});
          ending.add(done);
          void done.finally(() => ending.delete(done));
        }
        const t = active;
        if (n.method === 'item/agentMessage/delta') {
          if (t && typeof p.delta === 'string') {
            t.partial.set(p.itemId, (t.partial.get(p.itemId) ?? '') + p.delta);
            ctx.live({ type: 'text', delta: p.delta });
          }
          return;
        }
        if (!t) return;
        if (n.method === 'turn/started' && typeof p.turn?.id === 'string') t.id ??= p.turn.id;
        else if (n.method === 'item/completed' && p.item?.type === 'agentMessage') {
          t.partial.delete(p.item.id);
          if (p.item.text) t.said.push(String(p.item.text));
        } else if (n.method === 'error' && !p.willRetry) t.error = p.error?.message ?? 'Codex reported an error';
        else if (n.method === 'turn/completed' && (!t.id || p.turn?.id === t.id)) t.done(p.turn ?? {});
      };

      /**
       * Why an approval is declined before its intent is looked at, if it is:
       * the drive approves one call once, as its intent names it, and nothing
       * that would run something else or run it outside bwrap.
       */
      const refusal = (p: Record<string, any>): string | undefined => {
        // Input to a running command (`write_stdin`), or a shell's sub-command: they share the parent's item id, but are not the call its intent names.
        if (p.kind === 'writeStdin') return 'writeStdin';
        if (p.approvalId != null) return 'approvalId';
        if (typeof p.reason === 'string' && /without (the )?sandbox/i.test(p.reason)) return 'unsandboxed';
        // Codex 0.160 asks again for the same item to rerun a command bwrap denied without the sandbox ("command failed; retry without sandbox?").
        if (asked.has(String(p.itemId))) return 'repeat';
        if (p.networkApprovalContext != null || (Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length > 0)) return 'network';
        // More than the sandbox gives (extra permissions, a write root): bwrap is the boundary, not advice.
        if (p.additionalPermissions != null) return 'additionalPermissions';
        if (p.grantRoot != null) return 'grantRoot';
        return undefined;
      };

      const onRequest = async (req: RpcServerRequest): Promise<unknown> => {
        const p = req.params ?? {};
        switch (req.method) {
          case 'item/tool/call': {
            const callId = String(p.callId ?? '');
            const tool = bridge.get(String(p.tool));
            // A `never` tool's call: its own line in the log first (the barrier), else it is declined, never run.
            if (tool?.replay === 'never' && callId && !ctx.isMemoized(toolKey(callId)) && !(await barrier(callId))) {
              return { contentItems: [{ type: 'inputText', text: LAGGING_RESULT }], success: false };
            }
            mirror();
            const text = takeSaid(active);
            journal.message({ type: 'message', role: 'assistant', text, toolCalls: [{ id: callId, name: String(p.tool) }] });
            // Tracked for the invocation: a re-attach waits for it, so the next drive reads its real outcome.
            const run = invocation.fg.run(() => bridge.call(String(p.tool), p.arguments ?? {}, callId));
            invocation.inflight.add(run);
            void run.then(
              () => invocation.inflight.delete(run),
              () => invocation.inflight.delete(run)
            );
            const result: ToolResult = await run;
            return { contentItems: [{ type: 'inputText', text: result.text }], success: !result.isError };
          }
          case 'item/tool/requestUserInput':
            // In Default mode Codex answers the model's request_user_input
            // itself, without asking. Should it ask, no one is here to answer.
            return { answers: {} };
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval': {
            // Built-ins off: one slipped past the config; refuse it.
            if (!builtinsOn) {
              log('codex: declined a built-in tool', { method: req.method, itemId: p.itemId });
              return { decision: 'decline' };
            }
            const itemId = String(p.itemId ?? '');
            const why = refusal(p);
            asked.add(itemId);
            if (why) {
              log('codex: declined an approval asking for more than its call', { method: req.method, itemId, escalation: why });
              return { decision: 'decline' };
            }
            const item = { ...p, id: itemId, type: req.method.includes('fileChange') ? 'fileChange' : 'commandExecution' };
            const turnId = typeof p.turnId === 'string' ? p.turnId : undefined;
            try {
              // Too close to the invocation's end to run a command and record its outcome: declined, never run (an intent already written gets that outcome).
              if (item.type === 'commandExecution' && deadline - Date.now() < COMMAND_MARGIN_MS) {
                const begun = await starting.get(itemId)?.catch(() => undefined);
                if (begun && !('lagging' in begun) && begun.run) await calls.end(itemId, { text: NO_TIME_TEXT, isError: true });
                log('codex: declined a command too close to the end of the invocation', { itemId });
                return { decision: 'decline' };
              }
              // Approved once its intent is in the log (its item/started came first; else from here).
              const start = await (starting.get(itemId) ?? beginItem(item, turnId))!;
              if ('lagging' in start) {
                retryNote(itemId);
                return { decision: 'decline' };
              }
              if (start.run) {
                accepted.add(itemId);
                if (item.type === 'commandExecution') clamp(itemId, turnId);
                return { decision: 'accept' };
              }
              log('codex: declined a call the log already has', { itemId });
              return { decision: 'decline' };
            } catch (err) {
              log('codex: declined a call whose intent could not be committed', { itemId, error: String(err) });
              return { decision: 'decline' };
            }
          }
          case 'item/permissions/requestApproval':
            // More permissions for the rest of the turn: none granted.
            log('codex: granted no extra permissions', { itemId: p.itemId });
            return { permissions: {}, scope: 'turn' };
          case 'execCommandApproval':
          case 'applyPatchApproval':
            // The same, in the protocol's older names.
            log('codex: declined a built-in tool', { method: req.method });
            return { decision: { denied: { rejection: 'Built-in tools are off in this session: use the tools you are given.' } } };
          case 'mcpServer/elicitation/request':
            return { action: 'decline', content: null, _meta: null };
          default:
            throw Object.assign(new Error(`harness-world-codex does not support ${req.method}`), { code: -32601 });
        }
      };

      rpc = new AppServer(child, {
        onNotification,
        onRequest,
        onNoise: (line) => log('codex: stdout noise', { line: line.slice(0, 200) }),
      });
      const died = rpc.closed.then((err) => {
        throw err;
      });
      stopped.catch(() => {});
      lost.catch(() => {});
      died.catch(() => {});
      const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped, lost, died]);

      const init = await guard(rpc.initialize());
      const homes = [codexHome, ...(typeof init?.codexHome === 'string' ? [init.codexHome] : [])];
      const threadParams = {
        model,
        cwd,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: sandboxMode,
        ...(options.instructions ? { developerInstructions: options.instructions } : {}),
        ...(options.baseInstructions ? { baseInstructions: options.baseInstructions } : {}),
      };
      if (resume) {
        await guard(rpc.request('thread/resume', { threadId: resume.threadId, ...threadParams, excludeTurns: true }));
        threadId = resume.threadId;
        tail = await machine.tail('codex-home', resume.path, { offset: rolloutBytes.length });
      } else {
        const started = await guard(
          rpc.request('thread/start', {
            ...threadParams,
            dynamicTools: bridge.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })),
          })
        );
        const id = String(started?.thread?.id ?? '');
        // The path is the VM's word: the driver tails only the one it would derive itself (no file is no thread to mirror: every later drive would start over).
        const path = rolloutPathIn(homes, String(started?.thread?.path ?? ''), id);
        threadId = id;
        journal.append(THREAD_STREAM, { threadId, path } satisfies ThreadRecord, { id: `thread:${threadId}` });
        tail = await machine.tail('codex-home', path, { offset: 0 });
      }
      stream = rolloutStream(threadId);
      poll = setInterval(mirror, 2000);
      mirror();

      // Steers Codex refused (their turn ended first): each gets the next Codex turn of the same session turn.
      const carry: Submission[] = [];
      /** One Codex turn, to its end line. The session's turn ends in `turn`. */
      const codexTurn = async (text: string, clientId: string): Promise<TurnOutcome> => {
        // The invocation's first message carries, once, what the model must hear about the sandbox (its files were lost).
        if (notes) {
          if (!clientId.startsWith(RECOVER_PREFIX)) journal.message({ type: 'message', role: 'user', text: notes, synthetic: 'environment' });
          text = `${notes}\n\n${text}`;
          notes = undefined;
          invocation.notesShown = true;
          invocation.notesKey = machine.notesKey;
        }
        let done!: ActiveTurn['done'];
        const completed = new Promise<Parameters<ActiveTurn['done']>[0]>((r) => (done = r));
        const t: ActiveTurn = { said: [], partial: new Map(), done, completed };
        active = t;
        const endsBefore = turnEnds;
        const started = await guard(
          rpc.request('turn/start', {
            threadId,
            clientUserMessageId: clientId,
            input: [{ type: 'text', text, text_elements: [] }],
            // No environment is no shell and no apply_patch: the built-ins off.
            ...(builtinsOn ? {} : { environments: [] }),
            approvalPolicy: 'untrusted',
            ...(options.effort ? { effort: options.effort } : {}),
          })
        );
        t.id ??= started?.turn?.id;
        const steering = steer(t);
        let result: Awaited<ActiveTurn['completed']>;
        try {
          result = await guard(completed);
        } finally {
          await steering.stop();
        }
        // The outcomes of the turn's built-ins first: a turn never ends before them.
        await guard(Promise.all([...ending]));
        // Its end line (task_complete) follows the notification closely: drained, then looked for.
        for (let i = 0; i < 20 && turnEnds <= endsBefore; i++) {
          await guard(synced());
          if (turnEnds <= endsBefore) await sleep(100);
        }
        const said = takeSaid(t);
        if (said) journal.message({ type: 'message', role: 'assistant', text: said });
        active = undefined;
        // A model call the budget refused: the turn ends here, saying which cap (no redelivery spends more).
        if (capped) {
          throw new Unavailable(`The turn stopped: the ${capped === 'turnUsd' ? "turn's" : "session's"} model spend reached its cap (sandbox({ budget: { ${capped} } })).`, {
            hint: `Raise sandbox({ budget: { ${capped} } }) to let the session spend more.`,
          });
        }
        const status = result.status === 'completed' ? 'completed' : result.status === 'interrupted' ? 'interrupted' : 'failed';
        const error = status === 'completed' ? undefined : (t.error ?? result.error?.message ?? undefined);
        return { status, ...(error ? { error } : {}) };
      };
      const endTurn = async (outcome: TurnOutcome) => {
        journal.message({ type: 'turn', ...outcome });
        await guard(journal.flush());
        ledger.turnEnded();
        // The turn that showed the model its notes is in the log: the record stops repeating them. Notes that never reached the model stay owed.
        if (invocation.notesShown && !invocation.notesAcknowledged && machine.notes.length) {
          await guard(acknowledgeInDrive(ctx, invocation.notesKey));
          invocation.notesAcknowledged = true;
        }
        ctx.live({ type: 'idle' });
        // The Drive as the turn left it, for the Files panel (best effort: bounded by the invocation's time left).
        await driveFiles.snapshot();
      };
      /**
       * A turn of the session: Codex's turn, then one more Codex turn per
       * steer it refused because its turn had just ended. Those steers were
       * placed in this turn, so the turn ends only after them: a crash in
       * one of them is recovered as part of it.
       */
      const turn = async (text: string, clientId: string) => {
        let outcome = await codexTurn(text, clientId);
        for (let s = carry.shift(); s; s = carry.shift()) outcome = await codexTurn(s.text ?? '', s.id);
        await endTurn(outcome);
      };

      // Steers that arrive while a turn runs go into it (`turn/steer`).
      const steer = (t: ActiveTurn) => {
        let stopped = false;
        let running: Promise<void> | undefined;
        const check = () => {
          if (stopped || running || !t.id) return;
          running = (async () => {
            try {
              await ctx.refresh();
              for (const s of ctx.pending().filter((x) => x.kind === 'steer')) {
                if (stopped) return;
                await invocation.fg.run(() => placeSubmissions(ctx, [s]));
                try {
                  await rpc.request('turn/steer', { threadId, expectedTurnId: t.id, clientUserMessageId: s.id, input: [{ type: 'text', text: s.text ?? '', text_elements: [] }] });
                } catch {
                  carry.push(s);
                }
              }
            } catch (err) {
              // A placement the log refused (a withdraw won it, the drive lost the session): stop.
              if (!ctx.signal.aborted) ctx.halt?.(err);
            } finally {
              running = undefined;
            }
          })();
        };
        const off = ctx.onHint?.((h) => {
          if (h.eventType === 'hook_received' || h.eventType === 'reconnect') check();
        });
        const timer = setInterval(check, options.inboxPollMs ?? (off ? 5000 : 500));
        return {
          async stop() {
            stopped = true;
            off?.();
            clearInterval(timer);
            await running;
          },
        };
      };

      // An earlier invocation that ended before its snapshot: the manifest catches up first.
      await driveFiles.catchUp();
      // A turn a crash cut off.
      const note = recoveryNote(ctx.state());
      if (note) {
        const summary = summarizeRollout(lines);
        const owed = owedSubmissions(ctx.state(), note.turn.placed, summary.clientIds);
        if (resume && summary.dangling.length > 0) {
          // Calls the rollout has no output for get theirs from the log.
          const items = summary.dangling.map((c) => ({ type: 'function_call_output', call_id: c.callId, output: repairOutput(ctx.state(), c) }));
          await guard(rpc.request('thread/inject_items', { threadId, items }));
          await guard(synced());
        }
        // Codex finished the turn (its last turn was this one's, and completed): only the end was not in the log yet.
        const finished =
          resume &&
          summary.idle &&
          summary.lastTurn === 'completed' &&
          summary.dangling.length === 0 &&
          owed.length === 0 &&
          [...summary.lastTurnClientIds].some((id) => note.turn.placed.includes(id) || id.startsWith(RECOVER_PREFIX));
        if (finished) {
          const last = summary.lastAgentMessage;
          const said = note.turn.entries.some((e) => e.data.type === 'message' && e.data.role === 'assistant' && e.data.text === last);
          if (last && !said) journal.message({ type: 'message', role: 'assistant', text: last });
          await endTurn({ status: 'completed' });
        } else {
          let text = note.text;
          if (owed.length) {
            text += `\n\nMessages that may not have reached you before the interruption:\n${owed.map((s) => quote(s.text ?? '')).join('\n')}`;
          }
          const n = transcriptOf(ctx.state()).filter((r) => r.data.type === 'message' && r.data.role === 'user').length;
          journal.message({ type: 'message', role: 'user', text: notes ? `${notes}\n\n${text}` : text, synthetic: 'recovery' } satisfies TranscriptEntry);
          await placeSubmissions(ctx, note.pending);
          // Codex answers again from the interrupted step: what a reader saw of its reply is replaced by what the log kept.
          ctx.live(restartEvent(note.turn));
          // Its client id names the submissions the note carries: once Codex has recorded it, they are not owed again.
          await turn(text, recoveryClientId(n, [...owed, ...note.pending]));
        }
      }

      // The inbox: one submission per turn, steers mid-turn.
      for (;;) {
        await guard(ctx.refresh());
        const [s] = ctx.pending();
        if (!s) break;
        await placeSubmissions(ctx, [s]);
        await turn(s.text ?? '', s.id);
      }
      // A model step a crash left open that no request of this drive made again: closed.
      await guard(steps.settleAbandoned());

      // Done: let app-server exit, keep whatever it wrote last (its exit is no failure now).
      child.end();
      await Promise.race([child.exited, sleep(2000)]);
      if (!ctx.signal.aborted && !machine.signal.aborted) {
        const live = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped, lost]);
        await live(synced());
        await live(journal.flush());
      }
    } finally {
      if (poll) clearInterval(poll);
      for (const t of clamps.values()) clearTimeout(t);
      tail?.close();
      // Whether the link was lost before this drive let go of it (a re-attach), and what the mirror read meanwhile, in the log.
      held.lost = machine.signal.aborted;
      // The app's tools still running in the Function (an email confirming) settle first, within the invocation: the next drive reads their real outcome, and no retry runs beside them.
      if (invocation.inflight.size && !ctx.signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...invocation.inflight]), new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]);
        clearTimeout(timer);
      }
      if (held.lost && !ctx.signal.aborted) await journal.flush().catch(() => {});
      ledger.close();
      // No model step outlives the drive.
      await steps.close();
      // Nothing the model started outlives the drive (§5.4 "Ending an invocation"): the session's processes are killed, the VM and the Drive stay.
      if (proc?.alive()) proc.kill('SIGKILL');
      await machine.close().catch(() => {});
      // A command or patch Codex never reported (it died mid-call, the link
      // was lost, or the turn ended with a command still running):
      // interrupted, "may or may not have taken effect", after the kill. A
      // stopped drive's are left to the kernel.
      if (builtins?.size) await builtins.interruptAll('the command was still running when its drive ended: it may or may not have taken effect');
    }
  }

  /**
   * Codex's sandbox for its commands, decided once per session: the first
   * drive with the built-ins runs bubblewrap's self-test in the VM and
   * records its verdict in the log (`codex.sandbox`); every later drive keeps
   * it, so nothing the model leaves on the Drive (or a slow VM) can move the
   * session to `danger-full-access`. On a later VM where bwrap fails, Codex's
   * commands fail closed: its offer to rerun one without the sandbox is
   * declined.
   */
  async function sandboxVerdict(ctx: DriveContext, spec: CodexMachine, machine: SessionMachine, journal: NativeJournal): Promise<'workspace-write' | 'danger-full-access'> {
    const recorded = journal.records<{ sandboxMode?: string }>(SANDBOX_STREAM).find((r) => r.data?.sandboxMode === 'workspace-write' || r.data?.sandboxMode === 'danger-full-access')?.data?.sandboxMode;
    if (recorded === 'workspace-write' || recorded === 'danger-full-access') return recorded;
    const verdict = await selfTest(ctx, spec, machine);
    journal.append(SANDBOX_STREAM, verdict);
    return verdict.sandboxMode;
  }

  /**
   * Codex's bubblewrap self-test in the VM (P0.10, §12 question 6): `codex
   * sandbox` with the workspace-write profile, as the session's user, in an
   * empty directory of its own (the Drive has no say in it). Exit 0:
   * `workspace-write`. A definite failure (a non-zero exit): `danger-full-
   * access` (the VM is the boundary, and holds no credential). One that
   * didn't finish or couldn't start is tried once more, then fails the turn:
   * it is no verdict.
   */
  async function selfTest(ctx: DriveContext, spec: CodexMachine, machine: SessionMachine): Promise<{ sandboxMode: 'workspace-write' | 'danger-full-access'; reason?: string }> {
    // A CODEX_HOME and a working directory of its own, under the cache dir: nothing it writes is near the session's.
    const selfHome = 'codex-selftest';
    await machine.files.upload('cache', [
      { path: `${selfHome}/home/.keep`, bytes: new Uint8Array() },
      { path: `${selfHome}/cwd/.keep`, bytes: new Uint8Array() },
    ]);
    const dir = `${machine.dirs.cache}/${selfHome}`;
    let why = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let test: SessionProcess;
      try {
        test = await machine.spawn({
          command: codex.command,
          args: [...codex.args, 'sandbox', '-P', ':workspace', '-C', `${dir}/cwd`, '--', 'true'],
          cwd: `${dir}/cwd`,
          signal: ctx.signal,
          env: { ...(spec.env ?? {}), HOME: machine.dirs.home, CODEX_HOME: `${dir}/home`, TMPDIR: machine.dirs.tmp, NO_COLOR: '1' },
        });
      } catch (err) {
        if (ctx.signal.aborted || machine.signal.aborted) throw err;
        why = `it did not start (${String((err as Error)?.message ?? err).slice(0, 120)})`;
        continue;
      }
      test.end();
      void (async () => {
        for await (const _ of test.lines());
      })().catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([test.exited, new Promise<undefined>((r) => (timer = setTimeout(r, 20_000, undefined)))]);
      clearTimeout(timer);
      if (!exit) {
        test.kill('SIGKILL');
        await test.exited;
      }
      if (exit?.code === 0) return { sandboxMode: 'workspace-write' };
      if (typeof exit?.code === 'number') {
        const reason = `bubblewrap's self-test failed (exit code ${exit.code})`;
        log("codex: bubblewrap's self-test failed in the VM: commands run with danger-full-access (the VM is the boundary)", { reason, stderr: test.stderrTail().slice(-500) });
        return { sandboxMode: 'danger-full-access', reason };
      }
      why = exit ? `it was killed (${exit.signal})` : 'it did not finish in 20 s';
      log("codex: bubblewrap's self-test gave no verdict", { attempt, why });
    }
    throw new Unavailable(`Codex's sandbox self-test gave no verdict in the session's sandbox: ${why}.`, {
      code: 'unavailable',
      hint: 'The VM may be slow to start: the next message retries it.',
    });
  }
}

/** The client id prefix of a recovery note's turn: `recover:<n>`, then `:<id>,<id>` for the submissions it carries. */
export const RECOVER_PREFIX = 'recover:';

/** The client id a recovery note's turn is sent with. */
export function recoveryClientId(n: number, carried: readonly Submission[]): string {
  return `${RECOVER_PREFIX}${n}${carried.length ? `:${carried.map((s) => s.id).join(',')}` : ''}`;
}

/**
 * Placed submissions of the open turn that Codex never recorded: no user
 * message in the rollout has their id as its `client_id`, alone or among
 * the ids a recovery note's turn carried. A crash between placing and
 * sending, or a steer it accepted but had not written yet.
 */
export function owedSubmissions(state: SessionState, placed: string[], clientIds: Set<string>): Submission[] {
  const recorded = new Set<string>();
  for (const id of clientIds) {
    recorded.add(id);
    if (!id.startsWith(RECOVER_PREFIX)) continue;
    const at = id.indexOf(':', RECOVER_PREFIX.length);
    if (at >= 0) for (const carried of id.slice(at + 1).split(',')) recorded.add(carried);
  }
  return placed
    .filter((id) => !recorded.has(id))
    .map((id) => state.submissions.find((s) => s.id === id))
    .filter((s): s is Submission => !!s && (s.kind === 'prompt' || s.kind === 'steer' || s.kind === 'followUp'));
}

/**
 * The output injected for a call the rollout left dangling, from what the
 * log knows: the committed result (exactly once), the recorded failure, or
 * that it never started.
 */
export function repairOutput(state: SessionState, call: RolloutCall): string {
  const e: EffectRecord | undefined = state.effects.get(toolKey(call.callId));
  // Input to a running command (unified exec): that process went with the drive that ran it.
  if (!e && call.name === 'write_stdin') return 'Interrupted: the session stopped, and the process this input was for was stopped with it. Check the state its command left before running it again.';
  if (!e) return 'Not executed: the session stopped before this call started. Call it again if it is still needed.';
  if (e.status === 'completed') return typeof e.output === 'string' ? e.output : JSON.stringify(e.output);
  if (e.status === 'failed' && e.error) {
    if (e.error.interrupted && e.replay === 'safe') return 'Interrupted before it reported a result. It is safe to repeat.';
    return failureText(e.error);
  }
  return 'Interrupted: the session stopped while this call ran. It may have taken effect: check before repeating it.';
}

const quote = (t: string) =>
  t
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
