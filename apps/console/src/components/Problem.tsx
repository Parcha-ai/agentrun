import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Problem } from "@/lib/problem";

/** A read that failed, for a person: what failed, why and what to do next, then the server's own words and code, small,
 *  for a bug report. `onRetry` gives Try again; `link` a way somewhere else (the list a missing thing belongs to). */
export function ProblemCard({ problem: p, onRetry, link, className = "m-8" }: { problem: Problem; onRetry?: () => void; link?: { href: string; label: string }; className?: string }) {
  return (
    <section className={`flex gap-3 border bg-card px-4 py-4 md:px-5 ${className}`} role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
      <div className="min-w-0">
        <p className="text-prose font-semibold">{p.title}</p>
        <p className="mt-1 text-lead leading-relaxed">{p.why} {p.next}</p>
        {(p.said || p.code) && (
          <p className="mt-2 break-words font-mono text-label text-muted-foreground">{[p.said, p.code].filter(Boolean).join(" · ")}</p>
        )}
        {(onRetry || link) && (
          <div className="mt-3 flex flex-wrap gap-3">
            {onRetry && <Button type="button" onClick={onRetry} size="sm">Try again</Button>}
            {link && <a href={link.href} className="caps border px-3 py-2 text-small hover:bg-accent">{link.label}</a>}
          </div>
        )}
      </div>
    </section>
  );
}

/** A thing this server has no record of (a run or an agent by id): said so, with the list to find it in. */
export function NotHere({ what, id, list }: { what: "run" | "agent"; id: string; list: { href: string; label: string } }) {
  return (
    <ProblemCard problem={{ title: `No ${what} with this id.`, why: `This server has no ${what} ${id}.`, next: `Check the address, or find the ${what} in the list.` }} link={list} />
  );
}
