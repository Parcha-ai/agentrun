import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type PickerOption = { value: string; label: string };

/** The console's picker: a field that opens its list right under itself (Headless UI's Listbox, anchored "bottom
 *  start" and kept inside the viewport), in place of a native <select>, which a phone opens detached from the field.
 *  Keyboard and typeahead as a listbox has them (arrows, Home/End, Enter, Esc, letters). Styled as the console's fields:
 *  square corners, the field's border, 40 px rows and body text. `label` names it for assistive technology; `id` lets a
 *  visible label point at it. `placeholder` is what the field reads while nothing is picked, in the muted text a
 *  field's placeholder has, so the field is never a blank box. */
export function Picker({ value, onChange, options, label, id, className, placeholder }: { value: string; onChange: (value: string) => void; options: PickerOption[]; label: string; id?: string; className?: string; placeholder?: string }) {
  const picked = options.find((o) => o.value === value);
  return (
    <Listbox value={value} onChange={onChange}>
      <ListboxButton id={id} aria-label={label} className={cn("flex h-control-md min-w-0 items-center justify-between gap-2 border bg-background px-3 text-left border-input font-mono text-body hover:border-foreground/60 focus-visible:outline-offset-0 data-[open]:border-foreground", className)}>
        <span className={cn("min-w-0 truncate", !picked && "text-muted-foreground")}>{picked?.label ?? placeholder ?? ""}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </ListboxButton>
      <ListboxOptions anchor="bottom start" data-picker-list=""
        className="z-popover max-h-72 w-[var(--button-width)] min-w-[12rem] overflow-auto border border-border-strong bg-background py-1 font-mono text-body shadow-float outline-none [--anchor-gap:2px] [--anchor-padding:8px]">
        {options.map((o) => (
          <ListboxOption key={o.value} value={o.value} className="group flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 data-[focus]:bg-accent data-[selected]:text-foreground">
            <Check className="invisible size-3.5 shrink-0 text-primary-text group-data-[selected]:visible" aria-hidden />
            <span className="min-w-0 break-words">{o.label}</span>
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
