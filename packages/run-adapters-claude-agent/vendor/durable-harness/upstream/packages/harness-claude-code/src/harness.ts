import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { type DriveContext, type Harness, type HostTool, type ReplayPolicy, Restart, type SessionState, type Submission, Unavailable } from 'harness-world';
import {
  BuiltinCalls,
  CLAUDE_ROUTES,
  type GatewayCap,
  gatewayCredential,
  type GatewayHandler,
  gatewayHandler,
  gatewayUrl,
  isBrandedMachine,
  journalLedger,
  ModelSteps,
  NativeJournal,
  openTurn,
  placeSubmissions,
  type ProviderTool,
  recoveryNote,
  restartEvent,
  replayBy,
  type SessionMachine,
  type SessionProcess,
  settleAbandonedModelSteps,
  toolBridge,
  waitForSubmissions,
  zodShapeFromJsonSchema,
} from 'harness-world-process';
import { durableEnv, nativeModelId } from './env.ts';
import { uuidFrom } from './ids.ts';
import { MessageQueue } from './inbox.ts';
import { sandboxSpawn } from './spawn.ts';
import { JournalSessionStore } from './store.ts';
import { MCP_SERVER, TranscriptBuilder, type TurnEnd } from './transcript.ts';
import { assertAgentSdkVersion, CLAUDE_VM_EXECUTABLE } from './versions.ts';

/**
 * Claude Code on harness-world: a kernel `Harness` that drives the Claude
 * Agent SDK's `query()` in the drive (in the Function), with the `claude` CLI
 * as its child **in the session's Vercel Sandbox VM** (docs/workspaces.md
 * §5.6 "Claude Code"), never on the machine that drives the session.
 *
 * Every drive (one queue delivery):
 *
 * 1. returns at once when there is nothing to do (no open turn, nothing
 *    pending): an idle wake attaches no VM;
 * 2. attaches the session's VM through the sandbox tier (`sandbox.attach`:
 *    the `sandbox.attach` fact, the relay armed with the drive's fence) and
 *    refuses any machine the session factory didn't make (`isBrandedMachine`:
 *    `Unavailable('sandbox_required')`);
 * 3. starts `query()` with streaming input: a resume of the session the log
 *    holds (the SDK `load()`s the transcript from the journal; `sandboxSpawn`
 *    uploads only its `projects/**` into the VM), or a new session whose id
 *    is derived from the run;
 * 4. mirrors every transcript line the CLI writes into the journal (the
 *    SDK's `sessionStore`, flushed eagerly; `sandboxSpawn` maps the VM's
 *    paths to the Function's, on the trusted side);
 * 5. if the last turn never ended, opens with the recovery note; places each
 *    submission, then sends it (steers go in mid-turn, at priority `next`);
 *    serves the app's tools (an in-process MCP server, in the Function) and
 *    records each built-in call through the hooks;
 * 6. writes the normalized transcript and live events, and at each turn's
 *    end a `turn` entry and a flush;
 * 7. closes the input, lets the CLI exit, and kills what is left of the
 *    session's processes in the VM (the VM and the Drive stay).
 *
 * **The model.** The CLI's base URL is the VM's model port, its key the
 * attach's model key (`SessionMachine.modelKey`); every request it sends is
 * relayed to this drive's `gatewayHandler` (Claude's fixed table, the body
 * policy, the model allowlist, the budget, the credential), so the VM never
 * holds a credential (decision 6). The spend is kept in the session's
 * journal (`journalLedger`); a request past `sandbox({ budget })`'s turn or
 * session cap ends the turn at once with an `Unavailable` naming the cap.
 *
 * **Tools.** Tool-less by default: the app's `HostTool`s (`tools`) are the
 * CLI's only tools (`tools: []`), and the system prompt says so. With
 * `builtins`, Claude Code's own tools are on in the VM, on `/workspace` (the
 * session's Drive): `true` is the pinned allowlist `CLAUDE_BUILTINS`, a list
 * names them, the `claude_code` preset brings the CLI's whole set; the
 * ones whose state the transcript does not carry (`CLAUDE_BUILTINS_OFF`) are
 * always off. Each call is recorded through the hooks (`PreToolUse` commits
 * the intent before the call runs, after the assistant entry that made it is
 * in the log; `PostToolUse` / `PostToolUseFailure` the outcome, after the
 * Drive's writes are flushed for a mutating call), so after a crash the
 * recovery note says which calls completed and which were interrupted ("may
 * have half-run"); nothing reruns one. Bash's timeout is clamped to what is
 * left of the invocation, so a command never outlives it: one the clamp ends
 * is recorded as out of time, never left open. Claude Code runs its commands
 * under its own sandbox (bubblewrap, checked by a self-test in the VM before
 * the spawn): writes only to `/workspace` and the temp and home dirs, no read
 * of the CLI's state (`/var/lib/dh/s`), the model key unset in their
 * environment, a pid namespace that hides the CLI's own environ and keeps
 * them from tracing it, and no way to the model port. Where it can't start,
 * the drive fails the turn with an `Unavailable` (`unsandboxedCommands`
 * opts out).
 *
 * **A lost CLI.** When the CLI exits mid-turn (the link to the VM dropped, so
 * the relay killed it, or the VM killed it), the drive is rebuilt from the
 * log in the same delivery (`Restart`): it re-attaches and resumes the turn
 * with the recovery note, a few times per delivery while time is left.
 */

/** The SDK functions the harness calls (the module `@anthropic-ai/claude-agent-sdk`, a peer dependency). */
export type ClaudeAgentSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query' | 'createSdkMcpServer' | 'tool'>;
type QueryOptions = NonNullable<Parameters<ClaudeAgentSdk['query']>[0]['options']>;
type UserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;

/** The VM's network, as `sandbox({ network })` says it (durable-harness's `SandboxNetwork`). */
export type ClaudeSandboxNetwork = 'allow-all' | 'deny-all' | { readonly allow: readonly string[] };

/**
 * The session's sandbox, as a kernel harness gets it from the sandbox tier
 * (harness-world-sandbox's `kernelSandbox` over the session factory, with the
 * descriptor's fields; durable-harness builds it from `sandbox()`).
 */
export interface ClaudeSandbox {
  /** Attach the session's VM for this drive (the `sandbox.attach` fact): the branded machine, with `/model` serving `model`. */
  attach(ctx: DriveContext, request: { model?: GatewayHandler; deadline?: number }): Promise<SessionMachine>;
  /**
   * The notes the machine carried (a lost Drive) reached the model in a turn
   * that committed: don't show them again. `key` is what they described
   * (`SessionMachine.notesKey`): a loss recorded since is kept.
   */
  acknowledge?(ctx: DriveContext, key?: string): Promise<void>;
  /** `sandbox({ env })`: non-secret variables for the CLI (checked there, and again at every spawn). */
  readonly env?: Readonly<Record<string, string>>;
  /** `sandbox({ network })`: what the CLI's own sandbox lets commands reach, and whether provider-hosted tools may run. */
  readonly network: ClaudeSandboxNetwork;
  /** `sandbox({ budget })`'s dollar caps (`Infinity` turns one off). */
  readonly budget: { readonly turnUsd: number; readonly sessionUsd: number };
  /** `sandbox({ commandTimeoutMs })`: the longest a Bash command may run. */
  readonly commandTimeoutMs?: number;
  /**
   * The writer of the Drive's manifest for one drive (`hw.sandbox-files`,
   * harness-world-sandbox's `DriveFiles`): told of each mutating built-in as
   * it ends, and asked to catch up once attached and for a snapshot after
   * each turn. Without it the session has no manifest (the Files panel has
   * nothing to show).
   */
  files?(ctx: DriveContext, machine: SessionMachine): ClaudeDriveFiles;
}

/** The Drive manifest's writer for one drive (`ClaudeSandbox.files`): harness-world-sandbox's `DriveFiles`, structurally. */
export interface ClaudeDriveFiles {
  /** A mutating built-in ended: a live event, and the paths it named for the next snapshot. */
  changed(call: { tool: string; callId: string; paths?: readonly string[] }): void;
  /** List first if an earlier invocation ended before its snapshot. Best effort. */
  catchUp(): Promise<void>;
  /** After a turn: list the Drive, if a call may have changed it. Best effort, bounded. */
  snapshot(): Promise<void>;
}

/** `builtins`: off, the pinned allowlist, a list of names, or the CLI's whole preset. */
export type ClaudeBuiltins = boolean | readonly string[] | { readonly type: 'preset'; readonly preset: 'claude_code' };

export interface ClaudeCodeHarnessOptions {
  /**
   * The session's sandbox (required: Claude Code runs only in the session's
   * Vercel Sandbox VM). Without one, or when it hands back a machine the
   * session factory didn't make, a drive fails the turn with
   * `Unavailable('sandbox_required')` (docs/workspaces.md §6 rule 1).
   */
  sandbox?: ClaudeSandbox;
  /**
   * The app's tools, served to Claude Code as an in-process MCP server
   * (`mcp__hands__<name>`) in the Function: each call is a kernel effect
   * keyed by its `tool_use` id, with the tool's own replay policy. Default
   * none.
   */
  tools?: HostTool[];
  /**
   * Claude Code's own tools, in the VM, on `/workspace`. Default false
   * (tool-less: `tools` are the CLI's only tools). `true`: the pinned
   * allowlist `CLAUDE_BUILTINS`; a list: those names; `{ type: 'preset',
   * preset: 'claude_code' }`: the CLI's whole set. `CLAUDE_BUILTINS_OFF` is
   * off whatever this says.
   */
  builtins?: ClaudeBuiltins;
  /** More built-ins to turn off (tool names, added to `CLAUDE_BUILTINS_OFF`). */
  disallowedTools?: string[];
  /**
   * A built-in's replay policy: what the recovery note says about a call a
   * crash interrupted ("safe to repeat", or "may have taken effect"), and
   * whether its outcome waits for the Drive's writes to be flushed (every
   * policy but `safe`). Nothing reruns a built-in either way. Default
   * `claudeBuiltinReplay` (reads safe).
   */
  builtinReplay?: Record<string, ReplayPolicy> | ((name: string) => ReplayPolicy);
  /** Provider-hosted tools the model may use (`web_search`, `web_fetch`); default none; refused with `network: 'deny-all'`. */
  providerTools?: readonly ProviderTool[];
  /**
   * The model, a native Anthropic id (`claude-sonnet-4-5`) or a Gateway one
   * (`anthropic/claude-sonnet-4.5`, passed as its native id: `nativeModelId`).
   * Default `claude-sonnet-4-5`.
   */
  model?: string;
  /** The model of the CLI's small background calls (`nativeModelId` too). Default `model`. */
  smallModel?: string;
  /** Appended to Claude Code's own system prompt (the `claude_code` preset). */
  instructions?: string;
  /** The AI Gateway credential, read per model request, in the Function. Default `gatewayCredential`. */
  credential?: () => Promise<string>;
  /** The Gateway's base URL. Default `gatewayUrl()`. */
  gatewayUrl?: string;
  /** The CLI's path in the VM. Default `CLAUDE_VM_EXECUTABLE` (the base image's pinned build). Tests on the stand-in VM pass the host build. */
  executable?: string;
  /** The kernel name (its sessions' runs are `workflow//durable-harness@<version>//<name>`). Default `claude-code`. */
  name?: string;
  /** The Agent SDK module. Default: `import('@anthropic-ai/claude-agent-sdk')` on the first drive, after its version is checked against the pin. */
  sdk?: ClaudeAgentSdk;
  /** How long a `never` tool waits for its call to reach the log before it is refused. Default 10 s. */
  barrierMs?: number;
  /**
   * Hold mirrored transcript lines this long so they share journal batches
   * (fewer events per turn). A barrier or a turn's end sends them at once.
   * Default 150 ms.
   */
  coalesceMs?: number;
  /** Keep the child this long after a turn, for a follow-up to skip the resume. Default 0. */
  idleMs?: number;
  /** `query()`'s `maxTurns` (model round trips per turn). */
  maxTurns?: number;
  /**
   * Run the CLI's commands without Claude Code's own sandbox where bubblewrap
   * doesn't work in the VM (with `builtins` on). Default false: such a drive
   * fails the turn with an `Unavailable`. Without that sandbox a command runs
   * beside the CLI as the same user: it can read the CLI's environment (the
   * model key) and trace the CLI or take its socket (the VM's kernel has no
   * Yama ptrace restriction, P0.16), so the model port's key and peer check no
   * longer tell the CLI's calls from the model's (the key is then only a
   * correlation id), and nothing hides the CLI's config dir. The VM stays the
   * boundary. For the stand-in VM's tests, and images without user namespaces.
   */
  unsandboxedCommands?: boolean;
  /** Called with the child's stderr tail when it exits mid-turn, the gateway's refusals, and SDK diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** The default model. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** What the harness appends to the system prompt about the tools, before `instructions`, with the built-ins off and the app's tools there. */
export const TOOLS_NOTE = `Your only tools are this app's, the mcp__${MCP_SERVER}__ tools; you have no shell, file, search or web tools of your own.`;

/** `TOOLS_NOTE` for a session with no tools at all (built-ins off, no `tools`). */
export const NO_TOOLS_NOTE = 'You have no tools in this session: no shell, file, search or web tools. Answer from the conversation.';

/** With the built-ins on (docs/workspaces.md §5.6 "Workspace note"): what `/workspace` is. */
export const DRIVE_NOTE =
  'Your working directory, /workspace, is this session\'s own disk: files there are durable (they stay for later turns, on any machine) but not transactional: a command that a crash interrupted may have half-run, so check before you repeat one. Commands end with this turn: nothing keeps running in the background.';

/**
 * Built-ins that stay off whatever `builtins` says: their state lives in the
 * CLI process or its local files, which the transcript the log carries does
 * not hold (cron jobs, scheduled wakeups, worktrees, agent teams and their
 * messages, background shells, workflows, the task list, P0.17: 2.1.296
 * keeps it in the config dir), or they wait for a user who is not there
 * (questions, plan mode).
 */
export const CLAUDE_BUILTINS_OFF = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'ListAgents',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TodoWrite',
  'Workflow',
  'ReportFindings',
  'Monitor',
  'BashOutput',
  'KillShell',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  // Subagents (the `claude_code` preset): their sidechains' resume across VMs is not proven yet (§11.4 R7).
  'Task',
  'Agent',
];

/**
 * `builtins: true`: the pinned allowlist, the tools Claude Code 2.1.296 has
 * (its `system/init` list, checked by a test) that act on `/workspace` and
 * whose state is in the transcript. The design's Glob, Grep and TodoWrite are
 * not tools of this CLI (it searches through Bash, and its task list is off,
 * P0.17); WebSearch is provider-hosted (`providerTools`).
 */
export const CLAUDE_BUILTINS = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch'] as const;

/** Built-ins that only read: "safe to repeat" after a crash, and no flush before their outcome. Everything else: "may have taken effect". */
export const CLAUDE_SAFE_BUILTINS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill'];

/** The default `builtinReplay`. */
export const claudeBuiltinReplay = replayBy(CLAUDE_SAFE_BUILTINS);

/** What a Bash command keeps of the invocation for its outcome to be recorded and the drive to end (the kernel's end-of-drive margin is 15 s). */
const BASH_MARGIN_MS = 20_000;
/** The shortest clamped Bash timeout worth running: past it, the call is refused before it runs. */
const BASH_MIN_MS = 1_000;
/** The invocation assumed when the kernel gives no deadline (a hand-written context): a Vercel Function's default maximum duration, the shortest likely one. */
const ASSUMED_INVOCATION_MS = 300_000;
/** How often one delivery rebuilds a drive whose CLI exited mid-turn (the kernel fails the session at 8). */
const CLI_RESTARTS = 3;
/** What a rebuilt drive needs of the invocation to be worth starting: else the delivery fails, and the queue redelivers. */
const RESTART_MIN_LEFT_MS = 60_000;
/** Where the built-in file tools may not write (they run in the CLI, outside Claude's sandbox): the repo's and Claude's config on the Drive. */
const PROTECTED_DIRS = ['.git', '.claude'];
/** The file tools' path inputs. */
const FILE_TOOLS: Readonly<Record<string, string>> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
/** What the model hears beside a call whose writes the Drive didn't confirm. */
const NOT_FLUSHED_NOTE = "The session's disk didn't confirm this call's writes: they may not have reached it. Check the files before relying on them.";

/** The `builtins` option, resolved: the `tools` option for `query()` (undefined: the preset, all of them). */
export function builtinTools(builtins: ClaudeBuiltins | undefined): string[] | undefined {
  if (builtins === undefined || builtins === false) return [];
  if (builtins === true) return [...CLAUDE_BUILTINS];
  if (Array.isArray(builtins)) {
    if (!builtins.every((b) => typeof b === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(b))) throw new TypeError('harness-world-claude-code: builtins takes tool names (Bash, Read, ...)');
    return [...builtins];
  }
  const preset = builtins as { type?: unknown; preset?: unknown };
  if (preset.type === 'preset' && preset.preset === 'claude_code') return undefined;
  throw new TypeError("harness-world-claude-code: builtins takes true, a list of tool names, or { type: 'preset', preset: 'claude_code' }");
}

/** The Claude Code sandbox settings for the VM (§5.5 "Claude Code runs under its own sandbox"; P0.10, P0.16). */
export function claudeSandboxSettings(machine: Pick<SessionMachine, 'root' | 'dirs'>, network: ClaudeSandboxNetwork): NonNullable<QueryOptions['sandbox']> {
  const { dirs } = machine;
  const open = [dirs.tmp, dirs.home, dirs.cache];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [machine.root, ...open], denyRead: [dirname(dirs.config)], allowRead: open },
    credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] },
    network: {
      ...(network === 'allow-all' ? { allowedDomains: ['*'] } : network === 'deny-all' ? { allowedDomains: [], strictAllowlist: true } : { allowedDomains: [...network.allow], strictAllowlist: true }),
      // The model port is the CLI's alone: never through the sandbox's proxy (the loopback names and literals it takes;
      // a public name that resolves to loopback still gets past, and then meets the port's key).
      deniedDomains: [...LOOPBACK_NAMES],
    },
  } as NonNullable<QueryOptions['sandbox']>;
}

/** Loopback, as names and literals a command could hand the sandbox's proxy for the model port. */
export const LOOPBACK_NAMES = ['localhost', 'localhost.', '127.0.0.1', '127.1', '0.0.0.0', '0', '2130706433', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::', '[::]'];

/** The bwrap self-test (P0.10): what Claude Code's sandbox needs of the VM, as the unprivileged user. */
const BWRAP_SELF_TEST = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--unshare-net', '--die-with-parent', 'true'];

/** Whether bubblewrap works in the VM as the agent (a fresh `/proc` in a pid namespace, no network): Claude Code's sandbox can start. */
async function bwrapWorks(machine: SessionMachine, signal: AbortSignal): Promise<boolean> {
  try {
    const proc = await machine.spawn({ command: 'bwrap', args: BWRAP_SELF_TEST, signal });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    const exit = await proc.exited;
    clearTimeout(timer);
    return exit.code === 0;
  } catch {
    return false;
  }
}

export function claudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): Harness {
  const tools = options.tools ?? [];
  const allowed = builtinTools(options.builtins);
  const builtinsOn = allowed === undefined || allowed.length > 0;
  const model = nativeModelId(options.model ?? DEFAULT_MODEL);
  const smallModel = options.smallModel ? nativeModelId(options.smallModel) : undefined;
  const barrierMs = options.barrierMs ?? 10_000;
  const executable = options.executable ?? CLAUDE_VM_EXECUTABLE;
  const replay = typeof options.builtinReplay === 'function' ? options.builtinReplay : options.builtinReplay ? (name: string) => (options.builtinReplay as Record<string, ReplayPolicy>)[name] ?? claudeBuiltinReplay(name) : claudeBuiltinReplay;
  const providerTools = options.providerTools ?? [];
  const log = options.log ?? (() => {});
  let sdk: Promise<ClaudeAgentSdk> | undefined;
  const loadSdk = (): Promise<ClaudeAgentSdk> => {
    if (!sdk) {
      // The installed SDK must be the pinned one (pnpm only warns on a peer mismatch); a failed load is tried again on the next drive.
      const loading: Promise<ClaudeAgentSdk> = options.sdk
        ? Promise.resolve(options.sdk)
        : Promise.resolve().then(() => {
            assertAgentSdkVersion();
            return import('@anthropic-ai/claude-agent-sdk');
          });
      sdk = loading;
      loading.catch(() => (sdk = undefined));
    }
    return sdk;
  };

  return {
    name: options.name ?? 'claude-code',
    // Each model request reaches Agent Runs from the Gateway proxy (`ModelSteps.request`).
    modelCalls: 'self',
    async drive(ctx: DriveContext) {
      // Nothing to do (an idle wake, a chaos arming): no VM. A model step a
      // crash left open after its turn ended is closed (no request will retry it).
      if (!recoveryNote(ctx.state()) && ctx.pending().length === 0) {
        await settleAbandonedModelSteps(ctx);
        return;
      }
      const sandbox = options.sandbox;
      if (!sandbox) throw sandboxRequired();
      const [{ query, createSdkMcpServer, tool }, { z }] = await Promise.all([loadSdk(), import('zod')]);
      const journal = new NativeJournal(ctx);
      const records = await journal.read();
      const store = new JournalSessionStore(journal, { records, coalesceMs: options.coalesceMs ?? 150 });
      // The handler reads the credential per request, in the drive's async
      // context: on a Vercel Function the OIDC token comes from the request
      // that started the drive.
      const inDrive = AsyncLocalStorage.snapshot();
      const credential = options.credential ?? gatewayCredential;
      // The handler also sees each model request start and end: the drive's
      // model steps, written around a "Crash during: model" drill.
      const steps = new ModelSteps(ctx, options.log ? { log: options.log } : {});
      const ledger = journalLedger(journal, { records });
      if (ctx.deadline === undefined) log('claude-code: the kernel gave no deadline; assuming a 300 s invocation', {});
      const deadline = ctx.deadline ?? Date.now() + ASSUMED_INVOCATION_MS;
      const handler = gatewayHandler({
        routes: CLAUDE_ROUTES,
        models: { model, ...(smallModel ? { smallModel } : {}) },
        budget: sandbox.budget,
        ledger,
        providerTools,
        network: sandbox.network === 'allow-all' || sandbox.network === 'deny-all' ? sandbox.network : 'custom',
        credential: () => inDrive(credential),
        target: options.gatewayUrl ?? gatewayUrl(),
        track: steps.request,
        onCap: (cap) => {
          if (cap !== 'concurrency') ctx.halt?.(spendCapped(cap));
        },
        // Without the app's own log, the handler's default: a refused model call is a warning in the Function's logs, not silence.
        ...(options.log ? { log: (message: string, fields?: Record<string, unknown>) => log(`claude-code gateway: ${message}`, fields) } : {}),
      });

      const abort = new AbortController();
      const stop = () => abort.abort(ctx.signal.reason);
      ctx.signal.addEventListener('abort', stop, { once: true });
      /** What the attach handed back (closed when the drive ends, branded or not), and the Function's side of the CLI's config dir. */
      let held: SessionMachine | undefined;
      let configDir: string | undefined;
      try {
        const machine = (held = await sandbox.attach(ctx, { model: handler, deadline }));
        if (!isBrandedMachine(machine)) throw sandboxRequired();

        // The Function's side of the CLI's config dir: empty, 0700, this drive's.
        // The SDK's resume copies nothing from it (no credentials, no settings),
        // and the mirror's paths are mapped to it.
        configDir = await mkdtemp(join(tmpdir(), 'dh-claude-'));
        let proc: SessionProcess | undefined;
        // What the model must hear once (a lost Drive), in the drive's first message, and what it described (to acknowledge exactly that).
        let notes = machine.notes.length ? machine.notes.join('\n\n') : undefined;
        let noteSent = false;
        // The Drive's manifest: what the Files panel shows, kept in the log so it reads with no VM.
        const driveFiles = sandbox.files?.(ctx, machine);

        // Claude Code's own sandbox (P0.10): bubblewrap must work in the VM. A failed self-test is tried once more (a slow relay, a timeout).
        const ownSandbox = builtinsOn && ((await bwrapWorks(machine, ctx.signal)) || (await bwrapWorks(machine, ctx.signal)));
        if (builtinsOn && !ownSandbox) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          if (!options.unsandboxedCommands) throw noCommandSandbox();
          log("claude-code: bubblewrap doesn't work in this VM: the CLI's commands run without its sandbox (unsandboxedCommands; the VM is the boundary, the model key only a correlation id)");
        }

        /**
         * Tool calls the MCP server is running. The drive never returns with
         * one in flight: if the CLI dies mid-call, the call still runs to its
         * outcome in this process, and that outcome lands before the next
         * delivery reads the log.
         */
        const calls = new Set<Promise<unknown>>();
        const input = new MessageQueue<UserMessage>();
        /** User messages sent and not yet consumed by a turn (by `uuid`). */
        const outstanding = new Set<string>();
        const transcript = new TranscriptBuilder({ message: (e) => store.message(e), live: (e) => ctx.live(e) });
        const bridge = toolBridge(ctx, tools, {
          // A `never` tool runs only once the assistant entry that asked for it is in the log.
          beforeNever: ({ callId }) => store.barrier(callId, barrierMs),
        });
        // The built-ins: each call an intent before it runs, its outcome after (the hooks below).
        const builtins = new BuiltinCalls(ctx, { replay, beforeNever: ({ callId }) => store.barrier(callId, barrierMs), live: true });
        /** Bash calls whose timeout the invocation clamped: their outcome, if it timed out, says so. */
        const clamped = new Map<string, number>();
        const bridged = (name: string) => name.startsWith(`mcp__${MCP_SERVER}__`);
        const server = createSdkMcpServer({
          name: MCP_SERVER,
          version: '1.0.0',
          tools: bridge.tools.map((t) =>
            tool(t.name, t.description, zodShapeFromJsonSchema(t.inputSchema, z), async (args, extra) => {
              const callId = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
              if (typeof callId !== 'string') return errorResult(`${t.name} was not run: the call carries no tool_use id`);
              await transcript.beforeCall(callId, t.name);
              const running = t.call(args, callId);
              calls.add(running);
              try {
                const result = await running;
                return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
              } catch (err) {
                // The barrier timed out (nothing ran), or the drive stopped (the bridge halted it).
                return errorResult(`${t.name} was not run: ${(err as Error)?.message ?? String(err)}`);
              } finally {
                calls.delete(running);
              }
            })
          ),
        });

        const allow = (updatedInput?: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, ...(updatedInput ? { updatedInput } : {}) } });
        const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
        /**
         * A mutating call's writes reach the Drive before its outcome is
         * recorded (a timed-out Bash may have written). Returns why the flush
         * failed, if it did: that outcome is then committed as failed, saying
         * its writes may not be on the Drive (never as a plain success).
         */
        /** A mutating built-in ended: the Drive's manifest hears of it (a live event, and the file it named). */
        const changed = (name: string, callId: string, input: unknown) => {
          if (replay(name) === 'safe' || !driveFiles) return;
          const field = FILE_TOOLS[name];
          const path = field ? (input as Record<string, unknown> | undefined)?.[field] : undefined;
          driveFiles.changed({ tool: name, callId, ...(typeof path === 'string' ? { paths: [path] } : {}) });
        };
        const flushed = async (name: string): Promise<string | undefined> => {
          if (replay(name) === 'safe') return undefined;
          try {
            await machine.fsync();
            return undefined;
          } catch (err) {
            const why = String((err as Error)?.message ?? err).slice(0, 200);
            log('claude-code: the Drive flush after a built-in failed', { name, error: why });
            return why;
          }
        };
        const hooks: QueryOptions['hooks'] = {
          // Every built-in call commits its intent before it runs. Fails
          // closed: a hook that throws lets the tool run, so every error here
          // is a deny.
          PreToolUse: [
            {
              hooks: [
                async (hook) => {
                  try {
                    if (hook.hook_event_name !== 'PreToolUse' || bridged(hook.tool_name)) return {};
                    if (ctx.signal.aborted) return deny('the session stopped');
                    let updated: Record<string, unknown> | undefined;
                    const field = FILE_TOOLS[hook.tool_name];
                    if (field) {
                      const target = (hook.tool_input as Record<string, unknown> | undefined)?.[field];
                      if (typeof target === 'string' && protectedPath(machine.root, target)) return deny(`Not run: ${PROTECTED_DIRS.join(' and ')} on /workspace are not written by the file tools in this session.`);
                    }
                    if (hook.tool_name === 'Bash') {
                      const bash = (hook.tool_input ?? {}) as Record<string, unknown>;
                      if (bash.run_in_background === true) return deny('Not run: commands can\'t run in the background in this session (they end with the turn). Run it in the foreground.');
                      const left = deadline - Date.now() - BASH_MARGIN_MS;
                      if (left < BASH_MIN_MS) return deny('Not run: this invocation of the session is out of time. Say so, and the next turn can run it.');
                      const asked = typeof bash.timeout === 'number' && bash.timeout > 0 ? bash.timeout : (sandbox.commandTimeoutMs ? Math.min(120_000, sandbox.commandTimeoutMs) : 120_000);
                      const timeout = Math.floor(Math.min(asked, left, sandbox.commandTimeoutMs ?? Infinity));
                      // Only a clamped call's input changes (what the log records is what ran).
                      if (timeout < asked) {
                        clamped.set(hook.tool_use_id, timeout);
                        updated = { ...bash, timeout };
                      }
                    }
                    await transcript.beforeCall(hook.tool_use_id, hook.tool_name);
                    const start = await builtins.begin({ callId: hook.tool_use_id, name: hook.tool_name, input: updated ?? hook.tool_input });
                    if (start.run) return allow(updated);
                    // The log already has this call's outcome (it ran before a crash): never again.
                    return deny(`Not run again: this call already ran in this session. Its recorded result: ${start.result.text}`);
                  } catch (err) {
                    return deny(`Not run: ${(err as Error)?.message ?? String(err)}`);
                  }
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (hook) => {
                  if (hook.hook_event_name !== 'PostToolUse' || bridged(hook.tool_name)) return {};
                  const unflushed = await flushed(hook.tool_name);
                  const limit = clamped.get(hook.tool_use_id);
                  const timedOut = limit !== undefined && (hook.tool_response as { interrupted?: unknown } | undefined)?.interrupted === true;
                  let text = toolResponseText(hook.tool_response);
                  if (timedOut) text = outOfTime(limit, text);
                  if (unflushed !== undefined) text = notFlushed(unflushed, text);
                  await builtins.end(hook.tool_use_id, { name: hook.tool_name, input: hook.tool_input, text, ...(timedOut || unflushed !== undefined ? { isError: true } : {}) }).catch(() => {});
                  changed(hook.tool_name, hook.tool_use_id, hook.tool_input);
                  return unflushed === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: NOT_FLUSHED_NOTE } };
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (hook) => {
                  if (hook.hook_event_name !== 'PostToolUseFailure' || bridged(hook.tool_name)) return {};
                  const unflushed = await flushed(hook.tool_name);
                  const limit = clamped.get(hook.tool_use_id);
                  const timedOut = limit !== undefined && /timed? ?out|timeout/i.test(hook.error);
                  let text = timedOut ? outOfTime(limit, hook.error) : hook.error;
                  if (unflushed !== undefined) text = notFlushed(unflushed, text);
                  await builtins.end(hook.tool_use_id, { name: hook.tool_name, input: hook.tool_input, text, isError: true }).catch(() => {});
                  changed(hook.tool_name, hook.tool_use_id, hook.tool_input);
                  return unflushed === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUseFailure' as const, additionalContext: NOT_FLUSHED_NOTE } };
                },
              ],
            },
          ],
        };

        // The CLI's environment in the VM (the SDK gets it with the Function's config dir; `sandboxSpawn` swaps the VM's back in).
        const vmEnv = durableEnv({
          home: machine.dirs.home,
          configDir: machine.dirs.config,
          tmpDir: machine.dirs.tmp,
          cacheDir: machine.dirs.cache,
          baseUrl: machine.modelUrl,
          token: machine.modelKey,
          model,
          ...(smallModel ? { smallModel } : {}),
          ...(sandbox.commandTimeoutMs ? { bashTimeoutMs: sandbox.commandTimeoutMs } : {}),
          ...(sandbox.env ? { extra: sandbox.env } : {}),
        });
        const sdkEnv = { ...vmEnv, CLAUDE_CONFIG_DIR: configDir };
        const disallowed = [...CLAUDE_BUILTINS_OFF, ...(providerTools.includes('web_search') ? [] : ['WebSearch']), ...(options.disallowedTools ?? [])];
        const sessionId = uuidFrom(ctx.runId);
        const queryOptions: QueryOptions = {
          model,
          cwd: machine.root,
          env: sdkEnv,
          // Built-ins on: the allowed ones (less those whose state the log does not carry), each let through by
          // the PreToolUse hook once its intent is in the log. Off: the bridged tools are the only ones. Either
          // way nothing is asked of a user, and nothing else is permitted.
          ...(allowed !== undefined ? { tools: allowed } : {}),
          disallowedTools: disallowed,
          ...(builtinsOn ? { hooks } : {}),
          ...(ownSandbox ? { sandbox: claudeSandboxSettings(machine, sandbox.network) } : {}),
          ...(bridge.tools.length ? { mcpServers: { [MCP_SERVER]: server } } : {}),
          allowedTools: bridge.tools.map((t) => `mcp__${MCP_SERVER}__${t.name}`),
          permissionMode: 'dontAsk',
          strictMcpConfig: true,
          // No user, project or local settings (and so no CLAUDE.md): a model-planted .claude/ on the Drive is ignored.
          settingSources: [],
          persistSession: true,
          sessionStore: store,
          sessionStoreFlush: 'eager',
          includePartialMessages: true,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: [builtinsOn ? DRIVE_NOTE : bridge.tools.length ? TOOLS_NOTE : NO_TOOLS_NOTE, options.instructions].filter(Boolean).join('\n\n'),
            snapshot: true,
          },
          ...(store.hasSession ? { resume: sessionId } : { sessionId }),
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
          pathToClaudeCodeExecutable: executable,
          spawnClaudeCodeProcess: sandboxSpawn({
            machine,
            executable,
            env: sdkEnv,
            signal: ctx.signal,
            onError: (err) => ctx.halt?.(err),
            onSpawn: (p) => (proc = p),
            onUnmapped: (why) => ctx.halt?.(mirrorUnmapped(why)),
            // Its commands in their own pid namespace (its sandbox), or none at all: the model port then admits the CLI. Without its
            // sandbox (`unsandboxedCommands`) it doesn't, on a real VM: a command could read the key from its environ.
            isolatedCommands: ownSandbox || !builtinsOn,
          }),
          abortController: abort,
        };
        const q = query({ prompt: input, options: queryOptions });
        const messages = q[Symbol.asyncIterator]();

        const send = async (text: string, placed: Submission[], how: { synthetic?: string; priority?: 'next' | 'later' } = {}) => {
          // The drive's first message says, once, what the sandbox told it (a lost Drive).
          if (notes) {
            if (!how.synthetic) store.message({ type: 'message', role: 'user', text: notes, synthetic: 'environment' });
            text = `${notes}\n\n${text}`;
            notes = undefined;
            noteSent = true;
          }
          if (how.synthetic) {
            // In the log before the submissions it carries are placed.
            store.message({ type: 'message', role: 'user', text, synthetic: how.synthetic });
            await store.flush();
          }
          // Place before send: a withdraw that wins never reaches the CLI.
          await placeSubmissions(ctx, placed);
          // The message's id is derived from the first submission it carries
          // (the key of its placement), so a recovery can find it in the
          // transcript (`lostPrompts`).
          const first = placed[0]?.id;
          // A new turn's spend is keyed by its first submission; a steer joins the turn it steers, and a recovery note keeps the key of the turn it resumes (set before).
          if (first && how.priority !== 'next' && !how.synthetic) ledger.turn(first);
          const uuid = !first ? randomUUID() : how.synthetic ? uuidFrom(`note:${first}`) : uuidFrom(first);
          outstanding.add(uuid);
          input.push({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            uuid: uuid as UserMessage['uuid'],
            ...(how.priority ? { priority: how.priority } : {}),
          });
        };

        /**
         * The CLI exited mid-turn, not because the drive stopped: the link to
         * the VM dropped (the relay killed it), or the VM killed it. Rebuild
         * the drive from the log in this delivery (`Restart`: it re-attaches,
         * and the turn resumes with the recovery note) while time is left;
         * past that, the delivery fails and the queue redelivers.
         */
        const cliExited = (why: string): Error => {
          const tail = proc ? proc.stderrTail().slice(-500) : '';
          const message = `claude exited mid-turn: ${why}${machine.signal.aborted ? ' (the link to the VM was lost)' : ''}${tail ? ` (${tail})` : ''}`;
          if (ctx.attempt < CLI_RESTARTS && deadline - Date.now() > RESTART_MIN_LEFT_MS) {
            log('claude-code: the CLI exited mid-turn; the drive is rebuilt from the log', { why: why.slice(0, 200), linkLost: machine.signal.aborted, attempt: ctx.attempt });
            return new Restart(message);
          }
          return new Error(message);
        };

        /** Read messages until a turn ends. */
        const nextTurnEnd = async (): Promise<TurnEnd> => {
          for (;;) {
            let r: IteratorResult<unknown>;
            try {
              r = await messages.next();
            } catch (err) {
              if (ctx.signal.aborted) throw ctx.signal.reason;
              throw cliExited(String((err as Error)?.message ?? err));
            }
            if (ctx.signal.aborted) throw ctx.signal.reason;
            if (r.done) throw cliExited('its output ended');
            const m = r.value as { type: string; subtype?: string; error?: unknown };
            // The SDK dropped a mirror batch (the session store refused it three times): as an unmapped frame, the turn ends and the session is kept.
            if (m.type === 'system' && m.subtype === 'mirror_error') {
              log('claude-code: the SDK dropped a mirror batch', { error: String(m.error ?? '').slice(0, 200) });
              ctx.halt?.(mirrorUnmapped('a batch the Agent SDK could not keep in the log'));
              throw ctx.signal.reason ?? mirrorUnmapped('a batch the Agent SDK could not keep in the log');
            }
            const end = transcript.observe(m);
            if (end) return end;
          }
        };

        /** Steers that arrive while a turn runs go in at once, at priority `next`; the rest wait for the turn to end. */
        const steering = () => {
          const done = new AbortController();
          const stopped = AbortSignal.any([done.signal, ctx.signal]);
          const running = (async () => {
            for (;;) {
              for (const s of ctx.pending().filter((p) => p.kind === 'steer')) {
                if (stopped.aborted) return;
                await send(s.text ?? '', [s], { priority: 'next' });
              }
              // A hint wakes it at once; without hints the inbox is polled.
              await nap(ctx, ctx.onHint ? 5000 : 1000, stopped);
              if (stopped.aborted) return;
              await ctx.refresh();
            }
          })().catch((err) => {
            // A withdraw won a placement race (`Restart`), or a write failed: rebuild from the log.
            if (!ctx.signal.aborted) ctx.halt?.(err);
          });
          return async () => {
            done.abort();
            await running;
          };
        };

        const runTurn = async () => {
          const stopSteering = steering();
          try {
            for (;;) {
              const end = await nextTurnEnd();
              transcript.endTurn(end);
              // A failed turn (a refused or failed model call) says so on the live stream too, not only in the log.
              if (end.status === 'failed') ctx.live({ type: 'error', message: end.error ?? 'the turn failed' });
              if (end.consumed) for (const u of end.consumed) outstanding.delete(u);
              else outstanding.clear();
              if (end.queued > 0 || outstanding.size > 0) continue;
              await stopSteering();
              // A steer placed while the turn was ending starts another turn.
              if (outstanding.size === 0) break;
            }
          } finally {
            await stopSteering();
          }
          // The CLI writes its end-of-turn lines (last-prompt, mode, cost) right
          // after the result: let them ride in the turn's last batch.
          await new Promise((r) => setTimeout(r, 30));
          await store.flush();
          // The note reached the model in a turn that committed: a later attach doesn't show it again (unless the Drive was lost again since).
          if (noteSent) {
            noteSent = false;
            await sandbox.acknowledge?.(ctx, machine.notesKey);
          }
          ctx.live({ type: 'idle' });
          // The Drive as the turn left it, for the Files panel (best effort: bounded by the invocation's time left).
          await driveFiles?.snapshot();
        };

        try {
          // A turn a crash cut off: resume it with what the log knows. Quote
          // its prompts if the transcript never got one of them. Its spend
          // stays keyed as the turn it resumes, so the turn cap holds across
          // redeliveries.
          // An earlier invocation that ended before its snapshot: the manifest catches up first.
          await driveFiles?.catchUp();
          const open = openTurn(ctx.state());
          const note = recoveryNote(ctx.state(), { prompts: !!open && lostPrompts(ctx.state(), open.placed, store).length > 0 });
          if (note) {
            if (open) ledger.turn(open.placed[0] ?? `open:${open.since}`);
            // The CLI answers again from the interrupted step: what a reader saw of its reply is replaced by what the log kept.
            ctx.live(restartEvent(note.turn));
            await send(note.text, note.pending, { synthetic: 'recovery' });
            await runTurn();
          }
          // The inbox, one submission per turn.
          for (;;) {
            await ctx.refresh();
            let [s] = ctx.pending();
            if (!s && options.idleMs) [s] = await waitForSubmissions(ctx, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(options.idleMs)]) });
            if (!s) break;
            await send(s.text ?? '', [s]);
            await runTurn();
          }
          // A model step a crash left open that no request of this drive made again: closed.
          await steps.settleAbandoned();
          // Let the CLI exit (stdin closed) and the SDK deliver its last mirror frames.
          input.end();
          await drain(messages, 10_000);
          await store.flush();
        } finally {
          // A call still running (the CLI exited mid-call) finishes first; a
          // stopped drive's calls stop with it (their signal), given a moment.
          if (calls.size) await settled([...calls], ctx.signal, 5000);
          // A built-in the CLI never reported (it died mid-call): interrupted,
          // "may or may not have taken effect". A stopped drive's are left to
          // the kernel, which resolves them the same way.
          if (builtins.size) await builtins.interruptAll();
          if (!input.closed) input.end();
          q.close();
          const p = proc as SessionProcess | undefined;
          if (p?.alive()) await Promise.race([p.exited, new Promise((r) => setTimeout(r, 2000))]);
        }
      } finally {
        ctx.signal.removeEventListener('abort', stop);
        // A drive that ends unstopped (the CLI exited mid-turn, a Restart): its spend records and the mirror lines still in the coalesce
        // window reach the log before the rebuilt drive reads it (bounded: a failing journal has halted the drive anyway).
        if (!ctx.signal.aborted) await Promise.race([Promise.allSettled([store.flush(), journal.flush()]), new Promise((r) => setTimeout(r, 2000).unref())]);
        // Nothing the model started outlives the drive: the session's processes in the VM are killed (the VM and the Drive stay).
        if (held) await held.close().catch(() => {});
        // No model step outlives the drive.
        await steps.close();
        if (configDir) await rm(configDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/** The refusal by provenance (docs/workspaces.md §6 rule 1). */
function sandboxRequired(): Unavailable {
  return new Unavailable('Claude Code runs only in a Vercel Sandbox: pass workspace: sandbox()', {
    code: 'sandbox_required',
    hint: "durable-harness's claudeCode() and claudeCodeHarness() attach the session's sandbox by default; a hand-built harness needs the sandbox tier's machine.",
  });
}

/** Claude Code's sandbox can't start in the VM (with the built-ins on, and no `unsandboxedCommands`). */
function noCommandSandbox(): Unavailable {
  return new Unavailable("Claude Code's own sandbox (bubblewrap) doesn't start in this session's VM, so its commands would run beside the CLI, where they can read its model key: this turn ends", {
    hint: 'Boot from the base (prepareSandboxBase) or an image built by the same recipe (bubblewrap, socat, a mountable /proc); the next turn tries again.',
  });
}

/** A built-in's outcome when the Drive didn't confirm its writes (§5.6 "FSYNC"): a failure, never a plain success. */
function notFlushed(why: string, output: string): string {
  return `${NOT_FLUSHED_NOTE} (the flush failed: ${why})\n${output}`;
}

/** Whether a file tool's path is under one of `PROTECTED_DIRS` of the workspace (relative paths are the workspace's). */
export function protectedPath(root: string, path: string): boolean {
  const abs = posix.resolve(root, path);
  return PROTECTED_DIRS.some((d) => {
    const base = posix.join(root, d);
    return abs === base || abs.startsWith(`${base}/`);
  });
}

/** A spend cap the model calls reached: the turn ends, saying which (§5.5 step 6). */
function spendCapped(cap: Exclude<GatewayCap, 'concurrency'>): Unavailable {
  return new Unavailable(`The turn stopped: the ${cap === 'turnUsd' ? "turn's" : "session's"} model spend reached its cap (sandbox({ budget: { ${cap} } })).`, {
    hint: `Raise sandbox({ budget: { ${cap} } }) to let the session spend more.`,
  });
}

/** The mirror guard (§5.6 "Mirror"): the turn ends, the session is kept. */
function mirrorUnmapped(why: string): Unavailable {
  return new Unavailable(`harness-world-claude-code: mirror_unmapped: the CLI's transcript mirror sent ${why}, so the transcript can't be kept in the log; this turn ends and the session is kept`, {
    hint: 'This is a VM or CLI fault, not a model one: check the deployment pins the CLI the image carries; the next turn tries again.',
  });
}

/** A Bash call the invocation's clamp ended (§5.6 "Deadlines"): a definite outcome, never an open intent. */
function outOfTime(limitMs: number, output: string): string {
  return `Ran out of time in this invocation of the session (its timeout was cut to ${Math.round(limitMs / 1000)} s); partial effects may exist. Output so far:\n${output}`;
}

/**
 * The prompts among `placed` that never reached the transcript: neither the
 * message sent for them (its `uuid` is derived from the first submission of
 * their placement, `place:<id>`) nor a recovery note that carried them is in
 * it. The crash came between the placement and the CLI's write.
 */
export function lostPrompts(state: SessionState, placed: string[], store: Pick<JournalSessionStore, 'hasUser'>): string[] {
  const said = new Set(state.submissions.filter((s) => s.kind === 'prompt' || s.kind === 'steer' || s.kind === 'followUp').map((s) => s.id));
  return placed.filter((id) => {
    if (!said.has(id)) return false;
    const placement = state.effectOrder.find((e) => e.name === 'place' && e.key.startsWith('place:') && e.placed.includes(id));
    const first = placement ? placement.key.slice('place:'.length) : id;
    return !store.hasUser(uuidFrom(first)) && !store.hasUser(uuidFrom(`note:${first}`));
  });
}

/** Wait `ms`, or until a hint says the log moved, or until `signal` aborts. */
function nap(ctx: DriveContext, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const off = ctx.onHint?.(() => done());
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      off?.();
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Every promise settled, or `graceMs` after `signal` aborted, whichever is first. */
function settled(promises: Promise<unknown>[], signal: AbortSignal, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => (timer = setTimeout(done, graceMs));
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    void Promise.allSettled(promises).then(done);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A built-in's result as text: Bash's output, an edit's patch, a read file's content, else the JSON. */
export function toolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  const r = response as Record<string, any> | null | undefined;
  if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)';
    if (r.type === 'text' && typeof r.file?.content === 'string') return r.file.content;
  }
  return JSON.stringify(response) ?? String(response);
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Read the iterator to its end (or until `ms` passed). */
async function drain(it: AsyncIterator<unknown>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const r = await Promise.race([it.next().catch(() => ({ done: true as const, value: undefined })), new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), left))]);
    if (r === 'timeout' || r.done) return;
  }
}
