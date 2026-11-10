import { Copy, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import { Banner, Button, type ButtonProps, Dialog, Field, Picker, Textarea } from "@/components/ui";
import { CODING_AGENTS, type CodingAgentChoice, type CodingAgentContext, codingAgentOf, codingAgentPrompt, saveCodingAgent, savedCodingAgent } from "@/lib/codingAgentHandoff";
import { cn } from "@/lib/utils";

const TITLE: Record<CodingAgentContext["kind"], string> = {
  create: "Build with your coding agent",
  edit: "Edit with your coding agent",
  run: "Run with your coding agent",
};

/** This console's own address (no query, no fragment), for the prompt's console link. */
const consolePage = () => (globalThis.location ? `${location.origin}${location.pathname}` : undefined);

/** The handoff itself: the application (kept in this browser, the choice only), where to paste in it, and the prompt to
 *  review, edit and copy. Copying sends nothing and opens nothing. A clipboard the browser refuses leaves the prompt
 *  selected in its field, with a word to copy it from the keyboard. The messages stay inside the dialog, where the
 *  keyboard and a screen reader are while it is open. */
export function CodingAgentDialog({ open, onClose, context, serverUrl = "/v2", consoleUrl = consolePage() }: {
  open: boolean; onClose: () => void; context: CodingAgentContext; serverUrl?: string; consoleUrl?: string;
}) {
  const [choice, setChoice] = useState<CodingAgentChoice>(() => savedCodingAgent());
  const [prompt, setPrompt] = useState(() => codingAgentPrompt(context, serverUrl, consoleUrl));
  const [copied, setCopied] = useState<"no" | "yes" | "unavailable">("no");
  const text = useRef<HTMLTextAreaElement>(null);
  const to = codingAgentOf(choice);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(prompt);
      setCopied("yes");
    } catch {
      setCopied("unavailable");
      text.current?.focus();
      text.current?.select();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={TITLE[context.kind]}
      description="Pick where you work, then review and copy the prompt. Nothing opens or runs from here."
      footer={<>
        <Button size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" variant="solid" onClick={() => void copy()} disabled={!prompt.trim()}><Copy aria-hidden /> Copy prompt</Button>
      </>}>
      <div className="space-y-5">
        <Field label="Application" hint={to.instruction}>
          <Picker label="Application" autoFocus value={choice} className="w-full sm:w-72"
            onChange={(v) => { const next = codingAgentOf(v as CodingAgentChoice).id; saveCodingAgent(next); setChoice(next); setCopied("no"); }}
            options={CODING_AGENTS.map((a) => ({ value: a.id, label: a.label }))} />
        </Field>
        <Field label="Prompt" note="Review it and edit it before you copy it. It holds the task and no credential: your coding agent signs in to the server on its own.">
          <Textarea ref={text} value={prompt} rows={14} spellCheck={false} className="resize-y text-small leading-relaxed"
            onChange={(e) => { setPrompt(e.target.value); setCopied("no"); }} />
        </Field>
        {copied === "yes" && <Banner tone="success" title="Copied">Paste it into {to.label}. Nothing was sent to the server.</Banner>}
        {copied === "unavailable" && (
          <Banner tone="warning" role="alert" title="Clipboard unavailable">The prompt is selected in its field. Copy it with your keyboard (Ctrl+C, or Cmd+C on a Mac).</Banner>
        )}
      </div>
    </Dialog>
  );
}

/** "… with your coding agent": a button that opens the handoff for `context`, read when the button is pressed (a function
 *  gives the run's input as typed then). `serverUrl`: the console's API endpoint. `iconOnPhone`: under 640 px only the
 *  icon shows (its words stay for a screen reader and as its title), as a header's Edit does. */
export function CodingAgentHandoff({ context, label, serverUrl = "/v2", size = "sm", iconOnPhone, className }: {
  context: CodingAgentContext | (() => CodingAgentContext); label: string; serverUrl?: string; size?: ButtonProps["size"]; iconOnPhone?: boolean; className?: string;
}) {
  const [shown, setShown] = useState<CodingAgentContext | null>(null);
  const [open, setOpen] = useState(false);
  // Each opening starts a fresh dialog: the prompt is built again from the page as it is now.
  const [opening, setOpening] = useState(0);
  return (
    <>
      <Button size={size} onClick={() => { setShown(typeof context === "function" ? context() : context); setOpening((n) => n + 1); setOpen(true); }} aria-haspopup="dialog"
        title={iconOnPhone ? label : undefined} className={cn(iconOnPhone && "max-sm:w-8 max-sm:shrink-0 max-sm:px-0", className)}>
        <SquareTerminal aria-hidden /> {iconOnPhone ? <span className="max-sm:sr-only">{label}</span> : label}
      </Button>
      {shown && <CodingAgentDialog key={opening} open={open} onClose={() => setOpen(false)} context={shown} serverUrl={serverUrl} />}
    </>
  );
}
