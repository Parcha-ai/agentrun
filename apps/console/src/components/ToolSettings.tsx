import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { capabilityOf, HARNESS_ORDER, issuesFor, providerHelp, providerLabel, resolution, type ToolChoice, withProvider } from "@/lib/toolSettings";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/agentForm";
import type { ToolSettings } from "@/lib/v2";

/** One table of capabilities, the server's and an agent's alike: per capability its provider, from the ones offered in
 *  the server's order (the default first, and named so), and what it resolves to. A provider set here, unlike the
 *  layer's default (`fallbackOf`: the built-in default for the server's, the server's for an agent's), is marked, and
 *  its row can be reset to the default. */
export function ToolTable({ label, rows, settings, fallbackOf, resolvesOf, issues, busy = false, onChange }: {
  label: string;
  rows: ToolChoice[];
  settings: ToolSettings;
  fallbackOf: (row: ToolChoice) => string;
  resolvesOf: (row: ToolChoice, provider: string) => ReactNode;
  issues: Record<string, string[]>;
  busy?: boolean;
  onChange: (next: ToolSettings) => void;
}) {
  // Wider than a phone (375 px): the table scrolls in its own box, as MissionAnalytics' tables do, never the page. The box
  // is positioned so the header's sr-only "Reset" (absolute) is placed in it, not past it on the page.
  return (
    <div className="relative overflow-x-auto">
      <table aria-label={label} className="w-full border text-left">
        <thead><tr className="border-b">{["Tool", "Provider", "Resolves to"].map((c) => <th key={c} className="caps px-3 py-2 text-[11px] font-semibold text-muted-foreground">{c}</th>)}<th><span className="sr-only">Reset</span></th></tr></thead>
        <tbody>
          {rows.map((t) => {
            const fallback = fallbackOf(t);
            const own = settings[t.name]?.provider;
            const set = own !== undefined && own !== fallback;
            const provider = set ? own : fallback;
            const pick = (next: string | undefined) => onChange(withProvider(settings, t.name, next, fallback));
            return (
              <Fragment key={t.name}>
                <tr data-tool={t.name} data-set={set ? "" : undefined} className="border-b align-top last:border-b-0">
                  <td className="px-3 py-2.5 font-mono text-[13px]">{t.name}</td>
                  <td className="px-3 py-2">
                    <select aria-label={`${t.name} provider`} value={provider} disabled={busy} onChange={(e) => pick(e.target.value)}
                      className={cn("border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-border-strong disabled:opacity-60", set && "border-primary text-primary")}>
                      {t.providers.map((p) => <option key={p} value={p}>{providerLabel(p, t.name)}{p === fallback ? " (default)" : ""}</option>)}
                    </select>
                    {providerHelp(provider, t.name) && <span className="mt-1 block max-w-[300px] text-[11px] text-muted-foreground">{providerHelp(provider, t.name)}</span>}
                    {set && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">default: {providerLabel(fallback, t.name)}</span>}
                  </td>
                  <td className="px-3 py-2.5">{resolvesOf(t, provider)}</td>
                  <td className="px-2 py-2 text-right">
                    {set && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reset ${t.name} to its default`} onClick={() => pick(undefined)}>Reset</Button>}
                  </td>
                </tr>
                {issues[t.name]?.length ? (
                  <tr><td colSpan={4} className="px-3 pb-2.5">{issues[t.name].map((m) => <p key={m} className="font-mono text-[12px] text-destructive-text" role="alert">{m}</p>)}</td></tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
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
export function AgentToolSettings({ agent, harness, model, tools, choices, value, issues, onChange }: {
  agent: Agent | null;
  /** The harness, model and tools in the form, saved or not (no model: the server's default). */
  harness: string;
  model?: string;
  tools: readonly string[];
  choices: readonly ToolChoice[];
  /** The settings in the form: the agent's own, or the person's change of them. */
  value: ToolSettings;
  /** A refused save's issues, by field (saveError's). */
  issues: Record<string, string>;
  onChange: (next: ToolSettings) => void;
}) {
  // A grant under a legacy name (fetch_page) is its capability's (web_fetch): that row is its.
  const granted = new Set(tools.map(capabilityOf));
  const rows = choices.filter((c) => granted.has(c.name) || !c.available);
  if (!rows.length) return null;
  const saved = (agent?.definition.tool_settings ?? {}) as ToolSettings;
  const { byTool, rest } = issuesFor(issues, "definition.tool_settings", rows.map((t) => t.name));
  return (
    <section aria-label="Tool settings">
      <div className="mb-2"><span className="caps text-[12px] font-semibold">Tool providers</span></div>
      <p className="-mt-1 mb-2 text-[12px] text-muted-foreground">Each of these tools takes this server's provider (its default here) unless it is changed here.</p>
      <ToolTable label="This agent's tool providers" rows={rows} settings={value} fallbackOf={(t) => t.provider} issues={byTool} onChange={onChange}
        resolvesOf={(t) => {
          // The server's word holds only for what it was read for: the agent's, for its saved provider, harness and model;
          // capabilities', for the server's provider on each harness with the server's default model. A change of any of
          // them resolves once saved.
          const own = (value[t.name]?.provider ?? null) !== (saved[t.name]?.provider ?? null);
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
