// The tool plane: the capabilities a pack or a revision may grant, the providers a user may pick for the two that reach
// the web, and what each resolves to on a run. A capability resolves in one order: (1) the provider the user picked, the
// agent's own (`definition.tool_settings`) over the server's (`PUT /v2/settings/tools`), optional; (2) the native tool:
// the harness's own (claude-agent's WebSearch), or on pi one request to the run's own model provider with its hosted
// search (hosted-search.ts); (3) the kernel's keyless fallback: web_fetch's guarded direct fetch, and web_search on Exa's
// public keyless MCP endpoint (exa-keyless.ts). Codex's own search on codex, keyless Exa behind a gateway or under a spend cap; `off` turns web_search off
// unless Parallel is picked. web_search's default, `auto`, is that order; a pick of `native` is native only,
// unavailable where there is none, never Exa. A grant names a capability, never a provider. A pick of parallel without
// PARALLEL_API_KEY resolves unavailable, never to something else. The server resolves a run's tools at its first
// launch, from its pinned revision and the settings then, keeps them for the run's life (runs.ts), and hands the run's
// process the outcome as a non-secret description (TOOL_PLANE_ENV): the run reads its tools' providers there, never from
// a request.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionKeysOf, PARALLEL_KEY_ENV } from "./decisions.js";
import type { InputIssue } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessId } from "./harness.js";

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
 *  where there is one, else keyless Exa; `native`, the harness's own tool or its model provider's hosted one, and
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
/** One capability's settings: its provider. `permission` is reserved for the tool gate, and refused until it lands. */
export type ToolSetting = { provider?: string };
/** The settings of each capability that has a choice: the server's (`/v2/settings/tools`) and an agent's own
 *  (`definition.tool_settings`), one shape. */
export type ToolSettingsMap = Partial<Record<Pickable, ToolSetting>>;
/** What a capability resolves to on a run: the native tool, the kernel's own, keyless Exa, Parallel, or why not. */
export type Resolution = "native" | "kernel" | "exa-keyless" | "parallel" | `unavailable: ${string}`;
export const NO_PARALLEL_KEY: Resolution = "unavailable: parallel picked, no PARALLEL_API_KEY";
/** web_search with `off` picked: no search leaves the server. */
export const SEARCH_OFF: Resolution = "unavailable: web_search is turned off in settings";
/** The model providers whose hosted web search pi's web_search asks (hosted-search.ts), by pi-ai's provider id. */
export const HOSTED_SEARCH_PROVIDERS: readonly string[] = ["anthropic", "openai"];

/** A run's facts its capabilities resolve from. */
export type ResolveInput = {
  harness: string;
  /** The run's model as named, `provider/model-id`: the revision's, else the server's AGENT_MODEL. */
  model?: string;
  /** Its model requests go through a gateway (AGENT_MODEL_BASE_URL), not the provider's own API (pi's). */
  gateway: boolean;
  /** The agent's pick, then the server's; neither, the capability's default. */
  override?: string;
  pick?: string;
  /** The server holds PARALLEL_API_KEY. */
  parallelKey: boolean;
  /** The run has a spend cap: Codex's own search sends a request with no input bound, which a cap cannot admit. */
  capped?: boolean;
};

/** Why claude-agent has no native search under a spend cap, and what works there instead. */
const CLAUDE_CAPPED = "claude-agent under a spend cap: Claude's own search has per-use fees a spend cap cannot reserve yet, so web_search works under a cap through the default provider, auto";

/** What `capability` resolves to on a run of `input`. */
export function resolveCapability(capability: Pickable, input: ResolveInput): Resolution {
  const chosen = input.override ?? input.pick ?? PROVIDERS[capability][0];
  if (chosen === "off") return SEARCH_OFF;
  if (chosen === "parallel") return input.parallelKey ? "parallel" : NO_PARALLEL_KEY;
  if (capability === "web_fetch") return "kernel";
  if (chosen === "exa-keyless") return "exa-keyless";
  // Native, where there is one. Claude's model goes to Anthropic's Messages API (or its own ANTHROPIC_BASE_URL), never
  // through the other harnesses' gateway; Codex's own search goes to OpenAI with its request, except behind a gateway
  // (no known hosted search) or under a spend cap (its request has no input bound, which a cap cannot admit); pi asks
  // Anthropic's or OpenAI's. Under a spend cap Claude's own search is not offered either: each search has a per-use fee
  // the cap cannot reserve yet (its request's bound holds the pages' input tokens, not the fees). OpenCode has none: its
  // model requests carry no provider-hosted tool (its proxy policy refuses one). Where there is none, `auto` falls back
  // to keyless Exa and `native` is unavailable.
  const vendor = input.model?.slice(0, Math.max(0, input.model.indexOf("/")));
  const none = input.harness === "claude-agent" ? (input.capped ? CLAUDE_CAPPED : undefined) : input.harness === "codex" ? (input.gateway ? "codex behind a gateway" : input.capped ? "codex under a spend cap" : undefined) : input.harness === "opencode" ? "opencode, whose model requests carry no provider-hosted tool" : input.gateway ? `${input.harness} behind a gateway` : vendor && HOSTED_SEARCH_PROVIDERS.includes(vendor) ? undefined : input.model ?? "a model with none named";
  if (none === undefined) return "native";
  return chosen === "native" ? `unavailable: no native search for ${none}` : "exa-keyless";
}

export const isUnavailable = (resolution: Resolution | undefined): resolution is `unavailable: ${string}` => resolution?.startsWith("unavailable: ") === true;

/** The server's environment's part of every resolution: its gateway and Parallel's key. */
const served = (env: NodeJS.ProcessEnv) => ({ gateway: Boolean(env.AGENT_MODEL_BASE_URL), parallelKey: PARALLEL_KEY_ENV in decisionKeysOf(env) });

/** Each pickable capability on each harness under the server's `settings` and an agent's `overrides`, on `model`
 *  (default the server's AGENT_MODEL): what capabilities and the tool catalog show. */
export function resolvesView(env: NodeJS.ProcessEnv, settings: ToolSettingsMap, overrides: ToolSettingsMap = {}, model = env.AGENT_MODEL): Record<Pickable, Record<HarnessId, Resolution>> {
  return Object.fromEntries(PICKABLE.map((name) => {
    const input = { ...served(env), ...(model ? { model } : {}), ...picked(name, settings, overrides) };
    return [name, Object.fromEntries(HARNESSES.map((harness) => [harness, resolveCapability(name, { ...input, harness })]))];
  })) as Record<Pickable, Record<HarnessId, Resolution>>;
}

const picked = (name: Pickable, settings: ToolSettingsMap, overrides: ToolSettingsMap = {}) => ({
  ...(overrides[name]?.provider ? { override: overrides[name]!.provider } : {}),
  ...(settings[name]?.provider ? { pick: settings[name]!.provider } : {}),
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
  const model = tooling.workflow ? undefined : (tooling.model ?? env.AGENT_MODEL);
  const plane: Plane = {};
  const granted = tooling.tools.map(capabilityOf);
  for (const name of PICKABLE) {
    if (granted.includes(name)) plane[name] = resolveCapability(name, { ...served(env), harness, capped, ...(model ? { model } : {}), ...picked(name, settings, tooling.overrides) });
  }
  if (plane.web_search === "native" && harness === DEFAULT_HARNESS && model) plane.model = model;
  return plane;
}

/** A run's kept Plane at a later launch: as it was, but Parallel where the server no longer holds its key, which is
 *  unavailable, never another provider. */
export function recheckPlane(plane: Plane, env: NodeJS.ProcessEnv): Plane {
  const keyed = served(env).parallelKey;
  return Object.fromEntries(Object.entries(plane).map(([name, value]) => [name, value === "parallel" && !keyed ? NO_PARALLEL_KEY : value])) as Plane;
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

/** What a save of `permission` answers until the tool gate lands, so no one keeps a deny that nothing enforces. */
export const NOT_YET = "permissions arrive with the tool gate";

/** The issues of `value` as a settings map, its fields under `at` (none: a body's own): each capability that has a
 *  choice to `{provider?}`, the provider one offered for it. */
export function settingsIssues(value: unknown, at = ""): InputIssue[] {
  const field = (...names: string[]) => [at, ...names].filter(Boolean).join(".");
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlain(value)) return [{ field: at || "body", reason: "wrong_type", message: `${at || "the body"} is an object of ${PICKABLE.join(", ")} to their settings` }];
  return Object.entries(value).flatMap(([name, setting]): InputIssue[] => {
    if (!Object.hasOwn(PROVIDERS, name)) return [{ field: field(name), reason: "not_allowed", message: `Tool settings are kept for ${PICKABLE.join(" and ")}; ${name} is not one of them.` }];
    if (!isPlain(setting)) return [{ field: field(name), reason: "wrong_type", message: `${field(name)} is an object, {provider}` }];
    return Object.entries(setting).flatMap(([key, given]): InputIssue[] => {
      if (key === "permission") return [{ field: field(name, key), reason: "not_yet", message: NOT_YET }];
      if (key !== "provider") return [{ field: field(name, key), reason: "not_allowed", message: `${field(name)} keeps no field ${key}.` }];
      const offered: readonly string[] = PROVIDERS[name as Pickable];
      return offered.includes(given as string) ? [] : [{ field: field(name, key), reason: "not_an_option", message: `${field(name, key)} is one of ${offered.join(", ")}` }];
    });
  });
}

/** `map` with each capability's provider, its default where none is picked. */
export const withDefaults = (map: ToolSettingsMap): Record<Pickable, { provider: string }> =>
  Object.fromEntries(PICKABLE.map((name) => [name, { provider: map[name]?.provider ?? PROVIDERS[name][0] }])) as Record<Pickable, { provider: string }>;

/** The server's tool settings, beside the agent store in its data directory: not a secret, and not in store.sqlite,
 *  which runs hold open. Read once at the start, written whole and durably (0600) at each PUT; a missing file is every
 *  default, and so is one it cannot read, which it says in one line. */
export class ToolSettings {
  static readonly FILE = "tool-settings.json";
  private current: ToolSettingsMap;
  constructor(private readonly dir: string, warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)) {
    const file = join(dir, ToolSettings.FILE);
    let read: unknown = {};
    try {
      read = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") read = undefined;
    }
    const bad = read === undefined || settingsIssues(read).length > 0;
    if (bad) warn(`agentrun-serve: ${file} is not tool settings this server reads; every tool takes its default provider until a PUT /v2/settings/tools`);
    this.current = bad ? {} : (read as ToolSettingsMap);
  }

  get(): ToolSettingsMap {
    return structuredClone(this.current);
  }

  /** Replaces the settings: a capability `map` leaves out takes its default. Durable before it returns. */
  put(map: ToolSettingsMap): ToolSettingsMap {
    const kept = Object.fromEntries(PICKABLE.flatMap((name) => (map[name]?.provider ? [[name, { provider: map[name]!.provider }]] : []))) as ToolSettingsMap;
    writeDurableSync(join(this.dir, ToolSettings.FILE), `${JSON.stringify(kept)}\n`);
    this.current = kept;
    return this.get();
  }
}

/** GET /v2/agents/{id}'s `tools`: each tool its current revision grants, in `order` (capabilities.tools'), and for one
 *  with a provider choice the provider in force and where it came from (the agent's own settings, the server's, or the
 *  default), the one that applies when the agent sets none (the server's), and what it resolves to on the agent's
 *  harness and model. A tool with no choice is its name alone. */
export function agentTools(env: NodeJS.ProcessEnv, settings: ToolSettingsMap, agent: Tooling, order: readonly string[]) {
  const plane = planeFor(env, agent, settings);
  const rank = (name: string) => order.indexOf(capabilityOf(name)) + (name in LEGACY_NAMES ? 0.5 : 0);
  return [...new Set(agent.tools)].sort((a, b) => rank(a) - rank(b)).map((name) => {
    const capability = capabilityOf(name);
    if (!Object.hasOwn(PROVIDERS, capability)) return { name };
    const pick = capability as Pickable;
    const own = agent.overrides?.[pick]?.provider;
    const server = settings[pick]?.provider;
    return { name, provider: own ?? server ?? PROVIDERS[pick][0], provider_from: own ? "agent" : server ? "server" : "default", default_provider: server ?? PROVIDERS[pick][0], resolved: plane[pick]! };
  });
}
