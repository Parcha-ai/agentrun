import type { Permission, ToolSettings } from "./v2";

/** The harnesses a capability resolves for, in the order the console shows them. */
export const HARNESS_ORDER = ["pi", "claude-agent", "codex"] as const;

/** A capability with a provider choice (`capabilities.tools`, providers/1): the providers offered, the built-in default
 *  first; the server's pick (`provider`); the built-in default; what it resolves to on each harness under the server's
 *  settings; and whether it runs here at all, with the server's reason when not (a provider of `off`, say). */
export type ToolChoice = { name: string; providers: string[]; provider: string; default_provider: string; resolves: Record<string, string>; available: boolean; reason?: string };

/** Older tool names a revision may still grant, and the capability each one is, as the server has them
 *  (packages/serve/src/tool-plane.ts, LEGACY_NAMES): `fetch_page` runs, and resolves, as web_fetch. */
const LEGACY_NAMES: Readonly<Record<string, string>> = { fetch_page: "web_fetch" };
/** The capability a granted tool name is: its legacy target, else itself. */
export const capabilityOf = (name: string): string => LEGACY_NAMES[name] ?? name;

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
/** A provider's name as a person reads it; one the console does not know is shown as the server names it. */
export const providerLabel = (provider: string) => PROVIDER[provider] ?? provider;

const HELP: Record<string, string> = {
  auto: "The harness's own search, or the model provider's hosted one, else keyless Exa.",
  native: "The harness's own search, or the model provider's hosted one, never a third party: unavailable where there is none.",
  "exa-keyless": "Exa's keyless search: no key, a third party.",
  parallel: "Parallel: needs the Parallel key.",
  kernel: "This server's own fetch, guarded against private addresses.",
};
/** What choosing a provider means, in a line; none for one the console does not know. */
export const providerHelp = (provider: string): string | undefined => HELP[provider];

/** What a capability resolves to, said plainly: a provider's name, or the server's "unavailable: <reason>". */
export function resolution(value: string | undefined): { text: string; unavailable: boolean } {
  if (!value) return { text: "not known", unavailable: false };
  return value.startsWith("unavailable") ? { text: value, unavailable: true } : { text: providerLabel(value), unavailable: false };
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
export const withProvider = (settings: ToolSettings, tool: string, provider: string | undefined, fallback: string): ToolSettings => withField(settings, tool, "provider", provider, fallback);

/** `settings` with `tool`'s permission set to `permission`, its provider kept. One equal to `fallback` (the owner's default
 *  for the server's, the server's for an agent's), or undefined, is no setting. Never changes `settings`. */
export const withPermission = (settings: ToolSettings, tool: string, permission: Permission | undefined, fallback: Permission): ToolSettings => withField(settings, tool, "permission", permission, fallback);

/** The settings a layer sets, of `answer` (GET /v2/settings/tools gives every capability's provider, its default filled
 *  in, and each permission set): a provider unlike its default, and every permission, by settings key, a key this page
 *  shows no row for (a catalog tool's, an MCP server's wildcard) included. A PUT replaces the whole map, so a save made
 *  from these keeps what it does not change. */
export function ownSettings(answer: ToolSettings, choices: readonly ToolChoice[]): ToolSettings {
  const defaults = new Map(choices.map((c) => [c.name, c.default_provider]));
  return Object.fromEntries(Object.entries(answer).flatMap(([key, setting]) => {
    const provider = setting?.provider !== undefined && defaults.has(key) && setting.provider !== defaults.get(key) ? setting.provider : undefined;
    const permission = isPermission(setting?.permission) ? setting.permission : undefined;
    const own = { ...(provider !== undefined ? { provider } : {}), ...(permission ? { permission } : {}) };
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
