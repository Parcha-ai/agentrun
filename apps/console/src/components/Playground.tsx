import { ToolBlockers } from "@/components/ToolBlockers";
import { ArrowRight, Copy, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePicker, type UploadLimits, useAttachments } from "@/components/FilePicker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Input, Textarea } from "@/components/ui/field";
import type { Agent } from "@/lib/agentForm";
import { agentsByName } from "@/lib/agents";
import { ClientError } from "@/lib/client";
import { curlFor, exampleHint, exampleInput, keeper, type StartBody, startBody, submitStart } from "@/lib/runStart";
import { sendUpload, type Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

export type StartResult = { status: number; ms: number; body: unknown; runId?: string };

/** A start that did not succeed, as the response pane shows it: the server's typed error whole (its `details`
 *  included) with the fields a 422 names, or a network failure. */
export const startFailure = (e: unknown, ms: number): StartResult =>
  e instanceof ClientError ? { status: e.status, ms, body: { error: { ...e.toApiError(), ...(e.fields ? { fields: e.fields } : {}) } } } : { status: 0, ms, body: { error: { code: "network", message: String(e) } } };
export type PlaygroundProps = {
  agents: Agent[];
  revisions?: { revision: string; version: number; current: boolean; note: string | null; definition?: Record<string, unknown> }[];
  efforts: string[];
  origin: string;
  agentId?: string;
  onAgent?: (id: string) => void;
  /** Sends the request; resolves with what the server answered. */
  onSend?: (agentId: string, body: StartBody, key: string) => Promise<StartResult>;
  onOpenRun?: (runId: string) => void;
  result?: StartResult | null;
  /** The run the request started, followed live as the run page follows it (its rows, its answer, a follow-up). */
  live?: (runId: string) => React.ReactNode;
  /** The server's upload limits (capabilities' `limits`); `upload` sends a picked file, `removeUpload` deletes one the
   *  person removed. */
  limits?: UploadLimits;
  upload?: Upload;
  removeUpload?: (fileId: string) => Promise<unknown>;
};

/** The hosted console's API playground for starting a run: the request on the left (a form, or its JSON), the same
 *  request as code on the right, and the server's answer, with a way into the run it started. */
export function Playground({ agents, revisions = [], efforts, origin, agentId: initialAgent, onAgent, onSend, onOpenRun, result: initialResult = null, live, limits, upload = sendUpload, removeUpload }: PlaygroundProps) {
  const [agentId, setAgentId] = useState(initialAgent ?? agents[0]?.agent_id ?? "");
  // The selection follows the list and the page's choice: an agent that left the list (archived) is not kept.
  useEffect(() => {
    if (initialAgent && initialAgent !== agentId && agents.some((a) => a.agent_id === initialAgent)) setAgentId(initialAgent);
    else if (!agents.some((a) => a.agent_id === agentId)) setAgentId(agents[0]?.agent_id ?? "");
  }, [agents, initialAgent]); // eslint-disable-line react-hooks/exhaustive-deps
  const agent = agents.find((a) => a.agent_id === agentId);
  const kind = agent?.kind ?? "agentic";
  const [text, setText] = useState("");
  const example = kind === "workflow" ? exampleInput(agent?.definition.workflow) : null;
  // A workflow agent opens with its example input (its schema's, else its fields empty), replaced on a switch of agent
  // unless it was edited.
  const prefilled = useRef("");
  useEffect(() => {
    if (text.trim() && text !== prefilled.current) return;
    const next = example?.text ?? "";
    prefilled.current = next;
    setText(next);
  }, [agentId, example?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const [revision, setRevision] = useState("");
  const [effort, setEffort] = useState("");
  const [cap, setCap] = useState("");
  const [view, setView] = useState<"form" | "json">("form");
  const [pane, setPane] = useState<"code" | "response">(initialResult ? "response" : "code");
  const [lang, setLang] = useState<"curl" | "fetch">("curl");
  // In a short viewport (a phone in landscape) the code and response panel is folded so the form gets the height, and
  // Show code swaps the two. Taller viewports show both, as before.
  const [showCode, setShowCode] = useState(false);
  const [result, setResult] = useState<StartResult | null>(initialResult);
  // A refused start, said plainly above its answer: the server's reason, and the box it names when it lacks one.
  const refusal = useMemo(() => {
    const error = (result && result.status >= 400 ? (result.body as { error?: { code?: unknown; message?: unknown; fields?: unknown; details?: { box?: unknown } & Record<string, unknown> } } | null)?.error : undefined);
    if (!error || typeof error.message !== "string") return undefined;
    // A 422 names its fields: each one whose message says more than the refusal's is listed under it, as the Run bar does.
    const fields = Array.isArray(error.fields) ? error.fields.filter((f): f is { field: string; message: string } => !!f && typeof f.field === "string" && typeof f.message === "string" && f.message !== error.message) : [];
    return { message: error.message, more: fields, box: typeof error.details?.box === "string" ? error.details.box : undefined, details: error.code === "agent_not_runnable" ? error.details : undefined };
  }, [result]);
  const [sending, setSending] = useState(false);
  const keys = useMemo(() => keeper(), []);
  // Files picked here are sent at once; the request names each once the server has it, and waits for the rest.
  const attachments = useAttachments({ upload, remove: removeUpload, limits, frozen: sending });
  const built = startBody(kind, { text, revision, effort, maxCostUsd: cap, fileIds: attachments.fileIds });
  // A form that doesn't make a body yet still has one to key its start by (never sent): the text as typed.
  const body: StartBody = built.ok ? built.body : { input: (kind === "agentic" ? { content: text } : text) as StartBody["input"], ...(attachments.fileIds.length ? { file_ids: attachments.fileIds } : {}) };
  const key = agentId ? keys.keyFor(agentId, body) : "";
  const code = lang === "curl" ? curlFor(origin, agentId, body, key)
    : `const res = await fetch(${JSON.stringify(`${origin}/v2/agents/${agentId || "{agent_id}"}/runs`)}, {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.AGENTRUN_TOKEN}\`,\n    "Content-Type": "application/json",\n    "Idempotency-Key": ${JSON.stringify(key)},\n  },\n  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}),\n});\nconsole.log(res.status, await res.json());`;
  const send = async () => {
    if (!built.ok || !onSend || attachments.busy) return;
    setSending(true);
    const r = await submitStart(keys, agentId, built.body, onSend);
    setSending(false); setResult(r); setPane("response"); setShowCode(true);
    // The run has its own copies: the next request starts with none picked.
    if (r.status >= 200 && r.status < 300) attachments.clear();
  };
  const placeholder = kind === "agentic" ? "The run's first message, e.g. Summarize the standup: we ship Friday." : '{ "subject": "...", "body": "..." }';
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div aria-label="Playground agent" className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3 md:px-6">
        {/* No agent to pick: no field stands here, and the Request panel below says how to make the first one. */}
        {agents.length > 0 && (
          <div className="flex min-w-0 items-center gap-2 text-small">
            <label htmlFor="playground-agent" className="caps text-muted-foreground">Agent</label>
            <Picker id="playground-agent" label="Agent" placeholder="Pick an agent" value={agentId} onChange={(id) => { setAgentId(id); setRevision(""); onAgent?.(id); }}
              options={agentsByName(agents).map((a) => ({ value: a.agent_id, label: a.definition.name }))} className="w-56 max-w-[60vw]" />
          </div>
        )}
        <span className="font-mono text-small"><span className="text-primary-text">POST</span> <span className="text-muted-foreground">/v2/agents/{agentId || "{agent_id}"}/runs</span></span>
        <span className="flex-1" />
        <span className="caps text-label text-muted-foreground">Live API</span>
        <Button type="button" size="xs" onClick={() => setShowCode((s) => !s)} aria-expanded={showCode} className="hidden text-muted-foreground hover:text-foreground short:inline-flex">{showCode ? "Hide code" : "Show code"}</Button>
      </div>
      {/* Two columns only when the window is wide AND tall enough: a short one folds to one panel (short:), full width. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:[@media(min-height:501px)]:grid-cols-2">
        <section aria-label="Request" className={cn("flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r", showCode && "short:hidden")}>
          {agents.length === 0 ? (
            // No agents: a form that cannot send helps no one. The way to the first agent, then what a request takes.
            <>
              <header className="flex items-center justify-between border-b px-5 py-3 md:px-6"><span className="pb-1 text-lead font-semibold">Request</span></header>
              <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-6 md:px-6">
                <div className="border border-primary/50 bg-primary/5 p-5">
                  <p className="caps text-label text-primary-text">No agents yet</p>
                  <h2 className="mt-2 text-xl font-semibold">Start a run</h2>
                  <p className="mt-1 text-lead text-muted-foreground">Runs start from an agent. Make one, then send its first request here.</p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <a href="#/agents/new" className={buttonVariants({ variant: "solid", size: "lg" })}>Create an agent</a>
                    <a href="#/templates" className={buttonVariants({ variant: "outline", size: "lg" })}>Browse templates</a>
                  </div>
                </div>
                <div>
                  <h3 className="caps text-label text-muted-foreground">What a request takes</h3>
                  <dl className="mt-3 divide-y border-y">
                    {Object.entries(NOTES).map(([name, note]) => (
                      <div key={name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3"><dt className="w-40 font-mono text-body">{name}</dt><dd className="text-small text-muted-foreground">{note}</dd></div>
                    ))}
                  </dl>
                </div>
              </div>
            </>
          ) : (
            <>
            <header className="flex items-center justify-between border-b px-5 py-3 md:px-6">
              <span className="text-lead font-semibold">Request</span>
              <span className="flex gap-4 text-small">{(["form", "json"] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={cn("border-b pb-1 capitalize", view === v ? "border-foreground" : "border-transparent text-muted-foreground")}>{v === "json" ? "JSON" : "Form"}</button>)}</span>
            </header>
            <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-6 md:px-6">
              <div><h2 className="text-xl font-semibold">Start a run</h2><p className="mt-1 text-body text-muted-foreground">{agent ? `${agent.definition.name}: ${kind === "agentic" ? "an" : "a"} ${kind} agent.` : "Pick an agent."} The server answers 202 with the run; follow it on its page.</p></div>
              {view === "json" ? (
                <>
                  <pre className="overflow-auto border bg-card p-4 font-mono text-small leading-[1.7]">{JSON.stringify(body, null, 2)}</pre>
                  {/* The files the request's file_ids come from, and how far they are sent, in this view too. */}
                  <Label name="file_ids" note={NOTES.file_ids}>
                    <FilePicker attachments={attachments} limits={limits} />
                  </Label>
                </>
              ) : (
                <>
                  <Label name={kind === "agentic" ? "input.content" : "input"} required error={!built.ok && built.field === "input" && text ? built.message : undefined}>
                    <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={kind === "agentic" ? 4 : 7} placeholder={placeholder} />
                    {example && (
                      <p className="mt-1 font-mono text-label text-muted-foreground">
                        {exampleHint(example, "start")}
                        {example.fields.length > 0 && <> Fields: {example.fields.map((f, k) => <span key={f.name} title={f.note}>{k ? ", " : ""}<span className="text-foreground">{f.name}</span></span>)}.</>}
                      </p>
                    )}
                  </Label>
                  <Label name="file_ids" note={NOTES.file_ids}>
                    <FilePicker attachments={attachments} limits={limits} />
                  </Label>
                  <Label name="revision" note={NOTES.revision}>
                    <Picker label="Revision" value={revision} onChange={setRevision} className="w-full"
                      options={[{ value: "", label: "The current revision" }, ...revisions.map((r) => ({ value: r.revision, label: `rev ${r.version}${r.current ? " (current)" : ""}${r.note ? `: ${r.note}` : ""}` }))]} />
                  </Label>
                  <Label name="effort" note={NOTES.effort}>
                    <div className="flex gap-2">{["", ...efforts].map((e) => <Button key={e || "default"} type="button" size="sm" aria-pressed={effort === e} onClick={() => setEffort(e)} className={effort === e ? "border-foreground hover:border-foreground" : "text-muted-foreground"}>{e || "default"}</Button>)}</div>
                  </Label>
                  {kind === "agentic" && (
                    <Label name="max_cost_usd" note={NOTES.max_cost_usd} error={!built.ok && built.field === "max_cost_usd" ? built.message : undefined}>
                      <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="e.g. 0.50" />
                    </Label>
                  )}
                </>
              )}
            </div>
            <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3 md:px-6">
              <span className="text-small text-muted-foreground">Sends a real request to this server.</span>
              <Button variant="primary" size="lg" onClick={send} disabled={!built.ok || !onSend || sending || !agentId || attachments.busy} title={attachments.busy ? "Waiting for the files to be sent" : undefined}><Play aria-hidden /> {sending ? "Sending" : "Send request"}</Button>
            </footer>
            </>
          )}
        </section>
        <section aria-label="Code and response" className={cn("flex min-h-0 flex-col", !showCode && "short:hidden")}>
          <header className="flex items-center justify-between border-b px-5 py-3 md:px-6">
            <span className="flex gap-4 text-body">
              <button type="button" onClick={() => setPane("code")} className={cn("border-b pb-1", pane === "code" ? "border-foreground" : "border-transparent text-muted-foreground")}>Code</button>
              <button type="button" onClick={() => setPane("response")} disabled={!result} className={cn("border-b pb-1 disabled:opacity-45", pane === "response" ? "border-foreground" : "border-transparent text-muted-foreground")}>Response{result && <span className={cn("ml-2 font-mono", result.status < 300 ? "text-success-text" : "text-destructive-text")}>{result.status}</span>}</button>
            </span>
            {pane === "code" && <Button size="icon" variant="outline" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(code)}><Copy aria-hidden /></Button>}
          </header>
          {pane === "code" ? (
            <>
              <div className="flex gap-5 border-b px-5 text-small md:px-6">{(["curl", "fetch"] as const).map((l) => <button key={l} type="button" onClick={() => setLang(l)} className={cn("-mb-px border-b-2 py-2.5", lang === l ? "border-primary" : "border-transparent text-muted-foreground")}>{l === "curl" ? "cURL" : "JavaScript"}</button>)}</div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-5 font-mono text-small leading-[1.8] md:px-6">{code}</pre>
              <footer className="border-t px-5 py-3 text-small text-muted-foreground md:px-6">The same request from your code: set AGENTRUN_TOKEN in your environment.</footer>
            </>
          ) : result && (
            <>
              <p className="border-b px-5 py-2.5 font-mono text-small md:px-6"><span className={result.status < 300 ? "text-success-text" : "text-destructive-text"}>{result.status}</span> <span className="text-muted-foreground">{result.ms} ms</span></p>
              {refusal && (
                <p className="border-b px-5 py-2.5 font-mono text-small text-destructive-text md:px-6" role="alert">
                  The run did not start: {refusal.message}{refusal.box ? <span className="text-muted-foreground"> (box: {refusal.box})</span> : null}
                  <ToolBlockers agentId={agentId} details={refusal.details} />
                  {refusal.more.length > 0 && <span className="mt-1 block">{refusal.more.map((f) => <span key={`${f.field}:${f.message}`} className="block">{f.field}: {f.message}</span>)}</span>}
                </p>
              )}
              {result.runId && live ? (
                // The server answered 202: the run itself, followed until it ends, with the raw answer one click away.
                <>
                  <div className="min-h-0 flex-1 overflow-hidden border-b">{live(result.runId)}</div>
                  <details className="border-b px-5 py-2.5 md:px-6"><summary className="caps cursor-pointer text-label text-muted-foreground">Response body</summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words py-3 font-mono text-small leading-[1.8]">{JSON.stringify(result.body, null, 2)}</pre></details>
                </>
              ) : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-5 font-mono text-small leading-[1.8] md:px-6">{JSON.stringify(result.body, null, 2)}</pre>}
              {result.runId && <button type="button" onClick={() => onOpenRun?.(result.runId!)} className="caps flex items-center justify-between border-t px-5 py-4 text-small text-primary-text hover:bg-accent md:px-6">Open this run <ArrowRight className="size-4" aria-hidden /></button>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** What each field of a start request is, said once: under the form's fields, and as the read-only list a server
 *  with no agents shows in the form's place. */
const NOTES = {
  "input.content": "Required. The run's first message.",
  file_ids: "Empty names none.",
  revision: "Empty runs the current revision.",
  effort: "How hard the model thinks. Empty uses the agent's own.",
  max_cost_usd: "A spend cap in dollars; empty means none.",
} as const;

function Label({ name, required, note, error, children }: { name: string; required?: boolean; note?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between"><span className="font-mono text-body">{name}</span>{required && <span className="text-label text-muted-foreground">required</span>}</div>
      {children}
      {note && <p className="mt-1.5 text-small text-muted-foreground">{note}</p>}
      {error && <p className="mt-1.5 font-mono text-small text-destructive-text" role="alert">{error}</p>}
    </div>
  );
}
