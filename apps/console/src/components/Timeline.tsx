import { Brain, ChevronRight, CircleAlert, CircleDollarSign, CirclePause, FileText, Flag, LoaderCircle, MessageCircleQuestion, MessageSquareText, Scale, ShieldQuestion, User, Wrench } from "lucide-react";
import { useState } from "react";
import { BROWSER_TOOL_NAMES } from "@pi-browser/contract";
import { nameOf } from "@timeline/labels";
import { Chip } from "@/components/ui/chip";
import { clock } from "@/lib/format";
import { mcpToolLabel } from "@/lib/mcp";
import { rowDetail, rowFailed, rowPaused, type Step, steps } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";

const ICON: Record<string, typeof Brain> = {
  user_message: User, thinking: Brain, tool_use: Wrench, tool_result: Wrench, waiting: MessageCircleQuestion,
  usage: CircleDollarSign, final_answer: FileText, phase: Flag, error: CircleAlert, decision: Scale, text_block: MessageSquareText,
  tool_approval_requested: ShieldQuestion,
};
/** What a declining message that a stop or a cancel overtook said, never sent: the server keeps it in the approval row's
 *  text, after its arguments ("Not sent: the run was stopped. Your message: …"). */
const notSent = (row: TimelineRow) => (row.kind === "tool_approval_requested" ? /\n\n(Not sent: [\s\S]*)$/.exec(row.text ?? "")?.[1] : undefined);
/** A tool call's approval row while the call still waits: its summary (the server's) says so. */
const awaitsApproval = (row: TimelineRow) => row.kind === "tool_approval_requested" && row.summary.startsWith("Waiting for your approval");

/** A message the server wrote into the run (served `origin: "server"`): AgentRun's, never the person's. */
const fromServer = (row: TimelineRow) => row.origin === "server";
/** The title a row shows: its summary without the kind's own prefix ("Thinking: ", "You: ", a server message's
 *  "AgentRun: "). */
const title = (row: TimelineRow) => {
  const text = row.summary.replace(fromServer(row) ? /^AgentRun:\s*/ : /^(You|Thinking|Asked you|Waiting for you):\s*/, "");
  // A workflow run's input is a JSON object: show its fields, not its braces.
  if (row.kind === "user_message" && text.startsWith("{")) {
    try { return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "); } catch { /* not whole JSON: as is */ }
  }
  // An answer's first line as text: its markdown (a heading's #, bold's **, code's `) is not shown as typed. The summary is
  // that first line (the server's), so an answer with more says so with "…": the rest is a click away, never dropped unseen.
  if (row.kind === "final_answer") {
    const more = (row.text ?? "").split("\n").filter((l) => l.trim()).length > 1;
    return `${text.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, "").replace(/(\*\*|__|`)/g, "")}${more ? "…" : ""}`;
  }
  return text;
};
/** How long a tool took: "27 ms", or "3.5 s" from a second on. */
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
/** pi-browser's tools. Their wire names ("run", "snapshot") say nothing of the browser, so their rows take the name the
 *  timeline library gives each (nameOf: "Open or act on a page in the browser", as a run's tool counts show it). */
const BROWSER = new Set<string>(BROWSER_TOOL_NAMES);
/** A tool's name as the label says it: an MCP server's tool as `<server> · <tool>`, a browser tool by its name, any
 *  other as the harness names it. */
const toolName = (tool: string | null | undefined) => (tool ? (mcpToolLabel(tool) ?? (BROWSER.has(tool) ? nameOf(tool) : tool)) : tool);
const label = (row: TimelineRow) => fromServer(row) ? "AgentRun" :
  ({ user_message: "You", thinking: "Thinking", tool_use: toolName(row.tool_name) ?? "Tool", tool_result: toolName(row.tool_name) ?? "Result", waiting: "Waiting for you", usage: "Usage", final_answer: "Answer", phase: "Phase", error: "Error", decision: "Decision", text_block: "Text", tool_approval_requested: "Your approval" })[row.kind] ?? row.kind;

/** A waiting row's chip, by what the run waits on now (its `pending.kind`, the run page's to pass: a row carries no kind
 *  of its own), as the run header's status chip says it. Only a wait whose row is a `waiting` one: a cap pause's. An
 *  approval waits on its own tool_approval_requested row, which carries "Approval required"; the newest waiting row
 *  then is an earlier question, answered. */
const WAITING_CHIP: Record<string, string> = { budget: "Paused at cap" };

/** One step. With one row per action, a call's row carries its own outcome: `running` until it ends (a spinner), a
 *  failed or interrupted one reads as failed, and a missing one (a read that found nothing the run wrote) is grey. A
 *  server row marked `paused` (the run paused at its cap) shows a pause icon, muted like any server row. */
function Row({ step, last, waitingChip }: { step: Step; last: boolean; waitingChip?: string }) {
  // The row a step shows, and so its label: the one place a row is read for display.
  const row = step.row;
  const [open, setOpen] = useState(false);
  const running = row.kind === "tool_use" && row.tool_status === "running";
  const paused = rowPaused(row);
  const Icon = running ? LoaderCircle : paused ? CirclePause : ICON[row.kind] ?? Flag;
  // What the row says on its line: its title, or where the page shows what it asks.
  const shown = step.above ? (row.kind === "tool_approval_requested" ? "Waits for your approval above." : "Asked you the question above.") : title(row);
  // What opens under it; none when it is the line's own words (the same sentence twice is no more to read).
  const more = step.above ? null : step.detail ?? rowDetail(row);
  const detail = more && more.trim() !== shown.trim() ? more : null;
  const interrupted = row.tool_status === "interrupted";
  const failed = rowFailed(row) || interrupted;
  const missing = row.tool_status === "missing";
  return (
    <li className="relative flex gap-3">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span className={cn("mt-3 flex size-7 items-center justify-center border bg-background", (row.kind === "waiting" || awaitsApproval(row)) && "border-warning/60 text-warning-text", failed && "border-destructive/60 text-destructive-text", missing && "text-muted-foreground")}>
          <Icon className={cn("size-3.5", running && "animate-spin text-run-active")} aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-border" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 border-b py-3">
        <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!detail}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {label(row)}
              {row.kind === "waiting" && <Chip tone="warning">{waitingChip ?? "Input required"}</Chip>}
              {awaitsApproval(row) && <Chip tone="warning">Approval required</Chip>}
              {failed && <Chip tone="error">{interrupted ? "Interrupted" : "Error"}</Chip>}
              {row.agent_label && <Chip>{row.agent_label}</Chip>}
              {step.ms !== undefined && <span className="font-mono text-[11px]">{took(step.ms)}</span>}
              {step.times && <span className="font-mono text-[11px]">{step.times} times{step.until ? ` over ${took(Math.max(0, Date.parse(step.until) - Date.parse(row.timestamp)))}` : ""}</span>}
            </span>
            <span className={cn("mt-0.5 block break-words text-[15px] leading-snug", (missing || fromServer(row)) && "text-muted-foreground")}>{shown}</span>
            {step.saved && <span className="mt-0.5 block font-mono text-[12px] text-muted-foreground">saved {step.saved}</span>}
            {notSent(row) && <span className="mt-0.5 block break-words text-[13px] text-muted-foreground">{notSent(row)}</span>}
          </span>
          <span className="caps shrink-0 pt-0.5 text-[11px] text-muted-foreground">{clock(row.timestamp)}</span>
          {detail && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
        </button>
        {open && detail && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words border bg-card p-3 font-mono text-[12px] leading-[1.7]">{detail}</pre>}
      </div>
    </li>
  );
}

/** The run's live timeline as a step list (lib/timeline's `steps`: each tool once, from either of the server's shapes;
 *  a question once; repeated failures once): newest last, older steps folded behind "N earlier steps". `asking`: the
 *  waiting row of the question the page shows above while the run waits on it; its step points there. */
export function Timeline({ rows, live, fold = 6, asking, waitingOn }: { rows: TimelineRow[]; live: boolean; fold?: number; asking?: string;
  /** What the run waits on now (its `pending.kind`): the newest waiting row's chip says so. */
  waitingOn?: string }) {
  const current = waitingOn ? rows.findLast((r) => r.kind === "waiting")?.id : undefined;
  const [all, setAll] = useState(false);
  const told = steps(rows).map((s) => (asking && s.row.id === asking ? { ...s, above: true } : s));
  const hidden = all ? 0 : Math.max(0, told.length - fold);
  const shown = told.slice(hidden);
  if (!rows.length) return <Working title={live ? "The run is starting" : "Nothing on the timeline"} note={live ? "Steps appear here as the agent works." : "This run recorded no steps."} spin={live} />;
  return (
    <div>
      {hidden > 0 && (
        <button type="button" className="caps mb-1 ml-10 flex items-center gap-1 py-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          <ChevronRight className="size-3" aria-hidden /> {hidden} earlier steps
        </button>
      )}
      <ol>{shown.map((step, i) => <Row key={step.row.id} step={step} last={i === shown.length - 1 && !live} waitingChip={step.row.id === current && waitingOn ? WAITING_CHIP[waitingOn] : undefined} />)}</ol>
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
