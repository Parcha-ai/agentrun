import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, forwardRef, type InputHTMLAttributes, useLayoutEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { useFieldWiring } from "@/components/ui/field";
import type { PickerOption } from "@/components/ui/picker";
import { matchesFilter } from "@/lib/filter";
import { cn } from "@/lib/utils";

/** The search box. Headless UI's ComboboxInput writes its own aria-describedby over one given to it, as its
 *  ListboxButton does (see Picker), so a Field's note and error come in as `describedBy` and are put on here. */
const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { describedBy?: string }>(({ describedBy, ...props }, ref) => (
  <input ref={ref} {...props} aria-describedby={props["aria-describedby"] ?? describedBy} />
));
SearchInput.displayName = "SearchInput";

/** The search box's width, for the list that opens under it: the box's ref, and the list's style (`--field-width`,
 *  which the list's class reads). Headless UI gives the list its field's width too (`--input-width`), but reads it only
 *  once the list is open, an animation frame later, while the list is on the page from the render that opens it: its
 *  first open was drawn at its minimum width and then jumped to its field's. This reads the box as it is put on the
 *  page, before anything is drawn, and again whenever its size changes, so the width is there in the render that opens
 *  the list. (A Picker's list needs none of this: measured, its first width on the page is its field's.) */
function useFieldWidth() {
  const field = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [field, { "--field-width": `${width}px` } as CSSProperties] as const;
}

/** One choice of a SearchPicker: a Picker's option, and `keywords`, more of its words that a search finds it by (an
 *  event's slug and description) that its list does not show. */
export type SearchPickerOption = PickerOption & { keywords?: (string | null | undefined)[] };

/** The picker for a long list (a toolkit's events, its actions): a Picker whose field is a search box. Typing filters
 *  the open list to the options whose words, or `keywords`, have every word typed (matchesFilter: "issue comment"
 *  keeps GITHUB_CREATE_AN_ISSUE_COMMENT); the chevron or a focus opens the whole list. Picking puts the option's words
 *  in the field, and a search left without a pick goes back to them. Keyboard as a combobox has it (type, arrows,
 *  Enter picks, Esc closes); Enter never submits the form it is in. Headless UI's Combobox, styled and placed as a
 *  Picker is (square, the field's border, its list right under it), and wired to a Field's label, hint and error as a
 *  Picker is. `label` names it for assistive technology; `placeholder` is what the field reads while nothing is
 *  picked; `nothing(query)` is the list's line when no option matches ("No event matches “x”"). The field and each
 *  option carry their value (data-value); `name` puts the value in a form. */
export function SearchPicker({ value, onChange, options, label, id, className, disabled = false, name, placeholder, nothing }: {
  value: string; onChange: (value: string) => void; options: SearchPickerOption[]; label: string; id?: string; className?: string; disabled?: boolean; name?: string; placeholder?: string; nothing?: (query: string) => string;
}) {
  const [query, setQuery] = useState("");
  const wiring = useFieldWiring();
  const [field, fieldWidth] = useFieldWidth();
  const shown = options.filter((o) => matchesFilter(query, o.label, ...(o.keywords ?? [])));
  const labelOf = (v: string | null) => options.find((o) => o.value === v)?.label ?? "";
  return (
    // Enter in a search picks the option under the keyboard, or nothing: it never sends the form the search is in.
    <div className={cn("relative min-w-0", className)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>
      <Combobox value={value} onChange={(v: string | null) => { if (v !== null) onChange(v); }} onClose={() => setQuery("")} disabled={disabled} name={name} immediate>
        <ComboboxInput as={SearchInput} ref={field} id={id ?? wiring?.id} aria-label={label} describedBy={wiring?.describedBy} aria-invalid={wiring?.invalid || undefined} data-value={value} data-search-picker=""
          autoComplete="off" spellCheck={false} placeholder={placeholder} displayValue={labelOf} onChange={(e) => setQuery(e.target.value)}
          className="h-control-md w-full min-w-0 border border-input bg-background pl-3 pr-9 font-mono text-body placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive data-[open]:border-foreground" />
        <ComboboxButton aria-label={`Show every ${label.toLowerCase()}`} className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-60">
          <ChevronDown className="size-4" aria-hidden />
        </ComboboxButton>
        <ComboboxOptions anchor="bottom start" data-picker-list="" style={fieldWidth}
          className="z-popover max-h-72 w-[var(--field-width)] min-w-[12rem] overflow-auto border border-border-strong bg-background py-1 font-mono text-body shadow-float [--anchor-gap:2px] [--anchor-padding:8px]">
          {shown.map((o) => (
            <ComboboxOption key={o.value} value={o.value} disabled={o.disabled} title={o.title} data-value={o.value} data-tag-tone={o.tag ? o.tagTone ?? "success" : undefined}
              className="group flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 data-[disabled]:cursor-not-allowed data-[focus]:bg-accent data-[disabled]:opacity-50 data-[selected]:text-foreground">
              <Check className="invisible size-3.5 shrink-0 text-primary-text group-data-[selected]:visible" aria-hidden />
              <span className="min-w-0 break-words">{o.label}</span>
              {o.tag && <Chip tone={o.tagTone ?? "success"} className="ml-auto">{o.tag}</Chip>}
            </ComboboxOption>
          ))}
          {!shown.length && <p role="status" data-search-nothing="" className="px-3 py-2 text-muted-foreground">{nothing?.(query.trim()) ?? `Nothing matches “${query.trim()}”`}</p>}
        </ComboboxOptions>
      </Combobox>
    </div>
  );
}
