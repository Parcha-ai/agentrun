import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** One choice: its value, its words, and, where it can't be picked here, `disabled` with why (`title`). */
export type PickerOption = { value: string; label: string; disabled?: boolean; title?: string };

/** The console's picker, every dropdown's: a field that opens its list right under itself (Headless UI's Listbox,
 *  anchored "bottom start" and kept inside the viewport), in place of a native <select>, which a phone opens detached
 *  from the field. Keyboard and typeahead as a listbox has them (arrows, Home/End, Enter, Esc, letters). Styled as the
 *  console's fields: square corners, the field's border, 40 px rows and 13 px text (`small`: the tables' 12 px, 32 px).
 *  `label` names it for assistive technology; `id` lets a visible label point at it. `disabled` turns it off whole;
 *  `name` puts its value in a form (a hidden input). The field and each option carry their value (data-value). */
export function Picker({ value, onChange, options, label, id, className, disabled = false, name, small = false }: {
  value: string; onChange: (value: string) => void; options: PickerOption[]; label: string; id?: string; className?: string; disabled?: boolean; name?: string; small?: boolean;
}) {
  const picked = options.find((o) => o.value === value);
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled} name={name}>
      <ListboxButton id={id} aria-label={label} data-value={value}
        className={cn("flex min-w-0 items-center justify-between gap-2 border bg-background text-left font-mono outline-none focus:border-border-strong disabled:opacity-60 data-[open]:border-border-strong",
          small ? "h-8 px-2 text-[12px]" : "h-10 px-3 text-[13px]", className)}>
        <span className="min-w-0 truncate">{picked?.label ?? ""}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </ListboxButton>
      <ListboxOptions anchor="bottom start" data-picker-list=""
        className="z-50 max-h-72 w-[var(--button-width)] min-w-[12rem] overflow-auto border border-border-strong bg-background py-1 font-mono text-[13px] shadow-lg outline-none [--anchor-gap:2px] [--anchor-padding:8px]">
        {options.map((o) => (
          <ListboxOption key={o.value} value={o.value} disabled={o.disabled} title={o.title} data-value={o.value}
            className="group flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 data-[disabled]:cursor-not-allowed data-[focus]:bg-accent data-[disabled]:opacity-50 data-[selected]:text-foreground">
            <Check className="invisible size-3.5 shrink-0 text-primary group-data-[selected]:visible" aria-hidden />
            <span className="min-w-0 break-words">{o.label}</span>
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
