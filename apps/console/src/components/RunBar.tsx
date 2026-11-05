import { Play } from "lucide-react";
import { CodingAgentHandoff } from "@/components/CodingAgentHandoff";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePicker, type UploadLimits, useAttachments } from "@/components/FilePicker";
import { ToolBlockers } from "@/components/ToolBlockers";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { exampleInput, keeper, startBody, submitStart } from "@/lib/runStart";
import type { Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

type Problem = { message: string; fields?: FieldIssue[]; box?: string; details?: Record<string, unknown> };
type Sent = { status: number; runId?: string; problem?: Problem };

/** The agent page's run bar: an agentic agent's first message, or a workflow agent's input as JSON (its example to start
 *  from), and an effort. "default" sends none, so the server's own order applies. A start goes through `submitStart`, so a
 *  retry of a refused or lost start is the same request; a started run opens on its page, and a refusal is said here.
 *  `blocked`: why no run can start here (a harness the server can't run): Run is off, and sends nothing. A start refused
 *  for a box this server lacks says so, and that the fix is where the agent runs, in its settings. Files picked here are
 *  sent at once and named by the run (`file_ids`); Run waits until each is sent. */
export function RunBar({ agent, efforts, v2, go, blocked, limits, endpoint, upload = v2.upload }: { agent: Agent; efforts: string[]; v2: Client; go: (hash: string) => void; blocked?: string; limits?: UploadLimits; endpoint?: string; upload?: Upload }) {
  const workflow = agent.kind === "workflow";
  const example = useMemo(() => (workflow ? exampleInput(agent.definition.workflow) : null), [workflow, agent.definition.workflow]);
  const [text, setText] = useState(example?.text ?? "");
  const [effort, setEffort] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const keys = useMemo(() => keeper(), []);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  // The files hold still while a start that names them is under way.
  const attachments = useAttachments({ upload, remove: v2.deleteUpload, limits, frozen: sending });
  const built = startBody(agent.kind, { text, revision: agent.revision, effort, fileIds: attachments.fileIds });
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
    if (!built.ok || sending || inFlight.current || blocked || attachments.busy) return;
    inFlight.current = true;
    setSending(true); setProblem(null);
    try {
      const r = await submitStart(keys, agent.agent_id, built.body, send);
      if (!mounted.current) return;
      // The run has its own copies: leaving the page never deletes them.
      if (r.runId) { attachments.clear(); go(`#/runs/${encodeURIComponent(r.runId)}`); }
      else setProblem(r.problem ?? { message: `The server answered ${r.status}.` });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };
  // A 422 names its fields; each one whose message says more than the refusal's is listed under it.
  const more = (problem?.fields ?? []).filter((f) => f.message !== problem?.message);
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
              <Select aria-label="Effort" value={effort} onValueChange={setEffort}
                options={["", ...efforts].map((e) => ({ value: e, label: e || "default" }))} className="h-10" />
            </label>
          )}
          <Button variant="solid" onClick={() => void start()} disabled={!built.ok || sending || !!blocked || attachments.busy} title={blocked ?? (attachments.busy ? "Waiting for the files to be sent" : undefined)}><Play aria-hidden /> {sending ? "Starting" : "Run"}</Button>
        </div>
      </div>
      <div className="mt-3"><FilePicker attachments={attachments} limits={limits} disabled={!!blocked} /></div>
      {example && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{example.from === "example" ? "The workflow's example input. Edit it, then run." : "The workflow's input, its fields empty. Fill them in, then run."}</p>}
      {!built.ok && text.trim() && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{built.message}</p>}
      {problem && (
        <div className="mt-3 border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-[12px] text-destructive-text" role="alert">
          <p>The run did not start: {problem.message}</p>
          {problem.box && <p className="mt-1">This server can't run the {problem.box} box this agent runs in: change where it runs in its settings.</p>}
          <ToolBlockers agentId={agent.agent_id} details={problem.details} />
          {more.length > 0 && <ul className="mt-1">{more.map((f) => <li key={`${f.field}:${f.message}`}>{f.field}: {f.message}</li>)}</ul>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3" aria-label="Run agent">
        <CodingAgentHandoff context={{ kind: "run", agentId: agent.agent_id, revision: agent.revision }} serverUrl={endpoint ?? v2.endpoint} label="Run with your coding agent" />
        <a href={`#/playground?agent=${encodeURIComponent(agent.agent_id)}&revision=${encodeURIComponent(agent.revision)}`} className="text-[12px] text-primary hover:underline">API playground</a>
      </div>
    </section>
  );
}
