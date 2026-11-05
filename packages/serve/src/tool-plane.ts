// The tool plane: the capabilities a pack or a revision may grant, the providers a user may pick for the two that reach
// the web, and what each resolves to on a run. A capability resolves in one order: (1) the provider the user picked, the
// agent's own (`definition.tool_settings`) over the server's (`PUT /v2/settings/tools`), optional; (2) the native tool:
// the harness's own (claude-agent's WebSearch), or on pi one request to the run's own model provider with its hosted
// search (hosted-search.ts); (3) for web_search, Parallel where the server holds its key (env or saved, which then bills
// it); (4) the kernel's keyless fallback: web_fetch's guarded direct fetch, and web_search on Exa's public keyless MCP
// endpoint (exa-keyless.ts). On claude-agent `auto` skips (2): Claude's own search is an explicit pick, `native`. Codex's
// own search on codex, Parallel or keyless Exa behind a gateway, on OpenRouter or under a spend cap;
// `off` turns web_search off. web_search's default, `auto`, is that order; a pick of `native` is native only,
// unavailable where there is none, never Exa. A grant names a capability, never a provider. A pick of parallel without
// PARALLEL_API_KEY resolves unavailable, never to something else. The server resolves a run's tools at its first
// launch, from its pinned revision and the settings then, keeps them for the run's life (runs.ts), and hands the run's
// process the outcome as a non-secret description (TOOL_PLANE_ENV): the run reads its tools' providers there, never from
// a request.
//
// Each tool also has a permission, the tool gate's (tool-gate.ts): allow, ask or deny, the agent's over the server's over
// the owner's default (a built-in kernel tool allow, a third-party catalog tool ask, told apart by its name), read by
// the gate's one rule, permissionOf. A capability set to deny resolves to no provider; under ask, a harness's own search
// (inside its CLI, where no call can wait for a person) gives way to the kernel's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionKeysOf, PARALLEL_KEY_ENV } from "./decisions.js";
import type { InputIssue } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessId } from "./harness.js";
import { savedIn } from "./secrets.js";
import { hostModel, viaOpenRouter } from "./model.js";
import { defaultPermission, isCatalogTool, isMcpTool, type Permission, PERMISSIONS, permissionFrom, permissionOf } from "./tool-gate.js";

/**
 * The capabilities a pack or a revision may grant, by name: the tools the kernel gives a run, bound from serve's closed
 * table (tools.ts) and named the same on every harness that runs them. `web_search` and `web_fetch` resolve to a
 * provider (PROVIDERS); the rest are the kernel's own. Not capabilities: `fetch_page` (legacy: web_fetch's guarded fetch
 * with no provider behind it), the workflow call nodes' `pdf_pages` and `llm` (a workflow's call node names them, a grant
 * never does), and a catalog's tools (`monid.*`, `mcp:<server>/<tool>`: catalog tools, which their catalog grants).
 */
export const CAPABILITIES = ["read", "write", "edit", "web_search", "web_fetch", "browser", "ask_person"] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** The providers a user may pick for each capability that has a choice, its default first: `auto`, the native search
 *  where there is one (never on claude-agent, where Claude's own search is picked as `native`), else Parallel where the
 *  server holds its key, else keyless Exa; `native`, the harness's own tool or its model provider's hosted one, and
 *  nothing else; `exa-keyless`, Exa's public MCP endpoint, no key; `kernel`, the guarded direct fetch; `parallel`,
 *  Parallel's Search and Extract APIs on PARALLEL_API_KEY; `off`, web_search turned off: nothing is searched, and an
 *  agent naming it is refused until it is turned on again. */
export const PROVIDERS = Object.freeze({ web_search: ["auto", "native", "exa-keyless", "parallel", "off"], web_fetch: ["kernel", "parallel"] } as const);
export type Pickable = keyof typeof PROVIDERS;
export const PICKABLE = Object.keys(PROVIDERS) as Pickable[];
/** Older names a revision may still grant, and the capability each one is: `fetch_page` runs web_fetch, under its own
 *  name, and resolves as web_fetch does. */
export const LEGACY_NAMES: Readonly<Record<string, Pickable>> = Object.freeze({ fetch_page: "web_fetch" });
/** The capability a granted name runs: its legacy target, else itself. */
export const capabilityOf = (name: string): string => LEGACY_NAMES[name] ?? name;
/** Every tool of serve's table (tools.ts) and its legacy names, by name, so this module needs no import of it: a test
 *  holds the two as one. */
export const TABLE_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "ask_person", "fetch_page", "web_fetch", "web_search", "browser", "pdf_pages", "llm"];
/** The table's tools whose approved call the kernel runs itself, outside the model's turn (host-tools.ts's REPLAY): ask is
 *  offered for these and for catalog tools. Any other (browser, ask_person, the call-only ones) is allow or deny. */
export const ASKABLE: readonly string[] = ["read", "write", "edit", "bash", "fetch_page", "web_fetch", "web_search"];
/** The permissions `name` may be set to. */
export const permissionsOf = (name: string): readonly Permission[] => (ASKABLE.includes(name) || isCatalogTool(name) ? PERMISSIONS : ["allow", "deny"]);
/** A settings key: a tool of the table, a catalog tool (`monid.<tool>`, `mcp:<server>/<tool>`), or an MCP server's
 *  wildcard (`mcp:<server>/*`), which sets each of its tools. */
const isSettingsKey = (name: string): boolean => (TABLE_TOOLS.includes(name) && !Object.hasOwn(LEGACY_NAMES, name)) || isCatalogTool(name) || /^mcp:[^/]+\/\*$/.test(name);
/** One tool's settings: its provider (a capability that has a choice) and its permission. */
export type ToolSetting = { provider?: string; permission?: Permission };
/** The tools' settings, the server's (`/v2/settings/tools`) and an agent's own (`definition.tool_settings`), one shape:
 *  by settings key. */
export type ToolSettingsMap = Partial<Record<string, ToolSetting>>;
/** What a capability resolves to on a run: the native tool, the kernel's own, keyless Exa, Parallel, or why not. */
export type Resolution = "native" | "kernel" | "exa-keyless" | "parallel" | `unavailable: ${string}`;
export const NO_PARALLEL_KEY: Resolution = "unavailable: parallel picked, no PARALLEL_API_KEY";
/** web_search with `off` picked: no search leaves the server. */
export const SEARCH_OFF: Resolution = "unavailable: web_search is turned off in settings";
/** A capability set to deny: no provider is asked, and the gate refuses each call, so its run still starts. */
export const DENIED: Resolution = "unavailable: denied";
/** `native` picked for a capability set to ask on a harness whose own search runs inside its CLI. */
export const NATIVE_ASKS: Resolution = "unavailable: native search cannot wait for an approval";
/** The model providers whose hosted web search pi's web_search asks (hosted-search.ts), by pi-ai's provider id. */
export const HOSTED_SEARCH_PROVIDERS: readonly string[] = ["anthropic", "openai"];

/** A run's facts its capabilities resolve from. */
export type ResolveInput = {
  harness: string;
  /** The run's model as named, `provider/model-id`: the revision's, else the host's for its harness (hostModel: a tier
   *  variable or AGENT_MODEL it runs, else a model key's default). */
  model?: string;
  /** Its model requests go through a gateway (AGENT_MODEL_BASE_URL), not the provider's own API (pi's). */
  gateway: boolean;
  /** The agent's pick, then the server's; neither, the capability's default. */
  override?: string;
  pick?: string;
  /** The server holds PARALLEL_API_KEY; `parallelKeyFrom`, where from: its own environment, or saved on Tool keys. */
  parallelKey: boolean;
  parallelKeyFrom?: "server" | "saved";
  /** The run has a spend cap: Codex's own search sends a request with no input bound, which a cap cannot admit. */
  capped?: boolean;
  /** The harness's model requests go through OpenRouter (model.ts' viaOpenRouter), where its own search does not run. */
  openRouter?: boolean;
  /** Its permission in force (tool-gate.ts); absent, allow. */
  permission?: Permission;
};

/** Why claude-agent has no native search under a spend cap, and what works there instead. */
const CLAUDE_CAPPED = "claude-agent under a spend cap: Claude's own search has per-use fees a spend cap cannot reserve yet, so web_search works under a cap through the default provider, auto";

/** Why a run of `input` has no native search, where it has none: `id`, as the unavailable text names it, and `why`, the
 *  same in a sentence (capabilities' `why`). */
function noNative(input: ResolveInput): { id: string; why: string } | undefined {
  // Native, where there is one. Claude's model goes to Anthropic's Messages API (or its own ANTHROPIC_BASE_URL), never
  // through the other harnesses' gateway; Codex's own search goes to OpenAI with its request, except behind a gateway
  // (no known hosted search), on OpenRouter (which runs neither harness's own search, nor counts its searches) or
  // under a spend cap (its request has no input bound, which a cap cannot admit); pi asks
  // Anthropic's or OpenAI's. Under a spend cap Claude's own search is not offered either: each search has a per-use fee
  // the cap cannot reserve yet (its request's bound holds the pages' input tokens, not the fees). Where there is none,
  // `native` is unavailable, and `auto` goes to Parallel on the server's key (its fee booked and held by a cap, paid-calls.ts),
  // else to keyless Exa.
  const vendor = input.model?.slice(0, Math.max(0, input.model.indexOf("/")));
  if ((input.harness === "claude-agent" || input.harness === "codex") && input.openRouter) return { id: `${input.harness} on OpenRouter`, why: `through OpenRouter ${input.harness === "codex" ? "Codex" : "Claude"}'s own search is not run, and its searches are not counted to price` };
  if (input.harness === "claude-agent") return input.capped ? { id: CLAUDE_CAPPED, why: "under a spend cap Claude's own search is not offered, since a cap cannot reserve its per-use fees yet" } : undefined;
  if (input.harness === "codex") return input.gateway ? { id: "codex behind a gateway", why: "behind a gateway Codex has no own search" } : input.capped ? { id: "codex under a spend cap", why: "under a spend cap Codex's own search is not offered, since its request has no input bound" } : undefined;
  // OpenCode has none: its model requests carry no provider-hosted tool (its proxy policy refuses one).
  if (input.harness === "opencode") return { id: "opencode, whose model requests carry no provider-hosted tool", why: "OpenCode's model requests carry no provider-hosted tool" };
  if (input.gateway) return { id: `${input.harness} behind a gateway`, why: `behind a gateway ${input.harness} has no hosted search` };
  if (vendor && HOSTED_SEARCH_PROVIDERS.includes(vendor)) return undefined;
  return input.model ? { id: input.model, why: `${input.model} has no hosted search here` } : { id: "a model with none named", why: "no model is named, so there is no hosted search" };
}

/** The native search of a run that has one, in a sentence. */
const nativeWhy = (input: ResolveInput): string =>
  input.harness === "claude-agent" ? "Claude's own search" : input.harness === "codex" ? "Codex's own search" : `${input.model?.startsWith("openai/") ? "OpenAI" : "Anthropic"}'s hosted search, for ${input.model}`;

/** What `capability` resolves to on a run of `input`, and why in a plain sentence (capabilities' `why`): one rule, so
 *  the two never disagree. */
export function explainCapability(capability: Pickable, input: ResolveInput): { resolves: Resolution; why: string } {
  const chosen = input.override ?? input.pick ?? PROVIDERS[capability][0];
  const picked = input.override !== undefined ? "picked for this agent" : "picked in settings";
  const key = `your Parallel key (${input.parallelKeyFrom ?? "server"})`;
  if (input.permission === "deny") return { resolves: DENIED, why: "set to deny: the gate refuses each call" };
  if (chosen === "off") return { resolves: SEARCH_OFF, why: "turned off in settings" };
  if (chosen === "parallel") return input.parallelKey ? { resolves: "parallel", why: `Parallel, ${picked}: ${key}` } : { resolves: NO_PARALLEL_KEY, why: "Parallel is picked, and no PARALLEL_API_KEY is set or saved" };
  if (capability === "web_fetch") return { resolves: "kernel", why: "the guarded direct fetch" };
  if (chosen === "exa-keyless") return { resolves: "exa-keyless", why: `keyless Exa, ${picked}: Exa's free search, no key` };
  // Under ask, a harness's own search runs inside its CLI, where no call can wait for a person: none on claude-agent or
  // codex then, and the kernel's search, which the gate holds, in its place. pi's is a tool of the run's, which it holds.
  const asks = input.permission === "ask" && input.harness !== DEFAULT_HARNESS;
  const without = noNative(input);
  if (chosen === "native" && asks && without === undefined) return { resolves: NATIVE_ASKS, why: "native search cannot wait for an approval: it runs inside the harness's CLI" };
  const none = without ?? (asks ? { id: input.harness, why: "under ask the harness's own search cannot wait for a person's approval" } : undefined);
  if (chosen === "native") return none === undefined ? { resolves: "native", why: nativeWhy(input) } : { resolves: `unavailable: no native search for ${none.id}`, why: `no native search for ${none.id}` };
  // On claude-agent `auto` skips Claude's own search, an explicit pick (`native`): Parallel on the server's key, else
  // keyless Exa.
  if (input.harness === "claude-agent") return input.parallelKey ? { resolves: "parallel", why: key } : { resolves: "exa-keyless", why: "Exa's free keyless search, no key; Claude's own search is an explicit pick" };
  if (none === undefined) return { resolves: "native", why: nativeWhy(input) };
  return input.parallelKey ? { resolves: "parallel", why: `${none.why}; ${key}` } : { resolves: "exa-keyless", why: `${none.why}; Exa's free keyless search, no key` };
}

/** What `capability` resolves to on a run of `input`. */
export const resolveCapability = (capability: Pickable, input: ResolveInput): Resolution => explainCapability(capability, input).resolves;

export const isUnavailable = (resolution: Resolution | undefined): resolution is `unavailable: ${string}` => resolution?.startsWith("unavailable: ") === true;
/** Why a resolution is unavailable: its words after "unavailable: " (any other resolution as it is). */
export const whyUnavailable = (resolution: string): string => resolution.replace(/^unavailable: /, "");

/** The server's environment's part of every resolution: its gateway and Parallel's key, and where the key is from. */
const served = (env: NodeJS.ProcessEnv) => {
  const parallelKey = PARALLEL_KEY_ENV in decisionKeysOf(env);
  return { gateway: Boolean(env.AGENT_MODEL_BASE_URL), parallelKey, ...(parallelKey ? { parallelKeyFrom: savedIn(env).has(PARALLEL_KEY_ENV) ? ("saved" as const) : ("server" as const) } : {}) };
};

/** Each pickable capability on each harness under the server's `settings` and an agent's `overrides`, on `model`
 *  (default each harness's host model, the one a run that names none runs on: hostModel): what it resolves to and why, as
 *  capabilities and the tool catalog show them. */
export function explainsView(env: NodeJS.ProcessEnv, settings: ToolSettingsMap, overrides: ToolSettingsMap = {}, model?: string): Record<Pickable, { resolves: Record<HarnessId, Resolution>; why: Record<HarnessId, string> }> {
  return Object.fromEntries(PICKABLE.map((name) => {
    const input = { ...served(env), ...picked(name, settings, overrides) };
    const each = HARNESSES.map((harness) => {
      const on = model ?? hostModel(env, "default", harness);
      return [harness, explainCapability(name, { ...input, ...(on ? { model: on } : {}), harness, openRouter: viaOpenRouter(env, harness, on) })] as const;
    });
    return [name, { resolves: Object.fromEntries(each.map(([harness, said]) => [harness, said.resolves])), why: Object.fromEntries(each.map(([harness, said]) => [harness, said.why])) }];
  })) as Record<Pickable, { resolves: Record<HarnessId, Resolution>; why: Record<HarnessId, string> }>;
}

const picked = (name: Pickable, settings: ToolSettingsMap, overrides: ToolSettingsMap = {}) => ({
  ...(overrides[name]?.provider ? { override: overrides[name]!.provider } : {}),
  ...(settings[name]?.provider ? { pick: settings[name]!.provider } : {}),
  permission: permissionOf(name, settings, overrides),
});

/** What a run is told: each pickable capability its revision names, resolved; with web_search native on pi, the model
 *  its search asks (the one the resolution read). */
export type Plane = Partial<Record<Pickable, Resolution>> & { model?: string };
/** The facts of a pinned revision its run's tools resolve from. */
export type Tooling = { harness?: string; tools: readonly string[]; model?: string; overrides?: ToolSettingsMap; workflow?: true };

/** The run's process's description of its tools' providers: JSON of its Plane. */
export const TOOL_PLANE_ENV = "AGENTRUN_SERVE_TOOL_PLANE";

/** The Plane of a run of `tooling`, in the server's `env` (with its secrets) under its `settings`. */
export function planeFor(env: NodeJS.ProcessEnv, tooling: Tooling, settings: ToolSettingsMap, { capped = false }: { capped?: boolean } = {}): Plane {
  const harness = tooling.harness ?? DEFAULT_HARNESS;
  // A workflow's model nodes may each run on another tier's model, and a native search asks one model's provider: a
  // workflow's search resolves with no model (keyless Exa, or Parallel where picked), never on a model a node may not use.
  // A run that names no model runs on the host's for its harness (hostModel: a model key's default when no AGENT_MODEL
  // it runs is set), so its search resolves on that one.
  const model = tooling.workflow ? undefined : (tooling.model ?? hostModel(env, "default", harness));
  const plane: Plane = {};
  const granted = tooling.tools.map(capabilityOf);
  for (const name of PICKABLE) {
    if (granted.includes(name)) plane[name] = resolveCapability(name, { ...served(env), harness, capped, openRouter: viaOpenRouter(env, harness, model), ...(model ? { model } : {}), ...picked(name, settings, tooling.overrides) });
  }
  if (plane.web_search === "native" && harness === DEFAULT_HARNESS && model) plane.model = model;
  return plane;
}

/** A run's kept Plane at a later launch: as it was, but Parallel where the server no longer holds its key, which is
 *  unavailable, never another provider; and, given `now` (the Plane it would get today and each capability's permission
 *  today), a capability set to ask or deny, or kept denied, as it resolves today: a harness's own search cannot wait for
 *  a person, and a deny that was lifted is lifted. */
export function recheckPlane(plane: Plane, env: NodeJS.ProcessEnv, now?: { fresh: Plane; permission: (name: Pickable) => Permission }): Plane {
  const keyed = served(env).parallelKey;
  return Object.fromEntries(Object.entries(plane).map(([name, value]) => {
    const fresh = name === "model" ? undefined : now?.fresh[name as Pickable];
    if (fresh !== undefined && (value === DENIED || now!.permission(name as Pickable) !== "allow")) return [name, fresh];
    return [name, value === "parallel" && !keyed ? NO_PARALLEL_KEY : value];
  })) as Plane;
}

/** The Plane the server handed this run's process; empty when it handed none. */
export function planeOf(env: NodeJS.ProcessEnv): Plane {
  try {
    const plane = JSON.parse(env[TOOL_PLANE_ENV] ?? "{}") as unknown;
    return typeof plane === "object" && plane !== null && !Array.isArray(plane) ? (plane as Plane) : {};
  } catch {
    return {};
  }
}

/** Whether a run is handed Parallel's key: one of its capabilities resolves to Parallel. */
export const handsParallel = (plane: Plane): boolean => PICKABLE.some((name) => plane[name] === "parallel");

/** The issues of `value` as a settings map, its fields under `at` (none: a body's own): each settings key (a tool of the
 *  table, a catalog tool, an MCP server's wildcard) to `{provider?, permission?}`, a provider only for a capability that
 *  has a choice and one offered for it, a permission one offered for the tool. */
export function settingsIssues(value: unknown, at = ""): InputIssue[] {
  const field = (...names: string[]) => [at, ...names].filter(Boolean).join(".");
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlain(value)) return [{ field: at || "body", reason: "wrong_type", message: `${at || "the body"} is an object of tools to their settings` }];
  return Object.entries(value).flatMap(([name, setting]): InputIssue[] => {
    const pickable = Object.hasOwn(PROVIDERS, name);
    if (!isSettingsKey(name)) return [{ field: field(name), reason: "not_allowed", message: `Tool settings are kept for this server's tools (${TABLE_TOOLS.join(", ")}), catalog tools (monid.<tool>, mcp:<server>/<tool>) and an MCP server's tools (mcp:<server>/*); ${name} is none of them.` }];
    if (!isPlain(setting)) return [{ field: field(name), reason: "wrong_type", message: `${field(name)} is an object, {${pickable ? "provider, " : ""}permission}` }];
    return Object.entries(setting).flatMap(([key, given]): InputIssue[] => {
      if (key === "permission") {
        // A wildcard sets each tool of its server's: a catalog tool's permissions.
        const offered = permissionsOf(isMcpTool(name) ? name : name.replace(/\/\*$/, "/_"));
        return offered.includes(given as Permission) ? [] : [{ field: field(name, key), reason: "not_an_option", message: `${field(name, key)} is one of ${offered.join(", ")}` }];
      }
      if (key !== "provider" || !pickable) return [{ field: field(name, key), reason: "not_allowed", message: `${field(name)} keeps no field ${key}.` }];
      const offered: readonly string[] = PROVIDERS[name as Pickable];
      return offered.includes(given as string) ? [] : [{ field: field(name, key), reason: "not_an_option", message: `${field(name, key)} is one of ${offered.join(", ")}` }];
    });
  });
}

/** `map` with each capability's provider, its default where none is picked; a permission where one is set. */
export const withDefaults = (map: ToolSettingsMap): ToolSettingsMap & Record<Pickable, { provider: string; permission?: Permission }> => ({
  ...map,
  ...(Object.fromEntries(PICKABLE.map((name) => [name, { provider: map[name]?.provider ?? PROVIDERS[name][0], ...(map[name]?.permission ? { permission: map[name]!.permission } : {}) }])) as Record<Pickable, { provider: string; permission?: Permission }>),
});

/** The server's tool settings, beside the agent store in its data directory: not a secret, and not in store.sqlite,
 *  which runs hold open. Read once at the start, written whole and durably (0600) at each PUT; a missing file is every
 *  default, and so is one it cannot read, which it says in one line. */
/** The tool settings in `dir` as the server and the tool gate read them, failing closed: each entry that reads is kept;
 *  one that does not is dropped, but a known tool keeps what of it reads, and its permission, when not one offered,
 *  reads ask (deny where ask is not offered), never its allow default. `problems`: one line for each entry dropped or
 *  changed, naming the file and the field, never a value. `unreadable`: the file as a whole does not read (none, a
 *  missing file is every default). */
export function readToolSettings(dir: string): { settings: ToolSettingsMap; problems: string[]; unreadable?: true } {
  const file = join(dir, ToolSettings.FILE);
  let read: unknown;
  try {
    read = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, problems: [] };
    return { settings: {}, problems: [`${file} does not read as JSON`], unreadable: true };
  }
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlain(read)) return { settings: {}, problems: [`${file} is not an object of tools to their settings`], unreadable: true };
  const settings: ToolSettingsMap = {};
  const problems: string[] = [];
  for (const [name, setting] of Object.entries(read)) {
    const issues = settingsIssues({ [name]: setting });
    if (!issues.length) {
      settings[name] = setting as ToolSetting;
      continue;
    }
    problems.push(`${file}: ${issues.map((issue) => `${issue.field} ${issue.reason}`).join(", ")}`);
    if (!isSettingsKey(name) || !isPlain(setting)) continue;
    const kept: ToolSetting = {};
    if (typeof setting.provider === "string" && !settingsIssues({ [name]: { provider: setting.provider } }).length) kept.provider = setting.provider;
    if (setting.permission !== undefined) {
      const offered = permissionsOf(isMcpTool(name) ? name : name.replace(/\/\*$/, "/_"));
      kept.permission = offered.includes(setting.permission as Permission) ? (setting.permission as Permission) : offered.includes("ask") ? "ask" : "deny";
    }
    if (Object.keys(kept).length) settings[name] = kept;
  }
  return { settings, problems };
}

export class ToolSettings {
  static readonly FILE = "tool-settings.json";
  private current: ToolSettingsMap;
  constructor(private readonly dir: string, warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)) {
    const { settings, problems, unreadable } = readToolSettings(dir);
    for (const line of problems) warn(`agentrun-serve: ${line}; ${unreadable ? "every tool takes its defaults" : "that entry is dropped (a permission that is not offered reads ask)"} until a PUT /v2/settings/tools`);
    this.current = settings;
  }

  get(): ToolSettingsMap {
    return structuredClone(this.current);
  }

  /** Replaces the settings: a tool `map` leaves out takes its defaults. Durable before it returns. */
  put(map: ToolSettingsMap): ToolSettingsMap {
    const kept: ToolSettingsMap = Object.fromEntries(Object.entries(map).flatMap(([name, setting]) => {
      const set = { ...(setting?.provider ? { provider: setting.provider } : {}), ...(setting?.permission ? { permission: setting.permission } : {}) };
      return Object.keys(set).length ? [[name, set]] : [];
    }));
    writeDurableSync(join(this.dir, ToolSettings.FILE), `${JSON.stringify(kept)}\n`);
    this.current = kept;
    return this.get();
  }
}

/** GET /v2/agents/{id}'s `tools`: each tool its current revision grants, in `order` (capabilities.tools'), with its
 *  permission in force and where it came from (the agent's own settings, the server's, or the default), the one that
 *  applies when the agent sets none (the server's, else the default) and those it may be set to; and for one with a
 *  provider choice the provider in force and where it came from, the one that applies when the agent sets none, and what
 *  it resolves to on the agent's harness and model. */
export function agentTools(env: NodeJS.ProcessEnv, settings: ToolSettingsMap, agent: Tooling, order: readonly string[]) {
  const plane = planeFor(env, agent, settings);
  const rank = (name: string) => order.indexOf(capabilityOf(name)) + (name in LEGACY_NAMES ? 0.5 : 0);
  return [...new Set(agent.tools)].sort((a, b) => rank(a) - rank(b)).map((name) => {
    const capability = capabilityOf(name);
    const { permission, from } = permissionFrom(name, settings as never, (agent.overrides ?? {}) as never);
    const gate = { permission, permission_from: from, default_permission: permissionOf(name, settings as never), permissions: [...permissionsOf(name)] };
    if (!Object.hasOwn(PROVIDERS, capability)) return { name, ...gate };
    const pick = capability as Pickable;
    const own = agent.overrides?.[pick]?.provider;
    const server = settings[pick]?.provider;
    return { name, ...gate, provider: own ?? server ?? PROVIDERS[pick][0], provider_from: own ? "agent" : server ? "server" : "default", default_provider: server ?? PROVIDERS[pick][0], resolved: plane[pick]! };
  });
}
