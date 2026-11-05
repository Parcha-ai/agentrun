import { Globe } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { when } from "@/lib/format";
import type { PendingBrowser } from "@/lib/v2";

/** The agent's ask for the person in its browser (`pending.kind` "browser"), read from the run alone (it outlives a
 *  restart, so nothing here waits for an event): what to do there, "Done when" how it will know, and when the ask expires.
 *  `open` is the way to the run's browser (a link from the strip, the tab on the run page). Done and Cancel answer it where
 *  the page can (`onHandBack`: resolves with the refusal to say, in words, or null once taken); the person does it in the
 *  browser's own view first (its Take over and Hand back). */
export function BrowserAskCard({ pending, heading, open, onHandBack, compact = false }: {
  pending: PendingBrowser;
  heading?: ReactNode;
  open: ReactNode;
  onHandBack?: (outcome: "done" | "cancelled") => Promise<string | null>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const answer = async (outcome: "done" | "cancelled") => {
    if (!onHandBack) return;
    setBusy(true); setSaid(null);
    try { setSaid(await onHandBack(outcome)); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Waiting for you in the browser" className={compact ? "px-4 py-3" : "border border-warning/50 bg-warning/5 p-4"}>
      {heading}
      <p className="caps mt-1 flex items-center gap-2 text-[11px] text-warning-text"><Globe className="size-3.5" aria-hidden /> Waiting for you in the browser</p>
      <p className={compact ? "mt-1 text-[15px] leading-snug" : "mt-2 text-[15px] leading-relaxed"}>{pending.instruction}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">Done when: {pending.completion_condition}</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">Expires {when(pending.expires_at)} unanswered</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {open}
        {onHandBack && <>
          <span className="flex-1" />
          <Button size="sm" variant="solid" disabled={busy} onClick={() => void answer("done")}>Done</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer("cancelled")}>Cancel</Button>
        </>}
      </div>
      {said && <p className="mt-2 text-[12px] text-warning-text" role="status">{said}</p>}
    </section>
  );
}
