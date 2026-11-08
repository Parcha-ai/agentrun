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
// the gate's one rule, permissionOf. A capability set to deny resolves to no provider where it is shown; under ask, a
// harness's own search (inside its CLI, where no call can wait for a person) gives way to the kernel's. A run is never
// told a deny: its Plane resolves a denied capability as under ask, and the gate, which reads the permission at each
// call, is the one place that refuses it, so a deny lifted mid-run is lifted at the next call.
import { blurbOf } from "./tool-blurbs.js";
import { readFileSync } from "node:fs";
import { isToolSettingsKey } from "@parcha/pi-durable-agent";
import { join } from "node:path";
import { decisionKeysOf, PARALLEL_KEY_ENV } from "./decisions.js";
import { keyNeeded } from "./key-words.js";
import type { InputIssue } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessId } from "./harness.js";
import { builtinHarness, harnessOf } from "./harness-table.js";
import { viaOpenRouter, WIRES } from "./provider.js";
import { savedIn } from "./secrets.js";
import { hostModel } from "./model.js";
import { defaultPermission, isCatalogTool, isMcpTool, type Permission, PERMISSIONS, permissionFrom, permissionOf, SHELL_FAMILY } from "./tool-gate.js";

/**
 * The capabilities a pack or a revision may grant, by name: the tools the kernel gives a run, bound from serve's closed
 * table (tools.ts) and named the same on every harness that runs them. `web_search` and `web_fetch` resolve to a
 * provider (PROVIDERS); the rest are the kernel's own. Not capabilities: the workflow call nodes' `pdf_pages` and `llm` (a workflow's call node names them, a grant
 * never does), and a catalog's tools (`monid.*`, `mcp:<server>/<tool>`: catalog tools, which their catalog grants).
 */
export const CAPABILITIES = ["read", "write", "edit", "web_search", "web_fetch", "browser", "ask_person"] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** The providers a user may pick for each capability that has a choice, its default first: `auto`, the native search
 *  where there is one (never on claude-agent, where Claude's own search is picked as `native`), else Parallel where the
 *  server holds its key, else keyless Exa; `native`, the harness's own tool or its model provider's hosted one, and
 *  nothing else; `exa-keyless`, Exa's public MCP endpoint, no key; `kernel`, the guarded direct fetch; `parallel`,
 *  Parallel's Search and Extract APIs on PARALLEL_API_KEY; `off`, web_search turned off: nothing is searched, and an
 *  agent naming it is refused until it is turned on again. The browser's: `auto`, Browserbase where the server holds its
 *  keys, else Kernel where it holds Kernel's; `browserbase` or `kernel`, that one alone; `chrome`, a Chrome on the
 *  server's own host, which no server sets up yet (browserBy). */
export const PROVIDERS = Object.freeze({ web_search: ["auto", "native", "exa-keyless", "parallel", "off"], web_fetch: ["kernel", "parallel"], browser: ["auto", "browserbase", "kernel", "chrome"] } as const);
export type Pickable = keyof typeof PROVIDERS;
export const PICKABLE = Object.keys(PROVIDERS) as Pickable[];
/** Every tool of serve's table (tools.ts), by name, so this module needs no import of it: a test holds the two as one. */
export const TABLE_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "ask_person", "web_fetch", "web_search", "browser", "pdf_pages", "llm"];
/** The tools whose approved call the kernel runs itself, outside the model's turn (host-tools.ts's REPLAY): ask is
 *  offered for these and for catalog tools. Any other (browser, ask_person, the call-only ones) is allow or deny. The
 *  run's learned_workflow is one (tool-gate.ts runs an approved call of it on the run's own tools). */
export const ASKABLE: readonly string[] = ["read", "write", "edit", "bash", "web_fetch", "web_search", "learned_workflow"];
/** The permissions `name` may be set to. */
export const permissionsOf = (name: string): readonly Permission[] => (Object.hasOwn(SHELL_FAMILY, name) && SHELL_FAMILY[name] !== name ? permissionsOf(SHELL_FAMILY[name]!) : ASKABLE.includes(name) || isCatalogTool(name) ? PERMISSIONS : ["allow", "deny"]);
/** A tool's permission as this server applies it to an agent that sets none, as capabilities and an MCP server's read
 *  give it: the one in force under the server's settings (`permission`), the owner's default (`default_permission`) and
 *  those it may be set to. An agent's read gives the same, the agent's own layer over it (agentTools). */
export const serverGate = (name: string, settings: ToolSettingsMap) => ({ permission: permissionOf(name, settings as never), default_permission: defaultPermission(name), permissions: [...permissionsOf(name)] });
/** The run's own tools beyond the table, each its own settings key, allowed by default like a table tool: the learned
 *  workflow a run's pin names runs as `learned_workflow` (learned-workflow.ts LEARNED_WORKFLOW_TOOL). */
export const SERVE_OWN_TOOLS: readonly string[] = ["learned_workflow"];

/** A settings key: a tool of the table, one of the run's own tools (SERVE_OWN_TOOLS), a catalog tool (`monid.<tool>`,
 *  `mcp:<server>/<tool>`), or an MCP server's wildcard (`mcp:<server>/*`), which sets each of its tools. */
const isSettingsKey = (name: string): boolean => isToolSettingsKey(name) && (TABLE_TOOLS.includes(name) || SERVE_OWN_TOOLS.includes(name) || isCatalogTool(name) || /^mcp:[^/]+\/\*$/.test(name));
/** One tool's settings: its provider (a capability that has a choice) and its permission. */
export type ToolSetting = { provider?: string; permission?: Permission; /** Read as a stand-in for a value not offered (readToolSettings); never shown or written. */ fallback?: true; /** The stand-in's value as written in the file, which a save that keeps the stand-in writes back (ToolSettings.put). Never shown. */ raw?: unknown };
/** The tools' settings, the server's (`/v2/settings/tools`) and an agent's own (`definition.tool_settings`), one shape:
 *  by settings key. */
export type ToolSettingsMap = Partial<Record<string, ToolSetting>>;
/** What a capability resolves to on a run: the native tool, the kernel's own, keyless Exa, Parallel, or why not. */
export type Resolution = "native" | "kernel" | "exa-keyless" | "parallel" | "browserbase" | `unavailable: ${string}`;
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
  /** Which of the browser's providers the server holds the keys of (BROWSER_KEYS); none given, neither. */
  browserKeys?: Record<BrowserVendor, boolean>;
  /** The run has a spend cap: Codex's own search sends a request with no input bound, which a cap cannot admit. */
  capped?: boolean;
  /** The harness's model requests go through OpenRouter (provider.ts' viaOpenRouter), where its own search does not run. */
  openRouter?: boolean;
  /** Its permission in force (tool-gate.ts); absent, allow. */
  permission?: Permission;
};

/** Whether a harness's own search, `native` in its facts (the provider's search tool, through its proxy), has per-use fees
 *  a spend cap cannot reserve yet; `live` (the harness's own, booked per call) sends a request with no input bound. */
const cappedOwn = (id: string, label: string, mode: "native" | "live"): { id: string; why: string } =>
  mode === "native"
    ? { id: `${id} under a spend cap: ${label}'s own search has per-use fees a spend cap cannot reserve yet, so web_search works under a cap through the default provider, auto`, why: `under a spend cap ${label}'s own search is not offered, since a cap cannot reserve its per-use fees yet` }
    : { id: `${id} under a spend cap`, why: `under a spend cap ${label}'s own search is not offered, since its request has no input bound` };

/** The facts of the adapter `harness` runs on (none for pi): its own search, its wire. A stand-in keeps the facts of the
 *  harness it stands in for (harness-table.ts). */
const factsOf = (harness: string) => builtinHarness(harness)?.facts;

/** Whether a run on `harness` sends through OpenRouter, where a harness's own search does not run: false for one with
 *  none (and for pi, whose hosted search is asked of the model's provider). */
export const ownSearchViaOpenRouter = (env: NodeJS.ProcessEnv, harness: string, model?: string): boolean => {
  const facts = harnessOf(env, harness)?.facts;
  return facts?.webSearch ? viaOpenRouter(facts.wire, env, model) : false;
};

/** Why a run of `input` has no native search, where it has none: `id`, as the unavailable text names it, and `why`, the
 *  same in a sentence (capabilities' `why`). */
function noNative(input: ResolveInput): { id: string; why: string } | undefined {
  // Native, where there is one: a harness's own (its facts' webSearch), else pi's, which asks Anthropic's or OpenAI's. A
  // harness's own search goes with its request on its wire, except on OpenRouter (which runs no harness's own search, nor
  // counts its searches), behind serve's gateway on the wire it serves (no known hosted search), or under a spend cap
  // (cappedOwn: per-use fees the cap cannot reserve yet, its request's bound holding the pages' input tokens, not the
  // fees; or a request with no input bound). A harness with none (OpenCode, whose proxy policy refuses a
  // provider-hosted tool) has none at all. Where there is none, `native` is unavailable, and `auto` goes to Parallel on
  // the server's key (its fee booked and held by a cap, paid-calls.ts), else to keyless Exa.
  const vendor = input.model?.slice(0, Math.max(0, input.model.indexOf("/")));
  const facts = factsOf(input.harness);
  if (facts) {
    if (!facts.webSearch) return { id: `${input.harness}, whose model requests carry no provider-hosted tool`, why: `${facts.label}'s model requests carry no provider-hosted tool` };
    if (input.openRouter) return { id: `${input.harness} on OpenRouter`, why: `through OpenRouter ${facts.label}'s own search is not run, and its searches are not counted to price` };
    if (input.gateway && WIRES[facts.wire].gateway) return { id: `${input.harness} behind a gateway`, why: `behind a gateway ${facts.label} has no own search` };
    return input.capped ? cappedOwn(input.harness, facts.label, facts.webSearch) : undefined;
  }
  if (input.gateway) return { id: `${input.harness} behind a gateway`, why: `behind a gateway ${input.harness} has no hosted search` };
  if (vendor && HOSTED_SEARCH_PROVIDERS.includes(vendor)) return undefined;
  return input.model ? { id: input.model, why: `${input.model} has no hosted search here` } : { id: "a model with none named", why: "no model is named, so there is no hosted search" };
}

/** The native search of a run that has one, in a sentence. */
const nativeWhy = (input: ResolveInput): string => {
  const facts = factsOf(input.harness);
  return facts?.webSearch ? `${facts.label}'s own search` : `${input.model?.startsWith("openai/") ? "OpenAI" : "Anthropic"}'s hosted search, for ${input.model}`;
};

/** What `capability` resolves to on a run of `input`, and why in a plain sentence (capabilities' `why`): one rule, so
 *  the two never disagree. */
export function explainCapability(capability: Pickable, input: ResolveInput): { resolves: Resolution; why: string } {
  const chosen = input.override ?? input.pick ?? PROVIDERS[capability][0];
  const picked = input.override !== undefined ? "picked for this agent" : "picked in settings";
  const key = `your Parallel key (${input.parallelKeyFrom ?? "server"})`;
  if (input.permission === "deny") return { resolves: DENIED, why: "set to deny: the gate refuses each call" };
  if (chosen === "off") return { resolves: SEARCH_OFF, why: "turned off in settings" };
  if (chosen === "parallel") return input.parallelKey ? { resolves: "parallel", why: `Parallel, ${picked}: ${key}` } : { resolves: NO_PARALLEL_KEY, why: `Parallel is picked, and it needs ${keyNeeded([PARALLEL_KEY_ENV])}` };
  if (capability === "web_fetch") return { resolves: "kernel", why: "the guarded direct fetch" };
  if (capability === "browser") return browserBy(chosen, picked, input.browserKeys);
  if (chosen === "exa-keyless") return { resolves: "exa-keyless", why: `keyless Exa, ${picked}: Exa's free search, no key` };
  // Under ask, a harness's own search runs inside its CLI, where no call can wait for a person: none on claude-agent or
  // codex then, and the kernel's search, which the gate holds, in its place. pi's is a tool of the run's, which it holds.
  const asks = input.permission === "ask" && factsOf(input.harness) !== undefined;
  const without = noNative(input);
  if (chosen === "native" && asks && without === undefined) return { resolves: NATIVE_ASKS, why: "native search cannot wait for an approval: it runs inside the harness's CLI" };
  const none = without ?? (asks ? { id: input.harness, why: "under ask the harness's own search cannot wait for a person's approval" } : undefined);
  if (chosen === "native") return none === undefined ? { resolves: "native", why: nativeWhy(input) } : { resolves: `unavailable: no native search for ${none.id}`, why: `no native search for ${none.id}` };
  // `auto` skips a harness's own search that has per-use fees (its facts' `native`: the provider's search tool), an
  // explicit pick (`native`): Parallel on the server's key, else keyless Exa.
  const facts = factsOf(input.harness);
  if (facts?.webSearch === "native") return input.parallelKey ? { resolves: "parallel", why: key } : { resolves: "exa-keyless", why: `Exa's free keyless search, no key; ${facts.label}'s own search is an explicit pick` };
  if (none === undefined) return { resolves: "native", why: nativeWhy(input) };
  return input.parallelKey ? { resolves: "parallel", why: `${none.why}; ${key}` } : { resolves: "exa-keyless", why: `${none.why}; Exa's free keyless search, no key` };
}

/** What `capability` resolves to on a run of `input`. */
export const resolveCapability = (capability: Pickable, input: ResolveInput): Resolution => explainCapability(capability, input).resolves;

export const isUnavailable = (resolution: Resolution | undefined): resolution is `unavailable: ${string}` => resolution?.startsWith("unavailable: ") === true;
/** Why a resolution is unavailable: its words after "unavailable: " (any other resolution as it is). */
/** Why `resolution` is unavailable, in words. A vendor picked whose key this server does not hold (its value, kept in a
 *  run's meta and read back, names the variables) names where to save the key first, then the variable to set. */
export const whyUnavailable = (resolution: string): string => {
  if (resolution === NO_BROWSER_KEY) return `it needs ${keyNeeded(BROWSER_KEYS.browserbase)}, or ${keyNeeded(BROWSER_KEYS.kernel)}`;
  const why = resolution.replace(/^unavailable: /, "");
  const picked = /^(\S+) picked, no (.+)$/.exec(why);
  return picked ? `${picked[1]} is picked, and it needs ${keyNeeded(picked[2]!.split(" and "))}` : why;
};

/** The keys each of the browser's vendors needs, by name: a tool key's fields (tool-keys.ts), set or saved. Its plane
 *  value is the vendor's id: `kernel` on browser is Kernel's hosted browser, never the guarded fetch web_fetch calls so. */
export const BROWSER_KEYS = Object.freeze({ browserbase: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"], kernel: ["KERNEL_API_KEY"] } as const);
type BrowserVendor = keyof typeof BROWSER_KEYS;
const LABELS: Record<BrowserVendor, string> = { browserbase: "Browserbase", kernel: "Kernel" };
const isVendor = (name: unknown): name is BrowserVendor => name === "browserbase" || name === "kernel";
const browserKeysOf = (env: NodeJS.ProcessEnv): Record<BrowserVendor, boolean> => ({ browserbase: BROWSER_KEYS.browserbase.every((name) => Boolean(env[name])), kernel: BROWSER_KEYS.kernel.every((name) => Boolean(env[name])) });
/** A vendor picked whose keys the server does not hold: unavailable, never the other vendor. */
const noBrowserKey = (vendor: BrowserVendor): Resolution => `unavailable: ${vendor} picked, no ${BROWSER_KEYS[vendor].join(" and ")}`;
/** The keys a browser that resolves to `resolution` runs on: its vendor's (BROWSER_KEYS), none for no vendor. */
export const browserNeeds = (resolution: string | undefined): readonly string[] => (isVendor(resolution) ? BROWSER_KEYS[resolution] : []);
/** `auto` where the server holds neither vendor's keys. */
export const NO_BROWSER_KEY: Resolution = "unavailable: no browser key: set or save Browserbase's (BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID) or Kernel's (KERNEL_API_KEY)";
/** `chrome` picked: a Chrome on the server's own host, refused by name until a server can set one up. */
export const NO_CHROME: Resolution = "unavailable: a local Chrome is not set up on this server";

/** The browser `chosen` (picked as `picked` says) resolves to with the vendors' `keys`: `auto` is Browserbase where its
 *  keys are held, else Kernel where its key is, else unavailable; a vendor picked is that vendor or unavailable; `chrome`
 *  is unavailable by name. */
function browserBy(chosen: string, picked: string, keys: Record<BrowserVendor, boolean> = { browserbase: false, kernel: false }): { resolves: Resolution; why: string } {
  if (chosen === "chrome") return { resolves: NO_CHROME, why: whyUnavailable(NO_CHROME) };
  if (isVendor(chosen)) return keys[chosen] ? { resolves: chosen, why: `${LABELS[chosen]}, ${picked}` } : { resolves: noBrowserKey(chosen), why: `${LABELS[chosen]} is picked, and it needs ${keyNeeded(BROWSER_KEYS[chosen])}` };
  if (keys.browserbase) return { resolves: "browserbase", why: "Browserbase: its key is set or saved" };
  if (keys.kernel) return { resolves: "kernel", why: "Kernel: its key is set or saved, and Browserbase's is not" };
  return { resolves: NO_BROWSER_KEY, why: whyUnavailable(NO_BROWSER_KEY) };
}

/** The server's environment's part of every resolution: its gateway and Parallel's key, and where the key is from. */
const served = (env: NodeJS.ProcessEnv) => {
  const parallelKey = PARALLEL_KEY_ENV in decisionKeysOf(env);
  return { gateway: Boolean(env.AGENT_MODEL_BASE_URL), parallelKey, browserKeys: browserKeysOf(env), ...(parallelKey ? { parallelKeyFrom: savedIn(env).has(PARALLEL_KEY_ENV) ? ("saved" as const) : ("server" as const) } : {}) };
};

/** Each pickable capability on each harness under the server's `settings` and an agent's `overrides`, on `model`
 *  (default each harness's host model, the one a run that names none runs on: hostModel): what it resolves to and why, as
 *  capabilities and the tool catalog show them. */
export function explainsView(env: NodeJS.ProcessEnv, settings: ToolSettingsMap, overrides: ToolSettingsMap = {}, model?: string): Record<Pickable, { resolves: Record<HarnessId, Resolution>; why: Record<HarnessId, string> }> {
  return Object.fromEntries(PICKABLE.map((name) => {
    const input = { ...served(env), ...picked(name, settings, overrides) };
    const each = HARNESSES.map((harness) => {
      const on = model ?? hostModel(env, "default", harness);
      return [harness, explainCapability(name, { ...input, ...(on ? { model: on } : {}), harness, openRouter: ownSearchViaOpenRouter(env, harness, on) })] as const;
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
/** `approvals`: the revision's, kept only when "never" (the agent runs unattended: an ask is an allow, never over a deny). */
export type Tooling = { harness?: string; tools: readonly string[]; model?: string; overrides?: ToolSettingsMap; workflow?: true; approvals?: "never" };

/** The run's process's description of its tools' providers: JSON of its Plane. */
export const TOOL_PLANE_ENV = "AGENTRUN_SERVE_TOOL_PLANE";

/** The Plane of a run of `tooling`, in the server's `env` (with its secrets) under its `settings`. `run`: the Plane a
 *  run's process is handed, where a capability set to deny resolves as under ask (the provider a held call would use),
 *  since the gate refuses its calls while it is denied; else the one shown and checked, where it resolves denied. */
export function planeFor(env: NodeJS.ProcessEnv, tooling: Tooling, settings: ToolSettingsMap, { capped = false, run = false }: { capped?: boolean; run?: boolean } = {}): Plane {
  const harness = tooling.harness ?? DEFAULT_HARNESS;
  // A workflow's model nodes may each run on another tier's model, and a native search asks one model's provider: a
  // workflow's search resolves with no model (keyless Exa, or Parallel where picked), never on a model a node may not use.
  // A run that names no model runs on the host's for its harness (hostModel: a model key's default when no AGENT_MODEL
  // it runs is set), so its search resolves on that one.
  const model = tooling.workflow ? undefined : (tooling.model ?? hostModel(env, "default", harness));
  const plane: Plane = {};
  const granted = tooling.tools;
  for (const name of PICKABLE) {
    if (!granted.includes(name)) continue;
    const chosen = picked(name, settings, tooling.overrides);
    plane[name] = resolveCapability(name, { ...served(env), harness, capped, openRouter: ownSearchViaOpenRouter(env, harness, model), ...(model ? { model } : {}), ...chosen, ...(run && chosen.permission === "deny" ? { permission: "ask" as const } : {}) });
  }
  // The model a search through its provider's hosted search asks (hosted-search.ts): pi's own web_search, and on
  // another harness, whose agent searches with its own tool, a learned workflow's call node (learned-workflow.ts).
  if (plane.web_search === "native" && model) plane.model = model;
  return plane;
}

/** A run's kept Plane at a later launch: as it was, but Parallel, or the browser's vendor, where the server no longer
 *  holds its key, which is unavailable, never another provider; and, given `now` (the Plane it would get today and each
 *  capability's permission today), a capability set to ask or deny, or kept denied, as it resolves today: a harness's
 *  own search cannot wait for a person, and a deny that was lifted is lifted. The browser keeps its vendor, whose
 *  sessions it has: only a deny it was kept with is lifted. */
export function recheckPlane(plane: Plane, env: NodeJS.ProcessEnv, now?: { fresh: Plane; permission: (name: Pickable) => Permission }): Plane {
  const keyed = served(env).parallelKey;
  return Object.fromEntries(Object.entries(plane).map(([name, value]) => {
    const fresh = name === "model" ? undefined : now?.fresh[name as Pickable];
    if (fresh !== undefined && (value === DENIED || (name !== "browser" && now!.permission(name as Pickable) !== "allow"))) return [name, fresh];
    return [name, name === "browser" && isVendor(value) && !browserKeysOf(env)[value] ? noBrowserKey(value) : value === "parallel" && !keyed ? NO_PARALLEL_KEY : value];
  })) as Plane;
}

/** The Plane kept for a run made before its plane was kept, resolved at a later launch (runs.ts): its browser stays
 *  Browserbase, the one vendor there was then, never today's pick, which could check its sessions at another vendor. It
 *  keeps the vendor, never a refusal: the plane each launch hands over is checked again (recheckPlane), so Browserbase's
 *  keys missing make it unavailable for that launch alone, and restored keys make the next one run. */
export const keptFromBefore = (plane: Plane): Plane => (plane.browser === undefined ? plane : { ...plane, browser: "browserbase" });

/** A run's saved Plane as a launch reads it: a vendor's missing-key refusal an earlier server saved (noBrowserKey's exact
 *  words, Browserbase's or Kernel's) is that vendor again, which the launch checks again as usual (recheckPlane), so
 *  restored keys make it run. Every other saved value stays as it is: `auto` with no key at a run's first launch
 *  (NO_BROWSER_KEY) and `chrome` stay frozen. The same Plane where nothing changes. */
export function keptVendor(plane: Plane): Plane {
  const vendor = (Object.keys(BROWSER_KEYS) as BrowserVendor[]).find((name) => plane.browser === noBrowserKey(name));
  return vendor ? { ...plane, browser: vendor } : plane;
}

/** The key row (tool-keys.ts) of the browser's vendor on `resolution` with `picked` the provider in force: Kernel's where
 *  Kernel is picked or resolved, else Browserbase's, so a page links a missing key to the row it is saved on. */
export const browserKeyRow = (picked: string | undefined, resolution: string | undefined): "kernel" | "browserbase" => (picked === "kernel" || resolution === "kernel" ? "kernel" : "browserbase");

/** The Plane a run's process is handed at a launch, under the server's `settings` now: its kept Plane (as keptVendor
 *  reads it) checked again (recheckPlane) against the one it would get today; with none kept, today's, its browser kept
 *  (keptFromBefore). At a launch after its first (a relaunch, a follow-up's, one after a restart) a capability set
 *  to deny is handed denied (planeFor without `run`), the tool's own refusal backing the gate's; at its `first`, as
 *  under ask, so a deny lifted while that process lives is lifted at the next call. */
export function relaunchPlane(kept: Plane | undefined, env: NodeJS.ProcessEnv, tooling: Tooling | undefined, settings: ToolSettingsMap, { capped = false, first = false }: { capped?: boolean; first?: boolean } = {}): Plane {
  const fresh = tooling ? planeFor(env, tooling, settings, { capped, run: first }) : {};
  if (kept) return recheckPlane(kept, env, { fresh, permission: (name) => permissionOf(name, settings, tooling?.overrides ?? {}) });
  return tooling ? recheckPlane(keptFromBefore(fresh), env) : {};
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
    if (!isSettingsKey(name)) return [{ field: field(name), reason: "not_allowed", message: `Tool settings are kept for this server's tools (${[...TABLE_TOOLS, ...SERVE_OWN_TOOLS].join(", ")}), catalog tools (monid.<tool>, mcp:<server>/<tool>) and an MCP server's tools (mcp:<server>/*); ${name} is none of them.` }];
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
  // As served: what is in force, never the internal mark of a stand-in.
  ...Object.fromEntries(Object.entries(map).map(([name, setting]) => [name, setting && { ...(setting.provider ? { provider: setting.provider } : {}), ...(setting.permission ? { permission: setting.permission } : {}) }])),
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
      if (offered.includes(setting.permission as Permission)) kept.permission = setting.permission as Permission;
      else {
        // Its fail-closed stand-in, marked so: an ask nobody set lets nothing run unasked (tool-gate.ts SHELL_WATCHERS).
        kept.permission = offered.includes("ask") ? "ask" : "deny";
        kept.fallback = true;
        kept.raw = setting.permission;
      }
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
      const set: ToolSetting = { ...(setting?.provider ? { provider: setting.provider } : {}), ...(setting?.permission ? { permission: setting.permission } : {}) };
      // A stand-in sent back as served (a client saves the whole map) is no choice: it stays a stand-in, and the file keeps
      // the value as written, so neither this save nor a restart turns it into a permission set (tool-gate.ts
      // SHELL_WATCHERS). A different permission is a choice, written as given.
      const before = this.current[name];
      if (before?.fallback && set.permission === before.permission) Object.assign(set, { fallback: true, raw: before.raw });
      return Object.keys(set).length ? [[name, set]] : [];
    }));
    const written = Object.fromEntries(Object.entries(kept).map(([name, setting]) => [name, { ...(setting!.provider ? { provider: setting!.provider } : {}), ...(setting!.fallback ? { permission: setting!.raw } : setting!.permission ? { permission: setting!.permission } : {}) }]));
    writeDurableSync(join(this.dir, ToolSettings.FILE), `${JSON.stringify(written)}\n`);
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
  const rank = (name: string) => order.indexOf(name);
  return [...new Set(agent.tools)].sort((a, b) => rank(a) - rank(b)).map((name) => {
    const { permission, from } = permissionFrom(name, settings as never, (agent.overrides ?? {}) as never, agent.approvals ?? "ask");
    const gate = { permission, permission_from: from, default_permission: permissionOf(name, settings as never), permissions: [...permissionsOf(name)] };
    // One short line for people (tool-blurbs.ts), as capabilities serves it.
    const blurb = blurbOf(name);
    const shown = { name, ...(blurb ? { blurb } : {}) };
    if (!Object.hasOwn(PROVIDERS, name)) return { ...shown, ...gate };
    const pick = name as Pickable;
    const own = agent.overrides?.[pick]?.provider;
    const server = settings[pick]?.provider;
    return { ...shown, ...gate, provider: own ?? server ?? PROVIDERS[pick][0], provider_from: own ? "agent" : server ? "server" : "default", default_provider: server ?? PROVIDERS[pick][0], resolved: plane[pick]! };
  });
}
