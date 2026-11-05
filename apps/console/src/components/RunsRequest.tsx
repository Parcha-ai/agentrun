import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Copy, Play } from "lucide-react";
import { CodingAgentAction } from "./CodingAgentAction";
import { Button } from "./ui/button";
import { RUN_STATUSES } from "./RunsList";
import { startFailure, type StartResult } from "./Playground";
import { StatusBadge } from "./StatusBadge";
import type { Client, RunsFilter } from "@/lib/client";
import { queryRunsPrompt } from "@/lib/codingAgentPrompts";
import type { Run, RunStatus } from "@/lib/v2";
import { cn } from "@/lib/utils";

type RunPage = { runs: Run[]; next_cursor: string | null };
const field = "h-11 w-full rounded-lg border bg-card px-3 text-sm outline-none focus:border-primary";
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
      <header className="flex h-12 shrink-0 items-center border-b px-6"><span className="text-sm font-semibold">Request</span></header>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-6">
        <div><h2 className="text-xl font-semibold">List runs</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Inspect server-run sessions and imported history. This request only reads data.</p></div>
        <label className="block space-y-2"><span className="text-sm">Agent</span><input className={field} value={agentId ?? "All agents"} readOnly /></label>
        <label className="block space-y-2"><span className="text-sm">Status</span><select aria-label="Run status" className={field} value={status} disabled={sending} onChange={(event) => { setStatus(event.target.value as RunStatus | ""); changed(); }}>
          <option value="">All statuses</option>{RUN_STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
        </select></label>
        <label className="block space-y-2"><span className="text-sm">Archive</span><select aria-label="Archived runs" className={field} value={String(archived)} disabled={sending} onChange={(event) => { setArchived(event.target.value === "true"); changed(); }}><option value="false">Current runs</option><option value="true">Archived runs</option></select></label>
        <label className="block space-y-2"><span className="text-sm">Page size</span><select aria-label="Page size" className={field} value={limit} disabled={sending} onChange={(event) => { setLimit(Number(event.target.value)); changed(); }}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <label className="block space-y-2"><span className="text-sm">Cursor</span><input aria-label="Cursor" className={`${field} font-mono text-xs`} value={cursor} disabled={sending} placeholder="First page" onChange={(event) => { generation.current++; setCursor(event.target.value); setPage(null); setResult(null); }} /></label>
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t p-4"><CodingAgentAction label="Use your agent" prompt={prompt} /><Button variant="primary" disabled={sending} onClick={() => void send()}><Play aria-hidden />{sending ? "Sending" : "Send request"}</Button></footer>
    </section>
    <section className="flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-5 border-b px-6">{(["code", "response"] as const).map((tab) => <button key={tab} onClick={() => setPane(tab)} className={cn("h-12 border-b text-xs capitalize", pane === tab ? "border-primary" : "border-transparent text-muted-foreground")}>{tab}</button>)}<Button size="icon" className="ml-auto" aria-label="Copy code" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setCopied(false)); }}><Copy aria-hidden /></Button><span className="sr-only" role="status">{copied ? "Code copied" : ""}</span></header>
      {pane === "code" ? <><div className="flex h-12 shrink-0 gap-5 border-b px-6">{(["curl", "fetch"] as const).map((lang) => <button key={lang} onClick={() => setLanguage(lang)} className={cn("border-b text-xs", language === lang ? "border-primary" : "border-transparent text-muted-foreground")}>{lang === "curl" ? "cURL" : "JavaScript"}</button>)}</div><pre className="min-h-0 flex-1 overflow-auto p-6 font-mono text-xs leading-6">{code}</pre></> : <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        {result ? <><p className="font-mono text-xs">{result.status || "Network error"} · {Math.round(result.ms)} ms</p>
          {page && <>{page.runs.length ? <ul className="divide-y rounded-lg border">{page.runs.map((run) => <li key={run.run_id}><a className="flex items-center gap-3 p-3 text-sm hover:bg-accent" href={`#/runs/${encodeURIComponent(run.run_id)}`}><StatusBadge run={run} /><span className="min-w-0 flex-1 truncate">{run.title || run.run_id}</span><ArrowUpRight className="size-3.5 shrink-0" aria-hidden /></a></li>)}</ul> : <p className="text-sm text-muted-foreground">No runs match this request.</p>}{page.next_cursor && <Button size="sm" disabled={sending} onClick={() => void send(page.next_cursor!)}>Next page</Button>}</>}
          <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{JSON.stringify(result.body, null, 2)}</pre>
        </> : <p className="text-sm text-muted-foreground">{sending ? "Loading runs…" : "Send a request to see its response."}</p>}
      </div>}
    </section>
  </div>;
}
