// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). The runner's loops ask it before each call's intent (RunGate.decide): pi's tools, the kernel's
// host tools on claude-agent, codex and OpenCode, and the MCP gateway's calls alike.
//
// An MCP tool's setting may also carry a pin (pinRefusal): top-level arguments its calls must carry, each a JSON scalar
// or one of a list, or an object argument's keys (`{keys: [...]}`: given, it holds those keys alone, any values). A
// pinned tool takes only the arguments its listing in the run's pin declares, beside its pinned ones, so no alias the
// server takes for a pinned argument goes around it.
// A pin adds to a setting and is never a permission: the gate checks it after a deny and before an
// allow or an ask, so an allowed call not as pinned is refused unsent, and one under ask is refused before anyone is
// asked; an approved call is checked again before it runs. The agent's pin and the server's both hold.
//
// bash's setting in an agent's own tool settings may carry a policy the same way (policyRefusal): `policy: "read-only"`
// (bash-read-only.ts) reads each shell call's command and refuses one that could write, run code or read outside the
// run's folder, after a deny and a pin and before an allow or an ask, so approvals "never" lifts none of it; an approved
// call is decided again before it runs.
//
// An ask has one way to wait, every tool's alike (the owner's ruling of 11-04): it PARKS. The runner's loop holds the
// call and the run goes needs_input with the pending approval. On an answer the loop runs the approved call once, through
// the journal, and the session goes on with its result. One call waits at a time: another asked meanwhile is refused.
//
// The answer: POST /v2/runs/{id}/approvals/{approval_id} { decision: "allow" | "deny", note? } -> 204. The first answer
// wins; the same answer again is 204, a conflicting one 409. Only the owner's password session answers (server.ts), never
// a token. A cancel marks pending approvals canceled. Where no one can approve (accounts off), an ask is refused at once
// in words, never parked.

import { COMPUTER_OP_TOOL, computerToolDefs, defaultPermissionOf, SHELL_FAMILY, SHELL_WATCHERS, shellPermission, shellToolOf } from "@parcha/agentrun-kernel/kernel";
import { READ_SKILL_FILE } from "@parcha/agentrun-kernel";
import { LEARNED_DIR } from "./learning.js";
import { COMPUTER_ROOT, portPath } from "./workspace/paths.js";
import type { Workspace } from "./workspace/workspace.js";
import { builtinHarness } from "./harness-table.js";
import { META_TOOLS } from "./meta-tool-names.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { DECISION_PROVIDER_KEYS, KIND_KEYS, SERVE_OWN_TOOLS, type ToolSettingsRead } from "./tool-plane.js";
import { isTableTool, isToolRow, tableTools } from "./tool-list.js";
import { deniedText, NOT_RUN, RAN_UNKNOWN, type SettingFrom } from "./refusal-words.js";
import { type Approvals, approvalsOf } from "./approvals.js";
import { settingOfDefinition } from "./computer-setting.js";
import { BASH_POLICIES, readOnlyReason, readOnlyText } from "./bash-read-only.js";
import { formatToolName, isCatalogName, mcpNameOf, mcpToolName, monidNameOf } from "./tool-names.js";

/** What the gate does with a tool's calls. */
export const PERMISSIONS = ["allow", "ask", "deny"] as const;
export type Permission = (typeof PERMISSIONS)[number];

// An MCP tool's gate name is its catalog name, `mcp:<server>/<tool>` (tool-names.ts).
export { mcpToolName };
/** Where a run's shell is, as its default permissions read it: `computer` false for a run with no computer (its bash, where
 *  it has one, runs on the run's folder's own exec: Archil's in Mode 2); undefined where no run is in view (the server's
 *  settings page, capabilities), which reads the computer's defaults. */
export type ShellWhere = { readonly computer?: boolean };

const isBuiltin = (name: string): boolean => isToolRow(name) || SERVE_OWN_TOOLS.includes(name) || KIND_KEYS.includes(name) || DECISION_PROVIDER_KEYS.includes(name);

/** The owner's defaults: a built-in of this server (a row of the tool list, its own tools, a computer kind's key, a
 *  decision provider's) allows; anything else asks, so a new source never defaults to allow. On a run with no computer,
 *  the kernel's ruled rule (defaultPermissionOf): bash asks first, and the background tools, which need a computer, are
 *  refused. */
export const defaultPermission = (name: string, where: ShellWhere = {}): Permission => {
  if (isCatalogName(name) || !isBuiltin(name)) return "ask";
  return where.computer === false ? defaultPermissionOf(name, { computer: false }) : "allow";
};

// The shell family (bash and the background tools, each held to bash's setting; its watchers run unasked under bash: ask)
// is the kernel registry's, read here.
export { SHELL_FAMILY, SHELL_WATCHERS, shellToolOf };

/** The settings keys that may set `name`'s permission, most specific first: the tool's own name, then, for an MCP
 *  tool, its server's wildcard `mcp:<server>/*`, and for a monid endpoint, its provider's `monid:<provider>/*`. */
export function permissionKeys(name: string): string[] {
  const mcp = mcpNameOf(name);
  if (mcp) return [name, formatToolName({ kind: "mcp-server", server: mcp.server })];
  const monid = monidNameOf(name);
  return monid ? [name, formatToolName({ kind: "monid-provider", provider: monid.provider })] : [name];
}

/** The browser's registrations on pi (pi-browser's BROWSER_TOOL_NAMES, which a test holds this list to): each is a call
 *  of the table's `browser`. */
const BROWSER_REGISTRATIONS: readonly string[] = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"];
/** A computer kind's tools, by name, to the one settings key their kind is held to (`desktop`, `phone`): the kernel
 *  registry's own definitions say it (their settingsKey), so a tool a kind gains is held to its key with no line here. */
const KIND_TOOLS: ReadonlyMap<string, readonly string[]> = (() => {
  const keys = new Map<string, string[]>();
  for (const def of [...computerToolDefs("desktop", []), ...computerToolDefs("phone", [])]) keys.set(def.name, [...new Set([...(keys.get(def.name) ?? []), def.settingsKey])]);
  return keys;
})();
/** A script's computer op (computer_op's `op`) that runs on the computer what one of the run's own tools runs, held to
 *  that tool's setting: the shell is bash's, a program started to run on (processes.start) bash_background's (bash's
 *  setting, and a read-only bash policy refuses it), a file's write is write's, a file's read, listing or stat is
 *  read's. The other ops (apps, raw input) are the computer kind's, computer_op's own key (KIND_TOOLS). */
const OP_HELD_AS: Readonly<Record<string, string>> = Object.freeze({ "shell.run": "bash", "processes.start": "bash_background", "files.write": "write", "files.read": "read", "files.list": "read", "files.stat": "read" });
/** The ops whose command runs in the computer's shell. */
const SHELL_OPS: ReadonlySet<string> = new Set(["shell.run", "processes.start"]);

/** The tool a call of `name` with `args` is held to, with the arguments that tool's gate reads, where it is not its own:
 *  a computer_op whose op runs what one of the run's own tools runs (OP_HELD_AS), with its command and cwd, or its path.
 *  Undefined for any other call. */
export function heldAs(name: string, args: unknown): { readonly tool: string; readonly args: unknown } | undefined {
  if (name !== COMPUTER_OP_TOOL) return undefined;
  const { op, args: given } = (args ?? {}) as { op?: unknown; args?: unknown };
  const tool = typeof op === "string" && Object.hasOwn(OP_HELD_AS, op) ? OP_HELD_AS[op]! : undefined;
  if (tool === undefined) return undefined;
  const fields = (given !== null && typeof given === "object" ? given : {}) as Record<string, unknown>;
  return { tool, args: SHELL_OPS.has(op as string) ? { command: fields.command, ...(fields.cwd !== undefined ? { cwd: fields.cwd } : {}) } : { path: fields.path } };
}
const STRICTNESS: Readonly<Record<Permission, number>> = { allow: 0, ask: 1, deny: 2 };
/** A session's `{name -> settings key}` map (nameMapOf). */
export type NameMap = ReadonlyMap<string, string>;

/** Every name a session on `harness` gives its tools, to the settings key each is held to: the shell family (bash's),
 *  table, own and decision tools, read_skill_file (`read`), the kinds' tools (a shared one by its first kind), nativeTools,
 *  the browser's registrations. The names are the host's own: each adapter maps its CLI's names to them (its facts'
 *  hostName). The first named wins. */
export function nameMapOf(harness: string): NameMap {
  const facts = builtinHarness(harness)?.facts;
  const names = new Map<string, string>();
  const name = (own: string, key: string): void => void (names.has(own) || names.set(own, key));
  for (const [own, key] of Object.entries(SHELL_FAMILY)) name(own, key);
  for (const own of [...tableTools(), ...SERVE_OWN_TOOLS, ...DECISION_PROVIDER_KEYS]) name(own, own);
  name(READ_SKILL_FILE, "read");
  for (const [own, keys] of KIND_TOOLS) name(own, keys[0]!);
  for (const [own, key] of Object.entries(facts?.nativeTools ?? {})) if (key) name(own, key);
  for (const own of BROWSER_REGISTRATIONS) name(own, "browser");
  return names;
}

/** The settings key a call named `name` on `harness` is held to: a lookup in the session's names (`names`), then the open
 *  open family no list holds (a catalog name, `mcp:<server>/<tool>` or `monid:<provider>/<endpoint>`). Undefined: nothing
 *  maps it, and the gate asks (an MCP tool's or monid endpoint's wire name is read back by the loop, ClaimMcp.catalogOf,
 *  before the gate is asked). */
export function settingsKeyOf(harness: string, name: string, names: NameMap = nameMapOf(harness)): string | undefined {
  const own = names.get(name);
  if (own !== undefined) return own;
  return isCatalogName(name) ? name : undefined;
}

/** A pinned argument's scalar: `null` holds for a call that leaves the argument out (or gives null). */
export type PinScalar = string | number | boolean | null;
/** A pinned object argument's keys: the argument, when given (not left out, nor null), is an object whose keys are among
 *  these 1 to MAX_PIN_CHOICES names, its values free, so a write may change those fields and no other. */
export type PinKeys = { readonly keys: readonly string[] };
/** A pinned argument's value: one scalar the call must carry, a list of 1 to MAX_PIN_CHOICES ("one of"), or an object
 *  argument's keys (PinKeys), kept and said in its one form (canonicalChoices). */
export type PinValue = PinScalar | readonly PinScalar[] | PinKeys;
/** Whether a pin's value is a keys pin: the one form that is an object. */
export const isPinKeys = (value: unknown): value is PinKeys => typeof value === "object" && value !== null && !Array.isArray(value);
/** A setting's `pin`: an MCP tool's top-level arguments, by name, each fixed to one value, one of a list, or its keys. */
export type Pin = Readonly<Record<string, PinValue>>;
/** The most arguments one setting pins, and the most values a one-of list holds. */
export const MAX_PIN_ARGS = 8;
export const MAX_PIN_CHOICES = 16;

/** A layer of tool settings (the server's, PUT /v2/settings/tools, or an agent's own, definition.tool_settings) as the
 *  gate reads it: a permission by settings key, and an MCP tool's pin. */
export type PermissionSettings = Readonly<Record<string, { permission?: Permission; /** On an MCP server's wildcard in the server's settings: its read-only tools run with no approval (readsLift). */ allow_reads?: true; /** Not as written: a value not offered, read as its fail-closed stand-in (tool-plane.ts checkToolSettings). Never shown. */ fallback?: true; pin?: Pin; /** A pin in the server's settings that does not read (tool-plane.ts checkToolSettings): every call of the tool is refused. Never shown. */ brokenPin?: true; /** bash's policy, in an agent's own settings only (bash-read-only.ts): what its commands may do. */ policy?: string } | undefined>>;

/** A one-of list in its one form: each value once, null first, then by its JSON text; a keys pin's keys each once,
 *  sorted; a scalar as it is. The same meaning is the same text (a revision's id) and the same words (a refusal). */
export const canonicalChoices = (value: PinValue): PinValue => {
  if (isPinKeys(value)) return { keys: [...new Set(value.keys)].sort() };
  if (!Array.isArray(value)) return value;
  const texts = [...new Set(value.filter((one) => one !== null).map((one) => JSON.stringify(one)))].sort();
  return [...(value.includes(null) ? [null] : []), ...texts.map((text) => JSON.parse(text) as PinScalar)];
};
/** `pin` in its one form: its arguments sorted, each one-of list in its form (canonicalChoices). */
export const canonicalPin = (pin: Pin): Pin => Object.fromEntries(Object.keys(pin).sort().map((arg) => [arg, canonicalChoices(pin[arg]!)]));

/** Whether a call's argument `given` is the pinned scalar `one`: the same JSON scalar (strict equality), or, for null,
 *  left out or null. */
const isOne = (given: unknown, one: PinScalar): boolean => (one === null ? given === undefined || given === null : given === one);
/** Whether a call's argument `given` holds a keys pin's `keys`: left out, null, or an object (never a list) whose own keys
 *  are all among them. */
const keysHold = (given: unknown, keys: readonly string[]): boolean => given === undefined || given === null || (typeof given === "object" && !Array.isArray(given) && Object.keys(given).every((key) => keys.includes(key)));
/** Whether `given` holds pinned `value`: its scalar, one of its list, or its keys. */
const holds = (given: unknown, value: PinValue): boolean => (isPinKeys(value) ? keysHold(given, value.keys) : Array.isArray(value) ? value.some((one) => isOne(given, one)) : isOne(given, value as PinScalar));
/** A scalar in a refusal's words: text as it is, null as `absent`, any other as JSON. */
const scalarWords = (one: PinScalar): string => (one === null ? "absent" : typeof one === "string" ? one : JSON.stringify(one));
/** A pin in words, as the refusal says it, in its one form (canonicalPin): `channel_id = C0123`, `cc absent` for a null,
 *  `event in (absent | COMMENT)` for a list, `properties keys in (hs_lead_score)` for a keys pin. */
export const pinWords = (pin: Pin): string => Object.entries(canonicalPin(pin)).map(([arg, value]) => (isPinKeys(value) ? `${arg} keys in (${value.keys.join(" | ")})` : Array.isArray(value) ? `${arg} in (${value.map(scalarWords).join(" | ")})` : value === null ? `${arg} absent` : `${arg} = ${scalarWords(value as PinScalar)}`)).join(", ");
/** Names in words: `a`, `a and b`, `a, b and c`. */
const listWords = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** The arguments a call of `tool` carries that its listing does not declare, in words: "`to` is not an argument of X". */
const undeclaredWords = (args: readonly string[], tool: string): string => `${listWords(args.map((arg) => `\`${arg}\``))} ${args.length === 1 ? "is not an argument" : "are not arguments"} of ${tool}`;
/** What holds both of two layers' pins of one argument (`own`, the agent's, and `theirs`, the server's): a scalar where
 *  either is one and the other holds it, else the agent's list kept to the server's, in the agent's order; two keys pins,
 *  the agent's keys the server's has too; a keys pin and a scalar or list, what of the scalars the keys pin holds (null:
 *  left out). Undefined when nothing holds both, two keys pins with no key in both among them: no call writes a field
 *  each layer means. */
function bothOf(own: PinValue, theirs: PinValue): PinValue | undefined {
  const list = (value: PinValue): readonly PinScalar[] => (Array.isArray(value) ? value : [value as PinScalar]);
  if (isPinKeys(own) && isPinKeys(theirs)) {
    const kept = own.keys.filter((key) => theirs.keys.includes(key));
    return kept.length ? { keys: kept } : undefined;
  }
  if (isPinKeys(own) || isPinKeys(theirs)) {
    const [keys, other] = isPinKeys(own) ? [own, theirs] : [theirs as PinKeys, own];
    const kept = list(other).filter((one) => holds(one, keys));
    return !kept.length ? undefined : Array.isArray(other) ? kept : kept[0]!;
  }
  if (!Array.isArray(own)) return list(theirs).some((one) => one === own) ? own : undefined;
  if (!Array.isArray(theirs)) return own.some((one) => one === theirs) ? theirs : undefined;
  const kept = own.filter((one) => theirs.some((other) => other === one));
  return kept.length ? kept : undefined;
}

/** Why the call of MCP tool `name` with `args` is refused by a pin, or undefined when no pin refuses it. A pin is an
 *  addition to a setting, never a permission: each layer's pin on the tool's own key holds (the agent's and the
 *  server's both, whatever the permission), and a call must carry every pinned argument as pinned: its value, one of
 *  its list, or (a keys pin) an object of its keys alone, null or the argument left out. An argument both layers pin
 *  takes what holds both; where nothing does, every call is refused. `declared`: the top-level arguments the tool's
 *  listing in the run's pin declares (its inputSchema's `properties`): a pinned tool takes only those and its pinned
 *  ones, so an alias the server takes beside a pinned argument (`to` beside `recipient_email`) is refused, with no
 *  table of aliases; undefined (a listing with no `properties` object, or none known), no argument is closed. `ran`:
 *  whether an earlier attempt of the call may have been sent (deniedText's). `mismatched`: the arguments that do not
 *  hold, for the gate's log line. */
export function pinRefusal(name: string, args: unknown, server: PermissionSettings, agent: PermissionSettings = {}, ran: "no" | "unknown" = "no", declared?: ReadonlySet<string>): { text: string; mismatched: string[] } | undefined {
  if (!mcpNameOf(name)) return undefined;
  const what = ran === "no" ? NOT_RUN : RAN_UNKNOWN;
  if (server[name]?.brokenPin) return { text: `${name} can't be called: its pin in this server's tool settings does not read, so no call is let through until the owner sets it again (Settings → Tools). ${what}`, mismatched: [] };
  const own = agent[name]?.pin ?? {};
  const theirs = server[name]?.pin ?? {};
  // Both layers hold: an argument both pin takes what holds both (bothOf), and one where nothing does refuses every call.
  const clash = Object.keys(own).filter((arg) => Object.hasOwn(theirs, arg) && bothOf(own[arg]!, theirs[arg]!) === undefined);
  if (clash.length) return { text: `${name} can't be called: this agent's settings fix ${pinWords(Object.fromEntries(clash.map((arg) => [arg, own[arg]!])))} and this server's fix ${pinWords(Object.fromEntries(clash.map((arg) => [arg, theirs[arg]!])))}, so no call can satisfy both. ${what} Don't retry it: the owner makes the two agree.`, mismatched: clash };
  const pin: Pin = { ...theirs, ...Object.fromEntries(Object.entries(own).map(([arg, value]) => [arg, Object.hasOwn(theirs, arg) ? bothOf(value, theirs[arg]!)! : value])) };
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const undeclared = declared && Object.keys(pin).length ? Object.keys(given).filter((arg) => !declared.has(arg) && !Object.hasOwn(pin, arg)) : [];
  if (undeclared.length) return { text: `${undeclaredWords(undeclared, mcpNameOf(name)!.tool)}; a pinned tool takes only its listed arguments (${listWords(Object.keys(pin).sort())} ${Object.keys(pin).length === 1 ? "is" : "are"} pinned). ${what}`, mismatched: undeclared };
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
export function permissionFrom(name: string, server: PermissionSettings, agent: PermissionSettings = {}, approvals: Approvals = "ask", where: ShellWhere = {}, effect?: ToolEffect): { permission: Permission; from: SettingFrom } {
  const { permission, from } = settingOf(name, server, agent, where);
  if (permission === "ask" && effect === "read" && readsLift(name, server, agent, from)) return { permission: "allow", from: "server" };
  if (approvals !== "never" || permission !== "ask" || standsBehind(name, server, agent)) return { permission, from };
  return { permission: "allow", from: "unattended" };
}

/** What an MCP tool does, by its server's annotations (the MCP spec's hints, the server's word, never checked): "read"
 *  where readOnlyHint is true; else "destructive" only where destructiveHint is true; else "write". Not the spec's
 *  default (destructiveHint true when absent): under it every tool of a server that annotates nothing would read
 *  destructive and each approval of one would need the second confirm. A write still asks. */
export type ToolEffect = "read" | "write" | "destructive";
export function toolEffect(annotations: unknown): ToolEffect {
  const hints = typeof annotations === "object" && annotations !== null ? (annotations as { readOnlyHint?: unknown; destructiveHint?: unknown }) : {};
  if (hints.readOnlyHint === true) return "read";
  return hints.destructiveHint === true ? "destructive" : "write";
}

/** MCP tool `name`'s (`mcp:<server>/<tool>`) effect as a run's pin holds it (its annotations then, toolEffect): what the
 *  run's gate (ClaimMcp.effectOf) and a settings save's wake (settings-wake.ts) read, never a live listing. Undefined for a
 *  tool the pin does not hold. */
export function pinnedEffect(pin: Readonly<Record<string, { readonly tools: readonly { readonly name: string; readonly annotations?: unknown }[] }>>, name: string): ToolEffect | undefined {
  const parsed = mcpNameOf(name);
  const pinned = parsed && Object.hasOwn(pin, parsed.server) ? pin[parsed.server] : undefined;
  const tool = pinned?.tools.find((one) => one.name === parsed!.tool);
  return tool ? toolEffect(tool.annotations) : undefined;
}

/** Whether "allow reads" lifts the ask of MCP tool `name`, one its run's pin marks read-only (permissionFrom's `effect`):
 *  its server's wildcard in this server's settings carries `allow_reads`, the ask came from the server's settings or
 *  the default (an agent's own ask holds), the tool's own key sets no permission on this server (an explicit setting
 *  beats the rule), and nothing stands behind the ask (standsBehind: a deny in any layer, a value that does not read,
 *  settings unread). A pin's refusal is RunGate.decide's, after this, so the rule never lifts one. */
function readsLift(name: string, server: PermissionSettings, agent: PermissionSettings, from: SettingFrom): boolean {
  if (!mcpNameOf(name) || from === "agent") return false;
  const [own, wildcard] = permissionKeys(name);
  if (server[own!]?.permission !== undefined || server[wildcard!]?.allow_reads !== true) return false;
  return !standsBehind(name, server, agent);
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
function settingOf(name: string, server: PermissionSettings, agent: PermissionSettings, where: ShellWhere): { permission: Permission; from: SettingFrom } {
  // A shell tool's permission is bash's (SHELL_FAMILY), from bash's layer, wherever it is read: the gate, capabilities, an
  // agent's tools. A watcher (SHELL_WATCHERS) runs unasked only under an ask set as written in a layer: an ask that stands
  // in for anything else (a value not offered, nothing set) stays an ask. No key of its own is read, so none lifts bash's.
  if (Object.hasOwn(SHELL_FAMILY, name) && SHELL_FAMILY[name] !== name) {
    const bash = settingFrom(SHELL_FAMILY[name]!, server, agent, where);
    // Nothing set, on a run with no computer: the tool's own default (defaultPermissionOf: the background tools refused).
    if (bash.from === "default" && where.computer === false) return { permission: defaultPermission(name, where), from: "default" };
    return { permission: bash.written ? shellPermission(name, bash.permission) : bash.permission, from: bash.from };
  }
  const { permission, from } = settingFrom(name, server, agent, where);
  return { permission, from };
}

/** permissionFrom's own read, and whether the permission is `written`: a valid one set in a layer as it reads there, not
 *  a stand-in. A value that is no permission at all reads ask, never the value. A deny set on this server is absolute:
 *  where the server's own answer for the tool (its most specific key set there: the tool's own, else its MCP server's
 *  wildcard) is deny, that is the answer, from the server, before the agent's own settings are read, so no ask or allow
 *  of the agent's reaches past it. The server's own exact allow under its wildcard deny is its answer, as before.
 *  Otherwise the agent's own setting comes first, then the server's, then the default. */
function settingFrom(name: string, server: PermissionSettings, agent: PermissionSettings, where: ShellWhere = {}): { permission: Permission; from: "agent" | "server" | "default"; written: boolean } {
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
  return { permission: defaultPermission(name, where), from: "default", written: false };
}

/** `name`'s permission in force (permissionFrom): the one rule every path reads, the gate's, the tool plane's and a
 *  workflow's call nodes'. */
export const permissionOf = (name: string, server: PermissionSettings, agent: PermissionSettings = {}, approvals: Approvals = "ask", effect?: ToolEffect): Permission => permissionFrom(name, server, agent, approvals, {}, effect).permission;

/** An approval's price for the person who answers it: USD where the tool declares one (booked through the spend cap's
 *  paidCall), else "not metered" (an unpriced MCP call, the owner's ruling of 11-04), or "priced by usage" for a monid
 *  endpoint priced by usage: monid estimates its cost only when the call runs, after the person's allow, and its charge
 *  can pass that estimate (runner/monid-run.ts). */
export type ApprovalPrice = number | "not metered" | "priced by usage";

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
  /** Present, true, when the run's pin marks the tool destructive (toolEffect): an allow of it needs confirm_destructive. */
  destructive?: true;
};



// The refusal words (SettingFrom, DenyFrom, NOT_RUN, RAN_UNKNOWN, denyPlace, deniedText, refusedText) live in
// refusal-words.ts, shared with the runner's loops.
export { type DenyFrom, deniedText, denyPlace, NOT_RUN, RAN_UNKNOWN, refusedText, type SettingFrom } from "./refusal-words.js";
/** The refusal of an ask where no one can approve it: a server with accounts off, whose answer route takes no token. */
export const noApproverText = (tool: string, ran: "no" | "unknown" = "no"): string => `Permission denied: ${tool} needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools. ${ran === "no" ? NOT_RUN : RAN_UNKNOWN}`;

/** The Timeline row of a call that waits for an approval. */
export const APPROVAL_ROW = "tool_approval_requested" as const;
/** A call's arguments shown on its approval, at most this many bytes. */
export const ARGS_PREVIEW_BYTES = 2048;



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

/** The gate of the run `runId` whose folder is `where`, on its pinned revision. `serverSettings`: the server's tool
 *  settings as the runner read them from the one store at the claim (tool-plane.ts loadToolSettings), read at each call as
 *  the gate reads them. `approvers`: whether anyone can answer an ask here, the store's (server-approvers.ts, read at each
 *  claim). The gate reads nothing of the run's own files: they are the agent's to write. */
export function runGate(where: { root: string; work: string; computer?: boolean; effectOf?: (name: string) => ToolEffect | undefined; argumentsOf?: ArgumentsOf }, runId: string, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals; computer?: unknown; place?: unknown } }, serverSettings: () => ToolSettingsRead, approvers: boolean): RunGate {
  // The run's computer kind, from its revision's setting (as the claim starts it): a computer tool's words name it.
  const kind = settingOfDefinition(revision.body)?.computer.kind;
  return new RunGate({ root: where.root, work: where.work, runId, harness: revision.body.harness ?? DEFAULT_HARNESS, ...(where.computer === undefined ? {} : { computer: where.computer }), ...(kind !== undefined ? { kind } : {}), ...(where.effectOf ? { effectOf: where.effectOf } : {}), ...(where.argumentsOf ? { argumentsOf: where.argumentsOf } : {}) }, serverSettings, (revision.body.toolSettings ?? {}) as PermissionSettings, approvers, approvalsOf(revision.body.approvals));
}

/** The top-level arguments the listing of the MCP tool `name` (`mcp:<server>/<tool>`) in the run's pin declares under
 *  its inputSchema's `properties`, the snapshot the run offers the model, never a live listing; undefined for a listing
 *  with no `properties` object (nothing to close a pinned call to) and for any other tool. */
export type ArgumentsOf = (name: string) => ReadonlySet<string> | undefined;

/** A run's folder as its spec names it: the run's Workspace (Mode 2: its folder on the run's disk, never a folder of this
 *  machine), or the local folder's path. The gate checks paths against it and reads nothing in it. */
export type RunFiles = Pick<Workspace, "read"> | string;

/** A run's tool gate on the runner: its policy, asked before each call's intent (decide). */
export class RunGate {

  /** `readServerSettings`: the server's tool settings, read at each call; `overrides`: the pinned revision's own;
   *  `approvers`: whether anyone can answer an ask here (the owner's password session: accounts on); `approvals`: the
   *  pinned revision's (definition.approvals): "never" runs the agent unattended, an ask allowed (permissionFrom). */
  /** `where.effectOf`: an MCP tool's effect as the run's pin marks it (ClaimMcp.effectOf), what "allow reads" reads;
   *  never a live listing, so a server can't widen a run's access mid-run. */
  constructor(private readonly where: { root: string; work: string; runId: string; harness?: string; computer?: boolean; /** The run's computer kind (its revision's setting): the key a computer tool's refusal and ask name on a tie (kindSetting). */ kind?: string; effectOf?: (name: string) => ToolEffect | undefined; /** The arguments each MCP tool's listing in the run's pin declares (ClaimMcp.argumentsOf), for a pinned tool's closure (pinRefusal). */ argumentsOf?: ArgumentsOf }, private readonly readServerSettings: () => ToolSettingsRead, private readonly overrides: PermissionSettings = {}, private readonly approvers = true, private readonly approvals: Approvals = "ask") {}
  private names?: NameMap;

  /** A tool's permission now (permissionOf): the revision's own over the server's setting, read at each call, so a change
   *  reaches a live run at its next call; under approvals "never", an ask is an allow. */
  readonly policy = (tool: string): Permission => this.setting(tool).permission;

  /** The gate's answer for one call before its intent, for a loop that parks and answers asks itself (the runner's adapter
   *  loops, pi's and the CLI harnesses'): run it, ask a person, or refuse it with the words the model reads. The order:
   *  the deny (with where it was set, and that nothing was sent or charged), a pin, bash's policy (policyRefusal), then
   *  the allow, then the ask, so an allow that approvals "never" made is decided
   *  only after every refusal. Where no one can approve (accounts off: the store's approvers row a runner reads at each
   *  claim, server-approvers.ts), the ask is refused at once in words, never parked, as `enter` refuses it. `replayed`:
   *  the call is run again after an earlier attempt that may have been sent (a replay-safe call rerun after a crash), so a
   *  refusal says whether it took effect is not known, never that nothing was sent. */
  async decide(name: string, args: unknown, options: { readonly replayed?: boolean } = {}): Promise<"allow" | "ask" | { deny: string }> {
    // tools_search, tools_call and the host's codemode (runner/meta-tools.ts) run: each call they make is asked about here
    // as its own tool, by its own name (a computer's tool by its kind's setting, KIND_TOOLS).
    // Each has a settings key of its own (allow unless an owner sets deny: a denied one is not offered, and a call to it is
    // refused here).
    if (META_TOOLS.has(name)) {
      const setting = this.setting(name);
      return setting.permission === "deny" ? { deny: deniedText(name, name, setting.from, options.replayed ? "unknown" : "no") } : "allow";
    }
    // A script's computer op that runs what one of the run's own tools runs (heldAs: its shell, its files) is that tool's
    // call, decided as on a computer, where it runs: a desktop that mounts no folder has a computer to run a command on,
    // so shell.run and processes.start follow bash's one setting alike, as the run's own tools on a computer do. It is a
    // computer tool too: the kind's deny (desktop or phone set to deny) refuses it first, in the kind's words, below.
    const held = heldAs(name, args);
    if (held && this.policy(name) !== "deny") return this.onComputer().decide(held.tool, held.args, options);
    const key = this.keyOf(name) ?? name;
    const tool = this.askedAs(name);
    const ran = options.replayed ? "unknown" : "no";
    const verdict = this.policy(name);
    if (verdict === "deny") return { deny: deniedText(tool, key, this.denyFrom(name), ran) };
    const pinned = this.pinned(key, args, ran);
    if (pinned) return { deny: pinned.text };
    const policed = this.policyRefusal(key, name, args);
    if (policed) return { deny: policed };
    if (verdict === "allow") return "allow";
    return this.approvers ? "ask" : { deny: noApproverText(tool, ran) };
  }

  /** The settings key a call of `name` is held to, the one its refusal and its ask name: a computer tool's is the kind
   *  whose setting decides it (kindSetting), any other's its session's name map. */
  private keyOf(name: string): string | undefined {
    const kinds = this.kindKeysOf(name);
    if (kinds) return this.kindSetting(name, kinds).key;
    const harness = this.where.harness ?? DEFAULT_HARNESS;
    return settingsKeyOf(harness, name, (this.names ??= nameMapOf(harness)));
  }

  /** A computer tool's settings keys (KIND_TOOLS), the run's own kind first (where.kind); undefined for any other tool. */
  private kindKeysOf(tool: string): readonly string[] | undefined {
    const keys = KIND_TOOLS.get(tool);
    const kind = this.where.kind;
    return keys && kind !== undefined && keys.includes(kind) ? [kind, ...keys.filter((key) => key !== kind)] : keys;
  }

  /** A computer tool's permission: the stricter of its kinds' settings (a desktop's and a phone's keys both hold it), and
   *  the key that decided it, the run's own kind on a tie, so a phone run's refusal and ask say phone. */
  private kindSetting(tool: string, kinds: readonly string[]): { permission: Permission; from: SettingFrom; key: string } {
    return kinds.map((key) => ({ ...this.settingOf(tool, key), key })).reduce((strictest, one) => (STRICTNESS[one.permission] > STRICTNESS[strictest.permission] ? one : strictest));
  }

  /** The name a call is asked about by, as main's request names it (enter's `tool`): its settings key, a shell tool its
   *  own name; a script's computer op with `args` by the tool it is held to (heldAs); a name nothing maps, as it came. */
  askedAs(name: string, args?: unknown): string {
    const held = heldAs(name, args);
    if (held) return this.askedAs(held.tool);
    return shellToolOf(name) ?? this.keyOf(name) ?? name;
  }
  private computerGate?: RunGate;
  /** This gate as on a computer: where a script's computer op runs (heldAs), whatever the run's own shell is. */
  private onComputer(): RunGate {
    return (this.computerGate ??= new RunGate({ ...this.where, computer: true }, this.readServerSettings, this.overrides, this.approvers, this.approvals));
  }
  /** Where the permission `policy` gives `tool` was set: the agent's own tool settings, the server's, or the default; or
   *  "unattended", an ask the agent's approvals allowed. */
  readonly denyFrom = (tool: string): SettingFrom => this.setting(tool).from;
  private setting(tool: string): { permission: Permission; from: SettingFrom } {
    if (META_TOOLS.has(tool)) return this.settingOf(tool, tool);
    // A tool the desktop and the phone both have (every computer tool) is held to the stricter of both keys' settings,
    // never more permissive than the run's own kind's.
    const kinds = this.kindKeysOf(tool);
    if (kinds) return this.kindSetting(tool, kinds);
    return this.settingOf(tool, this.keyOf(tool));
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
    const where = { computer: this.where.computer };
    if (server === undefined) {
      const own = permissionFrom(key, {}, this.overrides, "ask", where);
      return own.permission === "deny" ? own : { permission: "ask", from: "default" };
    }
    // A shell tool under every harness's name for it is read as its own name, by bash's key (permissionFrom): a watcher's
    // ask is allow only where bash's ask is set as written. Its default is where the run's shell is (defaultPermission).
    return permissionFrom(shellToolOf(tool) ?? key, server, this.overrides, this.approvals, where, mcpNameOf(key) ? this.where.effectOf?.(key) : undefined);
  }

  /** Why a pin refuses the call of `key` with `args` now (pinRefusal): the revision's own pins and the server's, read at
   *  each call as its permission is, so a pin set or changed reaches a live run at its next call; a pinned tool held to
   *  the arguments its listing in the run's pin declares (where.argumentsOf). */
  private pinned(key: string, args: unknown, ran: "no" | "unknown" = "no"): { text: string; mismatched: string[] } | undefined {
    return pinRefusal(key, args, this.serverSettings() ?? {}, this.overrides, ran, this.where.argumentsOf?.(key));
  }

  /** Why bash's policy refuses the call `name` (held to `key`) with `args` now, or undefined: the revision's own setting
   *  (an agent's tool_settings.bash.policy), so every shell tool under every harness's name for it is held to it. A policy
   *  this server does not know refuses every shell call (fail closed), as a pin that does not read does. */
  private policyRefusal(key: string, name: string, args: unknown): string | undefined {
    if (key !== "bash") return undefined;
    const policy = this.overrides.bash?.policy;
    if (policy === undefined) return undefined;
    // Its own name for a background tool (bash_background);bash for bash and
    // a CLI's own shell (codex's shell, claude-agent's Bash).
    const tool = shellToolOf(name) ?? "bash";
    if (!(BASH_POLICIES as readonly string[]).includes(policy)) return `${tool} can't be called: this agent's bash policy ${JSON.stringify(policy).slice(0, 60)} is not one this server knows (${BASH_POLICIES.join(", ")}), so no command is let through until its tool_settings name one. ${NOT_RUN}`;
    const reason = readOnlyReason(tool, args, [this.where.work, COMPUTER_ROOT]);
    return reason === undefined ? undefined : readOnlyText(tool, reason, NOT_RUN);
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


}
