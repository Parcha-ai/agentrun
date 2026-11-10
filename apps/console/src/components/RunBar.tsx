import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePicker, type UploadLimits, useAttachments } from "@/components/FilePicker";
import { Picker } from "@/components/ui/picker";
import { ToolBlockers } from "@/components/ToolBlockers";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { exampleHint, exampleInput, keeper, startBody, submitStart } from "@/lib/runStart";
import { sendUpload, type Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

type Problem = { message: string; fields?: FieldIssue[]; box?: string; details?: Record<string, unknown> };
type Sent = { status: number; runId?: string; problem?: Problem };

/** The agent page's run bar: an agentic agent's first message, or a workflow agent's input as JSON (its example to start
 *  from), and an effort. "default" sends none, so the server's own order applies. A start goes through `submitStart`, so a
 *  retry of a refused or lost start is the same request; a started run opens on its page, and a refusal is said here.
 *  `blocked`: why no run can start here (a harness the server can't run): Run is off, and sends nothing. A start refused
 *  for a box this server lacks says so, and that the fix is where the agent runs, in its settings. Files picked here are
 *  sent at once and named by the run (`file_ids`); Run waits until each is sent. */
export function RunBar({ agent, efforts, v2, go, blocked, limits, upload = sendUpload }: { agent: Agent; efforts: string[]; v2: Client; go: (hash: string) => void; blocked?: string; limits?: UploadLimits; upload?: Upload }) {
  const workflow = agent.kind === "workflow";
  const example = useMemo(() => (workflow ? exampleInput(agent.definition.workflow) : null), [workflow, agent.definition.workflow]);
  const [text, setText] = useState(example?.text ?? "");
  const [effort, setEffort] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const keys = useMemo(() => keeper(), []);
  const [sending, setSending] = useState(false);
  // The files hold still while a start that names them is under way.
  const attachments = useAttachments({ upload, remove: v2.deleteUpload, limits, frozen: sending });
  const built = startBody(agent.kind === "workflow" ? "workflow" : "agentic", { text, effort, fileIds: attachments.fileIds });
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
  // A 422 names its fields; each one whose message says more than the refusal's is listed under it.
  const more = (problem?.fields ?? []).filter((f) => f.message !== problem?.message);
  return (
    <section className="border-b px-5 py-4 max-sm:py-3 md:px-8" aria-label="Start a run">
      {/* On a phone the message box is one line (a workflow's JSON keeps its height), and the file button sits in the
          row with Effort and Run: the textarea and the controls come out of their box, so the three wrap as one row. */}
      <div data-phone-row className="max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-2">
        <div className="flex flex-col gap-3 max-sm:contents lg:flex-row lg:items-start">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={workflow ? 6 : 2} spellCheck={!workflow}
            aria-label={workflow ? "The run's input, as JSON" : "The run's first message"}
            placeholder={workflow ? "The workflow's input, as JSON" : "The run's first message"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); } }}
            className={cn("min-w-0 flex-1 resize-y max-sm:order-first max-sm:basis-full", workflow ? "leading-[1.6]" : "max-sm:h-10")} />
          <div className="flex shrink-0 items-center gap-3 max-sm:order-last max-sm:gap-2">
            {efforts.length > 0 && (
              <div className="flex items-center gap-2" title="How hard the model thinks before it answers. default leaves it to the agent.">
                <span className="flex flex-col leading-tight"><label htmlFor="runbar-effort" className="caps text-label text-muted-foreground">Effort</label><span className="text-label text-muted-foreground max-sm:hidden">How hard the model thinks</span></span>
                <Picker id="runbar-effort" label="Effort" value={effort} onChange={setEffort} className="w-32" options={["", ...efforts].map((e) => ({ value: e, label: e || "default" }))} />
              </div>
            )}
            <Button variant="solid" onClick={() => void start()} disabled={!built.ok || sending || !!blocked || attachments.busy} title={blocked ?? (attachments.busy ? "Waiting for the files to be sent" : undefined)}><Play aria-hidden /> {sending ? "Starting" : "Run"}</Button>
          </div>
        </div>
        <div className="mt-3 max-sm:mt-0"><FilePicker attachments={attachments} limits={limits} disabled={!!blocked} compact /></div>
      </div>
      {example && <p className="mt-2 font-mono text-label text-muted-foreground">{exampleHint(example, "run")}</p>}
      {!built.ok && text.trim() && <p className="mt-2 font-mono text-small text-destructive-text" role="alert">{built.message}</p>}
      {problem && (
        <div className="mt-3 border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-small text-destructive-text" role="alert">
          <p>The run did not start: {problem.message}</p>
          {problem.box && <p className="mt-1">This server can't run the {problem.box} box this agent runs in: change where it runs in its settings.</p>}
          <ToolBlockers agentId={agent.agent_id} details={problem.details} />
          {more.length > 0 && <ul className="mt-1">{more.map((f) => <li key={`${f.field}:${f.message}`}>{f.field}: {f.message}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
