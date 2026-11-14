import { ShieldQuestion } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Textarea } from "@/components/ui/field";
import { argsShown, priceLine } from "@/lib/approval";
import { cn } from "@/lib/utils";
import type { PendingApproval } from "@/lib/v2";

export type ApprovalCardProps = {
  pending: PendingApproval;
  /** Answers the call: resolves with the refusal to show, in words, or null once the server took it (204). Whoever
   *  passes it reads the run again either way. `confirmed`: an allow of a destructive call, after its second click
   *  (the server's `confirm_destructive`). */
  onAnswer: (decision: "allow" | "deny", note?: string, confirmed?: true) => Promise<string | null>;
  /** Mission Control's strip: a shorter arguments block, and `heading` (the agent, the run, when it asked) on top. */
  compact?: boolean;
  heading?: ReactNode;
};

/** The note's longest, as the server takes it. */
const NOTE_MAX = 2000;

/** A tool call that waits for the owner's approval: the tool, its arguments (scrolled in a box of their own, never cut
 *  further than the server cut them, never wider than the page), what a call costs, a note the agent reads with a
 *  Deny, and Allow and Deny. An answer is one POST: the first click disables both buttons before anything else can land.
 *  A call its MCP server marks destructive says so, and its Allow takes a second click: Allow once asks again in place,
 *  naming the call, the keyboard on Back; only "Allow this destructive call" sends the allow. Its Deny stays one click. */
export function ApprovalCard({ pending, onAnswer, compact = false, heading }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<"allow" | "deny" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const destructive = pending.destructive === true;
  // Held outside React's state, so two clicks in the same tick are still one answer.
  const sending = useRef(false);
  const price = priceLine(pending.price);
  const answer = async (decision: "allow" | "deny", confirmed?: true) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setProblem(null); setConfirming(false);
    const why = note.trim();
    const refused = await (confirmed ? onAnswer(decision, undefined, confirmed) : onAnswer(decision, decision === "deny" && why ? why : undefined));
    sending.current = false;
    setBusy(false);
    if (refused) setProblem(refused); else setSaid(decision);
  };
  return (
    <section aria-label="Approval required" className={cn("min-w-0 border border-warning/50 bg-warning/5", compact ? "p-4" : "p-4 md:p-5")}>
      {heading}
      <p className={cn("caps flex items-center gap-2 text-label text-warning-text", heading && "mt-2")}><ShieldQuestion className="size-3.5" aria-hidden /> Approval required</p>
      <p className="mt-2 text-prose leading-snug">The agent wants to run <span className="break-all font-mono text-lead">{pending.tool}</span>.{destructive && <> <Chip tone="error" title="Its server marks this tool destructive: it may delete or overwrite.">Destructive</Chip></>}</p>
      <pre aria-label={`${pending.tool} arguments`} title={pending.args_preview} className={cn("mt-2 overflow-auto whitespace-pre-wrap break-all border bg-card p-3 font-mono text-small leading-[1.6]", compact ? "max-h-28" : "max-h-64")}>{argsShown(pending.args_preview)}</pre>
      {price && <p className="mt-2 font-mono text-small text-muted-foreground">{price}</p>}
      {said ? (
        <p className="mt-3 font-mono text-body text-success-text" role="status">{said === "allow" ? "Allowed. The run goes on." : "Denied. The agent reads why and goes on."}</p>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-small text-muted-foreground">Tell the agent why (optional, sent with Deny)</span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={compact ? 1 : 2} disabled={busy}
              className="mt-1 block resize-y py-2 font-sans text-lead" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="solid" size="sm" disabled={busy || confirming} onClick={() => (destructive ? setConfirming(true) : void answer("allow"))}>Allow once</Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void answer("deny")}>Deny</Button>
            {busy && <span className="font-mono text-small text-muted-foreground">Sending…</span>}
          </div>
          {confirming && <ConfirmDestructive tool={pending.tool} onAllow={() => void answer("allow", true)} onBack={() => setConfirming(false)} />}
          {!compact && <p className="text-small text-muted-foreground">or type what to do instead; sending it declines this call</p>}
          {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
        </div>
      )}
    </section>
  );
}

/** The second click a destructive call's allow takes, asked in place: what it allows, by name, then Back (where the
 *  keyboard starts, so Enter never allows it by habit) and the allow by its own name. Esc goes back. */
function ConfirmDestructive({ tool, onAllow, onBack }: { tool: string; onAllow: () => void; onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  return (
    <div role="alertdialog" aria-label={`Allow ${tool}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onBack(); } }}
      className="flex flex-wrap items-center gap-3 border border-destructive/50 bg-card px-3 py-2.5">
      <p className="min-w-0 flex-1 text-body"><span className="font-semibold">Allow a destructive call?</span> Its server marks <span className="break-all font-mono">{tool}</span> as one that may delete or overwrite.</p>
      <Button ref={back} type="button" size="sm" variant="ghost" onClick={onBack}>Back</Button>
      <Button type="button" size="sm" variant="destructive" onClick={onAllow}>Allow this destructive call</Button>
    </div>
  );
}
