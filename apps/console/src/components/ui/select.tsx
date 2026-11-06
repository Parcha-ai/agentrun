import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string; disabled?: boolean; description?: string };
type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  placeholder?: string;
};

/** A select-only combobox: navigation previews an option; Enter, Space or a click applies it. */
export function Select({ value, onValueChange, options, "aria-label": label, "aria-labelledby": labelledBy, id, disabled, autoFocus, className, placeholder = "Select an option" }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<Element | null>(null);
  const [active, setActive] = useState<string | undefined>(value);
  const [position, setPosition] = useState<CSSProperties>({});
  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout>>();
  const enabled = options.filter((option) => !option.disabled);
  const unavailable = disabled || !enabled.length;
  const selected = options.find((option) => option.value === value);
  const activeIndex = Math.max(0, enabled.findIndex((option) => option.value === active));
  const activeOption = enabled[activeIndex];
  const optionId = (option: SelectOption) => `${listId}-option-${encodeURIComponent(option.value)}`;
  const activeId = open && activeOption ? optionId(activeOption) : undefined;
  const clearType = useCallback(() => { typed.current = ""; clearTimeout(typeTimer.current); }, []);
  const close = useCallback((restore = false) => {
    setOpen(false);
    clearType();
    if (restore) trigger.current?.focus();
  }, [clearType]);
  const locate = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const margin = 8, gap = 6;
    const menuWidth = Math.min(Math.max(rect.width, 240), Math.max(0, width - margin * 2));
    const below = Math.max(0, y + height - rect.bottom - margin - gap);
    const above = Math.max(0, rect.top - y - margin - gap);
    const upwards = below < Math.min(320, above);
    setPosition({
      width: menuWidth,
      left: Math.max(x + margin, Math.min(rect.left, x + width - margin - menuWidth)),
      maxHeight: Math.min(320, Math.max(0, height - margin * 2), upwards ? above : below),
      ...(upwards ? { bottom: Math.max(window.innerHeight - y - height + margin, window.innerHeight - rect.top + gap) } : { top: Math.max(y + margin, rect.bottom + gap) }),
    });
  }, []);
  const show = (next = enabled.find((option) => option.value === value)?.value ?? enabled[0]?.value) => {
    if (unavailable) return;
    setHost(trigger.current?.closest("dialog[open]") ?? trigger.current?.closest(".ar-console") ?? document.body);
    setActive(next);
    locate();
    setOpen(true);
  };
  const choose = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onValueChange(option.value);
  };

  useEffect(() => () => clearType(), [clearType]);
  useEffect(() => { if (unavailable) close(); }, [unavailable, close]);
  useEffect(() => {
    if (!open) return;
    const inside = (event: Event) => [trigger.current, panel.current].some((node) => node && (event.composedPath().includes(node) || node.contains(event.target as Node)));
    const outside = (event: Event) => { if (!inside(event)) close(); };
    const scrolled = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || !target.contains(trigger.current)) return;
      const rect = trigger.current?.getBoundingClientRect(), viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!rect || rect.bottom <= y || rect.top >= y + height || rect.right <= x || rect.left >= x + width) close();
      else locate();
    };
    const dialog = trigger.current?.closest("dialog[open]");
    const dialogClosed = () => close();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", locate);
    window.visualViewport?.addEventListener("resize", locate);
    window.visualViewport?.addEventListener("scroll", locate);
    dialog?.addEventListener("close", dialogClosed);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(locate);
    if (trigger.current) observer?.observe(trigger.current);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", locate);
      window.visualViewport?.removeEventListener("resize", locate);
      window.visualViewport?.removeEventListener("scroll", locate);
      dialog?.removeEventListener("close", dialogClosed);
      observer?.disconnect();
    };
  }, [open, close, locate]);
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeId]);

  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeOption); else { clearType(); show(); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); clearType();
      let next = activeIndex;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = enabled.length - 1;
      else if (open) next = Math.max(0, Math.min(enabled.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
      else next = enabled.findIndex((option) => option.value === value);
      const nextValue = enabled[next >= 0 ? next : event.key === "ArrowUp" ? enabled.length - 1 : 0]?.value;
      if (open) setActive(nextValue); else show(nextValue);
      return;
    }
    if (event.key.length === 1 && event.key.trim()) {
      event.preventDefault();
      const letter = event.key.toLocaleLowerCase();
      const prefix = typed.current + letter;
      const term = [...prefix].every((character) => character === letter) ? letter : prefix;
      const current = open ? activeIndex : enabled.findIndex((option) => option.value === value);
      const start = term.length === 1 ? current + 1 : Math.max(0, current);
      const ordered = enabled.map((_, offset) => enabled[(start + offset) % enabled.length]);
      const found = ordered.find((option) => option.label.toLocaleLowerCase().startsWith(term));
      typed.current = term;
      clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(() => { typed.current = ""; }, 700);
      if (found) { if (open) setActive(found.value); else show(found.value); }
    }
  };

  return <>
    <button ref={trigger} type="button" role="combobox" id={id} aria-label={label} aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={activeId} disabled={unavailable} autoFocus={autoFocus}
      onKeyDown={keys} onClick={() => { clearType(); if (open) close(); else show(); }}
      className={cn("flex min-h-9 min-w-0 items-center justify-between gap-2 rounded-lg border border-border-strong/60 bg-card px-3 py-2 text-left text-[13px] text-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45", open && "border-primary/60", className)}>
      <span className="min-w-0 flex-1 truncate" title={selected?.label ?? value}>{selected?.label ?? (value || placeholder)}</span>
      <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
    </button>
    {open && host && createPortal(<div ref={panel} id={listId} role="listbox" aria-label={label ?? placeholder} aria-labelledby={labelledBy}
      style={position} className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-border-strong/70 bg-card p-1.5 text-foreground shadow-xl shadow-black/25">
      {options.map((option) => <div key={option.value} id={optionId(option)} role="option" aria-label={option.label} aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        aria-describedby={option.description ? `${optionId(option)}-description` : undefined}
        onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (!option.disabled) setActive(option.value); }} onClick={() => choose(option)}
        className={cn("flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-[13px]", option.disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer transition-colors hover:bg-accent", option.value === value && "bg-primary/[0.08] text-brand-accent", option.value === activeOption?.value && "bg-accent")}>
        <span className="min-w-0 flex-1"><span className="block break-words font-medium">{option.label}</span>{option.description && <span id={`${optionId(option)}-description`} className="mt-0.5 block break-words text-[11px] text-muted-foreground">{option.description}</span>}</span>
        <Check className={cn("size-4 shrink-0 text-brand-accent", option.value !== value && "invisible")} aria-hidden />
      </div>)}
    </div>, host)}
  </>;
}
