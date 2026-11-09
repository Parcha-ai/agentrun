import type { AgentTool, Permission, ToolSetting, ToolSettings } from "./v2";

/** The harnesses a capability resolves for, in the order the console shows them. */
export const HARNESS_ORDER = ["pi", "claude-agent", "codex", "opencode"] as const;

/** A capability with a provider choice (`capabilities.tools`, providers/1): the providers offered, the built-in default
 *  first; the server's pick (`provider`); the built-in default; what it resolves to on each harness under the server's
 *  settings; and whether it runs here at all, with the server's reason when not (a provider of `off`, say). */
export type ToolChoice = { name: string; providers: string[]; provider: string; default_provider: string; resolves: Record<string, string>; available: boolean; reason?: string };

/** The tools a workflow's call nodes call (`node: "call"` with a `tool`, wherever it sits), once, sorted. A call node runs only the server's built-in call tools, never a catalog one. */
export function callNodeTools(workflow: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.node === "call" && typeof o.tool === "string") found.add(o.tool);
    Object.values(o).forEach(walk);
  };
  walk(workflow);
  return [...found].sort();
}

/** The tools a 409 `agent_not_runnable` names as stopping a workflow's call nodes (approvals/1): `denied`, set to
 *  deny; `asks`, set to ask, which a call node can't wait for. Each is an array of settings keys, present only when not
 *  empty. */
export function toolBlockers(details: Record<string, unknown> | null | undefined): { denied: string[]; asks: string[] } {
  const names = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v as string[])] : []);
  return { denied: names(details?.denied), asks: names(details?.asks) };
}

/** The capabilities that have a provider choice, in the server's order: `capabilities.tools` entries that carry one. */
export function toolChoices(raw: unknown): ToolChoice[] {
  return (Array.isArray(raw) ? raw : []).flatMap((t): ToolChoice[] => {
    const e = t as Partial<ToolChoice> | null;
    if (!e || typeof e.name !== "string" || !Array.isArray(e.providers) || !e.providers.length) return [];
    return [{
      name: e.name, providers: e.providers, provider: e.provider ?? e.providers[0], default_provider: e.default_provider ?? e.providers[0], resolves: e.resolves && typeof e.resolves === "object" ? e.resolves : {},
      available: e.available !== false, ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}),
    }];
  });
}

/** A tool's permission on this server (`capabilities.tools`, approvals/1): the one in force (its setting, else the owner's
 *  default), the owner's default, those it may be set to, and `ask_needs: "password"` where ask can't be answered here
 *  (accounts off: approving a call takes the owner's password sign-in). */
export type ToolGate = { name: string; permission: Permission; default_permission: Permission; permissions: Permission[]; ask_needs?: "password" };

/** Said wherever a tool the server's table denies shows: the server's deny is absolute (it holds over an agent's own
 *  allow or ask and over Never ask). */
export const SERVER_DENY = "Refused on this server for every agent, whatever the agent's own setting or Never ask.";

/** Whether this server denies `name` for every agent: its agent read says so (permission deny, from the server), or the
 *  server's table does (capabilities' permission in force). */
export const serverDenies = (name: string, gates: readonly ToolGate[], read?: readonly AgentTool[]): boolean => {
  const own = read?.find((t) => t.name === name);
  return (own?.permission === "deny" && own.permission_from === "server") || gates.some((g) => g.name === name && g.permission === "deny");
};

const PERMISSIONS: readonly string[] = ["allow", "ask", "deny"];
const isPermission = (v: unknown): v is Permission => typeof v === "string" && PERMISSIONS.includes(v);

/** Each tool's permission, in the server's order: `capabilities.tools` entries that carry one. None from an older server. */
export function toolGates(raw: unknown): ToolGate[] {
  return (Array.isArray(raw) ? raw : []).flatMap((t): ToolGate[] => {
    const e = t as { name?: unknown; permission?: unknown; default_permission?: unknown; permissions?: unknown; ask_needs?: unknown } | null;
    if (!e || typeof e.name !== "string" || !Array.isArray(e.permissions) || !e.permissions.length || !e.permissions.every(isPermission) || !isPermission(e.default_permission)) return [];
    return [{ name: e.name, permission: isPermission(e.permission) ? e.permission : e.default_permission, default_permission: e.default_permission, permissions: e.permissions, ...(e.ask_needs === "password" ? { ask_needs: "password" as const } : {}) }];
  });
}

const PROVIDER: Record<string, string> = { auto: "auto", native: "native", kernel: "kernel fetch", "exa-keyless": "Exa keyless", parallel: "Parallel" };
/** The browser's own names and help: its providers are another set from search's and fetch's, and two of its ids
 *  ("auto", "kernel") mean other things there. The ids and the auto rule are the server's: packages/serve/src/tool-plane.ts
 *  PROVIDERS.browser (auto, browserbase, kernel, chrome) and browserBy (auto is Browserbase where its keys are set or
 *  saved, else Kernel where its key is, else unavailable; chrome is not set up on any server yet); the keys are
 *  tool-keys.ts' browserbase and kernel rows. */
const BY_TOOL: Record<string, { label: Record<string, string>; help: Record<string, string> }> = {
  browser: {
    label: { auto: "Auto (Browserbase where its key is saved, else Kernel)", browserbase: "Browserbase", kernel: "Kernel", chrome: "Local Chrome" },
    help: {
      auto: "Browserbase where its key is set or saved, else Kernel where its key is; unavailable with neither.",
      browserbase: "Browserbase's hosted browser: needs the Browserbase key and project id.",
      kernel: "Kernel's hosted browser: needs the Kernel key.",
      chrome: "A Chrome on this server's own host. No server sets one up yet, so it stays unavailable.",
    },
  },
};
/** A provider's name as a person reads it, for `tool` where that tool names its own (the browser); one the console does
 *  not know is shown as the server names it. */
export const providerLabel = (provider: string, tool?: string) => (tool && BY_TOOL[tool]?.label[provider]) ?? PROVIDER[provider] ?? provider;

const HELP: Record<string, string> = {
  auto: "The harness's own search, or the model provider's hosted one, else keyless Exa.",
  native: "The harness's own search, or the model provider's hosted one, never a third party: unavailable where there is none.",
  "exa-keyless": "Exa's keyless search: no key, a third party.",
  parallel: "Parallel: needs the Parallel key.",
  kernel: "This server's own fetch, guarded against private addresses.",
};
/** What choosing a provider means, in a line, for `tool` where that tool says its own; none for one the console does not
 *  know. */
export const providerHelp = (provider: string, tool?: string): string | undefined => (tool && BY_TOOL[tool]?.help[provider]) ?? HELP[provider];

/** What a capability resolves to, said plainly: a provider's name, or the server's "unavailable: <reason>". */
export function resolution(value: string | undefined, tool?: string): { text: string; unavailable: boolean } {
  if (!value) return { text: "not known", unavailable: false };
  return value.startsWith("unavailable") ? { text: value, unavailable: true } : { text: providerLabel(value, tool), unavailable: false };
}

/** `settings` with `tool`'s `field` set to `value`, the tool's other setting kept. One equal to `fallback` (what applies
 *  when this layer sets none), or undefined, is no setting; a tool left with none goes. Never changes `settings`. */
function withField<K extends "provider" | "permission">(settings: ToolSettings, tool: string, field: K, value: ToolSettings[string][K] | undefined, fallback: string): ToolSettings {
  const { [tool]: old, ...rest } = settings;
  const { [field]: _gone, ...kept } = old ?? {};
  const next = value === undefined || value === fallback ? kept : { ...kept, [field]: value };
  return Object.keys(next).length ? { ...rest, [tool]: next } : rest;
}

/** `settings` with `tool`'s provider set to `provider`, its permission kept. One equal to `fallback` (what applies when this
 *  layer sets none: the built-in default for the server's, the server's for an agent's), or undefined, is no setting: the
 *  row takes its default again. Never changes `settings`. */
export const withProvider = (settings: ToolSettings, tool: string, provider: ToolSetting["provider"], fallback: string): ToolSettings => withField(settings, tool, "provider", provider, fallback);

/** `settings` with `tool`'s permission set to `permission`, its provider kept. One equal to `fallback` (the owner's default
 *  for the server's, the server's for an agent's), or undefined, is no setting. Never changes `settings`. */
export const withPermission = (settings: ToolSettings, tool: string, permission: Permission | undefined, fallback: Permission): ToolSettings => withField(settings, tool, "permission", permission, fallback);

/** The settings a layer sets, of `answer` (GET /v2/settings/tools gives every capability's provider, its default filled
 *  in, and each permission set): every key and every field as the server holds it, a key this page shows no row for (a
 *  catalog tool's, an MCP server's wildcard) and a field this console doesn't know included, but a capability's provider
 *  equal to its default, which is the default filled in. A PUT replaces the whole map, so a save made from these keeps
 *  what it does not change. */
export function ownSettings(answer: ToolSettings, choices: readonly ToolChoice[]): ToolSettings {
  const defaults = new Map(choices.map((c) => [c.name, c.default_provider]));
  return Object.fromEntries(Object.entries(answer).flatMap(([key, setting]) => {
    if (!setting || typeof setting !== "object") return [];
    const { provider, ...rest } = setting;
    const own = provider !== undefined && !(defaults.has(key) && provider === defaults.get(key)) ? { ...rest, provider } : rest;
    return Object.keys(own).length ? [[key, own]] : [];
  }));
}

/** A refused save's issues (`field` → message, as saveError keys them) for one tool under `prefix`
 *  (`definition.tool_settings` for an agent, none for the server's), and those for none of `shown`. */
export function issuesFor(fields: Record<string, string>, prefix: string, shown: readonly string[]): { byTool: Record<string, string[]>; rest: string[] } {
  const byTool: Record<string, string[]> = {};
  const rest: string[] = [];
  for (const [field, message] of Object.entries(fields)) {
    if (prefix && field !== prefix && !field.startsWith(`${prefix}.`) && !field.startsWith(`${prefix}/`)) continue;
    const tail = prefix ? field.slice(prefix.length + 1) : field;
    const tool = [...shown].sort((a, b) => b.length - a.length).find((c) => tail === c || tail.startsWith(`${c}.`) || tail.startsWith(`${c}/`));
    if (tool) (byTool[tool] ??= []).push(message);
    else rest.push(message);
  }
  return { byTool, rest };
}
