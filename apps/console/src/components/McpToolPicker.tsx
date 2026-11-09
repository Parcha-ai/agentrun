import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { grantOf, grantProblem, type McpServer, mcpGrant, staleGrants } from "@/lib/mcp";
import { SERVER_DENY } from "@/lib/toolSettings";

/** The Tools step's MCP servers: a group per saved server with a box per tool it lists, ticked when `tools` grants
 *  `mcp:<server>/<tool>`; then each grant that no saved server answers for (its server deleted, or the tool no longer
 *  listed), ticked, with why, to untick. `servers`: null while they are read, "failed" when they could not be (the
 *  grants stay, to untick, with Retry). `harnesses`: those that run MCP tools here (`features.mcp_client.harnesses`);
 *  on another, nothing new can be ticked and a grant says it won't run. */
export function McpToolPicker({ servers, tools, harness, harnesses, onChange, onRetry }: { servers: McpServer[] | null | "failed"; tools: readonly string[]; harness: string; harnesses?: readonly string[]; onChange: (tools: string[]) => void; onRetry?: () => void }) {
  const toggle = (grant: string) => onChange(tools.includes(grant) ? tools.filter((t) => t !== grant) : [...tools, grant]);
  const granted = tools.filter((t) => grantOf(t));
  const runs = !harnesses || harnesses.includes(harness);
  // A grant the server's save refuses (by harness, or by name) can't be ticked; one already granted stays, to untick.
  const box = (grant: string, label: string, note?: string, warn?: string, refused?: string) => {
    const on = tools.includes(grant);
    const off = (!runs || !!refused) && !on;
    const said = warn ?? refused ?? (on && !runs ? `Won't run on ${harness}.` : undefined);
    return (
      <li key={grant}><label className={cn("flex items-start gap-3 border px-3 py-2.5 font-mono text-[13px]", on && "border-foreground", warn && "border-warning/60", off ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
        <input type="checkbox" value={grant} checked={on} disabled={off} onChange={() => toggle(grant)} className="mt-0.5 accent-[hsl(var(--primary))]" />
        <span className="min-w-0">{label}
          {note && <span className="mt-0.5 line-clamp-2 block font-sans text-[11px] text-muted-foreground" title={note}>{note}</span>}
          {said && <span className="mt-0.5 block font-sans text-[11px] text-warning-text" role="alert">{said}</span>}</span>
      </label></li>
    );
  };
  const grid = (children: ReactNode) => <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</ul>;
  const notHere = !runs && <p className="text-[12px] text-warning-text">{harness} doesn't run MCP tools on this server{harnesses?.length ? `: ${harnesses.join(" and ")} do` : ""}.</p>;
  if (servers === "failed") return (
    <div className="mt-4 space-y-2">
      <p className="font-mono text-[12px] text-warning-text" role="alert">The MCP servers could not be read.{" "}
        {onRetry && <button type="button" onClick={onRetry} className="caps ml-1 border px-2 py-0.5 text-[11px] hover:bg-accent">Retry</button>}</p>
      {granted.length > 0 && grid(granted.map((g) => box(g, g, "Can't check right now whether its server still lists it.")))}
    </div>
  );
  if (!servers) return granted.length ? <p className="mt-3 font-mono text-[12px] text-muted-foreground">Reading the MCP servers...</p> : null;
  const stale = staleGrants(tools, servers);
  if (!servers.length && !stale.length) return <p className="mt-3 text-[12px] text-muted-foreground">No MCP server is saved: add one in Settings → MCP servers to grant its tools.</p>;
  return (
    <div className="mt-4 space-y-4">
      {notHere}
      {servers.map((s) => (
        <section key={s.name} aria-label={`MCP server ${s.name}`}>
          <p className="caps mb-2 text-[11px] font-semibold text-muted-foreground">{s.name} · MCP server</p>
          {grid(s.tools.map((t) => box(mcpGrant(s.name, t.name), t.name, [t.title, t.description].filter(Boolean).join(": ") || undefined, undefined, grantProblem(s.name, t, harness) ?? (t.permission === "deny" ? SERVER_DENY : undefined))))}
        </section>
      ))}
      {stale.length > 0 && (
        <section aria-label="MCP grants that can't run">
          <p className="caps mb-2 text-[11px] font-semibold text-warning-text">Granted, but not on a saved server</p>
          {grid(stale.map((x) => box(x.grant, x.grant, undefined, x.why)))}
        </section>
      )}
    </div>
  );
}
