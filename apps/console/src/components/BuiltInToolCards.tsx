import { ToolCard } from "@/components/ToolCard";
import { defaultPlaceOf, notOn, runsOn, sandboxReason, type ToolOffer } from "@/lib/agentForm";
import type { Place, Places } from "@/lib/place";
import { SERVER_DENY, serverDenies, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import type { AgentTool, ToolSettings } from "@/lib/v2";

/** A Tools step's built-in tools, a ToolCard each, as the agent editor and Build's Tools step both draw them: the `<li>`s
 *  of the step's grid, for the `shown` offers (the step's filter keeps them). `offers`: every tool the server offers, which
 *  says which harnesses run each. `place`: the agent's own place, else none; with none, ticking a shell tool is what moves
 *  the agent to the box (defaultPlaceOf). `choices`, `gates`, `granted` (the agent's read tools) and `settings` (its tool
 *  settings): what says a tool is denied here or runs once the agent picks a provider of its own. `onChange`: the tools
 *  with the toggled one ticked or unticked. */
export function BuiltInToolCards({ shown, offers, tools, harness, place, places, workflow = false, mcpHarnesses, choices = [], gates = [], granted, settings = {}, onChange }: {
  shown: ToolOffer[]; offers: ToolOffer[]; tools: readonly string[]; harness: string; place: Place | undefined; places: Places | null | undefined;
  workflow?: boolean; mcpHarnesses?: readonly string[]; choices?: readonly ToolChoice[]; gates?: readonly ToolGate[]; granted?: readonly AgentTool[];
  settings?: ToolSettings; onChange: (tools: string[]) => void;
}) {
  const toolOpts = { mcpHarnesses, workflow };
  return <>{shown.map((t) => {
    // A call-only tool runs only in a workflow's call node, which needs it in its revision's tools: a workflow agent picks
    // it like any other. An agentic agent is never offered one, and one it already names shows as such, to untick.
    const runs = runsOn(harness, t.name, offers, toolOpts);
    const on = tools.includes(t.name);
    // A tool the server's provider leaves unavailable runs here once this agent picks a provider of its own.
    const choice = choices.find((c) => c.name === t.name);
    const ownPick = settings[t.name]?.provider;
    const pickedOver = !!choice && ownPick !== undefined && ownPick !== choice.provider;
    // With no place, ticking a shell tool is what moves the agent to the box: read the place with it ticked.
    const sandbox = sandboxReason(t, place ?? defaultPlaceOf(workflow, [...tools, t.name], places));
    const why = serverDenies(t.name, gates, granted) ? SERVER_DENY : t.call_only && !workflow ? "Workflow-only: a workflow's call node runs it, not an agent" : !runs ? notOn(harness, t.name, offers) : sandbox ?? (!t.available && !pickedOver ? (choice?.reason ?? t.reason ?? `Needs ${(t.missing ?? []).join(", ")}`) : undefined);
    // The state, as a one-line tag: "Workflow only" or "Sandbox-only" for those two, else the reason itself (cut to one
    // line); the reason in full is its title, and in Details.
    const tag = !why ? undefined : t.call_only && !workflow ? "Workflow only" : sandbox && runs && why === sandbox ? "Sandbox-only" : why;
    return (
      <li key={t.name} className="min-w-0"><ToolCard value={t.name} name={t.name} blurb={t.blurb} description={t.summary} why={why} tag={tag} on={on} disabled={!!why && !on}
        onToggle={() => onChange(on ? tools.filter((x) => x !== t.name) : [...tools, t.name])} /></li>
    );
  })}</>;
}
