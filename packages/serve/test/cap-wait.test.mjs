// Near its cap, a run's parallel steps wait for each other's holds to settle instead of parking (runBooking's line under
// the kernel's runCap), through the API with faux models and a faux monid, no key and no network:
// - 8 subagents at once under a $0.50 cap that covers what they cost many times over but not all their worst cases at
//   once: every child answers and the run completes, where it parked at spend_cap_reached before;
// - a burst of 25 paid calls (20 direct, 5 from one codemode script), each held at $1 and charged $0.02, under a $4 cap:
//   all are made and the run completes, at about $0.50;
// - in both, the cap is never passed: at every admission the run's booked spend and its open holds together are within it;
// - a step that cannot fit even once the steps in flight settle is still refused (a paid call at once, while cheaper calls
//   are out; a child's request once the run's spend leaves no room), and the run parks in words that say what is spent
//   and what is held apart, its pending figures too (spent_usd is never a hold);
// - a cancel while steps wait for room: they leave the line unsent, and nothing more is asked of any model;
// - a running run's listed spend is what it spent, never a hold (metrics.ts bookedListSpend).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as metrics from "../dist/runner/metrics.js";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, journalOf, scratch, serve, withEnv } from "./support.mjs";

const FAUX_CAP_WAIT = new URL("./fixtures/faux-cap-wait.mjs", import.meta.url).pathname;
const FAUX_BURST = new URL("./fixtures/faux-burst.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const ENDED = ["completed", "failed", "cancelled", "input_required"];
/** monid's endpoint listed at $1 a call (fixtures/faux-monid.mjs), its tool's name, and its permission. */
const LOOKUP = "monid:faux/person/lookup";
const LOOKUP_TOOL = "monid__faux__person__lookup";
const ALLOWED = { [LOOKUP]: { permission: "allow" } };
/** monid's endpoint listed at $0.003 a call, and its tool's name. */
const ENRICH = "monid:faux/person/enrich";
const ENRICH_TOOL = "monid__faux__person__enrich";

/** Every admission of the run, replayed from its journal in log order (every session's runner records): the booked
 *  spend and the open holds together as each step was admitted, each step's own hold among them. */
function admissions(entries) {
  const open = new Map();
  let spent = 0;
  const peaks = [];
  for (const entry of entries) {
    const data = entry.data ?? {};
    const id = `${entry.conversationId}:${data.turn}`;
    if (entry.kind === "runner.request") {
      open.set(id, typeof data.heldUsd === "number" ? data.heldUsd : 0);
      peaks.push(spent + [...open.values()].reduce((sum, usd) => sum + usd, 0));
    } else if (entry.kind === "runner.turn") {
      const held = open.get(id) ?? 0;
      open.delete(id);
      const figure = typeof data.bookedUsd === "number" ? data.bookedUsd : typeof data.usd === "number" ? data.usd : held;
      spent += data.unsent || data.givenBack ? 0 : figure;
    }
  }
  return peaks;
}

/** The run's bookings in log order, for a reader: each step's session with "+" its hold as admitted or "-" what it was
 *  booked at once settled. */
const traceOf = (entries) => entries.filter((e) => e.kind === "runner.request" || e.kind === "runner.turn").map((e) => `${e.conversationId}${e.kind === "runner.request" ? `+${(e.data?.heldUsd ?? 0).toFixed(3)}` : `-${(e.data?.bookedUsd ?? e.data?.usd ?? 0).toFixed(3)}`}`).join(" ");
/** The run's journal entries that say a step was refused at the cap (a paid call's refusal its model read as a result). */
const capRefusals = (entries) => entries.filter((e) => JSON.stringify(e.data ?? {}).includes("spend_cap_reached"));

/** A server whose faux models are `faux` (the subagent replies at a real run's price shape, by default), its fixture log. */
async function setup(t, { faux = FAUX_CAP_WAIT, monid = false, charge = "0.02" } = {}) {
  const tag = randomBytes(6).toString("hex");
  const log = join(process.env.TMPDIR ?? "/tmp", `faux-cap-wait-${tag}.jsonl`);
  const monidLog = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, {
    FAUX_SUBAGENT_LOG: log,
    FAUX_SUBAGENT_RELEASE: join(process.env.TMPDIR ?? "/tmp", `faux-cap-wait-${tag}.release`),
    AGENT_MODEL_STRONG: "faux-strong",
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    ...(monid ? { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: monidLog, AGENTRUN_TEST_FAUX_MONID_DELAY_MS: "300", ...(charge ? { AGENTRUN_TEST_FAUX_MONID_CHARGE: charge } : {}) } : {}),
  }, ["AGENT_MODEL_STRONG", "AGENT_MODEL_FAST", "AGENTRUN_TEST_FAUX_MONID_CHARGE"]);
  const server = await serve(t, { faux, ...(monid ? { fauxMonid: FAUX_MONID } : {}) });
  const lines = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const monidCalls = async () => (await readFile(monidLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run").length;
  const start = async (id, extra, content, maxCostUsd) => {
    const made = await server.api("POST", "/agents", agent(id, { approvals: "never", ...extra }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content }, max_cost_usd: maxCostUsd });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  const ended = async (runId, until = ENDED) => {
    await follow(server.api, runId, until, { deadlineMs: 150_000 });
    return (await server.api("GET", `/runs/${runId}`)).body;
  };
  return { ...server, lines, monidCalls, start, ended };
}

const delegate = (n, prompt) => `Delegate ${JSON.stringify(Array.from({ length: n }, (_, i) => ({ prompt: prompt(i), model: "strong" })))}`;
/** The model requests in the subagent fixture's log (its other lines note a wait, a hold or an abort). */
const requests = (lines) => lines.filter((line) => "model" in line);
async function until(ready, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await ready()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, `waited for ${what}`);
}

test("a running run's listed spend is what it spent, never a hold: the cap's own reading keeps the holds", () => {
  // A CLI run's booking: one request answered at $0.02, one still out held at $0.40, a paid call answered at $0.01.
  const entries = [
    { id: 1, conversationId: 2, kind: "runner.request", data: { turn: 1, model: "m", heldUsd: 0.3 } },
    { id: 2, conversationId: 2, kind: "runner.turn", data: { turn: 1, usd: 0.02, bookedUsd: 0.02 } },
    { id: 3, conversationId: 2, kind: "runner.request", data: { turn: 2, model: "m", heldUsd: 0.4 } },
    { id: 4, conversationId: 3, kind: "runner.request", data: { turn: 1, model: "paid:web_fetch", heldUsd: 0.05 } },
    { id: 5, conversationId: 3, kind: "runner.turn", data: { turn: 1, usd: 0.01, bookedUsd: 0.01 } },
  ];
  assert.equal(typeof metrics.bookedListSpend, "function", "the runs list's reader");
  assert.ok(Math.abs(metrics.bookedListSpend(entries) - 0.03) < 1e-9, `listed: ${metrics.bookedListSpend(entries)}`);
  assert.ok(Math.abs(metrics.bookedCapSpend(entries) - 0.43) < 1e-9, `the cap's reading: ${metrics.bookedCapSpend(entries)}`);
});

test("8 subagents at once under a cap that covers their cost but not all their worst cases: each waits its turn, all answer, the cap is never passed", { timeout: 240_000 }, async (t) => {
  const { start, ended, lines, data } = await setup(t);
  const runId = await start("eight", { tools: ["subagent"] }, delegate(8, (i) => `Wait 200 then say c${i}`), 0.5);
  const view = await ended(runId);
  t.diagnostic(`booked in order (session, +hold or -booked): ${traceOf(journalOf(data, runId))}`);
  assert.equal(view.status, "completed", JSON.stringify({ status: view.status, pending: view.pending, error: view.error }));
  for (let i = 0; i < 8; i++) assert.match(view.result?.final_answer ?? "", new RegExp(`\\bc${i}\\b`), `child ${i} answered`);
  assert.equal(requests(lines()).filter((line) => line.child).length, 8, "each child asked once");
  const peaks = admissions(journalOf(data, runId));
  assert.ok(peaks.length >= 10, `every request was booked: ${peaks.length}`);
  assert.ok(Math.max(...peaks) <= 0.5 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
  // Their worst cases together pass the cap: the run fits only because they waited for each other.
  const held = journalOf(data, runId).filter((e) => e.kind === "runner.request").map((e) => e.data?.heldUsd ?? 0);
  assert.ok(held.reduce((sum, usd) => sum + usd, 0) > 0.5, `the holds together pass the cap: ${held}`);
  assert.ok(view.cost.usd < 0.25, `it cost what its requests cost: ${JSON.stringify(view.cost)}`);
  t.diagnostic(`cost ${view.cost.usd}; holds together ${held.reduce((sum, usd) => sum + usd, 0)}; most spent + held at an admission ${Math.max(...peaks)} of 0.5`);
});

test("a burst of 25 paid calls (codemode's among them) held past the cap all go, the run completing at what they cost", { timeout: 240_000 }, async (t) => {
  const { start, ended, monidCalls, data } = await setup(t, { faux: FAUX_BURST, monid: true });
  const runId = await start("burst", { tools: [LOOKUP], tool_settings: ALLOWED }, `Burst ${JSON.stringify({ tool: LOOKUP_TOOL, direct: 20, codemode: 5 })}`, 4);
  const view = await ended(runId);
  const refused = capRefusals(journalOf(data, runId));
  assert.equal(refused.length, 0, `no call was refused at the cap: ${JSON.stringify(refused.slice(0, 2).map((e) => [e.kind, e.data]))}`.slice(0, 1500));
  assert.equal(view.status, "completed", JSON.stringify({ status: view.status, pending: view.pending, error: view.error }));
  assert.equal(await monidCalls(), 25, "every call was made, once");
  const peaks = admissions(journalOf(data, runId));
  assert.ok(Math.max(...peaks) <= 4 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
  // The calls were out at once, the cap full of their holds: it fit only because the rest waited for room.
  assert.ok(Math.max(...peaks) > 3, `several calls held at once: ${Math.max(...peaks)}`);
  assert.ok(Math.abs(view.cost.usd - 0.5) < 1e-6, `it cost what the calls charged: ${JSON.stringify(view.cost)}`);
  t.diagnostic(`cost ${view.cost.usd}; most spent + held at an admission ${Math.max(...peaks)} of 4`);
});

test("a paid call that cannot fit even once the calls in flight settle is refused at once, saying spent and held apart", { timeout: 240_000 }, async (t) => {
  const { start, ended, monidCalls, data } = await setup(t, { faux: FAUX_BURST, monid: true, charge: "" });
  // Three cheap calls ($0.003 each) are out when a $1 call asks under a $0.90 cap: no settle could make room for it.
  const tools = [ENRICH, LOOKUP];
  const runId = await start("dear", { tools, tool_settings: Object.fromEntries(tools.map((tool) => [tool, { permission: "allow" }])) }, `Burst ${JSON.stringify({ tool: LOOKUP_TOOL, direct: 1, codemode: 0, first: { tool: ENRICH_TOOL, n: 3 } })}`, 0.9);
  const view = await ended(runId);
  const entries = journalOf(data, runId);
  t.diagnostic(`booked in order (session, +hold or -booked): ${traceOf(entries)}`);
  assert.deepEqual([view.status, view.pending?.kind], ["input_required", "budget"], JSON.stringify({ status: view.status, pending: view.pending, error: view.error }));
  // Refused at once while the cheap calls were out (nothing spent yet), in words that say their holds as held.
  const refusal = entries.find((e) => e.kind === "agentrun.pause.pending")?.data?.refuse;
  assert.match(refusal ?? "", /^spend_cap_reached: Not sent: this run has spent \$0(?:\.00)? of its \$0\.90 cap and is holding \$0\.01 for steps still running; the next step, \S+, could cost up to \$1(?:\.00)? \([^)]+\), more than the cap leaves even once the steps still running settle\. Raise the cap to at least \$\d+\.\d\d to continue\.$/, JSON.stringify(refusal));
  // The run parks once the calls beside it have settled: by then they are spent, what they cost, and nothing is held.
  const { pending } = view;
  assert.deepEqual([pending.spent_usd, pending.held_usd, pending.needs_usd], [0.009, 0, 1], JSON.stringify(pending));
  assert.doesNotMatch(pending.said, /holding/, "with nothing running, nothing is said held");
  const made = await monidCalls();
  assert.equal(made, 3, "the dear call was never made");
  const peaks = admissions(entries);
  assert.ok(Math.max(...peaks) <= 0.9 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
  t.diagnostic(`refused: ${refusal}`);
});

test("a request that cannot fit even once the steps in flight settle is refused: the run parks saying spent and held apart", { timeout: 240_000 }, async (t) => {
  const { start, ended, data } = await setup(t);
  // At $0.20 one child's worst case fits beside what is spent, never two: they go one at a time, until what is spent
  // leaves no room for the next one's even with nothing else in flight.
  const runId = await start("alone", { tools: ["subagent"] }, delegate(8, (i) => `Wait 100 then say c${i}`), 0.2);
  const view = await ended(runId);
  const booked = journalOf(data, runId).filter((e) => e.kind === "runner.request" || e.kind === "runner.turn").map((e) => [e.conversationId, e.kind, e.data]);
  assert.deepEqual([view.status, view.pending?.kind], ["input_required", "budget"], JSON.stringify({ status: view.status, pending: view.pending, error: view.error, answer: view.result?.final_answer, booked }));
  const { pending } = view;
  // Refused while a step was still running: what it holds said apart from what was spent; with none running, no hold.
  assert.match(pending.said, /^Not sent: this run has spent \$0\.\d\d of its \$0\.20 cap(?: and is holding \$0\.\d\d for steps still running; the next step needs at least \$0\.\d\d, more than the cap leaves even once the steps still running settle|, and the next step needs at least \$0\.\d\d)\. Raise the cap to at least \$0\.\d\d to continue\.$/);
  // What it spent is what its answered requests cost, never a hold: each request costs $0.018 here.
  const answered = journalOf(data, runId).filter((e) => e.kind === "runner.turn").length;
  assert.ok(answered >= 2, `some requests answered: ${answered}`);
  assert.ok(pending.spent_usd <= 0.018 * answered + 1e-6, `spent ${pending.spent_usd}, at most what the ${answered} answered requests cost: a hold is never spend`);
  assert.equal(typeof pending.held_usd, "number", JSON.stringify(pending));
  assert.ok(pending.spent_usd + pending.needs_usd > 0.2, `it cannot fit alone: ${JSON.stringify(pending)}`);
  const peaks = admissions(journalOf(data, runId));
  assert.ok(Math.max(...peaks) <= 0.2 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
  t.diagnostic(`pending ${JSON.stringify(pending)}`);
});

test("a cancel while subagents wait for room: they leave the line unsent and nothing more is asked of any model", { timeout: 240_000 }, async (t) => {
  const { start, ended, lines, api, data } = await setup(t);
  // At $0.55 two children's worst cases fit at once beside the run's first request; the others wait, and the two hold
  // their requests open.
  const runId = await start("stop", { tools: ["subagent"] }, delegate(8, (i) => `Hold c${i}`), 0.55);
  await until(() => lines().filter((line) => line.held).length === 2, "two children holding a request", 20_000).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ lines: lines(), booked: journalOf(data, runId).filter((e) => e.kind.startsWith("runner.")).map((e) => [e.conversationId, e.kind, e.data]) })}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const booked = journalOf(data, runId).filter((e) => e.kind === "runner.request").length;
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  const view = await ended(runId, ["cancelled", "completed", "failed"]);
  assert.equal(view.status, "cancelled", JSON.stringify(view));
  const asked = requests(lines()).length;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(requests(lines()).length, asked, "nothing asked its model after the cancel");
  assert.equal(requests(lines()).filter((line) => line.child).length, 2, "only the two admitted children ever asked");
  assert.equal(journalOf(data, runId).filter((e) => e.kind === "runner.request").length, booked, "no waiter was booked");
});
