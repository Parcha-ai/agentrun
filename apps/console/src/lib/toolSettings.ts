import type { ToolSettings } from "./v2";

/** The harnesses a capability resolves for, in the order the console shows them. */
export const HARNESS_ORDER = ["pi", "claude-agent", "codex", "opencode"] as const;

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

/** `settings` with `tool`'s provider set to `provider`. One equal to `fallback` (what applies when this layer sets none:
 *  the built-in default for the server's, the server's for an agent's), or undefined, is no setting: the row takes its
 *  default again. Never changes `settings`. */
export function withProvider(settings: ToolSettings, tool: string, provider: string | undefined, fallback: string): ToolSettings {
  const { [tool]: _old, ...rest } = settings;
  return provider === undefined || provider === fallback ? rest : { ...rest, [tool]: { provider } };
}

/** The settings a layer sets: of `answer` (GET /v2/settings/tools gives every capability, its default filled in), those
 *  unlike their default. */
export function ownSettings(answer: ToolSettings, choices: readonly ToolChoice[]): ToolSettings {
  return Object.fromEntries(choices.flatMap((c) => (answer[c.name]?.provider && answer[c.name]!.provider !== c.default_provider ? [[c.name, { provider: answer[c.name]!.provider! }]] : [])));
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
