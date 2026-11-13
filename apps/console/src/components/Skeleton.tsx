import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One placeholder bar, in the muted surface, pulsing unless the person asked for less motion. */
export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block bg-muted motion-safe:animate-pulse", className)} />;
}

/** A page's shape while its first read is under way, named for a screen reader ("Loading Mission Control"). */
function Loading({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <div role="status" aria-label={label} aria-busy="true" className={className}>{children}<span className="sr-only">{label}…</span></div>;
}

/** Mission Control to come: the heading, six tiles, the analytics and the two lists. */
export function MissionSkeleton() {
  return (
    <Loading label="Loading Mission Control" className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
      <Bone className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="border p-4"><Bone className="h-3 w-16" /><Bone className="mt-3 h-6 w-12" /></div>)}
      </div>
      <Bone className="h-48 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Rows n={4} />
        <Rows n={6} />
      </div>
    </Loading>
  );
}

function Rows({ n }: { n: number }) {
  return (
    <div className="border">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"><Bone className="h-4 w-20" /><Bone className="h-4 flex-1" /><Bone className="hidden h-4 w-24 sm:block" /></div>
      ))}
    </div>
  );
}

/** A list (runs, agents) to come: `label` names it for a screen reader. */
export function ListSkeleton({ label, rows = 8 }: { label: string; rows?: number }) {
  return <Loading label={label}><Rows n={rows} /></Loading>;
}

/** A run's page to come: its header, the tabs and the first rows of its timeline. */
export function RunSkeleton() {
  return (
    <Loading label="Loading the run" className="space-y-6 p-5 md:p-8">
      <div className="space-y-3 border-b pb-6"><Bone className="h-4 w-24" /><Bone className="h-7 w-2/3" /><Bone className="h-3 w-1/3" /></div>
      <div className="flex gap-6">{Array.from({ length: 3 }, (_, i) => <Bone key={i} className="h-4 w-16" />)}</div>
      <div className="space-y-4">{Array.from({ length: 5 }, (_, i) => <div key={i} className="flex gap-3"><Bone className="size-4 shrink-0" /><Bone className={cn("h-4", i % 2 ? "w-1/2" : "w-3/4")} /></div>)}</div>
    </Loading>
  );
}

/** An agent's page to come: its name, its details and its runs. */
export function AgentSkeleton() {
  return (
    <Loading label="Loading the agent" className="space-y-6 p-5 md:p-8">
      <div className="space-y-3"><Bone className="h-7 w-64" /><Bone className="h-3 w-80 max-w-full" /></div>
      <Bone className="h-12 w-full" />
      <Rows n={5} />
    </Loading>
  );
}
