import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** A description longer than this many characters is more than the card's three lines hold: More shows the rest. */
const CLAMPED = 140;
/** The characters a collapsed card's one-line name, tag and alert hold at the grid's narrowest column (18rem); past
 *  them, the line is cut. The name's is a fallback only: the card measures whether its name is cut. */
const NAME_CUT = 32, TAG_CUT = 40, ALERT_CUT = 60;

/** One tool in the agent editor's Tools step, the same card for every source (a built-in tool, an MCP server's, one a
 *  Composio or any other MCP server lists), so the grid stays one height and can't drift between them.
 *
 *  Collapsed, every card is one fixed height whatever it says: its name on one line (whole in its title); ONE human line,
 *  the served `blurb`, else the `description` clamped to three lines with an ellipsis; its state as a short `tag` (the
 *  full reason, `why`, its title) and an `alert` (why it can't run, from its server or its harness) on a line each. A
 *  short description leaves the card its height. More opens that card alone, which grows: its name whole, the whole
 *  description and the reasons; Less closes it. More never ticks the tool.
 *
 *  Long unbroken text (a base64 example, a shell line, an MCP tool's id) wraps anywhere and never widens the card or its
 *  column. `note`: a word beside the name ("not metered"). `warn`: its border says something is wrong with it. */
export function ToolCard({ value, name, note, blurb, description, tag, why, alert, on, disabled, warn, onToggle }: {
  value: string; name: string; note?: ReactNode; blurb?: string; description?: string; tag?: string; why?: string; alert?: string;
  on: boolean; disabled: boolean; warn?: boolean; onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Whether the collapsed name is cut, as the browser draws it (the checkbox and a note take their room, so no count of
  // characters says it); the character count only where nothing is laid out (a test's DOM). Read while collapsed: open,
  // the name wraps whole, and the card keeps what it read so Less stays.
  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameCut, setNameCut] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = nameRef.current;
    if (open || !el) return;
    const read = () => { if (el.clientWidth > 0) setNameCut(el.scrollWidth > el.clientWidth + 1); };
    read();
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    watch?.observe(el);
    return () => watch?.disconnect();
  }, [name, open]);
  // More is offered only when the card hides something: a description under a blurb or past three lines, a reason the
  // short tag stands for, an alert longer than its one line, or a name cut on its.
  const longName = nameCut ?? name.length > NAME_CUT, longAlert = !!alert && alert.length > ALERT_CUT;
  const more = (!!description && (!!blurb || description.length > CLAMPED)) || (!!why && why !== tag) || longAlert || longName;
  // A hover title only says what the card cuts or hides, never what it already shows (Manuel's #20): the whole name when
  // it's cut, the whole description past its three lines, the reason a short tag stands for (or a reason too long for
  // its line), the whole alert when it's cut. An open card shows all of it, so it has none.
  const hover = (text: string | undefined, cut: boolean) => (!open && text && cut ? text : undefined);
  const toggle = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); };
  return (
    <label data-tool-card={value} className={cn("flex w-full min-w-0 flex-col border px-3 py-2.5 font-mono text-body", open ? "min-h-36" : "h-36 overflow-hidden", on && "border-foreground", warn && "border-warning/60", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <span className="flex min-w-0 items-center gap-3">
        <input type="checkbox" value={value} checked={on} disabled={disabled} onChange={onToggle} className="shrink-0 accent-primary" />
        {/* Cut to one line on the card, whole in its title when cut; whole, wrapping, once More opens (an MCP tool's id has
            no spaces, and tools from one server share a long prefix). */}
        <span ref={nameRef} title={hover(name, longName)} className={cn("min-w-0", open ? "[overflow-wrap:anywhere]" : "truncate")}>{name}</span>
        {note && <span className="shrink-0 font-sans text-label text-muted-foreground">{note}</span>}
      </span>
      {blurb ? <span data-line className="mt-1 truncate font-sans text-small text-muted-foreground">{blurb}</span>
        : description && !open ? <span data-line className="mt-1 line-clamp-3 font-sans text-label text-muted-foreground [overflow-wrap:anywhere]" title={hover(description, description.length > CLAMPED)}>{description}</span> : null}
      {tag && <span data-tag title={hover(why, !!why && (why !== tag || why.length > TAG_CUT))} className="mt-1 max-w-full self-start truncate border px-1.5 text-micro text-muted-foreground">{tag}</span>}
      {alert && !open && <span className="mt-1 truncate font-sans text-label text-warning-text" role="alert" title={hover(alert, longAlert)}>{alert}</span>}
      {open && (
        <span data-more className="mt-2 min-w-0 space-y-1 font-sans text-label text-muted-foreground">
          {description && <span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">{description}</span>}
          {why && why !== description && <span className="block [overflow-wrap:anywhere]">{why}</span>}
          {alert && <span className="block text-warning-text [overflow-wrap:anywhere]" role="alert">{alert}</span>}
        </span>
      )}
      {more && (
        <button type="button" onClick={toggle} aria-expanded={open} className="mt-auto self-start pt-1 font-sans text-label underline underline-offset-2 hover:text-foreground">{open ? "Less" : "More"}</button>
      )}
    </label>
  );
}
