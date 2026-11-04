import { Brain, ChevronRight, CircleAlert, CircleDollarSign, FileText, Flag, LoaderCircle, MessageCircleQuestion, MessageSquareText, Scale, User, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { clock } from "@/lib/format";
import { rowDetail, rowFailed, type Step, steps } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";
import { NO_ANSWER } from "@/lib/viewing";

const ICON: Record<string, typeof Brain> = {
  user_message: User, thinking: Brain, tool_use: Wrench, tool_result: Wrench, waiting: MessageCircleQuestion,
  usage: CircleDollarSign, final_answer: FileText, phase: Flag, error: CircleAlert, decision: Scale, text_block: MessageSquareText,
};

/** A line's own Markdown, bold (`**…**`) and code (`` `…` ``) only, as elements; the rest stays text (React escapes it,
 *  so no HTML gets through), and a mark with no partner stays as typed. Code inside bold is code; bold inside code is
 *  as typed. `__…__` is not bold here: a step names files like `__init__.py`. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*\n]+?\*\*|`[^`\n]+`)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 0 ? p
      : p.startsWith("`") ? <code key={i} className="font-mono text-[0.9em]">{p.slice(1, -1)}</code>
      // A command inside bold is code there too (a model's heading, **Run `npm test` first**); bold can't nest in bold.
      : <strong key={i} className="font-semibold">{inline(p.slice(2, -2))}</strong>);
}

/** The title a row shows: its summary without the kind's own prefix ("Thinking: ", "You: "), its bold and code shown as
 *  such (a model's thinking is often a bold heading; a command is in backticks). */
const title = (row: TimelineRow): ReactNode => {
  const text = row.summary.replace(/^(You|Thinking|Asked you|Waiting for you):\s*/, "");
  // A workflow run's input is a JSON object: show its fields, not its braces.
  if (row.kind === "user_message" && text.startsWith("{")) {
    try { return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "); } catch { /* not whole JSON: as is */ }
  }
  // An answer the agent left empty is said, not shown as a blank step; a written one shows its first line without its
  // block marks (a heading's #, a quote's >, a list's -).
  if (row.kind === "final_answer") return text.trim() || row.text?.trim() ? inline(text.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, "")) : NO_ANSWER;
  return inline(text);
};

/** A tool's label as a person reads it, whatever the harness calls it ("Fetch" for web_fetch and WebFetch, "Shell" for
 *  bash); any other id as words ("browser_release" is "Browser release"). An MCP server's prefix (`mcp__hands__`) goes. */
// A Map, so a tool named like an Object property (`__proto__`, `constructor`: an imported session names its own tools)
// finds nothing here and reads as words, never as the lookup's prototype.
const TOOL = new Map<string, string>(Object.entries({
  read: "Read", write: "Write", edit: "Edit", multiedit: "Edit", apply_patch: "Edit", notebookedit: "Edit",
  bash: "Shell", shell: "Shell", local_shell: "Shell", exec_command: "Shell",
  web_fetch: "Fetch", webfetch: "Fetch", fetch: "Fetch", web_search: "Search", websearch: "Search",
  ls: "List files", glob: "Find files", find: "Find files", grep: "Search files",
  ask_person: "Question", submit: "Answer", codemode: "Script", todowrite: "To-dos", task: "Subagent", skill: "Skill",
}));
function toolLabel(id: string): string {
  const bare = id.replace(/^mcp__.+?__/, "");
  const known = TOOL.get(bare.toLowerCase());
  if (known) return known;
  const words = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}
/** How long a tool took: "27 ms", or "3.5 s" from a second on. */
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const label = (row: TimelineRow) =>
  ({ user_message: "You", thinking: "Thinking", tool_use: row.tool_name ? toolLabel(row.tool_name) : "Tool", tool_result: row.tool_name ? toolLabel(row.tool_name) : "Result", waiting: "Waiting for you", usage: "Usage", final_answer: "Answer", phase: "Phase", error: "Error", decision: "Decision", text_block: "Text" })[row.kind] ?? row.kind;

/** One step. With one row per action, a call's row carries its own outcome: `running` until it ends (a spinner), a
 *  failed or interrupted one reads as failed, and a missing one (a read that found nothing the run wrote) is grey. */
function Row({ step, last }: { step: Step; last: boolean }) {
  // The row a step shows, and so its label: the one place a row is read for display.
  const row = step.row;
  const [open, setOpen] = useState(false);
  const running = row.kind === "tool_use" && row.tool_status === "running";
  const Icon = running ? LoaderCircle : ICON[row.kind] ?? Flag;
  const detail = step.above ? null : step.detail ?? rowDetail(row);
  const interrupted = row.tool_status === "interrupted";
  const failed = rowFailed(row) || interrupted;
  const missing = row.tool_status === "missing";
  return (
    <li className="relative flex gap-3">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span className={cn("mt-3 flex size-7 items-center justify-center border bg-background", row.kind === "waiting" && "border-warning/60 text-warning-text", failed && "border-destructive/60 text-destructive-text", missing && "text-muted-foreground")}>
          <Icon className={cn("size-3.5", running && "animate-spin text-run-active")} aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-border" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 border-b py-3">
        <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!detail}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {label(row)}
              {row.kind === "waiting" && <Chip tone="warning">Input required</Chip>}
              {failed && <Chip tone="error">{interrupted ? "Interrupted" : "Error"}</Chip>}
              {row.agent_label && <Chip>{row.agent_label}</Chip>}
              {step.ms !== undefined && <span className="font-mono text-[11px]">{took(step.ms)}</span>}
              {step.times && <span className="font-mono text-[11px]">{step.times} times{step.until ? ` over ${took(Math.max(0, Date.parse(step.until) - Date.parse(row.timestamp)))}` : ""}</span>}
            </span>
            <span className={cn("mt-0.5 block break-words text-[15px] leading-snug", missing && "text-muted-foreground")}>{step.above ? "Asked you the question above." : title(row)}</span>
            {step.saved && <span className="mt-0.5 block font-mono text-[12px] text-muted-foreground">saved {step.saved}</span>}
          </span>
          <span className="caps shrink-0 pt-0.5 text-[11px] text-muted-foreground">{clock(row.timestamp)}</span>
          {detail && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
        </button>
        {/* A tool step opens to the tool's own id too: its label is a word, and the id is what a log or the API says. */}
        {open && detail && row.tool_name && <p className="mt-3 font-mono text-[11px] text-muted-foreground">{row.tool_name}</p>}
        {open && detail && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words border bg-card p-3 font-mono text-[12px] leading-[1.7]">{detail}</pre>}
      </div>
    </li>
  );
}

/** The run's live timeline as a step list (lib/timeline's `steps`: each tool once, from either of the server's shapes;
 *  a question once; repeated failures once): newest last, older steps folded behind "N earlier steps". `asking`: the
 *  waiting row of the question the page shows above while the run waits on it; its step points there. */
export function Timeline({ rows, live, fold = 6, asking }: { rows: TimelineRow[]; live: boolean; fold?: number; asking?: string }) {
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
      <ol>{shown.map((step, i) => <Row key={step.row.id} step={step} last={i === shown.length - 1 && !live} />)}</ol>
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
