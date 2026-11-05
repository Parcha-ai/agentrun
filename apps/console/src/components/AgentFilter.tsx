import { Bot, Check, ChevronDown, Layers3, Search } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";

type Choice = { value: string | null; label: string; detail: string };

/** The analytics filter keeps search and keyboard navigation local until an agent is selected. */
export function AgentFilter({ agents, value, onChange }: { agents: MissionView["perAgent"]; value: string | null; onChange: (value: string | null) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selectionId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null | undefined>(value);
  const [position, setPosition] = useState<CSSProperties>({});
  const choices: Choice[] = [
    { value: null, label: "All agents", detail: `${agents.length} ${agents.length === 1 ? "agent" : "agents"}` },
    ...agents.map((agent) => ({ value: agent.agentId, label: agent.name, detail: `${agent.runs.toLocaleString("en-US")} ${agent.runs === 1 ? "run" : "runs"}` })),
  ];
  const term = query.trim().toLocaleLowerCase();
  const matches = choices.filter((choice) => `${choice.label} ${choice.value ?? ""}`.toLocaleLowerCase().includes(term));
  const found = matches.findIndex((choice) => choice.value === active);
  const activeIndex = found >= 0 ? found : matches.length ? 0 : -1;
  const activeChoice = matches[activeIndex];
  const optionId = (choice: Choice) => `${listId}-${choice.value === null ? "all" : `agent-${encodeURIComponent(choice.value)}`}`;
  const activeId = activeChoice ? optionId(activeChoice) : undefined;
  const selected = choices.find((choice) => choice.value === value)?.label ?? value ?? "All agents";

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  const locate = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const margin = 8, gap = 8;
    const menuWidth = Math.min(Math.max(rect.width, 296), Math.max(0, width - margin * 2));
    const below = Math.max(0, y + height - rect.bottom - margin - gap);
    const above = Math.max(0, rect.top - y - margin - gap);
    const upwards = below < Math.min(360, above);
    setPosition({
      width: menuWidth,
      left: Math.max(x + margin, Math.min(rect.left, x + width - margin - menuWidth)),
      maxHeight: Math.min(360, Math.max(0, height - margin * 2), upwards ? above : below),
      ...(upwards ? { bottom: Math.max(window.innerHeight - y - height + margin, window.innerHeight - rect.top + gap) } : { top: Math.max(y + margin, rect.bottom + gap) }),
    });
  }, []);
  const show = () => { setQuery(""); setActive(value); locate(); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const inside = (event: Event) => [trigger.current, panel.current].some((node) => node && (event.composedPath().includes(node) || node.contains(event.target as Node)));
    const outside = (event: Event) => { if (!inside(event)) close(false); };
    const scrolled = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || !target.contains(trigger.current)) return;
      const rect = trigger.current?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!rect || rect.bottom <= y || rect.top >= y + height || rect.right <= x || rect.left >= x + width) close(false);
      else locate();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", locate);
    document.addEventListener("scroll", scrolled, true);
    window.visualViewport?.addEventListener("resize", locate);
    window.visualViewport?.addEventListener("scroll", locate);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(locate);
    if (trigger.current) observer?.observe(trigger.current);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", locate);
      document.removeEventListener("scroll", scrolled, true);
      window.visualViewport?.removeEventListener("resize", locate);
      window.visualViewport?.removeEventListener("scroll", locate);
      observer?.disconnect();
    };
  }, [open, close, locate]);

  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [open, activeId]);

  const choose = (choice: Choice) => { onChange(choice.value); close(true); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") {
      // The popup is portaled; continue from the trigger's position in the page's Tab order.
      const next = adjacentFocus(trigger.current, panel.current, event.shiftKey ? -1 : 1);
      close(false);
      if (next) { event.preventDefault(); next.focus(); }
      else trigger.current?.focus();
      return;
    }
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(matches.length - 1, activeIndex + 1);
    if (event.key === "ArrowUp") next = Math.max(0, activeIndex - 1);
    if (event.key === "Home" && !query) next = 0;
    if (event.key === "End" && !query) next = matches.length - 1;
    if (next !== undefined) { event.preventDefault(); setActive(matches[next]?.value); }
    if (event.key === "Enter") { event.preventDefault(); if (activeChoice) choose(activeChoice); }
  };

  return <>
    <button ref={trigger} type="button" aria-label="Agent" aria-describedby={selectionId} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => open ? close(false) : show()}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}
      className={cn("flex h-[38px] w-[220px] max-w-full items-center gap-2.5 rounded-lg border bg-card px-3 text-left font-mono text-[13px] shadow-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", open ? "border-primary/60" : "border-border-strong/60")}>
      <Bot className="size-4 shrink-0 text-primary" aria-hidden />
      <span id={selectionId} className="min-w-0 flex-1 truncate" title={selected}>{selected}</span>
      <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
    </button>
    {open && createPortal(<div ref={panel} onKeyDown={keys} style={position} className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border-strong/70 bg-card shadow-xl shadow-black/25">
      <div className="flex shrink-0 items-center gap-2.5 border-b bg-background/40 px-3 py-3">
        <Search className="size-4 shrink-0 text-primary" aria-hidden />
        <input ref={search} type="text" role="combobox" aria-label="Search agents" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeId}
          value={query} onChange={(event) => { setQuery(event.target.value); setActive(undefined); }} placeholder="Find an agent…" autoComplete="off" spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none" />
        <kbd className="rounded border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground" aria-hidden>esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Agents" className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
        {matches.map((choice, index) => {
          const picked = choice.value === value;
          const Icon = choice.value === null ? Layers3 : Bot;
          return <button key={optionId(choice)} id={optionId(choice)} type="button" role="option" aria-label={choice.label} aria-selected={picked} tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(choice.value)} onClick={() => choose(choice)}
            className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-accent", picked && "bg-primary/[0.08]", index === activeIndex && "bg-accent")}>
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background/60", picked ? "border-primary/30 text-primary" : "border-border text-muted-foreground")}><Icon className="size-3.5" aria-hidden /></span>
            <span className="min-w-0 flex-1"><span className={cn("block truncate text-[13px] font-medium", picked && "text-primary")} title={choice.label}>{choice.label}</span><span className="block font-mono text-[10px] text-muted-foreground" aria-hidden>{choice.detail}</span></span>
            <Check className={cn("size-4 shrink-0 text-primary", !picked && "invisible")} aria-hidden />
          </button>;
        })}
        {!matches.length && <p role="status" className="px-3 py-7 text-center text-[13px] text-muted-foreground">No agents found.</p>}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 font-mono text-[9px] text-muted-foreground" aria-hidden><span>↑ ↓ navigate</span><span>↵ select</span></div>
    </div>, document.body)}
  </>;
}

function adjacentFocus(trigger: HTMLElement | null, panel: HTMLElement | null, direction: number): HTMLElement | undefined {
  if (!trigger) return;
  const stops = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]')).filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert]") || panel?.contains(element)) return false;
    if (element instanceof HTMLInputElement && element.type === "radio" && element.name && !element.checked) {
      const group = Array.from(document.getElementsByName(element.name));
      if (group.some((radio) => radio instanceof HTMLInputElement && radio.type === "radio" && radio.form === element.form && radio.checked)) return false;
    }
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
  return stops[stops.indexOf(trigger) + direction];
}
