// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). The runner's loops ask it before each call's intent (RunGate.decide): pi's tools, the kernel's
// host tools on claude-agent, codex and OpenCode, and the MCP gateway's calls alike.
//
// An MCP tool's setting may also carry a pin (pinRefusal): top-level arguments its calls must carry, each a JSON scalar
// or one of a list. A pin adds to a setting and is never a permission: the gate checks it after a deny and before an
// allow or an ask, so an allowed call not as pinned is refused unsent, and one under ask is refused before anyone is
// asked; an approved call is checked again before it runs. The agent's pin and the server's both hold.
//
// An ask has one way to wait, every tool's alike (the owner's ruling of 11-04): it PARKS. The runner's loop answers the
// call with waitingText and ends the turn, as ask_person's does; the run goes needs_input with the pending approval. On
// an answer the loop runs the approved call once, through the journal, and resumes the session with a message naming the
// call (resumeText). One call waits at a time: another asked meanwhile is refused.
//
// The answer: POST /v2/runs/{id}/approvals/{approval_id} { decision: "allow" | "deny", note? } -> 204. The first answer
// wins; the same answer again is 204, a conflicting one 409. Only the owner's password session answers (server.ts), never
// a token. A cancel marks pending approvals canceled. Where no one can approve (accounts off), an ask is refused at once
// in words, never parked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_TOOL_DEFS, PHONE_TOOL_DEFS } from "@parcha/agentrun-kernel/kernel";
import { READ_SKILL_FILE } from "@parcha/agentrun-kernel";
import { LEARNED_DIR } from "./learning.js";
import type { TurnOrigin } from "./learning-run.js";
import { COMPUTER_ROOT, portPath } from "./workspace/paths.js";
import type { Workspace } from "./workspace/workspace.js";
import { builtinHarness } from "./harness-table.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { SHELL_TOOLS } from "./background.js";
import { SERVE_OWN_TOOLS, TABLE_TOOLS, type ToolSettingsRead } from "./tool-plane.js";
import { deniedText, NOT_RUN, RAN_UNKNOWN, type SettingFrom } from "./refusal-words.js";
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
export const shellToolOf = (name: string): string | undefined => {
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
 *  catalog name; the browser's registrations are `browser`; an adapter's read_skill_file is `read` (but an agent's MCP tool of that name is its own). OpenCode's `<server>_<tool>` maps only for a server of
 *  `mcpServers` (the run's configured MCP servers), never by its shape, since a host tool's name has the same shape.
 *  Undefined: nothing maps it, and the gate asks. The key only: the runner's adapter loop asks the gate once per call,
 *  before its intent (RunGate.decide). */
export function settingsKeyOf(harness: string, name: string, mcpServers: readonly string[] = []): string | undefined {
  // A tool that runs a command in the box (bash_background and the rest) is held to bash's key: before the table's own names.
  if (Object.hasOwn(SHELL_FAMILY, name)) return SHELL_FAMILY[name];
  if (TABLE_TOOLS.includes(name) || SERVE_OWN_TOOLS.includes(name) || isCatalogTool(name)) return name;
  // An adapter's own read of a skill's file (codex's and OpenCode's read_skill_file, from the session's copy of the run's
  // skills) is a read: held to read's key, so a server's read deny refuses it and the default allows it, on every harness.
  // Unless the name is an agent's MCP tool on this harness (OpenCode's <server>_<tool>: a configured server `read` with a
  // tool `skill_file`): that tool keeps its own key, so read's setting never stands in for it.
  if (name === READ_SKILL_FILE) {
    const alias = builtinHarness(harness)?.facts?.toolAlias?.exec(name) ?? null;
    return alias && mcpServers.includes(alias[1]!) ? mcpToolName(alias[1]!, alias[2]!) : "read";
  }
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
export type PermissionSettings = Readonly<Record<string, { permission?: Permission; /** Not as written: a value not offered, read as its fail-closed stand-in (tool-plane.ts checkToolSettings). Never shown. */ fallback?: true; pin?: Pin; /** A pin in the server's settings that does not read (tool-plane.ts checkToolSettings): every call of the tool is refused. Never shown. */ brokenPin?: true } | undefined>>;

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

/** `name`'s permission in force and the layer it came from. A deny set on this server, under the tool's own key or its MCP
 *  server's wildcard (bash's for a shell tool), is absolute: it refuses on this server over any setting of the agent's.
 *  Otherwise most specific first: the agent's exact key, the agent's server wildcard, the server's exact key, the
 *  server's server wildcard, then the default. A call's arguments are held only by a pin (pinRefusal), which adds to a
 *  setting and is never a permission. `approvals` "never" (an agent run unattended) turns the ask that is left into an allow, from
 *  "unattended", as the last step, and only where nothing stands behind that ask (standsBehind): never past a deny in any
 *  layer, nor an ask that stands in for a setting that does not read. Nor is anything RunGate.enter refuses before it
 *  decides between running and parking ever lifted (a template's pin, among them). Without never, the answer is as it
 *  always was. */
export function permissionFrom(name: string, server: PermissionSettings, agent: PermissionSettings = {}, approvals: Approvals = "ask"): { permission: Permission; from: SettingFrom } {
  const { permission, from } = settingOf(name, server, agent);
  if (approvals !== "never" || permission !== "ask" || standsBehind(name, server, agent)) return { permission, from };
  return { permission: "allow", from: "unattended" };
}

/** Marks the server's settings map when its stored value does not read (tool-plane.ts loadToolSettings): every
 *  tool then takes its defaults, and a deny it may hold can't be seen, so nothing lifts an ask over it. A symbol:
 *  carried by a spread, never by JSON (it is never served) nor by Object.entries (no reader takes it for a tool). */
export const SETTINGS_UNREAD: unique symbol = Symbol("agentrun.tool-settings.unread");

/** `settings` marked unread (SETTINGS_UNREAD), a copy: what a gate holds to while its settings' read fails, its last good
 *  read's denies and pins still refusing and no ask lifted. */
const unreadOf = (settings: PermissionSettings): PermissionSettings => Object.assign({ ...settings }, { [SETTINGS_UNREAD]: true as const });

/** Whether something stands behind `name`'s ask that approvals "never" must not lift: the server's settings unread
 *  (SETTINGS_UNREAD: a deny may be in the file), or in either layer, under any key the tool is read by (its own, its MCP
 *  server's wildcard; a shell tool's, bash's), a deny, a value that is no permission, or a setting marked as not read as
 *  written (`fallback`). The ask a layer above gives does not hide a deny below it. */
function standsBehind(name: string, server: PermissionSettings, agent: PermissionSettings): boolean {
  if ((server as { readonly [SETTINGS_UNREAD]?: true })[SETTINGS_UNREAD] === true) return true;
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
 *  a stand-in. A value that is no permission at all reads ask, never the value. A deny set on this server is absolute:
 *  where the server's own answer for the tool (its most specific key set there: the tool's own, else its MCP server's
 *  wildcard) is deny, that is the answer, from the server, before the agent's own settings are read, so no ask or allow
 *  of the agent's reaches past it. The server's own exact allow under its wildcard deny is its answer, as before.
 *  Otherwise the agent's own setting comes first, then the server's, then the default. */
function settingFrom(name: string, server: PermissionSettings, agent: PermissionSettings): { permission: Permission; from: "agent" | "server" | "default"; written: boolean } {
  const own = permissionKeys(name).map((key) => server[key]).find((setting) => setting?.permission !== undefined);
  if (own?.permission === "deny") return { permission: "deny", from: "server", written: own.fallback !== true };
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



// The refusal words (SettingFrom, DenyFrom, NOT_RUN, RAN_UNKNOWN, denyPlace, deniedText, refusedText) live in
// refusal-words.ts, shared with the runner's loops.
export { type DenyFrom, deniedText, denyPlace, NOT_RUN, RAN_UNKNOWN, refusedText, type SettingFrom } from "./refusal-words.js";
/** The refusal of an ask where no one can approve it: a server with accounts off, whose answer route takes no token. */
export const noApproverText = (tool: string, ran: "no" | "unknown" = "no"): string => `Permission denied: ${tool} needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools. ${ran === "no" ? NOT_RUN : RAN_UNKNOWN}`;
/** A parked call's answer: the run pauses here. */
export const waitingText = (tool: string): string => `This ${tool} call waits for a person's approval; the run pauses here and continues with the result when they answer.`;

/** The Timeline row of a call that waits for an approval. */
export const APPROVAL_ROW = "tool_approval_requested" as const;
/** A call's arguments shown on its approval, at most this many bytes. */
export const ARGS_PREVIEW_BYTES = 2048;



/** The file in a run's directory that names the origin of the turn it runs now: written by the server alone, as it sends
 *  the learning lane's reflect turn (runs.ts's toLiveDoor), and gone before a person's turn is sent (runs.ts's personsTurn).
 *  The gate refuses that turn's writes under work/.learning/ (NOTE_ONLY_TEXT). */
export const TURN_ORIGIN_FILE = "turn-origin.json";
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

/** The gate of the run `runId` whose folder is `where`, on its pinned revision. `serverSettings`: the server's tool
 *  settings as the runner read them from the one store at the claim (tool-plane.ts loadToolSettings), read at each call as
 *  the gate reads them. `approvers`: whether anyone can answer an ask here, the store's (server-approvers.ts, read at each
 *  claim). `files`: where the run's own files are read (RunFiles), the run's folder when absent. */
export function runGate(where: { root: string; work: string }, runId: string, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } }, serverSettings: () => ToolSettingsRead, files: RunFiles | undefined, approvers: boolean): RunGate {
  return new RunGate({ root: where.root, work: where.work, runId, harness: revision.body.harness ?? DEFAULT_HARNESS }, serverSettings, (revision.body.toolSettings ?? {}) as PermissionSettings, approvers, approvalsOf(revision.body.approvals), files);
}

/** Where a gate reads the run's own files (the turn's origin): the run's Workspace (Mode 2: its folder on the run's disk,
 *  read by path in the folder, never a folder of this machine), or the local folder's path. */
export type RunFiles = Pick<Workspace, "read"> | string;

/** A run's tool gate on the runner: its policy and the turn's origin, asked before each call's intent (decide). */
export class RunGate {

  /** `readServerSettings`: the server's tool settings, read at each call; `overrides`: the pinned revision's own;
   *  `approvers`: whether anyone can answer an ask here (the owner's password session: accounts on); `approvals`: the
   *  pinned revision's (definition.approvals): "never" runs the agent unattended, an ask allowed (permissionFrom);
   *  `files`: where the run's own files are read (RunFiles), the run's folder `where.root` when absent. */
  constructor(private readonly where: { root: string; work: string; runId: string; harness?: string; mcpServers?: readonly string[] }, private readonly readServerSettings: () => ToolSettingsRead, private readonly overrides: PermissionSettings = {}, private readonly approvers = true, private readonly approvals: Approvals = "ask", private readonly files: RunFiles = where.root) {}

  /** A tool's permission now (permissionOf): the revision's own over the server's setting, read at each call, so a change
   *  reaches a live run at its next call; under approvals "never", an ask is an allow. */
  readonly policy = (tool: string): Permission => this.setting(tool).permission;

  /** The gate's answer for one call before its intent, for a loop that parks and answers asks itself (the runner's adapter
   *  loops, pi's and the CLI harnesses'): run it, ask a person, or refuse it with the words the model reads. `enter`'s
   *  order: the end-of-run turn's write under .learning/ (learningRefusal), the deny (with where it was set, and that
   *  nothing was sent or charged), a pin, then the allow, then the ask, so an allow that approvals "never" made is decided
   *  only after every refusal. Where no one can approve (accounts off: the store's approvers row a runner reads at each
   *  claim, server-approvers.ts), the ask is refused at once in words, never parked, as `enter` refuses it. */
  async decide(name: string, args: unknown): Promise<"allow" | "ask" | { deny: string }> {
    const key = settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, name, this.where.mcpServers) ?? name;
    const tool = this.askedAs(name);
    const learning = await this.learningRefusal(key, args);
    if (learning) return { deny: learning };
    const verdict = this.policy(name);
    if (verdict === "deny") return { deny: deniedText(tool, key, this.denyFrom(name), "no") };
    const pinned = this.pinned(key, args, "no");
    if (pinned) return { deny: pinned.text };
    if (verdict === "allow") return "allow";
    return this.approvers ? "ask" : { deny: noApproverText(tool, "no") };
  }

  /** The name a call is asked about by, as main's request names it (enter's `tool`): its settings key, a shell tool its
   *  own name; a name nothing maps, as it came. */
  askedAs(name: string): string {
    return shellToolOf(name) ?? settingsKeyOf(this.where.harness ?? DEFAULT_HARNESS, name, this.where.mcpServers) ?? name;
  }
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
  /** The server's settings now: read at each call, so a change reaches a live run; settings that do not read keep the
   *  last good, marked unread (SETTINGS_UNREAD): its denies and pins still refuse, and approvals "never" lifts no ask
   *  while the read fails, as a deny may be in what did not read (undefined: none read yet, every tool asks). Each problem
   *  is said once, by file and field, never a value. */
  private serverSettings(): PermissionSettings | undefined {
    const read = this.readServerSettings();
    for (const line of read.problems) {
      if (this.told.has(line)) continue;
      this.told.add(line);
      process.stderr.write(`agentrun-serve: the tool gate: ${line}\n`);
    }
    if (read.unreadable) return this.lastGood === undefined ? undefined : unreadOf(this.lastGood);
    this.lastGood = read.settings as PermissionSettings;
    return this.lastGood;
  }

  /** The origin of the turn running now: what the server's internal path wrote for it (TURN_ORIGIN_FILE in the run's
   *  folder, read through `files`: the run's Workspace or the local folder's path); none for a person's turn, or a file
   *  that is not there or does not read. */
  async turnOrigin(): Promise<TurnOrigin | undefined> {
    try {
      const text = typeof this.files === "string" ? readFileSync(join(this.files, TURN_ORIGIN_FILE), "utf8") : new TextDecoder().decode(await this.files.read(TURN_ORIGIN_FILE));
      return (JSON.parse(text) as { origin?: unknown })?.origin === "reflect" ? "reflect" : undefined;
    } catch {
      return undefined;
    }
  }

  /** The end-of-run turn's refusal of a write or edit under work/.learning/ (NOTE_ONLY_TEXT, the adapter loop's one text
   *  too), whatever the tool's permission: its notes are kept only from its answer. Undefined for any other call or turn,
   *  whose write there follows its permission, as anywhere. The first check of `enter` and `decide`. */
  private async learningRefusal(key: string, args: unknown): Promise<string | undefined> {
    if (key !== "write" && key !== "edit") return undefined;
    // The folder's path a file tool resolves against: the local folder's, or a computer's name for it (the Workspace's paths
    // are in the run's folder, so a path there is relative or under COMPUTER_ROOT).
    const work = typeof this.files === "string" ? this.where.work : COMPUTER_ROOT;
    return underLearning(work, args) && (await this.turnOrigin()) === "reflect" ? NOTE_ONLY_TEXT : undefined;
  }

}
