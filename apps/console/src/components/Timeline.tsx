import { Brain, ChevronRight, CircleAlert, CircleDollarSign, CirclePause, FileText, Flag, LoaderCircle, MessageCircleQuestion, MessageSquareText, Scale, ShieldQuestion, User, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { BROWSER_TOOL_NAMES } from "@pi-browser/contract";
import { nameOf } from "@timeline/labels";
import { Chip } from "@/components/ui/chip";
import { clock } from "@/lib/format";
import { mcpToolLabel } from "@/lib/mcp";
import { rowDetail, rowFailed, rowPaused, type Step, steps } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";
import { NO_ANSWER } from "@/lib/viewing";

const ICON: Record<string, typeof Brain> = {
  user_message: User, thinking: Brain, tool_use: Wrench, tool_result: Wrench, waiting: MessageCircleQuestion,
  usage: CircleDollarSign, final_answer: FileText, phase: Flag, error: CircleAlert, decision: Scale, text_block: MessageSquareText,
  tool_approval_requested: ShieldQuestion,
};
/** What a declining message that a stop or a cancel overtook said, never sent: the server keeps it in the approval row's
 *  text, after its arguments ("Not sent: the run was stopped. Your message: …"). */
const notSent = (row: TimelineRow) => (row.kind === "tool_approval_requested" ? /\n\n(Not sent: [\s\S]*)$/.exec(row.text ?? "")?.[1] : undefined);
/** A tool call's approval row while the call still waits: its summary (the server's) says so. */
const awaitsApproval = (row: TimelineRow) => row.kind === "tool_approval_requested" && (row.summary ?? "").startsWith("Waiting for your approval");

/** A message the server wrote into the run (served `origin: "server"`): AgentRun's, never the person's. */
const fromServer = (row: TimelineRow) => row.origin === "server";
/** A trigger's message, a webhook's input or a schedule's (served `origin: "trigger"`): the trigger's, never the person's. */
const fromTrigger = (row: TimelineRow) => row.origin === "trigger";
/** A trigger row's summary split at its "<Source> <its name>: " prefix: `who`, the trigger in its own words as serve
 *  names it now ("Webhook inbound-lead", "Schedule nightly", or the id once it is deleted), and `said`, the message. The
 *  split is exactly at the name the row carries (`trigger.name`, serve's, after its one-word source), so a name or a
 *  message with a colon in it keeps both whole; with no name (a trigger gone, named by its id) at the first ": ". A
 *  summary with no prefix has no `who`. Nothing is looked up: the served row says it. */
const triggerParts = (row: TimelineRow): { who: string | null; said: string } => {
  const summary = row.summary ?? "";
  const name = row.trigger?.name;
  const at = name ? summary.indexOf(` ${name}: `) : -1;
  if (name && at > 0 && !summary.slice(0, at).includes(" ")) return { who: summary.slice(0, at + 1 + name.length), said: summary.slice(at + name.length + 3).trimStart() };
  const m = /^([^:]+):\s*/.exec(summary);
  return m ? { who: m[1]!, said: summary.slice(m[0].length) } : { who: null, said: summary };
};
/** A line's own Markdown, bold (`**…**`) and code (`` `…` ``) only, as elements; the rest stays text (React escapes it,
 *  so no HTML gets through), and a mark with no partner stays as typed. Code inside bold is code; bold inside code is as
 *  typed. `__…__` is not bold here: a step names files like `__init__.py`. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*\n]+?\*\*|`[^`\n]+`)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 0 ? p
      : p.startsWith("`") ? <code key={i} className="font-mono text-[0.9em]">{p.slice(1, -1)}</code>
      // A command inside bold is code there too (a model's heading, **Run `npm test` first**); bold can't nest in bold.
      : <strong key={i} className="font-semibold">{inline(p.slice(2, -2))}</strong>);
}

/** The title a row shows: its summary without the kind's own prefix ("Thinking: ", "You: ", a server message's
 *  "AgentRun: ", a trigger's "<Source> <its name>: ", e.g. "Webhook inbound-lead: ", which is that row's label). Its
 *  bold and code show as such (`inline`, where the row is drawn). */
const title = (row: TimelineRow) => {
  const text = fromTrigger(row) ? triggerParts(row).said : (row.summary ?? "").replace(fromServer(row) ? /^AgentRun:\s*/ : /^(You|Thinking|Asked you|Waiting for you):\s*/, "");
  // A workflow run's input is a JSON object: show its fields, not its braces.
  if (row.kind === "user_message" && text.startsWith("{")) {
    try { return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "); } catch { /* not whole JSON: as is */ }
  }
  // An answer's or your message's summary is its first line (the server's), so one with more says so with "…": the rest
  // is a click away, never dropped unseen.
  const more = (row.text ?? "").split("\n").filter((l) => l.trim()).length > 1 ? "…" : "";
  // An answer the agent left empty is said, not shown as a blank step; a written one shows its first line without its
  // block marks (a heading's #, a quote's >, a list's -), its bold and code as such.
  if (row.kind === "final_answer") return text.trim() || row.text?.trim() ? `${text.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, "")}${more}` : NO_ANSWER;
  if (row.kind === "user_message") return `${text}${more}`;
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
const label = (row: TimelineRow) => fromServer(row) ? "AgentRun" : fromTrigger(row) ? (triggerParts(row).who ?? "Trigger") :
  ({ user_message: "You", thinking: "Thinking", tool_use: toolName(row.tool_name) ?? "Tool", tool_result: toolName(row.tool_name) ?? "Result", waiting: "Waiting for you", usage: "Usage", final_answer: "Answer", phase: "Phase", error: "Error", decision: "Decision", text_block: "Text", tool_approval_requested: "Your approval", learning: "Learning" } as Partial<Record<string, string>>)[row.kind] ?? row.kind;

/** A waiting row's chip, by what the run waits on now (its `pending.kind`, the run page's to pass: a row carries no kind
 *  of its own), as the run header's status chip says it. Only a wait whose row is a `waiting` one: a cap pause's. An
 *  approval waits on its own tool_approval_requested row, which carries "Approval required"; the newest waiting row
 *  then is an earlier question, answered. */
const WAITING_CHIP: Record<string, string> = { budget: "Paused at cap" };

/** One step: a failed one reads as failed. A server row marked `paused` (the run paused at its cap) shows a pause icon,
 *  muted like any server row. */
function Row({ step, last, waitingChip }: { step: Step; last: boolean; waitingChip?: string }) {
  // The row a step shows, and so its label: the one place a row is read for display.
  const row = step.row;
  const [open, setOpen] = useState(false);
  const paused = rowPaused(row);
  const Icon = paused ? CirclePause : ICON[row.kind] ?? Flag;
  // What the row says on its line: its title, or where the page shows what it asks.
  const shown = step.above ? (row.kind === "tool_approval_requested" ? "Waits for your approval above." : "Asked you the question above.") : title(row);
  // What opens under it; none when it is the line's own words (the same sentence twice is no more to read).
  const more = step.above ? null : step.detail ?? rowDetail(row);
  const detail = more && more.trim() !== shown.trim() ? more : null;
  const failed = rowFailed(row);
  return (
    <li className="relative flex gap-3">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span className={cn("mt-3 flex size-7 items-center justify-center border bg-background", (row.kind === "waiting" || awaitsApproval(row)) && "border-warning/60 text-warning-text", failed && "border-destructive/60 text-destructive-text")}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-border" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 border-b py-3">
        <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!detail}>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
              {/* A label can be long (a trigger's name, up to 200 characters, spaces or none): cut to the row's width, so it
                  never widens the page or runs over the time; whole on hover. */}
              <span data-label className="min-w-0 truncate" title={label(row)}>{label(row)}</span>
              {row.kind === "waiting" && <Chip tone="warning">{waitingChip ?? "Input required"}</Chip>}
              {awaitsApproval(row) && <Chip tone="warning">Approval required</Chip>}
              {failed && <Chip tone="error">Error</Chip>}
              {row.agent_label && <Chip>{row.agent_label}</Chip>}
              {step.ms !== undefined && <span className="font-mono text-[11px]">{took(step.ms)}</span>}
              {step.times && <span className="font-mono text-[11px]">{step.times} times{step.until ? ` over ${took(Math.max(0, Date.parse(step.until) - Date.parse(row.timestamp)))}` : ""}</span>}
            </span>
            <span className={cn("mt-0.5 block break-words text-[15px] leading-snug", fromServer(row) && "text-muted-foreground")}>{inline(shown)}</span>
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
  // The cap's own waiting row: the newest after the server's newest pause row (`paused`), so while the pages still arrive
  // an earlier question, answered, never takes the cap's chip. Only a cap pause has a chip of its own (WAITING_CHIP).
  const pauseAt = waitingOn === "budget" ? rows.findLastIndex((r) => r.paused === true) : -1;
  const current = pauseAt >= 0 ? rows.slice(pauseAt + 1).findLast((r) => r.kind === "waiting")?.id : undefined;
  const [all, setAll] = useState(false);
  const told = steps(rows).map((s) => (asking && s.row.id === asking ? { ...s, above: true } : s));
  const hidden = all ? 0 : Math.max(0, told.length - fold);
  const shown = told.slice(hidden);
  if (!rows.length) return <Working title={live ? "The run is starting" : "Nothing on the timeline"} note={live ? "Steps appear here as the agent works." : "This run recorded no steps."} spin={live} />;
  return (
    <div>
      {hidden > 0 && (
        <button type="button" className="caps mb-1 ml-10 flex items-center gap-1 py-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          <ChevronRight className="size-3" aria-hidden /> {hidden} earlier {hidden === 1 ? "step" : "steps"}
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
