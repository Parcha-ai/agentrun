import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { MessageMode } from "@/lib/runState";

const PLACEHOLDER: Record<MessageMode, string> = {
  steer: "Steer the run: add to what it is doing...",
  answer: "Answer the question...",
  follow_up: "Ask a follow-up question...",
};

/** grep.ai's follow-up box, posting to the same run (`POST /v2/runs/{id}/messages`). Sent is not done: it says "Sent"
 *  until the timeline shows the message. */
export function Composer({ mode, onSend, sending, sent }: { mode: MessageMode; onSend?: (text: string) => void; sending?: boolean; sent?: boolean }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim() && onSend) { onSend(text.trim()); setText(""); } };
  return (
    <form className="border bg-card" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <label className="sr-only" htmlFor="composer">Message</label>
      <textarea id="composer" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[mode]}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        className="block w-full resize-none bg-transparent px-4 pt-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <span className="caps text-[10px] text-muted-foreground">{sent ? "Sent. It appears on the timeline when the run takes it." : mode === "steer" ? "Steer" : mode === "answer" ? "Answer" : "Follow-up"}</span>
        <Button type="submit" size="sm" disabled={!text.trim() || !onSend || sending}>
          {sending ? "Sending" : mode === "answer" ? "Answer" : "Run"} <CornerDownLeft aria-hidden />
        </Button>
      </div>
    </form>
  );
}
