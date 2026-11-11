// The subagent tool (runner/subagent.ts), through the API on pi with the faux model (fixtures/faux-subagent.mjs) and an
// in-process runner: a granted call runs a fresh child conversation on the strong tier's model with exactly the subset of
// tools it names (an MCP tool among them) and answers with the child's last text; a revision that does not grant it, or
// a deny on it, refuses it; a name outside the agent's tools, or subagent itself, is refused before any child starts;
// a child is never offered subagent (depth 1); an answer cut at its output limit fails the call; the child's requests are
// booked on the run's one cap, whose refusal ends the child's call in the cap's words and parks the run, and a raise
// resumes the run, not the child; a child mid-turn when its runner goes is the same child on the next claim, answering
// once, with no finished request sent again; a cancel stops every child; several calls in a turn run at once, at most
// four at a time; the run's timeline nests the child's rows under the call; a call that names no tier runs its child on the agent's own model; a child given bash runs it in
// the run's computer, held to the agent's read-only bash policy by the same gate. No key, no network, no Docker (a fake
// sandbox whose bash runs on this machine in the run's folder: fixtures/streaming-sandbox.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { streamingSandbox } from "./fixtures/streaming-sandbox.mjs";
import { agent, follow, runRecordOf, serve, startInProcessRunner, withEnv } from "./support.mjs";

const { runFolder } = await import("../dist/workspace/paths.js");

const FAUX_SUBAGENT = new URL("./fixtures/faux-subagent.mjs", import.meta.url).pathname;
/** A faux Docker box: the server offers a sandbox place, so an agent may name bash (the runner's computer is the test's). */
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
/** What each request costs under the fixture: 1,000 input and 100 output tokens at $1 and $10 a million. */
const PER_REQUEST = 0.002;
const ENDED = ["completed", "failed", "cancelled", "input_required"];

async function setup(t, { mcp = false, sandbox, runner = true, strong = "faux-strong" } = {}) {
  const tag = randomBytes(6).toString("hex");
  const log = join(process.env.TMPDIR ?? "/tmp", `faux-subagent-${tag}.jsonl`);
  /** The file whose being there lets a "Hold" child answer (fixtures/faux-subagent.mjs). */
  const release = join(process.env.TMPDIR ?? "/tmp", `faux-subagent-${tag}.release`);
  // The host's strong model, or none (`strong: null`): AGENT_MODEL_STRONG is unset then.
  withEnv(t, { FAUX_SUBAGENT_LOG: log, FAUX_SUBAGENT_RELEASE: release, ...(strong ? { AGENT_MODEL_STRONG: strong } : {}), AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENT_MODEL_STRONG", "AGENT_MODEL_FAST"]);
  const server = await serve(t, { faux: FAUX_SUBAGENT, ...(runner ? {} : { runner: false }), ...(mcp ? { accounts: true, openSetup: true } : {}), ...(sandbox ? { fauxBox: FAUX_BOX, computerForClaim: sandbox } : {}) });
  let fake;
  if (mcp) {
    fake = await startFakeMcp({});
    t.after(() => fake.close());
    assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  }
  const lines = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  /** A new agent `id` (its definition's `extra` beside the suite's) started on `content`: its run's id. */
  const start = async (id, extra, content, { max_cost_usd } = {}) => {
    const made = await server.api("POST", "/agents", agent(id, { approvals: "never", ...extra }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content }, ...(max_cost_usd ? { max_cost_usd } : {}) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  /** Run `runId` followed to one of `until`, with its view and final answer. */
  const ended = async (runId, until = ENDED) => {
    const followed = await follow(server.api, runId, until, { deadlineMs: 120_000 });
    const view = (await server.api("GET", `/runs/${runId}`)).body;
    return { ...followed, view, answer: view.result?.final_answer ?? "" };
  };
  /** A run of a new agent, followed to its end. */
  const run = async (id, extra, content, options) => ended(await start(id, extra, content, options));
  return { ...server, start, ended, run, lines, release: () => writeFileSync(release, "go"), fake: () => fake };
}

/** Wait until `ready()` holds, at most `ms`. */
async function until(ready, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await ready()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, `waited for ${what}`);
}
/** The model requests in the fixture's log (its other lines note a wait, a hold or an abort). */
const requests = (lines) => lines.filter((line) => "model" in line);
/** The timeline's rows of run `runId` now. */
const rowsNow = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];

const delegate = (calls) => `Delegate ${JSON.stringify(calls)}`;
const resultsOf = (rows) => rows.filter((row) => row.kind === "tool_result" && row.tool_name === "subagent");

test("subagent is refused unless granted: an agent without it never starts a child, and a deny on it refuses the call", { timeout: 240_000 }, async (t) => {
  const { run, lines } = await setup(t);
  const ungranted = await run("no-subagent", { tools: ["read"] }, delegate([{ prompt: "Say hi", model: "strong" }]));
  assert.equal(ungranted.last.status, "completed");
  assert.doesNotMatch(ungranted.answer, /hi$/, ungranted.answer);
  assert.equal(lines().filter((line) => line.child).length, 0, "no child ever asked its model");
  assert.ok(!lines().some((line) => line.tools.includes("subagent")), "the model was never offered subagent");

  const denied = await run("denied-subagent", { tools: ["read", "subagent"], tool_settings: { subagent: { permission: "deny" } } }, delegate([{ prompt: "Say hi", model: "strong" }]));
  assert.equal(denied.last.status, "completed");
  const [result] = resultsOf(denied.rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(denied.rows));
  assert.match(denied.answer, /subagent/);
  assert.equal(lines().filter((line) => line.child).length, 0, "the denied call started no child");
});

test("a child gets exactly the tools the call names, an MCP tool among them, on the strong tier's model; a tool the agent lacks is refused", { timeout: 240_000 }, async (t) => {
  const { run, lines, fake } = await setup(t, { mcp: true });
  const tools = ["read", "write", "mcp:fake/add", "subagent"];
  const offered = await run("subset", { tools }, delegate([{ prompt: "Tools?", tools: ["read", "mcp:fake/add"], model: "strong" }]));
  assert.equal(offered.last.status, "completed", JSON.stringify(offered.view));
  assert.equal(offered.answer, "Results: Offered: read,mcp__fake__add");
  const childLines = lines().filter((line) => line.child);
  assert.deepEqual(childLines.map((line) => line.model), ["faux-strong"], "the child ran on the strong tier's model");
  assert.ok(lines().filter((line) => !line.child).every((line) => line.model === "faux-1"), "the run's own turns stay on its own model");

  // The child calls the MCP tool it was given, under the run's gate, and its answer comes back as the call's result.
  const called = await run("subset-mcp", { tools }, delegate([{ prompt: 'Call mcp__fake__add with {"a":2,"b":3}', tools: ["mcp:fake/add"], model: "strong" }]));
  assert.equal(called.answer, "Results: Tool said: 5");
  assert.equal(fake().log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1);

  // A tool the child was not given is no tool of its: write is not offered, and its call never runs.
  const unlisted = await run("subset-unlisted", { tools }, delegate([{ prompt: 'Call write with {"path":"x.md","content":"x"}', tools: ["read"], model: "strong" }]));
  assert.equal(unlisted.last.status, "completed");
  assert.doesNotMatch(unlisted.answer, /Wrote|wrote/);

  // A tool outside the agent's own is refused before any child starts.
  const before = lines().filter((line) => line.child).length;
  const outside = await run("subset-outside", { tools }, delegate([{ prompt: "Say hi", tools: ["web_fetch"], model: "strong" }]));
  assert.match(outside.answer, /web_fetch is not one of this agent's tools, so no subagent may have it\. A subagent may be given read, write, mcp:fake\/add\. Nothing ran\./);
  assert.equal(lines().filter((line) => line.child).length, before, "no child started");
});

test("depth 1: a child is never offered subagent, and a call that names it is refused", { timeout: 240_000 }, async (t) => {
  const { run, lines } = await setup(t);
  const deep = await run("deep", { tools: ["read", "subagent"] }, delegate([{ prompt: "Tools?", tools: ["read"], model: "fast" }, { prompt: "Say no", tools: ["subagent"], model: "fast" }]));
  assert.equal(deep.last.status, "completed");
  assert.match(deep.answer, /^Results: Offered: read \| subagent: a subagent is never given subagent \(subagents go one level deep\)\. Nothing ran\.$/);
  for (const line of lines().filter((one) => one.child)) assert.ok(!line.tools.includes("subagent"), JSON.stringify(line));
  // The timeline nests the child's rows under its call.
  assert.ok(deep.rows.some((row) => row.kind === "subagent_started"), JSON.stringify(deep.rows.map((row) => row.kind)));
  assert.ok(deep.rows.some((row) => row.kind === "subagent_completed"));
  assert.ok(deep.rows.some((row) => row.parent_tool_use_id), `the child's rows sit under the call: ${JSON.stringify(deep.rows.map((row) => [row.kind, row.parent_tool_use_id ?? null, row.summary]))}`);
});

test("several calls in one turn run at once, at most four at a time, each answer returned to its call", { timeout: 240_000 }, async (t) => {
  const { run, lines, store } = await setup(t);
  const calls = Array.from({ length: 6 }, (_, i) => ({ prompt: `Wait 400 then say c${i}`, model: "strong" }));
  const parallel = await run("parallel", { tools: ["subagent"] }, delegate(calls));
  assert.equal(parallel.last.status, "completed", JSON.stringify(parallel.view));
  assert.equal(parallel.answer, `Results: ${calls.map((_, i) => `c${i}`).join(" | ")}`);
  const waits = lines().filter((line) => line.wait);
  assert.equal(waits.length, 6);
  // The most children waiting at one moment: more than one (they ran at once), never more than four.
  const most = Math.max(...waits.map((one) => waits.filter((other) => other.from < one.until && one.from < other.until).length));
  assert.ok(most > 1 && most <= 4, `at most four at once, and more than one: ${most}`);
  // The run's end books its children's requests as its own: its row's cost is every request's, the six children's too.
  const asked = lines().filter((line) => line.model).length;
  assert.equal(asked, 2 + 6, "two turns of the run's own, one request of each child");
  const row = await store.runs.get(parallel.view.run_id);
  assert.ok(Math.abs(row.costUsd - asked * PER_REQUEST) < 1e-9, `the run's stored cost ${row.costUsd} is its ${asked} requests'`);
  assert.ok(Math.abs(parallel.view.cost.usd - asked * PER_REQUEST) < 1e-9, `the run's cost ${parallel.view.cost.usd}`);
});

test("the cap's refusal of a child's request fails its call in the cap's words and parks the run; nothing more is sent; a raise resumes the run, not the child", { timeout: 240_000 }, async (t) => {
  const { run, lines, api, ended } = await setup(t);
  const cap = 0.03;
  const capped = await run("capped", { tools: ["read", "subagent"] }, delegate([{ prompt: "Read forever nothing.md", tools: ["read"], model: "strong" }]), { max_cost_usd: cap });
  assert.equal(capped.last.status, "input_required", `parked at its cap: ${JSON.stringify(capped.view)}`);
  assert.equal(capped.view.pending?.kind, "budget", JSON.stringify(capped.view.pending));
  // One behaviour: the child's refused request ends its turn, its call fails in the cap's words, and the run's own next
  // request is refused the same way, so the run parks with the call's result on its record.
  const [result] = resultsOf(capped.rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(capped.rows.map((row) => [row.kind, row.tool_name, row.tool_status])));
  assert.match(result.tool_result_preview ?? "", /subagent: it stopped before it answered: .*spend_cap_reached/);
  const asked = requests(lines()).length;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(requests(lines()).length, asked, "nothing asked its model once the run parked at its cap");
  const child = requests(lines()).filter((line) => line.child).length;
  const own = requests(lines()).filter((line) => !line.child).length;
  assert.ok(child >= 3, `the child asked its model until the cap: ${child}`);
  // What the run spent is every request the cap let through, the child's among them, and never more than its cap.
  const want = (child + own) * PER_REQUEST;
  let spent = capped.view.cost?.usd;
  for (const end = Date.now() + 10_000; !(Math.abs(spent - want) < 1e-9) && Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    spent = (await api("GET", `/runs/${capped.view.run_id}`)).body.cost?.usd;
  }
  assert.ok(typeof spent === "number" && Math.abs(spent - want) < 1e-9, `cost ${spent} for ${child} child and ${own} own requests: every request the model was asked is booked on the run`);
  assert.ok(spent <= cap + 1e-9, `within its cap: ${spent}`);

  // A raise resumes the run, not the child: the agent's next turn reads the failed call (and may call subagent again,
  // which starts a fresh child); the child asks its model nothing more.
  const raised = await api("PATCH", `/runs/${capped.view.run_id}`, { max_cost_usd: 1 });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const resumed = await ended(capped.view.run_id, ["completed", "failed", "cancelled"]);
  assert.equal(resumed.last.status, "completed", JSON.stringify(resumed.view));
  assert.match(resumed.answer, /^Results: subagent: it stopped before it answered: .*spend_cap_reached/);
  assert.equal(requests(lines()).filter((line) => line.child).length, child, "the child was not resumed");
});

test("a child mid-turn when its runner goes is the same child on the next claim: it answers once, and no finished request is sent again; a tier's model changed meanwhile is the one it resumes on", { timeout: 240_000 }, async (t) => {
  const { start, ended, lines, api, data, release } = await setup(t, { runner: false });
  const closeFirst = await startInProcessRunner(data, { faux: FAUX_SUBAGENT });
  let firstClosed = false;
  t.after(() => (firstClosed ? undefined : closeFirst()));
  const runId = await start("restart", { tools: ["read", "subagent"] }, delegate([{ prompt: "Say first" }, { prompt: "Hold second", model: "strong" }]));
  // The first child has answered and its answer is on the run's record; the second is mid-request.
  await until(async () => lines().some((line) => line.held === "second") && (await rowsNow(api, runId)).some((row) => row.parent_tool_use_id && JSON.stringify(row).includes("first") && row.kind !== "tool_call"), "the first child's answer and the second child's held request");
  const held = runRecordOf(data, runId);
  await closeFirst();
  firstClosed = true;
  release();
  // The server's strong model changes before the next claim (setup's withEnv puts it back after the test).
  process.env.AGENT_MODEL_STRONG = "faux-strong-2";
  const closeSecond = await startInProcessRunner(data, { faux: FAUX_SUBAGENT });
  t.after(() => closeSecond());
  const done = await ended(runId, ["completed", "failed", "cancelled"]);
  assert.equal(done.last.status, "completed", JSON.stringify(done.view));
  assert.ok(runRecordOf(data, runId).epoch > held.epoch, "another claim resumed the run");
  assert.equal(done.answer, "Results: first | second");
  const asked = requests(lines());
  assert.equal(asked.filter((line) => line.asked === "Say first").length, 1, "the first child's finished request was never sent again");
  assert.equal(asked.filter((line) => !line.child).length, 2, "the run's own finished turn was never sent again: one turn that delegated, one that answered");
  assert.deepEqual(asked.filter((line) => line.asked === "Hold second").map((line) => line.model), ["faux-strong", "faux-strong-2"], "the second child's cut request was sent again, once, on the next claim, on the strong tier's model now");
  // The same two children: one started row and one completed row each, never a third child for the resumed call.
  assert.equal(done.rows.filter((row) => row.kind === "subagent_started").length, 2, JSON.stringify(done.rows.map((row) => [row.kind, row.summary])));
  assert.equal(done.rows.filter((row) => row.kind === "subagent_completed").length, 2);
  assert.deepEqual(resultsOf(done.rows).map((row) => row.tool_status), ["success", "success"]);
});

test("cancelling a run stops its children: their requests are aborted and nothing more is asked", { timeout: 240_000 }, async (t) => {
  const { start, ended, lines, api } = await setup(t);
  const runId = await start("cancel", { tools: ["read", "subagent"] }, delegate([{ prompt: "Hold one" }, { prompt: "Hold two" }]));
  await until(() => lines().filter((line) => line.held).length === 2, "both children holding a request");
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  const done = await ended(runId, ["cancelled", "completed", "failed"]);
  assert.equal(done.last.status, "cancelled", JSON.stringify(done.view));
  await until(() => lines().filter((line) => line.aborted).length === 2, "both children's requests aborted", 20_000);
  const asked = requests(lines()).length;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(requests(lines()).length, asked, "nothing asked its model after the cancel");
  assert.ok(!resultsOf(done.rows).some((row) => row.tool_status === "success"), "no child answered");
});

test("a child's answer cut at its model's output limit fails its call, saying so, with what it wrote", { timeout: 240_000 }, async (t) => {
  const { run } = await setup(t);
  const cut = await run("cut", { tools: ["read", "subagent"] }, delegate([{ prompt: "Cut half an ans" }]));
  assert.equal(cut.last.status, "completed", JSON.stringify(cut.view));
  const [result] = resultsOf(cut.rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(cut.rows.map((row) => [row.kind, row.tool_name, row.tool_status])));
  assert.match(cut.answer, /^Results: subagent: its answer is unfinished: [^\n]+\nWhat it wrote before the cut:\nhalf an ans$/);
});

test("a call's max_tool_calls narrows the agent's tool-call budget for its child and never widens it; with no budget of the agent's, the call's holds", { timeout: 240_000 }, async (t) => {
  const { run } = await setup(t);
  const narrowed = await run("budget", { tools: ["read", "subagent"], max_tool_calls: 3 }, delegate([
    { prompt: "Count reads a.md", tools: ["read"], max_tool_calls: 1 },
    { prompt: "Count reads a.md", tools: ["read"], max_tool_calls: 10 },
    { prompt: "Count reads a.md", tools: ["read"] },
  ]));
  assert.equal(narrowed.last.status, "completed", JSON.stringify(narrowed.view));
  assert.equal(narrowed.answer, "Results: Reads: 1 | Reads: 3 | Reads: 3", "1 narrows the agent's 3; 10 is held to 3; none takes the agent's 3");
  const own = await run("budget-own", { tools: ["read", "subagent"] }, delegate([{ prompt: "Count reads a.md", tools: ["read"], max_tool_calls: 2 }]));
  assert.equal(own.answer, "Results: Reads: 2");
  const bad = await run("budget-bad", { tools: ["read", "subagent"] }, delegate([{ prompt: "Say no", max_tool_calls: 0 }]));
  assert.equal(resultsOf(bad.rows)[0]?.tool_status, "failed", "a budget below 1 is refused before any child starts");
});

test("a tier with no model of its own (no model_tiers, no AGENT_MODEL_STRONG) runs its child on the agent's own model", { timeout: 240_000 }, async (t) => {
  const { run, lines } = await setup(t, { strong: null });
  const own = await run("no-tier-model", { tools: ["read", "subagent"] }, delegate([{ prompt: "Say mine", model: "strong" }]));
  assert.equal(own.last.status, "completed", JSON.stringify(own.view));
  assert.equal(own.answer, "Results: mine");
  assert.deepEqual(requests(lines()).filter((line) => line.child).map((line) => line.model), ["faux-1"], "the agent's own model");
});

test("a call that names no tier runs its child on the agent's own model", { timeout: 240_000 }, async (t) => {
  const { run, lines } = await setup(t);
  const own = await run("own-model", { tools: ["read", "subagent"] }, delegate([{ prompt: "Say mine" }, { prompt: "Say theirs", model: "strong" }]));
  assert.equal(own.last.status, "completed", JSON.stringify(own.view));
  assert.equal(own.answer, "Results: mine | theirs");
  assert.deepEqual(lines().filter((line) => line.child).map((line) => line.model).sort(), ["faux-1", "faux-strong"], "no tier: the agent's own model; strong: the tier's");
});

test("a child given bash runs it on the run's computer, and the agent's read-only bash policy holds the child's calls too", { timeout: 240_000 }, async (t) => {
  // The run's sandbox: its bash runs here, in the run's folder (the data directory is the server's, read once it starts).
  let data;
  const { run, lines, ...server } = await setup(t, { sandbox: async (launch) => streamingSandbox(runFolder(data, "child-bash", launch.runId)) });
  data = server.data;
  const tools = ["read", "bash", "subagent"];
  const given = await run("child-bash", { tools, tool_settings: { bash: { policy: "read-only" } } }, delegate([
    { prompt: 'Call bash with {"command":"echo child-bash"}', tools: ["bash", "read"] },
    { prompt: 'Call bash with {"command":"touch made.txt"}', tools: ["bash"] },
  ]));
  assert.equal(given.last.status, "completed", JSON.stringify(given.view));
  const [ran, refused] = given.answer.replace(/^Results: /, "").split(" | ");
  assert.match(ran, /^Tool said: child-bash\s*$/, given.answer);
  assert.match(refused, /^Tool said: bash is read-only for this agent, so this call was refused: /, given.answer);
  assert.ok(!existsSync(join(runFolder(data, "child-bash", given.view.run_id), "made.txt")), "the refused command never ran");
  const children = lines().filter((line) => line.child);
  assert.ok(children.length >= 2 && children.every((line) => line.tools.includes("bash") && !line.tools.includes("bash_background") && !line.tools.includes("subagent")), JSON.stringify(children));
});
