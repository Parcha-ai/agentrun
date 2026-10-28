import { useEffect, useRef, useState } from "react";
import { RunDetail } from "@/components/RunDetail";
import { RunError } from "@/components/RunError";
import { type Capabilities, type Client, ClientError, follow } from "@/lib/client";
import { NO_MESSAGES } from "@/lib/runState";
import type { ApiError, Run, RunFile, TimelineRow } from "@/lib/v2";

/** A run from the live server: its record, its timeline followed from the cursor, its files, and stop, cancel and
 *  messages. A write's acceptance is not its effect: the page shows what the run and its timeline say afterwards. */
export function LiveRun({ v2, runId, caps, agentName }: { v2: Client; runId: string; caps: Capabilities | null; agentName: (id: string) => string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [files, setFiles] = useState<RunFile[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"stop" | "cancel" | null>(null);
  const [follows, setFollows] = useState(0);
  const status = useRef<string>("");

  const refresh = async () => {
    try {
      const [r, f] = await Promise.all([v2.getRun(runId), v2.listFiles(runId)]);
      setRun(r); setFiles(f.files);
    } catch (e) { setError(e instanceof ClientError ? e.toApiError() : { code: "network", message: String(e), retryable: true }); }
  };
  useEffect(() => { void refresh(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, runId, {
      signal: ctl.signal,
      onRows: setRows,
      // A page names the run's status and state: when they move, the run record (result, error, cost) and files move too.
      onPage: (p) => { const s = `${p.status}/${p.state}`; if (s !== status.current) { status.current = s; void refresh(); } },
    }).catch((e) => { if (!ctl.signal.aborted) setError(e instanceof ClientError ? e.toApiError() : { code: "network", message: String(e), retryable: true }); });
    return () => ctl.abort();
  }, [runId, follows]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: "stop" | "cancel") => {
    setBusy(what);
    try { await v2[what](runId); } catch (e) { if (e instanceof ClientError) setError(e.toApiError()); }
    setBusy(null); await refresh(); setFollows((n) => n + 1);
  };
  const message = async (text: string) => {
    try { await v2.sendMessage(runId, text, crypto.randomUUID()); } catch (e) { if (e instanceof ClientError) setError(e.toApiError()); }
    await refresh(); setFollows((n) => n + 1);
  };

  if (!run) return error ? <div className="p-8"><RunError title="The server refused the request" error={error} /></div> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the run...</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="border-b p-3"><RunError title="The server refused the request" error={error} /></div>}
      <RunDetail key={run.run_id} run={run} agentName={agentName(run.agent_id)} messages={caps?.features.messages ?? NO_MESSAGES}
        rows={rows} files={files} readFile={(f) => v2.readFile(runId, f.path)} onMessage={message}
        actions={{ onStop: () => void act("stop"), onCancel: () => void act("cancel"), busy }} />
    </div>
  );
}
