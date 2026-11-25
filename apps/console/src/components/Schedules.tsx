import { agentHash } from "@/components/AgentPage";
import { ArrowLeft, Blocks, CalendarClock, GitPullRequest, KeyRound, Mail, Pause, Pencil, Play, Plus, Rss, Trash2, Webhook, Zap } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AcceptEditor, ConditionList, EVENT_HINTS, Said } from "@/components/AcceptEditor";
import { FieldInput, FieldIssues } from "@/components/FieldInput";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Field as UiField, formColumnsClass, Input, Textarea } from "@/components/ui/field";
import type { Agent } from "@/lib/agentForm";
import { agentsByName } from "@/lib/agents";
import { Picker } from "@/components/ui/picker";
import { SearchPicker } from "@/components/ui/search-picker";
import { ScheduleWhen } from "@/components/ScheduleWhen";
import { askCue, UnattendedWarning, useAskingTools } from "@/components/UnattendedWarning";
import { ZonePicker } from "@/components/ZonePicker";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { type AgentInput, agentInputOf, type FieldSpec, fieldIssueWords, fieldLabel, fieldOfIssue, fieldStartText, fieldValid } from "@/lib/inputForm";
import { paramHelp } from "@/lib/templatePackages";
import { httpHref } from "@/lib/safeUrl";
import { markdown, runLabel, when } from "@/lib/format";
import { keeper, uuid } from "@/lib/idempotency";
import { type Problem, problem } from "@/lib/problem";
import type { Tone } from "@/lib/runState";
import { ACCEPT_LIMITS, acceptFields, emptyRule, type RuleDraft, ruleDraftOf } from "@/lib/accept";
import { agentCapOf, inputText, atLeast, bodyOf, capOf, type CapRule, CONNECTED_NO_CAP, disabledWords, dollars, acceptWords, onceState, type OnceState, emptyGitHub, FIRED_BY, GITHUB_EVENT_NAMES, GITHUB_EVENTS, githubBodyOf, type GitHubDraft, type GitHubPicks, githubPicksOf, githubRulesOf, githubSourceOf, githubWhen, emailWhen, feedWhen, composioWhen, type ComposioDraft, type ComposioTrigger, composioBodyOf, composioSourceOf, type ConfigField, configFieldsOf, emptyComposio, isComposioTrigger, type GitHubTrigger, isGitHubTrigger, HOOK_URL_HINT, hookUrlOf, hookWhen, isScheduleTrigger, isWebhookTrigger, same, SIGNATURE_WORDS, utcWhen, type Draft, draftOf, type Schedule, type WebhookTrigger, emptyDraft, FIRING_LABEL, firingWords, instantKept, issuesOf, patchOf, pastWords, scheduleLine, emptyWebhook, type WebhookDraft, webhookBodyOf, webhookSourceOf, type FeedDraft, type FeedTrigger, type InputDraft, emptyFeed, feedBodyOf, feedDraftOf, feedFields, feedSourceOf, feedUrlsOf, FEED_EVERY_S, isFeedTrigger, type EmailTrigger, isEmailTrigger, type EmailDraft, emptyEmail, emailBodyOf, EMAIL_FIELDS, MAX_FEEDS, span, TRIGGER_KINDS } from "@/lib/schedules";
import type { ComposioEvent, ComposioTriggers, Firing, Trigger, TriggerCreate, TriggerMade } from "@/lib/v2";
import type { McpServer } from "@/lib/mcp";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

/** Which triggers page: the list (no `trigger`), a new one (`trigger` null, of `kind`), one trigger, or its editor
 *  (`edit`: a schedule's whole, a webhook's or GitHub trigger's filter, a feed trigger's feeds). */
export type ScheduleView = { trigger?: string | null; kind?: "schedule" | "webhook" | "github" | "composio" | "feed" | "email"; edit?: boolean };
type PageProps = { v2: Client; go: (hash: string) => void; agentName: (id: string) => string };
/** `minEvery`: the shortest interval the server takes (capabilities' features.triggers.min_every_s), when it says. */
/** `now`: the page's clock, for whether a one-time schedule's picked time is still ahead. */
type FormProps = { v2: Client; go: (hash: string) => void; minEvery?: number; now?: () => number };

const hashOf = (id: string) => `#/triggers/${encodeURIComponent(id)}`;
/** A time the server gave, as the console says every time: in the viewer's own zone. */
const at = (iso: string) => when(iso);
const TONE: Record<Firing["status"], Tone | "plain"> = { started: "success", sent: "success", skipped: "muted", missed: "warning", failed: "error", due: "active" };

/** Triggers (serve's trigger/1): schedules and webhooks, each starting an agent's capped runs with no one there. */
/** `refreshMs`: how often an open trigger's page reads it again, so a firing shows as it happens (the list, twice that). */
/** `now`: the page's clock, for whether a one-time schedule's time has passed. */
export function SchedulesPage({ v2, view, go, agentName, minEvery, failuresToPause, publicUrl, refreshMs = 15_000, now = Date.now }: PageProps & { view: ScheduleView; minEvery?: number; failuresToPause?: number; publicUrl?: boolean; refreshMs?: number; now?: () => number }) {
  // Composio reaches an app trigger at this server's public address: with none (capabilities say false), New app trigger
  // stays in sight but off, with the line that says how to give one. Unknown (an older server) leaves it on.
  const noAddress = publicUrl === false;
  if (view.trigger === undefined) return <ScheduleList v2={v2} go={go} agentName={agentName} every={refreshMs * 2} now={now} failuresToPause={failuresToPause} noAddress={noAddress} />;
  if (view.trigger === null) return view.kind === "webhook" ? <WebhookForm v2={v2} go={go} /> : view.kind === "github" ? <GitHubForm v2={v2} go={go} /> : view.kind === "composio" ? <ComposioForm v2={v2} go={go} noAddress={noAddress} /> : view.kind === "feed" ? <FeedForm v2={v2} go={go} minEvery={minEvery} /> : view.kind === "email" ? <EmailForm v2={v2} go={go} minEvery={minEvery} /> : <ScheduleForm v2={v2} go={go} minEvery={minEvery} now={now} />;
  if (view.edit) return <ScheduleEdit key={view.trigger} v2={v2} go={go} id={view.trigger} minEvery={minEvery} now={now} />;
  return <ScheduleDetail key={view.trigger} v2={v2} go={go} agentName={agentName} id={view.trigger} every={refreshMs} now={now} failuresToPause={failuresToPause} />;
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

/** A passed one time in words: "Done · ran <when>", or "Its time passed · <when>" with no run known to have started. */
const onceWords = (state: OnceState): string | null => (!state ? null : "ran" in state ? `Done · ran ${at(state.ran.nominal_at)}` : `Its time passed · ${at(state.passed)}`);

/** The server's refusal of a one time already passed (serve's trigger-schedule.ts), whatever time it names. */
const PAST_REFUSAL = /has already passed\.?$/;

/** A trigger that is off: "Turned off" when the server turned it off itself (a failure streak, a source it can't read),
 *  "Paused" when a person did. */
function OffChip({ trigger }: { trigger: Trigger }) {
  return trigger.disabled ? <Chip tone="warning">Turned off</Chip> : <Chip tone="muted">Paused</Chip>;
}

/** How a schedule's last firing went, or that it has not fired. */
const lastWords = (t: Trigger) => (t.last_firing ? `${firingWords(t.last_firing)}${t.last_firing.catch_up ? " · caught up late" : ""} · ${at(t.last_firing.nominal_at)}` : "Not fired yet");

/** A polled trigger's last check (a feed's): whether it read, its words, and when. */
const checkWords = (c: NonNullable<Trigger["last_check"]>) => `${c.ok ? "Checked" : "Check failed"} ${at(c.at)}: ${c.message}`;

/** The words under New app trigger when the server has no public address. */
export const NO_ADDRESS_LINE = "App triggers need this server's public address: set AGENTRUN_PUBLIC_URL and restart.";

function ScheduleList({ v2, go, agentName, every, now, failuresToPause, noAddress }: PageProps & { every: number; now: () => number; failuresToPause?: number; noAddress: boolean }) {
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
  // Each row's agent, read once, for the tools of it that ask: such a row says so, as its trigger's page does.
  const startsOf = (t: Trigger) => (t.target.kind === "start_run" ? t.target.agent_id : null);
  const { asks, outcome } = useAskingTools(v2, (triggers ?? []).flatMap((t) => startsOf(t) ?? []));
  return (
    // The page's frame is every list page's (Agents, Runs): a header bar with the place's icon and name in caps
    // and its actions at the right, the main one last, then the content in a pane of its own, so the bar stays.
    <section className="flex h-full min-h-0 flex-col" aria-label="Triggers">
      <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-3 px-5")}>
        <h1 className={pageTitleClass}><CalendarClock className="size-4" aria-hidden />Triggers</h1>
        {/* With no trigger yet the panel below offers each kind, with what it is for: the page says each once. */}
        {!(triggers && !triggers.length) && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" disabled={noAddress} onClick={() => go("#/triggers/new-composio")}><Blocks aria-hidden /> New app trigger</Button>
            <Button size="sm" onClick={() => go("#/triggers/new-github")}><GitPullRequest aria-hidden /> New GitHub trigger</Button>
            <Button size="sm" onClick={() => go("#/triggers/new-webhook")}><Webhook aria-hidden /> New webhook</Button>
            <Button size="sm" onClick={() => go("#/triggers/new-feed")}><Rss aria-hidden /> New feed trigger</Button>
            <Button size="sm" onClick={() => go("#/triggers/new-email")}><Mail aria-hidden /> New email trigger</Button>
            <Button size="sm" variant="primary" onClick={() => go("#/triggers/new")}><Plus aria-hidden /> New schedule</Button>
          </div>
        )}
      </header>
      {/* The content starts where the header's name does (px-5). */}
      <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-5 py-5 md:py-6">
      {noAddress && triggers && triggers.length > 0 && <p className="mb-4 text-small text-muted-foreground">{NO_ADDRESS_LINE}</p>}
      {error && !triggers ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
        : !triggers ? <ListSkeleton label="Loading the triggers" rows={4} />
        : !triggers.length ? <FirstTrigger go={go} noAddress={noAddress} />
        : (
          <ul className="border">
            {triggers.map((t) => (
              <li key={t.id} data-trigger={t.id} className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={hashOf(t.id)} className="min-w-0 break-words text-prose font-semibold hover:underline">{t.name}</a>
                    <Chip>{TRIGGER_KINDS[t.source.kind].label}</Chip>
                    {!t.enabled && !onceState(t, now()) && <OffChip trigger={t} />}
                  </div>
                  <p className="mt-1 break-words font-mono text-small text-muted-foreground" title={cronOf(t)}>{whatWords(t, agentName, now())}</p>
                  {disabledWords(t, failuresToPause) && <p className="mt-1 break-words text-small text-warning-text">{disabledWords(t, failuresToPause)}</p>}
                  {asks[startsOf(t) ?? ""] && <p data-asks="" className="mt-1 break-words text-small text-warning-text">{askCue(asks[startsOf(t)!]!, outcome)}</p>}
                </div>
                <div className="min-w-0 font-mono text-small text-muted-foreground md:text-right">
                  <p className="break-words">{lastWords(t)}</p>
                  {t.last_check && <p data-last-check={t.last_check.ok ? "ok" : "failed"} className={`mt-1 break-words ${t.last_check.ok ? "" : "text-warning-text"}`}>{checkWords(t.last_check)}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      {triggers && error && <ProblemCard problem={error} className="mt-4" />}
      </div>
      </div>
    </section>
  );
}


/** A server with no trigger yet: what a trigger is, and each kind of thing that can start a run, with its own way in.
 *  These stand in for the page's buttons, which show once there is a trigger. A card says what its kind does
 *  (TRIGGER_KINDS) and, where one is needed, what to save first. */
function FirstTrigger({ go, noAddress }: { go: (hash: string) => void; noAddress: boolean }) {
  const card = (kind: Trigger["source"]["kind"], first = "") => `${TRIGGER_KINDS[kind].what}${first ? ` ${first}` : ""}`;
  const kinds = [
    { Icon: CalendarClock, name: "Schedule", what: card("schedule"), action: "New schedule", to: "#/triggers/new" },
    { Icon: Webhook, name: "Webhook", what: card("webhook"), action: "New webhook", to: "#/triggers/new-webhook" },
    { Icon: GitPullRequest, name: "GitHub", what: card("github", "Connect GitHub in Settings first."), action: "New GitHub trigger", to: "#/triggers/new-github" },
    { Icon: Blocks, name: "From an app", what: card("composio", "Save the server in Settings first."), action: "New app trigger", to: "#/triggers/new-composio" },
    { Icon: Rss, name: "Feed", what: card("feed"), action: "New feed trigger", to: "#/triggers/new-feed" },
    { Icon: Mail, name: "Email", what: card("email", "Save the account in Settings → Email first."), action: "New email trigger", to: "#/triggers/new-email" },
  ];
  return (
    // No frame of its own: its words start at the page's left edge, under the header's, and its cards are its only
    // boxes. Each kind is a peer, so none is the main action: each button is the default one.
    <section aria-labelledby="first-trigger">
      <p className="caps text-label text-muted-foreground">No triggers yet</p>
      <h2 id="first-trigger" className="mt-2 text-xl font-semibold">Start runs without being here</h2>
      <p className="mt-1 max-w-prose text-lead text-muted-foreground">A trigger starts a run of an agent for you, and each run it starts stops at a spend cap. Pick what should start it.</p>
      <ul className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {kinds.map(({ Icon, name, what, action, to }) => (
          <li key={name} className="flex flex-col border bg-background p-4">
            <p className="flex items-center gap-2 text-prose font-semibold"><Icon className="size-4 text-muted-foreground" aria-hidden />{name}</p>
            <p className="mt-2 flex-1 text-lead leading-relaxed text-muted-foreground">{what}</p>
            {noAddress && to === "#/triggers/new-composio" && <p className="mt-2 text-small text-muted-foreground">{NO_ADDRESS_LINE}</p>}
            <Button size="sm" className="mt-4 self-start" disabled={noAddress && to === "#/triggers/new-composio"} onClick={() => go(to)}>{action}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A schedule's raw cron line, the tooltip on its words; none for any other trigger. */
const cronOf = (t: Trigger): string | undefined => (t.source.kind === "schedule" && "cron" in t.source ? t.source.cron : undefined);

/** A schedule's line (scheduleLine: when it fires and its next time, or "Done · ran …" for a one time that ran) or a
 *  webhook's requests, then the agent it starts or the run it messages. */
function whatWords(t: Trigger, agentName: (id: string) => string, now: number): string {
  const when = t.source.kind === "schedule" ? scheduleLine(t.source, t.next_at, { instead: onceWords(onceState(t, now)), now }) : t.source.kind === "github" ? githubWhen(t.source) : t.source.kind === "composio" ? composioWhen(t.source) : t.source.kind === "email" ? emailWhen(t.source) : t.source.kind === "feed" ? feedWhen(t.source) : hookWhen(t.source);
  return `${when} · ${t.target.kind === "start_run" ? agentName(t.target.agent_id) || t.target.agent_id : `messages run ${runLabel(t.target.run_id)}`}`;
}

/** Whether Composio has a trigger from an app's instance on, in words. */
type OnComposio = ComposioTriggers["triggers"][number]["on_composio"];
/** An app event as the New app trigger list says it: its name, else its slug. */
const eventLabel = (e: Pick<ComposioEvent, "name" | "slug">) => e.name || e.slug;
const ON_COMPOSIO: Record<OnComposio, string> = {
  on: "On", off: "Off", missing: "Composio no longer has it: delete this trigger and make it again.", unknown: "Composio didn't say",
};

/** A trigger this page doesn't open (one that sends its firings to a run), opened by its address: what it is, and nothing
 *  to change it. */
function NotASchedule() {
  return (
    <div className="p-5 md:p-8">
      <a href="#/triggers" className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
      <p className="mt-4 border px-4 py-6 text-body text-muted-foreground">This trigger sends its firings to a run: this page doesn't open it yet.</p>
    </div>
  );
}

function ScheduleDetail({ v2, go, agentName, id, every, now, failuresToPause }: PageProps & { id: string; every: number; now: () => number; failuresToPause?: number }) {
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
  // A trigger from an app: whether its instance is on at Composio (GET .../composio/triggers; null, not read), what
  // Composio could not follow of a pause or resume, and, once deleted here, what it could not follow of the delete.
  const [atComposio, setAtComposio] = useState<OnComposio | null>(null);
  const [composioNote, setComposioNote] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
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
  useRereads(() => { if (!reading.current && !firing.current && gone === null) read().catch(() => {}); }, every, [v2, id]);
  // A schedule with no cap of its own runs under its agent's default (definition.max_cost_usd): read it to say so.
  // A connected agent has neither: its runs are not capped, and the row says so. What was read is kept with the agent it
  // was read of, so it never describes the agent the trigger starts next.
  const [capRead, setCapRead] = useState<{ agentId: string; agentCap: number | undefined; connected: boolean } | null>(null);
  const capAgent = trigger && trigger.target.kind === "start_run" && typeof trigger.target.max_cost_usd !== "number" ? trigger.target.agent_id : null;
  useEffect(() => {
    if (!capAgent) return;
    let live = true;
    v2.getAgent(capAgent).then((r) => { if (live) setCapRead({ agentId: capAgent, agentCap: typeof r.agent.definition.max_cost_usd === "number" ? r.agent.definition.max_cost_usd : undefined, connected: agentCapOf(r.agent).connected }); }, () => {});
    return () => { live = false; };
  }, [v2, capAgent]);
  const { agentCap, connected } = capRead && capRead.agentId === capAgent ? capRead : { agentCap: undefined, connected: false };
  const appServer = trigger?.source.kind === "composio" ? trigger.source.server : null;
  useEffect(() => {
    if (!appServer) return;
    let live = true;
    v2.composioTriggers(appServer).then((r) => { if (live) setAtComposio(r.triggers.find((x) => x.id === id)?.on_composio ?? "unknown"); }, () => { if (live) setAtComposio(null); });
    return () => { live = false; };
  }, [v2, appServer, id, trigger?.enabled]);
  // An email trigger watches the server's one email account (Settings → Email): its address, read to say which (null:
  // none saved; undefined: not read, as with a token, which can't read it).
  const [mailAddress, setMailAddress] = useState<string | null | undefined>(undefined);
  const watchesMail = trigger?.source.kind === "email";
  useEffect(() => {
    if (!watchesMail) return;
    let live = true;
    v2.emailAccount().then((a) => { if (live) setMailAddress(a.configured ? a.address : null); }, () => {});
    return () => { live = false; };
  }, [v2, watchesMail]);
  // Deleted here, with what Composio could not follow: said until the person leaves.
  if (gone !== null) {
    return (
      <div className="p-5 md:p-8">
        <a href="#/triggers" className="caps flex items-center gap-2 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
        <h1 className="mt-3 break-words text-2xl font-semibold leading-tight">{trigger?.name ?? id}</h1>
        <p className="mt-2 text-body">Deleted here. Its runs stay.</p>
        <p role="status" data-composio-note className="mt-4 border border-warning/50 bg-warning/10 px-3 py-2 text-body text-warning-text">{gone}</p>
        <a href="#/triggers" className="mt-4 inline-block text-body underline underline-offset-2">All triggers</a>
      </div>
    );
  }
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} link={{ href: "#/triggers", label: "All triggers" }} /> : <ListSkeleton label="Loading the trigger" rows={4} />;
  const hook = isWebhookTrigger(trigger) ? trigger : null;
  // A GitHub trigger: its events, its firings, Pause/Resume (a Disconnect turns it off) and Delete; no URL or secret.
  const gh = isGitHubTrigger(trigger) ? trigger : null;
  // A trigger from an app: its server, event and config, its filter, and whether Composio still has its instance.
  const app = isComposioTrigger(trigger) ? trigger : null;
  // A feed trigger: its feeds, how often they are read, its last check (with the note of a first check's start), its
  // pointers and filter.
  const feed = isFeedTrigger(trigger) ? trigger : null;
  // An email trigger: the account and mailbox it watches, how often, its last check, its filter; no editor here.
  const mail = isEmailTrigger(trigger) ? trigger : null;
  if (!hook && !gh && !app && !feed && !mail && !isScheduleTrigger(trigger)) return <NotASchedule />;
  const runs = trigger as Schedule | WebhookTrigger | GitHubTrigger | ComposioTrigger | FeedTrigger | EmailTrigger;
  // A one-time schedule whose time has passed: Done with when it ran (a started firing of its own time, the server's word:
  // nothing to resume), or that its time passed. Resume stays unless the server says it ran: the browser's clock alone
  // may run ahead of the server's.
  const done = onceState(trigger, now(), firings);

  const act = async (what: "pause" | "delete", work: () => Promise<unknown>, failed: string) => {
    setBusy(what); setSaid(null);
    try { await work(); } catch (e) { setSaid(problem(e, failed)); } finally { setBusy(null); }
  };
  const toggle = () => act("pause", async () => {
    generation.current++;
    setComposioNote(null);
    const { composio, ...answer } = await v2.updateTrigger(id, { enabled: !trigger.enabled });
    generation.current++;
    setTrigger(answer);
    setComposioNote(composio?.note ?? null);
  }, trigger.enabled ? "the pause" : "the resume");
  // A delete Composio could not follow stays on the page to say what to remove there.
  const remove = () => act("delete", async () => {
    const said = await v2.deleteTrigger(id);
    if (said?.composio) setGone(said.composio.note);
    else go("#/triggers");
  }, "the delete");
  const rotate = async () => {
    if (rotateOut.current) return;
    rotateOut.current = true; setRenewing(true); setSaid(null); setFresh(null);
    try { setFresh((await v2.rotateTriggerSecret(id)).signing_secret ?? null); } catch (e) { setSaid(problem(e, "the new secret")); } finally { rotateOut.current = false; setRenewing(false); }
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
  // The input's other fields (an agent's typed input beside the message), each by its key.
  const given = Object.entries(runs.target.input).filter(([k]) => k !== "content");
  return (
    <div className="p-5 md:p-8">
      <a href="#/triggers" className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
      <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-3 sm:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          <h1 className="flex flex-wrap items-center gap-2 break-words text-2xl font-semibold leading-tight">{trigger.name}{!trigger.enabled && !done && <OffChip trigger={trigger} />}</h1>
          <p className="mt-2 break-words font-mono text-small text-muted-foreground">{hook ? `Webhook · ${hookWhen(hook.source)}` : gh ? `GitHub · ${githubWhen(gh.source)}` : app ? `App · ${composioWhen(app.source)}` : feed ? `Feed · ${feedWhen(feed.source)}` : mail ? `Email · ${emailWhen(mail.source)}` : <span title={cronOf(trigger)}>{scheduleLine(runs.source as Schedule["source"], trigger.next_at, { instead: onceWords(done), now: now() })}</span>}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
          {!(done && "ran" in done) && <Button size="sm" onClick={() => void toggle()} disabled={busy !== null}>{trigger.enabled ? <><Pause aria-hidden /> Pause</> : <><Play aria-hidden /> Resume</>}</Button>}
          {!mail && <Button size="sm" onClick={() => go(`${hashOf(id)}/edit`)}><Pencil aria-hidden /> {hook || gh || app ? "Edit filter" : feed ? "Edit feed" : "Edit"}</Button>}
          {hook && (!rotating ? <Button size="sm" onClick={() => setRotating(true)} disabled={busy !== null || renewing}><KeyRound aria-hidden /> Rotate secret</Button> : (
            <span className="flex items-center gap-2 border border-warning/50 px-2 py-1 text-small" role="alertdialog" aria-label="Make a new secret?">
              <span>The old secret stops signing at once.</span>
              <Button size="sm" variant="solid" onClick={() => { setRotating(false); void rotate(); }}>Yes, make a new one</Button>
              <Button size="sm" variant="ghost" onClick={() => setRotating(false)}>Keep</Button>
            </span>
          ))}
          {!confirming ? <Button size="sm" variant="destructive" onClick={() => setConfirming(true)} disabled={busy !== null}><Trash2 aria-hidden /> Delete</Button> : (
            <span className="flex items-center gap-2 border border-destructive/50 px-2 py-1 text-small" role="alertdialog" aria-label="Delete this trigger?">
              <span>Delete for good? Its runs stay.</span>
              <Button size="sm" variant="destructive" onClick={() => { setConfirming(false); void remove(); }}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </span>
          )}
          <Button size="sm" variant="solid" onClick={() => void runNow()} disabled={busy === "fire"}><Zap aria-hidden /> {busy === "fire" ? "Starting" : "Run now"}</Button>
        </div>
      </div>
      {disabledWords(trigger, failuresToPause) && (
        <p role="status" data-disabled className="mt-4 border border-warning/50 bg-warning/10 px-3 py-2 text-body text-warning-text">
          {disabledWords(trigger, failuresToPause)} {trigger.disabled?.reason === "source_unreadable" ? (feed ? "Edit its feeds, then Resume." : "Edit its when, then Resume.") : trigger.disabled?.reason === "auto_paused" ? (done && "passed" in done ? "Its time has passed: edit its time first, then Resume." : done ? "" : "Resume turns it on again.") : ""}
        </p>
      )}
      {said && <ProblemCard problem={said} className="mt-4" />}
      {/* Its agent's tools that ask stop a run from it until someone answers (a schedule's later firings skipped meanwhile):
          said, with the fix. */}
      {trigger.target.kind === "start_run" && <UnattendedWarning v2={v2} agentId={trigger.target.agent_id} skips={trigger.source.kind === "schedule"} className="mt-4" />}
      {composioNote && <p role="status" data-composio-note className="mt-4 border border-warning/50 bg-warning/10 px-3 py-2 text-body text-warning-text">{composioNote}</p>}
      {hook && fresh && <SecretOnce label="The webhook's new secret" secret={fresh} />}
      {(feed || mail) && <LastCheck check={trigger.last_check ?? null} newest={firings[0]} />}
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border p-4 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="caps text-label text-muted-foreground">Agent</dt><dd className="min-w-0 break-words"><a href={agentHash(runs.target.agent_id)} className="hover:underline">{agentName(runs.target.agent_id) || runs.target.agent_id}</a></dd>
        {(content !== null || !given.length) && <><dt className="caps text-label text-muted-foreground">Each run is asked</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{content ?? JSON.stringify(runs.target.input)}</dd></>}
        {given.length > 0 && <>
          <dt className="caps text-label text-muted-foreground">Each run's input</dt>
          <dd className="min-w-0 break-words"><ul className="space-y-1 font-mono text-small" data-input>{given.map(([k, v]) => <li key={k}>{k}: {typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v)}</li>)}</ul></dd>
        </>}
        <dt className="caps text-label text-muted-foreground">Cost cap</dt>{connected ? <dd data-no-cap className="min-w-0 break-words">{CONNECTED_NO_CAP}</dd> : <dd className="font-mono">{capOf(runs.target.max_cost_usd, agentCap)}</dd>}
        {hook ? <>
          <dt className="caps text-label text-muted-foreground">URL</dt><dd className="flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all font-mono text-small">{hookUrlOf(hook)}</code><CopyButton text={hookUrlOf(hook)} label="Copy URL" /><span className="basis-full text-small text-muted-foreground">{HOOK_URL_HINT}</span></dd>
          <dt className="caps text-label text-muted-foreground">Signature</dt><dd>{SIGNATURE_WORDS[hook.source.signature ?? "standard"]}</dd>
          <dt className="caps text-label text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words">{hook.source.accept?.length ? <ul className="space-y-1 font-mono text-small">{hook.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul> : "Every signed request"}</dd>
        </> : app ? <>
          <dt className="caps text-label text-muted-foreground">App</dt><dd className="min-w-0 break-words"><a href="#/settings/mcp" className="font-mono hover:underline">{app.source.server}</a><span className="text-small text-muted-foreground"> · a saved Composio server</span></dd>
          <dt className="caps text-label text-muted-foreground">Event</dt><dd className="min-w-0 break-words font-mono">{app.source.event}</dd>
          <dt className="caps text-label text-muted-foreground">Config</dt>
          <dd className="min-w-0 break-words">{Object.keys(app.source.config).length ? <ul className="space-y-1 font-mono text-small">{Object.entries(app.source.config).map(([k, v]) => <li key={k}>{k}: {app.source.sealed_config?.includes(k) ? <span data-sealed-config={k} className="text-muted-foreground">Sealed: kept here, never shown</span> : typeof v === "string" ? v : JSON.stringify(v)}</li>)}</ul> : "None"}</dd>
          <dt className="caps text-label text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words">{app.source.accept?.length ? <ul className="space-y-1 font-mono text-small">{app.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul> : "Every event of its instance"}</dd>
          <dt className="caps text-label text-muted-foreground">At Composio</dt>
          <dd className="min-w-0 break-words">{atComposio ? <span data-on-composio={atComposio} className={atComposio === "missing" ? "text-warning-text" : undefined}>{ON_COMPOSIO[atComposio]}</span> : <span className="text-muted-foreground">Not read</span>}</dd>
        </> : gh ? <>
          <dt className="caps text-label text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words"><ul className="space-y-1 font-mono text-small">{gh.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul><p className="mt-1 text-small text-muted-foreground">From this server's GitHub App (Settings → GitHub).</p></dd>
        </> : feed ? <>
          <dt className="caps text-label text-muted-foreground">Feeds</dt>
          <dd className="min-w-0 break-words"><ul className="space-y-1 font-mono text-small">{feed.source.urls.map((url) => <li key={url} className="break-all">{httpHref(url) ? <a href={httpHref(url)} target="_blank" rel="noreferrer" className="hover:underline">{url}</a> : url}</li>)}</ul></dd>
          <dt className="caps text-label text-muted-foreground">Read</dt><dd>Every {span(feed.source.every_s ?? FEED_EVERY_S)}</dd>
          {(feed.source.items !== undefined || feed.source.id !== undefined) && <>
            <dt className="caps text-label text-muted-foreground">JSON list</dt>
            <dd className="min-w-0 break-words font-mono text-small">Items at {feed.source.items ? feed.source.items : "the whole document"} · Id at {feed.source.id ?? "/id"}</dd>
          </>}
          <dt className="caps text-label text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words">{feed.source.accept?.length ? <ul className="space-y-1 font-mono text-small">{feed.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul> : "Every new or updated item"}</dd>
        </> : mail ? <>
          <dt className="caps text-label text-muted-foreground">Account</dt>
          <dd className="min-w-0 break-words" data-mail-account>{mailAddress ? <span className="font-mono">{mailAddress}</span> : mailAddress === null ? <span className="text-warning-text">None saved</span> : "This server's email account"}<span className="text-small text-muted-foreground"> · <a href="#/settings/email" className="hover:underline">Settings → Email</a></span></dd>
          <dt className="caps text-label text-muted-foreground">Mailbox</dt><dd className="min-w-0 break-words font-mono">{mail.source.mailbox}</dd>
          <dt className="caps text-label text-muted-foreground">Read</dt><dd>Every {span(mail.source.every_s)}</dd>
          <dt className="caps text-label text-muted-foreground">Accepts</dt>
          <dd className="min-w-0 break-words">{mail.source.accept?.length ? <ul className="space-y-1 font-mono text-small">{mail.source.accept.map((a, i) => <li key={i}>{acceptWords(a)}</li>)}</ul> : "Every new message"}</dd>
        </> : <>
          <dt className="caps text-label text-muted-foreground">While a run is going</dt><dd>The next time is skipped.</dd>
        </>}
      </dl>
      <section className="mt-6" aria-label="Firings">
        <h2 className="text-lg font-semibold">Firings</h2>
        {!firings.length ? <p className="mt-2 font-mono text-small text-muted-foreground">Not fired yet.</p> : (
          <ul className="mt-3 border">
            {firings.map((f) => (
              <li key={f.key} data-firing={f.key} className="flex flex-col gap-1 border-b px-4 py-2.5 text-body last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
                <span className="flex shrink-0 items-center gap-2"><Chip tone={TONE[f.status]}>{FIRING_LABEL[f.status]}</Chip><span className="font-mono text-small text-muted-foreground">{at(f.nominal_at)}</span></span>
                <span className="min-w-0 flex-1 break-words">{f.status === "started" ? `${FIRED_BY[f.by]}${f.catch_up ? ", caught up late" : ""}` : `${firingWords(f)}${f.catch_up ? " · caught up late" : ""}${f.by === "manual" ? " · Run now" : ""}`}</span>
                {f.run_id && <a href={`#/runs/${encodeURIComponent(f.run_id)}`} className="shrink-0 font-mono text-small underline-offset-2 hover:underline">Run {runLabel(f.run_id)}</a>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScheduleEdit({ v2, go, id, minEvery, now }: FormProps & { id: string }) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => { v2.getTrigger(id).then(setTrigger, (e) => setError(problem(e, "the trigger"))); }, [v2, id, tries]);
  if (!trigger) return error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} /> : <ListSkeleton label="Loading the trigger" rows={4} />;
  // A webhook's, GitHub trigger's or trigger from an app's filter is edited alone: its address, secret, what was made on
  // Composio, and its run stay as they are.
  if (isWebhookTrigger(trigger) || isGitHubTrigger(trigger) || isComposioTrigger(trigger)) return <FilterForm v2={v2} go={go} trigger={trigger} />;
  // A feed trigger's feeds, interval, pointers and filter are edited alone: its name and its run stay as they are.
  if (isFeedTrigger(trigger)) return <FeedForm v2={v2} go={go} trigger={trigger} minEvery={minEvery} />;
  // Never an editor for another kind of trigger: its save would rebuild it as a schedule that starts runs.
  if (!isScheduleTrigger(trigger)) return <NotASchedule />;
  return <ScheduleForm v2={v2} go={go} trigger={trigger} minEvery={minEvery} now={now} />;
}

/** One input with its label (marked * when the save refuses it empty), its hint, and the issue under it (`data-issue`: the
 *  field the server names). */
function Field({ label, field, issue, hint, required, children }: { label: string; field: string; issue?: string; hint?: string; required?: boolean; children: ReactNode }) {
  return <UiField className="min-w-0" label={label} required={required} hint={hint} error={issue ? <span data-issue={field}>{issue}</span> : undefined}>{children}</UiField>;
}

/** An empty cap field's placeholder: the picked agent's own default cap as served (definition.max_cost_usd), which an
 *  empty field takes; none when the agent has none, never a made-up example. */
const capPlaceholder = (agentCap: number | undefined) => (agentCap !== undefined ? `${dollars(agentCap)}, the agent's default` : undefined);

/** What a trigger's runs are: the agent each starts, what each is given (RunInput; `asked`: what comes with it) and the
 *  cost cap under `capRule`, the rule the form's body builder takes too: for a connected agent (`none`) no field, only the
 *  words saying why, with a refusal the server still names under the cap. `input`: how the picked agent takes its input
 *  and the server's issues at its fields (useTriggerCreate). `edit`: a change to the draft's run fields. `what` names the
 *  trigger in the cap's hint; `skips`: the agent warning's note for a schedule. */
function RunTargetFields({ v2, draft, edit, issues, agents, input, agentCap, capRule, what, asked, skips }: {
  v2: Client; draft: RunDraft; edit: (patch: Partial<RunDraft>) => void;
  issues: Record<string, string>; agents: Agent[] | null; input: RunInputState; agentCap: number | undefined; capRule: CapRule; what: string; asked?: string; skips?: boolean;
}) {
  // Another agent's input starts afresh (its fields as they start, its example), and the issues at the last one's fields go.
  // An edited trigger's stored input goes too (inputRead): it was the last agent's, keys the new one may refuse or never show.
  // Picking the trigger's own agent again brings its stored input back whole, the keys no field shows with it.
  const pick = (agentId: string) => {
    if (agentId === draft.agentId) return;
    const back = draft.stored?.agentId === agentId ? draft.stored.input : undefined;
    edit(back ? { agentId, values: inputText(back), json: JSON.stringify(back, null, 2), inputRead: back } : { agentId, values: undefined, json: undefined, inputRead: undefined });
    input.setFieldIssues([]);
  };
  return <>
    <Field label="Agent" field="target.agent_id" issue={issues["target.agent_id"]} required>
      <AgentPick agents={agents} value={draft.agentId} onChange={pick} />
    </Field>
    <UnattendedWarning v2={v2} agentId={draft.agentId} skips={skips} />
    <RunInput shape={input.shape} draft={draft} onChange={edit} issue={issues["target.input"]} fieldIssues={input.fieldIssues} setFieldIssues={input.setFieldIssues} hint={asked} />
    {capRule === "none" ? (
      <UiField className="min-w-0" group label="Cost cap" error={issues["target.max_cost_usd"] ? <span data-issue="target.max_cost_usd">{issues["target.max_cost_usd"]}</span> : undefined}>
        <p data-no-cap role="note" className="text-body text-muted-foreground">{CONNECTED_NO_CAP}</p>
      </UiField>
    ) : (
      <Field label="Cost cap, US dollars a run" field="target.max_cost_usd" issue={issues["target.max_cost_usd"]} required={capRule === "required"}
        hint={agentCap !== undefined ? `Uses the agent's default (${dollars(agentCap)}) if empty.` : capRule === "optional" ? "Uses the agent's default if empty." : `Each run this ${what} starts stops at this spend.`}>
        <Input name="maxCost" inputMode="decimal" className="max-w-64" value={draft.maxCost} onChange={(e) => edit({ maxCost: e.target.value })} placeholder={capPlaceholder(agentCap)} />
      </Field>
    )}
  </>;
}

/** A trigger form's run fields as its draft holds them. */
type RunDraft = { agentId: string; content: string; maxCost: string } & InputDraft;

/** The Agent picker of every trigger form: the agents in picker order (agentsByName), archived ones left out but the one
 *  picked, which stays picked (an edited schedule's), as does one not listed. Two or more that share a name (several made
 *  from one template) each say their id beside it, so each option names one agent; a name no other agent has stays as it
 *  is. */
function AgentPick({ agents, value, onChange }: { agents: Agent[] | null; value: string; onChange: (agentId: string) => void }) {
  const live = agentsByName((agents ?? []).filter((a) => !a.archived_at || a.agent_id === value));
  const nameOf = (a: Agent) => a.definition.name || a.agent_id;
  const shared = (a: Agent) => live.filter((b) => nameOf(b) === nameOf(a)).length > 1;
  return (
    <Picker name="agent" label="Agent" className="w-full" value={value} onChange={onChange}
      options={[{ value: "", label: agents ? "Pick an agent" : "Loading the agents" },
        ...live.map((a) => ({ value: a.agent_id, label: `${shared(a) ? `${nameOf(a)} (${a.agent_id})` : nameOf(a)}${a.kind === "workflow" ? " (workflow)" : ""}` })),
        ...(value && agents && !live.some((a) => a.agent_id === value) ? [{ value, label: value }] : [])]} />
  );
}

/** How the picked agent takes its input (lib/inputForm.ts, as the run bar reads it): an agentic agent's input_schema; a
 *  workflow agent's trigger sends the message, as it always has. None while the agents load. */
const shapeOf = (agent: Agent | undefined): AgentInput | undefined => (agent && agent.kind !== "workflow" ? agentInputOf(agent.definition.input_schema) : undefined);

/** A trigger form's run input: how the picked agent takes it (`shape`), the input fields the form shows for it (`keys`),
 *  and the server's issues at those fields. */
type RunInputState = { shape: AgentInput | undefined; keys: string[]; fieldIssues: FieldIssue[]; setFieldIssues: (update: FieldIssue[] | ((was: FieldIssue[]) => FieldIssue[])) => void };

/** What each run a trigger starts is given, by how its agent takes input (lib/inputForm.ts, the run bar's): the message;
 *  the message and the agent's typed fields under it (the message optional when the schema requires another field), each
 *  with the server's issues at it (`target.input.<key>`); or, for a schema the fields can't show, the whole input as JSON.
 *  `hint`: what else each run is given (an event's payload). */
function RunInput({ shape, draft, onChange, issue, fieldIssues, setFieldIssues, hint }: {
  shape: AgentInput | undefined; draft: { content: string } & InputDraft; onChange: (patch: { content?: string } & InputDraft) => void; issue?: string;
  fieldIssues: FieldIssue[]; setFieldIssues: RunInputState["setFieldIssues"]; hint?: string;
}) {
  if (shape?.kind === "json") {
    const fields = shape.example.fields.map((f) => f.name).join(", ");
    return (
      <Field label="Each run's input, as JSON" field="target.input" issue={issue} required
        hint={`The agent takes its whole input as JSON${fields ? `: ${fields}` : ""}.${hint ? ` ${hint}` : ""} What comes with each run (its event, the last run's answer) is added to its "content": without "content", the run starts without it.`}>
        <Textarea name="input" rows={6} spellCheck={false} className="p-3 font-mono leading-[1.6]" value={draft.json ?? shape.example.text} onChange={(e) => onChange({ json: e.target.value })} />
      </Field>
    );
  }
  const form = shape?.kind === "fields" ? shape.form : null;
  const values = form ? draft.values ?? fieldStartText(form) : {};
  const keyOf = (i: FieldIssue) => fieldOfIssue(i.field, "target.input");
  const setField = (key: string, f: FieldSpec, value: string) => {
    onChange({ values: { ...values, [key]: value } });
    // An issue at the field goes as soon as its value is one the server takes.
    if (fieldValid(f, value)) setFieldIssues((was) => was.filter((i) => keyOf(i) !== key));
  };
  return (
    <>
      <UiField className="min-w-0" label="Each run is asked" required={!form || form.contentRequired} optional={!!form && !form.contentRequired} hint={hint} error={issue ? <span data-issue="target.input">{issue}</span> : undefined}>
        <Textarea name="content" rows={4} className="p-3 font-sans" value={draft.content} onChange={(e) => onChange({ content: e.target.value })} />
      </UiField>
      {form && (
        <div role="group" aria-label="Each run's input" className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {form.fields.map(([key, f]) => (
            <div key={key} data-field={`target.input.${key}`} className="min-w-0">
              <FieldInput field={f} label={fieldLabel(key, f)} help={paramHelp(f)} value={values[key] ?? ""} onChange={(v) => setField(key, f, v)} />
              <FieldIssues issues={fieldIssues.filter((i) => keyOf(i) === key)} words={(i) => fieldIssueWords(i, key, f)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

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

/** A refusal's issues split for a form: those under the fields it shows (`shown`), each in its place, and the rest, said
 *  above it. */
function splitRefusal(found: ReturnType<typeof issuesOf>, shown: ReadonlySet<string>): { issues: Record<string, string>; rest: string[] } {
  return {
    issues: Object.fromEntries(Object.entries(found.fields).filter(([k]) => shown.has(k))),
    rest: [...found.rest, ...Object.entries(found.fields).filter(([k]) => !shown.has(k)).map(([, v]) => v)],
  };
}

/** What each create-trigger form keeps beside its draft: every agent for the picker, the picked one's default cap and the
 *  form's rule for its own (`capRule`: none for a connected agent, else optional when the agent has a default cap or
 *  `capOptional` says so, an edited schedule that ran under it, else required; a cap issue said for another agent goes
 *  once a connected one is picked, as no field is left to fix it in); the Idempotency-Key keeper (a create sent again
 *  unchanged, a lost answer or a second click, reuses its key and makes one trigger; an edited one gets a new key); whether
 *  the form is still open (a save that answers after the person left it opens nothing); and `refused`, which says a
 *  refusal's issues under the fields the form shows (`shown`), those at the agent's input fields (`input`, how the picked
 *  agent takes its input) at each, and the rest above it. `loadAgents`: false on a form with no agent picker (a feed's
 *  edit). */
function useTriggerCreate(v2: Client, agentId: string, loadAgents = true, capOptional = false) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const keys = useRef(keeper()).current;
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  useEffect(() => { if (loadAgents) allAgents(v2).then(setAgents, () => setAgents([])); }, [v2, loadAgents]);
  const { agentCap, connected } = agentCapOf((agents ?? []).find((a) => a.agent_id === agentId));
  const capRule: CapRule = connected ? "none" : agentCap !== undefined || capOptional ? "optional" : "required";
  useEffect(() => { if (capRule === "none") setIssues((was) => { const { "target.max_cost_usd": said, ...kept } = was; return said === undefined ? was : kept; }); }, [capRule]);
  const shape = shapeOf((agents ?? []).find((a) => a.agent_id === agentId));
  const [fieldIssues, setFieldIssues] = useState<FieldIssue[]>([]);
  const input: RunInputState = { shape, keys: shape?.kind === "fields" ? shape.form.fields.map(([k]) => k) : [], fieldIssues, setFieldIssues };
  const refused = (found: ReturnType<typeof issuesOf>, shown: ReadonlySet<string>) => {
    const split = splitRefusal(found, shown);
    setIssues(split.issues);
    setRest(split.rest);
    setFieldIssues(found.input ?? []);
  };
  return { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, open, refused };
}

/** A new schedule, or `trigger` to edit. A save the server refuses (422) says each issue under the field it names. */
function ScheduleForm({ v2, go, trigger, minEvery, now = Date.now }: FormProps & { trigger?: Schedule }) {
  const [draft, setDraft] = useState<Draft>(() => (trigger ? draftOf(trigger) : emptyDraft()));
  // The picked agent's default cap per run (definition.max_cost_usd): with one, the schedule's own cap may be left empty
  // and each run takes the agent's. An edited schedule that already ran under its agent's default keeps it so too. A
  // connected agent takes no cap at all, nor the effort an edited schedule carried for another agent.
  const ranUnderDefault = !!trigger && typeof trigger.target.max_cost_usd !== "number" && draft.agentId === trigger.target.agent_id;
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, refused } = useTriggerCreate(v2, draft.agentId, true, ranUnderDefault);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // A one-time schedule's time: a refusal on it (a time already passed) goes once the time picked is ahead of now; one
  // still past keeps it, as the server would refuse it again.
  const pickAt = (wall: string) => {
    set("at")(wall);
    const picked = instantKept(wall, draft.read?.at);
    if (picked !== null && Date.parse(picked) > now()) setIssues(({ "source.at": _gone, ...rest }) => rest);
    // Still past: the refusal stays, naming the time now picked.
    else if (picked !== null) setIssues((was) => (was["source.at"] ? { ...was, "source.at": pastWords(picked, { now: now() }) } : was));
  };
  const shown = new Set(["name", "source.cron", "source.timezone", "source.at", "source.every_s", "source.start_at", "target.agent_id", "target.input", "target.max_cost_usd", ...(trigger ? [] : ["enabled"])]);
  // The draft as a save sends it: with how the picked agent takes its input.
  const sent = (): Draft => ({ ...draft, shape: input.shape });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = bodyOf(sent(), capRule);
    setRest([]); input.setFieldIssues([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      if (!trigger) {
        const made = await v2.createTrigger(body as TriggerCreate, keys.keyFor("createTrigger", body));
        go(hashOf(made.id));
      } else {
        const patch = patchOf(trigger, body, capRule === "none");
        if (Object.keys(patch).length) await v2.updateTrigger(trigger.id, patch);
        go(hashOf(trigger.id));
      }
    } catch (err) {
      const found = issuesOf(err, input.keys);
      // A one-time schedule refused at a time already passed: said in the person's own time, as the schedule line reads,
      // never in the API's ISO time (its error's details keep that). Past by this page's clock, or by the server's own
      // refusal (serve's trigger-schedule.ts: "Pick a time in the future: <ISO> has already passed."), since a browser
      // clock running behind the server's can see a time as ahead that the server has already seen pass. Any other
      // refusal of the time keeps the server's words.
      const pickedAt = draft.kind === "at" ? instantKept(draft.at, draft.read?.at) : null;
      const atIssue = found.fields["source.at"];
      if (atIssue && pickedAt !== null && (Date.parse(pickedAt) <= now() || PAST_REFUSAL.test(atIssue))) found.fields["source.at"] = pastWords(pickedAt, { now: now() });
      refused(found, shown);
      setSaving(false);
    }
  };
  // An edit that changes when starts the schedule again from now (the server's rule for a new source): said before the save.
  const edited = trigger ? bodyOf(sent(), capRule).body : undefined;
  const restarts = !!(trigger && edited && patchOf(trigger, edited, capRule === "none").source);
  // The instants the hints say: the ones the save sends (a time left alone keeps the instant it was read with).
  const atInstant = draft.kind === "at" ? instantKept(draft.at, draft.read?.at) : null;
  const startInstant = draft.startAt ? instantKept(draft.startAt, draft.read?.startAt) : null;
  const kinds: { kind: Draft["kind"]; label: string }[] = [{ kind: "cron", label: "Repeats" }, { kind: "at", label: "Once" }, { kind: "every", label: "Every" }];
  return (
    <form onSubmit={(e) => void save(e)} className="p-5 md:p-8" noValidate>
      <a href={trigger ? hashOf(trigger.id) : "#/triggers"} className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> {trigger ? trigger.name : "Triggers"}</a>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><CalendarClock className="size-5 text-primary-text" aria-hidden />{trigger ? "Edit schedule" : "New schedule"}</h1>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className={`mt-5 ${formColumnsClass}`}>
        <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="nightly triage" /></Field>
        <fieldset className="min-w-0">
          <legend className="caps text-label text-muted-foreground">When</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup">
            {kinds.map(({ kind, label }) => (
              <label key={kind} className={`flex h-9 cursor-pointer items-center gap-2 border px-3 text-body ${draft.kind === kind ? "border-primary text-primary-text" : ""}`}>
                <input type="radio" name="kind" value={kind} checked={draft.kind === kind} onChange={() => set("kind")(kind)} className="accent-primary" />{label}
              </label>
            ))}
          </div>
          {/* Side by side where each has its 14rem (the picker's own least width), else one under the other: the form's
              columns can be narrower than a phone is wide. */}
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
            {draft.kind === "cron" && <Field label="Runs" field="source.cron" issue={issues["source.cron"]}><ScheduleWhen label="Runs" name="cron" value={draft.cron} onChange={set("cron")} /></Field>}
            {draft.kind === "at" && <Field label="At, your time" field="source.at" issue={issues["source.at"]} hint={atInstant ? `= ${utcWhen(atInstant)}` : undefined}><Input name="at" type="datetime-local" step={60} value={draft.at} onChange={(e) => pickAt(e.target.value)} /></Field>}
            {draft.kind === "every" && (
              // The label names the amount; the unit beside it has its own id and its own name ("Unit").
              <Field label="Every" field="source.every_s" issue={issues["source.every_s"]} hint={minEvery ? atLeast(minEvery) : undefined}>
                <span className="flex gap-2">
                  <Input name="every" inputMode="decimal" value={draft.every} onChange={(e) => set("every")(e.target.value)} placeholder="5" />
                  <Picker id="schedule-every-unit" name="everyUnit" label="Unit" className="w-32 shrink-0" value={draft.everyUnit} onChange={(v) => set("everyUnit")(v as Draft["everyUnit"])}
                    options={(["seconds", "minutes", "hours"] as const).map((u) => ({ value: u, label: u }))} />
                </span>
              </Field>
            )}
            {draft.kind === "cron" && (
              <Field label="Time zone" field="source.timezone" issue={issues["source.timezone"]} hint="The time zone this schedule runs in.">
                <ZonePicker name="timezone" label="Time zone" className="w-full" value={draft.timezone} onChange={set("timezone")} />
              </Field>
            )}
            {draft.kind === "every" && <Field label="Starting, your time (optional)" field="source.start_at" issue={issues["source.start_at"]} hint={startInstant ? `= ${utcWhen(startInstant)}` : undefined}><Input name="startAt" type="datetime-local" step={60} value={draft.startAt} onChange={(e) => set("startAt")(e.target.value)} /></Field>}
          </div>
          {restarts && <p className="mt-3 text-small text-warning-text" role="note">Changing when restarts the schedule from now.</p>}
        </fieldset>
        <RunTargetFields v2={v2} draft={draft} edit={(patch) => setDraft((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="schedule" skips />
        {!trigger && (
          <div>
            <label className="flex items-center gap-2 text-body"><input type="checkbox" name="enabled" checked={draft.enabled} onChange={(e) => set("enabled")(e.target.checked)} className="accent-primary" /> On from now (off: made paused)</label>
            {issues.enabled && <p className="mt-1 text-small text-destructive-text" role="alert" data-issue="enabled">{issues.enabled}</p>}
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

/** A signing secret, shown this once (the server keeps it sealed and never sends it again), with Copy. */
export function SecretOnce({ label, secret, url }: { label: string; secret: string; url?: string }) {
  return (
    <section aria-label={label} className="mt-4 space-y-3 border border-primary/50 p-4 text-body">
      {url && <Copyable title="URL" text={url} label="Copy URL" hint={HOOK_URL_HINT} />}
      <Copyable title="Signing secret" text={secret} label="Copy secret" />
      <p className="text-warning-text" role="note">You won't see this secret again.</p>
    </section>
  );
}

function Copyable({ title, text, label, hint }: { title: string; text: string; label: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <span className="caps text-label text-muted-foreground">{title}</span>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all border bg-muted/40 px-2 py-1 font-mono text-small">{text}</code><CopyButton text={text} label={label} /></div>
      {hint && <p className="mt-1 text-small text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A new email trigger: each new message in a mailbox of the server's email account (Settings → Email) starts a capped
 *  run of the agent. The account is read to say when none is saved (the server refuses the create then, naming Settings
 *  → Email); a read that fails (a token can't read it) says nothing. A create lands on the trigger's page, where its first
 *  check says what it watches from. */
function EmailForm({ v2, go, minEvery }: FormProps) {
  const [draft, setDraft] = useState<EmailDraft>(emptyEmail);
  const [noAccount, setNoAccount] = useState(false);
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, open, refused } = useTriggerCreate(v2, draft.agentId);
  useEffect(() => { v2.emailAccount().then((a) => { if (open.current) setNoAccount(!a.configured); }, () => {}); }, [v2, open]);
  const set = <K extends keyof EmailDraft>(k: K) => (value: EmailDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = emailBodyOf({ ...draft, shape: input.shape }, minEvery, capRule);
    setRest([]); input.setFieldIssues([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      const made = await v2.createTrigger(body, keys.keyFor("createTrigger", body));
      if (open.current) go(hashOf(made.id));
    } catch (err) {
      if (!open.current) return;
      refused(issuesOf(err, input.keys), EMAIL_FIELDS);
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} className="p-5 md:p-8" noValidate>
      <a href="#/triggers" className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Mail className="size-5 text-primary-text" aria-hidden />New email trigger</h1>
      <p className="mt-2 text-body text-muted-foreground">Each new message in the mailbox starts a capped run of the agent. The messages already there when it is made start none: its first check, on its page once it is made, says how many.</p>
      {noAccount && (
        <p role="status" data-no-email-account className="mt-4 border border-warning/50 bg-warning/10 px-3 py-2 text-body text-warning-text">
          No email account is saved: an email trigger reads this server's account. Save one in <a href="#/settings/email" className="underline underline-offset-2">Settings → Email</a> first.
        </p>
      )}
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className={`mt-5 ${formColumnsClass}`}>
        <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="new mail" /></Field>
        <Field label="Mailbox" field="source.mailbox" issue={issues["source.mailbox"]} hint="A folder of the account in Settings → Email, by its name on the server.">
          <Input name="mailbox" value={draft.mailbox} onChange={(e) => set("mailbox")(e.target.value)} placeholder="INBOX" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Check every" field="source.every_s" issue={issues["source.every_s"]} hint={minEvery ? atLeast(minEvery) : undefined}>
          <span className="flex gap-2">
            <Input name="every" inputMode="decimal" value={draft.every} onChange={(e) => set("every")(e.target.value)} placeholder="1" />
            <Picker id="email-every-unit" name="everyUnit" label="Unit" className="w-32 shrink-0" value={draft.everyUnit} onChange={(v) => set("everyUnit")(v as EmailDraft["everyUnit"])}
              options={(["seconds", "minutes", "hours"] as const).map((u) => ({ value: u, label: u }))} />
          </span>
        </Field>
        <RunTargetFields v2={v2} draft={draft} edit={(patch) => setDraft((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="trigger" asked="The message comes with it: its sender, subject and text." />
        <div>
          <label className="flex items-center gap-2 text-body"><input type="checkbox" name="enabled" checked={draft.enabled} onChange={(e) => set("enabled")(e.target.checked)} className="accent-primary" /> On from now (off: made paused)</label>
          {issues.enabled && <p className="mt-1 text-small text-destructive-text" role="alert" data-issue="enabled">{issues.enabled}</p>}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Creating" : "Create email trigger"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go("#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}

const SIGNATURES: WebhookDraft["signature"][] = ["standard", "github"];

/** A new webhook trigger: each signed request to its URL starts a capped run of the agent. The create's answer carries
 *  its signing secret that once (or, on a retry under the same Idempotency-Key, a note in its place): shown with the URL,
 *  each with Copy, until Done opens the trigger. */
function WebhookForm({ v2, go }: { v2: Client; go: (hash: string) => void }) {
  const [draft, setDraft] = useState<WebhookDraft>(emptyWebhook);
  const [made, setMade] = useState<TriggerMade | null>(null);
  // A create sent again unchanged makes one webhook, its secret's note on the retry.
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, refused } = useTriggerCreate(v2, draft.agentId);
  const set = <K extends keyof WebhookDraft>(k: K) => (value: WebhookDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const shown = new Set(["name", "source.signature", "target.agent_id", "target.input", "target.max_cost_usd", ...acceptFields(draft.accept.map((r) => r.where.length))]);
    const { body, issues: missing } = webhookBodyOf({ ...draft, shape: input.shape }, capRule);
    setRest([]); input.setFieldIssues([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      setMade(await v2.createTrigger(body, keys.keyFor("createTrigger", body)));
    } catch (err) {
      refused(issuesOf(err, input.keys), shown);
    } finally {
      setSaving(false);
    }
  };
  const back = <a href="#/triggers" className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>;
  if (made) {
    return (
      <div className="p-5 md:p-8">
        {back}
        <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Webhook className="size-5 text-primary-text" aria-hidden />{made.name}</h1>
        <p className="mt-2 text-body text-muted-foreground">{`Send each request to this URL, signed with this secret (${SIGNATURE_WORDS[made.source.kind === "webhook" ? made.source.signature ?? "standard" : "standard"]}). Each one starts a run.`}</p>
        {made.signing_secret ? <SecretOnce label="The webhook's URL and secret" url={hookUrlOf(made)} secret={made.signing_secret} /> : (
          <section aria-label="The webhook's URL and secret" className="mt-4 space-y-3 border p-4 text-body">
            <Copyable title="URL" text={hookUrlOf(made)} label="Copy URL" hint={HOOK_URL_HINT} />
            {made.note && <p role="note">{made.note}</p>}
          </section>
        )}
        <div className="mt-6"><Button type="button" size="lg" variant="solid" onClick={() => go(hashOf(made.id))}>Done</Button></div>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="p-5 md:p-8" noValidate>
      {back}
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Webhook className="size-5 text-primary-text" aria-hidden />New webhook</h1>
      <p className="mt-2 text-body text-muted-foreground">Each signed request to its URL starts a capped run of the agent. Its URL and signing secret show once it is made.</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className={`mt-5 ${formColumnsClass}`}>
        <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="on deploy" /></Field>
        <fieldset className="min-w-0">
          <legend className="caps text-label text-muted-foreground">Signature</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup">
            {SIGNATURES.map((sig) => (
              <label key={sig} className={`flex h-9 cursor-pointer items-center gap-2 border px-3 text-body ${draft.signature === sig ? "border-primary text-primary-text" : ""}`}>
                <input type="radio" name="signature" value={sig} checked={draft.signature === sig} onChange={() => set("signature")(sig)} className="accent-primary" />{SIGNATURE_WORDS[sig]}
              </label>
            ))}
          </div>
          {issues["source.signature"] && <p className="mt-1 text-small text-destructive-text" role="alert" data-issue="source.signature">{issues["source.signature"]}</p>}
        </fieldset>
        <p className="text-small text-muted-foreground">Events from an app Composio connects start runs through an app trigger instead: <a href="#/triggers/new-composio" className="underline underline-offset-2">New app trigger</a></p>
        <WebhookFilter signature={draft.signature} rules={draft.accept} onChange={set("accept")} issues={issues} cap={null} />
        <RunTargetFields v2={v2} draft={draft} edit={(patch) => setDraft((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="webhook" />
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
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, open, refused } = useTriggerCreate(v2, draft.agentId);
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
  const set = <K extends keyof GitHubDraft>(k: K) => (value: GitHubDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const shown = new Set(["name", "target.agent_id", "target.input", "target.max_cost_usd", ...acceptFields(githubRulesOf(draft).map((r) => r.where.length))]);
    const { body, issues: missing } = githubBodyOf({ ...draft, shape: input.shape }, capRule);
    setRest([]); input.setFieldIssues([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      const made = await v2.createTrigger(body, keys.keyFor("createTrigger", body));
      if (open.current) go(hashOf(made.id));
    } catch (err) {
      refused(issuesOf(err, input.keys), shown);
      setSaving(false);
    }
  };
  const back = <a href="#/triggers" className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>;
  const title = <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><GitPullRequest className="size-5 text-primary-text" aria-hidden />New GitHub trigger</h1>;
  if (readError) return <div className="p-5 md:p-8">{back}{title}<ProblemCard problem={readError} onRetry={() => setTries((n) => n + 1)} className="mt-4" /></div>;
  if (connected === null) return <ListSkeleton label="Reading GitHub's connection" rows={3} />;
  if (!connected) {
    return (
      <div className="p-5 md:p-8">
        {back}{title}
        <p className="mt-4 border px-4 py-6 text-body">
          Connect GitHub first: <a href="#/settings/github" className="underline underline-offset-2">Settings → GitHub</a>. A GitHub trigger takes events from this server's GitHub App.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="p-5 md:p-8" noValidate>
      {back}{title}
      <p className="mt-2 text-body text-muted-foreground">Each event it takes from this server's GitHub App starts a capped run of the agent.</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className={`mt-5 ${formColumnsClass}`}>
        <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="review PRs" /></Field>
        <GitHubEvents picks={draft} onChange={(picks) => setDraft((d) => ({ ...d, ...picks }))} issues={issues} />
        <RunTargetFields v2={v2} draft={draft} edit={(patch) => setDraft((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="trigger" asked="The event's payload comes with it." />
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Creating" : "Create GitHub trigger"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go("#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}

/** A new trigger from an app: a saved Composio server (Settings → MCP servers), one of its toolkit's events and that
 *  event's config, its fields read from the event's schema; an optional filter on what Composio delivers; then the agent
 *  each event starts a capped run of. The server makes the instance on Composio, and the project's webhook subscription
 *  when there is none, and says in its own words what stops it: a subscription at another address is moved here only once
 *  the person says so. */
function ComposioForm({ v2, go, noAddress }: { v2: Client; go: (hash: string) => void; noAddress: boolean }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [readError, setReadError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const [events, setEvents] = useState<{ server: string; events: ComposioEvent[] } | null>(null);
  // The filter box over the server's events: another server starts it empty.
  const [eventsError, setEventsError] = useState<Problem | null>(null);
  const [eventTries, setEventTries] = useState(0);
  const [draft, setDraft] = useState<ComposioDraft>(emptyComposio);
  // A create sent again unchanged reuses its key; an edited one (a move asked) gets a new key.
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, open, refused } = useTriggerCreate(v2, draft.agentId);
  // A refusal's way on: the link to connect the server's account, or the address the project's subscription is at.
  const [connect, setConnect] = useState<string | null>(null);
  // The move is asked about the create Composio refused, kept with it: "Move it here" sends that one, and any edit to the
  // form withdraws the question (another server is another project).
  const [elsewhere, setElsewhere] = useState<{ url: string; body: TriggerCreate } | null>(null);
  useEffect(() => {
    let live = true;
    setReadError(null);
    v2.listMcpServers().then((r) => {
      if (!live) return;
      const apps = r.servers.filter((x) => x.source === "composio");
      setServers(apps);
      // One saved Composio server: it is the one.
      if (apps.length === 1) setDraft((d) => (d.server ? d : { ...d, server: apps[0]!.name }));
    }, (e) => { if (live) setReadError(problem(e, "the saved MCP servers")); });
    return () => { live = false; };
  }, [v2, tries]);
  useEffect(() => {
    if (!draft.server) return;
    let live = true;
    const server = draft.server;
    setEvents(null); setEventsError(null);
    v2.composioEvents(server).then((r) => { if (live) setEvents({ server, events: r.events }); }, (e) => { if (live) setEventsError(problem(e, `${server}'s events`)); });
    return () => { live = false; };
  }, [v2, draft.server, eventTries]);
  // An edit: the move asked about the create as it was is withdrawn.
  const edit = (next: (d: ComposioDraft) => ComposioDraft) => { setElsewhere(null); setDraft(next); };
  const set = <K extends keyof ComposioDraft>(k: K) => (value: ComposioDraft[K]) => edit((d) => ({ ...d, [k]: value }));
  // Another server or event starts its config and filter afresh.
  const pickServer = (server: string) => { edit((d) => (d.server === server ? d : { ...d, server, event: "", config: {}, where: [] })); };
  const pickEvent = (event: string) => { edit((d) => (d.event === event ? d : { ...d, event, config: {}, where: [] })); setIssues({}); };
  const event = events?.server === draft.server ? events.events.find((e) => e.slug === draft.event) : undefined;
  // The server's events A to Z by the words the list shows (Composio sends them in no order a person reads by), and those
  // the filter box keeps; the picked one stays in the list, so the field still says it while a query hides it.
  const listedEvents = events?.server === draft.server ? [...events.events].sort((a, b) => eventLabel(a).localeCompare(eventLabel(b), undefined, { sensitivity: "base" })) : [];
  const fields: ConfigField[] = configFieldsOf(event?.config, event?.sealed);
  const send = async (body: TriggerCreate) => {
    const shown = new Set(["name", "source.server", "source.event", "source.config", ...fields.map((f) => `source.config.${f.name}`), "target.agent_id", "target.input", "target.max_cost_usd", ...(draft.where.length ? acceptFields([draft.where.length]) : [])]);
    setIssues({}); setRest([]); setConnect(null); setElsewhere(null); input.setFieldIssues([]); setSaving(true);
    try {
      const made = await v2.createTrigger(body, keys.keyFor("createTrigger", body));
      if (open.current) go(hashOf(made.id));
      return;
    } catch (err) {
      if (err instanceof ClientError && err.code === "composio_subscription_elsewhere") setElsewhere({ url: typeof err.details?.webhook_url === "string" ? err.details.webhook_url : "another address", body });
      else if (err instanceof ClientError && err.code.startsWith("composio_")) {
        // Composio's refusals are said in the server's words: what stops it, and how to go on.
        setRest([err.message]);
        if (err.code === "composio_not_connected") setConnect(httpHref(typeof err.details?.connect_url === "string" ? err.details.connect_url : null) ?? null);
      } else refused(issuesOf(err, input.keys), shown);
    }
    setSaving(false);
  };
  const bodyNow = () => composioBodyOf({ ...draft, shape: input.shape }, fields, capRule);
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { body, issues: missing } = bodyNow();
    setRest([]); setConnect(null);
    if (!body) { setIssues(missing ?? {}); return; }
    void send(body);
  };
  // The person said to move the project's subscription here: the create Composio refused, asking for the move.
  const move = () => {
    const asked = elsewhere;
    setElsewhere(null);
    if (asked) void send({ ...asked.body, source: { ...asked.body.source, move_subscription: true } } as TriggerCreate);
  };
  const back = <a href="#/triggers" className="caps flex items-center gap-2 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Triggers</a>;
  const title = <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Blocks className="size-5 text-primary-text" aria-hidden />New app trigger</h1>;
  if (readError) return <div className="max-w-2xl p-5 md:p-8">{back}{title}<ProblemCard problem={readError} onRetry={() => setTries((n) => n + 1)} className="mt-4" /></div>;
  if (servers === null) return <ListSkeleton label="Reading the saved Composio servers" rows={3} />;
  if (!servers.length) {
    return (
      <div className="max-w-2xl p-5 md:p-8">
        {back}{title}
        <p className="mt-4 border px-4 py-6 text-body">
          Save a Composio server first: <a href="#/settings/mcp" className="underline underline-offset-2">Settings → MCP servers</a>, Add from Composio. A trigger from an app uses its key and the account it is connected as.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={save} className="max-w-2xl p-5 md:p-8" noValidate>
      {back}{title}
      <p className="mt-2 text-body text-muted-foreground">Each event Composio delivers for it starts a capped run of the agent. This server makes the trigger on Composio for the account the server is connected as.</p>
      {noAddress && <p className="mt-4 border border-warning/50 p-3 text-body" role="status">{NO_ADDRESS_LINE}</p>}
      {rest.length > 0 && (
        <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">
          {rest.map((r, i) => <p key={i} className="break-words">{r}</p>)}
          {connect && <a href={connect} target="_blank" rel="noreferrer" className="mt-2 inline-block underline underline-offset-2">Connect the account</a>}
        </div>
      )}
      <div className="mt-5 space-y-5">
        <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="new issues" /></Field>
        <Field label="Composio server" field="source.server" issue={issues["source.server"]}>
          <Picker name="server" label="Composio server" className="w-full" value={draft.server} onChange={pickServer}
            options={[{ value: "", label: "Pick a server" }, ...servers.map((x) => ({ value: x.name, label: x.toolkit ? `${x.name} (${x.toolkit})` : x.name }))]} />
        </Field>
        {draft.server && (eventsError ? <ProblemCard problem={eventsError} onRetry={() => setEventTries((n) => n + 1)} className="" /> : (
          <div className="space-y-2">
            {/* One field: typing in it filters its list by an event's name, slug or description (QA #162: the filter was a box of its own above it). */}
            <Field label="Event" field="source.event" issue={issues["source.event"]}>
              <SearchPicker name="event" label="Event" className="w-full" value={draft.event} onChange={pickEvent} disabled={!listedEvents.length}
                placeholder={events?.server !== draft.server ? "Loading the events" : !listedEvents.length ? "Composio offers no event for this toolkit" : "Search or pick an event"}
                nothing={(query) => `No event matches “${query}”`}
                options={listedEvents.map((x) => ({ value: x.slug, label: eventLabel(x), keywords: [x.slug, x.description] }))} />
            </Field>
            {/* Composio writes an event's description in Markdown (lists, ``code``): rendered, never shown as its marks. */}
            {event?.description && <div data-event-description className="report report-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: markdown(event.description) }} />}
          </div>
        ))}
        {event && (
          <>
            {event.polled && <p className="text-small text-muted-foreground" role="note">Composio checks for it every few minutes, so a run starts some minutes after the event.</p>}
            {/* Its instructions are Composio's Markdown as its description is: rendered (sanitized), never shown as marks. */}
            {event.instructions && <div data-event-instructions className="report report-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: markdown(event.instructions) }} />}
            <fieldset className="min-w-0">
              <legend className="caps text-label text-muted-foreground">Config</legend>
              <p className="mb-2 mt-1 text-small text-muted-foreground">What Composio watches for <span className="font-mono">{event.slug}</span>.</p>
              <Said issues={issues} field="source.config" />
              {!fields.length ? <p className="text-small text-muted-foreground">This event takes no config.</p> : (
                <div className="space-y-4">
                  {fields.map((f) => <ConfigInput key={`${event.slug}:${f.name}`} field={f} value={draft.config[f.name] ?? f.initial} issue={issues[`source.config.${f.name}`]} onChange={(v) => edit((d) => ({ ...d, config: { ...d.config, [f.name]: v } }))} />)}
                </div>
              )}
            </fieldset>
            <AppFilter where={draft.where} onChange={set("where")} issues={issues} />
          </>
        )}
        <RunTargetFields v2={v2} draft={draft} edit={(patch) => edit((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="trigger" asked="What Composio delivered comes with it." />
      </div>
      {elsewhere && (
        <div role="alertdialog" aria-label="Move the subscription here?" className="mt-6 space-y-3 border border-warning/50 p-4 text-body">
          <p>Composio sends this project's events to <code className="break-all font-mono text-small">{elsewhere.url}</code> now. Moving them here stops them arriving there: anything listening at <code className="break-all font-mono text-small">{elsewhere.url}</code> (another AgentRun server, or a tool of yours) gets no more events.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="solid" onClick={move}>Move it here</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setElsewhere(null)}>Keep it there</Button>
          </div>
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving || !!elsewhere || noAddress}>{saving ? "Creating" : "Create app trigger"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go("#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}

/** One field of an event's config, typed as its schema says: text, a number, a choice, a switch, or JSON. Its title, its
 *  description, and whether it is required; the issue under it (`source.config.<name>`). */
function ConfigInput({ field: f, value, issue, onChange }: { field: ConfigField; value: string; issue?: string; onChange: (value: string) => void }) {
  const name = `config-${f.name}`;
  const error = issue ? <span data-issue={`source.config.${f.name}`}>{issue}</span> : undefined;
  if (f.type === "boolean") {
    return (
      <div data-config-field={f.name}>
        <label className="flex items-center gap-2 text-body"><input type="checkbox" name={name} checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="accent-primary" /> {f.title}</label>
        {f.description && <p className="mt-1 text-small text-muted-foreground">{f.description}</p>}
        {issue && <p className="mt-1 text-small text-destructive-text" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div data-config-field={f.name}>
      <UiField className="min-w-0" label={f.title} required={f.required} optional={!f.required} hint={f.description} error={error}>
        {f.options ? <Picker name={name} label={f.title} className="w-full" value={value} onChange={onChange} options={[...(f.required ? [] : [{ value: "", label: "None" }]), ...f.options.map((o) => ({ value: o, label: o }))]} placeholder="Pick one" />
          : f.type === "json" ? <Textarea name={name} rows={3} className="p-3 font-mono" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          : <Input name={name} type={f.sealed ? "password" : undefined} inputMode={f.type === "string" ? undefined : "decimal"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={f.sealed ? "new-password" : "off"} spellCheck={false} />}
      </UiField>
    </div>
  );
}

/** What a webhook's runs do with its filter and its cap (`max_active_runs`, serve's triggers.ts): with no filter a
 *  request while its last run is going is skipped; with one, each request it takes is its own run (its adapter's
 *  `concurrent`). A cap holds either way, and a request past it waits; taking the filter away keeps the cap. */
function runsWords(filtered: boolean, cap: number | null): string {
  const capped = cap !== null ? `, up to ${cap} at once; past that, a request waits for one of them to end` : "";
  if (!filtered) return cap !== null ? `Every signed request starts a run${capped}.` : "Every signed request starts a run. One that comes while its last run is still going is skipped.";
  return `With a filter, each request it takes starts its own run${cap !== null ? capped : ", even while an earlier run is still going"}. Any other request is answered and starts nothing.`;
}

/** A webhook's filter: rules typed by event name, with what each signature scheme calls an event, and what the filter
 *  changes about its runs. */
function WebhookFilter({ signature, rules, onChange, issues, cap }: { signature: WebhookDraft["signature"]; rules: RuleDraft[]; onChange: (rules: RuleDraft[]) => void; issues: Record<string, string>; cap: number | null }) {
  return (
    <fieldset className="min-w-0">
      <legend className="caps text-label text-muted-foreground">Filter <span className="font-normal normal-case">(optional)</span></legend>
      <div className="mt-2 space-y-3">
        <Said issues={issues} field="source.accept" />
        <AcceptEditor name="accept" rules={rules} onChange={onChange} issues={issues} room={ACCEPT_LIMITS.rules - rules.length} eventHint={EVENT_HINTS[signature]}
          eventPlaceholder={signature === "github" ? "issues" : "issue.opened"} />
        <p className="text-small text-muted-foreground" role="note">{runsWords(rules.length > 0, cap)}</p>
      </div>
    </fieldset>
  );
}

/** A GitHub trigger's events: the picker's events and actions, each picked event with its conditions, then rules for
 *  any other GitHub event, typed as a webhook's are. Each issue finds its rule by where githubRulesOf sends it. */
function GitHubEvents({ picks, onChange, issues }: { picks: GitHubPicks; onChange: (picks: GitHubPicks) => void; issues: Record<string, string> }) {
  const toggle = (key: string) => onChange({ ...picks, events: picks.events.includes(key) ? picks.events.filter((e) => e !== key) : [...picks.events, key] });
  const sent = githubRulesOf(picks).map((r) => r.id);
  return (
    <>
      <fieldset className="min-w-0">
        <legend className="caps text-label text-muted-foreground">Events</legend>
        <div className="mt-1 space-y-3">
          {GITHUB_EVENT_NAMES.map((name) => {
            const i = sent.indexOf(`event:${name}`);
            const at = `source.accept[${i}]`;
            return (
              <div key={name} data-github-event={name} className="space-y-1">
                {GITHUB_EVENTS.filter((e) => e.event === name).map(({ event, action, label }) => {
                  const key = `${event}:${action}`;
                  return (
                    <label key={key} className="flex items-center gap-2 text-body">
                      <input type="checkbox" name="event" value={key} checked={picks.events.includes(key)} onChange={() => toggle(key)} className="accent-primary" />
                      {label} <span className="font-mono text-label text-muted-foreground">{event} {action}</span>
                    </label>
                  );
                })}
                {i >= 0 && (
                  <div className="ml-6 space-y-1 pt-1">
                    {[at, `${at}.event`, `${at}.actions`].map((field) => <Said key={field} issues={issues} field={field} />)}
                    <ConditionList name={`github-${name}`} at={at} where={picks.where[name] ?? []} onChange={(where) => onChange({ ...picks, where: { ...picks.where, [name]: where } })} issues={issues} label={`Only when, for ${name}`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {issues["source.accept"] && <p className="mt-1 text-small text-destructive-text" role="alert" data-issue="source.accept">{issues["source.accept"]}</p>}
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="caps text-label text-muted-foreground">Other events <span className="font-normal normal-case">(optional)</span></legend>
        <p className="mb-2 mt-1 text-small text-muted-foreground">Any other GitHub event, by its name.</p>
        <AcceptEditor name="other" rules={picks.other} onChange={(other) => onChange({ ...picks, other })} issues={issues} indexOf={(i) => sent.indexOf(`other:${picks.other[i]?.key}`)} room={ACCEPT_LIMITS.rules - sent.length}
          eventHint={EVENT_HINTS.github} eventPlaceholder="issues" addLabel="Add another event" />
      </fieldset>
    </>
  );
}

/** A webhook's, GitHub trigger's or trigger from an app's filter, edited: a PATCH of its source, all of it as it was but
 *  the new `accept` (none, on a webhook: every signed request fires again; on a trigger from an app, every event of its
 *  instance). Its URL, secret, what was made on Composio and its run stay. A save that changes nothing sends nothing. */
function FilterForm({ v2, go, trigger }: { v2: Client; go: (hash: string) => void; trigger: WebhookTrigger | GitHubTrigger | ComposioTrigger }) {
  const hook = isWebhookTrigger(trigger) ? trigger : null;
  const app = isComposioTrigger(trigger) ? trigger : null;
  const [rules, setRules] = useState<RuleDraft[]>(() => (hook ? (hook.source.accept ?? []).map(ruleDraftOf) : app ? (app.source.accept ?? []).map(ruleDraftOf) : []));
  const [picks, setPicks] = useState<GitHubPicks>(() => (hook || app ? { events: [], where: {}, other: [] } : githubPicksOf((trigger as GitHubTrigger).source.accept)));
  // A trigger from an app's filter is its first rule's conditions (the form's own); any rule after it, made through the
  // API, is kept as it is. A first rule that names actions is kept so too.
  const appFirst = app && rules[0] && !rules[0].actions.trim() ? rules[0] : null;
  const appOthers = app ? rules.slice(appFirst ? 1 : 0) : [];
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // A save that answers after the person left the editor opens nothing, as the GitHub form's.
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { source, issues: found } = hook ? webhookSourceOf(hook.source, rules) : app ? composioSourceOf(app.source, appFirst?.where ?? [], appOthers, appFirst?.was) : githubSourceOf(picks);
    setRest([]);
    if (Object.keys(found).length) { setIssues(found); return; }
    setIssues({}); setSaving(true);
    try {
      if (!same(source, trigger.source)) await v2.updateTrigger(trigger.id, { source });
      if (open.current) go(hashOf(trigger.id));
    } catch (err) {
      if (!open.current) return;
      const shown = acceptFields(hook || app ? rules.map((r) => r.where.length) : githubRulesOf(picks).map((r) => r.where.length));
      const split = splitRefusal(issuesOf(err), shown);
      setIssues(split.issues);
      setRest(split.rest);
      setSaving(false);
    }
  };
  const Icon = hook ? Webhook : app ? Blocks : GitPullRequest;
  // The first rule's conditions, as the form edits them: emptied, the rule goes.
  const setWhere = (where: RuleDraft["where"]) => setRules(appFirst ? (where.length ? [{ ...appFirst, where }, ...appOthers] : appOthers) : where.length ? [{ ...emptyRule(), event: app!.source.event, where }, ...appOthers] : appOthers);
  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl p-5 md:p-8" noValidate>
      <a href={hashOf(trigger.id)} className="caps flex items-center gap-2 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> {trigger.name}</a>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Icon className="size-5 text-primary-text" aria-hidden />Edit filter</h1>
      <p className="mt-2 text-body text-muted-foreground">{hook ? "Which signed requests start a run. Its URL and secret stay as they are." : app ? `Which ${app.source.event} events from ${app.source.server} start a run. Its event, its config and its instance on Composio stay as they are.` : "Which events from this server's GitHub App start a run."}</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className="mt-5 space-y-5">
        {hook ? <WebhookFilter signature={hook.source.signature ?? "standard"} rules={rules} onChange={setRules} issues={issues} cap={trigger.max_active_runs ?? null} />
          : app ? <AppFilter where={appFirst?.where ?? []} onChange={setWhere} issues={issues} others={appOthers.map((r) => r.event + (r.actions.trim() ? ` (${r.actions.trim()})` : ""))} />
          : <GitHubEvents picks={picks} onChange={setPicks} issues={issues} />}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? "Saving" : "Save filter"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go(hashOf(trigger.id))}>Cancel</Button>
      </div>
    </form>
  );
}

/** A trigger from an app's filter: conditions on the event's delivery, all of which must hold (none: every event of its
 *  instance starts a run). The event's data is under /data. `others`: rules made through the API, kept as they are. */
function AppFilter({ where, onChange, issues, others = [] }: { where: RuleDraft["where"]; onChange: (where: RuleDraft["where"]) => void; issues: Record<string, string>; others?: string[] }) {
  return (
    <fieldset className="min-w-0">
      <legend className="caps text-label text-muted-foreground">Filter <span className="font-normal normal-case">(optional)</span></legend>
      <div className="mt-2 space-y-3">
        <Said issues={issues} field="source.accept" />
        <Said issues={issues} field="source.accept[0]" />
        <p className="text-small text-muted-foreground">A condition reads what Composio delivers: the event's data is under /data, such as /data/title for a new issue's title.</p>
        <ConditionList name="composio" at="source.accept[0]" where={where} onChange={onChange} issues={issues} label="Only when" />
        {others.length > 0 && <p className="text-small text-muted-foreground" role="note">{others.length === 1 ? "One more rule, made through the API, is kept as it is" : `${others.length} more rules, made through the API, are kept as they are`}: {others.join(", ")}.</p>}
      </div>
    </fieldset>
  );
}

/** A feed trigger's last check, said where its page opens: whether it read, its words and when; and, when its newest
 *  firing is a note of its own that started nothing (a first check's start: the items already there), that note. */
function LastCheck({ check, newest }: { check: NonNullable<Trigger["last_check"]> | null; newest?: Firing }) {
  const note = newest && (newest.by === "feed" || newest.by === "email") && newest.status === "skipped" && !newest.run_id && newest.reason ? newest.reason : null;
  return (
    <section aria-label="Last check" data-last-check={!check ? "none" : check.ok ? "ok" : "failed"} className={`mt-4 border px-4 py-3 text-body ${check && !check.ok ? "border-warning/50 bg-warning/10" : "border-primary/50 bg-primary/5"}`}>
      <p className="caps text-label text-muted-foreground">{!check ? "Not checked yet" : `${check.ok ? "Last check" : "Last check failed"} · ${at(check.at)}`}</p>
      {check && <p className={`mt-1 break-words ${check.ok ? "" : "text-warning-text"}`}>{check.message}</p>}
      {note && <p className="mt-1 break-words" data-note>{note}</p>}
    </section>
  );
}

/** A new feed trigger, or `trigger`'s feeds to edit: 1 to 20 URLs a line, how often they are read (at least the server's
 *  `minEvery`), a JSON list's pointers behind their disclosure, and Only when on the item; a new one, the run each item
 *  starts. A create lands on the trigger's page, where its first check says what it watches from. An edit sends its
 *  source alone, as a PATCH, and only when it changed. */
function FeedForm({ v2, go, trigger, minEvery }: FormProps & { trigger?: FeedTrigger }) {
  const [draft, setDraft] = useState<FeedDraft>(() => (trigger ? feedDraftOf(trigger) : emptyFeed()));
  // An edit has no agent to pick: its agent and what each run is asked stay as they are.
  const { agents, agentCap, capRule, input, issues, setIssues, rest, setRest, saving, setSaving, keys, open, refused } = useTriggerCreate(v2, draft.agentId, !trigger);
  // The JSON list's pointers show open when the trigger has one.
  const [listOpen, setListOpen] = useState(() => !!trigger && (trigger.source.items !== undefined || trigger.source.id !== undefined));
  // An issue on a pointer opens the disclosure it sits under, so the error shows beside its field.
  useEffect(() => { if (issues["source.items"] || issues["source.id"]) setListOpen(true); }, [issues]);
  const set = <K extends keyof FeedDraft>(k: K) => (value: FeedDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const shown = feedFields(feedUrlsOf(draft.urls).urls.length, [draft.where.length, ...draft.others.map((r) => r.where.length)]);
    setRest([]);
    const fail = (err: unknown) => {
      if (!open.current) return;
      refused(issuesOf(err, input.keys), shown);
      setSaving(false);
    };
    if (trigger) {
      const { source, issues: found } = feedSourceOf(draft, minEvery);
      if (Object.keys(found).length) { setIssues(found); return; }
      setIssues({}); setSaving(true);
      try {
        if (!same(source, trigger.source)) await v2.updateTrigger(trigger.id, { source });
        if (open.current) go(hashOf(trigger.id));
      } catch (err) { fail(err); }
      return;
    }
    const { body, issues: missing } = feedBodyOf({ ...draft, shape: input.shape }, minEvery, capRule);
    input.setFieldIssues([]);
    if (!body) { setIssues(missing ?? {}); return; }
    setIssues({}); setSaving(true);
    try {
      const made = await v2.createTrigger(body, keys.keyFor("createTrigger", body));
      if (open.current) go(hashOf(made.id));
    } catch (err) { fail(err); }
  };
  const urlIssues = Object.entries(issues).filter(([k]) => /^source\.urls(\[\d+\])?$/.test(k));
  const others = draft.others.map((r) => r.event + (r.actions.trim() ? ` (${r.actions.trim()})` : ""));
  return (
    <form onSubmit={(e) => void save(e)} className="p-5 md:p-8" noValidate>
      <a href={trigger ? hashOf(trigger.id) : "#/triggers"} className="caps -my-1 inline-flex items-center gap-2 py-1 text-label text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> {trigger ? trigger.name : "Triggers"}</a>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold"><Rss className="size-5 text-primary-text" aria-hidden />{trigger ? "Edit feed" : "New feed trigger"}</h1>
      <p className="mt-2 text-body text-muted-foreground">{trigger ? "The feeds it reads, how often, and which items start a run. Its name, its agent and what each run is asked stay as they are." : "Each new or updated item in its feeds starts a capped run of the agent. The items already there when it is made start none: its first check, on its page once it is made, says how many."}</p>
      {rest.length > 0 && <div className="mt-4 border border-destructive/50 p-3 text-body text-destructive-text" role="alert">{rest.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className={`mt-5 ${formColumnsClass}`}>
        {!trigger && <Field label="Name" field="name" issue={issues.name}><Input name="name" value={draft.name} onChange={(e) => set("name")(e.target.value)} placeholder="vendor outages" /></Field>}
        <div className="min-w-0">
          <UiField className="min-w-0" label="Feed URLs" hint={`One a line, 1 to ${MAX_FEEDS}: RSS, Atom, JSON Feed, or an API's JSON list. Plain http is read on a public address alone.`}
            error={urlIssues.length ? <>{urlIssues.map(([k, v]) => <span key={k} data-issue={k} className="block">{v}</span>)}</> : undefined}>
            <Textarea name="urls" rows={4} className="p-3 font-mono text-small" value={draft.urls} onChange={(e) => set("urls")(e.target.value)} placeholder="https://www.githubstatus.com/history.atom" spellCheck={false} />
          </UiField>
          {trigger && <p className="mt-2 text-small text-warning-text" role="note">A feed you add starts from now: what's in it already won't start runs.</p>}
        </div>
        <Field label="Every" field="source.every_s" issue={issues["source.every_s"]} hint={minEvery ? atLeast(minEvery) : undefined}>
          <span className="flex gap-2">
            <Input name="every" inputMode="decimal" value={draft.every} onChange={(e) => set("every")(e.target.value)} placeholder="15" />
            <Picker id="feed-every-unit" name="everyUnit" label="Unit" className="w-32 shrink-0" value={draft.everyUnit} onChange={(v) => set("everyUnit")(v as FeedDraft["everyUnit"])}
              options={(["seconds", "minutes", "hours"] as const).map((u) => ({ value: u, label: u }))} />
          </span>
        </Field>
        <details data-json-list open={listOpen} onToggle={(e) => setListOpen(e.currentTarget.open)} className="min-w-0 border p-3">
          <summary className="cursor-pointer text-body font-semibold">JSON list <span className="font-normal text-small text-muted-foreground">(optional: a feed that is an API's JSON, such as GitHub's pull requests)</span></summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Items at" field="source.items" issue={issues["source.items"]} hint="A JSON Pointer to the array of items: empty for the whole document, /data/items for one inside it.">
              <Input name="items" value={draft.items} onChange={(e) => set("items")(e.target.value)} placeholder="/data/items" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Each item's id at" field="source.id" issue={issues["source.id"]} hint="A JSON Pointer into an item to what names it: empty for /id, /number for a pull request.">
              <Input name="id" value={draft.id} onChange={(e) => set("id")(e.target.value)} placeholder="/id" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        </details>
        <fieldset className="min-w-0">
          <legend className="caps text-label text-muted-foreground">Filter <span className="font-normal normal-case">(optional)</span></legend>
          <div className="mt-2 space-y-3">
            <Said issues={issues} field="source.accept" />
            <Said issues={issues} field="source.accept[0]" />
            <p className="text-small text-muted-foreground">A condition reads the item: /title, /link, /summary, /author, /categories, /feed/url, and /update (true for an item seen before that was updated). A JSON list's item is under /item.</p>
            <ConditionList name="feed" at="source.accept[0]" where={draft.where} onChange={set("where")} issues={issues} label="Only when" />
            {others.length > 0 && <p className="text-small text-muted-foreground" role="note">{others.length === 1 ? "One more rule, made through the API, is kept as it is" : `${others.length} more rules, made through the API, are kept as they are`}: {others.join(", ")}.</p>}
          </div>
        </fieldset>
        {!trigger && <>
          <RunTargetFields v2={v2} draft={draft} edit={(patch) => setDraft((d) => ({ ...d, ...patch }))} issues={issues} agents={agents} input={input} agentCap={agentCap} capRule={capRule} what="trigger" asked="The item comes with it: its title, link, summary and feed." />
        </>}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" size="lg" variant="solid" disabled={saving}>{saving ? (trigger ? "Saving" : "Creating") : trigger ? "Save feed" : "Create feed trigger"}</Button>
        <Button type="button" size="lg" variant="ghost" onClick={() => go(trigger ? hashOf(trigger.id) : "#/triggers")}>Cancel</Button>
      </div>
    </form>
  );
}
