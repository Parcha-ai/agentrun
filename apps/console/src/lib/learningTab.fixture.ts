import SAMPLE from "@/components/CostPerRun.sample.json";
import type { Agent } from "./agentForm";
import type { AgentLearning } from "./learning";
import type { AuditRow, Bill, CostRun, LearningCost, LearningLoop, Promotions } from "./v2";

// A whole Learning tab's reads for the console's stories and tests, invented: the cost sample (80 runs of an invoice
// sorter whose learned workflow serves from run 21) with a bill over it, two revisions of that workflow (the first held
// by its audits at run 50, the second serving from there), their promotion records, and an audit ledger with a row for
// each audited run and one owner's grade. Every figure is made up; none is a measurement.

export const WORKFLOW = "sort-invoice";
/** The first revision's digest (the sample's) and the second's, which serves from run `SECOND_FROM`. */
export const FIRST = "a12596c0a12596c0";
export const SECOND = "c4e81f90c4e81f90";
export const SECOND_FROM = 50;
/** Each revision's check spend (its replay runs), carried by its first `k` served runs. */
const CHECK = { spend: 1.2, k: 20 };
const round = (value: number) => Math.round(value * 1e6) / 1e6;

const sample = SAMPLE as unknown as LearningCost;
const served = (r: CostRun) => r.path === "workflow" || r.path === "handed_back";
/** The audited runs by revision: the run numbers a shadow ran for, and those of them that disagreed. */
const AUDITED: Record<string, { rows: number[]; disagreed: number[] }> = {
  [FIRST]: { rows: [22, 26, 29, 33, 38, 42, 46, 49], disagreed: [38, 46, 49] },
  [SECOND]: { rows: [51, 55, 60, 64, 69, 75], disagreed: [] },
};
const auditedRuns = new Set(Object.values(AUDITED).flatMap((a) => a.rows));

export const RUNS: CostRun[] = sample.runs.map((r) => {
  const digest = served(r) ? (r.n! >= SECOND_FROM ? SECOND : FIRST) : null;
  const first = served(r) && (r.n === sample.summary.takeover!.n || r.n === SECOND_FROM);
  return { ...r, digest, took_over: first, cost_upper_bound: false, audited: served(r) && auditedRuns.has(r.n!) };
});
const run = (n: number) => RUNS.find((r) => r.n === n)!;

/** The bill over the runs as the server totals it: every run all in, cumulative, the first revision's served runs
 *  carrying its check's share; against the mean of the agent's own runs before the promotion, times the runs. */
function billOf(runs: readonly CostRun[]): Bill {
  const promoted = runs.find(served)!;
  const before = runs.filter((r) => r.n! < promoted.n! && r.path === "agent");
  const mean = round(before.reduce((sum, r) => sum + r.cost_usd!, 0) / before.length);
  let sum = 0, carried = 0;
  const points = runs.map((r, i) => {
    const share = served(r) && carried < CHECK.k ? (carried++, CHECK.spend / CHECK.k) : 0;
    sum += r.total_usd! + share;
    return { n: i + 1, run_id: r.run_id, actual_usd: round(sum), agent_usd: round(mean * (i + 1)) };
  });
  const from = promoted.n! - 1;
  const over = points.findLastIndex((p, i) => i >= from && p.actual_usd > p.agent_usd);
  const even = over + 1 < points.length ? points[Math.max(over + 1, from)]! : null;
  const jobs = runs.reduce((total, r) => total + r.cost_usd!, 0);
  return {
    baseline: { runs: before.length, mean_usd: mean }, promoted: { n: promoted.n!, run_id: promoted.run_id, at: promoted.started_at },
    learning_usd: round(points.at(-1)!.actual_usd - jobs), points,
    break_even: even && { n: even.n, run_id: even.run_id }, gap_usd: even ? null : round(points.at(-1)!.actual_usd - points.at(-1)!.agent_usd),
    withheld: 0, booked_usd: points.at(-1)!.actual_usd,
    revisions: [
      { workflow: WORKFLOW, digest: FIRST, compile_usd: 0, check_usd: CHECK.spend, spend_usd: CHECK.spend, k: CHECK.k, served: CHECK.k, attributed_usd: CHECK.spend, unattributed_usd: 0, state: "stopped" },
      { workflow: WORKFLOW, digest: SECOND, compile_usd: 0, check_usd: 0, spend_usd: 0, k: CHECK.k, served: CHECK.k, attributed_usd: 0, unattributed_usd: 0, state: "serving" },
    ],
    unattributed_usd: 0,
    holds: [{ n: SECOND_FROM, at: run(SECOND_FROM).started_at, workflow: WORKFLOW, by: "audit", reason: "3 of the newest 8 audits disagreed" }],
  };
}

export const COST: LearningCost = {
  ...sample, agent: "invoice-sorter", runs: RUNS, unknown_path_runs: 0, bill: billOf(RUNS),
  // The serving champion's check, as its promotion record has it below.
  summary: { ...sample.summary, replay: { n: 23, workflow_pct: 91, agent_pct: 100, cleared: true, agreed: 21, alone: 22, agree_min: 0.8 } },
};

export const AUDITS: AuditRow[] = [
  ...Object.entries(AUDITED).flatMap(([digest, { rows, disagreed }]) => rows.map((n): AuditRow => ({
    run: run(n).run_id, shadow_run: `audit.${run(n).run_id}`, workflow: WORKFLOW, digest, promoted_at: run(digest === FIRST ? sample.summary.takeover!.n : SECOND_FROM).started_at,
    source: "shadow", agreed: !disagreed.includes(n), served_cost: run(n).cost_usd, shadow_cost: round(0.78 + ((n * 37) % 23) / 100), at: run(n).started_at,
  }))),
  // The owner graded one run the second revision answered alone: a row of the ledger too.
  { run: run(72).run_id, shadow_run: null, workflow: WORKFLOW, digest: SECOND, promoted_at: run(SECOND_FROM).started_at, source: "grade", agreed: true, served_cost: run(72).cost_usd, shadow_cost: null, at: run(72).started_at },
];

const COMMIT = "c".repeat(40);
const NODES: NonNullable<NonNullable<Promotions["serving"][number]["champion"]>["nodes"]> = [
  { path: "0", kind: "extract", label: "fields", tier: "fast", checks: [] },
  { path: "1", kind: "decide", label: "account", tier: "agent", checks: [] },
  { path: "2", kind: "escalate", label: "unsure", tier: null, checks: [{ on: "when", predicate: { predicate: "field_equals", path: "account.code", value: "unknown" } }] },
];
const check = (n: number, alone: number, agreed: number): NonNullable<Promotions["promotions"][number]["check"]> => ({ compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n, alone, agreed, of: [], cost_usd: CHECK.spend });
const disagreements = AUDITED[FIRST]!.disagreed.map((n) => ({ run: `audit.${run(n).run_id}`, served: run(n).run_id, input: `invoice ${n}`, agent: "6100 Office supplies", draft: "6400 Software" }));

export const PROMOTIONS: Promotions = {
  agent: "invoice-sorter",
  promotions: [
    { workflow: WORKFLOW, digest: FIRST, at: run(sample.summary.takeover!.n).started_at, decided: "promote", reason: "checked on 20 inputs", check: check(20, 17, 15), runs: [], commit: COMMIT },
    { workflow: WORKFLOW, digest: FIRST, at: run(SECOND_FROM).started_at, decided: "hold", reason: "3 of the newest 8 audits disagreed", audit: { window: 10, disagree: 3, rows: 8, disagreements } },
    { workflow: WORKFLOW, digest: SECOND, at: run(SECOND_FROM).started_at, decided: "promote", reason: "checked on 23 inputs", check: check(23, 22, 21), runs: [], commit: COMMIT },
  ],
  serving: [{
    workflow: WORKFLOW, digest: SECOND, replaying: null, state: "serving", check: { n: 23, agreed: 21, alone: 22, attempt: 1 },
    audit: { window: 10, disagree: 3, rows: 7, disagreed: 0 }, audits_off: null, not_auditable: 0,
    champion: { digest: SECOND, commit: COMMIT, nodes: NODES, check: check(23, 22, 21) },
  }],
};

export const LOOP: LearningLoop = {
  agent: "invoice-sorter", completed_runs: RUNS.length,
  compiles: [
    { run_id: run(SECOND_FROM - 1).run_id, round: 2, at: run(SECOND_FROM - 1).started_at, workflow: WORKFLOW, attempts: [{ ok: true, errors: [] }], digest: SECOND, promoted: true, draft_errors: [], withheld: false },
    { run_id: run(20).run_id, round: 1, at: run(20).started_at, workflow: WORKFLOW, attempts: [{ ok: true, errors: [] }], digest: FIRST, promoted: true, draft_errors: [], withheld: false },
  ],
};

export const AGENT: Agent = {
  agent_id: "invoice-sorter", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", harness: "pi", skills: [], tools: ["read"], learning: true },
};

export const VIEW: AgentLearning = {
  agent: "invoice-sorter", main: "c3",
  corrections: "- A subscription invoice goes to 6400 Software, never 6100 Office supplies.\n- Ask when the invoice names no vendor.\n",
  workflows: [{ name: WORKFLOW, file: `workflows/${WORKFLOW}/workflow.json`, readme: `workflows/${WORKFLOW}/README.md`, description: "Sorts an invoice into its ledger account", status: "serving", run: run(SECOND_FROM - 1).run_id, bytes: 1840, etag: '"readme-v2"' }],
  log: { items: [{ by: { run: run(SECOND_FROM - 1).run_id }, commit: "c3", at: run(SECOND_FROM - 1).started_at, reason: "A new revision after its audits disagreed.", files: [`workflows/${WORKFLOW}/workflow.json`] }], total: 1, next_cursor: null },
  counts: { merged: 2, dropped: {}, in_progress: 0 },
  impact: { before: { runs: 20, median_duration_s: 41 }, after: { runs: 59, median_duration_s: 6 } },
};

/** A client that answers the tab's reads with the fixture, for a story or a test: every write resolves and changes nothing. */
export function fixtureClient(over: Partial<{ cost: LearningCost; audits: AuditRow[]; promotions: Promotions; view: AgentLearning; loop: LearningLoop }> = {}) {
  const view = over.view ?? VIEW;
  return {
    agentLearning: async () => view,
    listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    corrections: async () => ({ text: view.corrections, etag: '"c-v1"', cap_bytes: 2048 }),
    writeCorrections: async (_id: string, text: string) => ({ text, etag: '"c-v2"', cap_bytes: 2048 }),
    readLearningFile: async (_id: string, file: string) => ({ text: "{}\n", etag: `"v-${file}"` }),
    retireWorkflow: async () => ({ text: "", etag: '"v3"' }),
    approveWorkflow: async () => ({ text: "", etag: '"v4"' }),
    restoreWorkflow: async () => ({ text: "", etag: '"v5"' }),
    getAgent: async () => ({ agent: AGENT, etag: '"rv1"' }),
    updateDefinition: async () => ({ agent: AGENT, etag: '"rv2"' }),
    capabilities: async () => ({}),
    learnedWorkflowRevisions: async (_id: string, name: string) => ({ name, revisions: [], total: 0, truncated: false }),
    learningCost: async () => over.cost ?? COST,
    learningPromotions: async () => over.promotions ?? PROMOTIONS,
    learningLoop: async () => over.loop ?? LOOP,
    learningAudits: async () => ({ agent: AGENT.agent_id, audits: over.audits ?? AUDITS }),
  };
}
