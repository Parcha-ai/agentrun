import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { HARNESS_ORDER, issuesFor, PIN_BROKEN, PIN_HOLDS, pinLine, providerHelp, providerLabel, resolution, SERVER_DENY, serverDenies, type ToolChoice, type ToolGate, withPermission, withProvider } from "@/lib/toolSettings";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/agentForm";
import { grantOf, type McpServer } from "@/lib/mcp";
import type { Permission, ToolSetting, ToolSettings } from "@/lib/v2";

/** One row of a tools table: a tool, with its provider choice (`choice`) where it has one and its permission (`gate`)
 *  where the server offers one. */
export type ToolRow = { name: string; choice?: ToolChoice; gate?: ToolGate };

/** `choices` and `gates` as one table's rows, one per name, in `order` (capabilities.tools'), then any other. */
export function toolRows(choices: readonly ToolChoice[], gates: readonly ToolGate[], order: readonly string[] = gates.map((g) => g.name)): ToolRow[] {
  const names = [...new Set([...order.filter((n) => choices.some((c) => c.name === n) || gates.some((g) => g.name === n)), ...gates.map((g) => g.name), ...choices.map((c) => c.name)])];
  return names.map((name) => {
    const choice = choices.find((c) => c.name === name);
    const gate = gates.find((g) => g.name === name);
    return { name, ...(choice ? { choice } : {}), ...(gate ? { gate } : {}) };
  });
}

/** A tool's pin, as a setting holds it: its words under `label` ("Pinned", "Pinned for this agent"), then that calls outside
 *  it are refused (`also`: the server pins the tool too, and both hold); or, for a pin that doesn't read, that every call is
 *  refused. Nothing for a setting with no pin. */
export function PinNote({ setting, label = "Pinned", also = false }: { setting?: ToolSetting; label?: string; also?: boolean }) {
  if (setting?.pin_broken) return <p className="max-w-[640px] text-[12px] text-warning-text" role="note">{PIN_BROKEN}</p>;
  if (!setting?.pin) return null;
  return <p className="max-w-[640px] text-[12px] text-muted-foreground" role="note"><span className="text-foreground">{label}:</span> {pinLine(setting.pin)}. {PIN_HOLDS}{also ? " This server pins it too; both hold." : ""}</p>;
}

/** Said once above a table where ask can't be answered: accounts off. */
export const ASK_OFF = "Ask is off on this server: approving a call takes the owner's password sign-in, and this server runs with accounts off.";

/** One table of tools, the server's and an agent's alike: per tool its provider, where it has a choice, from the ones
 *  offered in the server's order (the default first, and named so), and what it resolves to; and its permission (allow,
 *  ask, deny), where the server offers one, the layer's default named. A setting unlike the layer's default
 *  (`fallbackOf` for a provider, `permissionFallbackOf` for a permission: the built-in default for the server's, the
 *  server's for an agent's) is marked; a provider's row can be reset, a permission goes back by choosing its default.
 *  Ask, where it can't be answered here (`ask_needs`), is offered disabled, with why. `refused`: whether a row's tool is
 *  refused by the server's deny, which holds for every agent (SERVER_DENY, said under it); `locked`, whether that also
 *  holds its permission at deny here (an agent's table: its own setting holds nothing over it). */
export function ToolTable({ label, rows, settings, fallbackOf, permissionFallbackOf = (g) => g.default_permission, resolvesOf, issues, busy = false, refused = () => false, locked = false, unattended = false, noteOf, onEdit }: {
  label: string;
  /** The agent never asks (its approvals): a tool whose permission is ask runs without asking, and says so. */
  unattended?: boolean;
  rows: ToolRow[];
  settings: ToolSettings;
  fallbackOf: (row: ToolChoice) => string;
  permissionFallbackOf?: (gate: ToolGate) => Permission;
  resolvesOf: (row: ToolChoice, provider: string) => ReactNode;
  issues: Record<string, string[]>;
  busy?: boolean;
  /** Said under a row, across the table (a tool's pin). */
  noteOf?: (name: string) => ReactNode;
  refused?: (name: string, permission: Permission) => boolean;
  locked?: boolean;
  /** A person's change of one key's one field, as an edit of the whole map: applied to the map as it is when it is
   *  saved (a read-modify-write), so every other key and field is written back as it was. */
  onEdit: (edit: (current: ToolSettings) => ToolSettings) => void;
}) {
  const providers = rows.some((r) => r.choice);
  const permissions = rows.some((r) => r.gate);
  const askOff = rows.some((r) => r.gate?.ask_needs === "password");
  // The permission right after the tool's name: the column a person looks for first (whether it runs, asks or is refused).
  const heads = ["Tool", ...(permissions ? ["Permission"] : []), ...(providers ? ["Provider", "Resolves to"] : [])];
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
            {rows.map(({ name, choice: t, gate }) => {
              const fallback = t ? fallbackOf(t) : "";
              const own = settings[name]?.provider;
              const set = t !== undefined && own !== undefined && own !== fallback;
              const provider = set ? own : fallback;
              const pick = (next: ToolSetting["provider"]) => onEdit((current) => withProvider(current, name, next, fallback));
              const gateFallback = gate ? permissionFallbackOf(gate) : "allow";
              const ownPermission = settings[name]?.permission;
              const permissionSet = gate !== undefined && ownPermission !== undefined && ownPermission !== gateFallback;
              const chosen = permissionSet ? ownPermission : gateFallback;
              const denied = gate !== undefined && refused(name, chosen);
              const held = denied && locked;
              const permission = held ? "deny" : chosen;
              return (
                <Fragment key={name}>
                  <tr data-tool={name} data-set={set || permissionSet ? "" : undefined} className="border-b align-top last:border-b-0">
                    <td className="px-3 py-2.5 font-mono text-[13px]">{name}</td>
                    {permissions && <td className="px-3 py-2">
                      {gate ? <>
                        <select aria-label={`${name} permission`} value={permission} disabled={busy || held} onChange={(e) => { const chosen = e.target.value as Permission; onEdit((current) => withPermission(current, name, chosen, gateFallback)); }}
                          className={cn("border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-border-strong disabled:opacity-60", permissionSet && "border-primary text-primary")}>
                          {gate.permissions.map((p) => <option key={p} value={p} disabled={p === "ask" && gate.ask_needs === "password" && !unattended}>{p}{p === gateFallback ? " (default)" : ""}</option>)}
                        </select>
                        {permissionSet && !held && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">default: {gateFallback}</span>}
                        {denied && <span className="mt-1 block max-w-[260px] text-[11px] text-warning-text">{SERVER_DENY}</span>}
                        {permission === "ask" && unattended && !denied && <span className="mt-1 block max-w-[220px] text-[11px] text-warning-text">Runs without asking: Never ask is on.</span>}
                        {permission === "ask" && gate.ask_needs === "password" && !unattended && <span className="mt-1 block max-w-[220px] text-[11px] text-warning-text">Each call is refused: no one can approve it here.</span>}
                      </> : none}
                    </td>}
                    {providers && <td className="px-3 py-2">
                      {t ? <>
                        <select aria-label={`${name} provider`} value={provider} disabled={busy} onChange={(e) => pick(e.target.value as ToolSetting["provider"])}
                          className={cn("border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-border-strong disabled:opacity-60", set && "border-primary text-primary")}>
                          {t.providers.map((p) => <option key={p} value={p}>{providerLabel(p, name)}{p === fallback ? " (default)" : ""}</option>)}
                        </select>
                        {providerHelp(provider, name) && <span className="mt-1 block max-w-[300px] text-[11px] text-muted-foreground">{providerHelp(provider, name)}</span>}
                        {set && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">default: {providerLabel(fallback, name)}</span>}
                      </> : none}
                    </td>}
                    {providers && <td className="px-3 py-2.5">{t ? resolvesOf(t, provider) : none}</td>}
                    <td className="px-2 py-2 text-right">
                      {set && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reset ${name} to its default`} onClick={() => pick(undefined)}>Reset</Button>}
                    </td>
                  </tr>
                  {noteOf?.(name) ? <tr data-note={name}><td colSpan={heads.length + 1} className="px-3 pb-2.5">{noteOf(name)}</td></tr> : null}
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
export function AgentToolSettings({ agent, harness, model, tools, choices, gates = [], mcpServers, serverSettings, focus, callTools, value, issues, unattended = false, onChange }: {
  agent: Agent | null;
  /** The agent never asks, as the form has it: its tools set to ask run without asking. */
  unattended?: boolean;
  /** The harness, model and tools in the form, saved or not (no model: the server's default). */
  harness: string;
  model?: string;
  tools: readonly string[];
  choices: readonly ToolChoice[];
  /** Each tool's permission on this server (capabilities'): the default of a granted tool's here. */
  gates?: readonly ToolGate[];
  /** The saved MCP servers, as their read gives them: an MCP tool granted here and not saved yet takes its permission
   *  (the server's in force, and those offered) from its server's read, which neither capabilities nor the agent's read
   *  list. */
  mcpServers?: readonly McpServer[];
  /** This server's tool settings (GET /v2/settings/tools), for its pins: where it pins a tool the agent pins too, both hold. */
  serverSettings?: ToolSettings;
  /** A tool to focus the permission of as this opens. */
  focus?: string;
  /** A workflow agent's: the tools its call nodes call (callNodeTools). Its rows are those alone, each with a permission as
   *  this server lists it; no catalog tool, which no call node runs. */
  callTools?: readonly string[];
  /** The settings in the form: the agent's own, or the person's change of them. */
  value: ToolSettings;
  /** A refused save's issues, by field (saveError's). */
  issues: Record<string, string>;
  onChange: (next: ToolSettings) => void;
}) {
  const granted = new Set(tools);
  const offered = choices.filter((c) => granted.has(c.name) || !c.available);
  // Each granted tool's permission, the server's in force its default: as capabilities list it, else as the agent's read
  // gave it (a catalog tool, monid.<tool> or mcp:<server>/<tool>, which capabilities don't list), else, for an MCP tool
  // granted and not saved yet, as its server's read gives it.
  const accountsOff = gates.some((g) => g.ask_needs === "password");
  const read = (name: string) => agent?.tools?.find((x) => x.name === name);
  const listedTool = (name: string) => {
    const grant = grantOf(name);
    return grant ? mcpServers?.find((s) => s.name === grant.server)?.tools.find((t) => t.name === grant.tool) : undefined;
  };
  // The agent's own setting for every tool of an MCP server (`mcp:<server>/*`), which the server applies before its own
  // (tool-gate.ts permissionFrom): an MCP tool's row falls back to it, so one set here is kept only where it differs.
  const ownWildcard = (name: string) => {
    const grant = grantOf(name);
    return grant ? value[`mcp:${grant.server}/*`]?.permission : undefined;
  };
  const permitted = callTools ? callTools.flatMap((name) => gates.filter((g) => g.name === name)) : [...new Set(tools)].flatMap((name): ToolGate[] => {
    const listed = gates.find((g) => g.name === name);
    if (listed) return [listed];
    const x = read(name) ?? listedTool(name);
    if (!x?.permissions?.length || !x.default_permission) return [];
    return [{ name, permission: x.permission ?? x.default_permission, default_permission: x.default_permission, permissions: x.permissions, ...(accountsOff && x.permissions.includes("ask") ? { ask_needs: "password" as const } : {}) }];
  });
  const rows = toolRows(offered, permitted, [...gates.map((g) => g.name), ...choices.map((c) => c.name)]);
  const section = useRef<HTMLElement>(null);
  // Once, as it opens: the tool asked for, at its own row.
  useEffect(() => {
    if (!focus) return;
    const label = `${focus} permission`;
    const select = [...(section.current?.querySelectorAll("select") ?? [])].find((s) => s.getAttribute("aria-label") === label);
    select?.scrollIntoView?.({ block: "center" });
    select?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  const saved = (agent?.definition.tool_settings ?? {}) as ToolSettings;
  // The agent's approvals in the form against the saved one: a change of it changes what a tool resolves to, once saved.
  const approvalsChanged = unattended !== ((agent?.definition.approvals ?? "ask") === "never");
  const { byTool, rest } = issuesFor(issues, "definition.tool_settings", rows.map((t) => t.name));
  return (
    <section aria-label="Tool settings" ref={section}>
      <div className="mb-2"><span className="caps text-[12px] font-semibold">Tool settings</span></div>
      {/* What ask means here: an agentic run waits for the owner's approval at each call; a workflow's call node can't
          wait, so the server refuses the start (its asks blocker, runnable.ts), in the same words. */}
      <p className="-mt-1 mb-2 text-[12px] text-muted-foreground">Each of these tools takes this server's setting (its default here) unless it is changed here. {callTools ? "A call node can't wait for an approval: a tool set to ask stops the run from starting. Set it to allow." : unattended ? "Never ask is on: a tool on ask runs without waiting for you. A tool set to deny still holds." : "A tool on ask makes the run wait for your approval at each call."}</p>
      <ToolTable label="This agent's tool settings" unattended={unattended} rows={rows} settings={value} fallbackOf={(t) => t.provider} issues={byTool} onEdit={(edit) => onChange(edit(value))}
        // A pin: the agent's own, the server's beside it where it pins the tool too; the server's alone where only it does.
        noteOf={(name) => {
          const own = value[name];
          const server = serverSettings?.[name];
          const owned = !!(own?.pin || own?.pin_broken);
          if (!owned && !server?.pin && !server?.pin_broken) return null;
          return <>
            {owned && <PinNote setting={own} label="Pinned for this agent" also={!!server?.pin} />}
            {(!owned || server?.pin_broken) && <PinNote setting={server} label="Pinned on this server" />}
          </>;
        }}
        // The server's deny holds over this agent's own setting (rule A): the row stays at deny and says why.
        refused={(name) => serverDenies(name, gates, agent?.tools, mcpServers)} locked
        // The agent's own setting for every tool of its MCP server when the form has one; else the server's permission for
        // this agent when its read says it (GET /agents/{id}), else capabilities' or the MCP server read's.
        permissionFallbackOf={(g) => ownWildcard(g.name) ?? read(g.name)?.default_permission ?? g.permission}
        resolvesOf={(t) => {
          // The server's word holds only for what it was read for: the agent's, for its saved provider, harness and model;
          // capabilities', for the server's provider on each harness with the server's default model. A change of any of
          // them resolves once saved.
          // A permission changes it too (deny: unavailable; ask: no search that can't wait for an approval).
          // So does the agent's approvals (Never ask lets a search that can't wait for an approval run): read under the saved one.
          const own = (value[t.name]?.provider ?? null) !== (saved[t.name]?.provider ?? null) || (value[t.name]?.permission ?? null) !== (saved[t.name]?.permission ?? null) || approvalsChanged;
          // The agent's word holds only for the provider it was read for, the one the select shows: a server pick changed
          // since capabilities were read (another tab) leaves capabilities' word, which goes with the select.
          const read = agent?.tools?.find((x) => x.name === t.name);
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
