import { type ReactNode, useState } from "react";
import { BuiltInToolCards } from "@/components/BuiltInToolCards";
import { ListFilter } from "@/components/ListFilter";
import { McpToolPicker, mcpShownCount } from "@/components/McpToolPicker";
import type { ToolOffer } from "@/lib/agentForm";
import { matchesFilter } from "@/lib/filter";
import type { McpServer } from "@/lib/mcp";
import type { Place, Places } from "@/lib/place";
import type { ToolChoice, ToolGate } from "@/lib/toolSettings";
import type { AgentTool, ToolSettings } from "@/lib/v2";

/** The tools a form grants, picked: one filter over every card, then the built-in tools and each saved MCP server's, as the
 *  agent editor's Tools step and Build's Tools step both show them. A card the filter hides keeps its state. `offers`: every
 *  tool the server offers. `servers`: the saved MCP servers (null while read, "failed" when they could not be), shown when
 *  `mcp`; `mcpHarnesses`: those that run MCP tools here. `place`: the agent's own place, else none (see BuiltInToolCards).
 *  `extra`: more groups for the same grid (the editor's monid grants), each counted and filtered by the same words.
 *  `onChange`: the tools with the toggled one ticked or unticked. */
export function ToolPicker({ offers, tools, harness, place, places, workflow = false, mcp = false, servers = null, mcpHarnesses, choices, gates, granted, settings, extra, onRetry, onChange }: {
  offers: ToolOffer[]; tools: readonly string[]; harness: string; place: Place | undefined; places: Places | null | undefined;
  workflow?: boolean; mcp?: boolean; servers?: McpServer[] | null | "failed"; mcpHarnesses?: readonly string[];
  choices?: readonly ToolChoice[]; gates?: readonly ToolGate[]; granted?: readonly AgentTool[]; settings?: ToolSettings;
  extra?: { count: (query: string) => number; render: (query: string) => ReactNode };
  onRetry?: () => void; onChange: (tools: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  // A call-only tool is offered to a workflow, or to an agent that names it (to untick). ask_person first: the one tool that
  // lets the agent stop and ask you, which Tool approvals is not.
  const builtIns = (q: string) => offers.filter((t) => workflow || !t.call_only || tools.includes(t.name))
    .filter((t) => matchesFilter(q, t.name, t.blurb, t.summary))
    .sort((a, b) => Number(b.name === "ask_person") - Number(a.name === "ask_person"));
  const showMcp = mcp && !workflow;
  const count = (q: string) => builtIns(q).length + (showMcp ? mcpShownCount(servers, tools, q) : 0) + (extra?.count(q) ?? 0);
  const shown = count(query);
  return <>
    {/* A filter over the built-in tools and every MCP server's (a GitHub server lists hundreds). */}
    <ListFilter value={query} onChange={setQuery} label="Filter tools" placeholder="Filter by name or description" shown={shown} total={count("")} className="mb-3" />
    {query.trim() && !shown && <p className="mb-3 font-mono text-body text-muted-foreground">No tool matches “{query.trim()}”.</p>}
    {/* Columns by a minimum width: as many as fit, one card a row in a narrow pane (a phone on its side). Every collapsed card
        one height, top-aligned: one card's Details grows it alone, never its row. */}
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-start gap-2">
      <BuiltInToolCards shown={builtIns(query)} offers={offers} tools={tools} harness={harness} place={place} places={places} workflow={workflow}
        mcpHarnesses={mcpHarnesses} choices={choices} gates={gates} granted={granted} settings={settings} onChange={onChange} />
      {/* The MCP and extra groups span the whole row: each lays out its own cards in the same columns. */}
      {showMcp && <li className="col-span-full"><McpToolPicker servers={servers} tools={tools} harness={harness} harnesses={mcpHarnesses} filter={query} onRetry={onRetry} onChange={onChange} /></li>}
      {extra?.render(query)}
    </ul>
  </>;
}
