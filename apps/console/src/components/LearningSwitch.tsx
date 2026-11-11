import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import type { AgentFields } from "@/lib/agentForm";
import { cn } from "@/lib/utils";

/** "Learns from its runs": the agent's learning switch (its definition's `learning`), named, said in one line, with a
 *  quiet note when the server has learning off. It asks for no tool: a run says what it learned in its answer, so an
 *  agent learns whatever its tools. `quiet` leaves out the line, beside text that says it already. The editor's Settings
 *  step and the agent's Learning tab both show it; neither owns its look. */
export function LearningSwitch({ id, checked, onChange, busy, disabled, quiet, server, problem, className }: {
  id: string; checked: boolean; onChange: (on: boolean) => void; busy?: boolean; disabled?: boolean; quiet?: boolean; server?: "on" | "off" | null;
  problem?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className={cn("flex gap-4", quiet ? "items-center" : "items-start")}>
        <div className="min-w-0 flex-1">
          <p id={id} className="text-lead font-semibold">Learns from its runs</p>
          {!quiet && <p className="mt-0.5 text-body text-muted-foreground">After each run, it looks back and keeps a short note when something will help next time; later runs read them first.</p>}
        </div>
        <Switch checked={checked} onChange={onChange} busy={busy} disabled={disabled} labelledBy={id} />
      </div>
      {server === "off" && <p className="font-mono text-label text-warning-text">This server has learning turned off, so no run learns until it's on.</p>}
      {problem}
    </div>
  );
}

/** The editor's Settings step's "Learning" field, its label as the step's other fields have it: the switch as the form
 *  holds it, on when the form says so, else as the definition was saved (`saved`). Put back off on an agent that never
 *  said, it says nothing again, so the switch alone makes no new revision. `error` and `warning`: a refused save's and a
 *  save's, for the field. */
export function LearningField({ fields, onFields, saved, server, error, warning }: { fields: AgentFields; onFields: (patch: AgentFields) => void; saved?: boolean | "notes"; server?: "on" | "off"; error?: string; warning?: string }) {
  const value = fields.learning ?? saved;
  const on = value === true || value === "notes";
  // A value equal to the saved one is no change of the form's, so choosing back what was saved makes no new revision.
  const pick = (next: boolean | "notes") => onFields({ learning: next === saved || (next === false && saved === undefined) ? undefined : next });
  return (
    <div>
      <div className="mb-2"><span className="caps text-small font-semibold">Learning</span></div>
      <LearningSwitch id="learning-switch" className="border px-4 py-3" checked={on} server={server}
        onChange={(next) => pick(next ? (saved === "notes" ? "notes" : true) : false)} />
      {on && (
        <fieldset aria-label="What it learns" className="mt-2 space-y-2">
          {([[true, "Notes, skills and workflows", "Once a job repeats, it can learn it as a workflow and run it as one step."], ["notes", "Notes and skills only", "It never runs a learned workflow, and is never asked to draft one."]] as const).map(([kind, label, note]) => (
            <label key={String(kind)} className={cn("flex items-start gap-3 border px-3 py-2.5", value === kind && "border-foreground")}>
              <input type="radio" name="learning-kind" className="mt-1 accent-primary" checked={value === kind} onChange={() => pick(kind)} />
              <span><span className="font-mono text-body">{label}</span><span className="block text-small text-muted-foreground">{note}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="mt-2 font-mono text-small text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-small text-warning-text">{warning}</p>}
    </div>
  );
}
