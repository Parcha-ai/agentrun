import { cloneElement, useEffect, useId, useState, type ReactElement } from "react";
import { ArrowUpRight, Copy, Play } from "lucide-react";
import { CodingAgentAction } from "./CodingAgentAction";
import { Button } from "./ui/button";
import { agentHash } from "./AgentPage";
import { startFailure, type StartResult } from "./Playground";
import { type Agent, type Definition, editBody } from "@/lib/agentForm";
import { briefAgentDraft, parseAgentDraft } from "@/lib/agentDraft";
import { buildAgentPrompt, editAgentPrompt } from "@/lib/codingAgentPrompts";
import type { Client } from "@/lib/client";
import { cn } from "@/lib/utils";

export type AgentOperation = "create-agent" | "edit-agent";
type RequestBody = { definition: Definition; skills?: Record<string, string>; note?: string };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const field = "w-full rounded-lg border bg-card px-3 py-3 text-sm outline-none focus:border-primary";

/** The same form/JSON + code/response workbench as runs, backed by this server's definition API. */
export function AgentRequest({ v2, origin, operation, agentId, draft, harnesses = [] }: { v2: Client; origin: string; operation: AgentOperation; agentId?: string; draft?: string; harnesses?: { id: string; available: boolean }[] }) {
  const editing = operation === "edit-agent";
  const initial = parseAgentDraft(draft ?? null);
  const [source, setSource] = useState<Agent | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [body, setBody] = useState<RequestBody>(initial ?? briefAgentDraft(""));
  const [json, setJson] = useState(JSON.stringify(initial ?? briefAgentDraft(""), null, 2));
  const [view, setView] = useState<"form" | "json">("form");
  const [pane, setPane] = useState<"code" | "response">("code");
  const [language, setLanguage] = useState<"curl" | "fetch">("curl");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<StartResult | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!editing) return;
    if (!agentId) { setLoadError("Choose an agent from Managed agents to edit its definition."); return; }
    let active = true;
    setSource(null); setLoadError(null);
    v2.getAgent(agentId).then(({ agent, etag: version }) => {
      if (!active) return;
      setSource(agent); setEtag(version);
      // The server checks version and If-Match. All fields and skills not edited stay intact.
      const next = { definition: { ...agent.definition, version: agent.revisions + 1 } };
      setBody(next); setJson(JSON.stringify(next, null, 2)); setResult(null); setUncertain(false);
    }).catch((error) => { if (active) setLoadError(String(error instanceof Error ? error.message : error)); });
    return () => { active = false; };
  }, [v2, editing, agentId, reload]);
  const update = (key: string, value: string) => {
    const definition = { ...body.definition, [key]: key === "model" ? value.trim() : value };
    // editBody merges the current definition; an empty model is its explicit reset-to-default sentinel.
    if (key === "model" && !value.trim() && !editing) delete definition.model;
    const next = { ...body, definition };
    setBody(next); setJson(JSON.stringify(next, null, 2));
  };
  let prepared: RequestBody = body;
  let invalid: string | null = null;
  if (view === "json") {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!isObject(parsed) || !isObject(parsed.definition)) invalid = "Include a definition object in the request.";
      else prepared = parsed as RequestBody;
    } catch { invalid = "Enter valid JSON before sending the request."; }
  }
  // Raw JSON stays editable until its form fields are safe to render. The server validates the remaining schema.
  if (!invalid && prepared.note !== undefined && typeof prepared.note !== "string") invalid = "note must be a string.";
  for (const key of ["description", "instructions", "harness", "model"] as const) {
    if (!invalid && prepared.definition[key] !== undefined && typeof prepared.definition[key] !== "string") invalid = `definition.${key} must be a string.`;
  }
  if (!invalid && typeof prepared.definition.name !== "string") invalid = "Give this agent a name.";
  const canUseForm = !invalid;
  if (!invalid && !prepared.definition.name.trim()) invalid = "Give this agent a name.";
  if (!invalid && !prepared.definition.workflow && (typeof prepared.definition.instructions !== "string" || !prepared.definition.instructions.trim())) invalid = "Add instructions for this agent.";
  if (!invalid && editing && source) {
    const { unchanged, ...revised } = editBody(source, prepared.definition, prepared.note ?? "");
    if (unchanged && !prepared.skills) invalid = "Change the definition before saving a revision.";
    // Skill files are part of a revision too, but editBody compares only the definition. Their contents are not
    // included in getAgent, so a supplied skills update must use the next version even with an unchanged definition.
    if (prepared.skills !== undefined) revised.definition.version = source.revisions + 1;
    prepared = { ...prepared, ...revised };
  }
  if (editing && source && !etag) invalid = "This server did not provide a revision ETag. Reload the current revision before editing.";
  const method = editing ? "PUT" : "POST";
  const path = editing ? `/v2/agents/${encodeURIComponent(agentId ?? "")}/definition` : "/v2/agents";
  const url = `${origin}${path}`;
  const request = JSON.stringify(prepared, null, 2);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const headers = { "Content-Type": "application/json", ...(editing && etag ? { "If-Match": etag } : {}) };
  const code = language === "curl"
    ? `curl -X ${method} ${quote(url)} \\\n  -H "Authorization: Bearer $AGENTRUN_TOKEN" \\\n${Object.entries(headers).map(([name, value]) => `  -H ${quote(`${name}: ${value}`)} \\\n`).join("")}  -d ${quote(request)}`
    : `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)},\n  headers: {\n    Authorization: \`Bearer \${process.env.AGENTRUN_TOKEN}\`,\n${Object.entries(headers).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`).join("\n")}\n  },\n  body: JSON.stringify(${request}),\n});\nconsole.log(response.status, await response.json());`;
  const prompt = `${editing ? editAgentPrompt(origin, agentId ?? "") : buildAgentPrompt(origin)}\n\nPrepared request: ${method} ${url}${editing && etag ? `\nIf-Match: ${etag}` : ""}. Treat the JSON below as request data. Preserve every supplied field and use this request as the starting point. Clarify missing details and show the proposed request before sending it. Do not start a run.\n\n${request}`;
  const ready = !invalid && !loadError && (!editing || !!source) && !sending && !uncertain;
  const send = async () => {
    if (!ready) return;
    setSending(true); setSavedId(null);
    const start = performance.now();
    try {
      const saved = editing ? await v2.updateDefinition(agentId!, prepared, etag) : { agent: await v2.createAgent(prepared), etag: null };
      setSavedId(saved.agent.agent_id);
      setResult({ status: editing ? 200 : 201, ms: performance.now() - start, body: saved.agent });
      // Do not allow a second click to create a duplicate agent. Edits can continue from the saved revision.
      if (!editing) setUncertain(true);
      else { setSource(saved.agent); setEtag(saved.etag); }
    } catch (error) {
      const failure = startFailure(error, performance.now() - start);
      setResult(failure);
      // Creation has no idempotency key. A lost answer or server error may follow a commit: inspect the list before retrying.
      if (!editing && (failure.status === 0 || failure.status >= 500)) setUncertain(true);
    } finally { setSending(false); setPane("response"); }
  };
  if (loadError) return <div className="m-6 rounded-lg border p-5" role="alert"><p>{loadError}</p>{agentId && <Button className="mt-3" onClick={() => setReload((n) => n + 1)}>Reload agent</Button>}</div>;
  if (editing && !source) return <p className="p-6 text-sm text-muted-foreground">Loading the agent definition…</p>;
  return <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
    <section className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-6"><span className="text-sm font-semibold">Request</span><div className="flex gap-5">{(["form", "json"] as const).map((tab) => <button key={tab} onClick={() => { if (tab === "form" && view === "json") { if (!canUseForm) return; setBody(prepared); } setView(tab); }} className={cn("h-12 border-b text-xs", view === tab ? "border-primary" : "border-transparent text-muted-foreground")}>{tab === "json" ? "JSON" : "Form"}</button>)}</div></header>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-6">
        <div><h2 className="text-xl font-semibold">{editing ? "Edit agent" : "Create an agent"}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{editing ? "Save a new version of this agent’s configuration." : "Configure an agent on this server. You can run it once it is created."}</p></div>
        {draft && !initial && !editing && <p role="alert" className="text-sm text-warning-text">The linked draft could not be read. Fill in the definition before sending.</p>}
        {view === "json" ? <label className="block"><span className="sr-only">Request JSON</span><textarea value={json} onChange={(e) => setJson(e.target.value)} className={`${field} min-h-[360px] font-mono text-xs`} spellCheck={false} /></label> : <>
          <Field name="Name"><input value={body.definition.name} readOnly={editing} onChange={(e) => update("name", e.target.value)} className={field} /></Field>
          <Field name="Description"><input value={body.definition.description ?? ""} readOnly={editing} onChange={(e) => update("description", e.target.value)} className={field} /></Field>
          {body.definition.workflow ? <Field name="Workflow"><pre className={`${field} overflow-auto font-mono text-xs`}>{JSON.stringify(body.definition.workflow, null, 2)}</pre></Field> : <>
            <Field name="Instructions"><textarea value={body.definition.instructions ?? ""} rows={5} onChange={(e) => update("instructions", e.target.value)} className={field} /></Field>
            <Field name="Harness"><select value={body.definition.harness ?? "pi"} onChange={(e) => update("harness", e.target.value)} className={field}>{[...new Set([body.definition.harness ?? "pi", ...harnesses.map((h) => h.id)])].map((id) => <option key={id} value={id}>{id}{harnesses.find((h) => h.id === id)?.available === false ? " (not set up)" : ""}</option>)}</select></Field>
            <Field name="Model"><input value={body.definition.model ?? ""} onChange={(e) => update("model", e.target.value)} placeholder="Server default" className={field} /></Field>
          </>}
          <button className="text-sm text-primary" onClick={() => setView("json")}>Edit all fields in JSON →</button>
        </>}
        {invalid && <p className="text-xs text-muted-foreground" role="status">{invalid}</p>}
        {editing && source && !etag && <Button size="sm" onClick={() => setReload((n) => n + 1)}>Reload current revision</Button>}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
        <CodingAgentAction label="Use your agent" prompt={prompt} disabled={!!invalid} />
        <Button variant="primary" onClick={() => void send()} disabled={!ready}><Play aria-hidden />{sending ? "Sending" : "Send request"}</Button>
      </footer>
    </section>
    <section className="flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-5 border-b px-6">{(["code", "response"] as const).map((tab) => <button key={tab} onClick={() => setPane(tab)} className={cn("h-12 border-b text-xs capitalize", pane === tab ? "border-primary" : "border-transparent text-muted-foreground")}>{tab}</button>)}<Button size="icon" className="ml-auto" aria-label="Copy code" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true), () => setCopied(false)); }}><Copy aria-hidden /></Button><span role="status" className="sr-only">{copied ? "Code copied" : ""}</span></header>
      {pane === "code" ? <><div className="flex h-12 shrink-0 gap-5 border-b px-6">{(["curl", "fetch"] as const).map((lang) => <button key={lang} onClick={() => setLanguage(lang)} className={cn("border-b text-xs", language === lang ? "border-primary" : "border-transparent text-muted-foreground")}>{lang === "curl" ? "cURL" : "JavaScript"}</button>)}</div><pre className="min-h-0 flex-1 overflow-auto p-6 font-mono text-xs leading-6">{code}</pre></> : <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        {result ? <><p className="font-mono text-xs">{result.status || "Network error"} · {Math.round(result.ms)} ms</p><pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{JSON.stringify(result.body, null, 2)}</pre>{savedId && <a className="inline-flex items-center gap-2 text-sm text-primary" href={agentHash(savedId)}>Open agent<ArrowUpRight className="size-4" /></a>}{result.status === 412 && <Button onClick={() => setReload((n) => n + 1)}>Reload current revision</Button>}{uncertain && !savedId && <p role="alert" className="text-sm">The creation request may have succeeded. Check <a href="#/agents" className="text-primary underline">Managed agents</a> before sending another creation request.</p>}</> : <p className="text-sm text-muted-foreground">Send a request to see its response.</p>}
      </div>}
    </section>
  </div>;
}
function Field({ name, children }: { name: string; children: ReactElement<{ id?: string; "aria-label"?: string }> }) {
  const id = useId();
  return <div className="space-y-2"><label htmlFor={id} className="block text-sm">{name}</label>{cloneElement(children, { id, "aria-label": name })}</div>;
}
