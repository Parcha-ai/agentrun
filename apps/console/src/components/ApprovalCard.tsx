import { ShieldQuestion } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { argsShown, priceLine } from "@/lib/approval";
import { cn } from "@/lib/utils";
import type { PendingApproval } from "@/lib/v2";

export type ApprovalCardProps = {
  pending: PendingApproval;
  /** Answers the call: resolves with the refusal to show, in words, or null once the server took it (204). Whoever
   *  passes it reads the run again either way. */
  onAnswer: (decision: "allow" | "deny", note?: string) => Promise<string | null>;
  /** Mission Control's strip: a shorter arguments block, and `heading` (the agent, the run, when it asked) on top. */
  compact?: boolean;
  heading?: ReactNode;
};

/** The note's longest, as the server takes it. */
const NOTE_MAX = 2000;

/** A tool call that waits for the owner's approval: the tool, its arguments (scrolled in a box of their own, never cut
 *  further than the server cut them, never wider than the page), what a call costs, a note the agent reads with a
 *  Deny, and Allow and Deny. An answer is one POST: the first click disables both buttons before anything else can land. */
export function ApprovalCard({ pending, onAnswer, compact = false, heading }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<"allow" | "deny" | null>(null);
  // Held outside React's state, so two clicks in the same tick are still one answer.
  const sending = useRef(false);
  const price = priceLine(pending.price);
  const answer = async (decision: "allow" | "deny") => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setProblem(null);
    const why = note.trim();
    const refused = await onAnswer(decision, decision === "deny" && why ? why : undefined);
    sending.current = false;
    setBusy(false);
    if (refused) setProblem(refused); else setSaid(decision);
  };
  return (
    <section aria-label="Approval required" className={cn("min-w-0 border border-warning/50 bg-warning/5", compact ? "p-4" : "p-4 md:p-5")}>
      {heading}
      <p className={cn("caps flex items-center gap-2 text-[11px] text-warning-text", heading && "mt-2")}><ShieldQuestion className="size-3.5" aria-hidden /> Approval required</p>
      <p className="mt-2 text-[15px] leading-snug">The agent wants to run <span className="break-all font-mono text-[14px]">{pending.tool}</span>.</p>
      <pre aria-label={`${pending.tool} arguments`} className={cn("mt-2 overflow-auto whitespace-pre-wrap break-all border bg-card p-3 font-mono text-[12px] leading-[1.6]", compact ? "max-h-28" : "max-h-64")}>{argsShown(pending.args_preview)}</pre>
      {price && <p className="mt-2 font-mono text-[12px] text-muted-foreground">{price}</p>}
      {said ? (
        <p className="mt-3 font-mono text-[13px] text-success-text" role="status">{said === "allow" ? "Allowed. The run goes on." : "Denied. The agent reads why and goes on."}</p>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[12px] text-muted-foreground">Tell the agent why (optional, sent with Deny)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={compact ? 1 : 2} disabled={busy}
              className="mt-1 block w-full resize-y border bg-background px-3 py-2 text-[14px] outline-none focus:border-border-strong disabled:opacity-60" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="solid" size="sm" disabled={busy} onClick={() => void answer("allow")}>Allow</Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void answer("deny")}>Deny</Button>
            {busy && <span className="font-mono text-[12px] text-muted-foreground">Sending…</span>}
            {!compact && <span className="text-[12px] text-muted-foreground sm:ml-auto">The run waits on this call. Stop or Cancel withdraws it.</span>}
          </div>
          {problem && <p className="font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
        </div>
      )}
    </section>
  );
}
