import { cn } from "@/lib/utils";
import { grantOf, type McpServer, mcpGrant, staleGrants } from "@/lib/mcp";

/** The Tools step's MCP servers: a group per saved server with a box per tool it lists, ticked when `tools` grants
 *  `mcp:<server>/<tool>`; then each grant that no saved server answers for (its server deleted, or the tool no longer
 *  listed), ticked, with why, to untick. `servers`: null while they are read, "failed" when they could not be. */
export function McpToolPicker({ servers, tools, onChange }: { servers: McpServer[] | null | "failed"; tools: readonly string[]; onChange: (tools: string[]) => void }) {
  const toggle = (grant: string) => onChange(tools.includes(grant) ? tools.filter((t) => t !== grant) : [...tools, grant]);
  if (servers === "failed") return <p className="mt-3 font-mono text-[12px] text-warning-text">The MCP servers could not be read: their tools are not shown.</p>;
  if (!servers) return tools.some(grantOf) ? <p className="mt-3 font-mono text-[12px] text-muted-foreground">Reading the MCP servers...</p> : null;
  const stale = staleGrants(tools, servers);
  if (!servers.length && !stale.length) return <p className="mt-3 text-[12px] text-muted-foreground">No MCP server is saved: add one in Settings → MCP servers to grant its tools.</p>;
  const box = (grant: string, label: string, note?: string, warn?: string) => {
    const on = tools.includes(grant);
    return (
      <li key={grant}><label className={cn("flex cursor-pointer items-start gap-3 border px-3 py-2.5 font-mono text-[13px]", on && "border-foreground", warn && "border-warning/60")}>
        <input type="checkbox" value={grant} checked={on} onChange={() => toggle(grant)} className="mt-0.5 accent-[hsl(var(--primary))]" />
        <span className="min-w-0">{label}
          {note && <span className="mt-0.5 line-clamp-2 block font-sans text-[11px] text-muted-foreground" title={note}>{note}</span>}
          {warn && <span className="mt-0.5 block font-sans text-[11px] text-warning-text" role="alert">{warn}</span>}</span>
      </label></li>
    );
  };
  return (
    <div className="mt-4 space-y-4">
      {servers.map((s) => (
        <section key={s.name} aria-label={`MCP server ${s.name}`}>
          <p className="caps mb-2 text-[11px] font-semibold text-muted-foreground">{s.name} · MCP server</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {s.tools.map((t) => box(mcpGrant(s.name, t.name), t.name, [t.title, t.description].filter(Boolean).join(": ") || undefined))}
          </ul>
        </section>
      ))}
      {stale.length > 0 && (
        <section aria-label="MCP grants that can't run">
          <p className="caps mb-2 text-[11px] font-semibold text-warning-text">Granted, but not on a saved server</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{stale.map((x) => box(x.grant, x.grant, undefined, x.why))}</ul>
        </section>
      )}
    </div>
  );
}
