// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). The run's tool paths call it: pi's tools, wrapped where the run's registry composes its agents'
// tools (app.ts), the kernel's host tools on claude-agent and codex (host-tools.ts), and the MCP gateway, which takes
// the same park (harness-app.ts) and registers an executor for its approved calls.
//
// An MCP tool's setting may also carry a pin (pinRefusal): top-level arguments its calls must carry, each a JSON scalar
// or one of a list. A pin adds to a setting and is never a permission: the gate checks it after a deny and before an
// allow or an ask, so an allowed call not as pinned is refused unsent, and one under ask is refused before anyone is
// asked; an approved call is checked again before it runs. The agent's pin and the server's both hold.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Cursor, defineExtension, type Extension, type Harness, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx, wrapTool } from "@earendil-works/pi-durable";
import { DESKTOP_TOOL_DEFS, type Drive, EffectFailure, INTERRUPTED_TEXT, openDrive, PHONE_TOOL_DEFS } from "@parcha/agentrun-kernel/kernel";
import { boundResult } from "@parcha/agentrun-kernel/process";
import { BARRIER, type DurableRun, MESSAGE_ORIGIN_KIND, syncNow, type SyncTarget } from "@parcha/pi-durable-disk";
import { dataOfRun, readJson, RUN_META } from "./files.js";
import { LEARNED_DIR } from "./learning.js";
import type { TurnOrigin } from "./learning-run.js";
import { COMPUTER_ROOT, portPath } from "./workspace/paths.js";
import { forModel } from "./result.js";
import { builtinHarness } from "./harness-table.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { durableSessions } from "./sessions.js";
import { SHELL_TOOLS } from "./background.js";
import { readToolSettings, SERVE_OWN_TOOLS, TABLE_TOOLS } from "./tool-plane.js";
import { NOT_RUN, RAN_UNKNOWN, refusedText } from "./refusal-words.js";
import { type Approvals, approvalsOf } from "./approvals.js";

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
/** A computer kind's tools, by name, to the one settings key their kind is held to (`desktop`, `phone`): the kernel
 *  registry's own definitions say it (their settingsKey), so a tool a kind gains is held to its key with no line here. */
const KIND_TOOLS: ReadonlyMap<string, readonly string[]> = (() => {
  const keys = new Map<string, string[]>();
  for (const def of [...DESKTOP_TOOL_DEFS, ...PHONE_TOOL_DEFS]) keys.set(def.name, [...new Set([...(keys.get(def.name) ?? []), def.settingsKey])]);
  return keys;
})();
const STRICTNESS: Readonly<Record<Permission, number>> = { allow: 0, ask: 1, deny: 2 };
/** The MCP server through which claude-agent calls the kernel's host tools (`mcp__hands__<wire name>`). */
const HOST_TOOLS_SERVER = "hands";

/** The settings key a call named `name` on `harness` is held to: the one mapping from every name a call reaches the gate
 *  by. A settings key is itself (a table tool, `monid.<tool>`, `mcp:<server>/<tool>`); a CLI's own tool is the table's it
 *  is; an MCP alias, `mcp__<server>__<tool>` (claude-agent's host tools `mcp__hands__<wire name>`, mapped as their
 *  wire name) and a harness's own (its facts' toolAlias: OpenCode's `<server>_<tool>`), is `mcp:<server>/<tool>`; a catalog's wire name (`monid_run`) is its
 *  catalog name; the browser's registrations are `browser`. OpenCode's `<server>_<tool>` maps only for a server of
 *  `mcpServers` (the run's configured MCP servers), never by its shape, since a host tool's name has the same shape.
 *  Undefined: nothing maps it, and the gate asks. The key only: an MCP call enters the gate once, in the MCP gateway for a
 *  registration it marks (GATED_BY_GATEWAY), else where its tool is wrapped. */
export function settingsKeyOf(harness: string, name: string, mcpServers: readonly string[] = []): string | undefined {
  // A tool that runs a command in the box (bash_background and the rest) is held to bash's key: before the table's own names.
  if (Object.hasOwn(SHELL_FAMILY, name)) return SHELL_FAMILY[name];
  if (TABLE_TOOLS.includes(name) || SERVE_OWN_TOOLS.includes(name) || isCatalogTool(name)) return name;
  // A desktop's or a phone's tool is its kind's key, as the browser's registrations are `browser`; one both kinds have
  // (the hand-over) is named by the first, its permission the stricter of both (RunGate's setting).
  const kind = KIND_TOOLS.get(name);
  if (kind !== undefined) return kind[0];
  // A CLI's own tool, the table's tool it is (its facts' nativeTools), by an own name only.
  const nativeTools = builtinHarness(harness)?.facts?.nativeTools;
  const native = nativeTools && Object.hasOwn(nativeTools, name) ? nativeTools[name] : undefined;
  if (native) return native;
  const mcp = /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(name);
  if (mcp) return mcp[1] === HOST_TOOLS_SERVER ? settingsKeyOf(harness, mcp[2]!, mcpServers) : mcpToolName(mcp[1]!, mcp[2]!);
  const monid = /^monid_([a-z]+)$/.exec(name);
  if (monid) return `monid.${monid[1]}`;
  if (BROWSER_REGISTRATIONS.includes(name)) return "browser";
  // A harness whose client names a session's MCP tool another way too (its facts' toolAlias: OpenCode's `<server>_<tool>`).
  const alias = builtinHarness(harness)?.facts?.toolAlias?.exec(name) ?? null;
  return alias && mcpServers.includes(alias[1]!) ? mcpToolName(alias[1]!, alias[2]!) : undefined;
}

/** A pinned argument's scalar: `null` holds for a call that leaves the argument out (or gives null). */
export type PinScalar = string | number | boolean | null;
/** A pinned argument's value: one scalar the call must carry, or a list of 1 to MAX_PIN_CHOICES ("one of"), kept and
 *  said in its one form (canonicalChoices). */
export type PinValue = PinScalar | readonly PinScalar[];
/** A setting's `pin`: an MCP tool's top-level arguments, by name, each fixed to one value or one of a list. */
export type Pin = Readonly<Record<string, PinValue>>;
/** The most arguments one setting pins, and the most values a one-of list holds. */
export const MAX_PIN_ARGS = 8;
export const MAX_PIN_CHOICES = 16;

/** A layer of tool settings (the server's, PUT /v2/settings/tools, or an agent's own, definition.tool_settings) as the
 *  gate reads it: a permission by settings key, and an MCP tool's pin. */
export type PermissionSettings = Readonly<Record<string, { permission?: Permission; /** Not as written: a value not offered, read as its fail-closed stand-in (tool-plane.ts readToolSettings). Never shown. */ fallback?: true; pin?: Pin; /** A pin in the server's file that does not read (tool-plane.ts readToolSettings): every call of the tool is refused. Never shown. */ brokenPin?: true } | undefined>>;

/** A one-of list in its one form: each value once, null first, then by its JSON text; any other value as it is. The
 *  same meaning is the same text (a revision's id) and the same words (a refusal). */
export const canonicalChoices = (value: PinValue): PinValue => {
  if (!Array.isArray(value)) return value;
  const texts = [...new Set(value.filter((one) => one !== null).map((one) => JSON.stringify(one)))].sort();
  return [...(value.includes(null) ? [null] : []), ...texts.map((text) => JSON.parse(text) as PinScalar)];
};
/** `pin` in its one form: its arguments sorted, each one-of list in its form (canonicalChoices). */
export const canonicalPin = (pin: Pin): Pin => Object.fromEntries(Object.keys(pin).sort().map((arg) => [arg, canonicalChoices(pin[arg]!)]));

/** Whether a call's argument `given` is the pinned scalar `one`: the same JSON scalar (strict equality), or, for null,
 *  left out or null. */
const isOne = (given: unknown, one: PinScalar): boolean => (one === null ? given === undefined || given === null : given === one);
/** Whether `given` holds pinned `value`: its scalar, or one of its list. */
const holds = (given: unknown, value: PinValue): boolean => (Array.isArray(value) ? value.some((one) => isOne(given, one)) : isOne(given, value as PinScalar));
/** A scalar in a refusal's words: text as it is, null as `absent`, any other as JSON. */
const scalarWords = (one: PinScalar): string => (one === null ? "absent" : typeof one === "string" ? one : JSON.stringify(one));
/** A pin in words, as the refusal says it, in its one form (canonicalPin): `channel_id = C0123`, `cc absent` for a null,
 *  `event in (absent | COMMENT)` for a list. */
export const pinWords = (pin: Pin): string => Object.entries(canonicalPin(pin)).map(([arg, value]) => (Array.isArray(value) ? `${arg} in (${value.map(scalarWords).join(" | ")})` : value === null ? `${arg} absent` : `${arg} = ${scalarWords(value as PinScalar)}`)).join(", ");
/** What holds both of two layers' pins of one argument (`own`, the agent's, and `theirs`, the server's): a scalar where
 *  either is one and the other holds it, else the agent's list kept to the server's, in the agent's order; undefined when
 *  nothing holds both. */
function bothOf(own: PinValue, theirs: PinValue): PinValue | undefined {
  const list = (value: PinValue): readonly PinScalar[] => (Array.isArray(value) ? value : [value as PinScalar]);
  if (!Array.isArray(own)) return list(theirs).some((one) => one === own) ? own : undefined;
  if (!Array.isArray(theirs)) return own.some((one) => one === theirs) ? theirs : undefined;
  const kept = own.filter((one) => theirs.some((other) => other === one));
  return kept.length ? kept : undefined;
}

/** Why the call of MCP tool `name` with `args` is refused by a pin, or undefined when no pin refuses it. A pin is an
 *  addition to a setting, never a permission: each layer's pin on the tool's own key holds (the agent's and the
 *  server's both, whatever the permission), and a call must carry every pinned argument as pinned: its value, or one of
 *  its list. An argument both layers pin takes what holds both; where nothing does, every call is refused. `ran`: whether an earlier attempt of
 *  the call may have been sent (deniedText's). `mismatched`: the arguments that do not hold, for the gate's log line. */
export function pinRefusal(name: string, args: unknown, server: PermissionSettings, agent: PermissionSettings = {}, ran: "no" | "unknown" = "no"): { text: string; mismatched: string[] } | undefined {
  if (!isMcpTool(name)) return undefined;
  const what = ran === "no" ? NOT_RUN : RAN_UNKNOWN;
  if (server[name]?.brokenPin) return { text: `${name} can't be called: its pin in this server's tool settings does not read, so no call is let through until the owner sets it again (Settings → Tools). ${what}`, mismatched: [] };
  const own = agent[name]?.pin ?? {};
  const theirs = server[name]?.pin ?? {};
  // Both layers hold: an argument both pin takes what holds both (bothOf), and one where nothing does refuses every call.
  const clash = Object.keys(own).filter((arg) => Object.hasOwn(theirs, arg) && bothOf(own[arg]!, theirs[arg]!) === undefined);
  if (clash.length) return { text: `${name} can't be called: this agent's settings fix ${pinWords(Object.fromEntries(clash.map((arg) => [arg, own[arg]!])))} and this server's fix ${pinWords(Object.fromEntries(clash.map((arg) => [arg, theirs[arg]!])))}, so no call can satisfy both. ${what} Don't retry it: the owner makes the two agree.`, mismatched: clash };
  const pin: Pin = { ...theirs, ...Object.fromEntries(Object.entries(own).map(([arg, value]) => [arg, Object.hasOwn(theirs, arg) ? bothOf(value, theirs[arg]!)! : value])) };
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const mismatched = Object.keys(pin).filter((arg) => !holds(Object.hasOwn(given, arg) ? given[arg] : undefined, pin[arg]!));
  if (!mismatched.length) return undefined;
  const by = Object.keys(own).length && Object.keys(theirs).length ? "the agent's and this server's settings" : Object.keys(own).length ? "the agent's settings" : "this server's settings";
  return { text: `${name} may only be called with ${pinWords(pin)}: its destination is fixed by ${by}. ${what}`, mismatched };
}

/** `name`'s permission in force and the layer it came from, most specific first: the agent's exact key, the agent's
 *  server wildcard, the server's exact key, the server's server wildcard, then the default. A call's arguments
 *  are held only by a pin (pinRefusal), which adds to a setting and is never a permission. `approvals` "never" (an agent run unattended) turns the ask that is left into an allow, from
 *  "unattended", as the last step, and only where nothing stands behind that ask (standsBehind): never past a deny in any
 *  layer, nor an ask that stands in for a setting that does not read. Nor is anything RunGate.enter refuses before it
 *  decides between running and parking ever lifted (a template's pin, among them). Without never, the answer is as it
 *  always was. */
export function permissionFrom(name: string, server: PermissionSettings, agent: PermissionSettings = {}, approvals: Approvals = "ask"): { permission: Permission; from: SettingFrom } {
  const { permission, from } = settingOf(name, server, agent);
  if (approvals !== "never" || permission !== "ask" || standsBehind(name, server, agent)) return { permission, from };
  return { permission: "allow", from: "unattended" };
}

/** Whether something stands behind `name`'s ask that approvals "never" must not lift: in either layer, under any key the
 *  tool is read by (its own, its MCP server's wildcard; a shell tool's, bash's), a deny, a value that is no permission,
 *  or a setting marked as not read as written (`fallback`). The ask a layer above gives does not hide a deny below it. */
function standsBehind(name: string, server: PermissionSettings, agent: PermissionSettings): boolean {
  const held = Object.hasOwn(SHELL_FAMILY, name) ? SHELL_FAMILY[name]! : name;
  return [agent, server].some((layer) => permissionKeys(held).some((key) => {
    const setting = layer[key];
    if (setting?.permission === undefined) return false;
    return setting.permission === "deny" || setting.fallback === true || !(PERMISSIONS as readonly string[]).includes(setting.permission);
  }));
}

/** permissionFrom before approvals: what the layers and the default say. */
function settingOf(name: string, server: PermissionSettings, agent: PermissionSettings): { permission: Permission; from: SettingFrom } {
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
export const permissionOf = (name: string, server: PermissionSettings, agent: PermissionSettings = {}, approvals: Approvals = "ask"): Permission => permissionFrom(name, server, agent, approvals).permission;

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
  /** The call is a replay: a crash cut an earlier attempt that may have been sent (the kernel's attempt above 0). A
   *  refusal then never says nothing was sent or charged. */
  replayed?: true;
};

/** enter's answer. `undefined`: run the call. Otherwise the answer the model reads instead: a refusal
 *  (`isError: true`), or the waiting text with `parked: true`, after which the caller ends the turn. */
export type Entered = undefined | (ToolAnswer & { parked?: true });

/** Runs an APPROVED parked call of a tool family the gate does not own (the MCP gateway's), exactly once. It owns the
 *  call's deadline: the gate puts no wall-clock bound on it (only a stop or a cancel cuts it, through `signal`), so an
 *  executor bounds its own work and answers a timeout as an error result (`isError: true`), never by waiting on. */
export type Executor = (tool: string, args: unknown, callId: string, signal: AbortSignal) => Promise<ToolAnswer>;

/** The mark a tool registration carries when its calls are gated by whoever registered it (the MCP gateway, which marks
 *  its registrations only when it holds this run's gate and park, and enters the gate in each call): RunGate.extension
 *  does not wrap it again. A private symbol, never `Symbol.for`: a global-registry key could be recreated by any code
 *  with the string alone. Only code that imports this export can set it (mcp-gateway.ts does). */
export const GATED_BY_GATEWAY: unique symbol = Symbol("agentrun.gatedByGateway");
/** A registration that may carry GATED_BY_GATEWAY. */
export type GatewayMarked = ToolRegistration & { [GATED_BY_GATEWAY]?: true };

/** The gate of one run, in the run's process. */
export interface Gate {
  /** One model-initiated call at the gate: allow, deny, or ask, which parks (see the header). */
  enter(tool: string, args: unknown, callId: string, park: Park, options?: EnterOptions): Promise<Entered>;
  /** Registers how an approved parked call of tools named `prefix…` (e.g. "mcp:") runs; one per prefix and run. */
  executor(prefix: string, run: Executor): void;
  /** A call's result text as the model gets it: as it is, a host tool's result already cut by HOST_RESULT_MAX_CHARS. */
  spill(callId: string, text: string): string;
}

/** Where a permission was set (permissionFrom's `from`): the agent's own tool settings, the server's, or the default; or
 *  "unattended": an ask the agent's approvals "never" allowed. */
export type SettingFrom = "agent" | "server" | "default" | "unattended";
/** Where a deny can come from: a setting in a layer, or the default. Never "unattended", which only ever allows. */
export type DenyFrom = Exclude<SettingFrom, "unattended">;
// The refusal words (NOT_RUN, RAN_UNKNOWN, refusedText) live in refusal-words.ts, shared with the runner's loops.
export { NOT_RUN, RAN_UNKNOWN, refusedText } from "./refusal-words.js";
/** Where a deny was set, in words: the place a person changes it. */
export const denyPlace = (from: SettingFrom = "server"): string => (from === "agent" ? "for this agent" : from === "default" ? "by default" : "on this server");
/** The refusal of a call whose tool is set to deny; of one held to another tool's setting (`heldTo`, a shell tool's
 *  bash), naming the setting to change and where it was set (`from`: this agent's settings or this server's). */
export const deniedText = (tool: string, heldTo?: string, from: SettingFrom = "server", ran: "no" | "unknown" = "no"): string => {
  // `ran`: "unknown" for a call an earlier attempt of which may have been sent (an approved call cut mid-flight, or a
  // replay-safe call run again after a crash): the words never claim it wasn't.
  const what = ran === "no" ? NOT_RUN : RAN_UNKNOWN;
  return heldTo && heldTo !== tool ? `Permission denied: ${tool} follows ${heldTo}'s setting, which is deny ${denyPlace(from)}. ${what} Don't retry it.` : `Permission denied: ${tool} is set to deny ${denyPlace(from)}. ${what} Don't retry it.`;
};
/** The refusal of an ask where no one can approve it: a server with accounts off, whose answer route takes no token. */
export const noApproverText = (tool: string, ran: "no" | "unknown" = "no"): string => `Permission denied: ${tool} needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools. ${ran === "no" ? NOT_RUN : RAN_UNKNOWN}`;
/** Set by the server in a run's environment when no one can approve here (accounts off): the gate refuses each ask. */
export const NO_APPROVER_ENV = "AGENTRUN_SERVE_NO_APPROVER";
/** A parked call's answer: the run pauses here. */
export const waitingText = (tool: string): string => `This ${tool} call waits for a person's approval; the run pauses here and continues with the result when they answer.`;

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
/** The run's store's record that the gate let a replay-safe pi call that can bill through (`{ callId }`), written before
 *  the tool runs. pi-durable reruns a cut replay-safe call with the same call id and no sign that it is a rerun: this mark
 *  is how the gate knows an earlier attempt may have been sent, so a deny of the rerun never says nothing was charged.
 *  Outside `agentrun.tool_`, the tool ledger's kinds (paid-calls.ts), which readers of a run's charges take by prefix. */
export const GATE_PASSED_ENTRY = "agentrun.gate_passed";
/** The replay-safe tools, by settings key, whose call can be charged (a provider's fee: Parallel's search or extract): the
 *  only ones the gate marks, so the root conversation does not grow by a mark per free call (read, the shell watchers,
 *  monid's discover and inspect), whose earlier attempt charged nothing. monid.run is never rerun (host-tools.ts REPLAY). */
const BILLED_REPLAYS: ReadonlySet<string> = new Set(["web_fetch", "web_search"]);

/** The refusal of the end-of-run turn's write or edit under work/.learning/: its notes are kept only from its answer's
 *  note blocks (learn/reflect.ts parseReflection), which the host merges in its own store; a file there is never kept. */
export const NOTE_ONLY_TEXT = "A note is kept only from your answer: write it in a ```note block, not to a file.";

/** Whether `args.path`, as a file tool resolves it (a leading `@` dropped, Unicode spaces made plain, then the port's
 *  path of it, portPath), names .learning/ in the run's folder or a path under it: by the folder's path here (`work`)
 *  or a computer's name for it (COMPUTER_ROOT). */
export function underLearning(work: string, args: unknown): boolean {
  const path = (args as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") return false;
  const plain = path.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  return portPath(plain, [work, COMPUTER_ROOT])?.split("/")[0] === LEARNED_DIR;
}

/** One call that waits for approval, as the run's store keeps it. */
export type ApprovalRequest = { id: string; tool: string; call_id: string; args: unknown; args_preview: string; requested_at: string; /** The message the turn that parked it took: a reopen settles that turn, answered or not. */ turn?: string; price?: ApprovalPrice; /** Parked on a replay: a crash cut an earlier attempt that may have been sent, so a refusal never says nothing was charged. Kept in the store, so a restart keeps it. */ replayed?: true };
/** Resumes the session with `content` as one message of its own (`approval-<id>`), writing `mark` with it or after it. */
export type Resume = (id: string, content: string, mark: (tx: Tx) => Promise<unknown>, origin?: ResumeOrigin) => Promise<void>;
/** Who wrote a resume, for the Timeline (pi-durable-agent's MessageOrigin): the server, carrying an answer, so it never
 *  shows as the person's message. A person's message that declined the call: `said`, their words, which the Timeline
 *  shows as theirs beside the server's row. */
export type ResumeOrigin = { kind: "server"; reason: "approval" } | { kind: "server"; reason: "approval_declined"; said: string };

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
/** The head of the gate's resume message: the call it answers, its arguments as shown (`shown`, redacted whole then cut,
 *  runs.ts) cut again at 300 characters, and the words that say it is not the person's. The one source of it: the resume
 *  writes it, and the Timeline strips exactly it from the row a person opens (runs.ts resumeShows). */
export function resumeHead(request: Pick<ApprovalRequest, "tool" | "call_id">, shown: string): string {
  const args = shown.length > 300 ? `${shown.slice(0, 299)}…` : shown;
  return `${RESUME_PREFIX}This answers your ${request.tool} call ${request.call_id} (arguments ${args}), which waited for a person's approval; it is not a new message from them.`;
}
export function resumeText(request: Pick<ApprovalRequest, "tool" | "call_id">, shown: string, decision: "allow" | "deny", result: ToolAnswer): string {
  const head = resumeHead(request, shown);
  return decision === "allow" ? `${head} They allowed it, and it ran${result.isError ? " and failed" : ""}. Its result:\n${result.text}` : `${head}\n${result.text}`;
}

/** The gate of the run `runId` at `where` (its directory, under the data directory's runs/), on its pinned revision:
 *  an agentic run's parks an asked call; a workflow's model node cannot. */
export function runGate(where: { root: string; work: string }, runId: string, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } }): RunGate {
  return new RunGate({ root: where.root, work: where.work, data: dataOfRun(where.root), runId, harness: revision.body.harness ?? DEFAULT_HARNESS }, (revision.body.toolSettings ?? {}) as PermissionSettings, revision.kind === "agentic", process.env[NO_APPROVER_ENV] !== "1", approvalsOf(revision.body.approvals));
}

/** The gate in a run's process, park mode: its policy, the turn's origin, the calls that wait, and the answers acted on. */
export class RunGate {
  private readonly requests = new Map<string, ApprovalRequest & { resolved?: true }>();
  /** The replay-safe pi calls the gate let through (GATE_PASSED_ENTRY), by call id: a rerun of one is a replay. */
  private readonly passed = new Set<string>();
  private durable?: DurableRun;
  /** The run's store, for the barrier before a call that is not replay-safe: from `prime` (before the resume) or `load`. */
  private syncTarget?: SyncTarget;
  private context?: Context;
  private coding?: readonly ToolRegistration[];
  /** The run's own tools beyond the table (its learned_workflow), on which an approved call of one runs. */
  private extra: readonly ToolRegistration[] = [];
  private resume?: Resume;
  /** Told just before an allowed call runs (harness-app's): the run is un-parked, so the call's own model requests (a
   *  learned workflow's node) go out; the harness is idle then, as the park ended its turn. */
  private unpark?: () => void;
  private drive?: Promise<Drive>;
  private timer?: NodeJS.Timeout;
  private settling = false;
  private readonly stop = new AbortController();

  /** `where.data`: the server's data directory, its tool settings beside the store; `overrides`: the pinned revision's
   *  own; `parks`: whether an asked call parks the run (an agentic run's), which a workflow's model node cannot;
   *  `approvers`: whether anyone can answer an ask here (the owner's password session: accounts on); `approvals`: the
   *  pinned revision's (definition.approvals): "never" runs the agent unattended, an ask allowed (permissionFrom). */
  constructor(private readonly where: { root: string; work: string; data: string; runId: string; harness?: string; mcpServers?: readonly string[] }, private readonly overrides: PermissionSettings = {}, private readonly parks = true, private readonly approvers = true, private readonly approvals: Approvals = "ask") {}

  /** A tool's permission now (permissionOf): the revision's own over the server's setting, read at each call, so a change
   *  reaches a live run at its next call; under approvals "never", an ask is an allow. */
  readonly policy = (tool: string): Permission => this.setting(tool).permission;
  /** Where the permission `policy` gives `tool` was set: the agent's own tool settings, the server's, or the default; or
   *  "unattended", an ask the agent's approvals allowed. */
  readonly denyFrom = (tool: string): SettingFrom => this.setting(tool).from;
  private setting(tool: string): { permission: Permission; from: SettingFrom } {
    // A tool the desktop and the phone both have (the hand-over): the gate knows not the run's kind, so it is held to the
    // stricter of both keys' settings, never more permissive than the run's own kind's.
    const shared = KIND_TOOLS.get(tool.replace(/^mcp__hands__/, ""));
    if (shared && shared.length > 1) {
      return shared.map((key) => this.settingOf(tool, key)).reduce((strictest, one) => (STRICTNESS[one.permission] > STRICTNESS[strictest.permission] ? one : strictest));
    }
    return this.settingOf(tool, settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, tool, this.where.mcpServers));
  }

  /** `tool`'s permission under its settings key `key`, and where it was set. */
  private settingOf(tool: string, key: string | undefined): { permission: Permission; from: SettingFrom } {
    // A name nothing maps fails closed: it asks (refused where no one can approve), never allows, under approvals "never"
    // too: no setting of it was read, so none says it may run.
    if (key === undefined) return { permission: "ask", from: "default" };
    const server = this.serverSettings();
    // No settings ever read: every tool asks, the shell watchers too (fail closed: an ask nothing read is never lifted),
    // or keeps the revision's own deny. Approvals "never" lifts none of these asks: the server's settings may hold a deny
    // no read has seen.
    if (server === undefined) {
      const own = permissionFrom(key, {}, this.overrides);
      return own.permission === "deny" ? own : { permission: "ask", from: "default" };
    }
    // A shell tool under every harness's name for it is read as its own name, by bash's key (permissionFrom): a watcher's
    // ask is allow only where bash's ask is set as written.
    return permissionFrom(shellToolOf(tool) ?? key, server, this.overrides, this.approvals);
  }

  /** Why a pin refuses the call of `key` with `args` now (pinRefusal): the revision's own pins and the server's, read at
   *  each call as its permission is, so a pin set or changed reaches a live run at its next call. */
  private pinned(key: string, args: unknown, ran: "no" | "unknown" = "no"): { text: string; mismatched: string[] } | undefined {
    return pinRefusal(key, args, this.serverSettings() ?? {}, this.overrides, ran);
  }

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
    const key = settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, name, this.where.mcpServers) ?? name;
    const tool = shellToolOf(name) ?? key;
    // The end-of-run turn writes no file under work/.learning/, whatever the tool's permission: its notes are kept only
    // from its answer (NOTE_ONLY_TEXT). Any other turn's write there follows its permission, as anywhere.
    if ((key === "write" || key === "edit") && this.turnOrigin() === "reflect" && underLearning(this.where.work, args)) return { text: NOTE_ONLY_TEXT, isError: true };
    // Every refusal that does not come from the permission (the reflect turn's above, the deny and a pin's below) stays
    // ABOVE the allow's return further down. An allow here may be an ask the agent's approvals "never" turned into one
    // (permissionFrom's last step), and an allowed call runs at once: nothing after that return refuses it.
    const verdict = this.policy(name);
    const ran = options.replayed ? "unknown" : "no";
    if (verdict === "deny") return { text: deniedText(tool, key, this.denyFrom(name), ran), isError: true };
    // A pinned MCP tool's call whose arguments are not the pinned ones: refused before it runs or asks anyone, so an
    // allowed or approved call goes only where its settings fix.
    const pinned = this.pinned(key, args, ran);
    if (pinned) {
      process.stderr.write(`agentrun-serve: the tool gate refused ${key} call ${callId}: ${pinned.mismatched.length ? `${pinned.mismatched.join(", ")} not as pinned` : "its pin does not read"}\n`);
      return { text: pinned.text, isError: true };
    }
    if (verdict === "allow") return undefined;
    // No one can answer here: refused at once with why, never parked until a cancel.
    if (!this.approvers) return { text: noApproverText(tool, ran), isError: true };
    if (!this.parks) return { text: `This ${tool} call needs a person's approval, which a workflow's model node cannot wait for; it was not run.`, isError: true };
    // Named by the call, so a call run again after a crash parks as the same request.
    const id = `ap_${createHash("sha256").update(JSON.stringify([callId, tool, args ?? null])).digest("hex").slice(0, 16)}`;
    const other = [...this.requests.values()].find((held) => !held.resolved && held.id !== id);
    if (other) return { text: `This ${tool} call was not run: the ${other.tool} call ${other.call_id} already waits for a person's approval. Call it again once that one is answered.`, isError: true };
    if (!this.requests.has(id)) {
      const turn = park.turn?.();
      const request: ApprovalRequest = { id, tool, call_id: callId, args: args ?? null, args_preview: argsPreview(args), requested_at: new Date().toISOString(), ...(turn !== undefined ? { turn } : {}), ...(options.price !== undefined ? { price: options.price } : {}), ...(options.replayed ? { replayed: true as const } : {}) };
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
    // Every tool is wrapped, an mcp__ name too, except a registration marked GATED_BY_GATEWAY: the MCP gateway marks the
    // ones whose calls it takes to this gate itself (gate.enter in its call), so such a call passes one gate, once. Nothing
    // is skipped by its name: an unmarked mcp__ tool is gated here as any tool is.
    const named = [...new Map(tools.filter((tool) => (tool as GatewayMarked)[GATED_BY_GATEWAY] !== true).map((tool) => [tool.name, tool])).values()];
    return defineExtension({ name: "tool-gate", wraps: named.map((tool) => wrapTool(tool, (inner) => this.wrap(inner))) });
  }

  private wrap(tool: ToolRegistration): ToolRegistration {
    const gate = this;
    const billed = tool.replay === "safe" && BILLED_REPLAYS.has(settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, tool.name, this.where.mcpServers) ?? "");
    return {
      ...tool,
      async execute(args, api, context) {
        const commit = (change: unknown) => api.commit(change as never, context) as never;
        // A rerun of a replay-safe call the gate let through before (pi-durable reruns it with the same call id after a
        // crash, with no sign of it): an earlier attempt may have been sent, which the gate's refusal must not deny. The
        // marks were read before the run resumed (prime), so a rerun the resume dispatches finds them.
        const answer = await gate.enter(tool.name, args, api.callId, { commit }, gate.passed.has(api.callId) ? { replayed: true } : {});
        // A parked call ends the turn, as ask_person's does.
        if (answer) return forModel(answer.text, answer.parked ? { control: { terminate: true } } : { isError: true });
        // Let through: a call that can bill is marked in the store before the tool runs, so a crash after it leaves a
        // rerun the gate knows for one. A mark that fails to commit stops the call (nothing has been sent).
        if (billed && !gate.passed.has(api.callId)) {
          await commit((tx: Tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: GATE_PASSED_ENTRY, data: { callId: api.callId } }));
          gate.passed.add(api.callId);
        }
        // pi-durable committed the call's intent before it reached execute: durable before the call is sent, so a lost
        // box never sends it twice (a resumed call with its intent is reported interrupted, not run again).
        if (tool.replay !== "safe" || billed) await syncNow(gate.syncTarget, BARRIER.piToolIntent);
        return tool.execute(args, api, context);
      },
    } as ToolRegistration;
  }

  /** Takes the open run, as the run's process opens (its app's onOpen), reading what its store holds of the gate unless
   *  `prime` read it before the resume. `coding`: the run's coding source (coding-tools.ts), on which an approved coding
   *  call runs, as the run's own would; `extra`, the run's own tools beyond the table (its learned_workflow), on which an
   *  approved call of one runs. */
  async load(durable: DurableRun, context: Context, coding?: readonly ToolRegistration[], extra: readonly ToolRegistration[] = []): Promise<void> {
    this.durable = durable;
    this.syncTarget = durable.store;
    this.context = context;
    this.coding = coding;
    this.extra = extra;
    if (!this.primed) await this.prime(durable.harness, context);
  }

  private primed = false;
  /** Reads what the run's store holds of the gate (the calls that wait, the answers acted on, the calls it let through)
   *  before the run resumes: its app's beforeResume hook, ahead of harness.resume(), which dispatches the calls a crash
   *  cut. Read here, not in onOpen, which a recovered call races. A workflow's run calls only this; load reads nothing more. */
  async prime(harness: Pick<Harness, "conversation">, context: Context, syncTarget?: SyncTarget): Promise<void> {
    if (syncTarget) this.syncTarget = syncTarget;
    const root = await harness.conversation(ROOT_CONVERSATION_ID, context);
    for (let cursor: Cursor | undefined; root; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) this.note(entry as { kind: string; data?: unknown });
      if (page.next === undefined) break;
      cursor = page.next;
    }
    this.primed = true;
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
  start(resume?: Resume, unpark?: () => void): void {
    this.resume = resume ?? this.submit;
    this.unpark = unpark;
    this.watch();
  }

  private note(entry: { kind: string; data?: unknown }): void {
    if (entry.kind === GATE_PASSED_ENTRY) {
      const callId = (entry.data as { callId?: unknown } | undefined)?.callId;
      if (typeof callId === "string") this.passed.add(callId);
      return;
    }
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
  private readonly submit: Resume = async (id, content, mark, origin) => {
    const root = await this.durable!.harness.root(this.context!);
    const requestId = `approval-${id}`;
    // pi writes its user entry with no data, so the resume's origin goes first as an entry of its own, which the Timeline
    // matches to it by its text (pi-durable-disk's serve does the same). Once only: a resume tried again whose input is
    // in already writes no second marker, which would be left open for a later message with the same text.
    if (origin && (await root.commit((tx) => tx.submissionByRequest(root.id, requestId), this.context!)) === undefined)
      await root.submit({ type: "write", requestId: `origin of ${requestId}`, entry: { kind: MESSAGE_ORIGIN_KIND, data: { origin, text: content } } }, this.context!);
    await root.submit({ type: "input", requestId, content, whenBusy: "followUp" }, this.context!);
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
      const answers = (await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string; note?: string; args_shown?: string; by?: string }> | undefined;
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
        // A request parked on a replay may follow an attempt that was sent: its refusal makes no "nothing was charged" claim.
        if (decision === "allow") this.unpark?.();
        // And a pin holds for an approved call too: one whose arguments are no longer as pinned (a pin set since it asked)
        // is refused as a deny since is.
        const result = decision === "deny" ? { text: refusedText(held.tool, answer.note, held.replayed ? "unknown" : "no"), isError: true } : this.policy(held.tool) === "deny" || this.pinned(held.tool, held.args) ? await this.ranOrDenied(held) : await this.run(held);
        // A test's seam, unset in a server (AGENTRUN_SERVE_TEST_CRASH_AFTER_CALL, a file that marks it once): an approved
        // call that ran and whose outcome is in the journal, then the process goes before its resume, once the test says go
        // (<file>.go), as a crash between the two would leave the run.
        const seam = process.env.AGENTRUN_SERVE_TEST_CRASH_AFTER_CALL;
        if (seam && decision === "allow" && !existsSync(seam)) {
          while (!existsSync(`${seam}.go`)) await new Promise((done) => setTimeout(done, 50));
          writeFileSync(seam, "");
          process.kill(process.pid, "SIGKILL");
        }
        // And again once the call is done: a stop or a cancel while it ran drops its result, which never reaches the model.
        const after = ((await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string }> | undefined)?.[held.id];
        if (after?.decision === "canceled" || after?.decision === "withdrawn") {
          await this.resolveSilently(held, after.decision);
          continue;
        }
        // The arguments the message names are the server's redacted ones: the gate never writes a held value there. The
        // result is cut as every host tool's is (boundResult, HOST_RESULT_MAX_CHARS, in its words): an executor's (an
        // MCP call's) comes uncut, and its journal keeps it whole.
        // The server's message, never the person's: a declining message's words are theirs, beside it.
        const origin: ResumeOrigin = decision === "deny" && answer.by === "message" && answer.note?.trim() ? { kind: "server", reason: "approval_declined", said: answer.note } : { kind: "server", reason: "approval" };
        await this.resume!(held.id, resumeText(held, answer.args_shown ?? "(not shown)", decision, { ...result, text: boundResult(result.text).text }), (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "resolved", id: held.id, decision } }), origin);
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

  /** The run's own `approvals:` session, the journal every approved call runs through: opened once. */
  private journal(): Promise<Drive> {
    this.drive ??= durableSessions(this.durable!.harness, this.context!, this.durable!.store)
      .open(`approvals:${this.where.runId}`)
      .then((writer) => openDrive({ writer, signal: this.stop.signal }))
      .catch((error: unknown) => {
        this.drive = undefined;
        throw error;
      });
    return this.drive;
  }

  /** An approved call whose tool was set to deny (or pinned so that its arguments no longer hold) before the gate acted
   *  on the answer. A call whose outcome is in the
   *  journal RAN (a crash came between it and its resume): the model gets that outcome, as any allowed call's, and nothing
   *  runs again; a later deny can't un-run it. One with an intent and no outcome may have been sent: denied, with no claim
   *  either way. One the journal never saw is denied, not run and not charged. */
  private async ranOrDenied(held: ApprovalRequest): Promise<ToolAnswer> {
    const drive = await this.journal();
    const key = `approval:${held.id}`;
    if (drive.isMemoized(key)) return this.run(held);
    const heldTo = settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, held.tool, this.where.mcpServers);
    const ran = held.replayed || drive.state().effects.has(key) ? "unknown" : "no";
    if (this.policy(held.tool) !== "deny") {
      const pinned = this.pinned(held.tool, held.args, ran);
      if (pinned) return { text: pinned.text, isError: true };
    }
    return { text: deniedText(held.tool, heldTo, this.denyFrom(held.tool), ran), isError: true };
  }

  /** The approved call, run once by the kernel through the journal any host tool's call goes through, as an effect of
   *  the run's own `approvals:` session, on the run's coding source: its intent is durable before it runs, its outcome
   *  after; a replay-safe call a crash cut off runs again, any other is answered interrupted and never runs again. */
  private async run(held: ApprovalRequest): Promise<ToolAnswer> {
    const runner = await this.runnerOf(held);
    if ("refused" in runner) return { text: runner.refused, isError: true };
    const drive = this.journal();
    try {
      // Its own abort beside the drive's: a stop or a cancel of the run cuts this call, which runs outside any turn.
      const cut = new AbortController();
      this.inFlight = { id: held.id, cut };
      try {
        return await (await drive).effect(`approval:${held.id}`, { name: held.tool, replay: runner.replay, input: held.args }, async ({ signal }) => {
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
