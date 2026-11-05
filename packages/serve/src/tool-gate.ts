// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). The run's tool paths call it: pi's tools, wrapped where the run's registry composes its agents'
// tools (app.ts), the kernel's host tools on claude-agent and codex (host-tools.ts), and the MCP gateway, which takes
// the same park (harness-app.ts) and registers an executor for its approved calls.
//
// An ask has one way to wait, every tool's alike (the owner's ruling of 11-04): it PARKS. The gated call answers at once
// with waitingText and the turn ends, as ask_person's does; the run goes needs_input with the pending approval. On an
// answer the gate runs the approved call itself (exactly once, through the journaled path: the kernel's host tool; an
// MCP call, the executor its gateway registers, which comes with the gateway) and resumes the session with a message
// naming the call. No CLI waits inside a tool call, so no CLI tool timeout applies. One call waits at a time: another
// asked meanwhile is refused.
//
// The answer: POST /v2/runs/{id}/approvals/{approval_id} { decision: "allow" | "deny", note? } -> 204. The first answer
// wins; the same answer again is 204, a conflicting one 409. Only the owner's password session answers (server.ts), never
// a token. A cancel marks pending approvals canceled. There is no ask timeout; a run nobody attends (a trigger's,
// later) is to deny what is set to ask, which is not built yet.
//
// In the run's process: the asked call's request is kept in the run's own store (an `agentrun.tool_approval`
// entry on its root conversation), so a restart keeps it. The server keeps a person's answer in the run's serve.json
// (runs.ts); the gate reads it there, runs an allowed call once through the kernel's journal (the intent-then-outcome
// effect any host tool's call is, on a session key of its own: a call a crash cut off runs again only where it is
// replay-safe, and is answered interrupted otherwise) on the run's own coding source, and resumes the session with one
// message that names the call and carries its result, or the refusal. A result is cut as every host tool's is
// (HOST_RESULT_MAX_CHARS); the gate spills nothing.
//
// A stop or a cancel wins over an answer (runs.ts supersede): the gate reads the answer again before it writes the
// call's intent, cuts an approved call in flight when its answer is withdrawn, and reads it again once the call is
// done. Two windows of milliseconds remain, the same class as a stop racing any tool call inside a turn:
// - A stop that lands between the read before the intent and drive.effect's intent lets a short call that does not
//   heed its abort run. Its result is dropped (the read after the call), never resumed.
// - A stop that lands between the read after the call and resume()'s commit can start the resume turn on a stopped
//   run: a stop, unlike a cancel, leaves no mark the resume is held to.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Cursor, defineExtension, type Extension, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx, wrapTool } from "@earendil-works/pi-durable";
import { type Drive, EffectFailure, INTERRUPTED_TEXT, openDrive } from "@parcha/agentrun-kernel/kernel";
import { boundResult } from "@parcha/agentrun-kernel/process";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { readJson, RUN_META } from "./files.js";
import { LEARNED_DIR } from "./learning.js";
import { BOX_WORK } from "./place.js";
import type { TurnOrigin } from "./learning-run.js";
import { forModel } from "./result.js";
import { durableSessions } from "./sessions.js";
import { SHELL_TOOLS } from "./background.js";
import { LEGACY_NAMES, readToolSettings, SERVE_OWN_TOOLS, TABLE_TOOLS } from "./tool-plane.js";

/** What the gate does with a tool's calls. */
export const PERMISSIONS = ["allow", "ask", "deny"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** An MCP tool's gate name: `mcp:<server>/<tool>`. */
export const mcpToolName = (server: string, tool: string): string => `mcp:${server}/${tool}`;
/** Whether `name` is an MCP tool's gate name. */
export const isMcpTool = (name: string): boolean => /^mcp:[^/]+\/.+$/.test(name);
/** A third-party catalog tool, by its name: monid's (`monid.<tool>`) or an MCP server's (`mcp:<server>/<tool>`). */
export const isCatalogTool = (name: string): boolean => name.startsWith("monid.") || isMcpTool(name);
/** The owner's defaults (11-01): a built-in kernel tool allow; a third-party catalog tool ask. */
export const defaultPermission = (name: string): Permission => (isCatalogTool(name) ? "ask" : "allow");

/** The tools that run a command in the run's box (background.ts SHELL_TOOLS), each held to bash's setting: bash: deny
 *  refuses bash_background as it refuses bash, and none of them is a settings key of its own. Under bash: ask the
 *  watchers (SHELL_WATCHERS) run unasked. */
export const SHELL_FAMILY: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(SHELL_TOOLS.map((name) => [name, "bash"])));
/** The shell tool a call named `name` is, under claude-agent's host-tool name too (`mcp__hands__bash_background`), when
 *  it is one held to another's setting: its own name, which its request, its refusal and its approved call keep. */
const shellToolOf = (name: string): string | undefined => {
  const own = name.replace(/^mcp__hands__/, "");
  return Object.hasOwn(SHELL_FAMILY, own) && SHELL_FAMILY[own] !== own ? own : undefined;
};
/** The shell tools that only watch or end a process the run already started, by its own id (background.ts: an id is
 *  digits under the run's own work/background/, and another's is "no background process"): under bash: ask they run
 *  unasked, so watching an approved process costs no approval per page. bash: deny still refuses them. */
export const SHELL_WATCHERS: ReadonlySet<string> = new Set(["bash_output", "bash_list", "bash_signal"]);
/** Shell tool `name`'s permission, given bash's: a watcher's ask is allow; any other keeps bash's. */
const shellPermission = (name: string, bash: Permission): Permission => (bash === "ask" && SHELL_WATCHERS.has(name) ? "allow" : bash);

/** The settings keys that may set `name`'s permission, most specific first: the tool's own name, then, for an MCP
 *  tool, its server's wildcard `mcp:<server>/*`. */
export function permissionKeys(name: string): string[] {
  if (!isMcpTool(name)) return [name];
  return [name, `${name.slice(0, name.indexOf("/"))}/*`];
}

/** The browser's registrations on pi (pi-browser's BROWSER_TOOL_NAMES, which a test holds this list to): each is a call
 *  of the table's `browser`. */
const BROWSER_REGISTRATIONS: readonly string[] = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"];
/** A CLI's own tools, by harness, and the table's tool each one is. */
const NATIVE_TOOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "claude-agent": { WebSearch: "web_search", WebFetch: "web_fetch", Bash: "bash", Read: "read", Write: "write", Edit: "edit" },
  codex: { web_search: "web_search", shell: "bash" },
};
/** The MCP server through which claude-agent calls the kernel's host tools (`mcp__hands__<wire name>`). */
const HOST_TOOLS_SERVER = "hands";

/** The settings key a call named `name` on `harness` is held to: the one mapping from every name a call reaches the gate
 *  by. A settings key is itself (a table tool, `monid.<tool>`, `mcp:<server>/<tool>`); a CLI's own tool is the table's it
 *  is; an MCP alias, `mcp__<server>__<tool>` (claude-agent's host tools `mcp__hands__<wire name>`, mapped as their
 *  wire name) and on OpenCode `<server>_<tool>`, is `mcp:<server>/<tool>`; a catalog's wire name (`monid_run`) is its
 *  catalog name; the browser's registrations are `browser`. OpenCode's `<server>_<tool>` maps only for a server of
 *  `mcpServers` (the run's configured MCP servers), never by its shape, since a host tool's name has the same shape.
 *  Undefined: nothing maps it, and the gate asks. The key only: an MCP call enters the gate once, in the MCP gateway. */
export function settingsKeyOf(harness: string, name: string, mcpServers: readonly string[] = []): string | undefined {
  // A legacy name the tool plane folds into a capability (fetch_page into web_fetch) is held to that capability's key,
  // and a tool that runs a command in the box (bash_background and the rest) to bash's: before the table's own names.
  if (Object.hasOwn(LEGACY_NAMES, name)) return LEGACY_NAMES[name];
  if (Object.hasOwn(SHELL_FAMILY, name)) return SHELL_FAMILY[name];
  if (TABLE_TOOLS.includes(name) || SERVE_OWN_TOOLS.includes(name) || isCatalogTool(name)) return name;
  const native = NATIVE_TOOLS[harness]?.[name];
  if (native) return native;
  const mcp = /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(name);
  if (mcp) return mcp[1] === HOST_TOOLS_SERVER ? settingsKeyOf(harness, mcp[2]!, mcpServers) : mcpToolName(mcp[1]!, mcp[2]!);
  const monid = /^monid_([a-z]+)$/.exec(name);
  if (monid) return `monid.${monid[1]}`;
  if (BROWSER_REGISTRATIONS.includes(name)) return "browser";
  const alias = harness === "opencode" ? /^([a-z][a-z0-9-]*)_(.+)$/.exec(name) : null;
  return alias && mcpServers.includes(alias[1]!) ? mcpToolName(alias[1]!, alias[2]!) : undefined;
}

/** A layer of tool settings (the server's, PUT /v2/settings/tools, or an agent's own, definition.tool_settings) as the
 *  gate reads it: a permission by settings key. */
export type PermissionSettings = Readonly<Record<string, { permission?: Permission; /** Not as written: a value not offered, read as its fail-closed stand-in (tool-plane.ts readToolSettings). Never shown. */ fallback?: true } | undefined>>;

/** `name`'s permission in force and the layer it came from, most specific first: the agent's exact key, the agent's
 *  server wildcard, the server's exact key, the server's server wildcard, then the default. Rules over a call's
 *  arguments are not in V1. */
export function permissionFrom(name: string, server: PermissionSettings, agent: PermissionSettings = {}): { permission: Permission; from: "agent" | "server" | "default" } {
  // A shell tool's permission is bash's (SHELL_FAMILY), from bash's layer, wherever it is read: the gate, capabilities, an
  // agent's tools. A watcher (SHELL_WATCHERS) runs unasked only under an ask set as written in a layer: an ask that stands
  // in for anything else (a value not offered, nothing set) stays an ask. No key of its own is read, so none lifts bash's.
  if (Object.hasOwn(SHELL_FAMILY, name) && SHELL_FAMILY[name] !== name) {
    const bash = settingFrom(SHELL_FAMILY[name]!, server, agent);
    return { permission: bash.written ? shellPermission(name, bash.permission) : bash.permission, from: bash.from };
  }
  const { permission, from } = settingFrom(name, server, agent);
  return { permission, from };
}

/** permissionFrom's own read, and whether the permission is `written`: a valid one set in a layer as it reads there, not
 *  a stand-in. A value that is no permission at all reads ask, never the value. */
function settingFrom(name: string, server: PermissionSettings, agent: PermissionSettings): { permission: Permission; from: "agent" | "server" | "default"; written: boolean } {
  for (const [from, layer] of [["agent", agent], ["server", server]] as const) {
    for (const key of permissionKeys(name)) {
      const setting = layer[key];
      const set = setting?.permission;
      if (!set) continue;
      if (!(PERMISSIONS as readonly string[]).includes(set)) return { permission: "ask", from, written: false };
      return { permission: set, from, written: setting.fallback !== true };
    }
  }
  return { permission: defaultPermission(name), from: "default", written: false };
}

/** `name`'s permission in force (permissionFrom): the one rule every path reads, the gate's, the tool plane's and a
 *  workflow's call nodes'. */
export const permissionOf = (name: string, server: PermissionSettings, agent: PermissionSettings = {}): Permission => permissionFrom(name, server, agent).permission;

/** A call's answer as the model reads it: its text, and whether it failed. */
export type ToolAnswer = { text: string; isError: boolean };

/** An approval's price for the person who answers it: USD where the tool declares one (booked through the spend cap's
 *  paidCall), else "not metered" (an unpriced MCP call, the owner's ruling of 11-04). */
export type ApprovalPrice = number | "not metered";

/** One pending approval, as the run's view shows it (`pending`) and the console's approval card reads it. */
export type PendingApproval = {
  kind: "approval";
  /** The approval's id, the answer route's `{approval_id}`; the same for the same call after a crash. */
  id: string;
  tool: string;
  call_id: string;
  /** The call's arguments as text, at most ARGS_PREVIEW_BYTES. */
  args_preview: string;
  requested_at: string;
  price?: ApprovalPrice;
};

/** The run's journal commit for the call, which makes the request durable before the gate answers, and who is told it
 *  parked, so its turn ends (harness-app.ts endsTurn): by the call's id, or, where the caller cannot name it, by its tool
 *  and its arguments' digest. */
export type Park = { commit<T>(change: (tx: unknown) => Promise<T>): Promise<T>; parked?(callId: string): void; parkedBy?(match: { tool: string; argsDigest: string }): void; /** The message the turn running the call took (harness-app's), kept with its request. */ turn?(): string | undefined };

/** What a call's ask carries beyond the call. */
export type EnterOptions = {
  /** What the approval card shows the call costs. */
  price?: ApprovalPrice;
};

/** enter's answer. `undefined`: run the call. Otherwise the answer the model reads instead: a refusal
 *  (`isError: true`), or the waiting text with `parked: true`, after which the caller ends the turn. */
export type Entered = undefined | (ToolAnswer & { parked?: true });

/** Runs an APPROVED parked call of a tool family the gate does not own (the MCP gateway's), exactly once. It owns the
 *  call's deadline: the gate puts no wall-clock bound on it (only a stop or a cancel cuts it, through `signal`), so an
 *  executor bounds its own work and answers a timeout as an error result (`isError: true`), never by waiting on. */
export type Executor = (tool: string, args: unknown, callId: string, signal: AbortSignal) => Promise<ToolAnswer>;

/** The gate of one run, in the run's process. */
export interface Gate {
  /** One model-initiated call at the gate: allow, deny, or ask, which parks (see the header). */
  enter(tool: string, args: unknown, callId: string, park: Park, options?: EnterOptions): Promise<Entered>;
  /** Registers how an approved parked call of tools named `prefix…` (e.g. "mcp:") runs; one per prefix and run. */
  executor(prefix: string, run: Executor): void;
  /** A call's result text as the model gets it: as it is, a host tool's result already cut by HOST_RESULT_MAX_CHARS. */
  spill(callId: string, text: string): string;
}

/** The refusal of a call whose tool is set to deny; of one held to another tool's setting (`heldTo`, a shell tool's
 *  bash), naming the setting to change. */
export const deniedText = (tool: string, heldTo?: string): string =>
  heldTo && heldTo !== tool ? `Permission denied: ${tool} follows ${heldTo}'s setting, which is deny on this server. Don't retry it.` : `Permission denied: ${tool} is set to deny on this server. Don't retry it.`;
/** The refusal of an ask where no one can approve it: a server with accounts off, whose answer route takes no token. */
export const noApproverText = (tool: string): string => `Permission denied: ${tool} needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools.`;
/** Set by the server in a run's environment when no one can approve here (accounts off): the gate refuses each ask. */
export const NO_APPROVER_ENV = "AGENTRUN_SERVE_NO_APPROVER";
/** A parked call's answer: the run pauses here. */
export const waitingText = (tool: string): string => `This ${tool} call waits for a person's approval; the run pauses here and continues with the result when they answer.`;
/** A call a person denied, with their reason when they gave one. */
export const refusedText = (tool: string, note?: string): string => `The user denied this ${tool} call.${note ? ` Reason: ${note}` : ""}`;

/** The Timeline row of a call that waits for an approval. */
export const APPROVAL_ROW = "tool_approval_requested" as const;
/** A call's arguments shown on its approval, at most this many bytes. */
export const ARGS_PREVIEW_BYTES = 2048;

/** A gate of `policy` (the run's permission of a tool now) with no run behind it: allow and deny are enforced and
 *  executors are kept; an ask throws, since nothing here can park a call (a run's is RunGate), and spill returns
 *  the text as it is. */
export function gateOf(policy: (tool: string) => Permission): Gate {
  const executors = new Map<string, Executor>();
  return {
    async enter(tool) {
      const permission = policy(tool);
      if (permission === "allow") return undefined;
      if (permission === "deny") return { text: deniedText(tool), isError: true };
      throw new Error(`A gate with no run cannot ask a person about ${tool}.`);
    },
    executor(prefix, run) {
      executors.set(prefix, run);
    },
    spill(_callId, text) {
      return text;
    },
  };
}


/** The file in a run's directory that names the origin of the turn it runs now: written by the server alone, as it sends
 *  the learning lane's reflect turn (runs.ts's toLiveDoor), and gone before a person's turn is sent (runs.ts's personsTurn).
 *  The gate refuses that turn's writes under work/.learning/ (NOTE_ONLY_TEXT). */
export const TURN_ORIGIN_FILE = "turn-origin.json";
/** The run's store's record of a call that waits for approval (`phase: "requested"`), and of its answer acted on
 *  (`phase: "resolved"`), on its root conversation. */
export const APPROVAL_ENTRY = "agentrun.tool_approval";

/** The refusal of the end-of-run turn's write or edit under work/.learning/: its notes are kept only from its answer's
 *  note blocks (learn/reflect.ts parseReflection), which the host merges in its own store; a file there is never kept. */
export const NOTE_ONLY_TEXT = "A note is kept only from your answer: write it in a ```note block, not to a file.";

/** Whether `args.path`, as a file tool resolves it (a leading `@` dropped, Unicode spaces made plain, then lexically),
 *  names work/.learning/ or a path under it: by this machine's `work` or the box's (BOX_WORK). */
export function underLearning(work: string, args: unknown): boolean {
  const path = (args as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") return false;
  const plain = path.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  const under = (base: string, at: string) => at === join(base, LEARNED_DIR) || at.startsWith(`${join(base, LEARNED_DIR)}${sep}`);
  return under(resolve(work), resolve(work, plain)) || under(BOX_WORK, posix.resolve(BOX_WORK, plain));
}

/** One call that waits for approval, as the run's store keeps it. */
export type ApprovalRequest = { id: string; tool: string; call_id: string; args: unknown; args_preview: string; requested_at: string; /** The message the turn that parked it took: a reopen settles that turn, answered or not. */ turn?: string; price?: ApprovalPrice };
/** Resumes the session with `content` as one message of its own (`approval-<id>`), writing `mark` with it or after it. */
export type Resume = (id: string, content: string, mark: (tx: Tx) => Promise<unknown>) => Promise<void>;

/** `text` cut to at most ARGS_PREVIEW_BYTES. What is shown of a call's arguments is the whole of them redacted first, then
 *  cut (runs.ts), so a cut never leaves the head of a key no redaction recognizes. */
export function previewOf(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= ARGS_PREVIEW_BYTES ? bytes.toString("utf8") : `${bytes.subarray(0, ARGS_PREVIEW_BYTES - 3).toString("utf8").replace(/\uFFFD+$/, "")}…`;
}
/** `args` as JSON, at most ARGS_PREVIEW_BYTES: the request's own record of them, never shown as it is. */
export const argsPreview = (args: unknown): string => previewOf(JSON.stringify(args ?? {}) ?? "");

/** How the gate's resume message starts: the server knows its row by it, and redacts the row whole (runs.ts). */
export const RESUME_PREFIX = "[tool approval] ";

/** The one message that resumes a session once a person answered: it names the call it answers (its tool, call id and
 *  arguments), so the model tells it from a person's new input, and carries the call's result, or the refusal. */
export function resumeText(request: Pick<ApprovalRequest, "tool" | "call_id">, shown: string, decision: "allow" | "deny", result: ToolAnswer): string {
  // `shown`: the arguments as the server shows them, redacted whole then cut (runs.ts): never the call's own.
  const args = shown.length > 300 ? `${shown.slice(0, 299)}…` : shown;
  const head = `${RESUME_PREFIX}This answers your ${request.tool} call ${request.call_id} (arguments ${args}), which waited for a person's approval; it is not a new message from them.`;
  return decision === "allow" ? `${head} They allowed it, and it ran${result.isError ? " and failed" : ""}. Its result:\n${result.text}` : `${head}\n${result.text}`;
}

/** The gate of the run `runId` at `where` (its directory, under the data directory's runs/), on its pinned revision:
 *  an agentic run's parks an asked call; a workflow's model node cannot. */
export function runGate(where: { root: string; work: string }, runId: string, revision: { kind: string; body: { toolSettings?: unknown; harness?: string } }): RunGate {
  return new RunGate({ root: where.root, work: where.work, data: resolve(where.root, "..", ".."), runId, harness: revision.body.harness ?? "pi" }, (revision.body.toolSettings ?? {}) as PermissionSettings, revision.kind === "agentic", process.env[NO_APPROVER_ENV] !== "1");
}

/** The gate in a run's process, park mode: its policy, the turn's origin, the calls that wait, and the answers acted on. */
export class RunGate {
  private readonly requests = new Map<string, ApprovalRequest & { resolved?: true }>();
  private durable?: DurableRun;
  private context?: Context;
  private coding?: readonly ToolRegistration[];
  /** The run's own tools beyond the table (its learned_workflow), on which an approved call of one runs. */
  private extra: readonly ToolRegistration[] = [];
  private resume?: Resume;
  private drive?: Promise<Drive>;
  private timer?: NodeJS.Timeout;
  private settling = false;
  private readonly stop = new AbortController();

  /** `where.data`: the server's data directory, its tool settings beside the store; `overrides`: the pinned revision's
   *  own; `parks`: whether an asked call parks the run (an agentic run's), which a workflow's model node cannot;
   *  `approvers`: whether anyone can answer an ask here (the owner's password session: accounts on). */
  constructor(private readonly where: { root: string; work: string; data: string; runId: string; harness?: string; mcpServers?: readonly string[] }, private readonly overrides: PermissionSettings = {}, private readonly parks = true, private readonly approvers = true) {}

  /** A tool's permission now (permissionOf): the revision's own over the server's setting, read at each call, so a change
   *  reaches a live run at its next call. */
  readonly policy = (tool: string): Permission => {
    const key = settingsKeyOf(this.where.harness ?? "pi", tool, this.where.mcpServers);
    // A name nothing maps fails closed: it asks (refused where no one can approve), never allows.
    if (key === undefined) return "ask";
    const server = this.serverSettings();
    // No settings ever read: every tool asks, the shell watchers too (fail closed: an ask nothing read is never lifted),
    // or keeps the revision's own deny.
    if (server === undefined) return permissionOf(key, {}, this.overrides) === "deny" ? "deny" : "ask";
    // A shell tool under every harness's name for it is read as its own name, by bash's key (permissionFrom): a watcher's
    // ask is allow only where bash's ask is set as written.
    return permissionOf(shellToolOf(tool) ?? key, server, this.overrides);
  };

  private lastGood?: PermissionSettings;
  private readonly told = new Set<string>();
  /** The server's settings now: read at each call, so a change reaches a live run; a file that does not read keeps the
   *  last good (undefined: none read yet). Each problem is said once, by file and field, never a value. */
  private serverSettings(): PermissionSettings | undefined {
    const read = readToolSettings(this.where.data);
    for (const line of read.problems) {
      if (this.told.has(line)) continue;
      this.told.add(line);
      process.stderr.write(`agentrun-serve: the tool gate: ${line}\n`);
    }
    if (read.unreadable) return this.lastGood;
    this.lastGood = read.settings as PermissionSettings;
    return this.lastGood;
  }

  /** The origin of the turn running now: what the server's internal path wrote for it; none for a person's turn. */
  turnOrigin(): TurnOrigin | undefined {
    try {
      return (JSON.parse(readFileSync(join(this.where.root, TURN_ORIGIN_FILE), "utf8")) as { origin?: unknown })?.origin === "reflect" ? "reflect" : undefined;
    } catch {
      return undefined;
    }
  }

  /** One model-initiated call at the gate: undefined when it may run; else its answer, refused at once (deny) or parked
   *  (ask). One call waits at a time: another asked meanwhile is answered so, not run. */
  async enter(name: string, args: unknown, callId: string, park: Park, options: EnterOptions = {}): Promise<Entered> {
    // Held to its settings key (settingsKeyOf), the name its request, a refusal and the approved call give; a shell tool
    // held to bash's (SHELL_FAMILY) keeps its own name, so an approved bash_background runs bash_background, never bash.
    const key = settingsKeyOf(this.where.harness ?? "pi", name, this.where.mcpServers) ?? name;
    const tool = shellToolOf(name) ?? key;
    // The end-of-run turn writes no file under work/.learning/, whatever the tool's permission: its notes are kept only
    // from its answer (NOTE_ONLY_TEXT). Any other turn's write there follows its permission, as anywhere.
    if ((key === "write" || key === "edit") && this.turnOrigin() === "reflect" && underLearning(this.where.work, args)) return { text: NOTE_ONLY_TEXT, isError: true };
    const verdict = this.policy(name);
    if (verdict === "allow") return undefined;
    if (verdict === "deny") return { text: deniedText(tool, key), isError: true };
    // No one can answer here: refused at once with why, never parked until a cancel.
    if (!this.approvers) return { text: noApproverText(tool), isError: true };
    if (!this.parks) return { text: `This ${tool} call needs a person's approval, which a workflow's model node cannot wait for; it was not run.`, isError: true };
    // Named by the call, so a call run again after a crash parks as the same request.
    const id = `ap_${createHash("sha256").update(JSON.stringify([callId, tool, args ?? null])).digest("hex").slice(0, 16)}`;
    const other = [...this.requests.values()].find((held) => !held.resolved && held.id !== id);
    if (other) return { text: `This ${tool} call was not run: the ${other.tool} call ${other.call_id} already waits for a person's approval. Call it again once that one is answered.`, isError: true };
    if (!this.requests.has(id)) {
      const turn = park.turn?.();
      const request: ApprovalRequest = { id, tool, call_id: callId, args: args ?? null, args_preview: argsPreview(args), requested_at: new Date().toISOString(), ...(turn !== undefined ? { turn } : {}), ...(options.price !== undefined ? { price: options.price } : {}) };
      // Held before the commit's await, in the tick of the look above: pi runs a turn's calls in parallel, and an ask
      // entered meanwhile finds this one and is refused. A commit that fails lets it go.
      this.requests.set(id, request);
      try {
        await park.commit((tx) => (tx as Tx).appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "requested", ...request } as never }));
      } catch (error) {
        this.requests.delete(id);
        throw error;
      }
    }
    park.parked?.(callId);
    this.watch();
    return { text: waitingText(tool), isError: false, parked: true };
  }

  /** pi's `tools` behind the gate: wraps, by name, for the run's registry, which apply wherever it is selected (every
   *  agent selects it: the root by default, a workflow's model node by name, app.ts). */
  extension(tools: readonly ToolRegistration[]): Extension {
    // pi's MCP tools (mcp__<server>__<tool>) are gated by the MCP gateway itself, inside their execute: not wrapped here.
    const named = [...new Map(tools.filter((tool) => !tool.name.startsWith("mcp__")).map((tool) => [tool.name, tool])).values()];
    return defineExtension({ name: "tool-gate", wraps: named.map((tool) => wrapTool(tool, (inner) => this.wrap(inner))) });
  }

  private wrap(tool: ToolRegistration): ToolRegistration {
    const gate = this;
    return {
      ...tool,
      async execute(args, api, context) {
        const answer = await gate.enter(tool.name, args, api.callId, { commit: (change) => api.commit(change as never, context) as never });
        // A parked call ends the turn, as ask_person's does.
        if (answer) return forModel(answer.text, answer.parked ? { control: { terminate: true } } : { isError: true });
        return tool.execute(args, api, context);
      },
    } as ToolRegistration;
  }

  /** Reads the requests the run's store holds, as the run's process opens, before its turns go on. `coding`: the run's
   *  coding source (coding-tools.ts), on which an approved coding call runs, as the run's own would; `extra`, the run's
 *  own tools beyond the table (its learned_workflow), on which an approved call of one runs. */
  async load(durable: DurableRun, context: Context, coding?: readonly ToolRegistration[], extra: readonly ToolRegistration[] = []): Promise<void> {
    this.durable = durable;
    this.context = context;
    this.coding = coding;
    this.extra = extra;
    const root = await durable.harness.conversation(ROOT_CONVERSATION_ID, context);
    for (let cursor: Cursor | undefined; root; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) this.note(entry as { kind: string; data?: unknown });
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }

  /** Whether a call waits for its answer, or for its answer to be acted on: a harness keeps the turn it ended closed. */
  waiting(): boolean {
    return [...this.requests.values()].some((held) => !held.resolved);
  }

  /** Whether a call of the turn that took `message` was parked, answered or not: that turn ended at the park, though a
   *  process that went before the next open settled it leaves it open in its session. */
  parkedIn(message: string | undefined): boolean {
    return message !== undefined && [...this.requests.values()].some((held) => held.turn === message);
  }

  /** Acts on the answers from now on, resuming the session through `resume`; by default pi's root conversation. */
  start(resume?: Resume): void {
    this.resume = resume ?? this.submit;
    this.watch();
  }

  private note(entry: { kind: string; data?: unknown }): void {
    const data = entry.data as (ApprovalRequest & { phase?: string }) | undefined;
    if (entry.kind !== APPROVAL_ENTRY || typeof data?.id !== "string") return;
    const held = this.requests.get(data.id);
    if (data.phase === "requested" && !held) this.requests.set(data.id, data);
    else if (data.phase === "resolved" && held) held.resolved = true;
  }

  /** Reads the run's serve.json for answers while a call waits. */
  private watch(): void {
    if (this.timer || !this.resume || !this.waiting()) return;
    this.timer = setInterval(() => void this.settle(), 250);
    this.timer.unref();
    void this.settle();
  }

  /** pi's resume: an input to the root conversation under the request's own id, which pi takes once however often it
   *  is sent, then the mark. */
  private readonly submit: Resume = async (id, content, mark) => {
    const root = await this.durable!.harness.root(this.context!);
    await root.submit({ type: "input", requestId: `approval-${id}`, content, whenBusy: "followUp" }, this.context!);
    await this.durable!.harness.commit(mark, this.context!);
  };

  private async settle(): Promise<void> {
    // Acting on an answer already: an approved call may be in flight, which a stop or a cancel since cuts.
    if (this.settling) return void this.cutIfWithdrawn().catch(() => undefined);
    const open = [...this.requests.values()].filter((held) => !held.resolved);
    if (!open.length) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.settling = true;
    try {
      const answers = (await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string; note?: string; args_shown?: string }> | undefined;
      for (const held of open) {
        const answer = answers?.[held.id];
        // Withdrawn with its run (a cancel, or a stop while it waited): never run and nothing resumed; resolved, so the
        // run waits on it no more.
        if (answer?.decision === "canceled" || answer?.decision === "withdrawn") {
          await this.resolveSilently(held, answer.decision);
          continue;
        }
        if (answer?.decision !== "allow" && answer?.decision !== "deny") continue;
        const decision = answer.decision;
        // Read again just before acting: a stop or a cancel since overrides the answer (runs.ts supersede), and then
        // nothing runs and nothing resumes. Once the call's intent is written, a stop takes its turn as any stop does.
        const now = ((await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string }> | undefined)?.[held.id];
        if (now?.decision !== decision) {
          if (now?.decision === "canceled" || now?.decision === "withdrawn") await this.resolveSilently(held, now.decision);
          continue;
        }
        // An allow runs the call, unless its tool was set to deny since it asked.
        const result = decision === "deny" ? { text: refusedText(held.tool, answer.note), isError: true } : this.policy(held.tool) === "deny" ? { text: deniedText(held.tool, settingsKeyOf(this.where.harness ?? "pi", held.tool, this.where.mcpServers)), isError: true } : await this.run(held);
        // And again once the call is done: a stop or a cancel while it ran drops its result, which never reaches the model.
        const after = ((await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string }> | undefined)?.[held.id];
        if (after?.decision === "canceled" || after?.decision === "withdrawn") {
          await this.resolveSilently(held, after.decision);
          continue;
        }
        // The arguments the message names are the server's redacted ones: the gate never writes a held value there. The
        // result is cut as every host tool's is (boundResult, HOST_RESULT_MAX_CHARS, in its words): an executor's (an
        // MCP call's) comes uncut, and its journal keeps it whole.
        await this.resume!(held.id, resumeText(held, answer.args_shown ?? "(not shown)", decision, { ...result, text: boundResult(result.text).text }), (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "resolved", id: held.id, decision } }));
        held.resolved = true;
      }
    } catch (error) {
      // Tried again at the next tick: the call's effect answers from its journal, and the resume is taken once.
      process.stderr.write(`agentrun-serve: an answered approval is not acted on yet: ${(error as Error)?.message ?? error}\n`);
    } finally {
      this.settling = false;
    }
  }

  /** The approved call in flight, and its own abort: a stop or a cancel of the run cuts it (cutIfWithdrawn). */
  private inFlight?: { id: string; cut: AbortController };

  /** Cuts the approved call in flight when a stop or a cancel since withdrew its answer (runs.ts supersede). */
  private async cutIfWithdrawn(): Promise<void> {
    const flying = this.inFlight;
    if (!flying || flying.cut.signal.aborted) return;
    const now = ((await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string }> | undefined)?.[flying.id];
    if (now?.decision === "canceled" || now?.decision === "withdrawn") flying.cut.abort(new Error(INTERRUPTED_TEXT));
  }

  /** A call withdrawn with its run: resolved in the run's store with nothing run and nothing resumed. */
  private async resolveSilently(held: ApprovalRequest & { resolved?: true }, decision: string): Promise<void> {
    await this.durable!.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "resolved", id: held.id, decision } }), this.context!);
    held.resolved = true;
  }

  /** The approved call, run once by the kernel through the journal any host tool's call goes through, as an effect of
   *  the run's own `approvals:` session, on the run's coding source: its intent is durable before it runs, its outcome
   *  after; a replay-safe call a crash cut off runs again, any other is answered interrupted and never runs again. */
  private async run(held: ApprovalRequest): Promise<ToolAnswer> {
    const runner = await this.runnerOf(held);
    if ("refused" in runner) return { text: runner.refused, isError: true };
    this.drive ??= durableSessions(this.durable!.harness, this.context!)
      .open(`approvals:${this.where.runId}`)
      .then((writer) => openDrive({ writer, signal: this.stop.signal }))
      .catch((error: unknown) => {
        this.drive = undefined;
        throw error;
      });
    try {
      // Its own abort beside the drive's: a stop or a cancel of the run cuts this call, which runs outside any turn.
      const cut = new AbortController();
      this.inFlight = { id: held.id, cut };
      try {
        return await (await this.drive).effect(`approval:${held.id}`, { name: held.tool, replay: runner.replay, input: held.args }, async ({ signal }) => {
          try {
            const answer = await runner.call(AbortSignal.any([signal, cut.signal]));
            // A host tool answers its own abort as an error result: still the stop's cut.
            if (cut.signal.aborted) throw new Error(INTERRUPTED_TEXT);
            return { text: answer.text, isError: answer.isError === true };
          } catch (error) {
            // Cut by a stop: its journal answers it interrupted, as a crash's cut call is.
            if (cut.signal.aborted) throw new Error(INTERRUPTED_TEXT);
            throw error;
          }
        });
      } finally {
        this.inFlight = undefined;
      }
    } catch (error) {
      // Its outcome (interrupted, or a throw), journaled; anything else (the drive fenced) is tried again.
      if (error instanceof EffectFailure) return { text: error.message, isError: true };
      throw error;
    }
  }

  private readonly executors = new Map<string, Executor>();

  /** Registers how an approved call of tools named `prefix…` runs (the MCP gateway's, "mcp:"): one per prefix and run.
   *  The gate runs it exactly once on its journaled path, as it runs a kernel host tool, with no deadline of its own: the
   *  executor bounds the call (Executor). */
  executor(prefix: string, run: Executor): void {
    this.executors.set(prefix, run);
  }

  /** What runs an approved call: the executor its tool's prefix names, which may have effects anywhere, so a call a
   *  crash cut off is never run again; else the kernel's host tool of the name, as replay-safe as that tool is. Neither:
   *  refused, in words, and never run. */
  private async runnerOf(held: ApprovalRequest): Promise<{ replay: "safe" | "never"; call(signal: AbortSignal): Promise<ToolAnswer> } | { refused: string }> {
    const prefix = [...this.executors.keys()].find((given) => held.tool.startsWith(given));
    if (prefix) {
      const executor = this.executors.get(prefix)!;
      return { replay: "never", call: (signal) => executor(held.tool, held.args, held.call_id, signal) };
    }
    if (isMcpTool(held.tool)) return { refused: `The approved ${held.tool} call was not run: nothing in this run runs mcp: calls.` };
    // Imported here, not at the top: host-tools reaches the web tools, which reach tool-plane, which reads this module's
    // permission rule, and a cycle of top-level imports leaves one of them uninitialized for whichever loads first.
    const { hostTools } = await import("./host-tools.js");
    const [tool] = hostTools(this.durable!, [held.tool], this.context!, new Map(), this.coding, undefined, this.extra);
    if (!tool) return { refused: `The approved ${held.tool} call is not one the kernel runs outside the model's turn.` };
    return { replay: tool.replay, call: (signal) => tool.call(held.args, { callId: held.call_id, signal }) as Promise<ToolAnswer> };
  }
}

/** A parked call: by its id, or, where the caller cannot name it (OpenCode's MCP calls carry none), by its tool, as the
 *  harness reports it, and its arguments' digest (argsDigest). */
export type ParkedCall = { callId: string } | { tool: string; argsDigest: string };

/** `value` as JSON with every object's keys sorted, so the same arguments are the same text however they were built. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : (JSON.stringify(value) ?? "null");

/** The digest a park by tool and arguments is matched on: the sha256 of the arguments' canonical JSON, in hex. */
export const argsDigest = (args: unknown): string => createHash("sha256").update(canonical(args ?? {})).digest("hex");

/** Whether the tool result `result` ends the turn `parked` waits in (harness-app.ts asks it at each one): the parked
 *  call's own, by its id; or, for a park by tool and arguments, the next result of that tool with those arguments. */
export function endsTurn(parked: ParkedCall | undefined, result: { callId: string; tool: string; args: unknown }): boolean {
  if (!parked) return false;
  if ("callId" in parked) return parked.callId === result.callId;
  return parked.tool === result.tool && parked.argsDigest === argsDigest(result.args);
}
