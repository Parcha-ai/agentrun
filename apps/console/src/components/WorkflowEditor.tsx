import { graphDiff, workflowGraph } from "@dsl/graph";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import type { WorkflowCheck } from "@/lib/client";
import { metaOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import type { GraphMarks } from "@/lib/wfGraph";
import { type Issue, type Json, lineCol, lintWorkflow, nodeAtOffset, parseWithSpans, spanOf } from "@/lib/workflowDoc";

const LINE_PX = 20;
const CHECK_MS = 400;

type Check = { text: string; check: WorkflowCheck } | { text: string; failed: string } | "unsupported" | null;

/** The server's check of the text, asked CHECK_MS after the last keystroke that left it parseable. A server without the
 *  route (404, 405) is not asked again, and the console's own lint stands in. A check that failed otherwise is named, the
 *  lint stands in for it, and `retry` asks again. Only an answer for the text on screen counts. */
function useServerCheck(text: string, value: Json | undefined, ok: boolean, tools: string[] | undefined, validate?: (body: { workflow: unknown; tools?: string[] }, signal?: AbortSignal) => Promise<WorkflowCheck>) {
  const [check, setCheck] = useState<Check>(null);
  const [again, setAgain] = useState(0);
  const toolsKey = (tools ?? []).join(",");
  useEffect(() => {
    if (!validate || !ok || check === "unsupported") return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      validate({ workflow: value, ...(tools ? { tools } : {}) }, ctl.signal).then(
        (answer) => { if (!ctl.signal.aborted) setCheck({ text, check: answer }); },
        (e: { status?: number; message?: string }) => {
          if (ctl.signal.aborted) return;
          if (e?.status === 404 || e?.status === 405) setCheck("unsupported");
          else setCheck({ text, failed: e?.message || `the server answered ${e?.status ?? "nothing"}` });
        },
      );
    }, CHECK_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text, ok, toolsKey, validate, again]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => { setCheck(null); setAgain((n) => n + 1); };
  if (check === "unsupported" || !validate) return { mode: "lint" as const, retry };
  if (check && check.text === text) return "failed" in check ? { mode: "failed" as const, failed: check.failed, retry } : { mode: "server" as const, check: check.check, retry };
  return { mode: "pending" as const, retry };
}

/** A workflow's JSON beside its graph. The graph is drawn again as you type (the last text that parsed stays drawn while
 *  the JSON is broken), marked NEW and EDITED against the saved revision, with its removed nodes listed; the problems the
 *  console can see are listed under the text by line, and the server's own refusal of a save beside them. Clicking a node
 *  selects its JSON; the node the cursor is in is outlined in the graph. `readOnly` (a past revision) shows the JSON and
 *  the marked graph only: the text takes no edit, and nothing is checked, by the server or the console. */
export function WorkflowEditor({ text, onText, base, baseLabel, serverIssues, readOnly = false, validate, tools }: {
  text: string;
  onText: (text: string) => void;
  /** The current revision's workflow: the diff is against it. None for a new agent. */
  base?: unknown;
  baseLabel?: string;
  /** The server's refusal of the last save, as it said it. */
  serverIssues?: { path: string; message: string }[] | null;
  /** A revision to look at, not edit: no edit, no check of it, and no problems list. */
  readOnly?: boolean;
  /** The server's check as you type; without it (or on a server without the route) the console's lint is shown. */
  validate?: (body: { workflow: unknown; tools?: string[] }, signal?: AbortSignal) => Promise<WorkflowCheck>;
  /** The definition's tools, for the server's check of call nodes. */
  tools?: string[];
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const parsed = useMemo(() => parseWithSpans(text), [text]);
  const good = useRef<{ value: Json; spans: Map<string, { start: number; end: number }> } | null>(null);
  if (parsed.ok) good.current = { value: parsed.value, spans: parsed.spans };
  const doc = good.current?.value;
  const graph = useMemo(() => workflowGraph(doc), [doc]);
  const baseGraph = useMemo(() => (base === undefined ? null : workflowGraph(base)), [base]);
  const diff = useMemo(() => (baseGraph ? graphDiff(baseGraph, graph) : null), [baseGraph, graph]);
  const server = useServerCheck(text, parsed.ok ? parsed.value : undefined, parsed.ok, tools, readOnly ? undefined : validate);
  const lint = useMemo<Issue[]>(() => (parsed.ok && !readOnly ? lintWorkflow(parsed.value) : []), [parsed, readOnly]);
  // The server's answer for this text is the one that counts; the lint shows while it is asked, or when it cannot be.
  const issues = useMemo<Issue[]>(() => (server.mode !== "server" ? lint : [
    ...server.check.issues.map((i) => ({ path: i.path, message: i.message, severity: "error" as const })),
    ...server.check.warnings.map((w) => (typeof w === "string" ? { path: "", message: w, severity: "warning" as const } : { path: w.path ?? "", message: w.message, severity: "warning" as const })),
  ]), [server.mode, server.mode === "server" ? server.check : null, lint]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedPath = parsed.ok ? nodeAtOffset(parsed.spans, graph.nodes.map((n) => n.path), cursor) : null;
  const marks = useMemo<GraphMarks>(() => ({
    meta: metaOf(doc, graph),
    diff: diff ? { added: diff.added.map((n) => n.path), edited: [...diff.changed, ...diff.rewritten].map((n) => n.next), moved: diff.moved.map((n) => n.next), removed: diff.removed.map(({ label, kind }) => ({ label, kind })) } : undefined,
    selected: selectedPath ? { path: selectedPath } : null,
  }), [doc, graph, diff, selectedPath]);

  const lines = text.split("\n").length;
  const located = (offset: number) => lineCol(text, offset);
  const rows: { line: number; col: number; message: string; severity: "error" | "warning"; offset: number; path?: string }[] = [];
  if (!parsed.ok) rows.push({ ...located(parsed.error.offset), message: `JSON: ${parsed.error.message}`, severity: "error", offset: parsed.error.offset });
  for (const i of issues) {
    const s = parsed.ok ? spanOf(parsed.spans, i.path) : undefined;
    const offset = s?.start ?? 0;
    rows.push({ ...located(offset), message: i.message, severity: i.severity, offset, path: i.path });
  }
  // The server's refusal of a save: each issue at its path when it names one (a 422's fields), else its message alone.
  for (const e of [...(serverIssues ?? [])].reverse()) {
    const s = e.path && parsed.ok ? spanOf(parsed.spans, e.path) : undefined;
    rows.unshift({ ...(s ? located(s.start) : { line: 0, col: 0 }), message: `Server: ${e.message}`, severity: "error", offset: s?.start ?? -1 });
  }
  const bad = new Map<number, "error" | "warning">();
  for (const r of rows) if (r.line && bad.get(r.line) !== "error") bad.set(r.line, r.severity);

  const jump = (start: number, end = start) => {
    const t = area.current;
    if (!t || start < 0) return;
    t.focus();
    t.setSelectionRange(start, end);
    t.scrollTop = Math.max(0, (located(start).line - 4) * LINE_PX);
    setCursor(start);
  };
  // The nodes are what an editor opens on: the text starts scrolled to the root, past the schemas.
  useEffect(() => {
    const s = parsed.ok ? parsed.spans.get("/root") : undefined;
    if (s && area.current) area.current.scrollTop = Math.max(0, (located(s.start).line - 2) * LINE_PX);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A reorder is a change: its nodes are moved, and the order shows in the connections between them.
  const rewired = diff ? diff.edges.added.length + diff.edges.removed.length : 0;
  const changes = diff ? diff.added.length + diff.changed.length + diff.rewritten.length + diff.removed.length + diff.moved.length + rewired : 0;
  const errors = rows.filter((r) => r.severity === "error").length;

  return (
    <div className="grid min-h-0 grid-cols-1 border xl:grid-cols-[minmax(420px,5fr)_7fr]">
      <div className="flex min-h-0 flex-col border-b xl:border-b-0 xl:border-r">
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <span className="caps text-[11px] font-semibold">workflow.json</span>
          <span className="font-mono text-[11px] text-muted-foreground">{lines} lines</span>
          <span className="flex-1" />
          {readOnly ? <span className="caps text-[11px] text-muted-foreground">Read-only</span> : <>
          {server.mode === "failed" && parsed.ok
            ? <span className="font-mono text-[11px] text-warning-text" title={server.failed}>server check failed, showing local checks <button type="button" onClick={server.retry} className="caps ml-1 border px-1.5 text-[10px] text-foreground hover:bg-accent">Retry</button></span>
            : server.mode !== "lint" && parsed.ok && <span className="font-mono text-[11px] text-muted-foreground">{server.mode === "pending" ? "checking..." : "checked by the server"}</span>}
          {errors ? <span className="caps inline-flex items-center gap-1 text-[11px] text-destructive-text"><CircleAlert className="size-3.5" aria-hidden /> {errors} {errors === 1 ? "problem" : "problems"}</span>
            : <span className="caps text-[11px] text-success-text">{server.mode === "server" ? "Valid" : "Valid shape"}</span>}
          </>}
        </div>
        <div className="relative flex h-[560px] min-h-0 xl:h-[calc(100vh-390px)] xl:min-h-[440px]">
          <div ref={gutter} aria-hidden className="w-12 shrink-0 select-none overflow-hidden border-r bg-card py-3 text-right font-mono text-[11px] text-muted-foreground" style={{ lineHeight: `${LINE_PX}px` }}>
            {Array.from({ length: lines }, (_, k) => (
              <div key={k} className={cn("pr-2", bad.get(k + 1) === "error" && "bg-destructive/15 text-destructive-text", bad.get(k + 1) === "warning" && "bg-warning/15 text-warning-text")}>{k + 1}</div>
            ))}
          </div>
          <textarea ref={area} value={text} readOnly={readOnly} spellCheck={false} wrap="off" aria-label="Workflow JSON"
            onChange={(e) => { if (!readOnly) onText(e.target.value); setCursor(e.target.selectionStart); }}
            onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart)}
            onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }}
            onKeyDown={(e) => {
              if (e.key !== "Tab" || readOnly) return;
              e.preventDefault();
              const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd;
              onText(`${text.slice(0, a)}  ${text.slice(b)}`);
              requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
            }}
            className="min-w-0 flex-1 resize-none overflow-auto bg-background px-3 py-3 font-mono text-[12px] outline-none selection:bg-[hsl(var(--primary)/0.28)] selection:text-foreground"
            style={{ lineHeight: `${LINE_PX}px`, tabSize: 2 }} />
        </div>
        {!readOnly && <ul className="max-h-48 min-h-[44px] overflow-auto border-t font-mono text-[12px]" aria-label="Problems">
          {rows.length === 0 && <li className="px-4 py-3 text-muted-foreground">{server.mode === "server" ? "No problems: the server's validator takes this workflow as it is." : "No problems the console can see. The server checks the workflow again when you save."}</li>}
          {rows.map((r, k) => (
            <li key={k}>
              <button type="button" onClick={() => jump(r.offset)} className="flex w-full items-start gap-2.5 border-b px-4 py-2 text-left hover:bg-accent">
                {r.severity === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive-text" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />}
                <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{r.line ? `L${r.line}:${r.col}` : "—"}</span>
                <span className="min-w-0 flex-1 break-words">{r.message}</span>
              </button>
            </li>
          ))}
        </ul>}
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
          <span className="caps text-[11px] font-semibold">Graph</span>
          <span className="font-mono text-[11px] text-muted-foreground">{graph.nodes.length} nodes</span>
          {diff && (changes
            ? <span className="font-mono text-[11px]">{[diff.added.length && `${diff.added.length} new`, diff.changed.length + diff.rewritten.length && `${diff.changed.length + diff.rewritten.length} edited`, diff.removed.length && `${diff.removed.length} removed`, diff.moved.length && `${diff.moved.length} moved`, !diff.moved.length && rewired && `${rewired} ${rewired === 1 ? "connection" : "connections"} changed`].filter(Boolean).join(" · ")} <span className="text-muted-foreground">against {baseLabel ?? "the current revision"}</span></span>
            : <span className="font-mono text-[11px] text-muted-foreground">Same as {baseLabel ?? "the current revision"}</span>)}
          <span className="flex-1" />
          {!parsed.ok && good.current && <span className="caps text-[11px] text-warning-text">Showing the last JSON that parsed</span>}
        </div>
        <div className={cn("min-h-[360px] flex-1 overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] px-4 py-5 xl:h-[calc(100vh-330px)] xl:min-h-[480px]", !parsed.ok && "opacity-60")}>
          {graph.nodes.length ? (
            <WorkflowGraph graph={graph} marks={marks} label="The workflow's graph" minScale={0.55} onSelect={(hit) => {
              // A node's label is what selects it in the text: a container's whole span would select its body too.
              const s = parsed.ok ? parsed.spans.get(`${hit.path}/label`) ?? parsed.spans.get(hit.path) : undefined;
              if (s) jump(s.start, s.end);
            }} />
          ) : <p className="p-6 text-center font-mono text-[13px] text-muted-foreground">No root node to draw yet.</p>}
        </div>
        <div className="border-t px-4 py-2"><GraphLegend /></div>
      </div>
    </div>
  );
}
