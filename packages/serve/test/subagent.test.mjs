// The subagent tool (runner/subagent.ts), through the API on pi with the faux model (fixtures/faux-subagent.mjs) and an
// in-process runner: a granted call runs a fresh child conversation on the strong tier's model with exactly the subset of
// tools it names (an MCP tool among them) and answers with the child's last text; a revision that does not grant it, or
// a deny on it, refuses it; a name outside the agent's tools, or subagent itself, is refused before any child starts;
// a child is never offered subagent (depth 1); the child's requests are booked on the run's one cap, which ends the child
// when it is reached; several calls in a turn run at once, at most four at a time; the run's timeline nests the child's
// rows under the call; a call that names no tier runs its child on the agent's own model; a child given bash runs it in
// the run's computer, held to the agent's read-only bash policy by the same gate. No key, no network, no Docker (a fake
// sandbox whose bash runs on this machine in the run's folder: fixtures/streaming-sandbox.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { streamingSandbox } from "./fixtures/streaming-sandbox.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { runFolder } = await import("../dist/workspace/paths.js");

const FAUX_SUBAGENT = new URL("./fixtures/faux-subagent.mjs", import.meta.url).pathname;
/** A faux Docker box: the server offers a sandbox place, so an agent may name bash (the runner's computer is the test's). */
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
/** What each request costs under the fixture: 1,000 input and 100 output tokens at $1 and $10 a million. */
const PER_REQUEST = 0.002;
const ENDED = ["completed", "failed", "cancelled", "input_required"];

async function setup(t, { mcp = false, sandbox } = {}) {
  const log = join(process.env.TMPDIR ?? "/tmp", `faux-subagent-${randomBytes(6).toString("hex")}.jsonl`);
  withEnv(t, { FAUX_SUBAGENT_LOG: log, AGENT_MODEL_STRONG: "faux-strong", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_SUBAGENT, ...(mcp ? { accounts: true, openSetup: true } : {}), ...(sandbox ? { fauxBox: FAUX_BOX, computerForClaim: sandbox } : {}) });
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
  /** A run of a new agent `id` (its definition's `extra` beside the suite's), on `content`, followed to its end. */
  const run = async (id, extra, content, { max_cost_usd } = {}) => {
    const made = await server.api("POST", "/agents", agent(id, { approvals: "never", ...extra }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content }, ...(max_cost_usd ? { max_cost_usd } : {}) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const followed = await follow(server.api, started.body.run_id, ENDED, { deadlineMs: 120_000 });
    const view = (await server.api("GET", `/runs/${started.body.run_id}`)).body;
    return { ...followed, view, answer: view.result?.final_answer ?? "" };
  };
  return { ...server, run, lines, fake: () => fake };
}

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

test("a child's spend books on the run's one cap, and the cap ends the child", { timeout: 240_000 }, async (t) => {
  const { run, lines, api } = await setup(t);
  const cap = 0.03;
  const capped = await run("capped", { tools: ["read", "subagent"] }, delegate([{ prompt: "Read forever nothing.md", tools: ["read"], model: "strong" }]), { max_cost_usd: cap });
  assert.equal(capped.last.status, "input_required", `parked at its cap: ${JSON.stringify(capped.view)}`);
  // The cap ends the child: its call fails in the cap's words, or, when the run parked at its cap first, the call is
  // cut with the run. Either way the child asks its model nothing more.
  const [result] = resultsOf(capped.rows);
  if (result) {
    assert.equal(result.tool_status, "failed");
    assert.match(result.tool_result_preview ?? "", /subagent: it stopped before it answered: .*spend_cap_reached/);
  }
  const asked = lines().length;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(lines().length, asked, "nothing asked its model once the run stopped at its cap");
  const child = lines().filter((line) => line.child).length;
  const own = lines().filter((line) => !line.child).length;
  assert.ok(child >= 3, `the child asked its model until the cap: ${child}`);
  // What the run spent is every request the cap let through, the child's among them, and never more than its cap.
  // Read again until the last answer's booking is in (it lands once the proxy has its upstream's end), at most 10 s.
  const want = (child + own) * PER_REQUEST;
  let spent = capped.view.cost?.usd;
  for (const until = Date.now() + 10_000; !(Math.abs(spent - want) < 1e-9) && Date.now() < until; ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    spent = (await api("GET", `/runs/${capped.view.run_id}`)).body.cost?.usd;
  }
  assert.ok(typeof spent === "number" && Math.abs(spent - (child + own) * PER_REQUEST) < 1e-9, `cost ${spent} for ${child} child and ${own} own requests: every request the model was asked is booked on the run`);
  assert.ok(spent >= child * PER_REQUEST - 1e-9, `the child's ${child} requests are in the run's cost: ${spent}`);
  assert.ok(spent <= cap + 1e-9, `within its cap: ${spent}`);
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
