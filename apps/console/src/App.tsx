import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { KeysPage } from "@/components/KeysPage";
import { ConnectionProvider, Unreached, useLink, useResumed } from "@/components/Connection";
import { Settings, type SettingsPage } from "@/components/Settings";
import { ToolsPage } from "@/components/ToolsPage";
import { WebhookPage } from "@/components/WebhookPage";
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
import { allPages, type Capabilities, ClientError, createClient, type ImportOffer, type ImportState, problemOf, type RunsFilter } from "@/lib/client";
import { createConnection } from "@/lib/connection";
import { appendRuns, keeper, keepersByRun, sendOnce, uuid } from "@/lib/idempotency";
import { hasOwnRun, mergeNeeds, type Needs, pollSettled, rerunBody } from "@/lib/needs";
import { placesOf } from "@/lib/place";
import { type Problem, problem } from "@/lib/problem";
import { type Template, templateHarness, tryTemplate } from "@/lib/templates";
import { toolChoices } from "@/lib/toolSettings";
import type { Run, RunStatus } from "@/lib/v2";

/** `agent`: an agent's page (at `tab`), or with `edit` its editor; null is a new agent's editor. `runsOf`, `status` and
 *  `archived` (for runs): the runs list's filters. `settings`: a settings page. */
type Where = { section: Section; run?: string; agent?: string | null; edit?: boolean; tab?: string; runsOf?: string; archived?: boolean; status?: RunStatus; settings?: SettingsPage };
/** The page an address opens. Exported for its test. */
export function route(h: string = location.hash): Where {
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: decodeURIComponent(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  m = h.match(/^#\/agents\/([^/?]+)(?:\/([a-z]+))?$/);
  if (m) return { section: "agents", agent: decodeURIComponent(m[1]), ...(m[2] === "edit" ? { edit: true } : m[2] ? { tab: m[2] } : {}) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) return { section: "playground" };
  // Settings, a page per address: #/settings/keys (and #/settings), #/settings/tools and #/settings/webhook; a later one is one
  // more name here.
  m = h.match(/^#\/settings(?:\/(keys|tools|webhook))?$/);
  if (m) return { section: "settings", settings: (m[1] ?? "keys") as SettingsPage };
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
  // The setup code, taken from the address once and removed from it (and from the history entry).
  const [setupCode] = useState(setupCodeOnce);
  const readSession = async () => {
    const r = await v2.session();
    // A server without accounts: a protected read tells whether this browser is in already (a token it sends).
    const probe = r.status === 404 ? await v2.listAgents().then(() => 200, (e) => (e instanceof ClientError ? e.status : 0)) : undefined;
    setAuth(authMode(r, probe));
  };
  useEffect(() => { readSession().catch(() => setAuth("sign_in")); }, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
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
  if (auth === null) return <ConnectionProvider connection={connection}><Starting /></ConnectionProvider>;
  if (auth !== "signed_in") {
    return (
      <SignIn key={auth} mode={auth} code={setupCode} offer={offer} onSubmit={async (password, code, importSessions) => {
        try { await (auth === "setup" ? v2.setup(password, code, importSessions) : v2.signIn(password)); setAuth("signed_in"); return null; }
        catch (e) {
          // Another browser set the owner up first: the page reads the session again, which now asks to sign in.
          if (e instanceof ClientError && e.status === 403 && auth === "setup") { await readSession().catch(() => {}); }
          return e instanceof ClientError ? signInProblem(e) : e instanceof Error ? e.message : String(e);
        }
      }} />
    );
  }
  return <ConnectionProvider connection={connection}><Console v2={v2} onSignedOut={() => setAuth("sign_in")} /></ConnectionProvider>;
}

/** Before the console knows who is signed in: a quiet page, or, while the server can't be reached, that said with the
 *  next try (never the password page, where a password would go nowhere). */
function Starting() {
  return useLink().state === "offline" ? <Unreached /> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground" role="status">Connecting…</p>;
}

function Console({ v2, onSignedOut }: { v2: ReturnType<typeof createClient>; onSignedOut: () => void }) {
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [where, setWhere] = useState(() => route());
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Mission Control: the store's counts (GET /v2/stats) and the latest runs, read each time the page opens.
  const [mission, setMission] = useState<MissionView | null>(null);
  const [missionError, setMissionError] = useState<Problem | null>(null);
  const [missionTry, setMissionTry] = useState(0);
  // The range and agent Mission Control's analytics are asked for; a change reads them again, the page kept meanwhile.
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const [statsAgent, setStatsAgent] = useState<string | null>(null);
  const [missionReading, setMissionReading] = useState(false);
  // What needs a person on Mission Control: the runs asking a question, the failures of the last day, the runs at work;
  // read with the page, and again every 10 seconds while it is open. `ownRun`: whether anything of the owner's has run.
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [needsProblem, setNeedsProblem] = useState<string | null>(null);
  const [ownRun, setOwnRun] = useState<boolean | null>(null);
  const [needsTry, setNeedsTry] = useState(0);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  // Whether `names` is the whole answer of the newest read (both of its reads landed): a name it lacks then is an agent
  // gone, and shows as its id.
  const [namesRead, setNamesRead] = useState(false);
  const namesAsked = useRef(0);
  // The `refreshed` the names were last read for.
  const namesAfter = useRef(-1);
  const [error, setError] = useState<Problem | null>(null);
  const [runsTry, setRunsTry] = useState(0);
  const asked = useRef(0);
  const go = (hash: string) => { location.hash = hash; };
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
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  // The capabilities, read at the start and again after a settings save: only the newest read lands, so an answer to an
  // earlier read (two saves in a row) never puts back what an earlier save left.
  const capsAsked = useRef(0);
  // It answers whether the read landed, for a page that says so (Settings → Tools).
  const readCaps = () => { const n = ++capsAsked.current; return v2.capabilities().then((x) => { if (n === capsAsked.current) setCaps(x); return true; }, () => false); };
  useEffect(() => { readCaps(); }, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  // The agents' names, every page of the active ones and of the archived: read at the start, and again each time a runs
  // view opens (the list, one agent's runs, a run's page), so an agent made since, here or elsewhere, is named at once, and
  // again when an import at setup ends while this page watches (`refreshed`).
  // Only the newest read lands.
  useEffect(() => {
    if (namesAsked.current && where.section !== "runs" && namesAfter.current === refreshed) return;
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
  const runsFilter: RunsFilter = { status: where.status, archived: where.archived };
  useEffect(() => {
    if (where.section !== "runs" || where.run) return;
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, null, runsFilter) : v2.listRuns(50, null, runsFilter))
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(problem(e, "the runs")); });
  }, [v2, where, refreshed, runsTry]);
  // A name the lookup lacks while a read of it is under way shows as nothing yet, never as the id.
  const agentName = (id: string) => names[id] ?? (namesRead ? id : "");
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: unknown; features?: { thinking?: string[] }; models?: { default?: string; source?: string; route_prefix?: string | null } } | null;
  // The server lists its tools as objects (name, available, missing).
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: toolOffers(c?.tools), thinking: c?.features?.thinking ?? [], defaultModel: c?.models?.default };
  // The capabilities with a choice of provider (providers/1): Settings → Tools, and an agent's tool settings.
  const choices = toolChoices(c?.tools);
  // The settings pages this server has: tool keys (their routes), and tools (a capability with a choice of provider).
  const settingsOffered: SettingsPage[] = [...(caps?.features?.tool_keys?.routes ? ["keys" as const] : []), ...(choices.length ? ["tools" as const] : []), ...(caps?.features?.webhooks?.routes ? ["webhook" as const] : [])];
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", mission: "#/", settings: `#/settings/${settingsOffered[0] ?? "keys"}` }[s]);
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
  const [startError, setStartError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const agentsAsked = useRef(0);
  useEffect(() => {
    if (where.section !== "playground") return;
    setStartError(null);
    // Only the newest read lands: an earlier one answering late (the list before an import ended) never replaces it.
    const n = ++agentsAsked.current;
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents)
      .then((a) => {
        if (n !== agentsAsked.current) return;
        setAgents(a);
        // Keep the pick only while it is an active agent: one archived since is not offered, so not picked either.
        const active = a.filter((x) => !x.archived_at);
        setPick((p) => (p && active.some((x) => x.agent_id === p) ? p : active[0]?.agent_id ?? null));
      })
      .catch((e) => { if (n === agentsAsked.current) { const p = problem(e, "the agents"); setStartError(`${p.why} ${p.next}${p.said ? ` (${p.said})` : ""}`); } });
  }, [v2, where.section, retry, refreshed]);
  useEffect(() => {
    if (where.section !== "mission") return;
    let live = true;
    setMissionError(null); setMissionReading(true);
    const from = rangeFrom(statsRange);
    Promise.all([v2.statsOver({ ...(from ? { from } : {}), ...(statsAgent ? { agent: statsAgent } : {}) }), v2.listRuns(10)])
      .then(([s, r]) => {
        if (!live) return;
        setMission(missionFrom(s, r.runs));
        // Whether anything of the owner's has run, decided by a read of every agent; once it has, it stays so. The range
        // and agent filters show only once it has, so a filter never brings the start-here panel back.
        if (!statsAgent) setOwnRun((held) => held || hasOwnRun(r.runs, s.analytics.by_source));
      })
      .catch((e) => { if (live) setMissionError(problem(e, "Mission Control")); })
      .finally(() => { if (live) setMissionReading(false); });
    return () => { live = false; };
  }, [v2, where.section, missionTry, statsRange, statsAgent, refreshed]);
  // Back after the server was away: Mission Control reads again what may have moved meanwhile, keeping the page.
  useResumed(() => setMissionTry((n) => n + 1));
  useEffect(() => {
    if (where.section !== "mission") return;
    let live = true;
    // Up to 100 runs of each status, newest first; each read lands apart, and one that fails keeps its section's last answer.
    const upTo = (status: RunStatus) => allPages((cursor) => v2.listRuns(50, cursor, { status }), (p) => p.runs, 2);
    const read = () => Promise.allSettled([upTo("input_required"), upTo("failed"), upTo("working")])
      .then((reads) => {
        if (!live) return;
        const day = Date.now() - 86_400_000;
        setNeedsProblem(mergeNeeds(null, reads).problem);
        setNeeds((prev) => {
          const { needs: next } = mergeNeeds(prev, reads);
          return { asking: next.asking.filter((r) => r.pending), failed: next.failed.filter((r) => Date.parse(r.ended_at ?? r.created_at) > day), live: next.live };
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
      return startFailure(e, Math.round(performance.now() - t0));
    }
  };
  const efforts = ((caps as unknown as { features?: { efforts?: string[] } } | null)?.features?.efforts) ?? [];
  return (
    <Shell active={where.section} settings={settingsOffered.length > 0} onNavigate={nav} onSignOut={() => {
      // The card comes back only once the server ended the session: a sign-out that did not reach it says so instead.
      v2.signOut().then(onSignedOut, (e) => setSignOutError(e instanceof ClientError ? e.message : "The sign-out did not reach the server. Try again."));
    }}>
      {signOutError && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">Not signed out: {signOutError}</p>}
      {imported && (
        <p className="flex items-center gap-3 border-b bg-card px-5 py-3 font-mono text-[13px] md:px-8" role="status">
          <span className="flex-1">{importLine(imported)}</span>
          {imported.state !== "running" && <button type="button" className="caps border px-2 py-1 text-[11px] hover:bg-accent" onClick={() => setImported(null)}>Dismiss</button>}
        </p>
      )}
      {where.section === "playground" && startError
        ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The agents could not be read: {startError}</p><button type="button" className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
        : where.section === "settings"
        ? <Settings active={where.settings ?? "keys"} offered={settingsOffered}>
            {where.settings === "tools" ? <ToolsPage v2={v2} choices={choices} onSaved={readCaps} onOpen={readCaps} />
              : where.settings === "webhook" ? <WebhookPage v2={v2} atRest={caps?.features?.webhooks?.at_rest} />
              : <KeysPage v2={v2} atRest={caps?.features?.tool_keys?.at_rest} onChange={readCaps} />}
          </Settings>
        : where.section === "mission"
        ? <MissionControl view={mission} error={missionError} onRetry={() => setMissionTry((n) => n + 1)}
            scope={{ range: statsRange, onRange: setStatsRange, agent: statsAgent, onAgent: setStatsAgent, refreshing: missionReading && mission !== null }}
            needsYou={needs && <NeedsYouStrip asking={needs.asking} failed={needs.failed} live={needs.live} problem={needsProblem} agentName={agentName} onAnswer={answer} onRunAgain={runAgain} onStop={stop} />}
            startHere={ownRun === false ? <StartHere harnesses={editorCaps.harnesses} tools={editorCaps.tools} onTry={tryIt} imported={importedRuns} /> : undefined} />
        : where.section === "playground"
        ? agents && <Playground agents={agents.filter((a) => !a.archived_at)} revisions={revs} efforts={efforts} origin={location.origin} agentId={pick ?? undefined} onAgent={setPick} onSend={send} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)}
            live={(id) => <LiveRun key={id} v2={v2} runId={id} caps={caps} agentName={agentName} />} />
        : where.section === "agents"
        ? where.agent === undefined ? <AgentsPage key={refreshed} v2={v2} archived={!!where.archived} go={go} />
          : where.agent !== null && !where.edit ? <AgentPage key={where.agent} v2={v2} agentId={where.agent} tab={where.tab} defaultModel={editorCaps.defaultModel} modelSource={c?.models?.source} routePrefix={c?.models?.route_prefix} harnesses={editorCaps.harnesses} efforts={efforts} go={go} />
          // A new decision agent's judge names the server's decision provider (agentForm's decisionProvider).
          : <AgentEditPage key={where.agent ?? "new"} v2={v2} choices={choices} caps={{ ...editorCaps, modelSource: c?.models?.source, routePrefix: c?.models?.route_prefix, decisionProvider: decisionProvider((caps as unknown as { workflows?: Parameters<typeof decisionProvider>[0] } | null)?.workflows), places: placesOf(caps) }} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onRetry={() => setRunsTry((n) => n + 1)} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            filter={runsFilter} onFilter={(f) => go(runsHash({ runsOf: where.runsOf, ...f }))}
            onMore={cursor ? () => { const n = asked.current; setMore(true); (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor, runsFilter) : v2.listRuns(50, cursor, runsFilter)).then((r) => { if (n === asked.current) { setRuns((x) => appendRuns(x ?? [], r.runs)); setCursor(r.next_cursor); setError(null); } }).catch((e) => setError(problem(e, "more runs"))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
  );
}
