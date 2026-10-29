import { ArrowRight, Copy, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/agentForm";
import { curlFor, keeper, type StartBody, startBody, submitStart } from "@/lib/runStart";
import { cn } from "@/lib/utils";

export type StartResult = { status: number; ms: number; body: unknown; runId?: string };
export type PlaygroundProps = {
  agents: Agent[];
  revisions?: { revision: string; version: number; current: boolean; note: string | null }[];
  efforts: string[];
  origin: string;
  agentId?: string;
  onAgent?: (id: string) => void;
  /** Sends the request; resolves with what the server answered. */
  onSend?: (agentId: string, body: StartBody, key: string) => Promise<StartResult>;
  onOpenRun?: (runId: string) => void;
  result?: StartResult | null;
};

/** The hosted console's API playground for starting a run: the request on the left (a form, or its JSON), the same
 *  request as code on the right, and the server's answer, with a way into the run it started. */
export function Playground({ agents, revisions = [], efforts, origin, agentId: initialAgent, onAgent, onSend, onOpenRun, result: initialResult = null }: PlaygroundProps) {
  const [agentId, setAgentId] = useState(initialAgent ?? agents[0]?.agent_id ?? "");
  // The selection follows the list and the page's choice: an agent that left the list (archived) is not kept.
  useEffect(() => {
    if (initialAgent && initialAgent !== agentId && agents.some((a) => a.agent_id === initialAgent)) setAgentId(initialAgent);
    else if (!agents.some((a) => a.agent_id === agentId)) setAgentId(agents[0]?.agent_id ?? "");
  }, [agents, initialAgent]); // eslint-disable-line react-hooks/exhaustive-deps
  const agent = agents.find((a) => a.agent_id === agentId);
  const kind = agent?.kind ?? "agentic";
  const [text, setText] = useState("");
  const [revision, setRevision] = useState("");
  const [effort, setEffort] = useState("");
  const [cap, setCap] = useState("");
  const [view, setView] = useState<"form" | "json">("form");
  const [pane, setPane] = useState<"code" | "response">(initialResult ? "response" : "code");
  const [lang, setLang] = useState<"curl" | "fetch">("curl");
  const [result, setResult] = useState<StartResult | null>(initialResult);
  const [sending, setSending] = useState(false);
  const keys = useMemo(() => keeper(), []);
  const built = startBody(kind, { text, revision, effort, maxCostUsd: cap });
  const body: StartBody = built.ok ? built.body : { input: kind === "agentic" ? { content: text } : text };
  const key = agentId ? keys.keyFor(agentId, body) : "";
  const code = lang === "curl" ? curlFor(origin, agentId, body, key)
    : `const res = await fetch(${JSON.stringify(`${origin}/v2/agents/${agentId}/runs`)}, {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.AGENTRUN_TOKEN}\`,\n    "Content-Type": "application/json",\n    "Idempotency-Key": ${JSON.stringify(key)},\n  },\n  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}),\n});\nconsole.log(res.status, await res.json());`;
  const send = async () => {
    if (!built.ok || !onSend) return;
    setSending(true);
    const r = await submitStart(keys, agentId, built.body, onSend);
    setSending(false); setResult(r); setPane("response");
  };
  const placeholder = kind === "agentic" ? "The run's first message, e.g. Summarize the standup: we ship Friday." : '{ "subject": "...", "body": "..." }';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3 md:px-6">
        <label className="flex items-center gap-2 text-[12px]">
          <span className="caps text-muted-foreground">Agent</span>
          <select value={agentId} onChange={(e) => { setAgentId(e.target.value); setRevision(""); onAgent?.(e.target.value); }} className="h-10 border bg-background px-3 font-mono text-[13px]">
            {agents.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.definition.name}</option>)}
          </select>
        </label>
        <span className="font-mono text-[12px]"><span className="text-primary">POST</span> <span className="text-muted-foreground">/v2/agents/{agentId || "{agent_id}"}/runs</span></span>
        <span className="flex-1" />
        <span className="caps text-[11px] text-muted-foreground">Live API</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
          <header className="flex items-center justify-between border-b px-5 py-3 md:px-6">
            <span className="text-[14px] font-semibold">Request</span>
            <span className="flex gap-4 text-[12px]">{(["form", "json"] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={cn("border-b pb-1 capitalize", view === v ? "border-foreground" : "border-transparent text-muted-foreground")}>{v === "json" ? "JSON" : "Form"}</button>)}</span>
          </header>
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-6 md:px-6">
            <div><h2 className="text-xl font-semibold">Start a run</h2><p className="mt-1 text-[13px] text-muted-foreground">{agent ? `${agent.definition.name}: ${kind === "agentic" ? "an" : "a"} ${kind} agent.` : "Pick an agent."} The server answers 202 with the run; follow it on its page.</p></div>
            {view === "json" ? (
              <pre className="overflow-auto border bg-card p-4 font-mono text-[12px] leading-[1.7]">{JSON.stringify(body, null, 2)}</pre>
            ) : (
              <>
                <Label name={kind === "agentic" ? "input.content" : "input"} required error={!built.ok && built.field === "input" && text ? built.message : undefined}>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={kind === "agentic" ? 4 : 7} placeholder={placeholder} className={field} />
                </Label>
                <Label name="revision" note="Empty runs the current revision.">
                  <select value={revision} onChange={(e) => setRevision(e.target.value)} className={field}>
                    <option value="">The current revision</option>
                    {revisions.map((r) => <option key={r.revision} value={r.revision}>rev {r.version}{r.current ? " (current)" : ""}{r.note ? `: ${r.note}` : ""}</option>)}
                  </select>
                </Label>
                <Label name="effort" note="Empty uses the agent's own.">
                  <div className="flex gap-2">{["", ...efforts].map((e) => <button key={e || "default"} type="button" onClick={() => setEffort(e)} className={cn("caps border px-3 py-2 text-[12px]", effort === e ? "border-foreground" : "text-muted-foreground")}>{e || "default"}</button>)}</div>
                </Label>
                {kind === "agentic" && (
                  <Label name="max_cost_usd" note="A spend cap in dollars; empty means none." error={!built.ok && built.field === "max_cost_usd" ? built.message : undefined}>
                    <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="e.g. 0.50" className={field} />
                  </Label>
                )}
              </>
            )}
          </div>
          <footer className="flex items-center justify-between gap-3 border-t px-5 py-3 md:px-6">
            <span className="text-[12px] text-muted-foreground">Sends a real request to this server.</span>
            <Button variant="primary" size="lg" onClick={send} disabled={!built.ok || !onSend || sending || !agentId}><Play aria-hidden /> {sending ? "Sending" : "Send request"}</Button>
          </footer>
        </section>
        <section className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between border-b px-5 py-3 md:px-6">
            <span className="flex gap-4 text-[13px]">
              <button type="button" onClick={() => setPane("code")} className={cn("border-b pb-1", pane === "code" ? "border-foreground" : "border-transparent text-muted-foreground")}>Code</button>
              <button type="button" onClick={() => setPane("response")} disabled={!result} className={cn("border-b pb-1 disabled:opacity-45", pane === "response" ? "border-foreground" : "border-transparent text-muted-foreground")}>Response{result && <span className={cn("ml-2 font-mono", result.status < 300 ? "text-success-text" : "text-destructive-text")}>{result.status}</span>}</button>
            </span>
            {pane === "code" && <Button size="icon" variant="outline" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(code)}><Copy aria-hidden /></Button>}
          </header>
          {pane === "code" ? (
            <>
              <div className="flex gap-5 border-b px-5 text-[12px] md:px-6">{(["curl", "fetch"] as const).map((l) => <button key={l} type="button" onClick={() => setLang(l)} className={cn("-mb-px border-b-2 py-2.5", lang === l ? "border-primary" : "border-transparent text-muted-foreground")}>{l === "curl" ? "cURL" : "JavaScript"}</button>)}</div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-5 font-mono text-[12px] leading-[1.8] md:px-6">{code}</pre>
              <footer className="border-t px-5 py-3 text-[12px] text-muted-foreground md:px-6">The same request from your code: set AGENTRUN_TOKEN in your environment.</footer>
            </>
          ) : result && (
            <>
              <p className="border-b px-5 py-2.5 font-mono text-[12px] md:px-6"><span className={result.status < 300 ? "text-success-text" : "text-destructive-text"}>{result.status}</span> <span className="text-muted-foreground">{result.ms} ms</span></p>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-5 font-mono text-[12px] leading-[1.8] md:px-6">{JSON.stringify(result.body, null, 2)}</pre>
              {result.runId && <button type="button" onClick={() => onOpenRun?.(result.runId!)} className="caps flex items-center justify-between border-t px-5 py-4 text-[12px] text-primary hover:bg-accent md:px-6">Open this run <ArrowRight className="size-4" aria-hidden /></button>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const field = "w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong";

function Label({ name, required, note, error, children }: { name: string; required?: boolean; note?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between"><span className="font-mono text-[13px]">{name}</span>{required && <span className="text-[11px] text-muted-foreground">required</span>}</div>
      {children}
      {note && <p className="mt-1.5 text-[12px] text-muted-foreground">{note}</p>}
      {error && <p className="mt-1.5 font-mono text-[12px] text-destructive-text" role="alert">{error}</p>}
    </div>
  );
}
