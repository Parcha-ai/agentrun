import { backendSdkOf } from "@/lib/backendSdk";
import { ObservedSessionPage } from "@/components/ObservedSessions";
import { observationHash, useObservations } from "@/lib/observations";
import { useEffect, useMemo, useRef, useState } from "react";
import { Picker } from "@/components/ui";
import { Code, RefreshCw } from "lucide-react";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentDojo } from "@/components/AgentDojo";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { ChatGPTRow } from "@/components/ChatGPTSignIn";
import { ClaudeLoginRow } from "@/components/ClaudeLoginRow";
import { ModelGatewayRow } from "@/components/ModelGatewayRow";
import { BuildAgent } from "@/components/BuildAgent";
import { RunsRequest } from "@/components/RunsRequest";
import { queryPlaygroundHref } from "@/lib/playgroundRoutes";
import { AgentRequest, type AgentOperation } from "@/components/AgentRequest";
import { ApiKeysPage } from "@/components/ApiKeysPage";
import { KeysPage } from "@/components/KeysPage";
import { HarnessKeysPage } from "@/components/HarnessKeysPage";
import { ConnectionProvider, Unreached, useLink, useResumed } from "@/components/Connection";
import { Settings, type SettingsPage } from "@/components/Settings";
import { DemoBar, DemoPage } from "@/demo/DemoPage";
import { demoOn, demoUpload, onDemoChange, setDemo } from "@/demo/mode";
import { ToolsPage } from "@/components/ToolsPage";
import { GitHubPage } from "@/components/GitHubPage";
import { McpServersPage } from "@/components/McpServersPage";
import { useSecrets } from "@/lib/secrets";
import { ModelKeyCard } from "@/components/ModelKeyCard";
import { NoModelBanner } from "@/components/NoModelBanner";
import { EmailPage } from "@/components/EmailPage";
import { WebhookPage } from "@/components/WebhookPage";
import { SlackPage } from "@/components/SlackPage";
import { ComputersPage } from "@/components/ComputersPage";
import { WorkspacePage } from "@/components/WorkspacePage";
import { ScheduleNames, type TriggerKnown } from "@/components/ScheduleChip";
import { SchedulesPage } from "@/components/Schedules";
import { TemplatesPage } from "@/components/Templates";
import { SuggestionsPage } from "@/components/SuggestionsPage";
import { repoOfHash } from "@/lib/suggestions";
import { WrappedPage } from "@/components/WrappedPage";
import { LiveRun } from "@/components/LiveRun";
import { Race } from "@/components/Race";
import { RaceStart } from "@/components/RaceStart";
import { RunSkeleton } from "@/components/Skeleton";
import { TraceCompare } from "@/components/TraceCompare";
import { comparedIds } from "@/lib/traceCompare";
import { MissionControl } from "@/components/MissionControl";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { queryObservedSessionPrompt, queryRunsPrompt } from "@/lib/codingAgentPrompts";
import { NeedsYouStrip } from "@/components/NeedsYouStrip";
import { ConnectExistingAgents, NativeConnections } from "@/components/NativeConnections";
import { StartHere } from "@/components/StartHere";
import { missionFrom, type MissionView, rangeFrom, type StatsRange } from "@/lib/mission";
import { Playground, type StartResult, startFailure } from "@/components/Playground";
import type { MovedToRunner } from "@/components/RunnerOffer";
import { type Agent, decisionProvider, editBody, runsWhere, toolOffers } from "@/lib/agentForm";
import { computerFields } from "@/lib/computers";
import { RUN_STATUSES, RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { SessionUnread, SignIn } from "@/components/SignIn";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { type AuthMode, authMode, newCodeProblem, noAccounts, setupCodeRenewed, setupTakesCode, signInProblem, takeSetupCode } from "@/lib/auth";
import { approvalRefusal } from "@/lib/approval";
import { computerRefusal } from "@/lib/computerAsk";
import { stepsBack, trackHistory } from "@/lib/back";
import { holdsMove } from "@/lib/useUnsavedChangesGuard";
import { allPages, type Capabilities, ClientError, createClient, type ImportOffer, type ImportState, problemOf, type RunsFilter } from "@/lib/client";
import { chatGPTView } from "@/lib/chatgpt";
import { claudeLoginView, LOGIN_HARNESS, loginServes } from "@/lib/claudeLogin";
import { createConnection } from "@/lib/connection";
import type { ChatGPTView } from "@/lib/v2";
import { appendRuns, keeper, keepersByRun, sendOnce, uuid } from "@/lib/idempotency";
import { waitingOf } from "@/lib/learning";
import { asksPerson, FAILED_WINDOW_MS, failureCount, hasOwnRun, mergeNeeds, type Needs, pollSettled, rerunBody } from "@/lib/needs";
import { placesOf } from "@/lib/place";
import { type Problem, problem } from "@/lib/problem";
import { type Template, templateHarness, tryTemplate } from "@/lib/templates";
import { githubReturnOf } from "@/lib/github";
import { addOf, signInOf } from "@/lib/mcp";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { HandBackOutcome, Run, RunStatus } from "@/lib/v2";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

/** How often the console reads capabilities again while no model is ready for execution. */
const MODEL_CHECK_MS = 10_000;

/** `agent`: an agent's page (at `tab`), or with `edit` its editor; null is a new agent's editor. `runsOf`, `status` and
 *  `archived` (for runs): the runs list's filters. `race`: a race's label (lib/race.ts); `newRace`: the form that starts
 *  one. `compare`: the runs a comparison names (lib/traceCompare.ts). `settings`: a settings page. */
type Where = { year?: number; repo?: string; observation?: string; nativeConnect?: boolean; connectionSource?: "server" | "remote" | "observe"; section: Section; template?: string; install?: string; playgroundAgent?: string; operation?: AgentOperation | "list-runs" | "apply-template"; draft?: string; run?: string; race?: string; newRace?: boolean; compare?: string[]; trigger?: string | null; kind?: "schedule" | "webhook" | "github" | "composio" | "feed" | "email"; agent?: string | null; edit?: boolean; tool?: string; tab?: string; runsOf?: string; archived?: boolean; status?: RunStatus; source?: string; from?: string; to?: string; model?: string; settings?: SettingsPage; signIn?: ReturnType<typeof signInOf>; add?: ReturnType<typeof addOf>; github?: ReturnType<typeof githubReturnOf> };
/** The page an address opens. Exported for its test. */
export function route(h: string = location.hash): Where {
  if (h === "#/dojo") return { section: "dojo" };
  // A year of the work on this machine (WrappedPage): `?year=` opens another year.
  const wrapped = h.match(/^#\/wrapped(?:\?(.*))?$/);
  if (wrapped) { const year = new URLSearchParams(wrapped[1] ?? "").get("year"); return { section: "wrapped", ...(year && /^\d{4}$/.test(year) ? { year: Number(year) } : {}) }; }
  const observed = h.match(/^#\/observations\/([^/?]+)$/);
  if (observed) return { section: "agents", observation: decodeURIComponent(observed[1]) };
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: decodeURIComponent(m[1]) };
  // A race: the runs its race:<label> label groups, watched side by side, under Runs. #/races/new is the form that starts
  // one. A race this console starts is never labeled `new` (newRaceLabel); one an API caller labeled `new` is not
  // reachable here, and its runs still list under Runs with that label.
  if (h === "#/races/new") return { section: "runs", newRace: true };
  m = h.match(/^#\/races\/([^/?]+)$/);
  if (m) return { section: "runs", race: decodeURIComponent(m[1]) };
  // Two to four runs' Dev tools figures side by side (lib/traceCompare.ts), under Runs: the runs its query names.
  if (h === "#/compare" || h.startsWith("#/compare?")) return { section: "runs", compare: comparedIds(h.split("?")[1] ?? "") };
  if (h === "#/agents/connect" || h.startsWith("#/agents/connect?")) {
    const source = new URLSearchParams(h.split("?")[1] ?? "").get("source");
    return { section: "agents", nativeConnect: true, ...(source === "remote" || source === "observe" ? { connectionSource: source } : {}) };
  }
  if (h === "#/agents/new") return { section: "agents", agent: null };
  // An agent's Tools, on one tool's permission (a start refused for it links here).
  m = h.match(/^#\/agents\/([^/?]+)\/edit\?(.*)$/);
  if (m) { const tool = new URLSearchParams(m[2]).get("tool"); return { section: "agents", agent: decodeURIComponent(m[1]), edit: true, ...(tool ? { tool } : {}) }; }
  m = h.match(/^#\/agents\/([^/?]+)(?:\/([a-z]+))?$/);
  if (m) return { section: "agents", agent: decodeURIComponent(m[1]), ...(m[2] === "edit" ? { edit: true } : m[2] ? { tab: m[2] } : {}) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) {
    const params = new URLSearchParams(h.split("?")[1] ?? "");
    const agent = params.get("agent"), operation = params.get("operation"), draft = params.get("draft");
    if (operation === "apply-template") {
      const template = params.get("template");
      return { section: "playground", operation, ...(template ? { template } : {}), ...(draft !== null ? { draft } : {}) };
    }
    return { section: "playground", ...(agent ? { playgroundAgent: agent } : {}),
      ...(operation === "create-agent" || operation === "edit-agent" || operation === "list-runs" ? { operation } : {}), ...(draft !== null ? { draft } : {}),
      ...(operation === "list-runs" && RUN_STATUSES.includes(params.get("status") as RunStatus) ? { status: params.get("status") as RunStatus } : {}),
      ...(operation === "list-runs" && params.get("archived") === "true" ? { archived: true } : {}),
      ...(operation === "list-runs" && !agent && SOURCE_NAME.test(params.get("source") ?? "") ? { source: params.get("source")! } : {}),
      ...(operation === "list-runs" && !agent ? runsWindowOf(params) : {}) };
  }
  // Suggested agents: every scanned repository, or one first (`?repo=owner/name`).
  m = h.match(/^#\/suggestions(?:\?(.*))?$/);
  if (m) { const repo = repoOfHash(m[1]); return { section: "suggestions", ...(repo ? { repo } : {}) }; }
  // The server's templates: the list, and one template's Apply screen.
  // A package on GitHub, read before it is installed (its source in `src`, as an "Add from URL" box or a link sends it).
  m = h.match(/^#\/templates\/install\?(.*)$/);
  if (m) return { section: "templates", install: new URLSearchParams(m[1]).get("src") ?? "" };
  m = h.match(/^#\/templates\/([^/?]+)$/);
  if (m) return { section: "templates", template: decodeURIComponent(m[1]) };
  if (h.startsWith("#/templates")) return { section: "templates" };
  // Triggers: the list, a new one of each kind, one trigger, and its editor.
  if (h === "#/triggers/new") return { section: "triggers", trigger: null, kind: "schedule" };
  if (h === "#/triggers/new-webhook") return { section: "triggers", trigger: null, kind: "webhook" };
  if (h === "#/triggers/new-github") return { section: "triggers", trigger: null, kind: "github" };
  if (h === "#/triggers/new-composio") return { section: "triggers", trigger: null, kind: "composio" };
  if (h === "#/triggers/new-feed") return { section: "triggers", trigger: null, kind: "feed" };
  if (h === "#/triggers/new-email") return { section: "triggers", trigger: null, kind: "email" };
  m = h.match(/^#\/triggers\/([^/?]+)(\/edit)?$/);
  if (m) return { section: "triggers", trigger: decodeURIComponent(m[1]), ...(m[2] ? { edit: true } : {}) };
  if (h.startsWith("#/triggers")) return { section: "triggers" };
  // Settings, a page per address: #/settings/keys (and #/settings), #/settings/harness-keys, #/settings/api-keys,
  // #/settings/tools, #/settings/email, #/settings/computers, #/settings/workspace, #/settings/webhook and
  // #/settings/slack; a later one is one more name here.
  // #/settings/mcp, with an OAuth sign-in's outcome when the server sends the browser back there.
  m = h.match(/^#\/settings\/mcp(?:\?(.*))?$/);
  if (m) { const add = addOf(m[1]); return { section: "settings", settings: "mcp", signIn: signInOf(m[1]), ...(add ? { add } : {}) }; }
  // #/settings/github, with what the way back from GitHub said (github=connected, or error&reason=<code>).
  m = h.match(/^#\/settings\/github(?:\?(.*))?$/);
  if (m) { const github = githubReturnOf(m[1]); return { section: "settings", settings: "github", ...(github ? { github } : {}) }; }
  m = h.match(/^#\/settings(?:\/(keys|harness-keys|api-keys|tools|email|computers|workspace|webhook|slack|demo))?$/);
  if (m) return { section: "settings", settings: (m[1] ?? "keys") as SettingsPage };
  // Mission Control is the first page: the bare address, and the old start page's, land there.
  if (h === "" || h === "#" || h === "#/" || h.startsWith("#/start") || h.startsWith("#/mission")) return { section: "mission" };
  if (!h.startsWith("#/runs?")) return { section: "runs" };
  // The runs list's filters live in the address, so a reload keeps them: one agent, one state, the archived runs.
  const q = new URLSearchParams(h.slice("#/runs?".length));
  const agent = q.get("agent"), status = q.get("status") as RunStatus | null;
  return { section: "runs", ...(agent ? { runsOf: agent } : {}), ...(status && RUN_STATUSES.includes(status) ? { status } : {}), ...(q.get("archived") === "true" ? { archived: true } : {}), ...(!agent && SOURCE_NAME.test(q.get("source") ?? "") ? { source: q.get("source")! } : {}), ...(!agent ? runsWindowOf(q) : {}) };
}

/** A source's name as GET /v2/runs' `source` takes it (the server's own pattern). */
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A model's name as GET /v2/runs' `model` takes it (the server's own pattern): `provider/model`, as a run's metrics name it. */
const MODEL_NAME = /^[^\u0000-\u001f\u007f]{1,256}$/;

/** GET /v2/runs' window and model from an address: `from` and `to` as instants, `model` as given. A value that is no time
 *  is left out. */
function runsWindowOf(q: URLSearchParams): Pick<Where, "from" | "to" | "model"> {
  const from = runsInstant(q.get("from")), to = runsInstant(q.get("to")), model = q.get("model");
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(model !== null && MODEL_NAME.test(model) ? { model } : {}) };
}

/** An address's time as the instant GET /v2/runs takes (an RFC 3339 date-time with its zone). The server reads no time
 *  zone, so this browser's own stands in where the address names none: a date is its midnight here, a time without a zone
 *  is a time here. A day or an hour that does not exist (Feb 30, 24:00) is no time. */
function runsInstant(text: string | null): string | undefined {
  const m = text?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i);
  if (!m) return undefined;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((n) => (n === undefined ? undefined : Number(n)));
  const ms = Number((m[7] ?? "").padEnd(3, "0")), zone = m[8];
  const at = zone ? new Date(Date.UTC(y!, mo! - 1, d!, h, mi, s, ms)) : new Date(y!, mo! - 1, d!, h, mi, s, ms);
  const parts = zone ? [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()] : [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()];
  if (Number.isNaN(at.getTime()) || parts.join() !== [y, mo, d, h, mi, s].join()) return undefined;
  if (!zone || zone.toUpperCase() === "Z") return at.toISOString();
  const [zh, zm] = zone.slice(1).split(":").map(Number);
  if (zh > 23 || zm > 59) return undefined;
  return new Date(at.getTime() - (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm) * 60_000).toISOString();
}

/** The runs list is narrowed past its state and archive: to one source, a window or a model. */
const runsNarrowed = (f: RunsFilter): boolean => !!(f.source || f.from || f.to || f.model);

/** The runs list's address for these filters. Exported for its test. */
export function runsHash({ runsOf, status, archived, source, from, to, model }: { runsOf?: string } & RunsFilter): string {
  const q = new URLSearchParams();
  if (runsOf) q.set("agent", runsOf);
  if (status) q.set("status", status);
  if (archived) q.set("archived", "true");
  if (source && !runsOf) q.set("source", source);
  if (from && !runsOf) q.set("from", from);
  if (to && !runsOf) q.set("to", to);
  if (model && !runsOf) q.set("model", model);
  return `#/runs${q.size ? `?${q}` : ""}`;
}

/** The setup link's code, taken from the address once per page load and then kept: React may run a state initializer
 *  twice (StrictMode, in development), and a second read of an address already cleared would lose the code. */
let capturedSetup: { code: string | null } | undefined;
function setupCodeOnce(): string | null {
  if (!capturedSetup) {
    const { code, rest } = takeSetupCode(location.hash);
    if (code !== null) history.replaceState(null, "", `${location.pathname}${location.search}${rest}`);
    capturedSetup = { code };
  }
  return capturedSetup.code;
}

/** The wait before the `n`th next read of a session that couldn't be read (0 first): 1 s, doubling to 30 s, and never an
 *  end: a server that takes minutes to start (a host's first start, a redeploy) is read until it answers. */
export const sessionRetryMs = (n: number): number => Math.min(1000 * 2 ** n, 30_000);

/** How often the console reads an import under way, and how many failed reads in a row end its watch. */
export const IMPORT_POLL_MS = 1000;
const IMPORT_READ_TRIES = 30;

/** The import asked for at setup, as a line. */
function importLine(s: ImportState): string {
  if (s.state === "running") return "Importing this machine's sessions: agents appear as they arrive.";
  if (s.state === "stopped") return "The import of this machine's sessions stopped. It goes on when the server starts again.";
  if (s.state === "failed") return "The import of this machine's sessions was given up before it finished. The server's log says why.";
  const runs = `${s.runs.toLocaleString("en-US")} session${s.runs === 1 ? "" : "s"}`;
  return `Imported ${runs} into ${s.agents.toLocaleString("en-US")} agent${s.agents === 1 ? "" : "s"}${s.skipped ? `; ${s.skipped.toLocaleString("en-US")} left out` : ""}.`;
}

/** The console over the server it is served from, behind its sign-in: agents, runs, and a run followed live. Its reads
 *  ride out the server going away (lib/connection): they wait, and carry on once it answers. */
export function App() {
  const [connection] = useState(createConnection);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  // Signed out elsewhere (another tab's Sign out, an expiry): a read refused (401) is checked against the session, read
  // again. A session that ended turns the console to the page a fresh load shows (a password's sign-in, saying why, or a
  // server's link where it has no accounts); the address stays, so signing in again opens the same page. A refusal of a
  // read made under an older session, the session good again since, changes nothing. One check at a time.
  const [signedOutElsewhere, setSignedOutElsewhere] = useState(false);
  const authNow = useRef<AuthMode | null>(null);
  authNow.current = auth;
  const checking = useRef(false);
  const recheck = useRef<() => Promise<void>>(async () => {});
  const v2 = useMemo(() => createClient({ fetch: connection.fetch, onSignedOut: () => void recheck.current() }), [connection]);
  // Demo mode (Settings → Demo): the console over sample data, answered in this page (demo/backend), in place of the
  // server's. Its code and data are loaded only once it is on. The session stays the server's, so signing out still does.
  const [demo, setDemoNow] = useState(() => demoOn());
  useEffect(() => onDemoChange(setDemoNow), []);
  const [demoClient, setDemoClient] = useState<ReturnType<typeof createClient> | null>(null);
  useEffect(() => {
    if (!demo) { setDemoClient(null); return; }
    let live = true;
    import("@/demo/backend").then(({ createDemo }) => {
      if (!live) return;
      const made = createDemo({ real: connection.fetch });
      setDemoClient({ ...createClient({ fetch: made.fetch, onSignedOut: () => void recheck.current() }), fileUrl: made.fileUrl });
    }, () => { if (live) setDemo(false); });
    return () => { live = false; };
  }, [demo, connection]);
  // The setup code, taken from the address once and removed from it (and from the history entry).
  const [setupCode, setSetupCode] = useState(setupCodeOnce);
  // A setup link opened in this same tab once the page is up changes only the address's fragment: its code is taken
  // then too, and removed from the address and its history entry, as at load.
  useEffect(() => {
    if (auth !== "setup") return;
    const take = () => {
      const { code, rest } = takeSetupCode(location.hash);
      if (code === null) return;
      history.replaceState(null, "", `${location.pathname}${location.search}${rest}`);
      setSetupCode(code);
    };
    window.addEventListener("hashchange", take);
    // And one opened before setup showed (while the session read was on its way), whose change came before this listened.
    take();
    return () => window.removeEventListener("hashchange", take);
  }, [auth]);
  // Whether setup takes the server's printed code (its session read says so), so the form asks for it with no link.
  const [codeNeeded, setCodeNeeded] = useState(false);
  /** The mode the server's session asks for now, and whether its setup takes the printed code. */
  const sessionRead = async () => {
    const r = await v2.session();
    // A server without accounts: a protected read tells whether this browser is in already (a token it sends).
    const probe = noAccounts(r) ? await v2.listAgents().then(() => 200, (e) => (e instanceof ClientError ? e.status : 0)) : undefined;
    return { mode: authMode(r, probe), codeNeeded: setupTakesCode(r) };
  };
  const sessionMode = async () => {
    const read = await sessionRead();
    setCodeNeeded(read.codeNeeded);
    return read.mode;
  };
  const readSession = async () => setAuth(await sessionMode());
  recheck.current = async () => {
    if (authNow.current !== "signed_in" || checking.current) return;
    checking.current = true;
    try {
      const mode = await sessionMode();
      if (mode !== "signed_in" && authNow.current === "signed_in") { setSignedOutElsewhere(true); setAuth(mode); }
    } catch { /* the session could not be read: the console stays as it is, and the next refusal checks again */ }
    finally { checking.current = false; }
  };
  // The first read of the session decides the page. One that fails (the server's answer unreadable, a proxy's page in its
  // place, the connection cut) is said as it is and tried again, 1 s after the first, doubling to 30 s, with Retry now:
  // never a sign-in, which would claim the server has a password when the page can't know (#2222).
  const [sessionUnread, setSessionUnread] = useState<{ problem: string; starting: boolean } | null>(null);
  const [sessionTry, setSessionTry] = useState(0);
  // Only the newest read decides, and only while nothing has: an older one (a Retry now before it answered) that lands
  // after a newer one opened setup or sign-in, or after the owner signed in, changes nothing.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    sessionRead().then(
      (read) => {
        if (!live || authNow.current !== null) return;
        setCodeNeeded(read.codeNeeded);
        setAuth(read.mode);
        setSessionUnread(null);
      },
      (e) => {
        if (!live || authNow.current !== null) return;
        const ms = sessionRetryMs(sessionTry);
        // A refusal with no error of the server's own (http_error) is another's page in its place: the status alone. A
        // gateway's 502, 503 or 504 page is the host's edge while the server starts (on Render, about a minute after a
        // one-click create; again at a redeploy or a wake): said as starting, and asked again, with no end.
        const refusal = e instanceof ClientError ? e : null;
        const foreign = refusal?.code === "http_error";
        const starting = foreign && [502, 503, 504].includes(refusal!.status);
        setSessionUnread({
          problem: refusal === null ? problemOf(e) : starting ? `Its address answered ${refusal.status}, not the server.` : `GET /v2/auth/session answered ${refusal.status}${foreign ? ", not as this server answers" : `: ${refusal.message}`}`,
          starting,
        });
        timer = setTimeout(() => setSessionTry((n) => n + 1), ms);
      },
    );
    return () => { live = false; clearTimeout(timer); };
  }, [v2, sessionTry]); // eslint-disable-line react-hooks/exhaustive-deps
  // Setup's list, offered at once where the server can import this machine's sessions (on loopback, before an owner), its
  // projects read until the server has them. A read that fails once the offer shows leaves it, its projects unknown; one that
  // fails before it shows (a 5xx, the network) is tried again at the next poll while setup is open, so a passing failure
  // never hides the offer. A 404 or a 403 is the server offering none: no box, and no more reads.
  const [offer, setOffer] = useState<ImportOffer | null>(null);
  useEffect(() => {
    if (auth !== "setup") return;
    let live = true;
    (async () => {
      for (let shown = false; live; ) {
        const r = await v2.setupImport().then((x) => x, () => undefined);
        if (!live) return;
        if (r === undefined && shown) return void setOffer({ projects: null, sessions: null });
        if (r !== undefined) {
          if (!r || !("counting" in r || "sessions" in r)) return;
          setOffer(r);
          shown = true;
          if (!("counting" in r)) return;
        }
        await new Promise((done) => setTimeout(done, IMPORT_POLL_MS));
      }
    })();
    return () => { live = false; };
  }, [v2, auth]);
  if (auth === null && sessionUnread !== null) return <SessionUnread problem={sessionUnread.problem} starting={sessionUnread.starting} onRetry={() => setSessionTry((n) => n + 1)} />;
  if (auth === null) return <ConnectionProvider connection={connection}><Starting /></ConnectionProvider>;
  if (auth !== "signed_in") {
    return (
      <SignIn key={auth} mode={auth} code={setupCode} codeNeeded={codeNeeded} offer={offer} problem={signedOutElsewhere && auth === "sign_in" ? "You were signed out. Sign in to go on." : null} onSubmit={async (password, code, importProjects) => {
        try { await (auth === "setup" ? v2.setup(password, code, importProjects) : v2.signIn(password)); setSignedOutElsewhere(false); setAuth("signed_in"); return null; }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403 && auth === "setup") { await readSession().catch(() => {}); }
          return e instanceof ClientError ? signInProblem(e) : e instanceof Error ? e.message : String(e);
        }
      }} onNewCode={async () => {
        try { return setupCodeRenewed(window.location.hostname, await v2.setupCode()); }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403) await readSession().catch(() => {});
          throw new Error(e instanceof ClientError ? newCodeProblem(e) : e instanceof Error ? e.message : String(e));
        }
      }} />
    );
  }
  if (demo && !demoClient) return <p className="p-8 text-center font-mono text-body text-muted-foreground" role="status">Opening the demo…</p>;
  return <ConnectionProvider connection={connection}><Console v2={demo && demoClient ? demoClient : v2} demo={demo} onSignedOut={() => { setSignedOutElsewhere(false); setAuth("sign_in"); }} /></ConnectionProvider>;
}

/** Before the console knows who is signed in: a quiet page, or, while the server can't be reached, that said with the
 *  next try (never the password page, where a password would go nowhere). */
function Starting() {
  return useLink().state === "offline" ? <Unreached /> : <p className="p-8 text-center font-mono text-body text-muted-foreground" role="status">Connecting…</p>;
}

/** `demo`: the client answers from sample data (demo mode), so the console says so and offers the tour. */
type ConsoleProps = { v2: ReturnType<typeof createClient>; onSignedOut: () => void; demo?: boolean };
/** A replacement authenticated client tears down its cached pages before their next commit. */
export function Console(props: ConsoleProps) {
  const clientKey = useMemo(uuid, [props.v2]);
  return <ConsolePage key={clientKey} {...props} />;
}

function ConsolePage({ v2, onSignedOut, demo = false }: ConsoleProps) {
  // Whether this session may paste, replace or remove a secret: the owner's password session alone (secrets_writable).
  const { writable: secretsWritable, whyNot: secretsWhyNot } = useSecrets(v2);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [where, setWhere] = useState(() => route());
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // The triggers' names and kinds, for the chip on a run a trigger started: read where the server has triggers, again on
  // each page change (a trigger made or renamed shows by its name on its runs).
  const scheduling = caps?.features?.triggers?.routes === true;
  const [scheduleNames, setScheduleNames] = useState<ReadonlyMap<string, TriggerKnown>>(new Map());
  useEffect(() => {
    if (!scheduling) return;
    let live = true;
    v2.listTriggers().then((r) => { if (live) setScheduleNames(new Map(r.triggers.map((t) => [t.id, { name: t.name, kind: t.source.kind }]))); }, () => {});
    return () => { live = false; };
  }, [v2, scheduling, where.section, where.trigger]);
  // Mission Control: the store's counts (GET /v2/stats) and the latest runs, read each time the page opens.
  const [mission, setMission] = useState<MissionView | null>(null);
  const [missionError, setMissionError] = useState<Problem | null>(null);
  const [missionTry, setMissionTry] = useState(0);
  // The range and agent Mission Control's analytics are asked for; a change reads them again, the page kept meanwhile.
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const observedDays = statsRange === "7d" ? 7 : 30;
  // A race's page (where.race) is under Runs too, but shows no runs list: nothing there reads observations.
  const observations = useObservations(v2, { active: where.section === "mission" || (where.section === "runs" && !where.run && !where.race && !where.compare && !where.runsOf && !where.archived && !where.status && !runsNarrowed(where)), days: observedDays });
  const [statsAgent, setStatsAgent] = useState<string | null>(null);
  // Keep the selected identity through refreshes that temporarily clear the connection list.
  const [sessionSelected, setSessionSelected] = useState(false);
  const [missionReading, setMissionReading] = useState(false);
  // Automatic refresh must not invalidate a valid slow stats/recent-runs answer. User scope changes still replace it.
  const missionPending = useRef(false);
  // What needs a person on Mission Control: the runs asking a question, the failures of the last day, the runs at work;
  // read with the page, and again every 10 seconds while it is open. `ownRun`: whether anything of the owner's has run.
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [needsProblem, setNeedsProblem] = useState<string | null>(null);
  const [ownRun, setOwnRun] = useState<boolean | null>(null);
  const [needsTry, setNeedsTry] = useState(0);
  // The failed runs Mission Control's last read of Needs you listed (its effect below), kept across that effect's restarts.
  const failedSeenRef = useRef<Set<string> | null>(null);
  // Whether the runs asking a person have been read at least once: until then the Needs input tile's count is unknown,
  // never the empty list a failed first read leaves (a later failure keeps the last list, and its count).
  const [askingRead, setAskingRead] = useState(false);
  // The same for the failures of the last 24 h (the Failed tile) and the runs working now (Active's "running now").
  const [failedRead, setFailedRead] = useState(false);
  const [liveRead, setLiveRead] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  // Whether `names` is the whole answer of the newest read (both of its reads landed): a name it lacks then is an agent
  // gone, and shows as its id.
  const [namesRead, setNamesRead] = useState(false);
  const namesAsked = useRef(0);
  // The active agents whose learned workflows wait for their owner's OK, with how many (Needs you).
  const [learningWaits, setLearningWaits] = useState<{ agent_id: string; name: string; pending: number }[]>([]);
  const [missionAgents, setMissionAgents] = useState<Agent[] | null>(null);
  const [missionAgentsError, setMissionAgentsError] = useState<string | null>(null);
  // The `refreshed` the names were last read for.
  const namesAfter = useRef(-1);
  const [error, setError] = useState<Problem | null>(null);
  const [runsTry, setRunsTry] = useState(0);
  const asked = useRef(0);
  // A page with unsaved changes (the agent builder) holds a move away and asks first (lib/useUnsavedChangesGuard).
  const go = (hash: string) => { if (!holdsMove(hash)) location.hash = hash; };
  // The import asked for at setup (here, or before the server restarted): read until it ends, a failed read tried again.
  // One that ends while this page watches has what the page shows read again (`refreshed`).
  const [imported, setImported] = useState<ImportState | null>(null);
  const [refreshed, setRefreshed] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      let watched = false;
      for (let failed = 0; live && failed < IMPORT_READ_TRIES; ) {
        const s = await v2.setupImport().then((r) => r, () => undefined);
        if (!live) return;
        if (s === undefined) failed += 1;
        else {
          failed = 0;
          if (!s || !("state" in s)) return;
          setImported(s);
          if (s.state !== "running") return void (watched && setRefreshed((n) => n + 1));
          watched = true;
        }
        await new Promise((r) => setTimeout(r, IMPORT_POLL_MS));
      }
    })();
    return () => { live = false; };
  }, [v2]);
  // An address moved under a page with unsaved changes (a link, back or forward, one typed) is taken back, and the page
  // asks first; Leave makes the same move again, so a Back left by keeps going back. This listener is added before
  // trackHistory's (below), so it reads the move before that one counts it. history.go(0) would reload: never sent.
  useEffect(() => {
    const on = () => {
      const steps = stepsBack();
      if (holdsMove(location.hash, () => { if (steps) history.go(-steps); })) { if (steps) history.go(steps); }
      else setWhere(route());
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // Each history entry the console moves through is numbered, so a page's back arrow knows whether it came from one (lib/back).
  useEffect(() => trackHistory(), []);
  // The capabilities, read at the start and again after a settings save: only the newest read lands, so an answer to an
  // earlier read (two saves in a row) never puts back what an earlier save left.
  const capsAsked = useRef(0);
  // Whether the poll's timer below has a capabilities read still answering: it starts no other until that one ends.
  const capsPolling = useRef(false);
  // It answers whether the read landed, for a page that says so (Settings → Tools).
  // Whether the latest capabilities read failed: a row that waits on them (Claude Code's login) then asks as it would
  // with no capabilities at all, never hidden for the rest of the visit by one failed read; the race form says so, with
  // Try again, rather than loading for ever.
  const [capsFailed, setCapsFailed] = useState(false);
  // `fetchCaps` answers what it read, null when the read failed, for a caller that needs them now (the move to the runner).
  const fetchCaps = () => { const n = ++capsAsked.current; return v2.capabilities().then((x) => { if (n === capsAsked.current) { setCaps(x); setCapsFailed(false); } return x; }, () => { if (n === capsAsked.current) setCapsFailed(true); return null; }); };
  const readCaps = () => fetchCaps().then((x) => x !== null);
  useEffect(() => { readCaps(); }, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  // The agents' names, every page of the active ones and of the archived: read at the start, and again each time a runs
  // view, Mission Control or Triggers opens (the list, one agent's runs, a run's page, a trigger's page), so an agent made
  // since, here or elsewhere (a template's apply makes one with its triggers), is named at once, and again when an import
  // at setup ends while this page watches (`refreshed`). Only the newest read lands.
  useEffect(() => {
    if (namesAsked.current && where.section !== "runs" && where.section !== "mission" && where.section !== "triggers" && namesAfter.current === refreshed) return;
    namesAfter.current = refreshed;
    const n = ++namesAsked.current;
    setNamesRead(false);
    void Promise.allSettled([false, true].map((archived) => allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents))).then((reads) => {
      if (n !== namesAsked.current) return;
      const fresh = Object.fromEntries(reads.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((x) => [x.agent_id, x.definition.name ?? x.agent_id]));
      // Each read's answer is kept. Both landed: the names are theirs. One failed: what came back goes over the names
      // held, and the lookup is not complete, so a name it lacks (an agent the failed read would have named) shows as
      // nothing yet, never as an id read as gone; the next runs view reads again.
      const whole = reads.every((r) => r.status === "fulfilled");
      setNames((held) => (whole ? fresh : { ...held, ...fresh }));
      setNamesRead(whole);
    });
  }, [v2, where, refreshed]);
  const runsFilter: RunsFilter = { status: where.status, archived: where.archived, source: where.source, from: where.from, to: where.to, model: where.model };
  useEffect(() => {
    // A race's page reads its own runs (lib/race.ts), and its lanes keep their reads few: no runs list behind it.
    if (where.section !== "runs" || where.run || where.race || where.compare) return;
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, null, runsFilter) : v2.listRuns(50, null, runsFilter))
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(problem(e, "the runs")); });
  }, [v2, where, refreshed, runsTry]);
  // A name the lookup lacks while a read of it is under way shows as nothing yet, never as the id. An agent made since the
  // names were read (made here, then tried in the Playground) is named from the Playground's own list, read on opening it.
  const agentName = (id: string) => names[id] ?? agents?.find((a) => a.agent_id === id)?.definition.name ?? (namesRead ? id : "");
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: unknown; features?: { thinking?: string[] }; models?: { default?: string; source?: string; route_prefix?: string | null } } | null;
  // The server lists its tools as objects (name, available, missing).
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: toolOffers(c?.tools), thinking: c?.features?.thinking ?? [], ...(typeof caps?.limits?.free_model_requests === "number" ? { freeRequests: caps.limits.free_model_requests } : {}) };
  // The capabilities with a choice of provider (providers/1): Settings → Tools, and an agent's tool settings.
  const choices = toolChoices(c?.tools);
  // Each tool's permission (approvals/1): Settings → Tools, and an agent's tool settings.
  const gates = toolGates(c?.tools);
  // The settings pages this server has: tool keys (their routes), tools (a capability with a choice of provider, or a
  // permission to set), MCP servers, GitHub, computers and the workspace (every server has them), and the webhook (its routes).
  const settingsOffered: SettingsPage[] = [...(caps?.features?.tool_keys?.routes ? ["keys" as const] : []), ...(caps?.features?.harness_keys?.routes ? ["harness-keys" as const] : []), ...(caps?.features?.api_keys?.routes ? ["api-keys" as const] : []), ...(choices.length || gates.length ? ["tools" as const] : []), "mcp" as const, "github" as const, "email" as const, "computers" as const, "workspace" as const, ...(caps?.features?.webhooks?.routes ? ["webhook" as const] : []), ...(caps?.features?.slack?.routes ? ["slack" as const] : []), "demo" as const];
  // In demo mode Settings is the demo's page alone: the server's own settings are no part of the sample story, and are
  // kept out of what a demo shows.
  const settingsShown: SettingsPage[] = demo ? ["demo"] : settingsOffered;
  const settingsPage: SettingsPage = demo ? "demo" : where.settings ?? "keys";
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", dojo: "#/dojo", mission: "#/", triggers: "#/triggers", templates: "#/templates", suggestions: "#/suggestions", wrapped: "#/wrapped", settings: `#/settings/${settingsShown[0] ?? "keys"}` }[s]);
  // One click on a template makes its agent (once) on the first harness with a model, runs it, and opens the run.
  // Try it keeps its start's key until a start lands: a click after a lost answer is the same start, not a second run.
  const templateKeys = useRef(keeper()).current;
  const tryIt = async (t: Template) => {
    const harness = templateHarness(editorCaps.harnesses);
    if (!harness) return "This server has no model to run it on yet.";
    try { const id = await tryTemplate(v2, t, harness, templateKeys); go(`#/runs/${encodeURIComponent(id)}`); return null; } catch (e) { return problemOf(e); }
  };
  // How many runs came from an import (the start-here panel says so); `imported` is the import in progress.
  const importedRuns = (mission?.analytics.by_source ?? []).filter((g) => g.source !== "live").reduce((n, g) => n + g.runs, 0);
  // The agents both start screens pick from, every page of them.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [revs, setRevs] = useState<{ revision: string; version: number; current: boolean; note: string | null }[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  // The revision picked in the Playground ("" for the current one) and its definition, undefined when the page does not
  // hold it (Playground's onRevision). Another agent starts on its current revision.
  const [playgroundRevision, setPlaygroundRevision] = useState<{ revision: string; definition?: Record<string, unknown> }>({ revision: "" });
  const pickedAgent = useRef(pick);
  pickedAgent.current = pick;
  const [startError, setStartError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const agentsAsked = useRef(0);
  // A different client, page or requested agent starts with a fresh list. Background refreshes keep the request mounted.
  useEffect(() => { setAgents(null); setStartError(null); setPick(null); pickedAgent.current = null; }, [v2, where.section, where.operation, where.playgroundAgent]);
  useEffect(() => {
    if (where.section !== "playground" || where.operation) return;
    setStartError(null);
    // Only the newest read lands: an earlier one answering late (the list before an import ended) never replaces it.
    const n = ++agentsAsked.current;
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents)
      .then((a) => {
        if (n !== agentsAsked.current) return;
        // Keep the pick only while it is an active agent: one archived since is not offered, so not picked either.
        const active = a.filter((x) => !x.archived_at);
        const selected = pickedAgent.current ?? where.playgroundAgent;
        if (selected && !active.some((x) => x.agent_id === selected)) {
          setAgents(null);
          setPick(null);
          setStartError("The selected agent is unavailable or archived. Choose another agent from Agents.");
          return;
        }
        setAgents(a);
        setPick(selected ?? active[0]?.agent_id ?? null);
      })
      .catch((e) => { if (n === agentsAsked.current) { const p = problem(e, "the agents"); setStartError(`${p.why} ${p.next}${p.said ? ` (${p.said})` : ""}`); } });
    return () => { agentsAsked.current++; };
  }, [v2, where.section, where.operation, where.playgroundAgent, retry, refreshed]);
  useEffect(() => {
    if (where.section !== "mission") return;
    let live = true;
    missionPending.current = true;
    setMissionError(null); setMissionReading(true);
    const from = rangeFrom(statsRange);
    // A session's usage is queryable without pretending it is a server agent with its own run endpoint.
    Promise.all([v2.statsOver({ ...(from ? { from } : {}), ...(statsAgent ? { agent: statsAgent } : {}) }), sessionSelected ? Promise.resolve({ runs: [] }) : statsAgent ? v2.listAgentRuns(statsAgent, 10) : v2.listRuns(10)])
      .then(([s, r]) => {
        if (!live) return;
        setMission(missionFrom(s, r.runs));
        // Whether anything of the owner's has run; once it has, it stays so. This controls only the optional
        // introduction; imported history and analytics are always visible.
        if (!statsAgent) setOwnRun((held) => held || hasOwnRun(r.runs, s.analytics.by_source));
      })
      .catch((e) => { if (live) setMissionError(problem(e, "Mission Control")); })
      .finally(() => { if (live) { missionPending.current = false; setMissionReading(false); } });
    return () => { live = false; missionPending.current = false; };
  }, [v2, where.section, missionTry, statsRange, statsAgent, sessionSelected, refreshed]);
  // Back after the server was away: Mission Control reads again what may have moved meanwhile, keeping the page.
  useResumed(() => setMissionTry((n) => n + 1));
  // Coding-agent actions happen outside this tab. Read their results on return, and keep visible counts current.
  useEffect(() => {
    if (where.section !== "mission") return;
    const refresh = () => { if (!document.hidden && !missionPending.current) setMissionTry((n) => n + 1); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); clearInterval(timer); };
  }, [where.section]);
  useEffect(() => {
    // Left Mission Control: its counts are read afresh on the way back, so the failed runs seen start over.
    if (where.section !== "mission") { failedSeenRef.current = null; setMissionAgents(null); setMissionAgentsError(null); return; }
    let live = true;
    // The failed runs the last read listed: one it did not (a run that failed since) reads the page's counts again, so the
    // failed total under the Failed tile and list ("See all N") never falls behind them. GET /stats is no cheap read (the
    // store's counts and analytics, and every run's row), so it is read again only then, never on every poll. Kept across
    // the reads' restarts (Run again restarts them, needsTry): a run that fails before the restarted reads' first one is
    // still one the last read did not list.
    const failedSeen = failedSeenRef;
    // Up to 100 runs of each status, newest first; each read lands apart, and one that fails keeps its section's last answer.
    const upTo = (status: RunStatus) => allPages((cursor) => v2.listRuns(50, cursor, { status }), (p) => p.runs, 2);
    // With them, every active agent, for which wait for their owner's OK on what they learned (`learning.pending`): a
    // run that ends leaving learned workflows shows in Needs you at the next read. A failed read keeps the last answer.
    const waiting = () => allPages((cursor) => v2.listAgents({ archived: false, cursor }), (p) => p.agents)
      .then((agents) => { if (live) {
        setLearningWaits(agents.filter((a) => waitingOf(a) > 0).map((a) => ({ agent_id: a.agent_id, name: a.definition.name ?? a.agent_id, pending: waitingOf(a) })));
        // The dashboard and Agents page resolve source profiles through the same inventory.
        setMissionAgents(agents);
        setMissionAgentsError(null);
      } }, (error) => { if (live) setMissionAgentsError(problemOf(error)); });
    const read = () => Promise.allSettled([upTo("input_required"), upTo("failed"), upTo("working"), waiting()])
      .then(([asking, failed, working]) => {
        if (!live) return;
        const reads = [asking, failed, working];
        const day = Date.now() - FAILED_WINDOW_MS;
        setNeedsProblem(mergeNeeds(null, reads).problem);
        if (reads[0]?.status === "fulfilled") setAskingRead(true);
        if (reads[1]?.status === "fulfilled") {
          setFailedRead(true);
          const ids = reads[1].value.map((r) => r.run_id);
          const seen = failedSeen.current;
          if (seen && ids.some((id) => !seen.has(id))) setMissionTry((n) => n + 1);
          failedSeen.current = new Set(ids);
        }
        if (reads[2]?.status === "fulfilled") setLiveRead(true);
        setNeeds((prev) => {
          const { needs: next } = mergeNeeds(prev, reads);
          return { asking: next.asking.filter(asksPerson), failed: next.failed.filter((r) => Date.parse(r.ended_at ?? r.created_at) > day), live: next.live };
        });
      });
    // Never two reads at once: the next starts 10 s after the last has settled, so an older one can't land last.
    const stop = pollSettled(read, 10_000);
    return () => { live = false; stop(); };
  }, [v2, where.section, needsTry]);
  // A key per run: an answer whose reply was lost keeps its key while another run is answered, so its retry is the same send.
  const answerKeys = useRef(keepersByRun()).current;
  // After an action the strip reads again in a moment, so an answered question or a run started again leaves it.
  const later = () => setTimeout(() => setNeedsTry((n) => n + 1), 2500);
  const answer = async (runId: string, text: string) => {
    try { await sendOnce(answerKeys(runId), runId, text, v2.sendMessage); later(); return null; } catch (e) { return problemOf(e); }
  };
  // A run is started again with the input and files its read serves (a list's run carries none), its effort and its
  // spend cap. Each start keeps its key until it lands, so a retry after a lost answer is the same start; the runs that
  // started are said, so they're never offered again.
  const againKeys = useRef(new Map<string, string>()).current;
  const runAgain = async (rs: readonly Run[]) => {
    const started: string[] = [];
    try {
      for (const r of rs) {
        const start = rerunBody(r.kind === "workflow" ? r : await v2.getRun(r.run_id));
        if ("refusal" in start) throw new Error(start.refusal);
        const key = againKeys.get(r.run_id) ?? uuid();
        againKeys.set(r.run_id, key);
        await v2.startRun(r.agent_id, start.body, key);
        started.push(r.run_id);
      }
      later(); return { started, problem: null };
    } catch (e) { if (started.length) later(); return { started, problem: problemOf(e) }; }
  };
  const stop = async (runId: string) => {
    try { await v2.stop(runId); later(); return null; } catch (e) { return problemOf(e); }
  };
  // An approval's answer is in the run's state at once (the server keeps it before its 204): the strip reads again now,
  // after a refusal too, which may mean the run moved on.
  const approve = async (runId: string, approvalId: string, decision: "allow" | "deny", note?: string, confirmed?: true) => {
    let refused: string | null = null;
    try { await v2.answerApproval(runId, approvalId, decision, note, confirmed); } catch (e) { refused = approvalRefusal(e); }
    setNeedsTry((n) => n + 1);
    return refused;
  };
  // The agent's ask at its computer, answered from the strip (POST …/computer/hand-back): read again after it, a refusal
  // too, as an approval's is.
  const handBack = async (runId: string, outcome: HandBackOutcome) => {
    let refused: string | null = null;
    try { await v2.handBackComputer(runId, outcome); } catch (e) { refused = computerRefusal(e, "hand"); }
    setNeedsTry((n) => n + 1);
    return refused;
  };
  const revsAsked = useRef(0);
  /** Reads `agentId`'s revisions, every page: only the newest read lands. */
  const readRevisions = (agentId: string) => {
    const n = ++revsAsked.current;
    allPages((cursor) => v2.listRevisions(agentId, cursor), (p) => p.revisions).then((r) => { if (n === revsAsked.current) setRevs(r); }).catch(() => {});
  };
  useEffect(() => {
    // The picked agent's revisions only: the old ones go at once, and an answer for an earlier pick is dropped.
    ++revsAsked.current;
    setRevs([]);
    setPlaygroundRevision({ revision: "" });
    if (pick) readRevisions(pick);
  }, [v2, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Runs the Playground started: the Claude login is read again after each (claudeSignedIn below).
  const [runsStarted, setRunsStarted] = useState(0);
  const send = async (agentId: string, body: Parameters<typeof v2.startRun>[1], key: string): Promise<StartResult> => {
    const t0 = performance.now();
    try {
      const r = await v2.startRun(agentId, body, key);
      return { status: r.status, ms: Math.round(performance.now() - t0), body: r.run, runId: r.run.run_id };
    } catch (e) {
      return startFailure(e, Math.round(performance.now() - t0));
    } finally {
      setRunsStarted((n) => n + 1);
    }
  };
  // The Playground's offer under a run refused in a box while Claude Code's login, which runs agents on the runner only, is
  // on: the agent read now, saved with the edit its Computer step makes for a runner pick (computerFields), on the
  // version read, and the agents and the picked agent's revisions read again so the bar, the revision picker and the next
  // run see it there. An agent the edit leaves as it is (on the runner already: a second click, or a move made elsewhere)
  // is not saved again. Answers the revision the agent runs now and the box-only tools the move dropped. Which tools run
  // only in a box is the capabilities' word: taken before they answered, or after their read failed, the move reads them
  // itself, and when that read fails too it saves nothing and says so.
  const moveToRunner = async (agentId: string): Promise<MovedToRunner> => {
    const { agent, etag } = await v2.getAgent(agentId);
    const tools = agent.definition.tools ?? [];
    const fields = computerFields({ kind: "none" }, tools, editorCaps.tools)
      ?? computerFields({ kind: "none" }, tools, toolOffers((await fetchCaps() as unknown as { tools?: unknown } | null)?.tools));
    if (!fields) throw new Error("the server's tools could not be read, so which of them run only in a box is unknown. Try again.");
    const { unchanged, ...body } = editBody(agent, fields, "Moved to the runner, where Claude Code's login on this machine runs it");
    if (unchanged) return { revision: agent.revision, saved: false, dropped: [] };
    const kept = new Set(body.definition.tools ?? []);
    const dropped = (agent.definition.tools ?? []).filter((tool) => !kept.has(tool));
    const saved = await v2.updateDefinition(agentId, body, etag);
    setRetry((n) => n + 1);
    if (pickedAgent.current === agentId) readRevisions(agentId);
    return { revision: saved.agent.revision, saved: true, dropped };
  };
  const efforts = ((caps as unknown as { features?: { efforts?: string[] } } | null)?.features?.efforts) ?? [];
  // The server's learning switch: undefined until its capabilities are read, null on a server without learning.
  const learningCap = caps ? ((caps as unknown as { features?: { learning?: "on" | "off" } }).features?.learning ?? null) : undefined;
  editorCaps.learning = learningCap ?? undefined;
  // While no managed model is ready, read capabilities again every MODEL_CHECK_MS and when the page returns to view,
  // so execution and learning setup clear once their models are configured. Native connections use their own authentication.
  const modelsReady = caps?.models?.ready;
  useEffect(() => {
    if (modelsReady !== false && caps?.learning_model?.ready !== false) return;
    // Through the one guarded reader, so an older answer never undoes a newer one. The timer starts no read while its last
    // one is still answering: a read slower than MODEL_CHECK_MS would otherwise be overtaken by the next tick's, and its
    // answer dropped. Coming back into view always reads now, and that newer answer is the one that lands.
    const tick = () => {
      if (capsPolling.current) return;
      capsPolling.current = true;
      void readCaps().finally(() => { capsPolling.current = false; });
    };
    const again = () => readCaps();
    const timer = setInterval(tick, MODEL_CHECK_MS);
    window.addEventListener("focus", again);
    return () => { clearInterval(timer); window.removeEventListener("focus", again); };
  }, [v2, modelsReady, caps?.learning_model?.ready]);
  // The server's ChatGPT sign-in (chatgpt/1), read each time no model is ready: the first screen's card and the bar offer it
  // first. Null before it is read and on a server without it.
  const [plan, setPlan] = useState<ChatGPTView | null>(null);
  useEffect(() => {
    if (modelsReady !== false) return;
    let live = true;
    v2.chatGPT().then((body) => { if (live) setPlan(chatGPTView(body)); }, () => { if (live) setPlan(null); });
    return () => { live = false; };
  }, [v2, modelsReady]);
  // Claude Code's login on this machine, read while no model is ready on a server whose routes for it answer
  // (features.claude_login): once, again on leaving Settings, so a sign-in finished there shows (Settings' own row reads
  // it while there), and after a run starts. Each read runs `claude auth status` on the server, so a move between other
  // pages reads nothing. On and signed in, Claude Agent runs on it: for an agent on that harness it is a model, and the
  // bar goes; an agent on another harness still has none.
  const claudeLoginRoutes = caps?.features?.claude_login === true;
  const inSettings = where.section === "settings";
  const [claudeSignedIn, setClaudeSignedIn] = useState(false);
  useEffect(() => {
    if (modelsReady !== false || !claudeLoginRoutes) { setClaudeSignedIn(false); return; }
    if (inSettings) return;
    let live = true;
    v2.claudeLogin().then((body) => { if (live) setClaudeSignedIn(claudeLoginView(body)?.state === "signed_in"); }, () => { if (live) setClaudeSignedIn(false); });
    return () => { live = false; };
  }, [v2, modelsReady, claudeLoginRoutes, inSettings, runsStarted]);
  // The first screen's card stays from a sign-in's start until the person is done with OpenAI's words on usage, though the
  // server has its model by then.
  const [planShown, setPlanShown] = useState(false);
  const onPlan = (v: ChatGPTView) => {
    setPlan(v);
    if (v.state === "pending" || v.state === "signed_in") setPlanShown(true);
    if (v.state === "signed_in") void readCaps();
  };
  const selectedAgent = agents?.find((agent) => agent.agent_id === pick);
  const selectedDefinition = selectedAgent?.definition;
  // The run the Playground starts is the picked revision's: the "No model" bar reads its definition, the agent's current
  // one when none is picked. A picked revision the page holds no definition for is not known to run natively, on a
  // backend SDK or on the login, so the bar stays.
  const runDefinition: Record<string, unknown> | undefined = playgroundRevision.revision ? playgroundRevision.definition : selectedDefinition;
  const externalPlayground = runDefinition?.native || backendSdkOf(runDefinition);
  // The login is a model only for a run on the runner (serve's loginForRun): a run in a sandbox box goes on the model
  // keys. Where the run goes is its definition's own place, else where the server runs one that names none (runsWhere:
  // the server's default place for a revision with a shell tool, else the runner). Not known (the server's places not
  // read yet), the bar stays.
  const runPlace = runDefinition && selectedAgent ? runsWhere({ kind: selectedAgent.kind, definition: runDefinition as Agent["definition"] }, placesOf(caps))?.place : undefined;
  // The bar renders only in the Playground. With no agent picked there (no agents yet, or the agents still being read)
  // there is no run to read, only where a first agent would run: the new-agent form puts it on the server's default
  // place (newAgentPlace). So the bar goes only when that place is the runner, where a first agent on Claude Agent runs
  // on the login; on a box, or with the places not read yet, it stays, for every harness. A picked agent's run goes on
  // the login only for a model the login serves (loginServes): one naming an OpenRouter model still needs its key.
  const noAgentOnRunner = placesOf(caps)?.defaultPlace.mode === "runner";
  const onClaudeLogin = claudeSignedIn && caps?.models?.needs !== "model" && (!selectedAgent ? noAgentOnRunner : (runDefinition?.harness === LOGIN_HARNESS && loginServes(runDefinition.model) && runPlace?.mode === "runner"));
  const playgroundTarget = where.operation ? where.playgroundAgent : pick ?? where.playgroundAgent;
  // The playground's operation, first on its request row: the page's own row, or Start a run's beside its agent.
  // Under the request row: no model to run on yet, unless the run goes on Claude Code's login (onClaudeLogin).
  const noModel = !externalPlayground && caps?.models?.ready === false && !onClaudeLogin && <NoModelBanner needs={caps.models.needs} source={caps.models.source} model={caps.models.default} settings={caps.features?.tool_keys?.routes === true && caps.features.tool_keys.at_rest === "sealed"} chatgpt={plan?.state === "signed_out" || plan?.state === "expired"} />;
  const operationPicker = <>
    <label className="sr-only" htmlFor="api-operation">API operation</label>
    <Picker id="api-operation" label="API operation" steady value={where.operation ?? "run"} onChange={(operation) => {
      const target = playgroundTarget;
      const params = new URLSearchParams();
      if (operation !== "run") params.set("operation", operation);
      if (operation !== "create-agent" && operation !== "apply-template" && target) params.set("agent", target);
      go(`#/playground${params.size ? `?${params}` : ""}`);
    }} options={[{ value: "create-agent", label: "POST · Create an agent" }, { value: "apply-template", label: "POST · Apply a template" }, { value: "run", label: "POST · Start a run" }, { value: "list-runs", label: "GET · Query runs" }, { value: "edit-agent", label: "PUT · Edit agent", disabled: !playgroundTarget }]} />
  </>;
  return (
    <ScheduleNames.Provider value={scheduleNames}>
    <Shell active={where.section} building={where.section === "agents" && where.agent === null} onBuild={() => go("#/agents/new")} settings={settingsOffered.length > 0} triggers={scheduling} onNavigate={nav} onSignOut={() => {
      // The card comes back only once the server ended the session: a sign-out that did not reach it says so instead.
      // A sign-out leaves the page as a move does: a page with unsaved changes asks first, and Leave signs out.
      const out = () => void v2.signOut().then(onSignedOut, (e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
      if (!holdsMove(null, out)) out();
    }} onSignOutEverywhere={() => {
      const out = () => void v2.signOutEverywhere().then(onSignedOut, (e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
      if (!holdsMove(null, out)) out();
    }} banners={<>
      {/* Off lands on the switch's page: the address may name a sample run or agent, which the server has not. */}
      {demo && <DemoBar onOff={() => { setDemo(false); location.hash = "#/settings/demo"; }} />}
      {signOutError && <p className="border-b bg-card px-5 py-3 font-mono text-body text-destructive-text md:px-8" role="alert">Not signed out: {signOutError}</p>}
      {imported && (
        <p className="flex items-center gap-3 border-b bg-card px-5 py-3 font-mono text-body md:px-8" role="status">
          <span className="flex-1">{importLine(imported)}</span>
          {imported.state !== "running" && <Button size="xs" type="button" onClick={() => setImported(null)}>Dismiss</Button>}
        </p>
      )}
    </>}>
      {where.section === "settings"
        ? <Settings active={settingsPage} offered={settingsShown}>
            {settingsPage === "demo" ? <DemoPage on={demo} onChange={setDemo} v2={v2} go={go} />
              : where.settings === "harness-keys" ? <HarnessKeysPage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} onChange={() => void readCaps()} />
              : where.settings === "api-keys" ? <ApiKeysPage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} origin={location.origin} />
              : where.settings === "tools" ? <ToolsPage v2={v2} choices={choices} gates={gates} harnesses={editorCaps.harnesses} mcp={!!caps?.features?.mcp_client} onSaved={readCaps} onOpen={readCaps} />
              : where.settings === "mcp" ? <McpServersPage v2={v2} signIn={where.signIn} add={where.add} writable={secretsWritable} whyNot={secretsWhyNot} choices={choices} />
              : where.settings === "github" ? <GitHubPage v2={v2} returned={where.github} />
              : where.settings === "email" ? <EmailPage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} />
              : where.settings === "computers" ? <ComputersPage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} />
              : where.settings === "workspace" ? <WorkspacePage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} />
              : where.settings === "webhook" ? <WebhookPage v2={v2} />
              : where.settings === "slack" ? <SlackPage v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} />
              : <KeysPage v2={v2} onChange={readCaps} writable={secretsWritable} whyNot={secretsWhyNot} harnesses={editorCaps.harnesses}
                  plan={<><ChatGPTRow v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} source={caps?.models?.source} defaultModel={caps?.models?.default} routePrefix={caps?.models?.route_prefix} onChange={() => void readCaps()} /><ClaudeLoginRow v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} available={caps ? caps.features?.claude_login !== false : capsFailed} onChange={() => void readCaps()} /><ModelGatewayRow v2={v2} writable={secretsWritable} whyNot={secretsWhyNot} onChange={() => void readCaps()} /></>} />}
          </Settings>
        : where.section === "dojo"
        ? <AgentDojo key={refreshed} v2={v2} server={learningCap} modelAccess={caps?.learning_model} />
        : where.section === "mission"
        // Source connection and history browsing need no managed model; setup follows an explicit choice to run here.
        ? <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <MissionControl yearLink={!demo} observed={observations} agents={missionAgents} agentsError={missionAgentsError} view={mission} error={missionError} onRetry={() => setMissionTry((n) => n + 1)}
                actions={<><Button size="icon" aria-label="Refresh Mission Control" disabled={missionReading} onClick={() => { setMissionTry((n) => n + 1); setNeedsTry((n) => n + 1); observations.refresh(); }}><RefreshCw className="size-4" aria-hidden /></Button>{sessionSelected && statsAgent
                  ? <CodingAgentAction label="Ask about this session" prompt={queryObservedSessionPrompt(location.origin, statsAgent, rangeFrom(statsRange))} playgroundHref={observationHash(statsAgent)} playgroundLabel="Connected agent" />
                  : <CodingAgentAction label="Ask about runs" prompt={queryRunsPrompt(location.origin, statsAgent ?? undefined)} playgroundHref={queryPlaygroundHref(statsAgent ?? undefined)} />}<ConnectExistingAgents variant="primary" /></>}
                scope={{ range: statsRange, onRange: setStatsRange, agent: statsAgent, onAgent: id => { setSessionSelected(!!id && !!observations.data?.sessions.some(session => session.id === id)); setStatsAgent(id); }, refreshing: missionReading && mission !== null }}
                asking={needs && askingRead ? needs.asking.length : null} failed={needs && failedRead ? failureCount(needs.failed) : null} live={needs && liveRead ? needs.live.length : null}
                needsYou={needs && <NeedsYouStrip asking={needs.asking} failed={needs.failed} failedAll={mission?.runs.failed} live={needs.live} learning={learningWaits} problem={needsProblem} agentName={agentName} onAnswer={answer} onApprove={approve} onHandBack={handBack} onRunAgain={runAgain} onStop={stop} />}
                startHere={ownRun === false && !observations.data?.sessions.length ? <StartHere harnesses={editorCaps.harnesses} tools={editorCaps.tools} onTry={tryIt} imported={importedRuns}
                  keySettings={caps?.features?.tool_keys?.routes === true && caps.features.tool_keys.at_rest === "sealed"}
                  modelSetup={caps && (caps.models.ready === false || planShown) ? <ModelKeyCard v2={v2} needs={caps.models.needs} model={caps.models.default} source={caps.models.source} routePrefix={caps.models.route_prefix} capsRead={caps.models} onSaved={readCaps} writable={secretsWritable} whyNot={secretsWhyNot}
                    plan={plan} harnesses={editorCaps.harnesses} onPlan={onPlan} onDone={() => setPlanShown(false)} /> : undefined} /> : undefined} />
            </div>
          </div>
        : where.section === "wrapped"
        ? <WrappedPage v2={v2} year={where.year} go={go} />
        : where.section === "suggestions"
        ? <SuggestionsPage v2={v2} repo={where.repo} go={go} />
        : where.section === "templates"
        ? <TemplatesPage key={where.install !== undefined ? `install:${where.install}` : where.template ?? ""} v2={v2} name={where.template} install={where.install} go={go} />
        : where.section === "triggers"
        ? <SchedulesPage v2={v2} view={{ trigger: where.trigger, kind: where.kind, edit: where.edit }} go={go} agentName={agentName} minEvery={caps?.features?.triggers?.min_every_s} failuresToPause={caps?.features?.triggers?.failures_to_pause} publicUrl={caps?.features?.triggers?.public_url} />
        : where.section === "playground"
        ? <section className="flex h-full min-h-0 flex-col">
            <header className={cn(pageToolbarClass, "gap-2 px-5")}><h1 className={pageTitleClass}><Code className="size-4" aria-hidden />API playground</h1></header>
            {/* Start a run draws this row itself, with its agent beside the operation: one row, not two. */}
            {(where.operation || !agents) && <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3 md:px-6">
              {operationPicker}
              <span className="min-w-0 break-all font-mono text-small text-muted-foreground">{where.operation === "apply-template" ? `/v2/templates/${where.template ? encodeURIComponent(where.template) : "{template}"}/apply` : where.operation === "list-runs" ? (where.playgroundAgent ? `/v2/agents/${where.playgroundAgent}/runs` : "/v2/runs") : where.operation === "create-agent" ? "/v2/agents" : where.operation === "edit-agent" ? `/v2/agents/${where.playgroundAgent ?? "{agent_id}"}/definition` : "/v2/agents/{agent_id}/runs"}</span>
            </div>}
            {where.operation === "apply-template" ? <div className="min-h-0 flex-1 overflow-auto"><TemplatesPage key={where.template ?? ""} v2={v2} name={where.template} go={go} playground draft={where.draft} /></div> : where.operation === "list-runs" ? <RunsRequest key={`list:${where.playgroundAgent ?? ""}:${where.status ?? ""}:${where.archived ?? false}:${where.source ?? ""}:${where.from ?? ""}:${where.to ?? ""}:${where.model ?? ""}`} v2={v2} origin={location.origin} agentId={where.playgroundAgent} filter={{ status: where.status, archived: where.archived, source: where.source, from: where.from, to: where.to, model: where.model }} /> : where.operation ? <AgentRequest key={`${where.operation}:${where.playgroundAgent ?? ""}:${where.draft ?? ""}`} v2={v2} operation={where.operation} origin={location.origin} agentId={where.playgroundAgent} draft={where.draft} harnesses={editorCaps.harnesses} routePrefix={c?.models?.route_prefix} /> : <>
              {!agents && noModel}
              {startError && <div className="m-8 border p-4" role="alert"><p className="text-lead text-destructive-text">The agents could not be read: {startError}</p><Button size="sm" className="mt-3" type="button" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div>}
              {agents && <Playground lead={operationPicker} notice={noModel} agents={agents.filter((a) => !a.archived_at)} revisions={revs} efforts={efforts} origin={location.origin} agentId={pick ?? undefined} onAgent={setPick} onRevision={(revision, definition) => setPlaygroundRevision({ revision, definition })} onSend={send} limits={caps?.limits} {...(demo ? { upload: demoUpload } : {})} removeUpload={v2.deleteUpload} onMoveToRunner={moveToRunner} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)}
                live={(id) => <LiveRun key={id} v2={v2} runId={id} caps={caps} agentName={agentName} />} />}
            </>}
          </section>
        : where.section === "agents"
        ? where.observation ? <ObservedSessionPage v2={v2} sessionId={where.observation} go={go} /> : where.nativeConnect ? <NativeConnections v2={v2} go={go} initialSource={where.connectionSource} />
          : where.agent === undefined ? <AgentsPage key={refreshed} v2={v2} archived={!!where.archived} go={go} learning={learningCap} />
          : where.agent === null ? <BuildAgent origin={location.origin} v2={v2} caps={{ tools: editorCaps.tools, gates, places: placesOf(caps), mcp: !!caps?.features?.mcp_client, mcpHarnesses: caps?.features?.mcp_client?.harnesses }} />
          : where.agent !== null && !where.edit ? <AgentPage key={where.agent} v2={v2} agentId={where.agent} tab={where.tab} learning={learningCap} routePrefix={c?.models?.route_prefix} harnesses={editorCaps.harnesses} efforts={efforts} limits={caps?.limits} places={placesOf(caps)} go={go} {...(demo ? { upload: demoUpload } : {})} />
          // A new decision agent's judge names the server's decision provider (agentForm's decisionProvider).
          : <AgentEditPage key={`${where.agent ?? "new"}:${where.tool ?? ""}`} v2={v2} choices={choices} gates={gates} focusTool={where.tool} caps={{ ...editorCaps, routePrefix: c?.models?.route_prefix, decisionProvider: decisionProvider((caps as unknown as { workflows?: Parameters<typeof decisionProvider>[0] } | null)?.workflows), places: placesOf(caps), mcp: !!caps?.features?.mcp_client, mcpHarnesses: caps?.features?.mcp_client?.harnesses }} agentId={where.agent} go={go} />
        // The form picks its lanes from the harnesses once, so it waits for the capabilities' first read.
        : where.newRace ? (caps ? <RaceStart v2={v2} harnesses={editorCaps.harnesses} tools={editorCaps.tools} places={placesOf(caps)} go={go} />
          : capsFailed ? <div className="p-5 md:p-8"><Banner tone="error" actions={<Button size="xs" onClick={() => void readCaps()}>Try again</Button>}>The server's harnesses could not be read, so there is nothing to pick a lane from yet.</Banner></div>
          : <RunSkeleton />)
        : where.race ? <Race key={where.race} v2={v2} label={where.race} />
        : where.compare ? <TraceCompare key={where.compare.join(",")} v2={v2} ids={where.compare} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList observations={!where.runsOf && !where.archived && !where.status && !runsNarrowed(where) ? observations : undefined} runs={runs} agentName={agentName} agentId={where.runsOf} error={error} onRetry={() => setRunsTry((n) => n + 1)} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            filter={runsFilter} onFilter={(f) => go(runsHash({ runsOf: where.runsOf, ...f }))}
            onMore={cursor ? () => { const n = asked.current; setMore(true); (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor, runsFilter) : v2.listRuns(50, cursor, runsFilter)).then((r) => { if (n === asked.current) { setRuns((x) => appendRuns(x ?? [], r.runs)); setCursor(r.next_cursor); setError(null); } }).catch((e) => setError(problem(e, "more runs"))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
    </ScheduleNames.Provider>
  );
}
