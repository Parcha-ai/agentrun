import { ArrowUpRight } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { cost, when } from "@/lib/format";
import type { Run } from "@/lib/v2";

/** Every run on the server, newest first, as the hosted console's history table, with the status column it leaves out
 *  at desktop width. A row opens its run. */
export function RunsList({ runs, agentName, onOpen, error, onMore, loadingMore }: { runs: Run[] | null; agentName: (id: string) => string; onOpen: (id: string) => void; error?: string | null; onMore?: () => void; loadingMore?: boolean }) {
  if (error) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">{error}</p>;
  if (!runs) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading runs...</p>;
  if (!runs.length) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>;
  return (
    <div className="p-5 md:p-8">
      <h1 className="mb-5 font-mono text-2xl font-semibold">Runs</h1>
      <table className="w-full border-collapse border text-[13px]">
        <thead className="hidden md:table-header-group">
          <tr className="caps text-[11px] text-muted-foreground">
            {["Status", "Run", "Agent", "Kind", "Started", "Cost"].map((h) => <th key={h} className="border-b px-3 py-2 text-left font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.run_id} className="cursor-pointer border-b hover:bg-accent" onClick={() => onOpen(r.run_id)}>
              <td className="px-3 py-2.5 align-top"><StatusBadge run={r} /></td>
              <td className="px-3 py-2.5 align-top">
                <button type="button" className="flex items-start gap-1 text-left" onClick={(e) => { e.stopPropagation(); onOpen(r.run_id); }}>
                  <span className="line-clamp-2">{r.title}</span><ArrowUpRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
                <span className="mt-1 block font-mono text-[11px] text-muted-foreground md:hidden">{agentName(r.agent_id)} · {when(r.created_at)}</span>
              </td>
              <td className="hidden px-3 py-2.5 align-top md:table-cell">{agentName(r.agent_id)}</td>
              <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{r.kind}</td>
              <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{when(r.created_at)}</td>
              <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{cost(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onMore && <div className="mt-4 flex justify-center"><button type="button" onClick={onMore} disabled={loadingMore} className="caps border px-4 py-2 text-[12px] hover:bg-accent disabled:opacity-45">{loadingMore ? "Loading" : "Load more"}</button></div>}
    </div>
  );
}
