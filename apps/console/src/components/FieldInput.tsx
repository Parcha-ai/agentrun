import type { ReactNode } from "react";
import { ScheduleWhen } from "@/components/ScheduleWhen";
import { ZonePicker } from "@/components/ZonePicker";
import { Input, Textarea } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import type { FieldIssue } from "@/lib/client";
import { type FieldSpec, placeholderOf } from "@/lib/inputForm";
import { choiceOptions } from "@/lib/templatePackages";

// A typed text field's kind of box, by its format: a date, an address or a link. Any other format is the server's to
// check.
const TEXT_TYPE: Record<string, string> = { date: "date", email: "email", uri: "url" };

/** One field of a form of typed fields, its label and help over its widget: a template's parameter on the Apply screen,
 *  and an agent's typed input field in the run forms, drawn the same. The value is the form's text ("true"/"false" for a
 *  box, a list one item a line); what it sends is the caller's. `help`: the field's own words (a cron line's or a zone's
 *  without their format, which the picker says in words); its pattern is the server's to check, never printed.
 *  `typedInput`: a run's typed input field, which nothing fills in when it is left out, so a default choice is offered by
 *  its own value (a template's parameter left out takes its default at apply). */
export function FieldInput({ field: p, label, help, value, onChange, typedInput = false }: { field: FieldSpec; label: string; help?: ReactNode; value: string; onChange: (text: string) => void; typedInput?: boolean }) {
  const hint = placeholderOf(p);
  const options = choiceOptions(p, { sent: typedInput });
  return (
    <label className="block">
      <span className="caps text-small font-semibold">{label}{p.required && <span className="text-destructive-text"> *</span>}</span>
      <span className="mb-1.5 block text-small text-muted-foreground">{help}{p.array && <>{help ? " " : ""}One a line.</>}</span>
      {/* A field with its own list of choices offers just those, whatever its format: the server holds it to them. */}
      {options
        ? <Picker label={label} className="w-full" value={value} onChange={onChange} options={options} />
        : p.array
        ? <Textarea rows={3} value={value} required={p.required} placeholder={hint} onChange={(e) => onChange(e.target.value)} className="resize-y leading-[1.6]" />
        : p.format === "cron" && p.type === "string"
        ? <ScheduleWhen label={label} value={value} onChange={onChange} />
        : p.format === "timezone" && p.type === "string"
        ? <ZonePicker label={label} className="w-full" value={value} onChange={onChange} />
        : p.type === "boolean"
        ? <input type="checkbox" className="size-4 accent-primary" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
        : <Input type={p.type === "string" ? TEXT_TYPE[p.format ?? ""] ?? "text" : "number"} step={p.type === "integer" ? 1 : "any"} value={value} required={p.required} placeholder={hint}
            min={p.minimum} max={p.maximum} minLength={p.minLength} maxLength={p.maxLength} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/** A field's issues, in the server's words (or `words`, the form's for a field), with its `fix` when it names one.
 *  `named`: each with its field. */
export function FieldIssues({ issues, named = false, words = (i) => i.message }: { issues: FieldIssue[]; named?: boolean; words?: (issue: FieldIssue) => string }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-small text-destructive-text" role="alert">
      {issues.map((i, n) => <li key={`${i.field}:${n}`}>{named && <span className="font-mono">{i.field} </span>}{words(i)}{i.fix && <span className="block text-foreground/80">{i.fix}</span>}</li>)}
    </ul>
  );
}
