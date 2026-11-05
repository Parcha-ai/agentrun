import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRunProvider, useAgentRun } from "./AgentRunProvider";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { SettingsPage } from "@/components/SettingsPage";
import { ConnectionProvider, Unreached, useLink, useResumed } from "@/components/Connection";
import { Settings, type SettingsPage as SettingsSection } from "@/components/Settings";
import { ToolsPage } from "@/components/ToolsPage";
import { ModelKeyCard } from "@/components/ModelKeyCard";
import { NoModelBanner } from "@/components/NoModelBanner";
import { WebhookPage } from "@/components/WebhookPage";
import { ScheduleNames } from "@/components/ScheduleChip";
import { SchedulesPage } from "@/components/Schedules";
import { LiveRun } from "@/components/LiveRun";
import { MissionControl } from "@/components/MissionControl";
import { NeedsYouStrip } from "@/components/NeedsYouStrip";
import { StartHere } from "@/components/StartHere";
import { missionFrom, type MissionView, rangeFrom, type StatsRange } from "@/lib/mission";
import { Playground, type StartResult, startFailure } from "@/components/Playground";
import { type Agent, decisionProvider, toolOffers } from "@/lib/agentForm";
import { RUN_STATUSES, RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { SignIn } from "@/components/SignIn";
import { type AuthMode, authMode, signInProblem, takeSetupCode } from "@/lib/auth";
import { approvalRefusal } from "@/lib/approval";
import { trackHistory } from "@/lib/back";
import { allPages, type AgentRevision, ClientError, createClient, type ImportOffer, type ImportState, problemOf, type RunsFilter } from "@/lib/client";
import { createConnection } from "@/lib/connection";
import { appendRuns, keeper, keepersByRun, sendOnce, uuid } from "@/lib/idempotency";
import { asksPerson, hasOwnRun, mergeNeeds, type Needs, pollSettled, rerunBody } from "@/lib/needs";
import { placesOf } from "@/lib/place";
import { type Problem, problem } from "@/lib/problem";
import { type Template, templateHarness, tryTemplate } from "@/lib/templates";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { Run, RunStatus } from "@/lib/v2";

/** How often the console reads the capabilities again while no model is ready (NoModelBanner, ModelKeyCard). */
const MODEL_CHECK_MS = 10_000;

/** `agent`: an agent's page (at `tab`), or with `edit` its editor; null is a new agent's editor. `runsOf`, `status` and
 *  `archived` (for runs): the runs list's filters. `settings`: a settings page. */
type Where = { section: Section; run?: string; schedule?: string | null; agent?: string | null; edit?: boolean; tool?: string; tab?: string; notes?: string[]; runsOf?: string; archived?: boolean; status?: RunStatus; settings?: SettingsSection; startAgent?: string; startRevision?: string };
const addressId = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
/** The page an address opens. Exported for its test. */
export function route(h: string = location.hash): Where {
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: addressId(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  // An agent's notes, pointed at from a run: its Learning tab with each `note` to show.
  m = h.match(/^#\/agents\/([^/?]+)\/learning\?(.*)$/);
  if (m) return { section: "agents", agent: addressId(m[1]), tab: "learning", notes: new URLSearchParams(m[2]).getAll("note") };
  // An agent's Tools, on one tool's permission (a start refused for it links here).
  m = h.match(/^#\/agents\/([^/?]+)\/edit\?(.*)$/);
  if (m) { const tool = new URLSearchParams(m[2]).get("tool"); return { section: "agents", agent: addressId(m[1]), edit: true, ...(tool ? { tool } : {}) }; }
  m = h.match(/^#\/agents\/([^/?]+)(?:\/([a-z]+))?$/);
  if (m) return { section: "agents", agent: addressId(m[1]), ...(m[2] === "edit" ? { edit: true } : m[2] ? { tab: m[2] } : {}) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) {
    const q = new URLSearchParams(h.split("?")[1]);
    return { section: "playground", ...(q.get("agent") ? { startAgent: q.get("agent")! } : {}), ...(q.get("revision") ? { startRevision: q.get("revision")! } : {}) };
  }
  // Schedules: the list, a new one, one schedule, and its editor.
  if (h === "#/schedules/new") return { section: "schedules", schedule: null };
  m = h.match(/^#\/schedules\/([^/?]+)(\/edit)?$/);
  if (m) return { section: "schedules", schedule: addressId(m[1]), ...(m[2] ? { edit: true } : {}) };
  if (h.startsWith("#/schedules")) return { section: "schedules" };
  // Settings, a page per address: #/settings/keys (and #/settings), #/settings/tools and #/settings/webhook; a later one is one
  // more name here.
  m = h.match(/^#\/settings(?:\/(keys|tools|webhook))?$/);
  if (m) return { section: "settings", settings: (m[1] ?? "keys") as SettingsSection };
  // Mission Control is the first page: the bare address, and the old start page's, land there.
  if (h === "" || h === "#" || h === "#/" || h.startsWith("#/start") || h.startsWith("#/mission")) return { section: "mission" };
  if (!h.startsWith("#/runs?")) return { section: "runs" };
  // The runs list's filters live in the address, so a reload keeps them: one agent, one state, the archived runs.
  const q = new URLSearchParams(h.slice("#/runs?".length));
  const agent = q.get("agent"), status = q.get("status") as RunStatus | null;
  return { section: "runs", ...(agent ? { runsOf: agent } : {}), ...(status && RUN_STATUSES.includes(status) ? { status } : {}), ...(q.get("archived") === "true" ? { archived: true } : {}) };
}

/** The runs list's address for these filters. Exported for its test. */
export function runsHash({ runsOf, status, archived }: { runsOf?: string } & RunsFilter): string {
  const q = new URLSearchParams();
  if (runsOf) q.set("agent", runsOf);
  if (status) q.set("status", status);
  if (archived) q.set("archived", "true");
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

/** How often the console reads an import under way, and how many failed reads in a row end its watch. */
export const IMPORT_POLL_MS = 1000;
const IMPORT_READ_TRIES = 30;

/** The import asked for at setup, as a line. */
function importLine(s: ImportState): string {
  if (s.state === "running") return "Importing this machine's sessions: agents appear as they arrive.";
  if (s.state === "stopped") return "The import of this machine's sessions stopped. It goes on when the server starts again.";
  const runs = `${s.runs.toLocaleString("en-US")} session${s.runs === 1 ? "" : "s"}`;
  return `Imported ${runs} into ${s.agents.toLocaleString("en-US")} agent${s.agents === 1 ? "" : "s"}${s.skipped ? `; ${s.skipped.toLocaleString("en-US")} left out` : ""}.`;
}

/** The console over the server it is served from, behind its sign-in: agents, runs, and a run followed live. Its reads
 *  ride out the server going away (lib/connection): they wait, and carry on once it answers. */
export function App() {
  const [connection] = useState(createConnection);
  const v2 = useMemo(() => createClient({ fetch: connection.fetch }), [connection]);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const [generation, setGeneration] = useState(0);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionReads = useRef(0);
  // The setup code, taken from the address once and removed from it (and from the history entry).
  const [setupCode] = useState(setupCodeOnce);
  const readSession = useCallback(async () => {
    const n = ++sessionReads.current;
    try {
      const r = await v2.session();
      // A server without accounts: a protected read tells whether this browser is in already (a token it sends).
      const probe = r.status === 404 ? await v2.listAgents().then(() => 200, (e) => (e instanceof ClientError ? e.status : 0)) : undefined;
      if (n === sessionReads.current) { setSessionError(null); setAuth(authMode(r, probe)); }
    } catch (e) {
      if (n === sessionReads.current) { setAuth(null); setSessionError(e instanceof Error ? e.message : String(e)); }
    }
  }, [v2]);
  const expired = useCallback(() => {
    setAuth(null);
    setSessionError(null);
    setGeneration((n) => n + 1);
  }, []);
  const signOut = useCallback(async () => { await v2.signOut(); sessionReads.current++; setGeneration((n) => n + 1); setAuth("sign_in"); }, [v2]);
  useEffect(() => { void readSession(); return () => { sessionReads.current++; }; }, [readSession, generation]);
  // Setup's box, offered at once where the server can import this machine's sessions (on loopback, before an owner), its
  // counts read until the server has them. A read that fails once the box shows leaves it, its count unknown; one that
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
  if (auth === null) return <ConnectionProvider connection={connection}>{sessionError ? <div className="p-8" role="alert"><p>The server session could not be checked: {sessionError}</p><button type="button" className="mt-4 border px-4 py-2" onClick={() => { setSessionError(null); setGeneration((n) => n + 1); }}>Try again</button></div> : <Starting />}</ConnectionProvider>;
  if (auth !== "signed_in") {
    return (
      <SignIn key={auth} mode={auth} code={setupCode} offer={offer} onSubmit={async (password, code, importSessions) => {
        try { await (auth === "setup" ? v2.setup(password, code, importSessions) : v2.signIn(password)); sessionReads.current++; setGeneration((n) => n + 1); setAuth("signed_in"); return null; }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403 && auth === "setup") { await readSession().catch(() => {}); }
          return e instanceof ClientError ? signInProblem(e) : e instanceof Error ? e.message : String(e);
        }
      }} />
    );
  }
  return <ConnectionProvider connection={connection}><AgentRunProvider client={v2} session={{ id: "local-owner", authenticated: true, label: "Owner", kind: "local-owner", generation }} onUnauthorized={expired} onSignOut={signOut}>
    <AgentRunConsole />
  </AgentRunProvider></ConnectionProvider>;
}

/** Before sign-in is known, a lost connection stays a connecting page instead of asking for a password. */
function Starting() {
  return useLink().state === "offline" ? <Unreached /> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground" role="status">Connecting…</p>;
}

/** The reusable console. Identity, connection and optional private routes come from its host's provider. */
export function AgentRunConsole() {
  const context = useAgentRun();
  const { client: v2, session, serverId, capabilities: caps, capabilitiesError, refreshCapabilities, signOut, extensionRoutes } = context;
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const readCaps = useCallback(() => refreshCapabilities().then(() => true, () => false), [refreshCapabilities]);
  const [address, setAddress] = useState(() => location.hash);
  const where = useMemo(() => route(address), [address]);
  // The schedules' names, for the chip on a run a schedule started: read where the server has schedules, again on each
  // page change (a schedule made or renamed shows by its name on its runs).
  const scheduling = caps?.features?.triggers?.routes === true;
  const [scheduleNames, setScheduleNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!scheduling) { setScheduleNames(new Map()); return; }
    let live = true;
    v2.listTriggers().then((r) => { if (live) setScheduleNames(new Map(r.triggers.map((t) => [t.id, t.name]))); }, () => {});
    return () => { live = false; };
  }, [v2, scheduling, where.section, where.schedule]);
  // Mission Control: the store's counts (GET /v2/stats) and the latest runs, read each time the page opens.
  const [mission, setMission] = useState<MissionView | null>(null);
  const [missionError, setMissionError] = useState<Problem | null>(null);
  const [missionTry, setMissionTry] = useState(0);
  // The range and agent Mission Control's analytics are asked for; a change reads them again, the page kept meanwhile.
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const [statsAgent, setStatsAgent] = useState<string | null>(null);
  const [missionReading, setMissionReading] = useState(false);
  const [missionMore, setMissionMore] = useState(false);
  const missionAsked = useRef(0);
  const missionPages = useRef(1);
  // What needs a person on Mission Control: the runs asking a question, the failures of the last day, the runs at work;
  // read with the page, and again every 10 seconds while it is open. `ownRun`: whether anything of the owner's has run.
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [needsProblem, setNeedsProblem] = useState<string | null>(null);
  const [ownRun, setOwnRun] = useState<boolean | null>(null);
  const [needsTry, setNeedsTry] = useState(0);
  // Whether the runs asking a person have been read at least once: until then the Needs input tile's count is unknown,
  // never the empty list a failed first read leaves (a later failure keeps the last list, and its count).
  const [askingRead, setAskingRead] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  // A complete lookup includes all supported lists. Only then does an absent name identify an agent that is gone.
  const [namesRead, setNamesRead] = useState(false);
  const namesAsked = useRef(0);
  const [error, setError] = useState<Problem | null>(null);
  const [runsTry, setRunsTry] = useState(0);
  const asked = useRef(0);
  const go = (hash: string) => { location.hash = hash; setAddress(hash); };
  useEffect(() => { const on = () => setAddress(location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
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
  useEffect(() => trackHistory(), []);
  // Names include active and archived agents, refresh after navigation or import, and ignore stale answers.
  useEffect(() => {
    const n = ++namesAsked.current;
    setNamesRead(false);
    if (!caps || caps.features.agents?.list === false) {
      setNames({});
      return;
    }
    const lists = caps.features.archive?.agents === false ? [false] : [false, true];
    void Promise.allSettled(lists.map((archived) => allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents))).then((reads) => {
      if (n !== namesAsked.current) return;
      const fresh = Object.fromEntries(reads.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((x) => [x.agent_id, x.definition.name ?? x.agent_id]));
      const whole = reads.every((r) => r.status === "fulfilled");
      setNames((held) => (whole ? fresh : { ...held, ...fresh }));
      setNamesRead(whole);
    });
    return () => { namesAsked.current++; };
  }, [v2, caps, where, refreshed]);
  const runsFilter: RunsFilter = { status: where.status, archived: where.archived };
  useEffect(() => {
    if (!caps || caps.features.runs?.list === false || where.section !== "runs" || where.run) return;
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setCursor(null); setMore(false); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, null, runsFilter) : v2.listRuns(50, null, runsFilter))
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(problem(e, "the runs")); });
    return () => { asked.current++; };
  }, [v2, where, refreshed, runsTry, caps]);
  // A name the lookup lacks while a read of it is under way shows as nothing yet, never as the id. An agent made since the
  // names were read (made here, then tried in the Playground) is named from the Playground's own list, read on opening it.
  const agentName = (id: string) => names[id] ?? agents?.find((a) => a.agent_id === id)?.definition.name ?? (namesRead ? id : "");
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: unknown; features?: { thinking?: string[] }; models?: { default?: string; source?: string; route_prefix?: string | null } } | null;
  // Whether a key saved in the first screen's card (ModelKeyCard) gives this server its model, so the start-here step can
  // point at the card: no model ready for want of a key, no AGENT_MODEL named (its provider's key may not be among the
  // card's), no gateway (a provider's key names no gateway model), and keys kept sealed (with no seal key every save is
  // refused). Anything else keeps the step's own setup text.
  const keyCardSavesModel = caps?.models?.ready === false && caps.models.needs !== "model" && !caps.models.default && caps.models.source !== "gateway"
    && !!caps.features?.tool_keys?.routes && caps.features.tool_keys.at_rest === "sealed";
  // The server lists its tools as objects (name, available, missing).
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: toolOffers(c?.tools), thinking: c?.features?.thinking ?? [], defaultModel: c?.models?.default, agents: caps?.features.agents, archive: caps?.features.archive?.agents };
  // The capabilities with a choice of provider (providers/1): Settings → Tools, and an agent's tool settings.
  const choices = toolChoices(c?.tools);
  // Each tool's permission (approvals/1): Settings → Tools, and an agent's tool settings. None from an older server.
  const gates = toolGates(c?.tools);
  // The settings pages this server has: tool keys (their routes), and tools (a capability with a choice of provider, or a
  // permission to set).
  const settingsOffered: SettingsSection[] = [...(caps?.features?.tool_keys?.routes ? ["keys" as const] : []), ...(choices.length || gates.length ? ["tools" as const] : []), ...(caps?.features?.webhooks?.routes ? ["webhook" as const] : [])];
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", mission: "#/", schedules: "#/schedules", settings: `#/settings/${settingsOffered[0] ?? "keys"}` }[s]);
  // One click on a template makes its agent (once) on the first harness with a model, runs it, and opens the run.
  // Try it keeps its start's key until a start lands: a click after a lost answer is the same start, not a second run.
  const templateKeys = useRef(keeper()).current;
  const tryIt = async (t: Template) => {
    if (caps?.features.agents?.create === false) return "Agent creation is unavailable on this server.";
    const harness = templateHarness(editorCaps.harnesses);
    if (!harness) return "This server has no model to run it on yet.";
    try { const id = await tryTemplate(v2, t, harness, templateKeys); go(`#/runs/${encodeURIComponent(id)}`); return null; } catch (e) { return problemOf(e); }
  };
  // How many runs came from an import (the start-here panel says so); `imported` is the import in progress.
  const importedRuns = (mission?.analytics?.by_source ?? []).filter((g) => g.source !== "live").reduce((n, g) => n + g.runs, 0);
  // The agents both start screens pick from, every page of them.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [revs, setRevs] = useState<AgentRevision[]>([]);
  const [revsError, setRevsError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const agentsAsked = useRef(0);
  useEffect(() => {
    const n = ++agentsAsked.current;
    if (!caps || caps.features.agents?.list === false || where.section !== "playground") return;
    setStartError(null);
    // Only the newest read lands, including a read started after an import.
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents)
      .then((a) => {
        if (n !== agentsAsked.current) return;
        setAgents(a);
        // Keep the pick only while it is an active agent: one archived since is not offered, so not picked either.
        const active = a.filter((x) => !x.archived_at);
        if (where.startAgent && !active.some((x) => x.agent_id === where.startAgent)) {
          setPick(null);
          setStartError("The requested agent is unavailable or archived. Select an active agent from the Agents page.");
          return;
        }
        setPick((p) => (where.startAgent && active.some((x) => x.agent_id === where.startAgent) ? where.startAgent : p && active.some((x) => x.agent_id === p) ? p : active[0]?.agent_id ?? null));
      })
      .catch((e) => { if (n === agentsAsked.current) { const p = problem(e, "the agents"); setStartError(`${p.why} ${p.next}${p.said ? ` (${p.said})` : ""}`); } });
    return () => { agentsAsked.current++; };
  }, [v2, where.section, where.startAgent, retry, refreshed, caps]);
  useEffect(() => {
    if (!caps || caps.features.runs?.list === false || where.section !== "mission") return;
    let live = true;
    let reading = false;
    setMissionError(null); setMissionReading(true);
    const from = rangeFrom(statsRange);
    const statuses: RunStatus[] = ["queued", "working", "input_required", "failed", ...(caps?.features.runs?.pause_workflow_runs ? ["paused" as const] : [])];
    const read = () => {
      reading = true;
      const n = ++missionAsked.current;
      const readRecent = async () => {
        let recent: Run[] = [], nextCursor: string | null = null;
        const count = missionPages.current;
        for (let i = 0; i < count; i++) {
          const page: { runs: Run[]; next_cursor: string | null } = await (statsAgent ? v2.listAgentRuns(statsAgent, 10, nextCursor) : v2.listRuns(10, nextCursor));
          recent = appendRuns(recent, page.runs);
          nextCursor = page.next_cursor;
          if (!nextCursor) break;
        }
        return { runs: recent, next_cursor: nextCursor };
      };
      return Promise.all([
      v2.statsOver({ ...(from ? { from } : {}), ...(statsAgent ? { agent: statsAgent } : {}) }),
      readRecent(),
      Promise.allSettled(statuses.map((status) => statsAgent ? v2.listAgentRuns(statsAgent, 50, null, { status }) : v2.listRuns(50, null, { status }))),
    ])
      .then(([s, r, pages]) => {
        if (!live || n !== missionAsked.current) return;
        const landed = pages.flatMap((p) => p.status === "fulfilled" ? [p.value] : []);
        const failed = pages.find((p) => p.status === "rejected");
        const activity = appendRuns(r.runs, landed.flatMap((p) => p.runs));
        const reviews = activity.filter((run) => run.status === "completed" && run.review).length;
        setMission(missionFrom(s, r.runs, { nextCursor: r.next_cursor, readAt: Date.now(), activity, activityComplete: landed.length === pages.length && landed.every((p) => !p.next_cursor) && reviews >= (s.runs.needs_review ?? 0) }));
        if (!statsAgent) setOwnRun((held) => held || hasOwnRun(r.runs, s.analytics?.by_source ?? []));
        setMissionError(failed?.status === "rejected" ? problem(failed.reason, "the activity lists") : null);
      })
      .catch((e) => { if (live && n === missionAsked.current) setMissionError(problem(e, "Mission Control")); })
      .finally(() => { reading = false; if (live && n === missionAsked.current) { setMissionReading(false); setMissionMore(false); } });
    };
    void read();
    const poll = setInterval(() => { if (!reading) { setMissionReading(true); void read(); } }, 15000);
    return () => { live = false; clearInterval(poll); };
  }, [v2, where.section, missionTry, statsRange, statsAgent, caps, refreshed]);
  // Back after the server was away: Mission Control reads again what may have moved meanwhile, keeping the page.
  useResumed(() => setMissionTry((n) => n + 1));
  useEffect(() => {
    if (!caps || caps.features.runs?.list === false || where.section !== "mission") return;
    let live = true;
    // Up to 100 runs of each status, newest first; each read lands apart, and one that fails keeps its section's last answer.
    const upTo = (status: RunStatus) => allPages((cursor) => v2.listRuns(50, cursor, { status }), (p) => p.runs, 2);
    const read = () => Promise.allSettled([upTo("input_required"), upTo("failed"), upTo("working")])
      .then((reads) => {
        if (!live) return;
        const day = Date.now() - 86_400_000;
        setNeedsProblem(mergeNeeds(null, reads).problem);
        if (reads[0]?.status === "fulfilled") setAskingRead(true);
        setNeeds((prev) => {
          const { needs: next } = mergeNeeds(prev, reads);
          return { asking: next.asking.filter(asksPerson), failed: next.failed.filter((r) => Date.parse(r.ended_at ?? r.created_at) > day), live: next.live };
        });
      });
    // Never two reads at once: the next starts 10 s after the last has settled, so an older one can't land last.
    const stop = pollSettled(read, 10_000);
    return () => { live = false; stop(); };
  }, [v2, where.section, needsTry, caps, refreshed]);
  // A key per run: an answer whose reply was lost keeps its key while another run is answered, so its retry is the same send.
  const answerKeys = useRef(keepersByRun()).current;
  // After an action the strip reads again in a moment, so an answered question or a run started again leaves it.
  const later = () => setTimeout(() => setNeedsTry((n) => n + 1), 2500);
  const answer = async (runId: string, text: string) => {
    try { await sendOnce(answerKeys(runId), runId, text, v2.sendMessage); later(); return null; } catch (e) { return problemOf(e); }
  };
  // A run is started again with its own whole first message (read from its timeline: a run's read carries no input),
  // its effort and its spend cap. Each start keeps its key until it lands, so a retry after a lost answer is the same
  // start; the runs that started are said, so they're never offered again.
  const againKeys = useRef(new Map<string, string>()).current;
  const runAgain = async (rs: readonly Run[]) => {
    const started: string[] = [];
    try {
      for (const r of rs) {
        const first = r.kind === "workflow" ? undefined : (await v2.getTimeline(r.run_id)).rows.find((row) => row.kind === "user_message");
        const start = rerunBody(r, first?.text);
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
  const approve = async (runId: string, approvalId: string, decision: "allow" | "deny", note?: string) => {
    let refused: string | null = null;
    try { await v2.answerApproval(runId, approvalId, decision, note); } catch (e) { refused = approvalRefusal(e); }
    setNeedsTry((n) => n + 1);
    return refused;
  };
  const revsAsked = useRef(0);
  useEffect(() => {
    // The picked agent's revisions only: the old ones go at once, and an answer for an earlier pick is dropped.
    const n = ++revsAsked.current;
    setRevs([]);
    setRevsError(null);
    if (where.section !== "playground") return;
    if (caps?.features.agents?.revisions === false) { setRevsError("Revision history is unavailable on this server."); return; }
    if (pick) allPages((cursor) => v2.listRevisions(pick, cursor), (p) => p.revisions).then((r) => { if (n === revsAsked.current) setRevs(r); }).catch((e) => { if (n === revsAsked.current) setRevsError(e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)); });
  }, [v2, pick, where.section, caps?.features.agents?.revisions]);
  const send = async (agentId: string, body: Parameters<typeof v2.startRun>[1], key: string): Promise<StartResult> => {
    const t0 = performance.now();
    try {
      const r = await v2.startRun(agentId, body, key);
      return { status: r.status, ms: Math.round(performance.now() - t0), body: r.run, runId: r.run.run_id };
    } catch (e) {
      return startFailure(e, Math.round(performance.now() - t0));
    }
  };
  const efforts = ((caps as unknown as { features?: { efforts?: string[] } } | null)?.features?.efforts) ?? [];
  // The server's learning switch: undefined until its capabilities are read, null on a server without learning.
  const learningCap = caps ? ((caps as unknown as { features?: { learning?: "on" | "off" } }).features?.learning ?? null) : undefined;
  editorCaps.learning = learningCap ?? undefined;
  // While no model is ready, the capabilities are read again every MODEL_CHECK_MS and whenever the page comes back into
  // view, so the bar (and the first screen's card) goes by itself once a key is set where the server starts, or saved.
  const modelsReady = caps?.models?.ready;
  useEffect(() => {
    if (modelsReady !== false) return;
    // Through the one guarded reader, so an older answer never undoes a newer one.
    const again = () => readCaps();
    const timer = setInterval(again, MODEL_CHECK_MS);
    window.addEventListener("focus", again);
    return () => { clearInterval(timer); window.removeEventListener("focus", again); };
  }, [v2, modelsReady, readCaps]);
  const extension = extensionRoutes.find((r) => r.path === address);
  const settingsPage = <SettingsPage client={v2} capabilities={caps} session={session} serverLabel={serverId === "/v2" ? undefined : serverId} onCapabilitiesChange={readCaps} />;
  return (
    <ScheduleNames.Provider value={scheduleNames}>
    <Shell active={where.section} settings schedules={scheduling} agents={caps?.features.agents?.list !== false} runs={caps?.features.runs?.list !== false} extensions={extensionRoutes} activeExtension={extension?.id} onExtensionNavigate={go} onNavigate={nav} signOutLabel={session.kind === "local-owner" ? "Sign out everywhere" : undefined} onSignOut={signOut ? () => {
      // The card comes back only once the server ended the session: a sign-out that did not reach it says so instead.
      void signOut().catch((e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
    } : undefined} banners={<>
      {signOutError && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">Not signed out: {signOutError}</p>}
      {imported && (
        <p className="flex items-center gap-3 border-b bg-card px-5 py-3 font-mono text-[13px] md:px-8" role="status">
          <span className="flex-1">{importLine(imported)}</span>
          {imported.state !== "running" && <button type="button" className="caps border px-2 py-1 text-[11px] hover:bg-accent" onClick={() => setImported(null)}>Dismiss</button>}
        </p>
      )}
      {caps?.models?.ready === false && where.section !== "mission" && <NoModelBanner needs={caps.models.needs} source={caps.models.source} model={caps.models.default} settings={caps.features?.tool_keys?.routes === true && caps.features.tool_keys.at_rest === "sealed"} />}
    </>}>
      {extension ? extension.render(context)
        : where.section === "settings"
        ? <Settings active={where.settings ?? "keys"} offered={settingsOffered}>
            {where.settings === "tools" && settingsOffered.includes("tools") ? <ToolsPage v2={v2} choices={choices} gates={gates} onSaved={readCaps} onOpen={readCaps} />
              : where.settings === "webhook" && settingsOffered.includes("webhook") ? <WebhookPage v2={v2} atRest={caps?.features?.webhooks?.at_rest} />
              : settingsPage}
          </Settings>
        : !caps ? <p role="status" className="p-8 font-mono text-[13px] text-muted-foreground">{capabilitiesError ? "Server capabilities are unavailable. Open Settings to retry." : "Reading server capabilities..."}</p>
        : where.section === "agents" && where.agent === undefined && caps.features.agents?.list === false
        ? <p role="status" className="p-8">Agent listing is unavailable on this server.</p>
        : ((where.section === "runs" && !where.run) || where.section === "mission") && caps.features.runs?.list === false
        ? <p role="status" className="p-8">Run listing is unavailable on this server.</p>
        : where.section === "schedules" && !scheduling ? <p role="status" className="p-8">Schedules are unavailable on this server.</p>
        : where.section === "playground" && caps.features.agents?.list === false
        ? <p role="status" className="p-8">Agent selection is unavailable on this server.</p>
        : where.section === "playground" && startError
        ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The agents could not be read: {startError}</p><button type="button" className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
        : where.section === "mission"
        // The first screen asks for a model key while the server says no agent that names no model runs here yet.
        ? <div className="flex h-full flex-col">
            {caps?.models?.ready === false && <ModelKeyCard v2={v2} needs={caps.models.needs} model={caps.models.default} atRest={caps.features.tool_keys?.at_rest} onSaved={readCaps} />}
            <div className="min-h-0 flex-1">
              <MissionControl view={mission} error={missionError} canCreate={caps.features.agents?.create !== false} filesSupported={caps.features.files?.read !== false} onRetry={() => setMissionTry((n) => n + 1)} onRefresh={() => setMissionTry((n) => n + 1)} loadingMore={missionMore}
                onMore={mission?.nextCursor ? () => { if (missionMore) return; missionPages.current++; setMissionMore(true); setMissionTry((n) => n + 1); } : undefined}
                scope={{ range: statsRange, onRange: setStatsRange, agent: statsAgent, onAgent: setStatsAgent, refreshing: missionReading && mission !== null }}
                asking={needs && askingRead ? needs.asking.length : null}
                needsYou={needs && <NeedsYouStrip asking={needs.asking} failed={needs.failed} live={needs.live} problem={needsProblem} agentName={agentName} onAnswer={answer} onApprove={approve} onRunAgain={runAgain} onStop={stop} />}
                startHere={ownRun === false && caps.features.agents?.create !== false ? <StartHere harnesses={editorCaps.harnesses} tools={editorCaps.tools} onTry={tryIt} imported={importedRuns}
                  keyCard={keyCardSavesModel} /> : undefined} />
            </div>
          </div>
        : where.section === "schedules"
        ? <SchedulesPage v2={v2} view={{ schedule: where.schedule, edit: where.edit }} go={go} agentName={agentName} minEvery={caps?.features?.triggers?.min_every_s} />
        : where.section === "playground"
        ? agents && (!where.startAgent || pick === where.startAgent) ? <Playground agents={agents.filter((a) => !a.archived_at)} revisions={revs} revisionsError={revsError} efforts={efforts} origin={location.origin} apiBase={new URL(v2.endpoint, location.href).href} agentId={pick ?? undefined} revision={where.startRevision} onAgent={(id) => { setPick(id); go(`#/playground?agent=${encodeURIComponent(id)}`); }} onSend={send} limits={caps?.limits} upload={v2.upload} removeUpload={v2.deleteUpload} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)}
            live={(id) => <LiveRun key={id} v2={v2} runId={id} caps={caps} agentName={agentName} />} /> : <p role="status" className="p-8 font-mono text-[13px] text-muted-foreground">Loading agents...</p>
        : where.section === "agents"
        ? where.agent === undefined ? <AgentsPage key={refreshed} v2={v2} archived={!!where.archived} capabilities={caps} go={go} />
          : where.agent !== null && !where.edit ? <AgentPage key={where.agent} v2={v2} agentId={where.agent} capabilities={caps} tab={where.tab} notes={where.notes} learning={learningCap} defaultModel={editorCaps.defaultModel} modelSource={c?.models?.source} routePrefix={c?.models?.route_prefix} harnesses={editorCaps.harnesses} efforts={efforts} limits={caps?.limits} go={go} />
          // A new decision agent's judge names the server's decision provider (agentForm's decisionProvider).
          : <AgentEditPage key={`${where.agent ?? "new"}:${where.tool ?? ""}`} v2={v2} choices={choices} gates={gates} focusTool={where.tool} caps={{ ...editorCaps, modelSource: c?.models?.source, routePrefix: c?.models?.route_prefix, decisionProvider: decisionProvider((caps as unknown as { workflows?: Parameters<typeof decisionProvider>[0] } | null)?.workflows), places: placesOf(caps) }} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onRetry={() => setRunsTry((n) => n + 1)} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            filter={runsFilter} onFilter={(f) => go(runsHash({ runsOf: where.runsOf, ...f }))}
            onMore={cursor ? () => {
              if (more) return;
              const n = asked.current;
              setMore(true);
              (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor, runsFilter) : v2.listRuns(50, cursor, runsFilter))
                .then((r) => { if (n === asked.current) { setRuns((x) => appendRuns(x ?? [], r.runs)); setCursor(r.next_cursor); setError(null); } })
                .catch((e) => { if (n === asked.current) setError(problem(e, "more runs")); })
                .finally(() => { if (n === asked.current) setMore(false); });
            } : undefined} />}
    </Shell>
    </ScheduleNames.Provider>
  );
}
