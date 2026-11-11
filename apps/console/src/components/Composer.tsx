import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import type { MessageMode } from "@/lib/runState";

// Each of serve's message modes (the contract's table for POST /v2/runs/{id}/messages) in plain words: what the box is
// for, and what sending does. The mode's own name (follow_up, steer, answer) is the API's, never shown.
const MODE: Record<MessageMode, { label: string; placeholder: string; does: string }> = {
  steer: { label: "Steer the run", placeholder: "Steer the run...", does: "The agent reads it when its current step ends." },
  answer: { label: "Answer the question", placeholder: "Answer the question...", does: "Answers what the agent asked; the run goes back to work." },
  follow_up: { label: "Ask a follow-up", placeholder: "Ask a follow-up question...", does: "Continues this run with your message; the same spend cap applies." },
};

/** The follow-up box, posting to the same run (`POST /v2/runs/{id}/messages`). Sent is not done: it says "Sent"
 *  until the timeline shows the message. */
/** `purpose`: the box's words where the mode's own don't say what a send does (a message that declines a tool call
 *  waiting on its approval). */
export function Composer({ mode, onSend, sending: sendingProp, sent, purpose }: { mode: MessageMode; onSend?: (text: string) => void | boolean | Promise<void | boolean>; sending?: boolean; sent?: boolean; purpose?: { label: string; placeholder: string; does: string } }) {
  const words = purpose ?? MODE[mode];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = sendingProp || busy;
  // The draft stays until the server takes the message: a send that fails (it resolves false) keeps it to send again.
  const send = async () => {
    if (!text.trim() || !onSend || sending) return;
    setBusy(true);
    const ok = await onSend(text.trim());
    setBusy(false);
    if (ok !== false) setText("");
  };
  return (
    <form className="border bg-card focus-within:border-foreground" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <Textarea bare id="composer" rows={2} value={text} readOnly={sending} aria-busy={sending} onChange={(e) => setText(e.target.value)} placeholder={words.placeholder}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        className="block w-full resize-none px-4 pt-3" />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <span className="min-w-0 text-label text-muted-foreground">
          <label htmlFor="composer" className="font-semibold text-foreground">{words.label}</label> · {sent ? "Sent. It appears on the timeline when the run takes it." : words.does}
        </span>
        <Button type="submit" size="sm" disabled={!text.trim() || !onSend || sending}>
          {sending ? "Sending" : "Send"} <CornerDownLeft aria-hidden />
        </Button>
      </div>
    </form>
  );
}
