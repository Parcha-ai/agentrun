import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { MessageMode } from "@/lib/runState";

// serve's own names for the modes and what each does (the contract's table for POST /v2/runs/{id}/messages).
const MODE: Record<MessageMode, { placeholder: string; does: string }> = {
  steer: { placeholder: "Steer the run...", does: "Lands after the current tool round." },
  answer: { placeholder: "Answer the question...", does: "Answers what the agent asked; the run goes back to work." },
  follow_up: { placeholder: "Ask a follow-up question...", does: "Starts a new turn of the same run, under the same cap." },
};

/** The follow-up box, posting to the same run (`POST /v2/runs/{id}/messages`). Sent is not done: it says "Sent"
 *  until the timeline shows the message. */
export function Composer({ mode, onSend, sending, sent }: { mode: MessageMode; onSend?: (text: string) => void; sending?: boolean; sent?: boolean }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim() && onSend) { onSend(text.trim()); setText(""); } };
  return (
    <form className="border bg-card" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <label className="sr-only" htmlFor="composer">Message</label>
      <textarea id="composer" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={MODE[mode].placeholder}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        className="block w-full resize-none bg-transparent px-4 pt-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <span className="min-w-0 text-[11px] text-muted-foreground">{sent ? "Sent. It appears on the timeline when the run takes it." : <><code className="font-mono text-foreground">{mode}</code> · {MODE[mode].does}</>}</span>
        <Button type="submit" size="sm" disabled={!text.trim() || !onSend || sending}>
          {sending ? "Sending" : "Send"} <CornerDownLeft aria-hidden />
        </Button>
      </div>
    </form>
  );
}
