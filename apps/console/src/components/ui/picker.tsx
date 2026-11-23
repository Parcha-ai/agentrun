import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { useFieldWiring } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** The picker's field, a button. Headless UI's ListboxButton writes its own aria-describedby (from its Description, which
 *  the console doesn't use) over one given to it, unset or not, so a Field's note and error come in as `describedBy`,
 *  which it passes through, and are put on here. */
const PickerButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { describedBy?: string }>(({ describedBy, ...props }, ref) => (
  <button ref={ref} {...props} aria-describedby={props["aria-describedby"] ?? describedBy} />
));
PickerButton.displayName = "PickerButton";

/** One choice: its value, its words, and, where it can't be picked here, `disabled` with why (`title`). `tag`: a fact
 *  about it ("Free · 1M context"), a chip after its words in the list. */
export type PickerOption = { value: string; label: string; icon?: ReactNode; disabled?: boolean; title?: string; tag?: string };

/** The console's picker, every dropdown's: a field that opens its list right under itself (Headless UI's Listbox,
 *  anchored "bottom start" and kept inside the viewport), in place of a native <select>, which a phone opens detached
 *  from the field. Keyboard and typeahead as a listbox has them (arrows, Home/End, Enter, Esc, letters). Styled as the
 *  console's fields: square corners, the field's border, control-md rows and body text (`small`: the tables' control-sm
 *  and small text). `label` names it for assistive technology; `id` lets a visible label point at it, and inside a Field the
 *  Field's own label, hint and error are wired to it. `disabled` turns
 *  it off whole; `name` puts its value in a form (a hidden input). `placeholder` is what the field reads while
 *  nothing is picked, in the muted text a field's placeholder has, so the field is never a blank box. The field and
 *  each option carry their value (data-value). `autoFocus`: a Dialog opens with the keyboard on this field.
 *  `steady`: a field sized by its words (no width of its own) keeps one width whatever is picked, the width its
 *  longest option needs on one line, and its list is at least that wide, so no option wraps; in a space narrower than
 *  that it shrinks and truncates as any picker does. */
export function Picker({ value, onChange, options, label, id, className, disabled = false, name, small = false, placeholder, autoFocus, steady = false }: {
  value: string; onChange: (value: string) => void; options: PickerOption[]; label: string; id?: string; className?: string; disabled?: boolean; name?: string; small?: boolean; placeholder?: string; autoFocus?: boolean; steady?: boolean;
}) {
  const picked = options.find((o) => o.value === value);
  const wiring = useFieldWiring();
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled} name={name}>
      <ListboxButton as={PickerButton} id={id ?? wiring?.id} autoFocus={autoFocus} aria-label={label} describedBy={wiring?.describedBy} aria-invalid={wiring?.invalid || undefined} data-value={value}
        className={cn("flex min-w-0 items-center justify-between gap-2 border border-input bg-background text-left font-mono hover:border-foreground/60 focus-visible:outline-offset-0 disabled:opacity-60 data-[open]:border-foreground",
          small ? "h-control-sm px-2 text-small" : "h-control-md px-3 text-body", className)}>
        {steady
          // Every option shares a grid cell with the selection, including its decorative icon.
          ? <span className="grid min-w-0">
              {options.map((o) => <span key={o.value} data-picker-sizer="" aria-hidden className="invisible col-start-1 row-start-1 flex h-0 min-w-0 items-center gap-2">{o.icon && <span className="flex shrink-0">{o.icon}</span>}<span className="truncate">{o.label}</span></span>)}
              <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">{picked?.icon && <span className="flex shrink-0" aria-hidden>{picked.icon}</span>}<span className={cn("min-w-0 truncate", !picked && "text-muted-foreground")}>{picked?.label ?? placeholder ?? ""}</span></span>
            </span>
          : <span className="flex min-w-0 items-center gap-2">{picked?.icon && <span className="flex shrink-0" aria-hidden>{picked.icon}</span>}<span className={cn("min-w-0 truncate", !picked && "text-muted-foreground")}>{picked?.label ?? placeholder ?? ""}</span></span>}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </ListboxButton>
      <ListboxOptions anchor="bottom start" data-picker-list=""
        className={cn("z-popover max-h-72 overflow-auto border border-border-strong bg-background py-1 font-mono text-body shadow-float outline-none [--anchor-gap:2px] [--anchor-padding:8px]",
          steady ? "w-max min-w-[max(12rem,var(--button-width))] max-w-[calc(100vw-1rem)]" : "w-[var(--button-width)] min-w-[12rem]")}>
        {options.map((o) => (
          <ListboxOption key={o.value} value={o.value} disabled={o.disabled} title={o.title} data-value={o.value}
            className="group flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 data-[disabled]:cursor-not-allowed data-[focus]:bg-accent data-[disabled]:opacity-50 data-[selected]:text-foreground">
            <Check className="invisible size-3.5 shrink-0 text-primary-text group-data-[selected]:visible" aria-hidden />
            {o.icon && <span className="flex shrink-0" aria-hidden>{o.icon}</span>}
            <span className="min-w-0 break-words">{o.label}</span>
            {o.tag && <Chip tone="success" className="ml-auto">{o.tag}</Chip>}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
