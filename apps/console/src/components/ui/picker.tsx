import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { useFieldWiring } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** One choice: its value, its words, and, where it can't be picked here, `disabled` with why (`title`). */
export type PickerOption = { value: string; label: string; disabled?: boolean; title?: string };

/** The console's picker, every dropdown's: a field that opens its list right under itself (Headless UI's Listbox,
 *  anchored "bottom start" and kept inside the viewport), in place of a native <select>, which a phone opens detached
 *  from the field. Keyboard and typeahead as a listbox has them (arrows, Home/End, Enter, Esc, letters). Styled as the
 *  console's fields: square corners, the field's border, control-md rows and body text (`small`: the tables' control-sm
 *  and small text). `label` names it for assistive technology; `id` lets a visible label point at it, and inside a Field the
 *  Field's own label, hint and error are wired to it. `disabled` turns
 *  it off whole; `name` puts its value in a form (a hidden input). `placeholder` is what the field reads while
 *  nothing is picked, in the muted text a field's placeholder has, so the field is never a blank box. The field and
 *  each option carry their value (data-value). */
export function Picker({ value, onChange, options, label, id, className, disabled = false, name, small = false, placeholder }: {
  value: string; onChange: (value: string) => void; options: PickerOption[]; label: string; id?: string; className?: string; disabled?: boolean; name?: string; small?: boolean; placeholder?: string;
}) {
  const picked = options.find((o) => o.value === value);
  const wiring = useFieldWiring();
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled} name={name}>
      <ListboxButton id={id ?? wiring?.id} aria-label={label} aria-describedby={wiring?.describedBy} aria-invalid={wiring?.invalid || undefined} data-value={value}
        className={cn("flex min-w-0 items-center justify-between gap-2 border border-input bg-background text-left font-mono hover:border-foreground/60 focus-visible:outline-offset-0 disabled:opacity-60 data-[open]:border-foreground",
          small ? "h-control-sm px-2 text-small" : "h-control-md px-3 text-body", className)}>
        <span className={cn("min-w-0 truncate", !picked && "text-muted-foreground")}>{picked?.label ?? placeholder ?? ""}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </ListboxButton>
      <ListboxOptions anchor="bottom start" data-picker-list=""
        className="z-popover max-h-72 w-[var(--button-width)] min-w-[12rem] overflow-auto border border-border-strong bg-background py-1 font-mono text-body shadow-float outline-none [--anchor-gap:2px] [--anchor-padding:8px]">
        {options.map((o) => (
          <ListboxOption key={o.value} value={o.value} disabled={o.disabled} title={o.title} data-value={o.value}
            className="group flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 data-[disabled]:cursor-not-allowed data-[focus]:bg-accent data-[disabled]:opacity-50 data-[selected]:text-foreground">
            <Check className="invisible size-3.5 shrink-0 text-primary-text group-data-[selected]:visible" aria-hidden />
            <span className="min-w-0 break-words">{o.label}</span>
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
