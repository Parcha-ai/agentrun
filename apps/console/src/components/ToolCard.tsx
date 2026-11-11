import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/** A description longer than this many characters is more than the card's three lines hold: More shows the rest. */
const CLAMPED = 140;

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
  // More is offered only when the card hides something: a description under a blurb or past three lines, a reason the
  // short tag stands for, an alert longer than its one line, or a name longer than its.
  const more = (!!description && (!!blurb || description.length > CLAMPED)) || (!!why && why !== tag) || (!!alert && alert.length > 60) || name.length > 32;
  const toggle = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); };
  return (
    <label title={open ? undefined : why} data-tool-card={value} className={cn("flex w-full min-w-0 flex-col border px-3 py-2.5 font-mono text-body", open ? "min-h-36" : "h-36 overflow-hidden", on && "border-foreground", warn && "border-warning/60", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <span className="flex min-w-0 items-center gap-3">
        <input type="checkbox" value={value} checked={on} disabled={disabled} onChange={onToggle} className="shrink-0 accent-primary" />
        {/* Cut to one line on the card, whole in its title; whole, wrapping, once More opens (an MCP tool's id has no
            spaces, and tools from one server share a long prefix). */}
        <span title={name} className={cn("min-w-0", open ? "[overflow-wrap:anywhere]" : "truncate")}>{name}</span>
        {note && <span className="shrink-0 font-sans text-label text-muted-foreground">{note}</span>}
      </span>
      {blurb ? <span data-line className="mt-1 truncate font-sans text-small text-muted-foreground">{blurb}</span>
        : description && !open ? <span data-line className="mt-1 line-clamp-3 font-sans text-label text-muted-foreground [overflow-wrap:anywhere]" title={description}>{description}</span> : null}
      {tag && <span data-tag title={why} className="mt-1 max-w-full self-start truncate border px-1.5 text-micro text-muted-foreground">{tag}</span>}
      {alert && !open && <span className="mt-1 truncate font-sans text-label text-warning-text" role="alert" title={alert}>{alert}</span>}
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
