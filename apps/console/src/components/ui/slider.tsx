import { cn } from "@/lib/utils";

/** One value out of a short run of whole steps (a revision of a history): a native range input, so the arrows, Home,
 *  End and Page keys move it and a screen reader reads it as a slider. `label` names it; `valueText` is what its value
 *  means in words ("Revision 3 of 5, Nov 4"), read instead of the bare number. The thumb and the filled track take the
 *  brand's colour. */
export function Slider({ value, onChange, min, max, label, valueText, className, disabled = false }: {
  value: number; onChange: (value: number) => void; min: number; max: number; label: string; valueText?: string; className?: string; disabled?: boolean;
}) {
  return (
    <input type="range" min={min} max={max} step={1} value={value} disabled={disabled} aria-label={label} aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.target.value))} className={cn("h-control-sm cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-45", className)} />
  );
}
