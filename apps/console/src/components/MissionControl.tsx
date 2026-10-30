import { StatusBadge } from "@/components/StatusBadge";
import { when } from "@/lib/format";
import { costParts, type MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";

/** Mission Control, the console's first page: how many agents and runs this server has, how many runs are working,
 *  waiting on a person or failed, what they cost (said with its basis, never $0 for a cost not known), runs per agent,
 *  and the latest runs, each a link to its page. */
export function MissionControl({ view, error }: { view: MissionView | null; error?: string | null }) {
  if (error) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">Mission Control could not be read: {error}</p>;
  if (!view) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  const spent = costParts(view.cost);
  const tiles: [string, string, string?, string?][] = [
    ["Agents", String(view.agents)],
    ["Runs", String(view.runs.total)],
    ["Active", String(view.runs.active)],
    ["Needs input", String(view.runs.needsInput), view.runs.needsInput ? "text-warning-text" : undefined],
    ["Failed", String(view.runs.failed), view.runs.failed ? "text-destructive-text" : undefined],
    ["Total cost", spent.total, undefined, spent.note],
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
        <h1 className="text-2xl font-semibold">Mission Control</h1>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map(([label, value, tone, note]) => (
            <li key={label} className="border p-4"><p className="caps text-[11px] text-muted-foreground">{label}</p><p className={cn("mt-2 font-mono text-xl font-semibold", tone)}>{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Runs per agent</h2>
            {view.perAgent.length ? (
              <ul>{view.perAgent.map((a) => (
                <li key={a.agentId} className="border-b last:border-b-0"><a href={`#/runs?agent=${encodeURIComponent(a.agentId)}`} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px] hover:bg-accent"><span className="min-w-0 truncate">{a.name}</span><span className="font-mono text-[13px] text-muted-foreground">{a.runs}</span></a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No agents yet.</p>}
          </section>
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Recent runs</h2>
            {view.recent.length ? (
              <ul>{view.recent.map((r) => (
                <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent">
                  <StatusBadge run={r} /><span className="min-w-0 flex-1 truncate text-[14px]">{r.title}</span><span className="hidden font-mono text-[12px] text-muted-foreground sm:inline">{when(r.created_at)}</span>
                </a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
