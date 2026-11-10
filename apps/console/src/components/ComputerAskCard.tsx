import { Monitor } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { askedAt } from "@/lib/computerAsk";
import { when } from "@/lib/format";
import type { ComputerAsk, HandBackOutcome } from "@/lib/v2";

/** The agent's ask for the person at its computer (`pending.kind` "browser" or "computer"), read from the run alone (it
 *  outlives a restart, so nothing here waits for an event): what to do there, "Done when" how it will know, and when the
 *  ask expires. Done and Cancel answer it (`onAnswer`, POST …/computer/hand-back for every kind: resolves with the refusal
 *  to say, in words, or null once taken); `onOpen` goes to the Screen tab. Handing back from the screen answers it too. */
export function ComputerAskCard({ ask, onAnswer, onOpen }: {
  ask: ComputerAsk;
  onAnswer?: (outcome: HandBackOutcome) => Promise<string | null>;
  onOpen?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // One answer in flight: a second click (Done again, or Cancel) before the first answers sends nothing. The server takes
  // the first answer.
  const answering = useRef(false);
  const answer = async (outcome: HandBackOutcome) => {
    if (!onAnswer || answering.current) return;
    answering.current = true;
    setBusy(true); setSaid(null);
    try { setSaid(await onAnswer(outcome)); } finally { answering.current = false; setBusy(false); }
  };
  return (
    <section aria-label="Waiting for you at the computer" className="border border-warning/50 bg-warning/5 p-4">
      <p className="caps flex items-center gap-2 text-[11px] text-warning-text"><Monitor className="size-3.5" aria-hidden /> Waiting for you · {askedAt(ask)}</p>
      {/* The agent's own words, which an agent can shape like a phishing page's: said to be its request, and plain text
          (React text: no Markdown, no link, no HTML), never rendered. */}
      <div data-agent-request className="mt-2 border-l-2 border-warning/60 pl-3">
        <p className="text-[15px] leading-relaxed">The agent asks you to: {ask.instruction}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">Done when: {ask.completion_condition}</p>
      </div>
      {/* The console's own line, never the server's or the agent's. */}
      <p className="mt-2 text-[12px] font-semibold">You never need to type your AgentRun password for this.</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">Expires {when(ask.expires_at)} unanswered</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {onOpen && <Button size="sm" variant="primary" onClick={onOpen}>Open the screen</Button>}
        <span className="flex-1" />
        {onAnswer && <>
          <Button size="sm" variant="solid" disabled={busy} onClick={() => void answer("done")}>Done</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer("cancelled")}>Cancel</Button>
        </>}
      </div>
      {said && <p className="mt-2 text-[12px] text-warning-text" role="alert">{said}</p>}
    </section>
  );
}
