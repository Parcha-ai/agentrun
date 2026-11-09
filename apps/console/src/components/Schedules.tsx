import { ArrowLeft, CalendarClock, Copy, GitPullRequest, KeyRound, Pause, Pencil, Play, Plus, Trash2, Webhook, Zap } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { runLabel, when } from "@/lib/format";
import { keeper, uuid } from "@/lib/idempotency";
import { type Problem, problem } from "@/lib/problem";
import type { Tone } from "@/lib/runState";
import { atLeast, bodyOf, capOf, dollars, acceptWords, emptyGitHub, FIRED_BY, GITHUB_EVENTS, githubBodyOf, type GitHubDraft, githubWhen, type GitHubTrigger, isGitHubTrigger, HOOK_URL_HINT, hookUrlOf, hookWhen, isScheduleTrigger, isWebhookTrigger, SIGNATURE_WORDS, utcWhen, type Draft, draftOf, type Schedule, type WebhookTrigger, emptyDraft, FIRING_LABEL, firingWords, instantKept, issuesOf, patchOf, whenWords, emptyWebhook, type WebhookDraft, webhookBodyOf } from "@/lib/schedules";
import type { Firing, Trigger, TriggerCreate, TriggerMade } from "@/lib/v2";

/** Which triggers page: the list (no `trigger`), a new one (`trigger` null, of `kind`), one trigger, or a schedule's editor
 *  (`edit`). */
export type ScheduleView = { trigger?: string | null; kind?: "schedule" | "webhook" | "github"; edit?: boolean };
type PageProps = { v2: Client; go: (hash: string) => void; agentName: (id: string) => string };
/** `minEvery`: the shortest interval the server takes (capabilities' features.triggers.min_every_s), when it says. */
type FormProps = { v2: Client; go: (hash: string) => void; minEvery?: number };

const hashOf = (id: string) => `#/triggers/${encodeURIComponent(id)}`;
/** A time the server gave, as the console says every time: in the viewer's own zone. */
const at = (iso: string) => when(iso);
const TONE: Record<Firing["status"], Tone | "plain"> = { started: "success", sent: "success", skipped: "muted", missed: "warning", failed: "error", due: "active" };

/** Triggers (serve's trigger/1): schedules and webhooks, each starting an agent's capped runs with no one there. */
/** `refreshMs`: how often an open trigger's page reads it again, so a firing shows as it happens (the list, twice that). */
export function SchedulesPage({ v2, view, go, agentName, minEvery, refreshMs = 15_000 }: PageProps & { view: ScheduleView; minEvery?: number; refreshMs?: number }) {
  if (view.trigger === undefined) return <ScheduleList v2={v2} go={go} agentName={agentName} every={refreshMs * 2} />;
  if (view.trigger === null) return view.kind === "webhook" ? <WebhookForm v2={v2} go={go} /> : view.kind === "github" ? <GitHubForm v2={v2} go={go} /> : <ScheduleForm v2={v2} go={go} minEvery={minEvery} />;
  if (view.edit) return <ScheduleEdit key={view.trigger} v2={v2} go={go} id={view.trigger} minEvery={minEvery} />;
  return <ScheduleDetail key={view.trigger} v2={v2} go={go} agentName={agentName} id={view.trigger} every={refreshMs} />;
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
      .then((r) => { if (live.current) { setTriggers(r.triggers); setError(null); } }, (e) => { if (live.current) setError(problem(e, "the triggers")); })
      .finally(() => { reading.current = false; });
  };
  useEffect(read, [v2, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  useRereads(read, every, [v2]);
  return (
    <div className="p-5 md:p-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto font-mono text-2xl font-semibold">Triggers</h1>
        <Button size="lg" onClick={() => go("#/triggers/new-github")}><GitPullRequest aria-hidden /> New GitHub trigger</Button>
        <Button size="lg" onClick={() => go("#/triggers/new-webhook")}><Webhook aria-hidden /> New webhook</Button>
        <Button size="lg" variant="solid" onClick={() => go("#/triggers/new")}><Plus aria-hidden /> New schedule</Button>
      </div>
      {error && !triggers ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
        : !triggers ? <ListSkeleton label="Loading the triggers" rows={4} />
        : !triggers.length ? <p className="border px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">No triggers yet. A schedule starts an agent's runs at the times you set; a webhook starts one on each signed request. Each run is capped.</p>
        : (
          <ul className="border">
            {triggers.map((t) => (
              <li key={t.id} data-trigger={t.id} className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={hashOf(t.id)} className="min-w-0 break-words text-[15px] font-semibold hover:underline">{t.name}</a>
                    <Chip>{KIND_WORDS[t.source.kind]}</Chip>
                    {!t.enabled && <Chip tone="muted">Paused</Chip>}
                  </div>
                  <p className="mt-1 break-words font-mono text-[12px] text-muted-foreground">{whatWords(t, agentName)}</p>
                </div>
                <div className="min-w-0 font-mono text-[12px] text-muted-foreground md:text-right">
                  {t.source.kind === "schedule" && <p>{t.next_at ? `Next ${at(t.next_at)}` : "No next time"}</p>}
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

/** A trigger's when and what, in one line: a schedule's times or a webhook's signed requests, then the agent it starts or
 *  the run it messages. */
const KIND_WORDS: Record<Trigger["source"]["kind"], string> = { schedule: "Schedule", webhook: "Webhook", github: "GitHub" };

function whatWords(t: Trigger, agentName: (id: string) => string): string {
  const when = t.source.kind === "schedule" ? whenWords(t.source) : t.source.kind === "github" ? githubWhen(t.source) : hookWhen(t.source);
  return `${when} · ${t.target.kind === "start_run" ? agentName(t.target.agent_id) || t.target.agent_id : `messages run ${runLabel(t.target.run_id)}`}`;
}

/** A trigger this page doesn't open (one that sends its firings to a run), opened by its address: what it is, and nothing
 *  to change it. */
function NotASchedule() {
  return (
    <div className="p-5 md:p-8">
      <a href="#/triggers" className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
      <p className="mt-4 border px-4 py-6 text-[13px] text-muted-foreground">This trigger sends its firings to a run: this page doesn't open it yet.</p>
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
  // A webhook's Rotate secret: asked first (the old secret stops signing at once), then the new one shown that once.
  const [rotating, setRotating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  // A rotation out: its own flag, not `busy` (a Run now that ends first clears that), so a second rotation never goes out
  // while the first is, and an older answer never shows a secret the newer one already revoked.
  const rotateOut = useRef(false);
  const [renewing, setRenewing] = useState(false);
  const [tries, setTries] = useState(0);
  // A Run now out: a second click while it is waits for it, so a double click fires once.
  const firing = useRef(false);
  // One read of the schedule and its firings at a time.
  const reading = useRef(false);
  // Moves on when an action (Pause, Resume, Run now) starts and when its answer lands: a read applies its answer only if
  // no action moved it since the read was asked, so an older answer never replaces a newer one.
  const generation = useRef(0);
  const read = () => {
    reading.current = true;
    const asked = generation.current;
    return Promise.all([v2.getTrigger(id), v2.triggerFirings(id)])
      .then(([t, f]) => { if (asked === generation.current) { setTrigger(t); setFirings(f.firings); setError(null); } })
      .finally(() => { reading.current = false; });
  };
  useEffect(() => { read().catch((e) => setError(problem(e, "the trigger"))); }, [v2, id, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Read again while the page is open, so a timed firing, its run and the next time show with no reload; not while a
  // read or a Run now is out. A read that fails here leaves the page as it was.
  useRereads(() => { if (!reading.current && !firing.current) read().catch(() => {}); }, every, [v2, id]);
  // A schedule with no cap of its own runs under its agent's default (definition.max_cost_usd): read it to say so.
  const [agentCap, setAgentCap] = useState<number | undefined>(undefined);
  const capAgent = trigger && trigger.target.kind === "start_run" && typeof trigger.target.max_cost_usd !== "number" ? trigger.target.agent_id : null;
  useEffect(() => {
    if (!capAgent) return;
    let live = true;
    v2.getAgent(capAgent).then((r) => { if (live) setAgentCap(typeof r.agent.definition.max_cost_usd === "number" ? r.agent.definition.max_cost_usd : undefined); }, () => {});
    return () => { live = false; };
  }, [v2, capAgent]);
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} link={{ href: "#/triggers", label: "All triggers" }} /> : <ListSkeleton label="Loading the trigger" rows={4} />;
  const hook = isWebhookTrigger(trigger) ? trigger : null;
  // A GitHub trigger: its events, its firings, Pause/Resume (a Disconnect turns it off) and Delete; no URL or secret.
  const gh = isGitHubTrigger(trigger) ? trigger : null;
  if (!hook && !gh && !isScheduleTrigger(trigger)) return <NotASchedule />;
  const runs = trigger as Schedule | WebhookTrigger | GitHubTrigger;

  const act = async (what: "pause" | "delete", work: () => Promise<unknown>, failed: string) => {
    setBusy(what); setSaid(null);
    try { await work(); } catch (e) { setSaid(problem(e, failed)); } finally { setBusy(null); }
  };
  const toggle = () => act("pause", async () => {
    generation.current++;
    const answer = await v2.updateTrigger(id, { enabled: !trigger.enabled });
    generation.current++;
    setTrigger(answer);
  }, trigger.enabled ? "the pause" : "the resume");
  const remove = () => act("delete", async () => { await v2.deleteTrigger(id); go("#/triggers"); }, "the delete");
  const rotate = async () => {
    if (rotateOut.current) return;
    rotateOut.current = true; setRenewing(true); setSaid(null); setFresh(null);
    try { setFresh((await v2.rotateTriggerSecret(id)).secret); } catch (e) { setSaid(problem(e, "the new secret")); } finally { rotateOut.current = false; setRenewing(false); }
  };
  const runNow = async () => {
    if (firing.current) return;
    firing.current = true; setBusy("fire"); setSaid(null);
    generation.current++;
    try {
      const made = await v2.fireTrigger(id, uuid());
      generation.current++;
      setFirings((all) => [made, ...all.filter((f) => f.key !== made.key)]);
      await read().catch(() => {});
    } catch (e) {
      setSaid(problem(e, "the run now"));
    } finally {
      firing.current = false; setBusy(null);
    }
  };
  const content = typeof runs.target.input.content === "string" ? runs.target.input.content : null;
  return (
    <div className="p-5 md:p-8">
      <a href="#/triggers" className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
      <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-3 sm:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          <h1 className="flex flex-wrap items-center gap-2 break-words text-2xl font-semibold leading-tight">{trigger.name}{!trigger.enabled && <Chip tone="muted">Paused</Chip>}</h1>
          <p className="mt-2 break-words font-mono text-[12px] text-muted-foreground">{hook ? `Webhook · ${hookWhen(hook.source)}` : gh ? `GitHub · ${githubWhen(gh.source)}` : `${whenWords(runs.source as Schedule["source"])} · ${trigger.next_at ? `next ${at(trigger.next_at)}` : "no next time"}`}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" onClick={() => void runNow()} disabled={busy === "fire"}><Zap aria-hidden /> {busy === "fire" ? "Starting" : "Run now"}</Button>
          <Button size="sm" onClick={() => void toggle()} disabled={busy !== null}>{trigger.enabled ? <><Pause aria-hidden /> Pause</> : <><Play aria-hidden /> Resume</>}</Button>
          {!hook && !gh && <Button size="sm" onClick={() => go(`${hashOf(id)}/edit`)}><Pencil aria-hidden /> Edit</Button>}
          {hook && (!rotating ? <Button size="sm" onClick={() => setRotating(true)} disabled={busy !== null || renewing}><KeyRound aria-hidden /> Rotate secret</Button> : (
            <span className="flex items-center gap-2 border border-warning/50 px-2 py-1 text-[12px]" role="alertdialog" aria-label="Make a new secret?">
              <span>The old secret stops signing at once.</span>
              <Button size="sm" variant="solid" onClick={() => { setRotating(false); void rotate(); }}>Yes, make a new one</Button>
              <Button size="sm" variant="ghost" onClick={() => setRotating(false)}>Keep</Button>
            </span>
          ))}
          {!confirming ? <Button size="sm" variant="destructive" onClick={() => setConfirming(true)} disabled={busy !== null}><Trash2 aria-hidden /> Delete</Button> : (
            <span className="flex items-center gap-2 border border-destructive/50 px-2 py-1 text-[12px]" role="alertdialog" aria-label="Delete this trigger?">
              <span>Delete for good? Its runs stay.</span>
              <Button size="sm" variant="destructive" onClick={() => { setConfirming(false); void remove(); }}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </span>
          )}
        </div>
      </div>
      {said && <ProblemCard problem={said} className="mt-4" />}
      {hook && fresh && <SecretOnce label="The webhook's new secret" secret={fresh} />}
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border p-4 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="caps text-[11px] text-muted-foreground">Agent</dt><dd className="min-w-0 break-words"><a href={`#/agents/${encodeURIComponent(runs.target.agent_id)}`} className="hover:underline">{agentName(runs.target.agent_id) || runs.target.agent_id}</a></dd>
        <dt className="caps text-[11px] text-muted-foreground">Each run is asked</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{content ?? JSON.stringify(runs.target.input)}</dd>
        <dt className="caps text-[11px] text-muted-foreground">Cost cap</dt><dd className="font-mono">{capOf(runs.target.max_cost_usd, agentCap)}</dd>
        {hook ? <>
          <dt className="caps text-[11px] text-muted-foreground">URL</dt><dd className="flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all font-mono text-[12px]">{hookUrlOf(hook)}</code><CopyButton text={hookUrlOf(hook)} label="Copy URL" /><span className="basis-full text-[12px] text-muted-foreground">{HOOK_URL_HINT}</span></dd>
          <dt className="caps text-[11px] text-muted-foreground">Signature</dt><dd>{SIGNATURE_WORDS[hook.source.signature ?? "standard"]}</dd>
          <dt className="caps text-[11px] text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words">{hook.source.accept?.length ? <ul className="space-y-1 font-mono text-[12px]">{hook.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul> : "Every signed request"}</dd>
        </> : gh ? <>
          <dt className="caps text-[11px] text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words"><ul className="space-y-1 font-mono text-[12px]">{gh.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul><p className="mt-1 text-[12px] text-muted-foreground">From this server's GitHub App (Settings → GitHub).</p></dd>
        </> : <>
          <dt className="caps text-[11px] text-muted-foreground">While a run is going</dt><dd>The next time is skipped.</dd>
        </>}
      </dl>
      <section className="mt-6" aria-label="Firings">
        <h2 className="text-lg font-semibold">Firings</h2>
        {!firings.length ? <p className="mt-2 font-mono text-[12px] text-muted-foreground">Not fired yet.</p> : (
          <ul className="mt-3 border">
            {firings.map((f) => (
              <li key={f.key} data-firing={f.key} className="flex flex-col gap-1 border-b px-4 py-2.5 text-[13px] last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
                <span className="flex shrink-0 items-center gap-2"><Chip tone={TONE[f.status]}>{FIRING_LABEL[f.status]}</Chip><span className="font-mono text-[12px] text-muted-foreground">{at(f.nominal_at)}</span></span>
                <span className="min-w-0 flex-1 break-words">{f.status === "started" ? FIRED_BY[f.by] : `${firingWords(f)}${f.by === "manual" ? " · Run now" : ""}`}</span>
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
  useEffect(() => { v2.getTrigger(id).then(setTrigger, (e) => setError(problem(e, "the trigger"))); }, [v2, id, tries]);
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} /> : <ListSkeleton label="Loading the schedule" rows={4} />;
  // Never an editor for another kind of trigger: its save would rebuild it as a schedule that starts runs.
  if (!isScheduleTrigger(trigger)) return <NotASchedule />;
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
function ScheduleForm({ v2, go, trigger, minEvery }: FormProps & { trigger?: Schedule }) {
  const [draft, setDraft] = useState<Draft>(() => (trigger ? draftOf(trigger) : emptyDraft()));
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // A create sent again unchanged (a lost answer, a second click) reuses its Idempotency-Key and makes one schedule; an
  // edited one gets a new key.
  const keys = useRef(keeper()).current;
  useEffect(() => { allAgents(v2).then(setAgents, () => setAgents([])); }, [v2]);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const shown = new Set(["name", "source.cron", "source.timezone", "source.at", "source.every_s", "source.start_at", "target.agent_id", "target.input", "target.max_cost_usd", ...(trigger ? [] : ["enabled"])]);
  // The picked agent's default cap per run (definition.max_cost_usd): with one, the schedule's own cap may be left empty
  // and each run takes the agent's. An edited schedule that already ran under its agent's default keeps it so too.
  const agentCapRaw = (agents ?? []).find((a) => a.agent_id === draft.agentId)?.definition.max_cost_usd;
  const agentCap = typeof agentCapRaw === "number" && agentCapRaw > 0 ? agentCapRaw : undefined;
  const capOptional = agentCap !== undefined || (!!trigger && typeof trigger.target.max_cost_usd !== "number" && draft.agentId === trigger.target.agent_id);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = bodyOf(draft, capOptional);
    setRest([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      if (!trigger) {
        const made = await v2.createTrigger(body as TriggerCreate, keys.keyFor("createTrigger", body));
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
  const edited = trigger ? bodyOf(draft, capOptional).body : undefined;
  const restarts = !!(trigger && edited && patchOf(trigger, edited).source);
  // The instants the hints say: the ones the save sends (a time left alone keeps the instant it was read with).
  const atInstant = draft.kind === "at" ? instantKept(draft.at, draft.read?.at) : null;
  const startInstant = draft.startAt ? instantKept(draft.startAt, draft.read?.startAt) : null;
  const live = (agents ?? []).filter((a) => !a.archived_at || a.agent_id === draft.agentId);
  const kinds: { kind: Draft["kind"]; label: string }[] = [{ kind: "cron", label: "Cron" }, { kind: "at", label: "Once" }, { kind: "every", label: "Every" }];
  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl p-5 md:p-8" noValidate>
      <a href={trigger ? hashOf(trigger.id) : "#/triggers"} className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> {trigger ? trigger.name : "Triggers"}</a>
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
            {draft.kind === "every" && <Field label="Starting, your time (optional)" field="source.start_at" issue={issues["source.start_at"]} hint={startInstant ? `= ${utcWhen(startInstant)}` : undefined}><input name="startAt" type="datetime-local" step={1} className={INPUT} value={draft.startAt} onChange={(e) => set("startAt")(e.target.value)} /></Field>}
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
        <Field label="Cost cap, US dollars a run" field="target.max_cost_usd" issue={issues["target.max_cost_usd"]}
          hint={agentCap !== undefined ? `Uses the agent's default (${dollars(agentCap)}) if empty.` : capOptional ? "Uses the agent's default if empty." : "Required: each run this schedule starts stops at this spend."}>
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
        <Button type="button" size="lg" variant="ghost" onClick={() => go(trigger ? hashOf(trigger.id) : "#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}

/** Writes `text` to the clipboard and says Copied beside it. The clipboard needs a secure page: with none, or a write
 *  the browser refuses, it says to select the text instead. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const manual = "The browser won't copy here. Select it and copy it.";
  const copy = () => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip?.writeText) { setSaid(manual); return; }
    clip.writeText(text).then(() => setSaid("Copied"), () => setSaid(manual));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" onClick={copy}><Copy aria-hidden /> {label}</Button>
      {said && <span className="font-mono text-[11px] text-muted-foreground" role="status">{said}</span>}
    </span>
  );
}

/** A signing secret, shown this once (the server keeps it sealed and never sends it again), with Copy. */
export function SecretOnce({ label, secret, url }: { label: string; secret: string; url?: string }) {
  return (
    <section aria-label={label} className="mt-4 space-y-3 border border-primary/50 p-4 text-[13px]">
      {url && <Copyable title="URL" text={url} label="Copy URL" hint={HOOK_URL_HINT} />}
      <Copyable title="Signing secret" text={secret} label="Copy secret" />
      <p className="text-warning-text" role="note">You won't see this secret again.</p>
    </section>
  );
}

function Copyable({ title, text, label, hint }: { title: string; text: string; label: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <span className="caps text-[11px] text-muted-foreground">{title}</span>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all border bg-muted/40 px-2 py-1 font-mono text-[12px]">{text}</code><CopyButton text={text} label={label} /></div>
      {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const SIGNATURES: ("standard" | "github")[] = ["standard", "github"];

/** A new webhook trigger: each signed request to its URL starts a capped run of the agent. The create's answer carries
 *  its signing secret that once (or, on a retry under the same Idempotency-Key, a note in its place): shown with the URL,
 *  each with Copy, until Done opens the trigger. */
function WebhookForm({ v2, go }: { v2: Client; go: (hash: string) => void }) {
  const [draft, setDraft] = useState<WebhookDraft>(emptyWebhook);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [made, setMade] = useState<TriggerMade | null>(null);
  // A create sent again unchanged reuses its Idempotency-Key (one webhook, its secret's note on the retry); an edited one
  // gets a new key.
  const keys = useRef(keeper()).current;
  useEffect(() => { allAgents(v2).then(setAgents, () => setAgents([])); }, [v2]);
  const set = <K extends keyof WebhookDraft>(k: K) => (value: WebhookDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const shown = new Set(["name", "source.signature", "target.agent_id", "target.input", "target.max_cost_usd"]);
  const agentCapRaw = (agents ?? []).find((a) => a.agent_id === draft.agentId)?.definition.max_cost_usd;
  const agentCap = typeof agentCapRaw === "number" && agentCapRaw > 0 ? agentCapRaw : undefined;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = webhookBodyOf(draft, agentCap !== undefined);
    setRest([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      setMade(await v2.createTrigger(body, keys.keyFor("createTrigger", body)));
    } catch (err) {
      const found = issuesOf(err);
      setIssues(Object.fromEntries(Object.entries(found.fields).filter(([k]) => shown.has(k))));
      setRest([...found.rest, ...Object.entries(found.fields).filter(([k]) => !shown.has(k)).map(([, v]) => v)]);
    } finally {
      setSaving(false);
    }
  };
  const back = <a href="#/triggers" className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>;
  if (made) {
    return (
      <div className="max-w-2xl p-5 md:p-8">
        {back}
        <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Webhook className="size-5 text-primary" aria-hidden />{made.name}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">Send each request to this URL, signed with this secret ({SIGNATURE_WORDS[made.source.kind === "webhook" ? made.source.signature ?? "standard" : "standard"]}). Each one starts a run.</p>
        {made.secret ? <SecretOnce label="The webhook's URL and secret" url={hookUrlOf(made)} secret={made.secret} /> : (
          <section aria-label="The webhook's URL and secret" className="mt-4 space-y-3 border p-4 text-[13px]">
            <Copyable title="URL" text={hookUrlOf(made)} label="Copy URL" hint={HOOK_URL_HINT} />
            {made.note && <p role="note">{made.note}</p>}
          </section>
        )}
        <div className="mt-6"><Button type="button" size="lg" variant="solid" onClick={() => go(hashOf(made.id))}>Done</Button></div>
      </div>
    );
  }
  const live = (agents ?? []).filter((a) => !a.archived_at);
  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl p-5 md:p-8" noValidate>
      {back}
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Webhook className="size-5 text-primary" aria-hidden />New webhook</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">Each signed request to its URL starts a capped run of the agent. Its URL and signing secret show once it is made.</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-[13px] text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className="mt-5 space-y-5">
        <Field label="Name" field="name" issue={issues.name}><input name="name" className={INPUT} value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="on deploy" /></Field>
        <fieldset className="min-w-0">
          <legend className="caps text-[11px] text-muted-foreground">Signature</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup">
            {SIGNATURES.map((sig) => (
              <label key={sig} className={`flex h-9 cursor-pointer items-center gap-2 border px-3 text-[13px] ${draft.signature === sig ? "border-primary text-primary" : ""}`}>
                <input type="radio" name="signature" value={sig} checked={draft.signature === sig} onChange={() => set("signature")(sig)} className="accent-primary" />{SIGNATURE_WORDS[sig]}
              </label>
            ))}
          </div>
          {issues["source.signature"] && <p className="mt-1 text-[12px] text-destructive-text" role="alert" data-issue="source.signature">{issues["source.signature"]}</p>}
        </fieldset>
        <Field label="Agent" field="target.agent_id" issue={issues["target.agent_id"]}>
          <select name="agent" className={INPUT} value={draft.agentId} onChange={(e) => set("agentId")(e.target.value)}>
            <option value="">{agents ? "Pick an agent" : "Loading the agents"}</option>
            {live.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.definition.name || a.agent_id}{a.kind === "workflow" ? " (workflow)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Each run is asked" field="target.input" issue={issues["target.input"]}><textarea name="content" rows={4} className="w-full border bg-background p-3 text-[13px]" value={draft.content} onChange={(e) => set("content")(e.target.value)} /></Field>
        <Field label="Cost cap, US dollars a run" field="target.max_cost_usd" issue={issues["target.max_cost_usd"]}
          hint={agentCap !== undefined ? `Uses the agent's default (${dollars(agentCap)}) if empty.` : "Required: each run this webhook starts stops at this spend."}>
          <input name="maxCost" inputMode="decimal" className={`${INPUT} max-w-40`} value={draft.maxCost} onChange={(e) => set("maxCost")(e.target.value)} placeholder="1" />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Creating" : "Create webhook"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go("#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}

/** A new GitHub trigger: the events it takes from this server's GitHub App, then the agent each one starts a capped run of.
 *  Offered only while GitHub is connected (GET /v2/integrations/github answers the App); with none (a 404, or an answer
 *  naming no App) the page says to connect it first. It has no URL or secret of its own: the App's one hook delivers its events. */
function GitHubForm({ v2, go }: { v2: Client; go: (hash: string) => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [readError, setReadError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const [draft, setDraft] = useState<GitHubDraft>(emptyGitHub);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // A create sent again unchanged reuses its Idempotency-Key; an edited one gets a new key.
  const keys = useRef(keeper()).current;
  // Whether the form is still open: a create that answers after the person left it (Cancel, the back link, the sidebar)
  // opens nothing.
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    setReadError(null);
    // Connected is a 200 that names the App (its app_id); a 404, or a 200 with no App in it, is not.
    v2.githubConnection().then((c) => { if (live) setConnected(!!c && "app_id" in c && !!c.app_id); }, (e) => {
      if (!live) return;
      if (e instanceof ClientError && e.status === 404) setConnected(false);
      else setReadError(problem(e, "GitHub's connection"));
    });
    return () => { live = false; };
  }, [v2, tries]);
  useEffect(() => { allAgents(v2).then(setAgents, () => setAgents([])); }, [v2]);
  const set = <K extends keyof GitHubDraft>(k: K) => (value: GitHubDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const toggle = (key: string) => setDraft((d) => ({ ...d, events: d.events.includes(key) ? d.events.filter((e) => e !== key) : [...d.events, key] }));
  const shown = new Set(["name", "source.accept", "target.agent_id", "target.input", "target.max_cost_usd"]);
  const agentCapRaw = (agents ?? []).find((a) => a.agent_id === draft.agentId)?.definition.max_cost_usd;
  const agentCap = typeof agentCapRaw === "number" && agentCapRaw > 0 ? agentCapRaw : undefined;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = githubBodyOf(draft, agentCap !== undefined);
    setRest([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      const made = await v2.createTrigger(body, keys.keyFor("createTrigger", body));
      if (open.current) go(hashOf(made.id));
    } catch (err) {
      const found = issuesOf(err);
      setIssues(Object.fromEntries(Object.entries(found.fields).filter(([k]) => shown.has(k))));
      setRest([...found.rest, ...Object.entries(found.fields).filter(([k]) => !shown.has(k)).map(([, v]) => v)]);
      setSaving(false);
    }
  };
  const back = <a href="#/triggers" className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>;
  const title = <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><GitPullRequest className="size-5 text-primary" aria-hidden />New GitHub trigger</h1>;
  if (readError) return <div className="max-w-2xl p-5 md:p-8">{back}{title}<ProblemCard problem={readError} onRetry={() => setTries((n) => n + 1)} className="mt-4" /></div>;
  if (connected === null) return <ListSkeleton label="Reading GitHub's connection" rows={3} />;
  if (!connected) {
    return (
      <div className="max-w-2xl p-5 md:p-8">
        {back}{title}
        <p className="mt-4 border px-4 py-6 text-[13px]">
          Connect GitHub first: <a href="#/settings/github" className="underline underline-offset-2">Settings → GitHub</a>. A GitHub trigger takes events from this server's GitHub App.
        </p>
      </div>
    );
  }
  const live = (agents ?? []).filter((a) => !a.archived_at);
  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl p-5 md:p-8" noValidate>
      {back}{title}
      <p className="mt-2 text-[13px] text-muted-foreground">Each event it takes from this server's GitHub App starts a capped run of the agent.</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-[13px] text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className="mt-5 space-y-5">
        <Field label="Name" field="name" issue={issues.name}><input name="name" className={INPUT} value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="review PRs" /></Field>
        <fieldset className="min-w-0">
          <legend className="caps text-[11px] text-muted-foreground">Events</legend>
          <div className="mt-1 space-y-1">
            {GITHUB_EVENTS.map(({ event, action, label }) => {
              const key = `${event}:${action}`;
              return (
                <label key={key} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" name="event" value={key} checked={draft.events.includes(key)} onChange={() => toggle(key)} className="accent-primary" />
                  {label} <span className="font-mono text-[11px] text-muted-foreground">{event} {action}</span>
                </label>
              );
            })}
          </div>
          {issues["source.accept"] && <p className="mt-1 text-[12px] text-destructive-text" role="alert" data-issue="source.accept">{issues["source.accept"]}</p>}
        </fieldset>
        <Field label="Agent" field="target.agent_id" issue={issues["target.agent_id"]}>
          <select name="agent" className={INPUT} value={draft.agentId} onChange={(e) => set("agentId")(e.target.value)}>
            <option value="">{agents ? "Pick an agent" : "Loading the agents"}</option>
            {live.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.definition.name || a.agent_id}{a.kind === "workflow" ? " (workflow)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Each run is asked" field="target.input" issue={issues["target.input"]} hint="The event's payload comes with it."><textarea name="content" rows={4} className="w-full border bg-background p-3 text-[13px]" value={draft.content} onChange={(e) => set("content")(e.target.value)} /></Field>
        <Field label="Cost cap, US dollars a run" field="target.max_cost_usd" issue={issues["target.max_cost_usd"]}
          hint={agentCap !== undefined ? `Uses the agent's default (${dollars(agentCap)}) if empty.` : "Required: each run this trigger starts stops at this spend."}>
          <input name="maxCost" inputMode="decimal" className={`${INPUT} max-w-40`} value={draft.maxCost} onChange={(e) => set("maxCost")(e.target.value)} placeholder="1" />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Creating" : "Create GitHub trigger"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go("#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}
