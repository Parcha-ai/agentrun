import type { ReactNode } from "react";
import { matchesFilter } from "@/lib/filter";
import { ToolCard } from "@/components/ToolCard";
import { Button } from "@/components/ui/button";
import { grantOf, grantProblem, type McpServer, type McpTool, mcpGrant, staleGrants } from "@/lib/mcp";
import { SERVER_DENY } from "@/lib/toolSettings";

/** The Tools step's MCP servers: a group per saved server with a box per tool it lists, ticked when `tools` grants
 *  `mcp:<server>/<tool>`; then each grant that no saved server answers for (its server deleted, or the tool no longer
 *  listed), ticked, with why, to untick. `servers`: null while they are read, "failed" when they could not be (the
 *  grants stay, to untick, with Retry). `harnesses`: those that run MCP tools here (`features.mcp_client.harnesses`);
 *  on another, nothing new can be ticked and a grant says it won't run. `filter`: the Tools step's filter box (ListFilter). */
export function McpToolPicker({ servers, tools, harness, harnesses, filter, onChange, onRetry }: { servers: McpServer[] | null | "failed"; tools: readonly string[]; harness: string; harnesses?: readonly string[]; filter: string; onChange: (tools: string[]) => void; onRetry?: () => void }) {
  const toggle = (grant: string) => onChange(tools.includes(grant) ? tools.filter((t) => t !== grant) : [...tools, grant]);
  const granted = tools.filter((t) => grantOf(t));
  const cards = mcpCards(servers, tools, filter);
  const runs = !harnesses || harnesses.includes(harness);
  // A grant the server's save refuses (by harness, or by name) can't be ticked; one already granted stays, to untick.
  // Each tool is the editor's one ToolCard, as a built-in tool is: the same height, its description clamped, More.
  const box = (grant: string, name: string, description?: string, warn?: string, refused?: string, note?: ReactNode) => {
    const on = tools.includes(grant);
    const off = (!runs || !!refused) && !on;
    const said = warn ?? refused ?? (on && !runs ? `Won't run on ${harness}.` : undefined);
    return (
      <li key={grant} className="min-w-0"><ToolCard value={grant} name={name} note={note} description={description} alert={said} on={on} disabled={off} warn={!!warn} onToggle={() => toggle(grant)} /></li>
    );
  };
  // The built-in tools' grid: columns of at least 18rem that a card's content never widens.
  const grid = (children: ReactNode) => <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-start gap-2">{children}</ul>;
  const notHere = !runs && <p className="text-small text-warning-text">{harness} doesn't run MCP tools on this server{harnesses?.length ? `: ${harnesses.join(" and ")} do` : ""}.</p>;
  if (servers === "failed") return (
    <div className="mt-4 space-y-2">
      <p className="font-mono text-small text-warning-text" role="alert">The MCP servers could not be read.{" "}
        {onRetry && <Button type="button" onClick={onRetry} size="xs" className="ml-1">Retry</Button>}</p>
      {cards.failed.length > 0 && grid(cards.failed.map((g) => box(g, g, "Can't check right now whether its server still lists it.")))}
    </div>
  );
  if (!servers) return granted.length ? <p className="mt-3 font-mono text-small text-muted-foreground">Reading the MCP servers...</p> : null;
  if (!servers.length && !staleGrants(tools, servers).length) return <p className="mt-3 text-small text-muted-foreground">No MCP server is saved: add one in <a href="#/settings/mcp" className="underline underline-offset-2">Settings → MCP servers</a> to grant its tools.</p>;
  return (
    <div className="mt-4 space-y-4">
      {notHere}
      {cards.servers.map(({ s, kept }) => (
        <section key={s.name} aria-label={`MCP server ${s.name}`}>
          <p className="caps mb-2 text-label font-semibold text-muted-foreground">{s.name} · MCP server</p>
          {/* A tool its server's read says no price meters: its calls run outside the run's cost and cap. */}
          {grid(kept.map((t) => box(mcpGrant(s.name, t.name), t.name, [t.title, t.description].filter(Boolean).join(": ") || undefined, undefined, grantProblem(t, harness) ?? (t.permission === "deny" ? SERVER_DENY : undefined), s.not_metered?.includes(t.name) ? "not metered" : undefined)))}
        </section>
      ))}
      {cards.stale.length > 0 && (
        <section aria-label="MCP grants that can't run">
          <p className="caps mb-2 text-label font-semibold text-warning-text">Granted, but not on a saved server</p>
          {grid(cards.stale.map((x) => box(x.grant, x.grant, undefined, x.why)))}
        </section>
      )}
    </div>
  );
}

/** The cards the Tools step's filter keeps ("": all); the picker draws them and the count sums them. A server's tools
 *  match by the server's name, the tool's name, title or description, and a server with none kept is left out; a grant
 *  no saved server answers for (`stale`), or every grant after a failed read (`failed`), matches by its name. */
export function mcpCards(servers: McpServer[] | null | "failed", tools: readonly string[], filter: string): { failed: string[]; servers: { s: McpServer; kept: McpTool[] }[]; stale: ReturnType<typeof staleGrants> } {
  if (servers === "failed") return { failed: tools.filter((t) => grantOf(t) && matchesFilter(filter, t)), servers: [], stale: [] };
  if (!servers) return { failed: [], servers: [], stale: [] };
  return {
    failed: [],
    servers: servers.map((s) => ({ s, kept: s.tools.filter((t) => matchesFilter(filter, s.name, t.name, t.title, t.description)) })).filter(({ kept }) => kept.length || !filter.trim()),
    stale: staleGrants(tools, servers).filter((x) => matchesFilter(filter, x.grant)),
  };
}

/** How many cards mcpCards keeps: the Tools step's "N of M shown", so a broken grant the filter finds is never "No tool matches". */
export function mcpShownCount(servers: McpServer[] | null | "failed", tools: readonly string[], filter: string): number {
  const cards = mcpCards(servers, tools, filter);
  return cards.failed.length + cards.servers.reduce((n, { kept }) => n + kept.length, 0) + cards.stale.length;
}
