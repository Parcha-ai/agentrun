import { ArrowLeft, CalendarClock, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import type { Agent } from "@/lib/agentForm";
import type { Client } from "@/lib/client";
import { runLabel, when } from "@/lib/format";
import { uuid } from "@/lib/idempotency";
import { type Problem, problem } from "@/lib/problem";
import type { Tone } from "@/lib/runState";
import { atLeast, bodyOf, capWords, utcWhen, type Draft, draftOf, emptyDraft, FIRING_LABEL, firingWords, instantOf, issuesOf, patchOf, whenWords } from "@/lib/schedules";
import type { Firing, Trigger } from "@/lib/v2";

/** Which schedules page: the list (no `schedule`), a new one (`schedule` null), one schedule, or its editor (`edit`). */
export type ScheduleView = { schedule?: string | null; edit?: boolean };
type PageProps = { v2: Client; go: (hash: string) => void; agentName: (id: string) => string };
/** `minEvery`: the shortest interval the server takes (capabilities' features.triggers.min_every_s), when it says. */
type FormProps = { v2: Client; go: (hash: string) => void; minEvery?: number };

const hashOf = (id: string) => `#/schedules/${encodeURIComponent(id)}`;
/** A time the server gave, as the console says every time: in the viewer's own zone. */
const at = (iso: string) => when(iso);
const TONE: Record<Firing["status"], Tone | "plain"> = { started: "success", skipped: "muted", missed: "warning", failed: "error", due: "active" };

/** Schedules (serve's trigger/1): each starts an agent's capped runs with no one there. */
/** `refreshMs`: how often an open schedule's page reads it again, so a firing shows as it happens (the list, twice that). */
export function SchedulesPage({ v2, view, go, agentName, minEvery, refreshMs = 15_000 }: PageProps & { view: ScheduleView; minEvery?: number; refreshMs?: number }) {
  if (view.schedule === undefined) return <ScheduleList v2={v2} go={go} agentName={agentName} every={refreshMs * 2} />;
  if (view.schedule === null) return <ScheduleForm v2={v2} go={go} minEvery={minEvery} />;
  if (view.edit) return <ScheduleEdit key={view.schedule} v2={v2} go={go} id={view.schedule} minEvery={minEvery} />;
  return <ScheduleDetail key={view.schedule} v2={v2} go={go} agentName={agentName} id={view.schedule} every={refreshMs} />;
}

/** `read` again every `every` ms while the tab shows, and once when it shows again; nothing while it is hidden (SWR's
 *  refreshInterval with refreshWhenHidden off). Stops when the page goes. */
function useRereads(read: () => void, every: number, deps: unknown[]) {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    const shown = () => document.visibilityState !== "hidden";
    const timer = setInterval(() => { if (shown()) latest.current(); }, every);
    const back = () => { if (shown()) latest.current(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", back); };
  }, [every, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** How a schedule's last firing went, or that it has not fired. */
const lastWords = (t: Trigger) => (t.last_firing ? `${firingWords(t.last_firing)} · ${at(t.last_firing.nominal_at)}` : "Not fired yet");

function ScheduleList({ v2, go, agentName, every }: PageProps & { every: number }) {
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  // Read now, and again while the page is open (one read at a time), so a schedule's firings show.
  const reading = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const read = () => {
    if (reading.current) return;
    reading.current = true;
    v2.listTriggers()
      .then((r) => { if (live.current) { setTriggers(r.triggers); setError(null); } }, (e) => { if (live.current) setError(problem(e, "the schedules")); })
      .finally(() => { reading.current = false; });
  };
  useEffect(read, [v2, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  useRereads(read, every, [v2]);
  return (
    <div className="p-5 md:p-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto font-mono text-2xl font-semibold">Schedules</h1>
        <Button size="lg" variant="solid" onClick={() => go("#/schedules/new")}><Plus aria-hidden /> New schedule</Button>
      </div>
      {error && !triggers ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
        : !triggers ? <ListSkeleton label="Loading the schedules" rows={4} />
        : !triggers.length ? <p className="border px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">No schedules yet. A schedule starts an agent's runs at the times you set, each one capped.</p>
        : (
          <ul className="border">
            {triggers.map((t) => (
              <li key={t.id} data-schedule={t.id} className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={hashOf(t.id)} className="min-w-0 break-words text-[15px] font-semibold hover:underline">{t.name}</a>
                    {!t.enabled && <Chip tone="muted">Paused</Chip>}
                  </div>
                  <p className="mt-1 break-words font-mono text-[12px] text-muted-foreground">{whenWords(t.source)} · {agentName(t.target.agent_id) || t.target.agent_id}</p>
                </div>
                <div className="min-w-0 font-mono text-[12px] text-muted-foreground md:text-right">
                  <p>{t.next_at ? `Next ${at(t.next_at)}` : "No next time"}</p>
                  <p className="mt-1 break-words">{lastWords(t)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      {triggers && error && <ProblemCard problem={error} className="mt-4" />}
    </div>
  );
}

function ScheduleDetail({ v2, go, agentName, id, every }: PageProps & { id: string; every: number }) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [firings, setFirings] = useState<Firing[]>([]);
  const [error, setError] = useState<Problem | null>(null);
  const [said, setSaid] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<"pause" | "fire" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tries, setTries] = useState(0);
  // A Run now out: a second click while it is waits for it, so a double click fires once.
  const firing = useRef(false);
  // One read of the schedule and its firings at a time.
  const reading = useRef(false);
  const read = () => {
    reading.current = true;
    return Promise.all([v2.getTrigger(id), v2.triggerFirings(id)])
      .then(([t, f]) => { setTrigger(t); setFirings(f.firings); setError(null); })
      .finally(() => { reading.current = false; });
  };
  useEffect(() => { read().catch((e) => setError(problem(e, "the schedule"))); }, [v2, id, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Read again while the page is open, so a timed firing, its run and the next time show with no reload; not while a
  // read or a Run now is out. A read that fails here leaves the page as it was.
  useRereads(() => { if (!reading.current && !firing.current) read().catch(() => {}); }, every, [v2, id]);
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} link={{ href: "#/schedules", label: "All schedules" }} /> : <ListSkeleton label="Loading the schedule" rows={4} />;

  const act = async (what: "pause" | "delete", work: () => Promise<unknown>, failed: string) => {
    setBusy(what); setSaid(null);
    try { await work(); } catch (e) { setSaid(problem(e, failed)); } finally { setBusy(null); }
  };
  const toggle = () => act("pause", async () => setTrigger(await v2.updateTrigger(id, { enabled: !trigger.enabled })), trigger.enabled ? "the pause" : "the resume");
  const remove = () => act("delete", async () => { await v2.deleteTrigger(id); go("#/schedules"); }, "the delete");
  const runNow = async () => {
    if (firing.current) return;
    firing.current = true; setBusy("fire"); setSaid(null);
    try {
      const made = await v2.fireTrigger(id, uuid());
      setFirings((all) => [made, ...all.filter((f) => f.key !== made.key)]);
      await read().catch(() => {});
    } catch (e) {
      setSaid(problem(e, "the run now"));
    } finally {
      firing.current = false; setBusy(null);
    }
  };
  const content = typeof trigger.target.input.content === "string" ? trigger.target.input.content : null;
  return (
    <div className="p-5 md:p-8">
      <a href="#/schedules" className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Schedules</a>
      <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-3 sm:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          <h1 className="flex flex-wrap items-center gap-2 break-words text-2xl font-semibold leading-tight">{trigger.name}{!trigger.enabled && <Chip tone="muted">Paused</Chip>}</h1>
          <p className="mt-2 break-words font-mono text-[12px] text-muted-foreground">{whenWords(trigger.source)} · {trigger.next_at ? `next ${at(trigger.next_at)}` : "no next time"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" onClick={() => void runNow()} disabled={busy === "fire"}><Zap aria-hidden /> {busy === "fire" ? "Starting" : "Run now"}</Button>
          <Button size="sm" onClick={() => void toggle()} disabled={busy !== null}>{trigger.enabled ? <><Pause aria-hidden /> Pause</> : <><Play aria-hidden /> Resume</>}</Button>
          <Button size="sm" onClick={() => go(`${hashOf(id)}/edit`)}><Pencil aria-hidden /> Edit</Button>
          {!confirming ? <Button size="sm" variant="destructive" onClick={() => setConfirming(true)} disabled={busy !== null}><Trash2 aria-hidden /> Delete</Button> : (
            <span className="flex items-center gap-2 border border-destructive/50 px-2 py-1 text-[12px]" role="alertdialog" aria-label="Delete this schedule?">
              <span>Delete for good? Its runs stay.</span>
              <Button size="sm" variant="destructive" onClick={() => { setConfirming(false); void remove(); }}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </span>
          )}
        </div>
      </div>
      {said && <ProblemCard problem={said} className="mt-4" />}
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border p-4 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="caps text-[11px] text-muted-foreground">Agent</dt><dd className="min-w-0 break-words"><a href={`#/agents/${encodeURIComponent(trigger.target.agent_id)}`} className="hover:underline">{agentName(trigger.target.agent_id) || trigger.target.agent_id}</a></dd>
        <dt className="caps text-[11px] text-muted-foreground">Each run is asked</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{content ?? JSON.stringify(trigger.target.input)}</dd>
        <dt className="caps text-[11px] text-muted-foreground">Cost cap</dt><dd className="font-mono">{capWords(trigger.target.max_cost_usd)}</dd>
        <dt className="caps text-[11px] text-muted-foreground">While a run is going</dt><dd>The next time is skipped.</dd>
      </dl>
      <section className="mt-6" aria-label="Firings">
        <h2 className="text-lg font-semibold">Firings</h2>
        {!firings.length ? <p className="mt-2 font-mono text-[12px] text-muted-foreground">Not fired yet.</p> : (
          <ul className="mt-3 border">
            {firings.map((f) => (
              <li key={f.key} data-firing={f.key} className="flex flex-col gap-1 border-b px-4 py-2.5 text-[13px] last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
                <span className="flex shrink-0 items-center gap-2"><Chip tone={TONE[f.status]}>{FIRING_LABEL[f.status]}</Chip><span className="font-mono text-[12px] text-muted-foreground">{at(f.nominal_at)}</span></span>
                <span className="min-w-0 flex-1 break-words">{f.status === "started" ? (f.by === "manual" ? "Run now" : "On schedule") : `${firingWords(f)}${f.by === "manual" ? " · Run now" : ""}`}</span>
                {f.run_id && <a href={`#/runs/${encodeURIComponent(f.run_id)}`} className="shrink-0 font-mono text-[12px] underline-offset-2 hover:underline">Run {runLabel(f.run_id)}</a>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScheduleEdit({ v2, go, id, minEvery }: FormProps & { id: string }) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => { v2.getTrigger(id).then(setTrigger, (e) => setError(problem(e, "the schedule"))); }, [v2, id, tries]);
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} /> : <ListSkeleton label="Loading the schedule" rows={4} />;
  return <ScheduleForm v2={v2} go={go} trigger={trigger} minEvery={minEvery} />;
}

/** One input with its label, its hint, and the issue under it (`data-issue`: the field the server names). */
function Field({ label, field, issue, hint, children }: { label: string; field: string; issue?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="block">
        <span className="caps text-[11px] text-muted-foreground">{label}</span>
        <span className="mt-1 block">{children}</span>
      </label>
      {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
      {issue && <p className="mt-1 text-[12px] text-destructive-text" role="alert" data-issue={field}>{issue}</p>}
    </div>
  );
}

const INPUT = "h-10 w-full border bg-background px-3 font-mono text-[13px]";
const ZONES: string[] = typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === "function" ? (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf("timeZone") : [];

/** Every agent, a page at a time, for the agent picker. */
async function allAgents(v2: Client): Promise<Agent[]> {
  const out: Agent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { agents: Agent[]; next_cursor: string | null } = await v2.listAgents({ cursor });
    out.push(...r.agents);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** A new schedule, or `trigger` to edit. A save the server refuses (422) says each issue under the field it names. */
function ScheduleForm({ v2, go, trigger, minEvery }: FormProps & { trigger?: Trigger }) {
  const [draft, setDraft] = useState<Draft>(() => (trigger ? draftOf(trigger) : emptyDraft()));
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { allAgents(v2).then(setAgents, () => setAgents([])); }, [v2]);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const shown = new Set(["name", "source.cron", "source.timezone", "source.at", "source.every_s", "source.start_at", "target.agent_id", "target.input", "target.max_cost_usd", ...(trigger ? [] : ["enabled"])]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = bodyOf(draft);
    setRest([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      if (!trigger) {
        const made = await v2.createTrigger(body);
        go(hashOf(made.id));
      } else {
        const patch = patchOf(trigger, body);
        if (Object.keys(patch).length) await v2.updateTrigger(trigger.id, patch);
        go(hashOf(trigger.id));
      }
    } catch (err) {
      const found = issuesOf(err);
      setIssues(Object.fromEntries(Object.entries(found.fields).filter(([k]) => shown.has(k))));
      setRest([...found.rest, ...Object.entries(found.fields).filter(([k]) => !shown.has(k)).map(([, v]) => v)]);
      setSaving(false);
    }
  };
  // An edit that changes when starts the schedule again from now (the server's rule for a new source): said before the save.
  const edited = trigger ? bodyOf(draft).body : undefined;
  const restarts = !!(trigger && edited && patchOf(trigger, edited).source);
  const atInstant = draft.kind === "at" ? instantOf(draft.at) : null;
  const live = (agents ?? []).filter((a) => !a.archived_at || a.agent_id === draft.agentId);
  const kinds: { kind: Draft["kind"]; label: string }[] = [{ kind: "cron", label: "Cron" }, { kind: "at", label: "Once" }, { kind: "every", label: "Every" }];
  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl p-5 md:p-8" noValidate>
      <a href={trigger ? hashOf(trigger.id) : "#/schedules"} className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> {trigger ? trigger.name : "Schedules"}</a>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><CalendarClock className="size-5 text-primary" aria-hidden />{trigger ? "Edit schedule" : "New schedule"}</h1>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-[13px] text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className="mt-5 space-y-5">
        <Field label="Name" field="name" issue={issues.name}><input name="name" className={INPUT} value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="nightly triage" /></Field>
        <fieldset className="min-w-0">
          <legend className="caps text-[11px] text-muted-foreground">When</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup">
            {kinds.map(({ kind, label }) => (
              <label key={kind} className={`flex h-9 cursor-pointer items-center gap-2 border px-3 text-[13px] ${draft.kind === kind ? "border-primary text-primary" : ""}`}>
                <input type="radio" name="kind" value={kind} checked={draft.kind === kind} onChange={() => set("kind")(kind)} className="accent-primary" />{label}
              </label>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {draft.kind === "cron" && <Field label="Cron line" field="source.cron" issue={issues["source.cron"]} hint="Minute, hour, day of month, month, day of week."><input name="cron" className={INPUT} value={draft.cron} onChange={(e) => set("cron")(e.target.value)} placeholder="30 1 * * *" /></Field>}
            {draft.kind === "at" && <Field label="At, your time" field="source.at" issue={issues["source.at"]} hint={atInstant ? `= ${utcWhen(atInstant)}` : undefined}><input name="at" type="datetime-local" step={1} className={INPUT} value={draft.at} onChange={(e) => set("at")(e.target.value)} /></Field>}
            {draft.kind === "every" && (
              <Field label="Every" field="source.every_s" issue={issues["source.every_s"]} hint={minEvery ? atLeast(minEvery) : undefined}>
                <span className="flex gap-2">
                  <input name="every" inputMode="decimal" className={INPUT} value={draft.every} onChange={(e) => set("every")(e.target.value)} placeholder="5" />
                  <select name="everyUnit" aria-label="Unit" className="h-10 border bg-background px-2 font-mono text-[13px]" value={draft.everyUnit} onChange={(e) => set("everyUnit")(e.target.value as Draft["everyUnit"])}>
                    <option value="seconds">seconds</option><option value="minutes">minutes</option><option value="hours">hours</option>
                  </select>
                </span>
              </Field>
            )}
            {draft.kind === "cron" && (
              <Field label="Time zone" field="source.timezone" issue={issues["source.timezone"]} hint="The zone the cron line runs in.">
                <input name="timezone" list="schedule-zones" className={INPUT} value={draft.timezone} onChange={(e) => set("timezone")(e.target.value)} />
              </Field>
            )}
            {draft.kind === "every" && <Field label="Starting, your time (optional)" field="source.start_at" issue={issues["source.start_at"]} hint={draft.startAt && instantOf(draft.startAt) ? `= ${utcWhen(instantOf(draft.startAt)!)}` : undefined}><input name="startAt" type="datetime-local" step={1} className={INPUT} value={draft.startAt} onChange={(e) => set("startAt")(e.target.value)} /></Field>}
          </div>
          {ZONES.length > 0 && <datalist id="schedule-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>}
          {restarts && <p className="mt-3 text-[12px] text-warning-text" role="note">Changing when restarts the schedule from now.</p>}
        </fieldset>
        <Field label="Agent" field="target.agent_id" issue={issues["target.agent_id"]}>
          <select name="agent" className={INPUT} value={draft.agentId} onChange={(e) => set("agentId")(e.target.value)}>
            <option value="">{agents ? "Pick an agent" : "Loading the agents"}</option>
            {live.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.definition.name || a.agent_id}{a.kind === "workflow" ? " (workflow)" : ""}</option>)}
            {draft.agentId && agents && !live.some((a) => a.agent_id === draft.agentId) && <option value={draft.agentId}>{draft.agentId}</option>}
          </select>
        </Field>
        <Field label="Each run is asked" field="target.input" issue={issues["target.input"]}><textarea name="content" rows={4} className="w-full border bg-background p-3 text-[13px]" value={draft.content} onChange={(e) => set("content")(e.target.value)} /></Field>
        <Field label="Cost cap, US dollars a run" field="target.max_cost_usd" issue={issues["target.max_cost_usd"]} hint="Required: each run this schedule starts stops at this spend.">
          <input name="maxCost" inputMode="decimal" className={`${INPUT} max-w-40`} value={draft.maxCost} onChange={(e) => set("maxCost")(e.target.value)} placeholder="2" />
        </Field>
        {!trigger && (
          <div>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="enabled" checked={draft.enabled} onChange={(e) => set("enabled")(e.target.checked)} className="accent-primary" /> On from now (off: made paused)</label>
            {issues.enabled && <p className="mt-1 text-[12px] text-destructive-text" role="alert" data-issue="enabled">{issues.enabled}</p>}
          </div>
        )}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Saving" : trigger ? "Save changes" : "Create schedule"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go(trigger ? hashOf(trigger.id) : "#/schedules")}>Cancel</Button>
      </div>
    </form>
  );
}
