import { FileText } from "lucide-react";
import { useState } from "react";
import { RunError } from "@/components/RunError";
import { RunGraphView } from "@/components/RunGraphView";
import { RunResult } from "@/components/RunResult";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { CopyButton } from "@/components/ui/copy-button";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import { bytes, cost, runEnded, when } from "@/lib/format";
import { Redactions } from "@/lib/redaction";
import type { RunGraph } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import type { ApiError, Run, RunFile } from "@/lib/v2";
import { publishCommand, type Omitted, type ShareBundle } from "./bundle";
import { CutsPanel } from "./CutsPanel";

/** The owner's preview: the run the bundle is of (for the publish command), what a switch asks for, and whether an
 *  export is being made again (the page then offers no command: the one it shows would be the bundle being replaced). */
export type SharePreview = { runId: string; onToggle: (id: string, restore: boolean) => void; pending: boolean };

type View = "report" | "timeline" | "graph" | "files";

/** A file the bundle left out, in words. */
const omittedWords = (o: Omitted): string => {
  if (o.what === "recordings") return "Recordings and screenshots are never shared.";
  if (o.what === "files") return "The run's file list was cut at its cap: the files past it are not in the bundle.";
  const why: Record<string, string> = { binary: "binary: no scrubber reads it", too_large: "over 256 KiB", over_total: "past the 4 MiB the files may take", over_count: "past 200 files", unreadable: "could not be read" };
  return `${o.path}: ${why[o.why] ?? o.why}`;
};

/** A share of one run, drawn from its `agentrun.share/1` bundle and nothing else: its header, its Report, Timeline, a
 *  workflow's Graph and its files as text, as the run page draws them. With `preview` (the owner's, on their own server)
 *  the cuts panel and the footer with the publish command; without, the page a share host shows. */
export function ShareView({ bundle, preview }: { bundle: ShareBundle; preview?: SharePreview }) {
  const { run } = bundle;
  // The run page's components read a served run; the bundle's run is its allowlist of one, and they read no field it
  // drops (the run's id, agent and links are not drawn here).
  const served = run as unknown as Run;
  const files: RunFile[] = bundle.files.map((f) => ({ path: f.path, size_bytes: f.bytes }) as RunFile);
  const [view, setView] = useState<View>("report");
  const [open, setOpen] = useState<string | null>(null);
  const showFile = (path: string) => { setOpen(path); setView("files"); };
  const tabs = [
    { id: "report" as const, label: "Report" },
    { id: "timeline" as const, label: `Timeline (${bundle.rows.length})` },
    ...(bundle.graph ? [{ id: "graph" as const, label: "Graph" }] : []),
    { id: "files" as const, label: `Files (${bundle.files.length})` },
  ];
  const ended = runEnded(run.status);
  const facts = [
    bundle.agent.name || "An agent",
    run.kind === "workflow" ? "Workflow" : null,
    run.created_at ? `${when(run.created_at)}${run.ended_at ? ` to ${when(run.ended_at)}` : ""}` : null,
    run.cost ? cost(run.cost, { ended }) : null,
    run.imported_from?.source ? `Imported from ${run.imported_from.source}` : null,
  ].filter(Boolean);
  // The header, the views and the footer share one column: wider in the preview, which has the cuts beside the views.
  const width = preview ? "max-w-6xl" : "max-w-4xl";
  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b">
        <div className={cn("mx-auto px-5 py-4 md:px-8", width)}>
          <p className="caps text-label text-muted-foreground">{preview ? "AgentRun · share preview" : "AgentRun · shared run"}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words text-2xl font-semibold"><Redactions text={run.title || "Untitled run"} /></h1>
            <StatusBadge run={served} />
          </div>
          <p className="mt-1 font-mono text-small text-muted-foreground">{facts.map((fact, i) => <span key={i}>{i ? " · " : ""}<Redactions text={fact!} /></span>)}</p>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <div className={cn("mx-auto flex flex-col gap-8 py-6 lg:flex-row", width)}>
          <div className="min-w-0 flex-1">
            <Tabs id="share" tabs={tabs} value={view} onChange={setView} label="The run's views" />
            <div {...tabPanelProps("share", view)} className="space-y-6 px-5 py-6 md:px-8">
              {view === "report" && (
                <>
                  {run.status === "failed" && run.error && <RunError error={run.error as ApiError} />}
                  {run.review && <section className="border border-warning/50 bg-warning/10 p-4" aria-label="Needs review"><p className="caps text-label text-warning-text">Needs review</p><p className="mt-2 text-lead"><Redactions text={run.review.reason} /></p></section>}
                  <RunResult run={served} rows={bundle.rows} files={files} onOpen={(f) => showFile(f.path)} shared />
                </>
              )}
              {view === "timeline" && <Timeline rows={bundle.rows} live={false} ended files={files} onOpen={(f) => showFile(f.path)} shared />}
              {view === "graph" && bundle.graph && (
                <div className="-mx-5 border-y md:-mx-8">
                  {/* Files are in the bundle as text, never served: the graph links none. */}
                  <RunGraphView data={bundle.graph as RunGraph} fileUrl={() => ""} offline />
                </div>
              )}
              {view === "files" && <Files bundle={bundle} open={open} onOpen={setOpen} />}
            </div>
          </div>
          {preview && (
            <aside className="w-full shrink-0 px-5 md:px-8 lg:w-[360px] lg:pl-0">
              <CutsPanel bundle={bundle} onToggle={preview.onToggle} pending={preview.pending} />
            </aside>
          )}
        </div>
      </main>
      {preview && <ShareFooter bundle={bundle} preview={preview} width={width} />}
    </div>
  );
}

/** The run's files as the bundle carries them: each opens here as text, never as a page; then what was left out. */
function Files({ bundle, open, onOpen }: { bundle: ShareBundle; open: string | null; onOpen: (path: string) => void }) {
  const file = bundle.files.find((f) => f.path === open);
  return (
    <div className="space-y-6">
      {bundle.files.length ? (
        <ul className="divide-y border bg-card">
          {bundle.files.map((f) => (
            <li key={f.path}>
              <button type="button" className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent", f.path === open && "bg-primary/[0.06] text-primary")} onClick={() => onOpen(f.path)} aria-pressed={f.path === open}>
                <FileText className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-small">{f.path}</span>
                <span className="font-mono text-label text-muted-foreground tabular-nums">{bytes(f.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-body text-muted-foreground">The bundle carries no files.</p>}
      {file && (
        <section aria-label={file.path}>
          <p className="caps mb-2 text-label text-muted-foreground">{file.path}</p>
          <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words border bg-card p-4 font-mono text-small leading-[1.7]"><Redactions text={file.content} /></pre>
        </section>
      )}
      {bundle.omitted.length > 0 && (
        <section>
          <p className="caps mb-2 text-label text-muted-foreground">Left out of the bundle</p>
          <ul className="space-y-1 font-mono text-small text-muted-foreground">
            {bundle.omitted.map((o, i) => <li key={i}>{omittedWords(o)}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

/** What the preview promises, the bundle's digest, and the command that publishes exactly it. */
function ShareFooter({ bundle, preview, width }: { bundle: ShareBundle; preview: SharePreview; width: string }) {
  const command = publishCommand(preview.runId, bundle);
  return (
    <footer className="shrink-0 border-t bg-card">
      <div className={cn("mx-auto space-y-2 px-5 py-3 md:px-8", width)}>
        <p className="text-body font-semibold">Nothing was sent. This is the exact page a share host would show.</p>
        <p className="font-mono text-label text-muted-foreground">sha256 <span className="break-all text-foreground">{bundle.sha256}</span></p>
        {preview.pending
          ? <p className="font-mono text-small text-muted-foreground" role="status">Exporting again with your restores…</p>
          : (
            <div className="flex flex-wrap items-center gap-3">
              <code className="min-w-0 flex-1 break-all border bg-background px-3 py-2 font-mono text-small">{command}</code>
              <CopyButton text={command} label="Copy" />
            </div>
          )}
        <p className="text-label text-muted-foreground max-sm:hidden">Publishing comes with a share host in a later beta. The command checks a fresh export against this sha256 and refuses if the run changed.</p>
      </div>
    </footer>
  );
}
