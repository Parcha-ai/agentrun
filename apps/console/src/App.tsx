import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { LiveRun } from "@/components/LiveRun";
import { MissionControl } from "@/components/MissionControl";
import { missionFrom, type MissionView, rangeFrom, type StatsRange } from "@/lib/mission";
import { Playground, type StartResult } from "@/components/Playground";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { RUN_STATUSES, RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { SignIn } from "@/components/SignIn";
import { type AuthMode, authMode, signInProblem, takeSetupCode } from "@/lib/auth";
import { allPages, type Capabilities, ClientError, createClient, type RunsFilter } from "@/lib/client";
import { appendRuns } from "@/lib/idempotency";
import type { Run, RunStatus } from "@/lib/v2";

/** `agent`: an agent's page (at `tab`), or with `edit` its editor; null is a new agent's editor. `runsOf`, `status` and
 *  `archived` (for runs): the runs list's filters. */
type Where = { section: Section; run?: string; agent?: string | null; edit?: boolean; tab?: string; runsOf?: string; archived?: boolean; status?: RunStatus };
/** The page an address opens. Exported for its test. */
export function route(h: string = location.hash): Where {
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: decodeURIComponent(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  m = h.match(/^#\/agents\/([^/?]+)(?:\/([a-z]+))?$/);
  if (m) return { section: "agents", agent: decodeURIComponent(m[1]), ...(m[2] === "edit" ? { edit: true } : m[2] ? { tab: m[2] } : {}) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) return { section: "playground" };
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
  // The setup code, taken from the address once and removed from it (and from the history entry).
  const [setupCode] = useState(setupCodeOnce);
  const readSession = async () => {
    const r = await v2.session();
    // A server without accounts: a protected read tells whether this browser is in already (a token it sends).
    const probe = r.status === 404 ? await v2.listAgents().then(() => 200, (e) => (e instanceof ClientError ? e.status : 0)) : undefined;
    setAuth(authMode(r, probe));
  };
  useEffect(() => { readSession().catch(() => setAuth("sign_in")); }, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  if (auth === null) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  if (auth !== "signed_in") {
    return (
      <SignIn key={auth} mode={auth} code={setupCode} onSubmit={async (password, code) => {
        try { await (auth === "setup" ? v2.setup(password, code) : v2.signIn(password)); setAuth("signed_in"); return null; }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403 && auth === "setup") { await readSession().catch(() => {}); }
          return e instanceof ClientError ? signInProblem(e) : String(e);
        }
      }} />
    );
  }
  return <Console v2={v2} onSignedOut={() => setAuth("sign_in")} />;
}

function Console({ v2, onSignedOut }: { v2: ReturnType<typeof createClient>; onSignedOut: () => void }) {
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [where, setWhere] = useState(() => route());
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Mission Control: the store's counts (GET /v2/stats) and the latest runs, read each time the page opens.
  const [mission, setMission] = useState<MissionView | null>(null);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [missionTry, setMissionTry] = useState(0);
  // The range and agent Mission Control's analytics are asked for; a change reads them again, the page kept meanwhile.
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const [statsAgent, setStatsAgent] = useState<string | null>(null);
  const [missionReading, setMissionReading] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const go = (hash: string) => { location.hash = hash; };
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => {
    v2.capabilities().then(setCaps).catch(() => {});
    // Every page of agents, for their names.
    (async () => {
      const all: Record<string, string> = {};
      for (let c: string | null | undefined = undefined, i = 0; i < 50; i++) {
        const page = await v2.listAgents({ cursor: c });
        for (const x of page.agents) all[x.agent_id] = x.definition.name ?? x.agent_id;
        if (!page.next_cursor) break;
        c = page.next_cursor;
      }
      setNames(all);
    })().catch(() => {});
  }, [v2]);
  const runsFilter: RunsFilter = { status: where.status, archived: where.archived };
  useEffect(() => {
    if (where.section !== "runs" || where.run) return;
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, null, runsFilter) : v2.listRuns(50, null, runsFilter))
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)); });
  }, [v2, where]);
  const agentName = (id: string) => names[id] ?? id;
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: unknown; features?: { thinking?: string[] }; models?: { default?: string; source?: string } } | null;
  // The server lists its tools as objects (name, available, missing; an older one as names): the editor takes both.
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: toolOffers(c?.tools), thinking: c?.features?.thinking ?? [], defaultModel: c?.models?.default, modelSource: c?.models?.source };
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", mission: "#/" }[s]);
  // The agents both start screens pick from, every page of them.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [revs, setRevs] = useState<{ revision: string; version: number; current: boolean; note: string | null }[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (where.section !== "playground") return;
    setStartError(null);
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents)
      .then((a) => {
        setAgents(a);
        // Keep the pick only while it is an active agent: one archived since is not offered, so not picked either.
        const active = a.filter((x) => !x.archived_at);
        setPick((p) => (p && active.some((x) => x.agent_id === p) ? p : active[0]?.agent_id ?? null));
      })
      .catch((e) => setStartError(e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)));
  }, [v2, where.section, retry]);
  useEffect(() => {
    if (where.section !== "mission") return;
    let live = true;
    setMissionError(null); setMissionReading(true);
    const from = rangeFrom(statsRange);
    Promise.all([v2.statsOver({ ...(from ? { from } : {}), ...(statsAgent ? { agent: statsAgent } : {}) }), v2.listRuns(10)])
      .then(([s, r]) => { if (live) setMission(missionFrom(s, r.runs)); })
      .catch((e) => { if (live) setMissionError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)); })
      .finally(() => { if (live) setMissionReading(false); });
    return () => { live = false; };
  }, [v2, where.section, missionTry, statsRange, statsAgent]);
  const revsAsked = useRef(0);
  useEffect(() => {
    // The picked agent's revisions only: the old ones go at once, and an answer for an earlier pick is dropped.
    const n = ++revsAsked.current;
    setRevs([]);
    if (pick) allPages((cursor) => v2.listRevisions(pick, cursor), (p) => p.revisions).then((r) => { if (n === revsAsked.current) setRevs(r); }).catch(() => {});
  }, [v2, pick]);
  const send = async (agentId: string, body: Parameters<typeof v2.startRun>[1], key: string): Promise<StartResult> => {
    const t0 = performance.now();
    try {
      const r = await v2.startRun(agentId, body, key);
      return { status: r.status, ms: Math.round(performance.now() - t0), body: r.run, runId: r.run.run_id };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      return e instanceof ClientError ? { status: e.status, ms, body: { error: { ...e.toApiError(), ...(e.fields ? { fields: e.fields } : {}) } } } : { status: 0, ms, body: { error: { code: "network", message: String(e) } } };
    }
  };
  const efforts = ((caps as unknown as { features?: { efforts?: string[] } } | null)?.features?.efforts) ?? [];
  return (
    <Shell active={where.section} onNavigate={nav} onSignOut={() => {
      // The card comes back only once the server ended the session: a sign-out that did not reach it says so instead.
      v2.signOut().then(onSignedOut, (e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
    }}>
      {signOutError && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">Not signed out: {signOutError}</p>}
      {where.section === "playground" && startError
        ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The agents could not be read: {startError}</p><button type="button" className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
        : where.section === "mission"
        ? <MissionControl view={mission} error={missionError} onRetry={() => setMissionTry((n) => n + 1)}
            scope={{ range: statsRange, onRange: setStatsRange, agent: statsAgent, onAgent: setStatsAgent, refreshing: missionReading && mission !== null }} />
        : where.section === "playground"
        ? agents && <Playground agents={agents.filter((a) => !a.archived_at)} revisions={revs} efforts={efforts} origin={location.origin} agentId={pick ?? undefined} onAgent={setPick} onSend={send} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)}
            live={(id) => <LiveRun key={id} v2={v2} runId={id} caps={caps} agentName={agentName} />} />
        : where.section === "agents"
        ? where.agent === undefined ? <AgentsPage v2={v2} archived={!!where.archived} go={go} />
          : where.agent !== null && !where.edit ? <AgentPage key={where.agent} v2={v2} agentId={where.agent} tab={where.tab} defaultModel={editorCaps.defaultModel} modelSource={editorCaps.modelSource} go={go} />
          : <AgentEditPage key={where.agent ?? "new"} v2={v2} caps={editorCaps} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            filter={runsFilter} onFilter={(f) => go(runsHash({ runsOf: where.runsOf, ...f }))}
            onMore={cursor ? () => { const n = asked.current; setMore(true); (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor, runsFilter) : v2.listRuns(50, cursor, runsFilter)).then((r) => { if (n === asked.current) { setRuns((x) => appendRuns(x ?? [], r.runs)); setCursor(r.next_cursor); } }).catch((e) => setError(String(e))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
  );
}
