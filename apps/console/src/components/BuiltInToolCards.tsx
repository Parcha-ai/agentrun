import { ToolCard } from "@/components/ToolCard";
import { defaultPlaceOf, notOn, runsOn, sandboxReason, type ToolOffer } from "@/lib/agentForm";
import type { Place, Places } from "@/lib/place";
import { SERVER_DENY, serverDenies, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import type { AgentTool, ToolSettings } from "@/lib/v2";

/** The `<li>`s of a Tools step's grid: a ToolCard for each of the `shown` built-in tools. `place` is the agent's own, else none:
 *  with none, ticking a shell tool is what moves the agent to the box (defaultPlaceOf). `runnerShell`: the box-only tools
 *  the agent's run shell runs on a runner place, as its computer is (computers.ts runnerShellOf). */
export function BuiltInToolCards({ shown, offers, tools, harness, place, places, runnerShell, workflow = false, mcpHarnesses, choices = [], gates = [], granted, settings = {}, onChange }: {
  shown: ToolOffer[]; offers: ToolOffer[]; tools: readonly string[]; harness: string; place: Place | undefined; places: Places | null | undefined; runnerShell: ReadonlySet<string>;
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
    const sandbox = sandboxReason(t, place ?? defaultPlaceOf(workflow, [...tools, t.name], places), runnerShell);
    const unavailable = !t.available && !pickedOver ? (choice?.reason ?? t.reason ?? `Needs ${(t.missing ?? []).join(", ")}`) : undefined;
    // Every rule that keeps it off here, together (QA: the browser runs only on pi and only on the server, and the card
    // said one rule at a time): the harnesses that run it, where it runs, and what it lacks.
    const rules = [!runs ? notOn(harness, t.name, offers) : undefined, sandbox, unavailable].filter((rule): rule is string => !!rule);
    const why = serverDenies(t.name, gates, granted) ? SERVER_DENY : t.call_only && !workflow ? "Workflow-only: a workflow's call node runs it, not an agent" : rules.length ? rules.join("; ") : undefined;
    // The state, as a one-line tag: "Workflow only", "Sandbox-only" or "Server-only" for those, else the reason itself (cut
    // to one line); the reason in full is its title, and in Details.
    const tag = !why ? undefined : t.call_only && !workflow ? "Workflow only" : sandbox && why === sandbox ? (t.sandbox_only ? "Sandbox-only" : "Server-only") : why;
    return (
      <li key={t.name} className="min-w-0"><ToolCard value={t.name} name={t.name} blurb={t.blurb} description={t.summary} why={why} tag={tag} on={on} disabled={!!why && !on}
        onToggle={() => onChange(on ? tools.filter((x) => x !== t.name) : [...tools, t.name])} /></li>
    );
  })}</>;
}
