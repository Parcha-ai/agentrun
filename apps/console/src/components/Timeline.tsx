import { Brain, ChevronRight, CircleAlert, CircleDollarSign, FileText, Flag, LoaderCircle, MessageCircleQuestion, User, Wrench } from "lucide-react";
import { useState } from "react";
import { Chip } from "@/components/ui/chip";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";

const ICON: Record<string, typeof Brain> = {
  user_message: User, thinking: Brain, tool_use: Wrench, tool_result: Wrench, waiting: MessageCircleQuestion,
  usage: CircleDollarSign, final_answer: FileText, phase: Flag, error: CircleAlert,
};

/** The title a row shows: its summary without the kind's own prefix ("Thinking: ", "You: "). */
const title = (row: TimelineRow) => {
  const text = row.summary.replace(/^(You|Thinking|Asked you|Waiting for you):\s*/, "");
  // A workflow run's input is a JSON object: show its fields, not its braces.
  if (row.kind === "user_message" && text.startsWith("{")) {
    try { return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "); } catch { /* not whole JSON: as is */ }
  }
  return text;
};
const label = (row: TimelineRow) =>
  ({ user_message: "You", thinking: "Thinking", tool_use: row.tool_name ?? "Tool", tool_result: row.tool_name ?? "Result", waiting: "Waiting for you", usage: "Usage", final_answer: "Answer", phase: "Phase", error: "Error" })[row.kind] ?? row.kind;

function Row({ row, last }: { row: TimelineRow; last: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[row.kind] ?? Flag;
  const detail = row.kind === "tool_use" ? row.tool_input_preview : row.kind === "tool_result" ? row.tool_result_preview : row.text;
  const failed = row.tool_status === "error" || row.kind === "error";
  return (
    <li className="relative flex gap-3">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span className={cn("mt-3 flex size-7 items-center justify-center border bg-background", row.kind === "waiting" && "border-warning/60 text-warning-text", failed && "border-destructive/60 text-destructive-text")}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-border" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 border-b py-3">
        <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!detail}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {label(row)}
              {row.kind === "waiting" && <Chip tone="warning">Input required</Chip>}
              {failed && <Chip tone="error">Error</Chip>}
              {row.agent_label && <Chip>{row.agent_label}</Chip>}
            </span>
            <span className="mt-0.5 block break-words text-[15px] leading-snug">{title(row)}</span>
          </span>
          <span className="caps shrink-0 pt-0.5 text-[11px] text-muted-foreground">{clock(row.timestamp)}</span>
          {detail && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
        </button>
        {open && detail && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words border bg-card p-3 font-mono text-[12px] leading-[1.7]">{detail}</pre>}
      </div>
    </li>
  );
}

/** The run's live timeline as a step list: newest last, older steps folded behind "N earlier steps". */
export function Timeline({ rows, live, fold = 6 }: { rows: TimelineRow[]; live: boolean; fold?: number }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, rows.length - fold);
  const shown = rows.slice(hidden);
  if (!rows.length) return <Working title={live ? "The run is starting" : "Nothing on the timeline"} note={live ? "Steps appear here as the agent works." : "This run recorded no steps."} spin={live} />;
  return (
    <div>
      {hidden > 0 && (
        <button type="button" className="caps mb-1 ml-10 flex items-center gap-1 py-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          <ChevronRight className="size-3" aria-hidden /> {hidden} earlier steps
        </button>
      )}
      <ol>{shown.map((row, i) => <Row key={row.id} row={row} last={i === shown.length - 1 && !live} />)}</ol>
      {live && <Working title="Working" note="Steps appear as the agent takes them." spin />}
    </div>
  );
}

/** A centred progress note: a spinner, a mono caps title and one muted line. */
export function Working({ title, note, spin = true }: { title: string; note: string; spin?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      {spin && <LoaderCircle className="size-5 animate-spin text-run-active" aria-hidden />}
      <p className="caps text-[11px] font-semibold">{title}</p>
      <p className="max-w-sm text-[13px] text-muted-foreground">{note}</p>
    </div>
  );
}
