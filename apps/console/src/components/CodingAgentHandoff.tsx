import { Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CODING_AGENTS, codingAgentPrompt, readCodingAgent, rememberCodingAgent, type CodingAgentChoice, type CodingAgentContext } from "@/lib/codingAgentHandoff";

/** A reviewed prompt copied into the person's chosen app or CLI. No application is opened automatically. */
export function CodingAgentHandoff({ context, serverUrl = "/v2", label = "Use your coding agent" }: { context: CodingAgentContext | (() => CodingAgentContext); serverUrl?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(readCodingAgent);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    const changed = () => setChoice(readCodingAgent());
    window.addEventListener("storage", changed);
    window.addEventListener("agentrun-coding-agent-change", changed);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener("agentrun-coding-agent-change", changed); };
  }, []);
  useEffect(() => {
    if (!open) return;
    if (typeof dialog.current?.showModal === "function") dialog.current.showModal();
    document.getElementById(`${id}-application`)?.focus();
  }, [open, id]);
  const destination = CODING_AGENTS.find((agent) => agent.id === choice)!;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(prompt);
      setCopied(true); setCopyError(false);
    } catch {
      setCopyError(true); setCopied(false);
      text.current?.focus(); text.current?.select();
    }
  };
  return (
    <>
      <Button type="button" size="sm" onClick={() => { setPrompt(codingAgentPrompt(typeof context === "function" ? context() : context, serverUrl)); setCopied(false); setCopyError(false); setOpen(true); }} aria-haspopup="dialog"><ExternalLink aria-hidden /> {label}</Button>
      {open && <dialog ref={dialog} open={typeof HTMLDialogElement.prototype.showModal !== "function" ? true : undefined} onClose={() => setOpen(false)} aria-labelledby={`${id}-title`} className="m-auto max-h-[90dvh] w-[min(44rem,calc(100vw-2rem))] overflow-auto rounded-xl border bg-card p-5 text-foreground shadow-2xl backdrop:bg-black/60">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`${id}-title`} className="font-semibold">Continue with your coding agent</h2>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}><X aria-hidden /> Close</Button>
        </div>
        <label className="mt-4 block text-[13px]">Application
          <Select id={`${id}-application`} aria-label="Application" autoFocus value={choice} onValueChange={(value) => { const next = value as CodingAgentChoice; rememberCodingAgent(next); setChoice(next); }} options={CODING_AGENTS.map((agent) => ({ value: agent.id, label: agent.label }))} className="mt-2 w-full" />
        </label>
        <p className="mt-3 text-[13px] text-muted-foreground">{destination.instruction}</p>
        <label className="mt-4 block text-[13px]">Review or edit the prompt
          <textarea ref={text} value={prompt} onChange={(e) => { setPrompt(e.target.value); setCopied(false); }} rows={13} spellCheck={false} className="mt-2 block w-full resize-y rounded-lg border bg-background p-3 font-mono text-[12px] leading-relaxed" />
        </label>
        <p className="mt-2 text-[12px] text-muted-foreground">The prompt carries task context. Your coding agent installs the skill and authenticates separately. Copying does not submit a request.</p>
        {copied && <p className="mt-3 text-[13px] text-success-text" role="status">Copied. Paste it into {destination.label}.</p>}
        {copyError && <p className="mt-3 text-[13px] text-warning-text" role="alert">Clipboard unavailable. The prompt is selected; copy it with your keyboard.</p>}
        <div className="mt-4 flex justify-end"><Button type="button" onClick={() => void copy()} disabled={!prompt.trim()}><Copy aria-hidden /> Copy prompt</Button></div>
      </dialog>}
    </>
  );
}
