// The demo's world: the story's agents and runs as the server's reads would say them at any moment, held in this page's
// memory. A run that is still going moves with the clock; an answer, an approval, a stop or a new run changes only this
// memory, and a reload starts the story again.
import { BATCH_DURATION, batchRunAt, fixturePages, juryRun, kybRun } from "@/demo/dwf/runs";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning } from "@/lib/learning";
import type { Stats } from "@/lib/mission";
import type { RunGraph } from "@/lib/runGraph";
import type { LearnedItem } from "@/lib/learning";
import type { Firing, GradeAnswer, GradeBody, LearningAudits, LearningCost, LearningLoop, Promotions, RaiseAnswer, Run, RunLearningRead, TemplateApply, TemplateApplied, TemplateView, RunTrace, RunUsage, TimelineRow, Trigger, TriggerCreate, TriggerInput, TriggerSecret, WorkflowRevisions } from "@/lib/v2";
import { nextFiring } from "./schedule";
import { type Beat, type GateAnswer, lengthOf, play, requestsOf, tokensFor, traceOf, usageOf, usageRow } from "./script";
import { AGENTS, CORRECTIONS_MD, DAY, type DemoAgent, HOUR, heroes, history, LEARNED_README, MIN, MODELS, REFUND_WORKFLOW, type RunStory, TAKEOVER_DAYS_AGO } from "./tale";

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
/** A stand-in for a commit or a revision id: 40 hex characters made from a name, the same at every load. */
export function hex(name: string, length = 40): string {
  let out = "";
  for (let i = 0, h = 2166136261; out.length < length; i++) {
    for (const ch of `${name}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

type Held = {
  story: RunStory;
  start: number;
  beats: Beat[] | null;
  answers: GateAnswer[];
  stopAt?: number;
  cancelled?: boolean;
  archivedAt?: number;
  /** A run whose end is in the past and can no longer move: its view, made once. */
  settled?: Run;
  /** What a person added after the story began: a message while it ran (steer), a follow-up once it ended, or the rest of
   *  a run a raised spend cap let go on. Each plays from its own start, after the story's own beats. */
  later?: Later[];
  /** A spend cap a person raised. */
  cap?: number;
  /** A workflow run paused now (since when), and how long its earlier pauses held it. */
  pausedAt?: number;
  pausedMs?: number;
  /** Where a workflow run's own clock stood when it was stopped (`stopAt` is when, by the wall clock). */
  stoppedAt?: number;
  grade?: GradeAnswer;
  /** The files a person picked for the run, at `inputs/<path>`. */
  files?: RunInputFile[];
  /** The words a wrong grade gave, which its correction round keeps. */
  gradeLabel?: string;
};
/** A file a person picked for a run, kept in the page: its upload id, its name and what it holds. */
export type RunInputFile = { id: string; path: string; text: string };
type Later = { kind: "steer" | "follow_up" | "resume"; start: number; beats: Beat[]; usd: number; stopAt?: number; cancelled?: boolean };

/** What each sample graph's decisions cost in all: a workflow run's cost is its graph's. */
const GRAPH_USD = { kyb: kybRun().totals.cost_usd ?? 0, jury: juryRun().totals.cost_usd ?? 0, batch: batchRunAt(BATCH_DURATION + 1).totals.cost_usd ?? 0 };
const GRAPH_MS = { kyb: kybRun().totals.elapsed_ms ?? 0, jury: juryRun().totals.elapsed_ms ?? 0, batch: BATCH_DURATION };

/** The one agent whose learning is told in full: its cost before and after, its checks and its audits. */
const FULL_STORY = "refund-desk";
const LEARNING_WORKFLOW = "refund-decision";
const LEARNING_DIGEST = hex("refund-decision:champion", 64);
const PENDING_WORKFLOW = "partial-refund-shipping";
/** How long a wrong grade's correction round takes: the run's learning reads `reflecting`, then `merged`. */
export const CORRECTION_MS = 3_000;

/** Replaces the sample merchant's name in a sample graph, so each run's graph names the merchant its title does. */
function renamed<T>(value: T, from: string, to: string): T {
  if (from === to) return value;
  return JSON.parse(JSON.stringify(value).split(from).join(to).split(from.toUpperCase()).join(to.toUpperCase())) as T;
}
/** A graph with every timestamp moved so the run starts at `start`. */
function retimed(g: RunGraph, start: number): RunGraph {
  const delta = start - Date.parse(g.run.startedAt);
  const text = JSON.stringify(g).replace(/"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/g, (_, t: string) => `"${iso(Date.parse(t) + delta)}"`);
  return JSON.parse(text) as RunGraph;
}
/** The KYB sample as it goes for a merchant whose record and certificate agree: the route is sure, and approves. */
function kybClean(g: RunGraph): RunGraph {
  const out = JSON.parse(JSON.stringify(g)) as RunGraph;
  for (const d of out.decisions) {
    if (d.id === "dec_kyb_cross") { d.answers = { ...d.answers, dates_consistent: { type: "noul", noul: 0.96 } }; d.action = { same_entity: true, same_state: true, dates_consistent: true }; }
    if (d.id === "dec_kyb_route") { d.answers = { branch: { type: "choice", choice: "approve", probabilities: { approve: 0.93, review: 0.06, reject: 0.01 }, confidence: 0.93 } }; d.action = { branch: "approve", taken: "approve" }; }
  }
  const review = out.nodes["/root/steps/3/branches/review/body"];
  out.nodes["/root/steps/3/branches/approve/body"] = { ...review };
  out.nodes["/root/steps/3/branches/review/body"] = { status: "not_run" };
  out.nodes["/root/steps/3"] = { ...out.nodes["/root/steps/3"], branch: "approve" };
  return out;
}

export type World = ReturnType<typeof createWorld>;

/** The demo's world, opened at `opened` (the story's "now"); `clock` says the present, which moves on from there. */
export function createWorld({ opened = Date.now(), clock = () => Date.now() }: { opened?: number; clock?: () => number } = {}) {
  // The story's agents, and after them the ones made in the demo.
  const list: DemoAgent[] = AGENTS.map((a) => ({ ...a }));
  const agents = new Map(list.map((a) => [a.id, a]));
  const held = new Map<string, Held>();
  const hold = (story: RunStory, start = opened - story.startAgo) => {
    const agent = agents.get(story.agent)!;
    // A learning agent's run ends with what its learning made of it.
    const beats = story.beats ? [...story.beats, ...(agent.learning ? [{ k: "learning", state: story.id === "demo-run-refund-by-agent" ? "merged" : "dropped", reason: story.id === "demo-run-refund-by-agent" ? null : "empty", detail: story.id === "demo-run-refund-by-agent" ? "Kept one correction from this run: quote the policy line in the note." : "Nothing new to keep from this run." } satisfies Beat] : [])] : null;
    // Each gate's answer, timed from when the gate asked: the story is played to find that moment.
    const answers: GateAnswer[] = [];
    for (const a of story.answered ?? []) {
      const p = play(beats ?? [], { start, now: Number.MAX_SAFE_INTEGER, answers });
      if (!p.pending) break;
      answers.push({ at: p.lastAt + a.afterMs, ...(a.text === undefined ? {} : { text: a.text }), ...(a.decision ? { decision: a.decision } : {}) });
    }
    const h: Held = { story, start, beats, answers };
    held.set(story.id, h);
    return h;
  };
  for (const s of [...history(opened), ...heroes()]) hold(s);

  const versionOf = (a: DemoAgent) => a.current ?? a.notes.length;
  const revisionOf = (a: DemoAgent, version = versionOf(a)) => hex(`${a.id}:rev:${version}`, 64);

  // ---- Runs ----

  /** Where a workflow run's own clock stands: the present, less the time its pauses held it. */
  const graphClock = (h: Held, now: number) => (h.pausedAt ?? now) - (h.pausedMs ?? 0);
  const graphOf = (h: Held, now: number): RunGraph | null => {
    const kind = h.story.graph;
    if (!kind) return null;
    const agent = agents.get(h.story.agent)!;
    const merchant = typeof h.story.input.merchant === "string" ? h.story.input.merchant : null;
    // A run stopped before its end stays as it stood then, whenever it is read.
    const stopped = h.stoppedAt !== undefined && h.stoppedAt < h.start + GRAPH_MS[kind];
    const at = stopped ? h.stoppedAt! : graphClock(h, now);
    const sample = kind === "batch" ? batchRunAt(Math.max(0, at - h.start)) : kind === "kyb" ? (h.story.review ? kybRun() : kybClean(kybRun())) : juryRun();
    const named = kind === "kyb" && merchant ? renamed(sample, "Corvane Analytics Inc.", merchant) : kind === "jury" && merchant ? renamed(sample, "Saltmarsh Outdoor Gear Co.", merchant) : sample;
    const g = retimed(named, h.start);
    return { ...g, run: { ...g.run, id: h.story.id, agent: agent.id, revision: revisionOf(agent), paused: h.pausedAt !== undefined && !stopped && at < h.start + GRAPH_MS[kind], ...(stopped ? { status: h.cancelled ? "cancelled" : "stopped", endedAt: iso(h.stopAt!) } : {}) }, read_at: iso(now) };
  };

  /** A run as GET /v2/runs/{id} says it at `now`. */
  const viewOf = (h: Held, now = clock()): Run => {
    if (h.settled) return h.archivedAt ? { ...h.settled, archived_at: iso(h.archivedAt) } : h.settled;
    const { story } = h;
    const agent = agents.get(story.agent)!;
    let status: Run["status"] = "working";
    let state: Run["state"] = "working";
    let endedAt: number | null = null;
    let pending: Run["pending"] = null;
    let usd = story.graph ? GRAPH_USD[story.graph] : story.usd;
    const whole = usd;
    let requests = 1;
    let finalAnswer: string | null = null;
    let failed = false;
    if (h.beats) {
      const p = play(h.beats, { start: h.start, now, answers: h.answers, stopAt: h.stopAt });
      requests = Math.max(p.requests, 1);
      failed = p.failed || (p.done && !!story.fails);
      if (h.stopAt !== undefined && !p.done) { status = h.cancelled ? "cancelled" : "completed"; state = "idle"; endedAt = h.stopAt; }
      else if (p.pending) { status = "input_required"; state = "waiting"; pending = p.pending; }
      else if (p.done) { status = failed ? "failed" : "completed"; state = "idle"; endedAt = p.lastAt; }
      if (!p.done) usd = whole * (p.requests / Math.max(p.requestsInAll, 1));
      finalAnswer = p.rows.findLast((r) => r.kind === "final_answer")?.text ?? null;
    } else {
      const length = GRAPH_MS[story.graph!];
      requests = story.graph === "batch" ? 20 : 4;
      if (h.stoppedAt !== undefined && h.stoppedAt < h.start + length) { status = h.cancelled ? "cancelled" : "completed"; state = "idle"; endedAt = h.stopAt!; usd = whole * ((h.stoppedAt - h.start) / length); }
      else if (graphClock(h, now) >= h.start + length) { status = "completed"; state = "idle"; endedAt = h.start + length + (h.pausedMs ?? 0); }
      else usd = whole * Math.max(0, (graphClock(h, now) - h.start) / length);
    }
    // What a person added once the story's own beats had ended: the last follow-up (or the rest a raised cap let go on)
    // is what the run now does, and its answer is the run's.
    const after = (h.later ?? []).filter((x) => x.kind !== "steer");
    if (after.length) {
      const last = after.at(-1)!;
      const p = play(last.beats, { start: last.start, now, stopAt: last.stopAt });
      usd += after.reduce((n, x) => n + x.usd * (x === last && !p.done ? p.requests / Math.max(p.requestsInAll, 1) : 1), 0);
      requests += after.reduce((n, x) => n + requestsOf(x.beats), 0);
      failed = false;
      pending = null;
      if (p.done) { status = "completed"; state = "idle"; endedAt = p.lastAt; }
      else if (last.stopAt !== undefined) { status = last.cancelled ? "cancelled" : "completed"; state = "idle"; endedAt = last.stopAt; }
      else { status = "working"; state = "working"; endedAt = null; }
      finalAnswer = p.rows.findLast((r) => r.kind === "final_answer")?.text ?? finalAnswer;
    }
    const ended = endedAt !== null;
    const learns = !!agent.learning && ended && status === "completed";
    const merged = story.id === "demo-run-refund-by-agent";
    // A wrong grade opens a correction round on the run's learning: it reflects a moment, then keeps the correction.
    const round = learns && h.grade?.feedback === "correction" ? Date.parse(h.grade.graded_at) : null;
    const reflecting = round !== null && now < round + CORRECTION_MS;
    const kept = h.gradeLabel ? `Kept a correction from your grade: ${h.gradeLabel}` : "Kept a correction from your grade.";
    const run: Run = {
      run_id: story.id, agent_id: agent.id, agent_version: versionOf(agent), revision: revisionOf(agent), kind: agent.kind, sha: null,
      status, state, title: story.title, ...(story.effort ? { effort: story.effort } : {}), input: story.input, file_ids: h.files?.map((f) => f.id) ?? [], place: { mode: "runner" }, claim: null,
      created_at: iso(h.start), updated_at: iso(endedAt ?? Math.min(now, h.start + 60 * MIN)), ended_at: ended ? iso(endedAt!) : null,
      result: status === "completed" ? { output: story.output ?? null, final_answer: finalAnswer } : null,
      error: status === "failed" && story.fails && !after.length ? { code: story.fails.code, message: story.fails.message, retryable: false } : null,
      review: ended && status === "completed" && story.review ? { ...story.review, at: iso(endedAt!) } : null,
      pending,
      cost: { usd: Number(usd.toFixed(6)), basis: "estimate", charge_state: null, cap_usd: h.cap ?? agent.maxCostUsd ?? null, tokens: tokensFor(usd, requests), tools_usd: 0, learning_usd: learns ? (merged ? 0.0312 : 0.0021) : 0, all_in_usd: Number((usd + (learns ? (merged ? 0.0312 : 0.0021) : 0)).toFixed(6)) },
      stopped_for: story.fails?.code === "spend_cap_reached" && status === "failed" && !after.length ? "budget" : null, budget_refused_calls: 0, audit_of: null,
      path: story.path ?? (agent.kind === "agentic" ? "agent" : null),
      workflow: story.path && story.path !== "agent" ? { name: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, repick: null } : null,
      approvals: "ask", archived_at: h.archivedAt ? iso(h.archivedAt) : null, imported_from: null,
      trigger: story.trigger ? { id: story.trigger, firing_key: `${story.trigger}:${story.id}` } : null, labels: {},
      learning: round !== null ? (reflecting ? { state: "reflecting", reason: null, detail: "Reading your grade into its corrections.", at: iso(round) } : { state: "merged", reason: null, detail: kept, at: iso(round + CORRECTION_MS) })
        : learns ? { state: merged ? "merged" : "dropped", reason: merged ? null : "empty", detail: merged ? "Kept one correction from this run: quote the policy line in the note." : "Nothing new to keep from this run.", at: iso(endedAt! + 4_000) } : null,
      recordings: [], poll_after_ms: ended ? 0 : 1000, last_progress_at: ended ? null : iso(Math.min(now, h.start + 60 * MIN)),
    };
    // Nothing moves a run that has ended, but for an archive, which is kept beside it, and a correction round under way.
    if (ended && !reflecting) h.settled = { ...run, archived_at: null };
    return run;
  };

  const all = () => [...held.values()];
  const newestFirst = (now = clock()) => all().filter((h) => h.start <= now).sort((a, b) => b.start - a.start);

  /** The agentic run's timeline rows at `now`, with its usage row once it has cost anything. */
  const rowsOf = (h: Held, now = clock()): TimelineRow[] => {
    if (!h.beats) return [];
    const p = play(h.beats, { start: h.start, now, answers: h.answers, stopAt: h.stopAt });
    const rows = [...p.rows];
    let requests = p.requests;
    // Each later turn is a conversation of its own, after the story's.
    for (const [k, x] of (h.later ?? []).entries()) {
      const q = play(x.beats, { start: x.start, now, stopAt: x.stopAt });
      requests += q.requests;
      rows.push(...q.rows.map((r) => ({ ...r, id: `${k + 2}:${r.id}`, conversation_id: k + 2 })));
    }
    rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const run = viewOf(h, now);
    if (run.ended_at && requests) rows.push(usageRow(Date.parse(run.ended_at), rows.length, run.cost.usd ?? 0, requests, true));
    return rows.map((r, i) => ({ ...r, seq: i }));
  };

  // ---- Agents ----

  const BLURB: Record<string, string> = { read: "Read files in the run's folder", write: "Write files in the run's folder", web_fetch: "Read a public web page", web_search: "Search the web", email_send: "Send an email", email_draft: "Save an email draft", ask_person: "Ask you a question mid-run", bash: "Run shell commands in the sandbox" };
  const nativeOf = (a: DemoAgent) => (a.native ? {
    runtime: a.native.runtime, project: a.native.project, selector: a.native.selector, machine_id: "mch_demo_laptop", version: a.native.version, model: a.model, fingerprint: hex(`${a.id}:setup`, 64),
    configuration: [{ path: a.native.runtime === "codex" ? "AGENTS.md" : "CLAUDE.md", sha256: hex(`${a.id}:config`, 64) }], skills: a.native.skills, mcp_servers: a.native.mcp,
    state: "ready" as const, issues: [], capabilities: { launch: true, learning: false, workflows: false as const, approval: "native" as const, usage: true }, connected: !a.native.disconnected, verified_at: iso(a.native.verifiedAt ?? opened - 2 * HOUR),
  } : undefined);
  const definitionOf = (a: DemoAgent, version = versionOf(a)): Agent["definition"] => {
    if (a.saved) return { ...a.saved[version - 1], id: a.id, version, name: a.name } as Agent["definition"];
    const native = nativeOf(a);
    return {
      id: a.id, version, name: a.name, description: a.description,
      ...(a.kind === "workflow" ? { workflow: a.workflow as Record<string, unknown> } : { instructions: a.instructions, ...(a.learning ? { learning: true } : {}), approvals: "ask" as const, model: a.model }),
      harness: a.harness, ...(a.maxCostUsd && version === a.notes.length ? { max_cost_usd: a.maxCostUsd } : {}), skills: [], tools: a.tools, ...(native ? { native } : {}),
    } as Agent["definition"];
  };
  const agentOf = (a: DemoAgent, now = clock()): Agent => {
    const runs = all().filter((h) => h.story.agent === a.id && h.start <= now);
    const made = opened - a.madeDaysAgo * DAY;
    return {
      agent_id: a.id, definition: definitionOf(a), kind: a.kind, mcp_pin: null, revision: revisionOf(a), revisions: a.notes.length, source: null, template: null, skills: [], sign_ins: [],
      runs: { count: runs.length, live: runs.filter((h) => !viewOf(h, now).ended_at).length }, own_computer: null, region: "local", home_etag: `"${revisionOf(a)}"`, archived_at: a.archivedAt ? iso(a.archivedAt) : null,
      ...(a.learning ? { learning: { pending: a.id === FULL_STORY && !pendingApproved ? 1 : 0 } } : {}),
      ...(a.native ? { native_status: nativeOf(a) } : {}),
      created_at: iso(made), updated_at: iso(made + (a.notes.length - 1) * 6 * DAY),
      tools: a.tools.map((name) => {
        const asks = name === "email_send";
        return { name, blurb: BLURB[name] ?? name, permission: asks ? "ask" as const : "allow" as const, permission_from: "default" as const, default_permission: asks ? "ask" as const : "allow" as const, permissions: ["allow" as const, "ask" as const, "deny" as const] };
      }),
      run_blockers: null,
    };
  };
  const revisionsOf = (a: DemoAgent) => {
    const made = opened - a.madeDaysAgo * DAY;
    return a.notes.map((note, i) => ({ revision: revisionOf(a, i + 1), version: i + 1, parent: i ? revisionOf(a, i) : null, kind: a.kind, current: i + 1 === versionOf(a), note, created_at: iso(made + i * 6 * DAY), definition: definitionOf(a, i + 1) })).reverse();
  };

  // ---- Stats ----

  const statsOver = ({ from, agent, now = clock() }: { from?: number; agent?: string; now?: number }): Stats => {
    // As the server counts: an archived run is in no figure but `archived`; the range and the agent narrow the analytics
    // alone, and the tiles above them (runs, cost, each agent's runs) are the whole store's.
    const store = newestFirst(now).filter((h) => !h.archivedAt).map((h) => ({ h, run: viewOf(h, now) }));
    const views = store.filter(({ h }) => (!agent || h.story.agent === agent) && (from === undefined || h.start >= from));
    const empty = () => ({ runs: 0, completed: 0, needs_review: 0, failed: 0, runs_with_metrics: 0, runs_with_token_metrics: 0, tokens: 0, cost_usd: 0, unknown_cost_runs: 0 });
    const totals = { ...empty(), input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 };
    const groups = { day: new Map<string, ReturnType<typeof empty> & { day: string }>(), harness: new Map<string, ReturnType<typeof empty>>(), tools: new Map<string, { calls: number; errors: number }>() };
    let wall = 0;
    let ended = 0;
    let active = 0;
    let activeMs = 0;
    const add = (g: ReturnType<typeof empty>, run: Run, tokens: number) => {
      g.runs += 1;
      if (run.status === "completed") g.completed += 1;
      if (run.status === "failed") g.failed += 1;
      if (run.review) g.needs_review += 1;
      g.runs_with_metrics += 1; g.runs_with_token_metrics += 1; g.tokens += tokens; g.cost_usd += run.cost.usd ?? 0;
    };
    for (const { h, run } of views) {
      const t = run.cost.tokens!;
      const tokens = t.input + t.output + t.cache_read + t.cache_write;
      add(totals, run, tokens);
      totals.input += t.input; totals.output += t.output; totals.cache_read += t.cache_read; totals.cache_write += t.cache_write; totals.requests += t.requests ?? 0;
      const d = day(h.start);
      if (!groups.day.has(d)) groups.day.set(d, { ...empty(), day: d });
      add(groups.day.get(d)!, run, tokens);
      const a = agents.get(h.story.agent)!;
      const key = `${a.harness}\u0000${h.story.effort ?? ""}`;
      if (!groups.harness.has(key)) groups.harness.set(key, empty());
      add(groups.harness.get(key)!, run, tokens);
      if (run.ended_at) { ended += 1; wall += Date.parse(run.ended_at) - h.start; } else { active += 1; activeMs += now - h.start; }
      for (const b of h.beats ?? []) {
        if (b.k !== "tool" && b.k !== "approval" && b.k !== "ask") continue;
        const tool = b.k === "ask" ? "ask_person" : b.tool;
        const row = groups.tools.get(tool) ?? { calls: 0, errors: 0 };
        row.calls += 1; if (b.k === "tool" && b.failed) row.errors += 1;
        groups.tools.set(tool, row);
      }
    }
    const round = <G extends { cost_usd: number }>(g: G): G => ({ ...g, cost_usd: Number(g.cost_usd.toFixed(4)) });
    const byDay = [...groups.day.values()].sort((a, b) => a.day.localeCompare(b.day)).map(round);
    return {
      agents: list.length,
      runs: { total: store.length, active: store.filter((v) => !v.run.ended_at && v.run.status !== "input_required").length, needs_input: store.filter((v) => v.run.status === "input_required").length, failed: store.filter((v) => v.run.status === "failed").length, needs_review: store.filter((v) => v.run.review).length, status_unknown: 0 },
      // Every agent with a run counts, the server's own suggestion scanner too, which is not listed.
      per_agent: [...agents.values()].filter((a) => list.includes(a) || store.some((v) => v.run.agent_id === a.id)).map((a) => ({ agent_id: a.id, name: a.name, runs: store.filter((v) => v.run.agent_id === a.id).length })),
      cost: { usd: Number(store.reduce((n, v) => n + (v.run.cost.usd ?? 0), 0).toFixed(4)), basis: "estimate", unknown_runs: 0 },
      archived: { agents: 0, runs: all().filter((h) => h.archivedAt).length },
      analytics: {
        filter: { from: from === undefined ? null : iso(from), to: null, agent: agent ?? null },
        totals: round(totals),
        time: { ended_runs: ended, wall_ms: wall, active_runs: active, active_ms: activeMs },
        by_harness_effort: [...groups.harness.entries()].map(([key, g]) => ({ ...round(g), harness: key.split("\u0000")[0], effort: key.split("\u0000")[1] || null })),
        by_day: byDay,
        by_source: [{ ...round({ ...totals }), source: "live" }].map(({ input: _i, cache_read: _r, cache_write: _w, output: _o, requests: _q, unmetered: _u, ...g }) => g),
        tools: [...groups.tools.entries()].map(([tool, g]) => ({ tool, label: BLURB[tool] ?? (tool === "learned_workflow" ? "Run a learned workflow" : tool), ...g })).sort((a, b) => b.calls - a.calls),
        usage: {
          tokens: totals.tokens, input: totals.input, output: totals.output, cache_read: totals.cache_read, cache_write: totals.cache_write,
          known_runs: totals.runs, unknown_runs: 0, observed_sessions: 0, unknown_sessions: 0, partial_days: 0, retention_limited: false,
          by_day: byDay.map((g) => ({ day: g.day, tokens: g.tokens })),
          by_harness: [...new Set(list.map((a) => a.harness))].map((harness) => ({ harness, tokens: [...groups.harness.entries()].filter(([k]) => k.startsWith(`${harness}\u0000`)).reduce((n, [, g]) => n + g.tokens, 0) })).filter((g) => g.tokens > 0),
        },
      },
    };
  };

  // ---- Triggers ----

  // A schedule's cron is read off the story's own clock, so its "next" and its past firings agree with it: the brief ran
  // 47 minutes before the demo opened and runs again in a week; the certificates run on weekdays, nine hours from now.
  const cronAt = (ms: number, days: string) => { const t = new Date(ms); return `${t.getUTCMinutes()} ${t.getUTCHours()} * * ${days}`; };
  const briefAt = opened - 47 * MIN;
  let certificatesNext = opened + 9 * HOUR;
  while (![1, 2, 3, 4, 5].includes(new Date(certificatesNext).getUTCDay())) certificatesNext += DAY;
  const TRIGGERS: { id: string; name: string; agent: string; source: Trigger["source"]; input: Record<string, unknown>; madeDaysAgo: number; nextIn?: number; nextAt?: number | null; secretAt?: number; target?: Trigger["target"]; catchup?: number; maxActive?: number | null }[] = [
    { id: "trg-demo-helpdesk-tickets", name: "New support ticket", agent: "support-triage", source: { kind: "webhook", signature: "standard" }, input: { content: "${body.subject}\n\n${body.text}" }, madeDaysAgo: 57 },
    { id: "trg-demo-helpdesk-refunds", name: "Refund request filed", agent: "refund-desk", source: { kind: "webhook", signature: "standard", accept: [{ event: "refund.requested" }] }, input: { content: "Refund request ${body.id}: ${body.buyer} asks for $${body.amount} back on order ${body.order}." }, madeDaysAgo: 40 },
    { id: "trg-demo-weekly-brief", name: "Weekly risk brief", agent: "weekly-risk-brief", source: { kind: "schedule", cron: cronAt(briefAt, String(new Date(briefAt).getUTCDay())), timezone: "UTC" }, input: { content: "Write this week's risk brief." }, madeDaysAgo: 36, nextIn: 7 * DAY - 47 * MIN },
    { id: "trg-demo-weekday-certificates", name: "Certificates, every weekday", agent: "certificate-review", source: { kind: "schedule", cron: cronAt(certificatesNext, "1-5"), timezone: "UTC" }, input: { documents: "${inbox.certificates}" }, madeDaysAgo: 27, nextIn: certificatesNext - opened },
    { id: "trg-demo-pull-requests", name: "Pull request opened", agent: "pr-reviewer", source: { kind: "webhook", signature: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"] }] }, input: { content: "Review pull request #${body.number}: ${body.pull_request.title}" }, madeDaysAgo: 22 },
  ];
  const enabled = new Map(TRIGGERS.map((t) => [t.id, true]));
  const firingsOf = (id: string, now = clock()): Firing[] => {
    const t = TRIGGERS.find((x) => x.id === id);
    const by = t?.source.kind === "schedule" ? "schedule" : "webhook";
    const fired = newestFirst(now).filter((h) => h.story.trigger === id);
    return fired.slice(0, 25).map((h) => ({ key: `${id}:${h.story.id}`, by: h.story.id.startsWith("demo-run-now-") ? "manual" : by, nominal_at: iso(h.start), status: "started", at: iso(h.start), run_id: h.story.id, reason: null, error: null }));
  };
  /** When a schedule fires next: the story's own time for one it tells, else worked out from what was saved, again once
   *  that time has passed. */
  const nextOf = (t: (typeof TRIGGERS)[number], now: number): number | null => {
    if (t.source.kind !== "schedule") return null;
    if (t.nextAt === undefined && t.nextIn !== undefined) t.nextAt = opened + t.nextIn;
    if (t.nextAt === undefined || (t.nextAt !== null && t.nextAt <= now)) t.nextAt = nextFiring(t.source, now, opened - t.madeDaysAgo * DAY);
    return t.nextAt;
  };
  const triggerOf = (t: (typeof TRIGGERS)[number], now = clock()): Trigger => {
    const firings = firingsOf(t.id, now);
    const made = opened - t.madeDaysAgo * DAY;
    const next = nextOf(t, now);
    return {
      id: t.id, name: t.name, enabled: enabled.get(t.id) ?? true, source: t.source,
      target: t.target ?? { kind: "start_run", agent_id: t.agent, input: t.input },
      catchup_window_s: t.catchup ?? 3600, max_active_runs: t.maxActive ?? null, failures_in_a_row: 0, disabled: null,
      next_at: next !== null && (enabled.get(t.id) ?? true) ? iso(next) : null, last_run_id: firings[0]?.run_id ?? null,
      created_at: iso(made), updated_at: iso(made), last_firing: firings[0] ?? null,
      ...(t.source.kind === "webhook" ? { hook_url: `https://agentrun.larkspur.example/v2/hooks/${t.id}`, secret: { name: `trigger:${t.id}`, set: true, source: "saved", changed_at: iso(t.secretAt ?? made) } } : {}),
    } as Trigger;
  };

  // ---- What the Refund desk learned ----

  let pendingApproved = false;
  /** Corrections a person wrote, by agent, in place of the story's. */
  const corrections = new Map<string, string>();
  const correctionsOf = (id: string): string => corrections.get(id) ?? (id === FULL_STORY ? CORRECTIONS_MD : agents.get(id)?.learned?.corrections ?? "");
  /** A learned workflow's status a person changed (retired, restored, approved), by agent and workflow. */
  const statusSet = new Map<string, LearnedItem["status"]>();
  const withStatus = (agent: string, w: LearnedItem): LearnedItem => {
    const set = statusSet.get(`${agent}/${w.name}`);
    return set ? { ...w, status: set, etag: `"${hex(`${agent}:${w.name}:${set}`, 16)}"` } : w;
  };
  const refundRuns = (now = clock()) => all().filter((h) => h.story.agent === "refund-desk" && h.start <= now).sort((a, b) => a.start - b.start);
  const takeoverAt = opened - TAKEOVER_DAYS_AGO * DAY;
  const learningOf = (id: string, now = clock()): AgentLearning => {
    const a = agents.get(id)!;
    const model = { location: "server" as const, ready: true, model: MODELS.default, needs: null, reason: null };
    if (!a.learning) return { agent: id, main: null, corrections: "", workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null, learning_model: model };
    if (id !== FULL_STORY) {
      // An agent earlier in its learning: the corrections it keeps, and for one, a workflow being checked against its past runs.
      const own = all().filter((h) => h.story.agent === id && h.start <= now);
      const kept = (correctionsOf(id).match(/^- /gm) ?? []).length;
      const c = a.learned?.checking;
      const log = c ? [{ by: { run: own.at(-1)?.story.id ?? "" }, commit: hex(`${id}:learn:1`), at: iso(opened - 3 * DAY), reason: `Drafted ${c.name}`, files: [`workflows/${c.name}/workflow.json`] }] : [];
      return {
        agent: id, main: a.learned ? hex(`${id}:learn:1`) : null, corrections: correctionsOf(id),
        workflows: (c ? [{ name: c.name, file: `workflows/${c.name}/workflow.json`, readme: `workflows/${c.name}/README.md`, description: c.description, status: "checking", run: own.at(-1)?.story.id ?? null, bytes: JSON.stringify(c.workflow, null, 2).length, etag: `"${hex(`${id}:etag`, 16)}"`, last_change: { kind: "approved", by: "person", at: iso(opened - 3 * DAY) } }] as LearnedItem[] : []).map((w) => withStatus(id, w)),
        log: { items: log, total: log.length, next_cursor: null }, counts: { merged: kept, dropped: { empty: Math.max(own.length - kept, 0) }, in_progress: c ? 1 : 0 }, impact: null, learning_model: model,
      };
    }
    const runs = refundRuns(now);
    const first = runs.find((h) => h.start >= takeoverAt)?.story.id ?? null;
    const log = [
      { by: { run: runs.at(-9)?.story.id ?? "" }, commit: hex("learn:5"), at: iso(opened - 2 * DAY), reason: `Drafted ${PENDING_WORKFLOW}: refunds that keep back the original shipping`, files: [`workflows/${PENDING_WORKFLOW}/workflow.json`, `workflows/${PENDING_WORKFLOW}/README.md`] },
      { by: { user: true as const }, commit: hex("learn:4"), at: iso(opened - 9 * DAY), reason: "Edited corrections.md", files: ["corrections.md"] },
      { by: { run: first ?? "" }, commit: hex("learn:3"), at: iso(takeoverAt), reason: `Promoted ${LEARNING_WORKFLOW}: it agreed with the agent on all 22 past runs it answered alone`, files: [`workflows/${LEARNING_WORKFLOW}/workflow.json`] },
      { by: { run: "demo-run-refund-by-agent" }, commit: hex("learn:2"), at: iso(opened - 19 * DAY), reason: "Kept a correction: quote the policy line in the note", files: ["corrections.md"] },
      { by: { run: runs[3]?.story.id ?? "" }, commit: hex("learn:1"), at: iso(opened - 29 * DAY), reason: `Drafted ${LEARNING_WORKFLOW}`, files: [`workflows/${LEARNING_WORKFLOW}/workflow.json`, `workflows/${LEARNING_WORKFLOW}/README.md`] },
    ];
    const before = runs.filter((h) => h.start < takeoverAt);
    const after = runs.filter((h) => h.start >= takeoverAt);
    const seconds = (hs: Held[]) => { const xs = hs.map((h) => lengthOf(h.beats ?? []) / 1000).sort((x, y) => x - y); return xs.length ? Math.round(xs[Math.floor(xs.length / 2)]) : 0; };
    return {
      agent: id, main: hex("learn:5"), corrections: correctionsOf(id),
      workflows: ([
        { name: LEARNING_WORKFLOW, file: `workflows/${LEARNING_WORKFLOW}/workflow.json`, readme: `workflows/${LEARNING_WORKFLOW}/README.md`, description: "Decides a refund request: policy line, refund amount, note and email draft.", status: "serving", run: first, bytes: JSON.stringify(REFUND_WORKFLOW).length, etag: `"${hex("etag:serving", 16)}"`, last_change: { kind: "approved", by: "person", at: iso(takeoverAt) } },
        { name: PENDING_WORKFLOW, file: `workflows/${PENDING_WORKFLOW}/workflow.json`, readme: `workflows/${PENDING_WORKFLOW}/README.md`, description: "Works out a changed-mind refund less the original shipping.", status: pendingApproved ? "checking" : "pending", run: runs.at(-9)?.story.id ?? null, bytes: 1412, etag: `"${hex(`etag:pending:${pendingApproved}`, 16)}"`, last_change: pendingApproved ? { kind: "approved", by: "person", at: iso(now) } : { kind: "learned", by: "run", at: iso(opened - 2 * DAY) } },
      ] as AgentLearning["workflows"]).map((w) => withStatus(id, w)),
      log: { items: log, total: log.length, next_cursor: null },
      counts: { merged: 5, dropped: { empty: Math.max(runs.length - 9, 0), checker: 4 }, in_progress: 0 },
      impact: before.length && after.length ? { before: { runs: before.length, median_duration_s: seconds(before) }, after: { runs: after.length, median_duration_s: seconds(after) } } : null,
      learning_model: model,
    };
  };
  /** What a person does to a learned workflow from its README: approve one that waits for an OK, retire one, or restore a
   *  retired one to what it was. False when the workflow is not one this agent lists, or is not in a state for it. */
  const workflowAction = (agent: string, readme: string, action: string): boolean => {
    const w = learningOf(agent).workflows.find((x) => x.readme === readme);
    if (!w) return false;
    const key = `${agent}/${w.name}`;
    if (action === "approve") {
      if (w.status !== "pending") return false;
      if (agent === FULL_STORY && w.name === PENDING_WORKFLOW) { pendingApproved = true; statusSet.delete(key); } else statusSet.set(key, "checking");
      return true;
    }
    if (action === "retire") { if (w.status === "retired") return false; retiredFrom.set(key, w.status); statusSet.set(key, "retired"); return true; }
    if (action === "restore") { if (w.status !== "retired") return false; statusSet.delete(key); const was = retiredFrom.get(key); if (was && was !== learningOf(agent).workflows.find((x) => x.readme === readme)?.status) statusSet.set(key, was); return true; }
    return false;
  };
  const retiredFrom = new Map<string, LearnedItem["status"]>();

  const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : 0);
  const learningCostOf = (id: string, now = clock()): LearningCost => {
    const none: LearningCost = { agent: id, runs: [], total_runs: 0, unknown_cost_runs: 0, unknown_path_runs: 0, workflows: [], summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, bill: { learning_usd: 0, points: [], break_even: null, gap_usd: null, withheld: 0, booked_usd: 0, revisions: [], unattributed_usd: null, holds: [] } };
    if (id !== FULL_STORY) return none;
    const ended = refundRuns(now).map((h) => ({ h, run: viewOf(h, now) })).filter((x) => x.run.status === "completed");
    const rows = ended.map(({ h, run }, i) => {
      const path = h.story.path ?? "agent";
      const cost = run.cost.usd ?? 0;
      const learning = run.cost.learning_usd ?? 0;
      return { n: i + 1, run_id: run.run_id, started_at: run.created_at, path, workflow: path === "agent" ? null : LEARNING_WORKFLOW, digest: path === "agent" ? null : LEARNING_DIGEST, took_over: path === "workflow", audited: false, cost_usd: cost, cost_upper_bound: false, learning_usd: learning, total_usd: Number((cost + learning).toFixed(6)) };
    });
    const takeover = rows.find((r) => r.path === "workflow") ?? null;
    const before = rows.filter((r) => !takeover || r.n < takeover.n);
    const served = rows.filter((r) => r.path === "workflow");
    const byHand = rows.filter((r) => takeover && r.n >= takeover.n && r.path !== "workflow");
    const agentMean = mean(before.map((r) => r.cost_usd));
    const afterMean = mean(rows.filter((r) => takeover && r.n >= takeover.n).map((r) => r.cost_usd));
    const learningUsd = Number(rows.reduce((n, r) => n + r.learning_usd, 0).toFixed(4));
    // The owner's bill, run after run, against what the agent alone would have cost for the same runs.
    let actual = 0;
    let alone = 0;
    let breakEven: { n: number; run_id: string } | null = null;
    const points = rows.map((r) => {
      actual += r.total_usd;
      alone += r.path === "agent" ? r.cost_usd : agentMean;
      if (!breakEven && takeover && r.n > takeover.n && actual < alone) breakEven = { n: r.n, run_id: r.run_id };
      return { n: r.n, run_id: r.run_id, actual_usd: Number(actual.toFixed(4)), agent_usd: Number(alone.toFixed(4)) };
    });
    return {
      agent: id, runs: rows, total_runs: rows.length, unknown_cost_runs: 0, unknown_path_runs: 0,
      workflows: takeover ? [{ workflow: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, state: "serving", served: { runs: served.length, mean_usd: mean(served.map((r) => r.cost_usd)) }, by_hand: byHand.length ? { runs: byHand.length, mean_usd: mean(byHand.map((r) => r.cost_usd)) } : null, unknown_cost_runs: 0 }] : [],
      summary: {
        takeover: takeover ? { n: takeover.n, run_id: takeover.run_id } : null,
        before: before.length ? { runs: before.length, mean_usd: agentMean } : null,
        after: takeover ? { runs: rows.length - before.length, mean_usd: afterMean } : null,
        after_state: takeover ? "priced" : "no_served_runs",
        times_cheaper: takeover && afterMean ? Number((agentMean / afterMean).toFixed(1)) : null,
        hand_backs: takeover ? { ran: served.length + byHand.length, back: byHand.length } : null, withheld: null,
        replay: takeover ? { n: 24, workflow_pct: 100, agent_pct: 100, cleared: true, agreed: 22, alone: 22, agree_min: 0.95 } : null,
      },
      bill: {
        learning_usd: learningUsd, points, break_even: breakEven, gap_usd: points.length ? Number((points.at(-1)!.agent_usd! - points.at(-1)!.actual_usd).toFixed(4)) : null, withheld: 0, booked_usd: points.at(-1)?.actual_usd ?? 0,
        revisions: takeover ? [{ workflow: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, compile_usd: 0.184, check_usd: 0.412, spend_usd: 0.596, k: 24, served: served.length, attributed_usd: 0.596, unattributed_usd: 0, state: "serving" }] : [],
        unattributed_usd: 0, holds: [],
      },
    };
  };
  // The check that promoted the workflow: 24 of the agent's past runs replayed, 22 answered alone, all 22 as the agent had.
  const check = { compile_after: 20, agree_min: 0.95, alone_min: 0.8, attempt: 1 as const, n: 24, agreed: 22, alone: 22, cost_usd: 0.412, outcomes: { answered: 22, handed_back: 2, failed: 0, skipped_write: 0 } };
  const promotionsOf = (id: string): Promotions => {
    if (id !== FULL_STORY) return { agent: id, promotions: [], serving: [] };
    const nodes = REFUND_WORKFLOW.root.steps.map((s, i) => ({ path: `/root/steps/${i}`, kind: s.node, label: s.label, tier: s.node === "pick" || s.node === "extract" ? "fast" as const : null, checks: [] }));
    return {
      agent: id,
      promotions: [
        { workflow: LEARNING_WORKFLOW, digest: hex("refund-decision:draft-1", 64), at: iso(opened - 22 * DAY), decided: "hold", reason: "It answered 19 of 24 past runs alone and agreed with the agent on 16 of them; 95% is needed.", check: { ...check, agreed: 16, alone: 19, outcomes: { answered: 19, handed_back: 2, failed: 3, skipped_write: 0 } } },
        { workflow: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, at: iso(takeoverAt), decided: "promote", reason: "It answered 22 of 24 past runs alone, and agreed with the agent on all 22.", check, commit: hex("learn:3") },
      ],
      serving: [{ workflow: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, replaying: null, state: "serving", check: { n: 24, agreed: 22, alone: 22, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 14, disagreed: 0 }, audits_off: null, not_auditable: 0, champion: { digest: LEARNING_DIGEST, commit: hex("learn:3"), nodes, check } }],
    };
  };
  const loopOf = (id: string, now = clock()): LearningLoop => {
    if (id !== FULL_STORY) return { agent: id, completed_runs: 0, compiles: [] };
    const runs = refundRuns(now);
    return {
      agent: id, completed_runs: runs.filter((h) => viewOf(h, now).status === "completed").length,
      compiles: [
        { run_id: runs.at(-9)?.story.id ?? "", round: 3, at: iso(opened - 2 * DAY), workflow: PENDING_WORKFLOW, attempts: [{ ok: true, errors: [] }], digest: hex(`${PENDING_WORKFLOW}:draft`, 64), promoted: null, draft_errors: [], withheld: false },
        { run_id: runs.find((h) => h.start >= takeoverAt - DAY)?.story.id ?? "", round: 2, at: iso(takeoverAt - 2 * HOUR), workflow: LEARNING_WORKFLOW, attempts: [{ ok: false, errors: ["/root/steps/3: the code node reads `line.refund`, which no earlier node writes"] }, { ok: true, errors: [] }], digest: LEARNING_DIGEST, promoted: true, draft_errors: [], withheld: false },
        { run_id: runs[3]?.story.id ?? "", round: 1, at: iso(opened - 22 * DAY), workflow: LEARNING_WORKFLOW, attempts: [{ ok: true, errors: [] }], digest: hex("refund-decision:draft-1", 64), promoted: false, draft_errors: [], withheld: false },
      ],
    };
  };
  const auditsOf = (id: string, now = clock()): LearningAudits => {
    if (id !== FULL_STORY) return { agent: id, audits: [] };
    const served = refundRuns(now).filter((h) => h.story.path === "workflow" && viewOf(h, now).status === "completed");
    // One served run in five is run again by the agent alone, to see that the workflow still answers as it would.
    return { agent: id, audits: served.filter((_, i) => i % 5 === 2).slice(-14).map((h) => ({ run: h.story.id, shadow_run: null, workflow: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, promoted_at: iso(takeoverAt), source: "shadow", agreed: true, served_cost: Number(h.story.usd.toFixed(4)), shadow_cost: 0.19, at: iso(h.start + 3 * MIN) })) };
  };
  const workflowRevisionsOf = (name: string): WorkflowRevisions => {
    const text = JSON.stringify(REFUND_WORKFLOW, null, 2);
    if (name !== LEARNING_WORKFLOW) return { name, revisions: [], total: 0, truncated: false };
    const runs = refundRuns();
    return { name, total: 2, truncated: false, revisions: [
      { commit: hex("learn:1"), at: iso(opened - 29 * DAY), by: { run: runs[3]?.story.id ?? "" }, reason: `Drafted ${LEARNING_WORKFLOW}`, text: text.replace('"work out the refund"', '"work out the refund (draft)"'), digest: hex("refund-decision:draft-1", 64) },
      { commit: hex("learn:3"), at: iso(takeoverAt), by: { run: runs.find((h) => h.start >= takeoverAt - DAY)?.story.id ?? "" }, reason: "Wrote the refund in code, from the picked line", text, digest: LEARNING_DIGEST },
    ] };
  };
  /** An agent's learning files by path: the Refund desk's full story, or what an agent earlier in its learning keeps. */
  const learningFileOf = (agent: string, file: string): string | null => {
    if (file === "corrections.md" && (agent === FULL_STORY || agents.get(agent)?.learned)) return correctionsOf(agent);
    if (agent === FULL_STORY) return learningFiles[file] ?? null;
    const learned = agents.get(agent)?.learned;
    if (!learned) return null;
    const c = learned.checking;
    const files: Record<string, string> = {
      ...(c ? { [`workflows/${c.name}/README.md`]: c.readme, [`workflows/${c.name}/workflow.json`]: JSON.stringify(c.workflow, null, 2) } : {}),
    };
    return files[file] ?? null;
  };
  const learningFiles: Record<string, string> = {
    "corrections.md": CORRECTIONS_MD,
    [`workflows/${LEARNING_WORKFLOW}/README.md`]: LEARNED_README,
    [`workflows/${LEARNING_WORKFLOW}/workflow.json`]: JSON.stringify(REFUND_WORKFLOW, null, 2),
    [`workflows/${PENDING_WORKFLOW}/README.md`]: `# ${PENDING_WORKFLOW}\n\nWorks out a changed-mind refund: the amount paid less the original shipping, once the carrier has scanned the return.\n\nDrafted from 11 runs where the agent did this by hand. It waits for your OK before it is checked against past runs.\n`,
    [`workflows/${PENDING_WORKFLOW}/workflow.json`]: JSON.stringify({ v: 2, name: PENDING_WORKFLOW, root: { node: "chain", steps: [{ node: "call", label: "look the order up", tool: "web_fetch", as: "order" }, { node: "code", label: "paid less original shipping", as: "refund" }] } }, null, 2),
  };
  const runLearningOf = (h: Held, now = clock()): RunLearningRead => {
    const run = viewOf(h, now);
    if (!run.learning) return null;
    const merged = run.learning.state === "merged";
    const graded = h.grade ? { ...h.grade, feedback_status: h.grade.feedback ? (run.learning.state === "reflecting" ? "running" as const : "ended" as const) : null } : undefined;
    return { ...(graded ? { graded } : {}), run: run.run_id, state: run.learning.state, reason: run.learning.reason, detail: run.learning.detail, at: run.learning.at, seed: hex("learn:1"), merged: merged ? hex("learn:2") : null, workflows: [], corrections: merged ? 1 : 0, problems: [], compiled: null, draft_errors: [], used: { workflows: h.story.path && h.story.path !== "agent" ? [{ name: LEARNING_WORKFLOW, calls: 1, failed: 0 }] : [] } };
  };

  // ---- Files ----

  const INPUT_FILE = "inputs/message.md";
  const filesOf = (h: Held, now = clock()): Record<string, string> => {
    const content = typeof h.story.input.content === "string" ? h.story.input.content : null;
    const saved = new Set(rowsOf(h, now).map((r) => r.path).filter((p): p is string => !!p));
    const own = Object.fromEntries(Object.entries(h.story.files ?? {}).filter(([path]) => saved.has(path)));
    const picked = Object.fromEntries((h.files ?? []).map((f) => [`inputs/${f.path}`, f.text]));
    return { ...(content ? { [INPUT_FILE]: content } : {}), ...picked, ...own };
  };

  // ---- What a person does ----

  let made = 0;
  /** Starts a run of `agentId` now, as a start from the playground or a trigger's Run now would: the agent's sample
   *  story, played live from this moment, opening with what was asked. */
  const start = (agentId: string, input: Record<string, unknown>, by: "person" | "trigger" = "person", trigger?: string, files: RunInputFile[] = []): Run | null => {
    const a = agents.get(agentId);
    if (!a) return null;
    const said = typeof input.content === "string" && input.content.trim() ? input.content.trim() : null;
    const sample = heroes().find((s) => s.agent === agentId && s.beats) ?? history(opened).findLast((s) => s.agent === agentId && s.beats) ?? heroes().find((s) => s.agent === agentId)
      ?? { id: "", agent: agentId, title: a.name, startAgo: 0, input: {}, beats: standIn(said), usd: 0.004 } satisfies RunStory;
    // What was asked shows at once, as the run's first row.
    const beats = sample.beats?.map((b, i) => (i === 0 && b.k === "user" ? { ...b, wait: 0, text: said ?? b.text } : b));
    const story: RunStory = { ...sample, id: `demo-run-now-${++made}`, title: said ? said.split("\n")[0].slice(0, 80) : sample.title, startAgo: 0, input: Object.keys(input).length ? input : sample.input, ...(beats ? { beats } : {}), answered: [], hero: undefined, trigger: by === "trigger" ? trigger : undefined };
    const h = hold(story, clock());
    if (files.length) h.files = files;
    return viewOf(h);
  };
  /** Makes an agent from a definition, as the builder or the playground's create would: kept in this page's memory. */
  const createAgent = (definition: Record<string, unknown>): Agent => {
    const name = typeof definition.name === "string" && definition.name.trim() ? definition.name.trim() : "New agent";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    let id = slug;
    for (let n = 2; agents.has(id); n++) id = `${slug}-${n}`;
    const a: DemoAgent = { id, name, description: typeof definition.description === "string" ? definition.description : "", kind: definition.workflow ? "workflow" : "agentic", harness: typeof definition.harness === "string" ? definition.harness : "pi", model: typeof definition.model === "string" ? definition.model : MODELS.default, tools: Array.isArray(definition.tools) ? (definition.tools as string[]) : [], learning: !!definition.learning, madeDaysAgo: (opened - clock()) / DAY, notes: [null], saved: [{ skills: [], tools: [], ...definition }] };
    list.push(a); agents.set(id, a);
    return agentOf(a);
  };
  /** Saves an edit as the agent's next revision. A story's agent keeps its earlier revisions as they were. */
  const saveDefinition = (id: string, definition: Record<string, unknown>, note: string | null): Agent | null => {
    const a = agents.get(id);
    if (!a) return null;
    a.saved ??= a.notes.map((_, i) => definitionOf(a, i + 1) as Record<string, unknown>);
    // An edit is made on the definition that is current, and becomes the current one, whichever revision was before.
    a.saved.push({ ...a.saved[versionOf(a) - 1], ...definition });
    a.notes = [...a.notes, note];
    a.current = undefined;
    if (typeof definition.description === "string") a.description = definition.description;
    if (typeof definition.model === "string") a.model = definition.model;
    if (typeof definition.harness === "string") a.harness = definition.harness;
    a.learning = !!a.saved.at(-1)!.learning;
    return agentOf(a);
  };
  /** A run of an agent the story has no sample for (one made in the demo): a stand-in that says what demo mode is. */
  const standIn = (said: string | null): Beat[] => [
    { k: "user", text: said ?? "Run the agent." },
    { k: "think", text: "Demo mode calls no model, so this run is a stand-in for what the agent would do." },
    { k: "final", text: "This is a sample answer. Demo mode calls no model and starts nothing on your server. Turn demo mode off in Settings → Demo to run this agent for real." },
  ];
  // ---- The suggestion scanner: the server's own agent, whose runs read a connected repository for work an agent could take ----

  const SCANNER: DemoAgent = { id: "suggestion-scanner", name: "Suggestion scanner", description: "Reads a connected repository for work an agent could take, and suggests an agent for each.", kind: "agentic", harness: "pi", model: MODELS.default, tools: ["read", "bash"], instructions: "Read the repository for work people do by hand that an agent could take, and suggest an agent for each, with the lines that show it.", madeDaysAgo: 30, notes: [null] };
  // Not one of the agents listed: the server keeps it for its scans.
  agents.set(SCANNER.id, SCANNER);
  let scanRuns = 0;
  /** A scan's run, from `start` for about `ms`: what the suggestions page links to as the scan's run. */
  const holdScan = ({ repo, commit, start: at, ms, found }: { repo: string; commit: string; start: number; ms: number; found: { path: string; line: number; quote: string; title: string }[] }): { run_id: string; endsAt: number } => {
    const step = Math.round(ms / 5);
    const said = `Scan ${repo} at ${commit.slice(0, 7)} for work an agent could take.`;
    const beats: Beat[] = [
      { k: "user", text: said, wait: 0 },
      { k: "think", text: "Looking for work people do by hand: TODOs that say so, review queues, tickets answered by looking something up.", wait: step },
      { k: "tool", tool: "bash", label: "Ran rg -n \"by hand|seller sees nothing|TODO\" --type ts", input: "rg -n \"by hand|seller sees nothing|TODO\" --type ts", result: found.map((f) => `${f.path}:${f.line}: ${f.quote}`).join("\n"), wait: step, ms: Math.round(step / 2) },
      ...found.map((f): Beat => ({ k: "tool", tool: "read", label: `Read ${f.path}`, input: f.path, result: `${f.line}: ${f.quote}`, wait: Math.round(step / (2 * found.length)), ms: Math.round(step / (2 * found.length)) })),
      { k: "final", text: `Found ${found.length} suggestions in ${repo}:\n${found.map((f) => `- ${f.title} (${f.path}:${f.line})`).join("\n")}`, wait: step },
    ];
    const id = `demo-run-scan-${++scanRuns}`;
    hold({ id, agent: SCANNER.id, title: `Scan ${repo}`, startAgo: 0, input: { content: said }, beats, usd: 0.0412 }, at);
    return { run_id: id, endsAt: play(beats, { start: at, now: Number.MAX_SAFE_INTEGER }).lastAt };
  };

  // ---- A person's other writes: each changes only this page's memory, as the server would have changed its store ----

  const later = (h: Held, x: Omit<Later, "start">) => { (h.later ??= []).push({ ...x, start: clock() }); delete h.settled; };
  /** A message to a run, as the server takes one: the answer to its question; a steer while it runs (a call waiting for
   *  approval is declined, and the agent reads the message); a follow-up once it has ended, which it answers. */
  const message = (id: string, text: string): "answer" | "steer" | "follow_up" | null => {
    const h = held.get(id);
    if (!h) return null;
    const run = viewOf(h);
    if (run.pending?.kind === "question") { answer(id, { text }); return "answer"; }
    if (run.pending?.kind === "approval") answer(id, { decision: "deny" });
    if (!run.ended_at) { later(h, { kind: "steer", beats: [{ k: "user", text, wait: 0 }], usd: 0 }); return "steer"; }
    const before = run.result?.final_answer;
    later(h, { kind: "follow_up", usd: 0.0062, beats: [
      { k: "user", text, wait: 0 },
      { k: "think", text: "Reading the follow-up against what this run found and answered." },
      { k: "final", text: before ? `On your follow-up: what this run found still holds, so its answer stands. ${before}` : "On your follow-up: nothing this run found changes, so there is nothing more to do." },
    ] });
    return "follow_up";
  };
  /** A grade of an ended run's answer: kept beside the run, and a wrong grade opens a correction round on a learning agent. */
  const grade = (id: string, body: GradeBody): GradeAnswer | null => {
    const h = held.get(id);
    if (!h) return null;
    const run = viewOf(h);
    // A run that learns takes a wrong grade's words into its corrections, in a round of its own.
    const learns = !!run.learning;
    const label = body.correct ? "" : (body.label ?? "").trim();
    h.grade = { run_id: id, correct: body.correct, source: body.source ?? "feedback", graded_at: iso(clock()), path: (run.path === "handed_back" || run.path === "workflow" ? run.path : "agent"), workflow: run.workflow?.name ?? null, workflow_digest: run.workflow?.digest ?? null, feedback: !body.correct && learns ? "correction" : null, ...(body.expected ? { expected: body.expected } : {}) };
    h.gradeLabel = label || undefined;
    if (!body.correct && learns && label) corrections.set(h.story.agent, `${correctionsOf(h.story.agent).trimEnd()}\n- ${label}\n`);
    delete h.settled;
    return h.grade;
  };
  /** A higher spend cap: a run the cap stopped goes on from where it stopped, and finishes. */
  const raiseCap = (id: string, cap: number): RaiseAnswer | null => {
    const h = held.get(id);
    if (!h) return null;
    h.cap = cap;
    const run = viewOf(h);
    const resumed = run.stopped_for === "budget";
    if (resumed) later(h, { kind: "resume", usd: 0.38, beats: [
      { k: "say", text: `The spend cap is now $${cap.toFixed(2)}. Picking up where the run stopped.`, wait: 300 },
      { k: "tool", tool: "bash", label: "Ran git diff origin/main...pr-2210 -- payouts/ api/", input: "git diff origin/main...pr-2210 -- payouts/ api/", result: "diff --git a/payouts/cutoff.ts b/payouts/cutoff.ts\n…", ms: 1400 },
      { k: "final", text: h.story.afterCap ?? "Finished with the higher cap." },
    ] });
    delete h.settled;
    const now = viewOf(h);
    return { run_id: id, max_cost_usd: cap, resumed, status: now.status, state: now.state };
  };
  /** Pauses or resumes a workflow run: its graph's clock holds while it is paused. */
  const setPaused = (id: string, on: boolean): { run_id: string; paused: boolean; status: Run["status"] } | null => {
    const h = held.get(id);
    if (!h || !h.story.graph) return null;
    if (on && h.pausedAt === undefined && !viewOf(h).ended_at) h.pausedAt = clock();
    if (!on && h.pausedAt !== undefined) { h.pausedMs = (h.pausedMs ?? 0) + clock() - h.pausedAt; delete h.pausedAt; }
    return { run_id: id, paused: h.pausedAt !== undefined, status: viewOf(h).status };
  };
  const archiveAgent = (id: string, on: boolean): Agent | null => { const a = agents.get(id); if (!a) return null; a.archivedAt = on ? clock() : undefined; return agentOf(a); };
  /** Makes an earlier revision the agent's current one again. */
  const setCurrent = (id: string, revision: string): Agent | null => {
    const a = agents.get(id);
    const version = a ? a.notes.findIndex((_, i) => revisionOf(a, i + 1) === revision) + 1 : 0;
    if (!a || !version) return null;
    a.current = version === a.notes.length ? undefined : version;
    return agentOf(a);
  };
  const writeCorrections = (id: string, text: string): string | null => { if (!agents.get(id)?.learning) return null; corrections.set(id, text); return text; };
  const triggerId = (name: string) => { const slug = `trg-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trigger"}`; let id = slug; for (let n = 2; TRIGGERS.some((t) => t.id === id); n++) id = `${slug}-${n}`; return id; };
  const signingSecret = (id: string) => `whsec_demo_${hex(`${id}:${clock()}`, 32)}`;
  const createTrigger = (body: TriggerCreate): (Trigger & { signing_secret?: string }) | null => {
    const target = body.target as Trigger["target"];
    const agent = target.kind === "start_run" ? target.agent_id : held.get(target.run_id)?.story.agent;
    if (!agent || !agents.has(agent)) return null;
    const name = body.name?.trim() || `${agents.get(agent)!.name} trigger`;
    const id = triggerId(name);
    TRIGGERS.push({ id, name, agent, source: body.source as Trigger["source"], input: target.kind === "start_run" ? target.input ?? {} : {}, madeDaysAgo: (opened - clock()) / DAY, target, catchup: body.catchup_window_s, maxActive: body.max_active_runs ?? null, secretAt: clock() });
    enabled.set(id, body.enabled ?? true);
    const made = triggerOf(TRIGGERS.at(-1)!);
    return made.source.kind === "webhook" ? { ...made, signing_secret: signingSecret(id) } : made;
  };
  const updateTrigger = (id: string, body: TriggerInput): Trigger | null => {
    const t = TRIGGERS.find((x) => x.id === id);
    if (!t) return null;
    if (body.name !== undefined) t.name = body.name;
    if (body.enabled !== undefined) enabled.set(id, body.enabled);
    if (body.source) { t.source = body.source as Trigger["source"]; t.nextIn = undefined; t.nextAt = undefined; }
    if (body.target) { t.target = body.target as Trigger["target"]; if (t.target.kind === "start_run") { t.agent = t.target.agent_id; t.input = t.target.input; } }
    if (body.catchup_window_s !== undefined) t.catchup = body.catchup_window_s;
    if (body.max_active_runs !== undefined) t.maxActive = body.max_active_runs;
    return triggerOf(t);
  };
  /** What Run now starts a run with: the trigger's saved input, less a value that fills from a request (`${body.…}`),
   *  which a run by hand has none of. With nothing left, the agent's sample story says what was asked. */
  const firedInput = (input: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(input).filter(([, v]) => !(typeof v === "string" && v.includes("${"))));
  const deleteTrigger = (id: string): boolean => { const i = TRIGGERS.findIndex((x) => x.id === id); if (i < 0) return false; TRIGGERS.splice(i, 1); enabled.delete(id); return true; };
  const rotateTriggerSecret = (id: string): TriggerSecret | null => {
    const t = TRIGGERS.find((x) => x.id === id);
    if (!t || t.source.kind !== "webhook") return null;
    t.secretAt = clock();
    return { secret: { name: `trigger:${id}`, set: true, source: "console", changed_at: iso(t.secretAt) }, signing_secret: signingSecret(id) };
  };

  /** Applies a bundled template, as the server does: makes its agent (or a new revision of the one named), with no
   *  trigger made. A dry run says what would happen and makes nothing. */
  const applyTemplate = (t: TemplateView, body: TemplateApply): TemplateApplied => {
    // The install form's choices: a model of the package's (and the harness it runs on) or one of the owner's, and approvals.
    const choice = t.model?.choices?.find((c) => c.id === body.overrides?.choice);
    const model = body.overrides?.model ?? choice?.model;
    const approvals = body.overrides?.approvals;
    const definition = { version: 1, name: t.display_name ?? t.name, description: t.description, instructions: t.description, harness: choice?.harness ?? t.harness?.[0] ?? "pi", tools: t.tools ?? [], skills: t.skills, ...(t.learning ? { learning: true } : {}), ...(model ? { model } : {}), ...(approvals ? { approvals } : {}) };
    const onto = body.agent_id && agents.has(body.agent_id) ? body.agent_id : null;
    const base = { template: t.id, version: t.version, servers: {}, triggers: [], warnings: [] };
    if (body.dry_run) return { ...base, agent_id: onto ?? "", revision_id: null, revision_version: onto ? agents.get(onto)!.notes.length + 1 : 1, agent_change: onto ? "updated" : "made" };
    const agent = onto ? saveDefinition(onto, definition, `Applied template ${t.id}`)! : createAgent(definition);
    return { ...base, agent_id: agent.agent_id, revision_id: agent.revision, revision_version: agent.revisions, agent_change: onto ? "updated" : "made" };
  };

  // ---- Connected agents: a Claude Code or Codex setup found on the demo's laptop ----

  const MACHINE = "mch_demo_laptop";
  const targetOf = (runtime: "claude-code" | "codex", project: string, selector: { kind: "project" } | { kind: "agent"; name: string }) => ({
    runtime, project, selector, machine_id: MACHINE, version: runtime === "codex" ? "0.164.0" : "2.1.330", model: runtime === "codex" ? "openai/gpt-6.1-sol" : MODELS.default,
    fingerprint: hex(`${runtime}:${project}:setup`, 64), configuration: [{ path: runtime === "codex" ? "AGENTS.md" : "CLAUDE.md", sha256: hex(`${runtime}:${project}:config`, 64) }],
    skills: [], mcp_servers: [], state: "ready" as const, issues: [], capabilities: { launch: true, learning: false, workflows: false as const, approval: "native" as const, usage: true },
  });
  /** What a project folder on the demo's laptop holds: a Claude Code and a Codex setup, each ready to connect. */
  const discoverNative = (project: string, runtime?: "claude-code" | "codex") => ({ machine_id: MACHINE, targets: (runtime ? [runtime] : (["claude-code", "codex"] as const)).map((r) => targetOf(r, project, { kind: "project" })) });
  /** Connects a setup as an agent, run from here as it is set up there. */
  const connectNative = (body: { project: string; runtime: "claude-code" | "codex"; selector?: { kind: "project" | "agent" | "profile"; name?: string } }) => {
    const selector = body.selector?.kind === "agent" && body.selector.name ? { kind: "agent" as const, name: body.selector.name } : { kind: "project" as const };
    // The same setup connected before, and disconnected since, is connected again: its agent and its runs are kept.
    const again = list.find((x) => x.native && x.native.runtime === body.runtime && x.native.project === body.project && JSON.stringify(x.native.selector) === JSON.stringify(selector));
    if (again?.native) {
      again.native.disconnected = undefined;
      again.native.verifiedAt = clock();
      return { agent: agentOf(again), native: nativeOf(again)! };
    }
    const folder = body.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
    const name = `${folder} (${body.runtime === "codex" ? "Codex" : "Claude Code"})`;
    const t = targetOf(body.runtime, body.project, selector);
    const made = createAgent({ name, description: `The ${body.runtime === "codex" ? "Codex" : "Claude Code"} setup in ${body.project}, run as it is set up there.`, harness: body.runtime, model: t.model, tools: [] });
    const a = agents.get(made.agent_id)!;
    a.native = { runtime: body.runtime, project: body.project, selector, version: t.version, skills: [], mcp: [] };
    a.saved = undefined;
    a.instructions = undefined;
    const agent = agentOf(a);
    a.native.verifiedAt = clock();
    return { agent, native: nativeOf(a)! };
  };
  /** Disconnects a connected agent: no run of it starts until it is connected again; its setup and runs are kept. */
  const disconnectNative = (id: string) => { const a = agents.get(id); if (!a?.native) return null; a.native.disconnected = true; return nativeOf(a)!; };
  /** Checks a connected agent's setup again: still as it was, so it is ready. */
  const verifyNative = (id: string) => { const a = agents.get(id); if (!a?.native) return null; a.native.verifiedAt = clock(); return nativeOf(a)!; };

  const answer = (id: string, a: Omit<GateAnswer, "at">): boolean => {
    const h = held.get(id);
    if (!h || !viewOf(h).pending) return false;
    h.answers.push({ at: clock(), ...a });
    return true;
  };
  const stop = (id: string, cancelled: boolean): boolean => {
    const h = held.get(id);
    if (!h || viewOf(h).ended_at) return false;
    const last = (h.later ?? []).filter((x) => x.kind !== "steer").at(-1);
    const now = clock();
    if (last) { last.stopAt = now; last.cancelled = cancelled; } else { h.stopAt = now; h.cancelled = cancelled; }
    // A workflow run stops where its graph stands, which a pause held back: its pause ends with it.
    if (!last && h.story.graph) {
      h.stoppedAt = graphClock(h, now);
      if (h.pausedAt !== undefined) { h.pausedMs = (h.pausedMs ?? 0) + now - h.pausedAt; delete h.pausedAt; }
    }
    delete h.settled;
    return true;
  };
  const archive = (id: string, on: boolean): Run | null => {
    const h = held.get(id);
    if (!h) return null;
    h.archivedAt = on ? clock() : undefined;
    return viewOf(h);
  };

  return {
    opened, clock, agents: () => list.map((a) => agentOf(a)), agent: (id: string) => (agents.has(id) ? agentOf(agents.get(id)!) : null), revisions: (id: string) => (agents.has(id) ? revisionsOf(agents.get(id)!) : null),
    modelOf: (agentId: string) => agents.get(agentId)?.model ?? MODELS.default,
    runs: ({ agent, status, archived }: { agent?: string; status?: string; archived?: boolean } = {}) => newestFirst().filter((h) => (!agent || h.story.agent === agent) && !!h.archivedAt === !!archived).map((h) => viewOf(h)).filter((r) => !status || r.status === status),
    run: (id: string) => (held.has(id) ? viewOf(held.get(id)!) : null),
    rows: (id: string) => (held.has(id) ? rowsOf(held.get(id)!) : null),
    graph: (id: string) => (held.has(id) ? graphOf(held.get(id)!, clock()) : null),
    trace: (id: string): RunTrace | null => { const h = held.get(id); if (!h) return null; const run = viewOf(h); return traceOf(id, rowsOf(h), agents.get(h.story.agent)!.model, run.cost.usd ?? 0, Math.max(requestsOf(h.beats ?? []), 1)); },
    usage: (id: string): RunUsage | null => { const h = held.get(id); return h ? usageOf(viewOf(h), agents.get(h.story.agent)!.model) : null; },
    files: (id: string) => (held.has(id) ? filesOf(held.get(id)!) : null),
    runLearning: (id: string) => (held.has(id) ? runLearningOf(held.get(id)!) : undefined),
    stats: statsOver,
    triggers: () => TRIGGERS.map((t) => triggerOf(t)), trigger: (id: string) => { const t = TRIGGERS.find((x) => x.id === id); return t ? triggerOf(t) : null; }, firings: (id: string) => firingsOf(id),
    setTriggerEnabled: (id: string, on: boolean) => { if (!enabled.has(id)) return null; enabled.set(id, on); return triggerOf(TRIGGERS.find((x) => x.id === id)!); },
    fire: (id: string): Firing | null => { const t = TRIGGERS.find((x) => x.id === id); const run = t && start(t.agent, firedInput(t.input), "trigger", id); return run ? { key: `${id}:${run.run_id}`, by: "manual", nominal_at: run.created_at, status: "started", at: run.created_at, run_id: run.run_id, reason: null, error: null } : null; },
    learning: (id: string) => (agents.has(id) ? learningOf(id) : null),
    createAgent, saveDefinition, learningCost: learningCostOf, promotions: promotionsOf, loop: loopOf, audits: auditsOf, workflowRevisions: workflowRevisionsOf,
    learningFile: learningFileOf, workflowAction,
    holdScan, applyTemplate, discoverNative, connectNative, disconnectNative, verifyNative, start, answer, stop, archive, message, grade, raiseCap, setPaused, archiveAgent, setCurrent, writeCorrections, createTrigger, updateTrigger, deleteTrigger, rotateTriggerSecret,
    /** A sample page image by its run-relative path, as a data URL. */
    page: (path: string) => fixturePages[path] ?? null,
  };
}
