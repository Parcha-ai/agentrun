import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { type AgentFields, type ToolOffer, toolsFor } from "@/lib/agentForm";
import { cn } from "@/lib/utils";

/** "Learns from its runs": the agent's learning switch (its definition's `learning`), named, said in one line, with a
 *  quiet note when the agent lacks the write tool (`noWrite`; `onAddWrite` adds it, else the note says where) and when
 *  the server has learning off. `quiet` leaves out the line, beside text that says it already. The editor's Settings
 *  step and the agent's Learning tab both show it; neither owns its look. */
export function LearningSwitch({ id, checked, onChange, busy, disabled, quiet, server, noWrite, onAddWrite, problem, className }: {
  id: string; checked: boolean; onChange: (on: boolean) => void; busy?: boolean; disabled?: boolean; quiet?: boolean; server?: "on" | "off" | null;
  noWrite?: boolean; onAddWrite?: () => void; problem?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className={cn("flex gap-4", quiet ? "items-center" : "items-start")}>
        <div className="min-w-0 flex-1">
          <p id={id} className="text-[14px] font-semibold">Learns from its runs</p>
          {!quiet && <p className="mt-0.5 text-[13px] text-muted-foreground">After each run, it looks back and keeps a short note when something will help next time; later runs read them first.</p>}
        </div>
        <Switch checked={checked} onChange={onChange} busy={busy} disabled={disabled} labelledBy={id} />
      </div>
      {checked && noWrite && (
        <p className="font-mono text-[11px] text-muted-foreground">Needs the write tool, for now.{onAddWrite
          ? <> <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onAddWrite}>Add it</button></>
          : " Add it in the editor's Tools step."}</p>
      )}
      {server === "off" && <p className="font-mono text-[11px] text-warning-text">This server has learning turned off, so no run learns until it's on.</p>}
      {problem}
    </div>
  );
}

/** The editor's Settings step's "Learning" field, its label as the step's other fields have it: the switch as the form
 *  holds it, on when the form says so, else as the definition was saved (`saved`). Put back off on an agent that never
 *  said, it says nothing again, so the switch alone makes no new revision. Off to on without the write tool offers to
 *  tick it, when its harness runs it here. `error` and `warning`: a refused save's and a save's, for the field. */
export function LearningField({ fields, onFields, saved, tools, server, error, warning }: { fields: AgentFields; onFields: (patch: AgentFields) => void; saved?: boolean; tools: ToolOffer[]; server?: "on" | "off"; error?: string; warning?: string }) {
  const on = (fields.learning ?? saved) === true;
  const canWrite = toolsFor(fields.harness ?? "pi", tools).some((t) => t.name === "write" && t.available);
  return (
    <div>
      <div className="mb-2"><span className="caps text-[12px] font-semibold">Learning</span></div>
      <LearningSwitch id="learning-switch" className="border px-4 py-3" checked={on} server={server}
        onChange={(next) => onFields({ learning: next ? true : saved === undefined ? undefined : false })}
        noWrite={!(fields.tools ?? []).includes("write")} onAddWrite={canWrite ? () => onFields({ tools: [...(fields.tools ?? []), "write"] }) : undefined} />
      {error && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-[12px] text-warning-text">{warning}</p>}
    </div>
  );
}
