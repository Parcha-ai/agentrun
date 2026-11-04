import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRunProvider, useAgentRun } from "./AgentRunProvider";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { SettingsPage } from "@/components/SettingsPage";
import { LiveRun } from "@/components/LiveRun";
import { MissionControl } from "@/components/MissionControl";
import { missionFrom, type MissionView, rangeFrom, type StatsRange } from "@/lib/mission";
import { Playground, type StartResult, startFailure } from "@/components/Playground";
import { type Agent, decisionProvider, toolOffers } from "@/lib/agentForm";
import { RUN_STATUSES, RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { SignIn } from "@/components/SignIn";
import { type AuthMode, authMode, signInProblem, takeSetupCode } from "@/lib/auth";
import { allPages, ClientError, createClient, type AgentRevision, type RunsFilter } from "@/lib/client";
import { appendRuns } from "@/lib/idempotency";
import type { Run, RunStatus } from "@/lib/v2";

/** `agent`: an agent's page (at `tab`), or with `edit` its editor; null is a new agent's editor. `runsOf`, `status` and
 *  `archived` (for runs): the runs list's filters. `settings`: a settings page. */
type Where = { section: Section; run?: string; agent?: string | null; edit?: boolean; tab?: string; runsOf?: string; archived?: boolean; status?: RunStatus; settings?: "keys"; startAgent?: string; startRevision?: string };
const addressId = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
/** The page an address opens. Exported for its test. */
export function route(h: string = location.hash): Where {
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: addressId(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  m = h.match(/^#\/agents\/([^/?]+)(?:\/([a-z]+))?$/);
  if (m) return { section: "agents", agent: addressId(m[1]), ...(m[2] === "edit" ? { edit: true } : m[2] ? { tab: m[2] } : {}) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) {
    const q = new URLSearchParams(h.split("?")[1]);
    return { section: "playground", ...(q.get("agent") ? { startAgent: q.get("agent")! } : {}), ...(q.get("revision") ? { startRevision: q.get("revision")! } : {}) };
  }
  // Settings, a page per address: #/settings/keys (and #/settings) for now; a later one is one more name here.
  m = h.match(/^#\/settings(?:\/(keys))?$/);
  if (m) return { section: "settings", settings: (m[1] ?? "keys") as "keys" };
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

/** The console over the server it is served from, behind its sign-in: agents, runs, and a run followed live. */
export function App() {
  const v2 = useMemo(() => createClient(), []);
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
  if (auth === null) return sessionError ? <div className="p-8" role="alert"><p>The server session could not be checked: {sessionError}</p><button type="button" className="mt-4 border px-4 py-2" onClick={() => { setSessionError(null); setGeneration((n) => n + 1); }}>Try again</button></div> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  if (auth !== "signed_in") {
    return (
      <SignIn key={auth} mode={auth} code={setupCode} onSubmit={async (password, code) => {
        try { await (auth === "setup" ? v2.setup(password, code) : v2.signIn(password)); sessionReads.current++; setGeneration((n) => n + 1); setAuth("signed_in"); return null; }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403 && auth === "setup") { await readSession().catch(() => {}); }
          return e instanceof ClientError ? signInProblem(e) : String(e);
        }
      }} />
    );
  }
  return <AgentRunProvider client={v2} session={{ id: "local-owner", authenticated: true, label: "Owner", kind: "local-owner", generation }} onUnauthorized={expired} onSignOut={signOut}>
    <AgentRunConsole />
  </AgentRunProvider>;
}

/** The reusable console. Identity, connection and optional private routes come from its host's provider. */
export function AgentRunConsole() {
  const context = useAgentRun();
  const { client: v2, session, serverId, capabilities: caps, capabilitiesError, refreshCapabilities, signOut, extensionRoutes } = context;
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [address, setAddress] = useState(() => location.hash);
  const where = useMemo(() => route(address), [address]);
  // Mission Control: the store's counts (GET /v2/stats) and the latest runs, read each time the page opens.
  const [mission, setMission] = useState<MissionView | null>(null);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [missionTry, setMissionTry] = useState(0);
  // The range and agent Mission Control's analytics are asked for; a change reads them again, the page kept meanwhile.
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const [statsAgent, setStatsAgent] = useState<string | null>(null);
  const [missionReading, setMissionReading] = useState(false);
  const [missionMore, setMissionMore] = useState(false);
  const missionAsked = useRef(0);
  const missionPages = useRef(1);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  // A complete lookup includes all supported lists. Only then does an absent name identify an agent that is gone.
  const [namesRead, setNamesRead] = useState(false);
  const namesAsked = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const go = (hash: string) => { location.hash = hash; setAddress(hash); };
  useEffect(() => { const on = () => setAddress(location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  // Refresh names across navigation, including active and archived agents. A partial answer keeps the names already
  // read, without treating an absent name as an agent that is gone. Only the newest request may update the lookup.
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
  }, [v2, caps, where]);

  const runsFilter: RunsFilter = { status: where.status, archived: where.archived };
  useEffect(() => {
    if (!caps || caps.features.runs?.list === false || where.section !== "runs" || where.run) return;
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setCursor(null); setMore(false); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, null, runsFilter) : v2.listRuns(50, null, runsFilter))
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)); });
    return () => { asked.current++; };
  }, [v2, where, caps]);
  // A name the lookup lacks while a read of it is under way shows as nothing yet, never as the id.
  const agentName = (id: string) => names[id] ?? (namesRead ? id : "");
  // The server lists its tools as objects (name, available, missing; an older one as names): the editor takes both.
  const editorCaps: EditorCaps = { harnesses: caps?.harnesses ?? [], tools: toolOffers(caps?.tools), thinking: caps?.features?.thinking ?? [], defaultModel: caps?.models?.default ?? undefined, agents: caps?.features.agents, archive: caps?.features.archive?.agents };
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", mission: "#/", settings: "#/settings/keys" }[s]);
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
      .catch((e) => { if (n === agentsAsked.current) setStartError(e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)); });
    return () => { agentsAsked.current++; };
  }, [v2, where.section, where.startAgent, retry, caps]);
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
          const page = await v2.listRuns(10, nextCursor);
          recent = appendRuns(recent, page.runs);
          nextCursor = page.next_cursor;
          if (!nextCursor) break;
        }
        return { runs: recent, next_cursor: nextCursor };
      };
      return Promise.all([
      v2.statsOver({ ...(from ? { from } : {}), ...(statsAgent ? { agent: statsAgent } : {}) }),
      readRecent(),
      Promise.all(statuses.map((status) => v2.listRuns(50, null, { status }))),
    ])
      .then(([s, r, pages]) => {
        if (!live || n !== missionAsked.current) return;
        const activity = appendRuns(r.runs, pages.flatMap((p) => p.runs));
        const reviews = activity.filter((run) => run.status === "completed" && run.review).length;
        setMission(missionFrom(s, r.runs, { nextCursor: r.next_cursor, readAt: Date.now(), activity, activityComplete: pages.every((p) => !p.next_cursor) && reviews >= (s.runs.needs_review ?? 0) }));
        setMissionError(null);
      })
      .catch((e) => { if (live && n === missionAsked.current) setMissionError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)); })
      .finally(() => { reading = false; if (live && n === missionAsked.current) { setMissionReading(false); setMissionMore(false); } });
    };
    void read();
    const poll = setInterval(() => { if (!reading) { setMissionReading(true); void read(); } }, 15000);
    return () => { live = false; clearInterval(poll); };
  }, [v2, where.section, missionTry, statsRange, statsAgent, caps]);
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
  const efforts = caps?.features.efforts ?? [];
  const extension = extensionRoutes.find((r) => r.path === location.hash);
  const settingsPage = <SettingsPage client={v2} capabilities={caps} session={session} serverLabel={serverId === "/v2" ? undefined : serverId} onCapabilitiesChange={() => { void refreshCapabilities().catch(() => {}); }} />;
  return (
    <Shell active={where.section} settings agents={caps?.features.agents?.list !== false} runs={caps?.features.runs?.list !== false} extensions={extensionRoutes} activeExtension={extension?.id} onExtensionNavigate={go} onNavigate={nav} onSignOut={signOut ? () => {
      // The card comes back only once the server ended the session: a sign-out that did not reach it says so instead.
      signOut().catch((e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
    } : undefined} signOutLabel={session.kind === "local-owner" ? "Sign out everywhere" : undefined}>
      {signOutError && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">Not signed out: {signOutError}</p>}
      {capabilitiesError && <p className="border-b px-5 py-3 text-[13px] text-destructive-text" role="alert">Capabilities could not be read: {capabilitiesError.message}</p>}
      {extension ? extension.render(context) : where.section === "settings" ? settingsPage : !caps ? <p role="status" className="p-8 font-mono text-[13px] text-muted-foreground">{capabilitiesError ? "Server capabilities are unavailable. Open Settings to retry." : "Reading server capabilities..."}</p>
        : where.section === "agents" && where.agent === undefined && caps.features.agents?.list === false
        ? <p role="status" className="p-8">Agent listing is unavailable on this server.</p>
        : ((where.section === "runs" && !where.run) || where.section === "mission") && caps.features.runs?.list === false
        ? <p role="status" className="p-8">Run listing is unavailable on this server.</p>
        : where.section === "playground" && caps.features.agents?.list === false
        ? <p role="status" className="p-8">Agent selection is unavailable on this server.</p>
        : where.section === "playground" && startError
        ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The agent selection could not be loaded: {startError}</p><button type="button" className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
        : where.section === "mission"
        ? <MissionControl view={mission} error={missionError} canCreate={caps.features.agents?.create !== false} filesSupported={caps.features.files?.read !== false} onRetry={() => setMissionTry((n) => n + 1)} onRefresh={() => setMissionTry((n) => n + 1)} loadingMore={missionMore}
            onMore={mission?.nextCursor ? () => {
              if (missionMore) return;
              missionPages.current++;
              setMissionMore(true);
              setMissionTry((n) => n + 1);
            } : undefined}
            scope={{ range: statsRange, onRange: setStatsRange, agent: statsAgent, onAgent: setStatsAgent, refreshing: missionReading && mission !== null }} />
        : where.section === "playground"
        ? agents && (!where.startAgent || pick === where.startAgent) ? <Playground agents={agents.filter((a) => !a.archived_at)} revisions={revs} revisionsError={revsError} efforts={efforts} origin={location.origin} apiBase={new URL(v2.endpoint, location.href).href} agentId={pick ?? undefined} revision={where.startRevision} onAgent={(id) => { setPick(id); go(`#/playground?agent=${encodeURIComponent(id)}`); }} onSend={send} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)}
            live={(id) => <LiveRun key={id} v2={v2} runId={id} caps={caps} agentName={agentName} />} /> : <p role="status" className="p-8 font-mono text-[13px] text-muted-foreground">Loading agents...</p>
        : where.section === "agents"
        ? where.agent === undefined ? <AgentsPage v2={v2} archived={!!where.archived} capabilities={caps} go={go} />
          : where.agent !== null && !where.edit ? <AgentPage key={where.agent} v2={v2} agentId={where.agent} tab={where.tab} capabilities={caps} defaultModel={editorCaps.defaultModel} modelSource={caps?.models?.source} efforts={efforts} go={go} />
          // A new decision agent's judge names the server's decision provider (agentForm's decisionProvider).
          : <AgentEditPage key={where.agent ?? "new"} v2={v2} caps={{ ...editorCaps, modelSource: caps?.models?.source, decisionProvider: decisionProvider(caps?.workflows) }} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            filter={runsFilter} onFilter={(f) => go(runsHash({ runsOf: where.runsOf, ...f }))}
            onMore={cursor ? () => {
              if (more) return;
              const n = asked.current;
              setMore(true);
              (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor, runsFilter) : v2.listRuns(50, cursor, runsFilter))
                .then((r) => { if (n === asked.current) { setRuns((x) => appendRuns(x ?? [], r.runs)); setCursor(r.next_cursor); } })
                .catch((e) => { if (n === asked.current) setError(String(e)); })
                .finally(() => { if (n === asked.current) setMore(false); });
            } : undefined} />}
    </Shell>
  );
}
