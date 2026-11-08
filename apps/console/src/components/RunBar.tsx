import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePicker, type UploadLimits, useAttachments } from "@/components/FilePicker";
import { capWords } from "@/components/NeedsYou";
import { ToolBlockers } from "@/components/ToolBlockers";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { exampleInput, keeper, startBody, submitStart } from "@/lib/runStart";
import { sendUpload, type Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

type Problem = { message: string; fields?: FieldIssue[]; box?: string; details?: Record<string, unknown> };
type Sent = { status: number; runId?: string; problem?: Problem };

/** The agent page's run bar: an agentic agent's first message, or a workflow agent's input as JSON (its example to start
 *  from), and an effort. "default" sends none, so the server's own order applies. A start goes through `submitStart`, so a
 *  retry of a refused or lost start is the same request; a started run opens on its page, and a refusal is said here.
 *  `blocked`: why no run can start here (a harness the server can't run): Run is off, and sends nothing. A start refused
 *  for a box this server lacks says so, and that the fix is where the agent runs, in its settings. Files picked here are
 *  sent at once and named by the run (`file_ids`); Run waits until each is sent. A Spend cap typed here caps this run alone
 *  (`max_cost_usd`); empty sends none, so the agent's default cap applies (its definition's `max_cost_usd`, shown as the
 *  box's placeholder). A cap the server refuses (a 422 naming max_cost_usd) is said at the box, in the server's words. */
export function RunBar({ agent, efforts, v2, go, blocked, limits, upload = sendUpload }: { agent: Agent; efforts: string[]; v2: Client; go: (hash: string) => void; blocked?: string; limits?: UploadLimits; upload?: Upload }) {
  const workflow = agent.kind === "workflow";
  const example = useMemo(() => (workflow ? exampleInput(agent.definition.workflow) : null), [workflow, agent.definition.workflow]);
  const [text, setText] = useState(example?.text ?? "");
  const [effort, setEffort] = useState("");
  const [cap, setCap] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const keys = useMemo(() => keeper(), []);
  const [sending, setSending] = useState(false);
  // The files hold still while a start that names them is under way.
  const attachments = useAttachments({ upload, remove: v2.deleteUpload, limits, frozen: sending });
  const built = startBody(agent.kind, { text, effort, maxCostUsd: cap, fileIds: attachments.fileIds });
  // The agent's own default cap, which an empty box leaves in force.
  const agentCap = typeof agent.definition.max_cost_usd === "number" ? agent.definition.max_cost_usd : null;
  const send = async (id: string, body: Parameters<Client["startRun"]>[1], key: string): Promise<Sent> => {
    try {
      const r = await v2.startRun(id, body, key);
      return { status: r.status, runId: r.run.run_id };
    } catch (e) {
      if (e instanceof ClientError) return { status: e.status, problem: { message: e.message, fields: e.fields, ...(e.code === "agent_not_runnable" && typeof e.details?.box === "string" ? { box: e.details.box } : {}), ...(e.code === "agent_not_runnable" && e.details ? { details: e.details } : {}) } };
      return { status: 0, problem: { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  // A start that answers after the bar is gone (the person went elsewhere) still runs, and moves nobody's page.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const start = async () => {
    if (!built.ok || sending || blocked || attachments.busy) return;
    setSending(true); setProblem(null);
    const r = await submitStart(keys, agent.agent_id, built.body, send);
    if (!mounted.current) return;
    setSending(false);
    // The run has its own copies: the page forgets the files before it goes, so leaving never deletes them.
    if (r.runId) { attachments.clear(); go(`#/runs/${encodeURIComponent(r.runId)}`); }
    else setProblem(r.problem ?? { message: `The server answered ${r.status}.` });
  };
  // What is wrong with the cap: the box's own check, else the server's refusal of it. Said at the box, not again below.
  const capIssue = !built.ok && built.field === "max_cost_usd" ? built.message : problem?.fields?.find((f) => f.field === "max_cost_usd")?.message ?? null;
  // A 422 names its fields; each one whose message says more than the refusal's is listed under it (the cap's at its box).
  const more = (problem?.fields ?? []).filter((f) => f.message !== problem?.message && f.field !== "max_cost_usd");
  return (
    <section className="border-b px-5 py-4 md:px-8" aria-label="Start a run">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={workflow ? 6 : 2} spellCheck={!workflow}
          aria-label={workflow ? "The run's input, as JSON" : "The run's first message"}
          placeholder={workflow ? "The workflow's input, as JSON" : "The run's first message"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); } }}
          className={cn("min-w-0 flex-1 resize-y border bg-background px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong", workflow && "leading-[1.6]")} />
        <div className="flex shrink-0 items-center gap-3">
          {efforts.length > 0 && (
            <label className="flex items-center gap-2" title="How hard the model thinks before it answers. default leaves it to the agent.">
              <span className="flex flex-col leading-tight"><span className="caps text-[11px] text-muted-foreground">Effort</span><span className="text-[11px] text-muted-foreground">How hard the model thinks</span></span>
              <select value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Effort" className="h-10 border bg-background px-3 font-mono text-[13px]">
                {["", ...efforts].map((e) => <option key={e || "default"} value={e}>{e || "default"}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-col">
            <div className="flex items-center gap-2" title={agentCap !== null ? `This run's spend cap in US dollars. Empty uses the agent's default, ${capWords(agentCap)}.` : "This run's spend cap in US dollars. Empty runs it with no cap."}>
              <span className="flex flex-col leading-tight"><label htmlFor="runbar-cap" className="caps text-[11px] text-muted-foreground">Spend cap</label><span className="text-[11px] text-muted-foreground">This run, US dollars</span></span>
              <input id="runbar-cap" value={cap} onChange={(e) => { setCap(e.target.value); if (problem?.fields?.some((f) => f.field === "max_cost_usd")) setProblem(null); }} inputMode="decimal" aria-label="Spend cap"
                aria-invalid={capIssue ? true : undefined} placeholder={agentCap !== null ? capWords(agentCap) : "none"}
                className={cn("h-10 w-24 border bg-background px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong", capIssue && "border-destructive")} />
            </div>
            {capIssue && <p className="mt-1 max-w-[16rem] font-mono text-[11px] text-destructive-text" role="alert" data-issue="max_cost_usd">{capIssue}</p>}
          </div>
          <Button variant="solid" onClick={() => void start()} disabled={!built.ok || sending || !!blocked || attachments.busy} title={blocked ?? (attachments.busy ? "Waiting for the files to be sent" : undefined)}><Play aria-hidden /> {sending ? "Starting" : "Run"}</Button>
        </div>
      </div>
      <div className="mt-3"><FilePicker attachments={attachments} limits={limits} disabled={!!blocked} /></div>
      {example && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{example.from === "example" ? "The workflow's example input. Edit it, then run." : "The workflow's input, its fields empty. Fill them in, then run."}</p>}
      {!built.ok && built.field !== "max_cost_usd" && text.trim() && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{built.message}</p>}
      {problem && (
        <div className="mt-3 border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-[12px] text-destructive-text" role="alert">
          <p>The run did not start: {problem.message}</p>
          {problem.box && <p className="mt-1">This server can't run the {problem.box} box this agent runs in: change where it runs in its settings.</p>}
          <ToolBlockers agentId={agent.agent_id} details={problem.details} />
          {more.length > 0 && <ul className="mt-1">{more.map((f) => <li key={`${f.field}:${f.message}`}>{f.field}: {f.message}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
