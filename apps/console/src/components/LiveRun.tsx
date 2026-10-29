import { useEffect, useRef, useState } from "react";
import { RunDetail } from "@/components/RunDetail";
import { RunError } from "@/components/RunError";
import { type Capabilities, type Client, ClientError, follow } from "@/lib/client";
import { harnessSteers, NO_MESSAGES } from "@/lib/runState";
import type { ApiError, Run, RunFile, TimelineRow } from "@/lib/v2";

const asApiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: true });

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
  const toolResults = useRef(0);
  // The run's harness decides whether a message to a working run is a steer: until it is known, no message is offered.
  const [harness, setHarness] = useState<{ id: string | undefined } | null>(null);
  useEffect(() => { if (run && !harness) v2.agentHarness(run.agent_id).then((id) => setHarness({ id })).catch(() => setHarness({ id: undefined })); }, [run?.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    try {
      const [r, f] = await Promise.all([v2.getRun(runId), v2.listFiles(runId)]);
      setRun(r); setFiles(f.files);
    } catch (e) { setError(asApiError(e)); }
  };
  useEffect(() => { void refresh(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, runId, {
      signal: ctl.signal,
      // A tool round can write files while the run stays working: re-read them when a new tool result lands.
      onRows: (r) => { setRows(r); const n = r.filter((x) => x.kind === "tool_result").length; if (n > toolResults.current) { toolResults.current = n; void v2.listFiles(runId).then((f) => setFiles(f.files)).catch(() => {}); } },
      // A page names the run's status and state: when they move, the run record (result, error, cost) and files move too.
      onPage: (p) => { const s = `${p.status}/${p.state}`; if (s !== status.current) { status.current = s; void refresh(); } },
    }).catch((e) => { if (!ctl.signal.aborted) setError(asApiError(e)); });
    return () => ctl.abort();
  }, [runId, follows]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: "stop" | "cancel") => {
    setBusy(what);
    try { await v2[what](runId); setError(null); } catch (e) { setError(asApiError(e)); }
    setBusy(null); await refresh(); setFollows((n) => n + 1);
  };
  const message = async (text: string) => {
    let ok = true;
    try { await v2.sendMessage(runId, text, crypto.randomUUID()); setError(null); } catch (e) { setError(asApiError(e)); ok = false; }
    await refresh(); setFollows((n) => n + 1);
    return ok;
  };

  if (!run) return error ? <div className="p-8"><RunError title="The server refused the request" error={error} /></div> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the run...</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="border-b p-3"><RunError title="The server refused the request" error={error} /></div>}
      <RunDetail key={run.run_id} run={run} agentName={agentName(run.agent_id)} messages={(harness && caps?.features.messages) || NO_MESSAGES} harnessSteers={harnessSteers(harness?.id, caps?.harnesses ?? [])}
        rows={rows} files={files} readFile={(f) => v2.readFile(runId, f.path)} onMessage={message}
        actions={{ onStop: () => void act("stop"), onCancel: () => void act("cancel"), busy }} />
    </div>
  );
}
