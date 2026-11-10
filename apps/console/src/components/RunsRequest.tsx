import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Copy, Play } from "lucide-react";
import { CodingAgentAction } from "./CodingAgentAction";
import { Button, Picker } from "./ui";
import { RUN_STATUSES } from "./RunsList";
import { startFailure, type StartResult } from "./Playground";
import { StatusBadge } from "./StatusBadge";
import type { Client, RunsFilter } from "@/lib/client";
import { queryRunsPrompt } from "@/lib/codingAgentPrompts";
import type { Run, RunStatus } from "@/lib/v2";
import { cn } from "@/lib/utils";

type RunPage = { runs: Run[]; next_cursor: string | null };
const field = "h-11 w-full border bg-card px-3 text-lead outline-none focus:border-primary";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** An explicit read-only workbench. Pagination always retains the selected agent and filters. */
export function RunsRequest({ v2, origin, agentId, filter = {} }: { v2: Client; origin: string; agentId?: string; filter?: RunsFilter }) {
  const [status, setStatus] = useState<RunStatus | "">(filter.status ?? "");
  const [archived, setArchived] = useState(!!filter.archived);
  const [limit, setLimit] = useState(50);
  const [cursor, setCursor] = useState("");
  const [pane, setPane] = useState<"code" | "response">("code");
  const [language, setLanguage] = useState<"curl" | "fetch">("curl");
  const [result, setResult] = useState<StartResult | null>(null);
  const [page, setPage] = useState<RunPage | null>(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setStatus(filter.status ?? ""); setArchived(!!filter.archived); setCursor(""); setPage(null); setResult(null); setSending(false);
    return () => { generation.current++; };
  }, [agentId, filter.status, filter.archived]);
  const filters: RunsFilter = { ...(status ? { status } : {}), ...(archived ? { archived: true } : {}) };
  const path = agentId ? `/v2/agents/${encodeURIComponent(agentId)}/runs` : "/v2/runs";
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  if (status) query.set("status", status);
  if (archived) query.set("archived", "true");
  const url = `${origin}${path}?${query}`;
  const code = language === "curl"
    ? `curl -X GET ${quote(url)} \\\n  -H "Authorization: Bearer $AGENTRUN_API_KEY"`
    : `const response = await fetch(${JSON.stringify(url)}, {\n  method: "GET",\n  headers: { Authorization: \`Bearer \${process.env.AGENTRUN_API_KEY}\` },\n});\nconsole.log(response.status, await response.json());`;
  const prompt = `${queryRunsPrompt(origin, agentId)}\n\nPrepared read-only request: GET ${url}\nUse exactly this agent scope, status, archive selection, page size and cursor. Do not broaden the query or issue writes. Show the results and links to relevant runs. Follow next_cursor only when more results are needed, keeping the same filters.`;
  const changed = () => { generation.current++; setCursor(""); setPage(null); setResult(null); setCopied(false); };
  const send = async (after = cursor) => {
    if (sending) return;
    const attempt = ++generation.current;
    setSending(true); setPage(null); setResult(null); setCursor(after); setCopied(false);
    const start = performance.now();
    try {
      const next = agentId ? await v2.listAgentRuns(agentId, limit, after || undefined, filters) : await v2.listRuns(limit, after || undefined, filters);
      if (generation.current !== attempt) return;
      setPage(next); setResult({ status: 200, ms: performance.now() - start, body: next });
    } catch (error) {
      if (generation.current !== attempt) return;
      setResult(startFailure(error, performance.now() - start));
    } finally {
      if (generation.current === attempt) { setSending(false); setPane("response"); }
    }
  };
  return <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
    <section className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
      <header className="flex h-12 shrink-0 items-center border-b px-6"><span className="text-lead font-semibold">Request</span></header>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-6">
        <div><h2 className="text-xl font-semibold">List runs</h2><p className="mt-2 text-lead leading-relaxed text-muted-foreground">Inspect server-run sessions and imported history. This request only reads data.</p></div>
        <label className="block space-y-2"><span className="text-lead">Agent</span><input className={field} value={agentId ?? "All agents"} readOnly /></label>
        <label className="block space-y-2"><span className="text-lead">Status</span><Picker label="Run status" value={status} disabled={sending} onChange={(value) => { setStatus(value as RunStatus | ""); changed(); }} options={[{ value: "", label: "All statuses" }, ...RUN_STATUSES.map((value) => ({ value, label: value.replaceAll("_", " ") }))]} /></label>
        <label className="block space-y-2"><span className="text-lead">Archive</span><Picker label="Archived runs" value={String(archived)} disabled={sending} onChange={(value) => { setArchived(value === "true"); changed(); }} options={[{ value: "false", label: "Current runs" }, { value: "true", label: "Archived runs" }]} /></label>
        <label className="block space-y-2"><span className="text-lead">Page size</span><Picker label="Page size" value={String(limit)} disabled={sending} onChange={(value) => { setLimit(Number(value)); changed(); }} options={[10, 25, 50, 100].map((size) => ({ value: String(size), label: String(size) }))} /></label>
        <label className="block space-y-2"><span className="text-lead">Cursor</span><input aria-label="Cursor" className={`${field} font-mono text-small`} value={cursor} disabled={sending} placeholder="First page" onChange={(event) => { generation.current++; setCursor(event.target.value); setPage(null); setResult(null); }} /></label>
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t p-4"><CodingAgentAction label="Use your agent" prompt={prompt} /><Button variant="primary" disabled={sending} onClick={() => void send()}><Play aria-hidden />{sending ? "Sending" : "Send request"}</Button></footer>
    </section>
    <section className="flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-5 border-b px-6">{(["code", "response"] as const).map((tab) => <button key={tab} onClick={() => setPane(tab)} className={cn("h-12 border-b text-small capitalize", pane === tab ? "border-primary" : "border-transparent text-muted-foreground")}>{tab}</button>)}<Button size="icon" className="ml-auto" aria-label="Copy code" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setCopied(false)); }}><Copy aria-hidden /></Button><span className="sr-only" role="status">{copied ? "Code copied" : ""}</span></header>
      {pane === "code" ? <><div className="flex h-12 shrink-0 gap-5 border-b px-6">{(["curl", "fetch"] as const).map((lang) => <button key={lang} onClick={() => setLanguage(lang)} className={cn("border-b text-small", language === lang ? "border-primary" : "border-transparent text-muted-foreground")}>{lang === "curl" ? "cURL" : "JavaScript"}</button>)}</div><pre className="min-h-0 flex-1 overflow-auto p-6 font-mono text-small leading-6">{code}</pre></> : <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        {result ? <><p className="font-mono text-small">{result.status || "Network error"} · {Math.round(result.ms)} ms</p>
          {page && <>{page.runs.length ? <ul className="divide-y border">{page.runs.map((run) => <li key={run.run_id}><a className="flex items-center gap-3 p-3 text-lead hover:bg-accent" href={`#/runs/${encodeURIComponent(run.run_id)}`}><StatusBadge run={run} /><span className="min-w-0 flex-1 truncate">{run.title || run.run_id}</span><ArrowUpRight className="size-3.5 shrink-0" aria-hidden /></a></li>)}</ul> : <p className="text-lead text-muted-foreground">No runs match this request.</p>}{page.next_cursor && <Button size="sm" disabled={sending} onClick={() => void send(page.next_cursor!)}>Next page</Button>}</>}
          <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-small leading-6">{JSON.stringify(result.body, null, 2)}</pre>
        </> : <p className="text-lead text-muted-foreground">{sending ? "Loading runs…" : "Send a request to see its response."}</p>}
      </div>}
    </section>
  </div>;
}
