import { useId, useState } from "react";
import { Input } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import { type CronShape, lineOf, shapeAs, type ShapeKind, shapeOf, timeOf, timeText } from "@/lib/cronShape";
import { cronWords } from "@/lib/schedules";

const SHAPES: { value: ShapeKind | "custom"; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Monday to Friday)" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom schedule" },
];
// Cron's day-of-week numbers (0 is Sunday), Monday first.
const DAYS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d] }));
const DATES = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
const MINUTES = Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `:${String(i).padStart(2, "0")}` }));

/** When a schedule runs, picked in words: a shape (every hour, every day, every weekday, one day of the week or of the
 *  month) and its time, written as the cron line it is (`value`, `onChange`). "Custom schedule" takes the line itself,
 *  said back in words as it is typed. A line that is no shape here (a step, a list) opens as a custom line, and a line is
 *  only rewritten when it is edited. The Triggers form's schedule and a template's cron parameter (its served
 *  `format: cron`) both use it. `label` names the shape picker (a Field's label points at it); `name` names the cron
 *  line's field when it is typed. */
export function ScheduleWhen({ value, onChange, label, name }: { value: string; onChange: (line: string) => void; label: string; name?: string }) {
  const shape = shapeOf(value);
  const [custom, setCustom] = useState(() => value.trim() !== "" && !shape);
  const ids = useId();
  const typed = custom || (value.trim() !== "" && !shape);
  const set = (s: CronShape) => onChange(lineOf(s));
  const pickShape = (v: string) => {
    if (v === "custom") { setCustom(true); return; }
    setCustom(false);
    set(shapeAs(v as ShapeKind, shape));
  };
  const at = shape && "at" in shape ? shape.at : null;
  return (
    <div className="space-y-2" data-schedule-when>
      <div className="flex flex-wrap gap-2">
        <Picker label={label} className="min-w-56 flex-1" value={typed ? "custom" : (shape?.kind ?? "")} onChange={pickShape} placeholder="Pick when it runs" options={SHAPES} />
        {!typed && shape?.kind === "weekly" && (
          <Picker id={`${ids}-day`} label="Day of the week" className="w-40" value={String(shape.day)} onChange={(v) => set({ ...shape, day: Number(v) })} options={DAYS} />
        )}
        {!typed && shape?.kind === "monthly" && (
          <Picker id={`${ids}-date`} label="Day of the month" className="w-24" value={String(shape.date)} onChange={(v) => set({ ...shape, date: Number(v) })} options={DATES} />
        )}
        {!typed && shape?.kind === "hourly" && (
          <Picker id={`${ids}-minute`} label="Minutes past the hour" className="w-24" value={String(shape.minute)} onChange={(v) => set({ ...shape, minute: Number(v) })} options={MINUTES} />
        )}
        {!typed && shape && at && (
          <Input id={`${ids}-at`} type="time" aria-label="At" className="w-32" value={timeText(at)}
            onChange={(e) => { const t = timeOf(e.target.value); if (t) set({ ...shape, at: t } as CronShape); }} />
        )}
      </div>
      {typed && (
        <>
          <Input id={`${ids}-line`} name={name} aria-label="Custom schedule" value={value} onChange={(e) => onChange(e.target.value)} placeholder="30 1 * * *" spellCheck={false} />
          <p className="text-small text-muted-foreground" aria-live="polite">{value.trim() ? cronWords(value.trim()) : "Minute, hour, day of month, month, day of week."}</p>
        </>
      )}
    </div>
  );
}
