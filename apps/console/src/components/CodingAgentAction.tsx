import { Check, ChevronDown, Code, Copy, MousePointer2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { codingAgentLabels, codingAgentLink, codingAgents, CODING_AGENT_EVENT, readCodingAgent, rememberCodingAgent, type CodingAgent } from "@/lib/codingAgentLinks";
import codexIcon from "@/assets/coding-agents/codex.png";
import claudeIcon from "@/assets/coding-agents/claude-code.png";
import codexCliIcon from "@/assets/coding-agents/codex-cli.svg";
import claudeCliIcon from "@/assets/coding-agents/claude-code-cli.svg";

export function CodingAgentIcon({ agent }: { agent: CodingAgent | "" }) {
  const src = agent === "codex" ? codexIcon : agent === "claude" ? claudeIcon : agent === "codex-cli" ? codexCliIcon : agent === "claude-cli" ? claudeCliIcon : null;
  if (src) return <img src={src} width={18} height={18} alt="" aria-hidden className="size-[18px] shrink-0 object-contain" />;
  return agent === "cursor" ? <MousePointer2 className="size-4 shrink-0" aria-hidden /> : <Copy className="size-4 shrink-0" aria-hidden />;
}

function usePreferredAgent() {
  const [agent, setAgent] = useState<CodingAgent | "">(readCodingAgent);
  useEffect(() => {
    // The event carries the choice too: other buttons in this visit update even when storage is unavailable.
    const sync = (event: Event) => {
      const value: unknown = event instanceof CustomEvent ? event.detail : undefined;
      setAgent(codingAgents.includes(value as CodingAgent) ? value as CodingAgent : readCodingAgent());
    };
    window.addEventListener(CODING_AGENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(CODING_AGENT_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const choose = (value: CodingAgent) => {
    rememberCodingAgent(value); setAgent(value);
    window.dispatchEvent(new CustomEvent(CODING_AGENT_EVENT, { detail: value }));
  };
  return { agent, choose };
}

export type CodingAgentActionProps = { label: string; prompt: string; playgroundHref?: string; disabled?: boolean; compact?: boolean; compactIcon?: ReactNode };

/** A remembered handoff destination. Selecting a destination only saves the preference; the main button opens or
 * copies the prompt. The menu lives above scroll containers and stays inside the viewport. */
export function CodingAgentAction({ label, prompt, playgroundHref, disabled, compact = false, compactIcon }: CodingAgentActionProps) {
  const { agent, choose } = usePreferredAgent();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const href = codingAgentLink(agent, prompt);
  const title = agent ? href ? `Open in ${codingAgentLabels[agent]}` : `Copy prompt for ${codingAgentLabels[agent]}` : "Choose your coding agent";
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const copy = async () => {
    setOpen(false);
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setFallback(false); }
    catch { setFallback(true); }
  };
  useEffect(() => { setCopied(false); setFallback(false); }, [agent, prompt]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const width = Math.min(240, window.innerWidth - 16);
      const height = Math.min(menu.current?.scrollHeight || 340, window.innerHeight - 16);
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      const down = below >= height || below >= above;
      const maxHeight = Math.max(80, down ? below : above);
      setPosition({ width, left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)), top: down ? anchor.bottom + 4 : Math.max(8, anchor.top - Math.min(height, maxHeight) - 4), maxHeight });
    };
    place();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  // Keep the menu invisible until measured, then focus it after its position is committed. This avoids both a
  // first-frame jump and layout effects during static rendering (Storybook and the server-rendered test views).
  const positioned = position !== null;
  useEffect(() => {
    if (open && positioned) (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
  }, [open, positioned]);
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const itemStyle = "flex w-full items-center gap-2 px-3 py-2 text-left text-body hover:bg-accent focus:bg-accent focus:outline-none";
  const content = <>{compact && compactIcon ? compactIcon : <CodingAgentIcon agent={agent} />}{compact ? <span className="sr-only">{copied ? "Copied" : label}</span> : copied ? "Copied" : label}</>;
  const actionTitle = compact ? `${label} · ${title}` : title;
  return <div ref={container} className="inline-flex shrink-0">
    {href && !disabled
      ? <a href={href} title={actionTitle} aria-label={compact ? label : undefined} className={`caps inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap border text-small transition-colors hover:border-border-strong hover:bg-accent ${compact ? "px-2" : "px-3"}`}>{content}</a>
      : <Button size="sm" className={`rounded-r-none${compact ? " px-2" : ""}`} disabled={disabled} title={actionTitle} aria-label={compact ? label : undefined} onClick={() => agent ? void copy() : setOpen(true)}>{content}</Button>}
    <Button ref={trigger} size="icon" className="border-l-0" disabled={disabled} aria-label={`Choose coding agent for ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((v) => !v)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}><ChevronDown aria-hidden /></Button>
    <span className="sr-only" role="status">{copied ? "Prompt copied" : ""}</span>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label="Coding agent" onKeyDown={navigate}
      className={`fixed z-popover overflow-y-auto border bg-card p-1 shadow-float${positioned ? "" : " invisible"}`} style={position ?? { width: 240 }}>
      {codingAgents.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={agent === value} tabIndex={-1} className={itemStyle} onClick={() => { choose(value); close(); }}>
        <CodingAgentIcon agent={value} />{codingAgentLabels[value]}{agent === value && <Check className="ml-auto size-3.5" aria-hidden />}
      </button>)}
      <div role="separator" className="my-1 border-t" />
      {playgroundHref && <a role="menuitem" tabIndex={-1} href={playgroundHref} className={itemStyle} onClick={() => setOpen(false)}><Code className="size-4" aria-hidden />API playground</a>}
      <button type="button" role="menuitem" tabIndex={-1} className={itemStyle} onClick={() => { trigger.current?.focus(); void copy(); }}><Copy className="size-4" aria-hidden />Copy prompt</button>
    </div>, document.body)}
    {fallback && createPortal(<div className="fixed inset-0 z-popover grid place-items-center bg-overlay/70 p-4" onClick={(event) => { if (event.target === event.currentTarget) { setFallback(false); trigger.current?.focus(); } }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Copy prompt" className="w-full max-w-xl border bg-background p-5 shadow-float" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setFallback(false); trigger.current?.focus(); }
        if (event.key === "Tab") {
          const items = [...dialog.current!.querySelectorAll<HTMLElement>("button, textarea")];
          if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
        }
      }}>
        <div className="mb-3 flex items-center justify-between gap-3"><p className="font-semibold">Copy prompt</p><Button size="icon" variant="ghost" aria-label="Close prompt" onClick={() => { setFallback(false); trigger.current?.focus(); }}><X aria-hidden /></Button></div>
        <p className="mb-3 text-body text-muted-foreground">Clipboard access is unavailable. Copy this prompt into your coding agent.</p>
        <textarea ref={field} readOnly aria-label="Prompt to copy" value={prompt} rows={9} className="w-full resize-y border bg-card p-3 font-mono text-small" onFocus={(event) => event.currentTarget.select()} />
      </div>
    </div>, document.body)}
  </div>;
}
