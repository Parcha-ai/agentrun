// The demo's world: the story's agents and runs as the server's reads would say them at any moment, held in this page's
// memory. A run that is still going moves with the clock; an answer, an approval, a stop or a new run changes only this
// memory, and a reload starts the story again.
import { BATCH_DURATION, batchRunAt, fixturePages, juryRun, kybRun } from "@/demo/dwf/runs";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning } from "@/lib/learning";
import type { Stats } from "@/lib/mission";
import type { RunGraph } from "@/lib/runGraph";
import type { Firing, LearningAudits, LearningCost, LearningLoop, Promotions, Run, RunLearningRead, RunTrace, RunUsage, TimelineRow, Trigger, WorkflowRevisions } from "@/lib/v2";
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
};

/** What each sample graph's decisions cost in all: a workflow run's cost is its graph's. */
const GRAPH_USD = { kyb: kybRun().totals.cost_usd ?? 0, jury: juryRun().totals.cost_usd ?? 0, batch: batchRunAt(BATCH_DURATION + 1).totals.cost_usd ?? 0 };
const GRAPH_MS = { kyb: kybRun().totals.elapsed_ms ?? 0, jury: juryRun().totals.elapsed_ms ?? 0, batch: BATCH_DURATION };

/** The one agent whose learning is told in full: its cost before and after, its checks and its audits. */
const FULL_STORY = "refund-desk";
const LEARNING_WORKFLOW = "refund-decision";
const LEARNING_DIGEST = hex("refund-decision:champion", 64);
const PENDING_WORKFLOW = "partial-refund-shipping";

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

  const revisionOf = (a: DemoAgent, version = a.notes.length) => hex(`${a.id}:rev:${version}`, 64);

  // ---- Runs ----

  const graphOf = (h: Held, now: number): RunGraph | null => {
    const kind = h.story.graph;
    if (!kind) return null;
    const agent = agents.get(h.story.agent)!;
    const merchant = typeof h.story.input.merchant === "string" ? h.story.input.merchant : null;
    const sample = kind === "batch" ? batchRunAt(Math.max(0, now - h.start)) : kind === "kyb" ? (h.story.review ? kybRun() : kybClean(kybRun())) : juryRun();
    const named = kind === "kyb" && merchant ? renamed(sample, "Corvane Analytics Inc.", merchant) : kind === "jury" && merchant ? renamed(sample, "Saltmarsh Outdoor Gear Co.", merchant) : sample;
    const g = retimed(named, h.start);
    const stopped = h.stopAt !== undefined && !g.run.endedAt;
    return { ...g, run: { ...g.run, id: h.story.id, agent: agent.id, revision: revisionOf(agent), ...(stopped ? { status: h.cancelled ? "cancelled" : "stopped", endedAt: iso(h.stopAt!) } : {}) }, read_at: iso(now) };
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
      if (h.stopAt !== undefined && h.stopAt < h.start + length) { status = h.cancelled ? "cancelled" : "completed"; state = "idle"; endedAt = h.stopAt; usd = whole * ((h.stopAt - h.start) / length); }
      else if (now >= h.start + length) { status = "completed"; state = "idle"; endedAt = h.start + length; }
      else usd = whole * Math.max(0, (now - h.start) / length);
    }
    const ended = endedAt !== null;
    const learns = !!agent.learning && ended && status === "completed";
    const merged = story.id === "demo-run-refund-by-agent";
    const run: Run = {
      run_id: story.id, agent_id: agent.id, agent_version: agent.notes.length, revision: revisionOf(agent), kind: agent.kind, sha: null,
      status, state, title: story.title, ...(story.effort ? { effort: story.effort } : {}), input: story.input, file_ids: [], place: { mode: "runner" }, claim: null,
      created_at: iso(h.start), updated_at: iso(endedAt ?? Math.min(now, h.start + 60 * MIN)), ended_at: ended ? iso(endedAt!) : null,
      result: status === "completed" ? { output: story.output ?? null, final_answer: finalAnswer } : null,
      error: status === "failed" && story.fails ? { code: story.fails.code, message: story.fails.message, retryable: false } : null,
      review: ended && status === "completed" && story.review ? { ...story.review, at: iso(endedAt!) } : null,
      pending,
      cost: { usd: Number(usd.toFixed(6)), basis: "estimate", charge_state: null, cap_usd: agent.maxCostUsd ?? null, tokens: tokensFor(usd, requests), tools_usd: 0, learning_usd: learns ? (merged ? 0.0312 : 0.0021) : 0, all_in_usd: Number((usd + (learns ? (merged ? 0.0312 : 0.0021) : 0)).toFixed(6)) },
      stopped_for: story.fails?.code === "spend_cap_reached" && status === "failed" ? "budget" : null, budget_refused_calls: 0, audit_of: null,
      path: story.path ?? (agent.kind === "agentic" ? "agent" : null),
      workflow: story.path && story.path !== "agent" ? { name: LEARNING_WORKFLOW, digest: LEARNING_DIGEST, repick: null } : null,
      approvals: "ask", archived_at: h.archivedAt ? iso(h.archivedAt) : null, imported_from: null,
      trigger: story.trigger ? { id: story.trigger, firing_key: `${story.trigger}:${story.id}` } : null, labels: {},
      learning: learns ? { state: merged ? "merged" : "dropped", reason: merged ? null : "empty", detail: merged ? "Kept one correction from this run: quote the policy line in the note." : "Nothing new to keep from this run.", at: iso(endedAt! + 4_000) } : null,
      recordings: [], poll_after_ms: ended ? 0 : 1000, last_progress_at: ended ? null : iso(Math.min(now, h.start + 60 * MIN)),
    };
    // Nothing moves a run that has ended, but for an archive, which is kept beside it.
    if (ended) h.settled = { ...run, archived_at: null };
    return run;
  };

  const all = () => [...held.values()];
  const newestFirst = (now = clock()) => all().filter((h) => h.start <= now).sort((a, b) => b.start - a.start);

  /** The agentic run's timeline rows at `now`, with its usage row once it has cost anything. */
  const rowsOf = (h: Held, now = clock()): TimelineRow[] => {
    if (!h.beats) return [];
    const p = play(h.beats, { start: h.start, now, answers: h.answers, stopAt: h.stopAt });
    const rows = [...p.rows];
    const ended = p.done || h.stopAt !== undefined;
    if (ended && p.requests) rows.push(usageRow(p.lastAt, rows.length, h.story.usd * (p.done ? 1 : p.requests / Math.max(p.requestsInAll, 1)), p.requests, true));
    return rows;
  };

  // ---- Agents ----

  const BLURB: Record<string, string> = { read: "Read files in the run's folder", write: "Write files in the run's folder", web_fetch: "Read a public web page", web_search: "Search the web", email_send: "Send an email", email_draft: "Save an email draft", ask_person: "Ask you a question mid-run", bash: "Run shell commands in the sandbox" };
  const nativeOf = (a: DemoAgent) => (a.native ? {
    runtime: a.native.runtime, project: a.native.project, selector: a.native.selector, machine_id: "mch_demo_laptop", version: a.native.version, model: a.model, fingerprint: hex(`${a.id}:setup`, 64),
    configuration: [{ path: a.native.runtime === "codex" ? "AGENTS.md" : "CLAUDE.md", sha256: hex(`${a.id}:config`, 64) }], skills: a.native.skills, mcp_servers: a.native.mcp,
    state: "ready" as const, issues: [], capabilities: { launch: true, learning: false, workflows: false as const, approval: "native" as const, usage: true }, connected: true, verified_at: iso(opened - 2 * HOUR),
  } : undefined);
  const definitionOf = (a: DemoAgent, version = a.notes.length): Agent["definition"] => {
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
      runs: { count: runs.length, live: runs.filter((h) => !viewOf(h, now).ended_at).length }, own_computer: null, region: "local", home_etag: `"${revisionOf(a)}"`, archived_at: null,
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
    return a.notes.map((note, i) => ({ revision: revisionOf(a, i + 1), version: i + 1, parent: i ? revisionOf(a, i) : null, kind: a.kind, current: i === a.notes.length - 1, note, created_at: iso(made + i * 6 * DAY), definition: definitionOf(a, i + 1) })).reverse();
  };

  // ---- Stats ----

  const statsOver = ({ from, agent, now = clock() }: { from?: number; agent?: string; now?: number }): Stats => {
    const views = newestFirst(now).filter((h) => (!agent || h.story.agent === agent) && (from === undefined || h.start >= from)).map((h) => ({ h, run: viewOf(h, now) }));
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
    const everything = newestFirst(now).map((h) => viewOf(h, now));
    const byDay = [...groups.day.values()].sort((a, b) => a.day.localeCompare(b.day)).map(round);
    return {
      agents: list.length,
      runs: { total: totals.runs, active: views.filter((v) => !v.run.ended_at && v.run.status !== "input_required").length, needs_input: views.filter((v) => v.run.status === "input_required").length, failed: totals.failed, needs_review: totals.needs_review, status_unknown: 0 },
      per_agent: list.map((a) => ({ agent_id: a.id, name: a.name, runs: everything.filter((r) => r.agent_id === a.id && (from === undefined || Date.parse(r.created_at) >= from)).length })),
      cost: { usd: Number(totals.cost_usd.toFixed(4)), basis: "estimate", unknown_runs: 0 },
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
  const TRIGGERS: { id: string; name: string; agent: string; source: Trigger["source"]; input: Record<string, unknown>; madeDaysAgo: number; nextIn?: number }[] = [
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
  const triggerOf = (t: (typeof TRIGGERS)[number], now = clock()): Trigger => {
    const firings = firingsOf(t.id, now);
    const made = opened - t.madeDaysAgo * DAY;
    return {
      id: t.id, name: t.name, enabled: enabled.get(t.id) ?? true, source: t.source,
      target: { kind: "start_run", agent_id: t.agent, input: t.input },
      catchup_window_s: 3600, max_active_runs: null, failures_in_a_row: 0, disabled: null,
      next_at: t.nextIn && (enabled.get(t.id) ?? true) ? iso(opened + t.nextIn) : null, last_run_id: firings[0]?.run_id ?? null,
      created_at: iso(made), updated_at: iso(made), last_firing: firings[0] ?? null,
      ...(t.source.kind === "webhook" ? { hook_url: `https://agentrun.larkspur.example/v2/hooks/${t.id}`, secret: { name: `trigger:${t.id}`, set: true, source: "saved", changed_at: iso(made) } } : {}),
    } as Trigger;
  };

  // ---- What the Refund desk learned ----

  let pendingApproved = false;
  const refundRuns = (now = clock()) => all().filter((h) => h.story.agent === "refund-desk" && h.start <= now).sort((a, b) => a.start - b.start);
  const takeoverAt = opened - TAKEOVER_DAYS_AGO * DAY;
  const learningOf = (id: string, now = clock()): AgentLearning => {
    const a = agents.get(id)!;
    const model = { location: "server" as const, ready: true, model: MODELS.default, needs: null, reason: null };
    if (!a.learning) return { agent: id, main: null, corrections: "", workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null, learning_model: model };
    if (id !== FULL_STORY) {
      // An agent earlier in its learning: the corrections it keeps, and for one, a workflow being checked against its past runs.
      const own = all().filter((h) => h.story.agent === id && h.start <= now);
      const kept = (a.learned?.corrections.match(/^- /gm) ?? []).length;
      const c = a.learned?.checking;
      const log = c ? [{ by: { run: own.at(-1)?.story.id ?? "" }, commit: hex(`${id}:learn:1`), at: iso(opened - 3 * DAY), reason: `Drafted ${c.name}`, files: [`workflows/${c.name}/workflow.json`] }] : [];
      return {
        agent: id, main: a.learned ? hex(`${id}:learn:1`) : null, corrections: a.learned?.corrections ?? "",
        workflows: c ? [{ name: c.name, file: `workflows/${c.name}/workflow.json`, readme: `workflows/${c.name}/README.md`, description: c.description, status: "checking", run: own.at(-1)?.story.id ?? null, bytes: 1180, etag: `"${hex(`${id}:etag`, 16)}"`, last_change: { kind: "approved", by: "person", at: iso(opened - 3 * DAY) } }] : [],
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
      agent: id, main: hex("learn:5"), corrections: CORRECTIONS_MD,
      workflows: [
        { name: LEARNING_WORKFLOW, file: `workflows/${LEARNING_WORKFLOW}/workflow.json`, readme: `workflows/${LEARNING_WORKFLOW}/README.md`, description: "Decides a refund request: policy line, refund amount, note and email draft.", status: "serving", run: first, bytes: JSON.stringify(REFUND_WORKFLOW).length, etag: `"${hex("etag:serving", 16)}"`, last_change: { kind: "approved", by: "person", at: iso(takeoverAt) } },
        { name: PENDING_WORKFLOW, file: `workflows/${PENDING_WORKFLOW}/workflow.json`, readme: `workflows/${PENDING_WORKFLOW}/README.md`, description: "Works out a changed-mind refund less the original shipping.", status: pendingApproved ? "checking" : "pending", run: runs.at(-9)?.story.id ?? null, bytes: 1412, etag: `"${hex(`etag:pending:${pendingApproved}`, 16)}"`, last_change: pendingApproved ? { kind: "approved", by: "person", at: iso(now) } : { kind: "learned", by: "run", at: iso(opened - 2 * DAY) } },
      ],
      log: { items: log, total: log.length, next_cursor: null },
      counts: { merged: 5, dropped: { empty: Math.max(runs.length - 9, 0), checker: 4 }, in_progress: 0 },
      impact: before.length && after.length ? { before: { runs: before.length, median_duration_s: seconds(before) }, after: { runs: after.length, median_duration_s: seconds(after) } } : null,
      learning_model: model,
    };
  };
  const approvePending = () => { pendingApproved = true; };

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
    return { run: run.run_id, state: run.learning.state, reason: run.learning.reason, detail: run.learning.detail, at: run.learning.at, seed: hex("learn:1"), merged: merged ? hex("learn:2") : null, workflows: [], corrections: merged ? 1 : 0, problems: [], compiled: null, draft_errors: [], used: { workflows: h.story.path && h.story.path !== "agent" ? [{ name: LEARNING_WORKFLOW, calls: 1, failed: 0 }] : [] } };
  };

  // ---- Files ----

  const INPUT_FILE = "inputs/message.md";
  const filesOf = (h: Held, now = clock()): Record<string, string> => {
    const content = typeof h.story.input.content === "string" ? h.story.input.content : null;
    const saved = new Set(rowsOf(h, now).map((r) => r.path).filter((p): p is string => !!p));
    const own = Object.fromEntries(Object.entries(h.story.files ?? {}).filter(([path]) => saved.has(path)));
    return { ...(content ? { [INPUT_FILE]: content } : {}), ...own };
  };

  // ---- What a person does ----

  let made = 0;
  /** Starts a run of `agentId` now, as a start from the playground or a trigger's Run now would: the agent's sample
   *  story, played live from this moment, opening with what was asked. */
  const start = (agentId: string, input: Record<string, unknown>, by: "person" | "trigger" = "person", trigger?: string): Run | null => {
    const a = agents.get(agentId);
    if (!a) return null;
    const said = typeof input.content === "string" && input.content.trim() ? input.content.trim() : null;
    const sample = heroes().find((s) => s.agent === agentId && s.beats) ?? history(opened).findLast((s) => s.agent === agentId && s.beats) ?? heroes().find((s) => s.agent === agentId)
      ?? { id: "", agent: agentId, title: a.name, startAgo: 0, input: {}, beats: standIn(said), usd: 0.004 } satisfies RunStory;
    // What was asked shows at once, as the run's first row.
    const beats = sample.beats?.map((b, i) => (i === 0 && b.k === "user" ? { ...b, wait: 0, text: said ?? b.text } : b));
    const story: RunStory = { ...sample, id: `demo-run-now-${++made}`, title: said ? said.split("\n")[0].slice(0, 80) : sample.title, startAgo: 0, input: Object.keys(input).length ? input : sample.input, ...(beats ? { beats } : {}), answered: [], hero: undefined, trigger: by === "trigger" ? trigger : undefined };
    return viewOf(hold(story, clock()));
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
    a.saved.push({ ...a.saved.at(-1), ...definition });
    a.notes = [...a.notes, note];
    if (typeof definition.description === "string") a.description = definition.description;
    if (typeof definition.model === "string") a.model = definition.model;
    a.learning = !!a.saved.at(-1)!.learning;
    return agentOf(a);
  };
  /** A run of an agent the story has no sample for (one made in the demo): a stand-in that says what demo mode is. */
  const standIn = (said: string | null): Beat[] => [
    { k: "user", text: said ?? "Run the agent." },
    { k: "think", text: "Demo mode calls no model, so this run is a stand-in for what the agent would do." },
    { k: "final", text: "This is a sample answer. Demo mode calls no model and starts nothing on your server. Turn demo mode off in Settings → Demo to run this agent for real." },
  ];
  const answer = (id: string, a: Omit<GateAnswer, "at">): boolean => {
    const h = held.get(id);
    if (!h || !viewOf(h).pending) return false;
    h.answers.push({ at: clock(), ...a });
    return true;
  };
  const stop = (id: string, cancelled: boolean): boolean => {
    const h = held.get(id);
    if (!h || viewOf(h).ended_at) return false;
    h.stopAt = clock(); h.cancelled = cancelled;
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
    fire: (id: string): Firing | null => { const t = TRIGGERS.find((x) => x.id === id); const run = t && start(t.agent, {}, "trigger", id); return run ? { key: `${id}:${run.run_id}`, by: "manual", nominal_at: run.created_at, status: "started", at: run.created_at, run_id: run.run_id, reason: null, error: null } : null; },
    learning: (id: string) => (agents.has(id) ? learningOf(id) : null),
    createAgent, saveDefinition, learningCost: learningCostOf, promotions: promotionsOf, loop: loopOf, audits: auditsOf, workflowRevisions: workflowRevisionsOf,
    learningFile: (file: string) => learningFiles[file] ?? null, approvePending,
    start, answer, stop, archive,
    /** A sample page image by its run-relative path, as a data URL. */
    page: (path: string) => fixturePages[path] ?? null,
  };
}
