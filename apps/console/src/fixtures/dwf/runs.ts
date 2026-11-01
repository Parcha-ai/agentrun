// Workflow runs as GET /v2/runs/{id}/graph gives them (contract C4), written for the console's stories and tests before
// serve's route existed: a 20-document batch at any moment of its run, a KYB check with Parallel's citations, and a jury
// of four decision models that disagree. Synthetic: the companies, documents, sources, costs and latencies are invented.
import { workflowGraph } from "@dsl/graph";
import type { Answer, Decision, Effect, NodeRun, Question, RunGraph, RunItem } from "@/lib/runGraph";
import { certificate, COMPANIES, type Company } from "./pages";
import { batchWorkflow, DOC_CHECKS, juryWorkflow, kybWorkflow } from "./workflows";

const iso = (t0: string, ms: number) => new Date(Date.parse(t0) + ms).toISOString();
const stem = (file: string) => file.replace(/\.pdf$/, "");
const pageRef = (c: Company) => `pages/${stem(c.file)}/1.png`;
const fileUrl = (run: string, ref: string) => `/v2/runs/${run}/files/${ref}`;
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const qs = (schema: { properties: Record<string, { description: string }> }): Record<string, Question> =>
  Object.fromEntries(Object.entries(schema.properties).map(([id, p]) => [id, { type: "noul", instructions: p.description }]));
const pageText = (c: Company) => `STATE OF ${c.state.toUpperCase()}\nOFFICE OF THE SECRETARY OF STATE\nCertificate of Incorporation\n${c.name}\nI, ${c.officer}, Secretary of State of the State of ${c.state}, do hereby certify that the attached is a true and correct copy of the Certificate of Incorporation of "${c.name.toUpperCase()}", filed in this office on the date below, under file number ${c.number}.\nFiled: ${c.filed}\nFile number: ${c.number}`;

/** Every page image the fixtures name, by its run-relative ref: what GET /v2/runs/{id}/files/{ref} would return. */
export const fixturePages: Record<string, string> = {};
for (const [i, c] of COMPANIES.entries()) fixturePages[pageRef(c)] = certificate(c, { altered: i === 5, noSeal: i === 12, faint: i === 15 });
export const fixtureFileUrl = (ref: string) => fixturePages[ref] ?? "";

// ---- batch-20: map(pdf_pages -> Jev image judge -> grade) -> report -------------------------------------------------

export const BATCH_RUN = "run_01JD7K2X9QH4M8B6TPC3ZV5W1R";
const BATCH_T0 = "2026-10-30T15:02:11.000Z";
const MAP = "/root/steps/0";
const RENDER = `${MAP}/body/steps/0`;
const INSPECT = `${MAP}/body/steps/1`;
const GRADE = `${MAP}/body/steps/2`;
const REPORT = "/root/steps/1";

/** What happens to each document: most read clean; one is altered, one has no seal, one is faint; one PDF is broken, one
 *  call is rate limited past its deadline, and one call's outcome is unknown, so its item goes to review. */
const FATE: Record<number, "render_failed" | "rate_limited" | "interrupted"> = { 3: "render_failed", 7: "rate_limited", 9: "interrupted" };
const SCORES: Record<number, Partial<Record<"altered" | "seal" | "signature" | "legible", number>>> = { 5: { altered: 0.86 }, 12: { seal: 0.07 }, 15: { legible: 0.58, signature: 0.71 } };
const jitter = (i: number, k: number) => ((i * 7919 + k * 104729) % 1000) / 1000;

type Plan = { i: number; c: Company; start: number; renderEnd: number; judgeStart: number; judgeEnd: number; end: number };
const PLAN: Plan[] = (() => {
  const free = [0, 0, 0, 0];
  return COMPANIES.map((c, i) => {
    const slot = free.indexOf(Math.min(...free));
    const start = free[slot] + 15;
    const renderEnd = start + 700 + Math.round(jitter(i, 1) * 1100);
    const judgeStart = renderEnd + 30;
    const judgeEnd = FATE[i] === "render_failed" ? renderEnd : judgeStart + 1300 + Math.round(jitter(i, 2) * 1700);
    const end = judgeEnd + 12;
    free[slot] = end;
    return { i, c, start, renderEnd, judgeStart, judgeEnd, end };
  });
})();
export const BATCH_DURATION = Math.max(...PLAN.map((p) => p.end)) + 60;

function batchDecision(p: Plan): Decision | null {
  const fate = FATE[p.i];
  if (fate === "render_failed") return null;
  const s = { altered: 0.03 + jitter(p.i, 3) * 0.05, seal: 0.93 + jitter(p.i, 4) * 0.06, signature: 0.88 + jitter(p.i, 5) * 0.1, legible: 0.95 + jitter(p.i, 6) * 0.045, ...SCORES[p.i] };
  const answered = !fate;
  const ref = pageRef(p.c);
  return {
    id: `dec_${stem(p.c.file)}_inspect`, node: INSPECT, executionPath: `${MAP}/items/${p.i}/body/steps/1`, item: p.i, kind: "judge",
    provider: "jev", model: "jev-latest", status: answered ? "answered" : fate === "interrupted" ? "cancelled" : "failed",
    questions: qs(DOC_CHECKS),
    answers: answered ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, noul(Number(v.toFixed(3)))])) : {},
    rule: answered ? { kind: "judge" } : null,
    action: answered ? { altered: s.altered >= 0.5, seal: s.seal >= 0.5, signature: s.signature >= 0.5, legible: s.legible >= 0.5 } : null,
    cost_usd: fate === "rate_limited" ? 0 : fate === "interrupted" ? null : Number((0.0036 + jitter(p.i, 7) * 0.0011).toFixed(5)),
    cost_basis: fate === "interrupted" ? "unknown" : "provider",
    latency_ms: p.judgeEnd - p.judgeStart,
    state: { document: p.c.file, page: "<page1>", text: pageText(p.c) },
    state_truncated: false,
    images: [{ token: "<page1>", ref, url: fileUrl(BATCH_RUN, ref) }],
    ...(fate === "rate_limited" ? { error: "rate_limited: 429 Too Many Requests; Retry-After 30 s is past the node's deadline" } : {}),
    ...(fate === "interrupted" ? { error: "outcome_unknown: the connection closed after the request was sent; not asked again" } : {}),
  };
}

function batchEffect(p: Plan, t: number): Effect | null {
  if (t < p.start) return null;
  const done = t >= p.renderEnd;
  const failed = FATE[p.i] === "render_failed";
  const ref = pageRef(p.c);
  return {
    node: RENDER, executionPath: `${MAP}/items/${p.i}/body/steps/0`, item: p.i, tool: "pdf_pages",
    status: !done ? "working" : failed ? "failed" : "done",
    input: { path: p.c.file, maxPages: 2 },
    output: !done ? null : failed
      ? { error: { code: "exit", message: "pdftoppm exited 1: Syntax Error: Couldn't find trailer dictionary" } }
      : { name: p.c.file, pageCount: 1, pages: [{ page: 1, image: ref }], text: pageText(p.c) },
    startedAt: iso(BATCH_T0, p.start), ...(done ? { endedAt: iso(BATCH_T0, p.renderEnd) } : {}),
  };
}

/** The batch run as the graph route gives it `t` milliseconds after it started (and paused, when asked). */
export function batchRunAt(t: number, { paused = false } = {}): RunGraph {
  const items: RunItem[] = PLAN.map((p) => {
    const fate = FATE[p.i];
    const status = t < p.start ? "pending" : t < p.end ? "working" : fate === "interrupted" ? "needs_review" : fate ? "failed" : "done";
    return { index: p.i, status, executionPath: `${MAP}/items/${p.i}`, label: p.c.file };
  });
  const effects = PLAN.map((p) => batchEffect(p, t)).filter((e): e is Effect => !!e);
  const decisions = PLAN.filter((p) => t >= p.judgeEnd).map(batchDecision).filter((d): d is Decision => !!d);
  const mapDone = PLAN.every((p) => t >= p.end);
  const ended = t >= BATCH_DURATION;
  const started = (from: number) => (t >= from ? iso(BATCH_T0, from) : undefined);
  const any = (pred: (p: Plan) => boolean) => PLAN.some(pred);
  const agg = (begin: (p: Plan) => number): NodeRun => ({
    status: mapDone ? "done" : any((p) => t >= begin(p)) ? "working" : "pending",
    startedAt: started(Math.min(...PLAN.map(begin))),
  });
  const nodes: Record<string, NodeRun> = {
    "/root": { status: ended ? "done" : "working", startedAt: BATCH_T0, ...(ended ? { endedAt: iso(BATCH_T0, BATCH_DURATION) } : {}) },
    [MAP]: { status: mapDone ? "done" : "working", startedAt: BATCH_T0, items },
    [`${MAP}/body`]: { status: mapDone ? "done" : "working" },
    [RENDER]: agg((p) => p.start),
    [INSPECT]: agg((p) => p.judgeStart),
    [GRADE]: agg((p) => p.judgeEnd),
    [REPORT]: { status: ended ? "done" : mapDone ? "working" : "pending" },
  };
  const known = decisions.map((d) => d.cost_usd);
  return {
    run: { id: BATCH_RUN, agent: "agt_coi_batch", revision: "rev_3", status: ended ? "completed" : "working", paused: paused && !ended, startedAt: BATCH_T0, endedAt: ended ? iso(BATCH_T0, BATCH_DURATION) : null },
    workflow: batchWorkflow,
    graph: workflowGraph(batchWorkflow),
    nodes,
    decisions,
    effects,
    totals: { cost_usd: known.some((c) => c === null) ? null : known.reduce<number>((a, c) => a + (c ?? 0), 0), decisions: decisions.length, effects: effects.length, elapsed_ms: Math.min(t, BATCH_DURATION) },
  };
}

/** Mid-flight: about half the documents read, three settled badly, four in flight. */
export const BATCH_MID = 9800;
export const batchMidRun = () => batchRunAt(BATCH_MID);
export const batchPausedRun = () => batchRunAt(BATCH_MID, { paused: true });
export const batchDoneRun = () => batchRunAt(BATCH_DURATION + 1);

// ---- kyb: pdf_pages -> parallel{ Parallel registry lookup ; Jev certificate look } -> cross-check -> route ---------

export const KYB_RUN = "run_01JD7M4F2C8N1S5VXK7QDR3E9A";
const KYB_T0 = "2026-10-30T15:20:42.000Z";
const corvane = COMPANIES[1];

export function kybRun(): RunGraph {
  const ref = pageRef(corvane);
  const t = (ms: number) => iso(KYB_T0, ms);
  const decisions: Decision[] = [
    {
      id: "dec_kyb_registry", node: "/root/steps/1/branches/0", executionPath: "/root/steps/1/branches/0", item: null, kind: "judge",
      provider: "parallel", model: "standard", status: "answered",
      questions: qs(kybWorkflow.schemas.Registry),
      answers: { registered: noul(0.97), active: noul(0.94), name_matches: noul(0.91) },
      rule: { kind: "judge" }, action: { registered: true, active: true, name_matches: true },
      cost_usd: 0.01, cost_basis: "provider", latency_ms: 21430,
      evidence: [
        { url: "https://corp.delaware.example/entity/7340291", title: "Division of Corporations: Entity Details, CORVANE ANALYTICS, INC.", scope: "registered", excerpts: ["File Number: 7340291. Incorporation Date / Formation Date: 08/05/2021. Entity Kind: Corporation. Entity Type: General. Residency: Domestic. State: DELAWARE.", "Registered Agent: Harbor Agents Inc., 1209 Orange Grove Rd, Wilmington, DE 19801."] },
        { url: "https://corp.delaware.example/entity/7340291/status", title: "Status: Good Standing, as of 10/28/2026", scope: "active", excerpts: ["Status: Good Standing. Franchise tax filed for 2025. No forfeiture or voidance recorded."] },
        { url: "https://www.corvane-analytics.example/about", title: "About Corvane Analytics", scope: "name_matches", excerpts: ["Corvane Analytics, Inc. is a Delaware corporation headquartered in Austin, Texas, building demand-forecasting software for regional grocers."] },
      ],
      state: { company: corvane.name, state: corvane.state, registration_number: corvane.number }, state_truncated: false, images: [],
    },
    {
      id: "dec_kyb_look", node: "/root/steps/1/branches/1", executionPath: "/root/steps/1/branches/1", item: null, kind: "judge",
      provider: "jev", model: "jev-latest", status: "answered",
      questions: qs(kybWorkflow.schemas.CertLook),
      answers: { altered: noul(0.07), seal: noul(0.96), legible: noul(0.98) },
      rule: { kind: "judge" }, action: { altered: false, seal: true, legible: true },
      cost_usd: 0.0042, cost_basis: "provider", latency_ms: 2310,
      state: { page: "<cert>", text: pageText(corvane) }, state_truncated: false, images: [{ token: "<cert>", ref, url: fileUrl(KYB_RUN, ref) }],
    },
    {
      id: "dec_kyb_cross", node: "/root/steps/2", executionPath: "/root/steps/2", item: null, kind: "judge",
      provider: "jev", model: "jev-latest", status: "answered",
      questions: qs(kybWorkflow.schemas.CrossCheck),
      answers: { same_entity: noul(0.95), same_state: noul(0.98), dates_consistent: noul(0.38) },
      rule: { kind: "judge" }, action: { same_entity: true, same_state: true, dates_consistent: false },
      cost_usd: 0.0016, cost_basis: "provider", latency_ms: 910,
      state: { applicant: { company: corvane.name, state: corvane.state }, registry: { answers: { registered: 0.97, active: 0.94, name_matches: 0.91 }, formation_date: "2021-08-05" }, certificate_text: pageText(corvane) }, state_truncated: false, images: [],
    },
    {
      id: "dec_kyb_route", node: "/root/steps/3", executionPath: "/root/steps/3", item: null, kind: "route",
      provider: "jev", model: "jev-latest", status: "answered",
      questions: { branch: { type: "choice", instructions: kybWorkflow.root.steps[3].instructions as string, criteria: Object.fromEntries(Object.entries(kybWorkflow.root.steps[3].branches as Record<string, { criteria: string }>).map(([k, v]) => [k, v.criteria])) } },
      answers: { branch: { type: "choice", choice: "approve", probabilities: { approve: 0.61, review: 0.33, reject: 0.06 }, confidence: 0.61 } },
      rule: { kind: "route", branches: ["approve", "review", "reject"], unsure: { gte: 0.75, branch: "review" } },
      action: { branch: "approve", taken: "review", unsure: true },
      cost_usd: 0.0012, cost_basis: "provider", latency_ms: 740,
      state: { registry: { registered: true, active: true, name_matches: true }, look: { altered: false, seal: true, legible: true }, cross: { same_entity: true, same_state: true, dates_consistent: false } }, state_truncated: false, images: [],
    },
  ];
  const effects: Effect[] = [{
    node: "/root/steps/0", executionPath: "/root/steps/0", item: null, tool: "pdf_pages", status: "done",
    input: { path: corvane.file, maxPages: 1 }, output: { name: corvane.file, pageCount: 1, pages: [{ page: 1, image: ref }], text: pageText(corvane) },
    startedAt: t(40), endedAt: t(1220),
  }];
  const nodes: Record<string, NodeRun> = {
    "/root": { status: "done", startedAt: t(0), endedAt: t(24980) },
    "/root/steps/0": { status: "done", startedAt: t(40), endedAt: t(1220) },
    "/root/steps/1": { status: "done", startedAt: t(1240), endedAt: t(22690) },
    "/root/steps/1/branches/0": { status: "done", startedAt: t(1250), endedAt: t(22680) },
    "/root/steps/1/branches/1": { status: "done", startedAt: t(1250), endedAt: t(3560) },
    "/root/steps/2": { status: "done", startedAt: t(22700), endedAt: t(23610) },
    "/root/steps/3": { status: "done", startedAt: t(23620), endedAt: t(24960), branch: "review" },
    "/root/steps/3/branches/approve/body": { status: "not_run" },
    "/root/steps/3/branches/review/body": { status: "done", startedAt: t(24365), endedAt: t(24960) },
    "/root/steps/3/branches/reject/body": { status: "not_run" },
  };
  return {
    run: { id: KYB_RUN, agent: "agt_kyb", revision: "rev_7", status: "completed", paused: false, startedAt: t(0), endedAt: t(24980) },
    workflow: kybWorkflow, graph: workflowGraph(kybWorkflow), nodes, decisions, effects,
    totals: { cost_usd: decisions.reduce((a, d) => a + (d.cost_usd ?? 0), 0), decisions: decisions.length, effects: effects.length, elapsed_ms: 24980 },
  };
}

// ---- jury: fetch_page -> parallel{ Jev, three OpenRouter decision models } -> aggregate -> route by value ----------

export const JURY_RUN = "run_01JD7P0B6W3T9Y2HQX4N8KM5CF";
const JURY_T0 = "2026-10-30T15:31:07.000Z";
const STOREFRONT = "Saltmarsh Outdoor Gear Co. sells camping, fishing and hunting supplies: fixed-blade hunting knives (4 to 7 inch), bear deterrent spray (EPA registered, 9.2 oz), folding saws, fire starters, and a 'trail kit' bundle. Shipping to all 50 states; bear spray not shipped to CA, NY or HI. Age verification at checkout for knives and sprays.";

export function juryRun(): RunGraph {
  const t = (ms: number) => iso(JURY_T0, ms);
  const juror = (k: number, label: string, provider: string, model: string, p: number, cost: number, latency: number, evidence?: Decision["evidence"]): Decision => ({
    id: `dec_jury_${label}`, node: `/root/steps/1/branches/${k}`, executionPath: `/root/steps/1/branches/${k}`, item: null, kind: "judge",
    provider, model, status: "answered",
    questions: qs(juryWorkflow.schemas.Prohibited), answers: { prohibited: noul(p) }, rule: { kind: "judge" }, action: { prohibited: p >= 0.5 },
    cost_usd: cost, cost_basis: "provider", latency_ms: latency, ...(evidence ? { evidence } : {}),
    state: { merchant: "Saltmarsh Outdoor Gear Co.", url: "https://saltmarsh-outdoor.example", page_text: STOREFRONT }, state_truncated: false, images: [],
  });
  const decisions = [
    juror(0, "jev", "jev", "jev-latest", 0.62, 0.0011, 640),
    juror(1, "pplx-decider", "openrouter", "perplexity/pplx-decider-v1.2", 0.21, 0.006, 3120, [
      { url: "https://saltmarsh-outdoor.example/shipping", title: "Shipping and restricted items", scope: "prohibited", excerpts: ["Bear deterrent spray is not shipped to California, New York or Hawaii. Knives ship with adult signature required."] },
      { url: "https://network-rules.example/prohibited-merchandise", title: "Card network rules: prohibited and restricted merchandise", scope: "prohibited", excerpts: ["Sporting knives and EPA-registered animal deterrents are restricted, not prohibited, when sold with age verification."] },
    ]),
    juror(2, "liquid-d1", "openrouter", "liquid/d1", 0.74, 0.0009, 410),
    juror(3, "clef", "openrouter", "cloudflare/clef", 0.35, 0.0004, 380),
  ];
  const effects: Effect[] = [{
    node: "/root/steps/0", executionPath: "/root/steps/0", item: null, tool: "fetch_page", status: "done",
    input: { url: "https://saltmarsh-outdoor.example" }, output: { status: 200, url: "https://saltmarsh-outdoor.example/", title: "Saltmarsh Outdoor Gear: camp, fish, hunt", text: STOREFRONT },
    startedAt: t(30), endedAt: t(880),
  }];
  const nodes: Record<string, NodeRun> = {
    "/root": { status: "done", startedAt: t(0), endedAt: t(4110) },
    "/root/steps/0": { status: "done", startedAt: t(30), endedAt: t(880) },
    "/root/steps/1": { status: "done", startedAt: t(900), endedAt: t(4030) },
    ...Object.fromEntries([640, 3120, 410, 380].map((l, k) => [`/root/steps/1/branches/${k}`, { status: "done" as const, startedAt: t(905), endedAt: t(905 + l) }])),
    "/root/steps/2": { status: "done", startedAt: t(4040), endedAt: t(4046) },
    "/root/steps/3": { status: "done", startedAt: t(4050), endedAt: t(4100), branch: "disagree" },
    "/root/steps/3/branches/agree/body": { status: "not_run" },
    "/root/steps/3/branches/disagree/body": { status: "done", startedAt: t(4052), endedAt: t(4100) },
  };
  return {
    run: { id: JURY_RUN, agent: "agt_jury", revision: "rev_2", status: "completed", paused: false, startedAt: t(0), endedAt: t(4110) },
    workflow: juryWorkflow, graph: workflowGraph(juryWorkflow), nodes, decisions, effects,
    totals: { cost_usd: decisions.reduce((a, d) => a + (d.cost_usd ?? 0), 0), decisions: decisions.length, effects: effects.length, elapsed_ms: 4110 },
  };
}
