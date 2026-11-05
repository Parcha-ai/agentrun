import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { capabilityOf, HARNESS_ORDER, issuesFor, providerHelp, providerLabel, resolution, type ToolChoice, type ToolGate, withPermission, withProvider } from "@/lib/toolSettings";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/agentForm";
import type { Permission, ToolSettings } from "@/lib/v2";

/** One row of a tools table: a tool, with its provider choice (`choice`) where it has one and its permission (`gate`)
 *  where the server offers one. */
export type ToolRow = { name: string; choice?: ToolChoice; gate?: ToolGate; follows?: string };

/** `choices` and `gates` as one table's rows, one per name, in `order` (capabilities.tools'), then any other. */
export function toolRows(choices: readonly ToolChoice[], gates: readonly ToolGate[], order: readonly string[] = gates.map((g) => g.name)): ToolRow[] {
  const names = [...new Set([...order.filter((n) => choices.some((c) => c.name === n) || gates.some((g) => g.name === n)), ...gates.map((g) => g.name), ...choices.map((c) => c.name)])];
  return names.map((name) => {
    const choice = choices.find((c) => c.name === name);
    const gate = gates.find((g) => g.name === name);
    // A legacy name (fetch_page) is held to its capability's permission (web_fetch's): it follows that row's.
    const follows = capabilityOf(name) !== name ? capabilityOf(name) : undefined;
    return { name, ...(choice ? { choice } : {}), ...(gate && !follows ? { gate } : {}), ...(gate && follows ? { follows } : {}) };
  });
}

/** Said once above a table where ask can't be answered: accounts off. */
export const ASK_OFF = "Ask is off on this server: approving a call takes the owner's password sign-in, and this server runs with accounts off.";

/** One table of tools, the server's and an agent's alike: per tool its provider, where it has a choice, from the ones
 *  offered in the server's order (the default first, and named so), and what it resolves to; and its permission (allow,
 *  ask, deny), where the server offers one, the layer's default named. A setting unlike the layer's default
 *  (`fallbackOf` for a provider, `permissionFallbackOf` for a permission: the built-in default for the server's, the
 *  server's for an agent's) is marked; a provider's row can be reset, a permission goes back by choosing its default.
 *  Ask, where it can't be answered here (`ask_needs`), is offered disabled, with why. */
export function ToolTable({ label, rows, settings, fallbackOf, permissionFallbackOf = (g) => g.default_permission, resolvesOf, issues, busy = false, onEdit }: {
  label: string;
  rows: ToolRow[];
  settings: ToolSettings;
  fallbackOf: (row: ToolChoice) => string;
  permissionFallbackOf?: (gate: ToolGate) => Permission;
  resolvesOf: (row: ToolChoice, provider: string) => ReactNode;
  issues: Record<string, string[]>;
  busy?: boolean;
  /** A person's change of one key's one field, as an edit of the whole map: applied to the map as it is when it is
   *  saved (a read-modify-write), so every other key and field is written back as it was. */
  onEdit: (edit: (current: ToolSettings) => ToolSettings) => void;
}) {
  const providers = rows.some((r) => r.choice);
  const permissions = rows.some((r) => r.gate || r.follows);
  const askOff = rows.some((r) => r.gate?.ask_needs === "password");
  const heads = ["Tool", ...(providers ? ["Provider"] : []), ...(permissions ? ["Permission"] : []), ...(providers ? ["Resolves to"] : [])];
  const none = <span className="font-mono text-[12px] text-muted-foreground">—</span>;
  // Wider than a phone (375 px): the table scrolls in its own box, as MissionAnalytics' tables do, never the page. The box
  // is positioned so the header's sr-only "Reset" (absolute) is placed in it, not past it on the page.
  return (
    <>
      {askOff && <p className="mb-2 text-[12px] text-warning-text">{ASK_OFF}</p>}
      <div className="relative overflow-x-auto">
        <table aria-label={label} className="w-full border text-left">
          <thead><tr className="border-b">{heads.map((c) => <th key={c} className="caps px-3 py-2 text-[11px] font-semibold text-muted-foreground">{c}</th>)}<th><span className="sr-only">Reset</span></th></tr></thead>
          <tbody>
            {rows.map(({ name, choice: t, gate, follows }) => {
              const fallback = t ? fallbackOf(t) : "";
              const own = settings[name]?.provider;
              const set = t !== undefined && own !== undefined && own !== fallback;
              const provider = set ? own : fallback;
              const pick = (next: string | undefined) => onEdit((current) => withProvider(current, name, next, fallback));
              const gateFallback = gate ? permissionFallbackOf(gate) : "allow";
              const ownPermission = settings[name]?.permission;
              const permissionSet = gate !== undefined && ownPermission !== undefined && ownPermission !== gateFallback;
              const permission = permissionSet ? ownPermission : gateFallback;
              return (
                <Fragment key={name}>
                  <tr data-tool={name} data-set={set || permissionSet ? "" : undefined} className="border-b align-top last:border-b-0">
                    <td className="px-3 py-2.5 font-mono text-[13px]">{name}</td>
                    {providers && <td className="px-3 py-2">
                      {t ? <>
                        <select aria-label={`${name} provider`} value={provider} disabled={busy} onChange={(e) => pick(e.target.value)}
                          className={cn("border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-border-strong disabled:opacity-60", set && "border-primary text-primary")}>
                          {t.providers.map((p) => <option key={p} value={p}>{providerLabel(p, name)}{p === fallback ? " (default)" : ""}</option>)}
                        </select>
                        {providerHelp(provider, name) && <span className="mt-1 block max-w-[300px] text-[11px] text-muted-foreground">{providerHelp(provider, name)}</span>}
                        {set && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">default: {providerLabel(fallback, name)}</span>}
                      </> : none}
                    </td>}
                    {permissions && <td className="px-3 py-2">
                      {gate ? <>
                        <select aria-label={`${name} permission`} value={permission} disabled={busy} onChange={(e) => { const chosen = e.target.value as Permission; onEdit((current) => withPermission(current, name, chosen, gateFallback)); }}
                          className={cn("border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-border-strong disabled:opacity-60", permissionSet && "border-primary text-primary")}>
                          {gate.permissions.map((p) => <option key={p} value={p} disabled={p === "ask" && gate.ask_needs === "password"}>{p}{p === gateFallback ? " (default)" : ""}</option>)}
                        </select>
                        {permissionSet && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">default: {gateFallback}</span>}
                        {permission === "ask" && gate.ask_needs === "password" && <span className="mt-1 block max-w-[220px] text-[11px] text-warning-text">Each call is refused: no one can approve it here.</span>}
                      </> : follows ? <span className="font-mono text-[12px] text-muted-foreground">follows {follows}</span> : none}
                    </td>}
                    {providers && <td className="px-3 py-2.5">{t ? resolvesOf(t, provider) : none}</td>}
                    <td className="px-2 py-2 text-right">
                      {set && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reset ${name} to its default`} onClick={() => pick(undefined)}>Reset</Button>}
                    </td>
                  </tr>
                  {issues[name]?.length ? (
                    <tr><td colSpan={heads.length + 1} className="px-3 pb-2.5">{issues[name].map((m) => <p key={m} className="font-mono text-[12px] text-destructive-text" role="alert">{m}</p>)}</td></tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A resolution, said plainly: an unavailable one in the warning colour with the server's reason. */
export function Resolves({ value, prefix, tool }: { value: string | undefined; prefix?: string; tool?: string }) {
  const r = resolution(value, tool);
  return <span className={cn("block font-mono text-[12px]", r.unavailable ? "text-warning-text" : "text-muted-foreground")}>{prefix}{r.text}</span>;
}

/** What a capability resolves to on each harness, one line each. */
export const PerHarness = ({ choice }: { choice: ToolChoice }) => <>{HARNESS_ORDER.map((h) => <Resolves key={h} value={choice.resolves[h]} prefix={`${h}: `} tool={choice.name} />)}</>;

/** The agent editor's tool settings: per capability with a provider choice that this agent grants, or that the server's
 *  pick leaves unavailable (the agent's own pick may be what makes it run, before it is granted), its provider, the
 *  server's pick its default, and what it resolves to on the agent's harness and model. Nothing at all when none has one. */
export function AgentToolSettings({ agent, harness, model, tools, choices, gates = [], focus, value, issues, onChange }: {
  agent: Agent | null;
  /** The harness, model and tools in the form, saved or not (no model: the server's default). */
  harness: string;
  model?: string;
  tools: readonly string[];
  choices: readonly ToolChoice[];
  /** Each tool's permission on this server (capabilities'): the default of a granted tool's here. */
  gates?: readonly ToolGate[];
  /** A tool to focus the permission of as this opens (a legacy name at its settings key's row). */
  focus?: string;
  /** The settings in the form: the agent's own, or the person's change of them. */
  value: ToolSettings;
  /** A refused save's issues, by field (saveError's). */
  issues: Record<string, string>;
  onChange: (next: ToolSettings) => void;
}) {
  // A grant under a legacy name (fetch_page) is its capability's (web_fetch): that row is its.
  const granted = new Set(tools.map(capabilityOf));
  const offered = choices.filter((c) => granted.has(c.name) || !c.available);
  // Each granted tool's permission, the server's in force its default: as capabilities list it, else as the agent's read
  // gave it (a catalog tool, monid.<tool> or mcp:<server>/<tool>, which capabilities don't list).
  const accountsOff = gates.some((g) => g.ask_needs === "password");
  const read = (name: string) => agent?.tools?.find((x) => x.name === name);
  // A grant under a legacy name (fetch_page) is held to its capability's permission (web_fetch's): that row is its.
  const permitted = [...new Set(tools.map(capabilityOf))].flatMap((name): ToolGate[] => {
    const listed = gates.find((g) => g.name === name);
    if (listed) return [listed];
    const x = read(name);
    if (!x?.permissions?.length || !x.default_permission) return [];
    return [{ name, permission: x.permission ?? x.default_permission, default_permission: x.default_permission, permissions: x.permissions, ...(accountsOff && x.permissions.includes("ask") ? { ask_needs: "password" as const } : {}) }];
  });
  const rows = toolRows(offered, permitted, [...gates.map((g) => g.name), ...choices.map((c) => c.name)]);
  const section = useRef<HTMLElement>(null);
  // Once, as it opens: the tool asked for, at its settings key's row (fetch_page is web_fetch's).
  useEffect(() => {
    if (!focus) return;
    const label = `${capabilityOf(focus)} permission`;
    const select = [...(section.current?.querySelectorAll("select") ?? [])].find((s) => s.getAttribute("aria-label") === label);
    select?.scrollIntoView?.({ block: "center" });
    select?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  const saved = (agent?.definition.tool_settings ?? {}) as ToolSettings;
  const { byTool, rest } = issuesFor(issues, "definition.tool_settings", rows.map((t) => t.name));
  return (
    <section aria-label="Tool settings" ref={section}>
      <div className="mb-2"><span className="caps text-[12px] font-semibold">Tool settings</span></div>
      <p className="-mt-1 mb-2 text-[12px] text-muted-foreground">Each of these tools takes this server's setting (its default here) unless it is changed here. A tool on ask makes the run wait for your approval at each call.</p>
      <ToolTable label="This agent's tool settings" rows={rows} settings={value} fallbackOf={(t) => t.provider} issues={byTool} onEdit={(edit) => onChange(edit(value))}
        // The server's permission for this agent when its read says it (GET /agents/{id}), else capabilities'.
        permissionFallbackOf={(g) => read(g.name)?.default_permission ?? g.permission}
        resolvesOf={(t) => {
          // The server's word holds only for what it was read for: the agent's, for its saved provider, harness and model;
          // capabilities', for the server's provider on each harness with the server's default model. A change of any of
          // them resolves once saved.
          // A permission changes it too (deny: unavailable; ask: no search that can't wait for an approval).
          const own = (value[t.name]?.provider ?? null) !== (saved[t.name]?.provider ?? null) || (value[t.name]?.permission ?? null) !== (saved[t.name]?.permission ?? null);
          // The agent's word holds only for the provider it was read for, the one the select shows: a server pick changed
          // since capabilities were read (another tab) leaves capabilities' word, which goes with the select.
          const read = agent?.tools?.find((x) => capabilityOf(x.name) === t.name);
          const known = read && read.provider === (value[t.name]?.provider ?? t.provider) ? read.resolved : undefined;
          const savedModel = (model ?? "") === ((agent?.definition.model as string | undefined) ?? "");
          if (!own && harness === (agent?.definition.harness ?? "pi") && savedModel && known) return <Resolves value={known} prefix={`${harness}: `} tool={t.name} />;
          if (!own && !saved[t.name] && !model) return <Resolves value={t.resolves[harness]} prefix={`${harness}: `} tool={t.name} />;
          return <span className="block font-mono text-[12px] text-muted-foreground">once saved</span>;
        }} />
      {rest.map((m) => <p key={m} className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{m}</p>)}
    </section>
  );
}
