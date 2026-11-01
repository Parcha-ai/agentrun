import { Play } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { exampleInput, keeper, startBody, submitStart } from "@/lib/runStart";
import { cn } from "@/lib/utils";

type Problem = { message: string; fields?: FieldIssue[] };
type Sent = { status: number; runId?: string; problem?: Problem };

/** The agent page's run bar: an agentic agent's first message, or a workflow agent's input as JSON (its example to start
 *  from), and an effort. "default" sends none, so the server's own order applies. A start goes through `submitStart`, so a
 *  retry of a refused or lost start is the same request; a started run opens on its page, and a refusal is said here. */
export function RunBar({ agent, efforts, v2, go }: { agent: Agent; efforts: string[]; v2: Client; go: (hash: string) => void }) {
  const workflow = agent.kind === "workflow";
  const example = useMemo(() => (workflow ? exampleInput(agent.definition.workflow) : null), [workflow, agent.definition.workflow]);
  const [text, setText] = useState(example?.text ?? "");
  const [effort, setEffort] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const keys = useMemo(() => keeper(), []);
  const built = startBody(agent.kind, { text, effort });
  const send = async (id: string, body: Parameters<Client["startRun"]>[1], key: string): Promise<Sent> => {
    try {
      const r = await v2.startRun(id, body, key);
      return { status: r.status, runId: r.run.run_id };
    } catch (e) {
      if (e instanceof ClientError) return { status: e.status, problem: { message: e.message, fields: e.fields } };
      return { status: 0, problem: { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  const start = async () => {
    if (!built.ok || sending) return;
    setSending(true); setProblem(null);
    const r = await submitStart(keys, agent.agent_id, built.body, send);
    setSending(false);
    if (r.runId) go(`#/runs/${encodeURIComponent(r.runId)}`);
    else setProblem(r.problem ?? { message: `The server answered ${r.status}.` });
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
            <label className="flex items-center gap-2">
              <span className="caps text-[11px] text-muted-foreground">Effort</span>
              <select value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Effort" className="h-10 border bg-background px-3 font-mono text-[13px]">
                {["", ...efforts].map((e) => <option key={e || "default"} value={e}>{e || "default"}</option>)}
              </select>
            </label>
          )}
          <Button variant="solid" onClick={() => void start()} disabled={!built.ok || sending}><Play aria-hidden /> {sending ? "Starting" : "Run"}</Button>
        </div>
      </div>
      {example && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{example.from === "example" ? "The workflow's example input. Edit it, then run." : "The workflow's input, its fields empty. Fill them in, then run."}</p>}
      {!built.ok && text.trim() && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{built.message}</p>}
      {problem && (
        <div className="mt-3 border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-[12px] text-destructive-text" role="alert">
          <p>The run did not start: {problem.message}</p>
          {more.length > 0 && <ul className="mt-1">{more.map((f) => <li key={`${f.field}:${f.message}`}>{f.field}: {f.message}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
