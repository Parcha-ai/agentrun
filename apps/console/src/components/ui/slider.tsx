import { cn } from "@/lib/utils";

/** One value out of a short run of whole steps (a revision of a history): a native range input, so the arrows, Home,
 *  End and Page keys move it and a screen reader reads it as a slider. `label` names it; `valueText` is what its value
 *  means in words ("Revision 3 of 5, Nov 4"), read instead of the bare number. Quiet: a thin track in the strong border
 *  token and a small foreground dot, so it never outweighs what it steps through; the global focus ring shows on it. */
const QUIET = [
  "appearance-none bg-transparent",
  "[&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:bg-border-strong",
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-foreground",
  "[&::-moz-range-track]:h-0.5 [&::-moz-range-track]:bg-border-strong",
  "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground",
].join(" ");

export function Slider({ value, onChange, min, max, label, valueText, className, disabled = false }: {
  value: number; onChange: (value: number) => void; min: number; max: number; label: string; valueText?: string; className?: string; disabled?: boolean;
}) {
  return (
    <input type="range" min={min} max={max} step={1} value={value} disabled={disabled} aria-label={label} aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.target.value))} className={cn(QUIET, "h-control-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-45", className)} />
  );
}
