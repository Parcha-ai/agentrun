import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { LiveRun } from "@/components/LiveRun";
import { Button } from "@/components/ui";
import type { Client } from "@/lib/client";
import type { MessageCaps } from "@/lib/liveRun";

/** One session beside Agent Factory's board: the run's own live view (what it did last, what it asks, its message box,
 *  stop and cancel), drawn over the board's right side so the board keeps its place, its filters and its scroll. On a
 *  page too narrow for both it covers the board.
 *  The view is the run page's own (LiveRun), so what a person can do here is exactly what that page allows: a session an
 *  SDK or a connected CLI runs shows no message box and no stop, here as there.
 *  Opening it moves the keyboard to Close; closing it gives the keyboard back to the card that opened it (the page does
 *  that). Escape closes it, except from a field being typed in, or a menu or dialog open inside it. */
export function FactorySession({ v2, runId, caps, agentName, label, onClose, onChanged }: {
  v2: Client; runId: string; caps: MessageCaps | null; agentName: (id: string) => string;
  /** Whose session it is, as the board names it ("Console builder · run 9644d8ab"). */
  label: string;
  onClose: () => void;
  /** Something done here has been read back: the board reads its sessions again at once. */
  onChanged?: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, [runId]);
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest("textarea, input, select, [contenteditable], dialog, [role=dialog], [role=alertdialog], [role=listbox], [role=menu]")) return;
    onClose();
  };
  return (
    <aside aria-label="Session" data-factory-session={runId} onKeyDown={keys}
      className="absolute inset-y-0 right-0 z-sticky flex w-full flex-col border-l bg-background xl:w-3/5 xl:max-w-3xl xl:shadow-drawer">
      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b px-3 py-1">
        <p className="caps min-w-0 flex-1 truncate text-label text-muted-foreground" title={label}>{label}</p>
        <a href={`#/runs/${encodeURIComponent(runId)}`} className="shrink-0 text-small underline underline-offset-2 hover:text-primary-text">Open run</a>
        <Button ref={close} size="icon" variant="ghost" aria-label="Close session" title="Close" onClick={onClose}><X className="size-4" aria-hidden /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden short:overflow-auto">
        <LiveRun key={runId} v2={v2} runId={runId} caps={caps} agentName={agentName} embedded onChanged={onChanged} />
      </div>
    </aside>
  );
}
