import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Chip } from "@/components/ui/chip";
import { Picker } from "@/components/ui/picker";
import { ClientError, type Client } from "@/lib/client";
import { parseCsv } from "@/lib/csv";
import { dollars } from "@/lib/format";
import { BATCH_ROWS_MAX, DEFAULT_CAP_USD, PATH_WORDS, running, stopWords } from "@/lib/learningBatch";
import type { LearningBatch } from "@/lib/v2";

// Learn from a CSV, on the agent's Learning tab: a file of rows, the column or columns to give the agent and the one that holds
// the reference answer, a cap, and Learn. The server runs the agent on each row in order with learning on and tells it the
// reference after each answer (POST /v2/agents/{id}/learning/batches); this page only starts it, cancels it and reads it. The
// batch is the server's, so a reload reads the same numbers. When it ends, the tab's results are read again (`onFinished`).

/** How often a running batch is read. */
const POLL_MS = 2000;

export function LearnFromCsv({ v2, agentId, onFinished, pollMs = POLL_MS }: { v2: Client; agentId: string; onFinished?: () => void; pollMs?: number }) {
  const [batch, setBatch] = useState<LearningBatch | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(false);
  const [again, setAgain] = useState(0);
  const seenRunning = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  // The latest batch of the agent, read at once and while it runs.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (id?: string) => {
      try {
        const at = id ?? (await v2.learningBatches(agentId)).batches[0]?.id;
        const b = at ? await v2.learningBatch(agentId, at) : null;
        if (!live) return;
        setBatch(b); setError(null);
        if (b && running(b)) { seenRunning.current = true; timer = setTimeout(() => void read(b.id), pollMs); }
        else if (b && seenRunning.current) { seenRunning.current = false; finished.current?.(); }
      } catch (e) {
        if (!live) return;
        setError(e ?? new Error("unknown"));
        // Every failed read is read again (a first one too: the feature is never hidden for the visit by one bad read).
        timer = setTimeout(() => void read(id), pollMs * 2);
      }
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [v2, agentId, pollMs, again]);

  if (batch === undefined && !error) return <Bone className="h-24 w-full" />;
  if (batch === undefined)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-mono text-small text-muted-foreground" role="status">Learn from a CSV is not available right now: {error instanceof Error ? error.message : String(error)}.</p>
        <Button size="sm" variant="outline" onClick={() => { setError(null); setAgain((n) => n + 1); }}>Read again</Button>
      </div>
    );
  const now = batch && running(batch);
  return (
    <section className="space-y-4" aria-label="Learn from a CSV">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="caps text-small font-semibold">Learn from a CSV</h2>
        {!now && !form && <Button size="sm" onClick={() => setForm(true)}>{batch ? "Learn from another CSV" : "Learn from a CSV"}</Button>}
      </div>
      {!!error && <p className="font-mono text-small text-warning-text" role="status">The batch was not read again: {error instanceof Error ? error.message : String(error)}. Trying again.</p>}
      {form && !now && <Upload v2={v2} agentId={agentId} onStarted={(b) => { seenRunning.current = true; setBatch(b); setForm(false); setAgain((n) => n + 1); }} onCancel={() => setForm(false)} />}
      {batch && !form && <Progress v2={v2} agentId={agentId} batch={batch} onBatch={setBatch} />}
      {!batch && !form && <p className="max-w-prose text-body text-muted-foreground">Give it rows you already have answers for. It runs on each in order, learning as it goes, and is told the right answer after each one.</p>}
    </section>
  );
}

/** The file, the columns, the cap and Learn. */
function Upload({ v2, agentId, onStarted, onCancel }: { v2: Client; agentId: string; onStarted: (b: LearningBatch) => void; onCancel: () => void }) {
  const [file, setFile] = useState<{ name: string; columns: string[]; rows: Record<string, string>[] } | null>(null);
  const [problemText, setProblemText] = useState<string | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [cap, setCap] = useState(String(DEFAULT_CAP_USD));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRefused(null);
    const parsed = parseCsv(await f.text());
    if ("error" in parsed) { setFile(null); setProblemText(parsed.error); return; }
    setProblemText(parsed.rows.length > BATCH_ROWS_MAX ? `A batch takes at most ${BATCH_ROWS_MAX} rows: this file has ${parsed.rows.length}.` : null);
    setFile({ name: f.name, columns: parsed.columns, rows: parsed.rows });
    const last = parsed.columns.at(-1)!;
    setAnswer(last); setInputs(parsed.columns.filter((c) => c !== last));
  };
  const capUsd = Number(cap);
  const ready = !!file && !problemText && inputs.length > 0 && !!answer && !inputs.includes(answer) && Number.isFinite(capUsd) && capUsd > 0;
  const learn = async () => {
    if (!file || !ready) return;
    setBusy(true); setRefused(null);
    try {
      onStarted(await v2.startLearningBatch(agentId, { inputs, answer, rows: file.rows, max_cost_usd: capUsd }));
    } catch (e) {
      setRefused(e instanceof ClientError ? (e.fields?.[0]?.message ?? e.message) : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 border bg-card p-4">
      <Field label="CSV file" note="A header line, then one row for each thing to learn from. The file is read here; its rows go to the server.">
        <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e)} aria-label="CSV file" className="block w-full font-mono text-body file:mr-3 file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:font-mono" />
      </Field>
      {problemText && <p className="font-mono text-small text-destructive-text" role="alert">{problemText}</p>}
      {file && !("error" in file) && (
        <>
          <p className="font-mono text-small text-muted-foreground">{file.name}: {file.rows.length} rows, {file.columns.length} columns</p>
          <Field label="The agent is given" group note="The columns each run reads. The answer column is never one of them.">
            <div className="grid gap-2 sm:grid-cols-2">
              {file.columns.map((c) => (
                <Checkbox key={c} label={c} checked={inputs.includes(c)} disabled={c === answer}
                  onChange={(e) => setInputs((xs) => (e.target.checked ? file.columns.filter((x) => xs.includes(x) || x === c) : xs.filter((x) => x !== c)))} />
              ))}
            </div>
          </Field>
          <Field label="The answer column" note="What the agent is told after each answer: the reference it should have given.">
            <Picker label="The answer column" value={answer} onChange={(v) => { setAnswer(v); setInputs((xs) => xs.filter((x) => x !== v)); }} options={file.columns.map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Cap, in dollars" note="Caps what the runs spend (each run, its look-back and its review). A row starts only when what is left covers it. Grades are counted in the cost but not capped." hint={ready ? `Up to ${dollars(capUsd)} for ${file.rows.length} rows.` : undefined}>
            <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="max-w-40" aria-label="Cap, in dollars" />
          </Field>
          <Preview columns={[...inputs, answer].filter(Boolean)} rows={file.rows.slice(0, 3)} />
        </>
      )}
      {refused && <p className="font-mono text-small text-destructive-text" role="alert">{refused}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void learn()}>{busy ? "Starting" : "Learn"}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

/** The first rows as they will be read: the chosen columns. */
function Preview({ columns, rows }: { columns: string[]; rows: Record<string, string>[] }) {
  return (
    <div className="overflow-x-auto" aria-label="The first rows">
      <table className="w-full border-collapse font-mono text-small">
        <thead><tr>{columns.map((c) => <th key={c} className="caps border-b px-2 py-1 text-left font-semibold">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} className="max-w-64 truncate border-b px-2 py-1">{r[c]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const TONE = { running: "active", completed: "success", cancelled: "muted", stopped: "warning" } as const;

/** A batch's progress: rows done of the total, right or wrong, what it learned, what it cost and the path each run took. */
function Progress({ v2, agentId, batch: b, onBatch }: { v2: Client; agentId: string; batch: LearningBatch; onBatch: (b: LearningBatch) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const cancel = async () => {
    setBusy(true); setFailed(null);
    try { onBatch(await v2.cancelLearningBatch(agentId, b.id)); } catch (e) { setFailed(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const stop = stopWords(b);
  const cost = b.cost_usd === null ? "unknown" : dollars(b.cost_usd);
  return (
    <div className="space-y-4 border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><Chip tone={TONE[b.status]}>{b.status}</Chip><span className="font-mono text-body">{b.finished} of {b.total} rows</span></div>
        {running(b) && <Button size="sm" variant="destructive" disabled={busy} onClick={() => void cancel()}>Cancel</Button>}
      </div>
      <div className="h-2 w-full bg-muted" role="progressbar" aria-label="Rows done" aria-valuemin={0} aria-valuemax={b.total} aria-valuenow={b.finished}>
        <div className="h-full bg-primary" style={{ width: `${b.total ? (b.finished / b.total) * 100 : 0}%` }} />
      </div>
      {stop && <Banner tone="warning">{stop}</Banner>}
      {b.status === "completed" && <Banner tone="success">Every row ran. The results are below.</Banner>}
      {failed && <p className="font-mono text-small text-destructive-text" role="alert">{failed}</p>}
      <dl className="grid grid-cols-2 gap-3 font-mono text-body sm:grid-cols-4">
        <Fig label="Right" value={`${b.right}`} />
        <Fig label="Wrong" value={`${b.wrong}`} />
        <Fig label="Failed" value={`${b.failed}`} />
        <Fig label="Cost so far" value={`${cost} of ${dollars(b.max_cost_usd)}`} />
        <Fig label="Notes learned" value={`${b.lessons.notes.length}`} />
        <Fig label="Skills learned" value={`${b.lessons.skills.length}`} />
        <Fig label="Workflow revisions" value={`${b.revisions.length}`} />
        <Fig label="Paths" value={`${b.paths.agent} by hand, ${b.paths.handed_back} handed back, ${b.paths.workflow} workflow`} />
      </dl>
      {(b.lessons.notes.length + b.lessons.skills.length + b.lessons.workflows.length > 0) && (
        <p className="text-body text-muted-foreground">Learned: {[...b.lessons.notes, ...b.lessons.skills.map((s) => `${s} (skill)`), ...b.lessons.workflows.map((w) => `${w} (workflow)`)].join(", ")}.</p>
      )}
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse font-mono text-small">
          <thead><tr>{["Row", "Result", "Path", "Cost", "Answer", "Reference"].map((h) => <th key={h} className="caps sticky top-0 border-b bg-card px-2 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {b.rows.map((r) => (
              <tr key={r.n} aria-current={b.current === r.n ? "step" : undefined}>
                <td className="border-b px-2 py-1">{r.n}</td>
                <td className="border-b px-2 py-1">{r.state === "done" ? <Chip tone={r.right ? "success" : "error"}>{r.right ? "right" : "wrong"}</Chip> : r.state === "failed" ? <Chip tone="error" title={r.error}>failed</Chip> : <Chip tone={r.state === "running" ? "active" : "muted"}>{r.state === "running" ? "running" : "waiting"}</Chip>}</td>
                <td className="border-b px-2 py-1">{r.path ? PATH_WORDS[r.path] : ""}</td>
                <td className="border-b px-2 py-1">{r.total_usd == null ? "" : dollars(r.total_usd)}</td>
                <td className="max-w-48 truncate border-b px-2 py-1" title={r.answer ?? undefined}>{r.answer ?? ""}</td>
                <td className="max-w-48 truncate border-b px-2 py-1" title={r.reference}>{r.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Fig = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0"><dt className="caps text-micro text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>
);
