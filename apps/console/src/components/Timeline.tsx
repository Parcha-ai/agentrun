import { Brain, ChevronRight, CircleAlert, CircleDollarSign, CirclePause, FileText, Flag, MessageCircleQuestion, MessageSquareText, Monitor, Scale, ShieldQuestion, User, Workflow, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { BROWSER_TOOL_NAMES } from "@pi-browser/contract";
import { callWords, type ComputerCallRow } from "@timeline/computer";
import { nameOf } from "@timeline/labels";
import { Chip } from "@/components/ui/chip";
import { Spinner } from "@/components/ui/spinner";
import { chargeWords, clock, markdown, openLinkedFile } from "@/lib/format";
import { mcpToolLabel } from "@/lib/mcp";
import { rowDetail, rowFailed, rowPaused, rowRefused, type Step, steps } from "@/lib/timeline";
import { kindWithModel, ranOnWords } from "@/lib/nodeModel";
import { cn } from "@/lib/utils";
import type { LearnedNode, RunFile, TimelineRow } from "@/lib/v2";
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
 *  so no HTML gets through), and a mark with no partner stays as typed. Code inside bold is code; bold inside code is
 *  as typed. `__…__` is not bold here: a step names files like `__init__.py`. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*\n]+?\*\*|`[^`\n]+`)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 0 ? p
      : p.startsWith("`") ? <code key={i} className="font-mono">{p.slice(1, -1)}</code>
      // A command inside bold is code there too (a model's heading, **Run `npm test` first**); bold can't nest in bold.
      : <strong key={i} className="font-semibold">{inline(p.slice(2, -2))}</strong>);
}

/** The title a row shows: its summary without the kind's own prefix ("Thinking: ", "You: ", a server message's
 *  "AgentRun: ", a trigger's "<Source> <its name>: ", e.g. "Webhook inbound-lead: ", which is that row's label). */
const title = (row: TimelineRow) => {
  const text = fromTrigger(row) ? triggerParts(row).said : (row.summary ?? "").replace(fromServer(row) ? /^AgentRun:\s*/ : /^(You|Thinking|Asked you|Waiting for you):\s*/, "");
  // A workflow run's input is a JSON object: show its fields, not its braces.
  if (row.kind === "user_message" && text.startsWith("{")) {
    try { return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "); } catch { /* not whole JSON: as is */ }
  }
  // The summary is the text's first line (the server's), so an answer or your message with more says so with "…": the
  // rest is a click away (the row opens its text whole), never dropped unseen.
  const more = (row.text ?? "").split("\n").filter((l) => l.trim()).length > 1 ? "…" : "";
  // An answer's first line without its block marks (a heading's #, a quote's >, a list's -); its bold and code are
  // drawn by `inline`. An answer left empty is said, not shown as a blank step.
  if (row.kind === "final_answer") {
    if (!text.trim() && !row.text?.trim()) return NO_ANSWER;
    return `${text.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, "")}${more}`;
  }
  if (row.kind === "user_message") return `${text}${more}`;
  return text;
};
/** How long a tool took: "27 ms", or "3.5 s" from a second on. */
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
/** pi-browser's tools. Their wire names ("run", "snapshot") say nothing of the browser, so their rows take the name the
 *  timeline library gives each (nameOf: "Open or act on a page in the browser", as a run's tool counts show it). */
const BROWSER = new Set<string>(BROWSER_TOOL_NAMES);
/** A built-in tool's label as a person reads it, whatever the harness calls it ("Fetch" for web_fetch and WebFetch, "Shell"
 *  for bash); any other id as words ("browser_release" is "Browser release"). */
// A Map, so a tool named like an Object property (`__proto__`, `constructor`: an imported session names its own tools)
// finds nothing here and reads as words, never as the lookup's prototype.
const TOOL = new Map<string, string>(Object.entries({
  read: "Read", write: "Write", edit: "Edit", multiedit: "Edit", apply_patch: "Edit", notebookedit: "Edit",
  bash: "Shell", shell: "Shell", local_shell: "Shell", exec_command: "Shell",
  web_fetch: "Fetch", webfetch: "Fetch", fetch: "Fetch", web_search: "Search", websearch: "Search",
  ls: "List files", glob: "Find files", find: "Find files", grep: "Search files",
  ask_person: "Question", submit: "Answer", codemode: "Script", todowrite: "To-dos", task: "Subagent", skill: "Skill",
}));
function toolWords(id: string): string {
  const bare = id.replace(/^mcp__.+?__/, "");
  const known = TOOL.get(bare.toLowerCase());
  if (known) return known;
  const words = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}
/** A tool's name as the label says it: an MCP server's tool as `<server> · <tool>`, a browser tool by its name, any
 *  other in words. */
const toolName = (tool: string | null | undefined) => (tool ? (mcpToolLabel(tool) ?? (BROWSER.has(tool) ? nameOf(tool) : toolWords(tool))) : tool);
const label = (row: TimelineRow) => fromServer(row) ? "AgentRun" : fromTrigger(row) ? (triggerParts(row).who ?? "Trigger") :
  ({ user_message: "You", thinking: "Thinking", tool_use: toolName(row.tool_name) ?? "Tool", tool_result: toolName(row.tool_name) ?? "Result", waiting: "Waiting for you", usage: "Usage", final_answer: "Answer", phase: "Phase", error: "Error", decision: "Decision", text_block: "Text", tool_approval_requested: "Your approval", learning: "Learning" } as Partial<Record<string, string>>)[row.kind] ?? row.kind;

/** A waiting row's chip, by what the run waits on now (its `pending.kind`, the run page's to pass: a row carries no kind
 *  of its own), as the run header's status chip says it. Only a wait whose row is a `waiting` one: a cap pause's. An
 *  approval waits on its own tool_approval_requested row, which carries "Approval required"; the newest waiting row
 *  then is an earlier question, answered. */
const WAITING_CHIP: Record<string, string> = { budget: "Paused at cap" };

/** One step: a failed one reads as failed. A server row marked `paused` (the run paused at its cap) shows a pause icon,
 *  muted like any server row. */
function Row({ step, last, ended, waitingChip, files, onOpen }: { step: Step; last: boolean; ended: boolean; waitingChip?: string; files?: RunFile[]; onOpen?: (file: RunFile) => void }) {
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
            <span className="flex min-w-0 items-center gap-2 text-body text-muted-foreground">
              {/* A label can be long (a trigger's name, up to 200 characters, spaces or none): cut to the row's width, so it
                  never widens the page or runs over the time; whole on hover. */}
              <span data-label className="min-w-0 truncate" title={label(row)}>{label(row)}</span>
              {/* A call's own charge (a browser call's session time): on its row, never a row of its own. */}
              {(row.kind === "tool_use" || row.kind === "tool_result") && row.usage && <span className="font-mono text-label">· {chargeWords(row.usage, { ended })}</span>}
              {row.kind === "waiting" && <Chip tone="warning">{waitingChip ?? "Input required"}</Chip>}
              {awaitsApproval(row) && <Chip tone="warning">Approval required</Chip>}
              {failed && <Chip tone="error">Error</Chip>}
              {/* A call refused before it ran never failed: a neutral chip, never the red Error one (its row says why). */}
              {rowRefused(row) && <Chip tone="muted" title="Not run: refused before it ran">Refused</Chip>}
              {row.agent_label && <Chip label title={row.agent_label}>{row.agent_label}</Chip>}
              {step.ms !== undefined && <span className="font-mono text-label">{took(step.ms)}</span>}
              {step.times && <span className="font-mono text-label">{step.times} times{step.until ? ` over ${took(Math.max(0, Date.parse(step.until) - Date.parse(row.timestamp)))}` : ""}</span>}
            </span>
            <span className={cn("mt-0.5 block break-words text-prose leading-snug", fromServer(row) && "text-muted-foreground")}>{inline(shown)}</span>
            {step.saved && <span className="mt-0.5 block font-mono text-small text-muted-foreground">saved {step.saved}</span>}
            {notSent(row) && <span className="mt-0.5 block break-words text-body text-muted-foreground">{notSent(row)}</span>}
          </span>
          <span className="caps shrink-0 pt-0.5 text-label text-muted-foreground">{clock(row.timestamp)}</span>
          {detail && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
        </button>
        {/* A tool step opens to the tool's own id too: its label is a word, and the id is what a log or the API says. */}
        {open && detail && row.tool_name && <p className="mt-3 font-mono text-small text-muted-foreground">{row.tool_name}</p>}
        {/* An answer opens as the Report reads it (the same markdown(): links as links, fences as code blocks, no raw HTML); a link naming one of the run's files opens that file, as in the Report. */}
        {open && detail && row.kind === "final_answer" && <article className="report mt-3 max-h-80 max-w-none overflow-auto border bg-card p-3" onClick={openLinkedFile((path) => { const f = files?.find((x) => x.path === path); if (f) onOpen?.(f); })} dangerouslySetInnerHTML={{ __html: markdown(detail, onOpen && files ? { paths: files.map((f) => f.path) } : undefined) }} />}
        {open && detail && row.kind !== "final_answer" && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words border bg-card p-3 font-mono text-small leading-[1.7]">{detail}</pre>}
        {row.learned_nodes?.length ? <LearnedNodes nodes={row.learned_nodes} /> : null}
        {row.computer_calls?.length ? <ComputerCalls calls={row.computer_calls} dropped={row.computer_calls_dropped ?? 0} /> : null}
      </div>
    </li>
  );
}

/** A tool call's computer calls (its result row's `computer_calls`: a code-mode script's many, a computer tool's one):
 *  closed, a line that says how many and how many failed; open, each call in the order it was made, how long after the
 *  first it started, what it did in words (callWords: "open TextEdit", "select all (⌘A); type into the text box") and how
 *  long it took. Never what was typed: the server keeps none of it. */
function ComputerCalls({ calls, dropped }: { calls: readonly ComputerCallRow[]; dropped: number }) {
  const [open, setOpen] = useState(false);
  const failed = calls.filter((call) => !call.ok).length;
  const count = calls.length + dropped;
  const said = [`${count} computer ${count === 1 ? "call" : "calls"}`, ...(failed ? [`${failed} failed`] : [])].join(" · ");
  const first = Date.parse(calls[0]!.started_at);
  return (
    <div className="mt-2">
      <button type="button" className="caps flex items-center gap-1 text-label text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} the computer calls`}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden /><Monitor className="size-3" aria-hidden />{said}
      </button>
      {open && (
        <ol aria-label="The computer calls" className="mt-2 divide-y border bg-card">
          {calls.map((call, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-1.5">
              <span className="w-14 shrink-0 font-mono text-label text-muted-foreground">+{took(Math.max(0, Date.parse(call.started_at) - first))}</span>
              <span className={cn("min-w-0 flex-1 truncate text-body", !call.ok && "text-destructive-text")} title={callWords(call)}>{callWords(call)}</span>
              <span className="w-14 text-right font-mono text-label text-muted-foreground">{took(call.ms)}</span>
            </li>
          ))}
          {dropped > 0 && <li className="px-3 py-1.5 text-body text-muted-foreground">{dropped} more not kept</li>}
        </ol>
      )}
    </div>
  );
}

/** How a learned workflow's node ended, in its chip's tone: ok, failed, escalated; any other word (a skipped node) muted. */
const NODE_TONE: Record<string, "success" | "error" | "warning"> = { ok: "success", failed: "error", escalated: "warning" };
/** A learned workflow call's nodes (its result row's `learned_nodes`): closed, a line that says how many ran and how many
 *  did not end ok; open, each node in the order it ended, its status, its label, its kind and how long it took. Never why
 *  a node failed: the server keeps none of that text. */
function LearnedNodes({ nodes }: { nodes: LearnedNode[] }) {
  const [open, setOpen] = useState(false);
  const counts = Object.entries(nodes.reduce<Record<string, number>>((n, x) => ({ ...n, [x.status]: (n[x.status] ?? 0) + 1 }), {})).filter(([status]) => status !== "ok");
  const said = [`${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`, ...counts.map(([status, n]) => `${n} ${status}`)].join(" · ");
  return (
    <div className="mt-2">
      <button type="button" className="caps flex items-center gap-1 text-label text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} the workflow's ${nodes.length === 1 ? "node" : "nodes"}`}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden /><Workflow className="size-3" aria-hidden />{said}
      </button>
      {open && (
        <ol aria-label="The workflow's nodes" className="mt-2 divide-y border bg-card">
          {nodes.map((n, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-1.5">
              <span data-status={n.status} className="contents"><Chip tone={NODE_TONE[n.status] ?? "muted"} className="w-[5.5rem] justify-center">{n.status}</Chip></span>
              <span className="min-w-0 flex-1 truncate text-body" title={n.label}>{n.label}</span>
              <span data-kind className="font-mono text-label text-muted-foreground" title={ranOnWords(n) || undefined}>{kindWithModel(n.kind, n)}</span>
              <span className="w-14 text-right font-mono text-label text-muted-foreground">{took(n.duration_ms)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The run's live timeline as a step list (lib/timeline's `steps`: each tool once, from either of the server's shapes;
 *  a question once; repeated failures once): newest last, older steps folded behind "1 earlier step" or "N earlier steps". `asking`: the
 *  waiting row of the question the page shows above while the run waits on it; its step points there. */
export function Timeline({ rows, live, fold = 6, asking, waitingOn, files, onOpen, ended = false }: { rows: TimelineRow[]; live: boolean; fold?: number; asking?: string;
  /** Whether the run has ended (runEnded of its status): a charge's words then say what is known, never "so far". The run
   *  page and the agent page's latest run both pass it. */
  ended?: boolean;
  /** The run's files and the handler that opens one: a link in an opened Answer that names a file opens it. */
  files?: RunFile[]; onOpen?: (file: RunFile) => void;
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
        <button type="button" className="caps mb-1 ml-10 flex items-center gap-1 py-2 text-label text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          <ChevronRight className="size-3" aria-hidden /> {hidden} earlier {hidden === 1 ? "step" : "steps"}
        </button>
      )}
      <ol>{shown.map((step, i) => <Row key={step.row.id} step={step} last={i === shown.length - 1 && !live} ended={ended} waitingChip={step.row.id === current && waitingOn ? WAITING_CHIP[waitingOn] : undefined} files={files} onOpen={onOpen} />)}</ol>
      {live && <Working title="Working" note="Steps appear as the agent takes them." spin />}
    </div>
  );
}

/** A centred progress note: a spinner, a mono caps title and one muted line. */
export function Working({ title, note, spin = true }: { title: string; note: string; spin?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      {spin && <Spinner className="size-5" />}
      <p className="caps text-label font-semibold">{title}</p>
      <p className="max-w-sm text-body text-muted-foreground">{note}</p>
    </div>
  );
}
