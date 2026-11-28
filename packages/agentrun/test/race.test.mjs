// `agentrun race start` and `agentrun race show`: one task on 2 to 4 harness and model lanes, each a new agent of its own
// and one run of it carrying the race's labels, as the console's New race form starts a race; and the race read back by
// its label, in lane order. Against a server in this process with no runner: the runs are taken, and nothing runs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../../serve/test/support.mjs";
import { laneOf, laneTools, newRaceLabel } from "../lib/race.mjs";
import { cli, scratch } from "./support.mjs";

async function started(t) {
  const { dir, env } = scratch("race");
  const server = await serve(t, { runner: false });
  const agentrun = (args) => cli({ ...env, AGENTRUN_API_KEY: server.token }, [...args, "--base-url", server.baseUrl]);
  return { dir, token: server.token, api: server.api, agentrun };
}

const MODEL = "anthropic/claude-sonnet-4.5";
const OTHER = "openai/gpt-5";

test("demo: agentrun race start starts one run a lane, each its own agent, carrying the race's labels, task and cap; race show reads them back in lane order", { timeout: 120_000 }, async (t) => {
  const { dir, token, api, agentrun } = await started(t);
  const task = join(dir, "task.md");
  writeFileSync(task, "Print the 20th Fibonacci number.\n");
  const out = await agentrun(["race", "start", "--lane", `pi/${MODEL}`, "--lane", `pi/${OTHER}`, "--task", `@${task}`, "--max-cost-usd", "0.5", "--label", "cli-race-1"]);
  assert.equal(out.code, 0, out.err);
  const printed = JSON.parse(out.out);
  assert.equal(printed.label, "cli-race-1");
  assert.equal(printed.filter, "race:cli-race-1");
  assert.equal(printed.console, "#/races/cli-race-1");
  assert.deepEqual(printed.lanes.map((lane) => [lane.lane, lane.harness, lane.model, lane.agent_id]), [[1, "pi", MODEL, "race-cli-race-1-1-1"], [2, "pi", OTHER, "race-cli-race-1-2-1"]]);
  const caps = (await api("GET", "/capabilities")).body;
  const computers = (await api("GET", "/computers")).body;
  for (const lane of printed.lanes) {
    assert.match(lane.run_id ?? "", /\S/, `lane ${lane.lane} has its run`);
    const run = (await api("GET", `/runs/${lane.run_id}`)).body;
    assert.deepEqual(run.labels, { race: "cli-race-1", lane: String(lane.lane), harness: lane.harness, model: lane.model });
    assert.equal(run.cost?.cap_usd, 0.5);
    const agent = (await api("GET", `/agents/${lane.agent_id}`)).body;
    const definition = agent.definition ?? agent;
    assert.equal(definition.instructions, "Do the task you are given.");
    assert.equal(definition.harness, lane.harness);
    assert.deepEqual(definition.tools ?? [], laneTools(lane.harness, caps, computers), "a new agent's tools here, as the console's lane");
  }
  const first = (await api("GET", `/runs/${printed.lanes[0].run_id}`)).body;
  assert.deepEqual(first.input, { content: "Print the 20th Fibonacci number." }, "the task is the run's input, trimmed");
  assert.equal(first.revision, (await api("GET", `/agents/${printed.lanes[0].agent_id}`)).body.revision, "its agent's first revision");

  const shown = await agentrun(["race", "show", "cli-race-1"]);
  assert.equal(shown.code, 0, shown.err);
  const race = JSON.parse(shown.out);
  assert.deepEqual(race.lanes.map((lane) => [lane.lane, lane.harness, lane.model, lane.run_id, lane.cap_usd]), printed.lanes.map((lane) => [String(lane.lane), lane.harness, lane.model, lane.run_id, 0.5]));
  for (const lane of race.lanes) assert.equal(typeof lane.status, "string");
  assert.ok(!`${out.out}${out.err}${shown.out}${shown.err}`.includes(token), "the token is never printed");
});

test("a lane the server refuses leaves the others started: its words on stderr, its agent archived, exit 1", { timeout: 120_000 }, async (t) => {
  const { api, agentrun } = await started(t);
  const out = await agentrun(["race", "start", "--lane", `pi/${MODEL}`, "--lane", `no-such-harness/${MODEL}`, "--task", "Say hi.", "--label", "cli-race-2"]);
  assert.equal(out.code, 1, out.err);
  const printed = JSON.parse(out.out);
  assert.match(printed.lanes[0].run_id ?? "", /\S/);
  assert.equal(printed.lanes[1].run_id, undefined);
  assert.match(printed.lanes[1].error, /\S/);
  assert.match(out.err, /^Lane 2 \(no-such-harness\/anthropic\/claude-sonnet-4\.5\) did not start: /m);
  const runs = (await api("GET", "/runs?label=race:cli-race-2")).body.runs;
  assert.deepEqual(runs.map((run) => run.labels.lane), ["1"]);
});

test("race start refuses, sending nothing, a race of one lane or five, a lane with no model, an empty task, a cap of 0 and a label a run label can't carry", async () => {
  const { env } = scratch("race-refused");
  // A port nothing listens on: a request sent would fail as unreachable, never as a refusal.
  const agentrun = (args) => cli(env, [...args, "--base-url", "http://127.0.0.1:9/v2"]);
  const two = ["--lane", `pi/${MODEL}`, "--lane", `codex/gpt-5`];
  const cases = [
    [["--lane", `pi/${MODEL}`, "--task", "x"], /2 to 4 lanes/],
    [[...two, ...two, "--lane", `pi/${MODEL}`, "--task", "x"], /2 to 4 lanes/],
    [["--lane", "pi", "--lane", `codex/gpt-5`, "--task", "x"], /--lane pi: a lane is HARNESS\/MODEL/],
    [[...two], /--task TEXT\|@FILE/],
    [[...two, "--task", "  "], /--task is empty/],
    [[...two, "--task", "x", "--max-cost-usd", "0"], /--max-cost-usd 0/],
    [[...two, "--task", "x", "--label", "has space"], /--label has space/],
  ];
  for (const [args, said] of cases) {
    const out = await agentrun(["race", "start", ...args]);
    assert.equal(out.code, 2, `${args.join(" ")}: ${out.err}`);
    assert.match(out.err, said);
    assert.equal(out.out, "");
  }
  const shown = await agentrun(["race", "show", "has space"]);
  assert.equal(shown.code, 2, shown.err);
});

test("race show names a label no run carries", { timeout: 120_000 }, async (t) => {
  const { agentrun } = await started(t);
  const out = await agentrun(["race", "show", "never-raced"]);
  assert.equal(out.code, 2, out.err);
  assert.match(out.err, /No run carries the label race:never-raced/);
});

test("a lane's tools are a new agent's here: its harness's available tools, no call-only or host (meta) one, the browser only on the runner, bash on the runner only where its shell runs it", () => {
  const tools = [
    { name: "read", available: true, harnesses: ["pi", "codex"] },
    { name: "web_search", available: false, harnesses: ["pi"] },
    { name: "fetch_call", available: true, call_only: true, harnesses: ["pi"] },
    { name: "tools_search", available: true, meta: true, harnesses: ["pi"] },
    { name: "write", harnesses: ["pi"] },
    { name: "browser", available: true, runner_only: true, harnesses: ["pi"] },
    { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] },
    { name: "bash_background", available: true, sandbox_only: true, harnesses: ["pi"] },
  ];
  const box = { tools, places: { default_place: { mode: "sandbox", box: "docker" } } };
  const runner = { tools, places: { default_place: { mode: "runner" } } };
  assert.deepEqual(laneTools("pi", box, undefined), ["read", "write", "bash", "bash_background"]);
  assert.deepEqual(laneTools("pi", runner, { kinds: [{ kind: "none" }] }), ["read", "write", "browser"]);
  assert.deepEqual(laneTools("pi", runner, { kinds: [{ kind: "none", shell: "local" }] }), ["read", "write", "browser", "bash"]);
  assert.deepEqual(laneTools("codex", box, undefined), ["read"]);
  assert.deepEqual(laneTools("pi", undefined, undefined), []);
});

test("a lane is HARNESS/MODEL split at the first slash; a new label is the minute and 12 random hex digits, as the console's", () => {
  assert.deepEqual(laneOf("pi/anthropic/claude-sonnet-4.5"), { harness: "pi", model: "anthropic/claude-sonnet-4.5" });
  assert.equal(laneOf("pi"), undefined);
  assert.equal(laneOf("/gpt-5"), undefined);
  assert.equal(laneOf("codex/"), undefined);
  assert.equal(newRaceLabel(new Date("2026-11-28T01:23:45Z"), () => "0123abcd-4567-89ef-0123-456789abcdef"), "20261128-0123-0123abcd4567");
});

/** A fake server: GET /capabilities and /computers, POST /agents and its runs and archive, each answered by `answer`
 *  (path, method, body) after its own delay; every request recorded. */
async function fake(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const path = req.url.replace(/^\/v2/, "");
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, path, body });
      const said = await answer(req.method, path, body);
      if (said === "drop") return req.socket.destroy();
      res.writeHead(said.status, { "content-type": "application/json" });
      res.end(JSON.stringify(said.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { env } = scratch("race-fake");
  const base = `http://127.0.0.1:${server.address().port}/v2`;
  return { seen, agentrun: (args) => cli({ ...env, AGENTRUN_API_KEY: "fake-test-key" }, [...args, "--base-url", base]) };
}
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const CAPS = { tools: [{ name: "read", available: true, harnesses: ["pi"] }, { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] }], places: { default_place: { mode: "runner" } } };
const COMPUTERS = { kinds: [{ kind: "none", shell: "local" }] };
const served = (method, path) => (path === "/capabilities" ? { status: 200, body: CAPS } : path === "/computers" ? { status: 200, body: COMPUTERS } : undefined);

test("a lane refused while another lane's request is still out reads as refused, not started: each request is judged on its own", { timeout: 60_000 }, async (t) => {
  const { seen, agentrun } = await fake(t, async (method, path, body) => {
    const read = served(method, path);
    if (read) return read;
    if (method === "POST" && path === "/agents") {
      // Lane 1 is refused while lane 2's agent is still being made.
      return body.definition.id.endsWith("-1-1") ? later(50, { status: 422, body: { error: { code: "input_invalid", message: "lane one is refused" } } }) : later(300, { status: 201, body: { agent_id: body.definition.id, revision: "rv-2" } });
    }
    if (method === "POST" && path.endsWith("/runs")) return { status: 201, body: { run_id: "run-2", status: "queued" } };
    return { status: 404, body: {} };
  });
  const out = await agentrun(["race", "start", "--lane", "pi/m-one", "--lane", "pi/m-two", "--task", "x", "--label", "fake-1"]);
  assert.equal(out.code, 1, out.err);
  const printed = JSON.parse(out.out);
  assert.equal(printed.lanes[0].error, "input_invalid: lane one is refused");
  assert.equal(printed.lanes[0].run_id, undefined);
  assert.equal(printed.lanes[1].run_id, "run-2");
  assert.match(out.err, /^Lane 1 \(pi\/m-one\) did not start: input_invalid: lane one is refused$/m);
  assert.deepEqual(seen.filter((r) => r.path.endsWith("/runs")).map((r) => r.path), ["/agents/race-fake-1-2-1/runs"]);
});

test("a lane whose start was cut off reads as unsure, the label and every other lane still printed; an archive that fails keeps the refusal", { timeout: 60_000 }, async (t) => {
  const { agentrun } = await fake(t, async (method, path, body) => {
    const read = served(method, path);
    if (read) return read;
    if (method === "POST" && path === "/agents") return { status: 201, body: { agent_id: body.definition.id, revision: "rv" } };
    if (path === "/agents/race-fake-2-1-1/runs") return { status: 201, body: { run_id: "run-1", status: "queued" } };
    if (path === "/agents/race-fake-2-2-1/runs") return "drop";
    if (path === "/agents/race-fake-2-3-1/runs") return { status: 409, body: { error: { code: "idempotency_conflict", message: "lane three is refused" } } };
    if (path === "/agents/race-fake-2-3-1/archive") return "drop";
    return { status: 404, body: {} };
  });
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--lane", "pi/c", "--task", "x", "--label", "fake-2"]);
  assert.equal(out.code, 1, out.err);
  const printed = JSON.parse(out.out);
  assert.equal(printed.label, "fake-2");
  assert.equal(printed.lanes[0].run_id, "run-1");
  assert.match(printed.lanes[1].unsure ?? "", /Cannot reach the server/);
  assert.equal(printed.lanes[1].error, undefined, "a start cut off is no refusal: it may have started");
  assert.equal(printed.lanes[2].error, "idempotency_conflict: lane three is refused");
  assert.match(printed.lanes[2].archive ?? "", /Cannot reach the server/);
  assert.match(out.err, /^Lane 2 \(pi\/b\) may have started: .*agentrun race show fake-2/m);
});

test("race start starts no lane when the server's computers do not read: a lane's tools would miss the runner's shell", { timeout: 60_000 }, async (t) => {
  const { seen, agentrun } = await fake(t, async (method, path) => (path === "/capabilities" ? { status: 200, body: CAPS } : path === "/computers" ? { status: 503, body: { error: { code: "unavailable", message: "try again" } } } : { status: 201, body: {} }));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--task", "x", "--label", "fake-3"]);
  assert.equal(out.code, 1, out.err);
  assert.match(out.err, /GET \/computers: try again\. No lane was started\./);
  assert.equal(seen.filter((r) => r.method === "POST").length, 0);
});

/** `--wait`'s fake runs: each run's timeline (long-polled, as `runs wait` reads it) and the run itself, from `runs`
 *  (run id -> the run as GET /runs/{id} answers it); a run whose status is not terminal answers an unchanged page. */
const ENDED = new Set(["completed", "failed", "cancelled", "input_required", "paused"]);
function waited(runs) {
  return (method, path) => {
    const read = served(method, path);
    if (read) return read;
    const timeline = /^\/runs\/([^/?]+)\/timeline\?/.exec(path);
    if (timeline) {
      const run = runs[decodeURIComponent(timeline[1])];
      const ended = ENDED.has(run.status);
      return { status: 200, body: { run_id: run.run_id, status: run.status, rows: [], next_after: 1, unchanged: !ended, has_more: false, final: ended, poll_after_ms: 100 } };
    }
    const one = /^\/runs\/([^/?]+)$/.exec(path);
    if (one) return { status: 200, body: runs[decodeURIComponent(one[1])] };
    return undefined;
  };
}
const runOf = (id, lane, harness, model, status, extra = {}) => ({ run_id: id, status, labels: { race: "w", lane: String(lane), harness, model }, created_at: "2026-11-28T04:00:00.000Z", ended_at: ENDED.has(status) ? "2026-11-28T04:00:12.000Z" : null, cost: { usd: 0.031, cap_usd: 0.5 }, ...extra });
/** A fake that starts each lane as run-<n> and answers `--wait`'s reads from `runs`. */
const starting = (runs) => {
  const wait = waited(runs);
  return async (method, path, body) => {
    const read = wait(method, path);
    if (read) return read;
    if (method === "POST" && path === "/agents") return { status: 201, body: { agent_id: body.definition.id, revision: "rv" } };
    const lane = /^\/agents\/race-[^/]+-(\d+)-1\/runs$/.exec(path);
    if (method === "POST" && lane) return { status: 201, body: { run_id: `run-${lane[1]}`, status: "queued" } };
    return { status: 404, body: { error: { code: "not_found", message: `no ${method} ${path}` } } };
  };
};

test("race start --wait follows each lane's run to its end on the run's own timeline, prints the lanes side by side and exits 1 when a lane failed", { timeout: 60_000 }, async (t) => {
  const runs = {
    "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "Block sort.\u001b[31m red\u001b[0m\nIt is in place." } }),
    "run-2": runOf("run-2", 2, "pi", "b", "failed", { error: { code: "model_error", message: "the model failed" } }),
  };
  const { seen, agentrun } = await fake(t, starting(runs));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--task", "x", "--label", "w", "--wait"]);
  assert.equal(out.code, 1, out.err);
  const lines = out.out.trimEnd().split("\n");
  assert.match(lines[0], /^LANE +HARNESS\/MODEL +STATUS +COST +SECONDS +ANSWER$/);
  assert.match(lines[1], /^1 +pi\/a +completed +\$0\.0310 of \$0\.50 +12 +Block sort\. red$/, "the answer's first line, its control characters gone");
  assert.match(lines[2], /^2 +pi\/b +failed +\$0\.0310 of \$0\.50 +12 +model_error: the model failed$/);
  assert.ok(!out.out.includes("\u001b"), "no escape from a model's text reaches the terminal");
  assert.match(out.err, /^Lane 2 \(pi\/b\) failed\.$/m);
  const reads = seen.filter((r) => r.method === "GET" && r.path.startsWith("/runs"));
  assert.ok(reads.some((r) => /^\/runs\/run-1\/timeline\?after=0&wait_ms=0$/.test(r.path)), "each lane is waited on its run's own timeline, as runs wait does");
  assert.ok(!reads.some((r) => r.path.startsWith("/runs?")), "no list polling while lanes have runs to follow");
});

test("race start --wait --json: every lane completed is exit 0, each lane with its status, cost, seconds and answer", { timeout: 60_000 }, async (t) => {
  const runs = { "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "13" } }), "run-2": runOf("run-2", 2, "pi", "b", "completed", { result: { final_answer: "14" } }) };
  const { agentrun } = await fake(t, starting(runs));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--task", "x", "--label", "w", "--wait", "--json"]);
  assert.equal(out.code, 0, out.err);
  const printed = JSON.parse(out.out);
  assert.equal(printed.label, "w");
  assert.deepEqual(printed.lanes.map((l) => [l.lane, l.run_id, l.status, l.cost_usd, l.cap_usd, l.seconds, l.answer]), [[1, "run-1", "completed", 0.031, 0.5, 12, "13"], [2, "run-2", "completed", 0.031, 0.5, 12, "14"]]);
});

test("race start --wait past --timeout exits 1 and names each lane still running; the runs go on", { timeout: 60_000 }, async (t) => {
  const runs = { "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "done" } }), "run-2": runOf("run-2", 2, "pi", "b", "running") };
  const { agentrun } = await fake(t, starting(runs));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--task", "x", "--label", "w", "--wait", "--timeout", "1"]);
  assert.equal(out.code, 1, out.err);
  assert.match(out.out, /^2 +pi\/b +running /m);
  assert.match(out.err, /^Lane 2 \(pi\/b\) is still running after 1 s; it goes on: see agentrun race show w --wait\.$/m);
  assert.doesNotMatch(out.err, /Lane 1/);
});

test("race start --wait: a lane waiting on an approval ends the wait for that lane, says where to answer it, exit 8 when no lane failed", { timeout: 60_000 }, async (t) => {
  const runs = { "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "done" } }), "run-2": runOf("run-2", 2, "pi", "b", "input_required", { pending: { kind: "approval", id: "ap-1", tool: "bash", summary: "rm -rf build" } }) };
  const { agentrun } = await fake(t, starting(runs));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "pi/b", "--task", "x", "--label", "w", "--wait"]);
  assert.equal(out.code, 8, out.err);
  assert.match(out.out, /^2 +pi\/b +input_required /m);
  assert.match(out.err, /^Lane 2 \(pi\/b\) waits on an approval: answer it on the race's page in the console, #\/races\/w; then agentrun race show w --wait\.$/m);
});

test("race start --wait: a lane that did not start is a row of its own and exit 1, the other lane still followed to its end", { timeout: 60_000 }, async (t) => {
  const runs = { "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "done" } }) };
  const start = starting(runs);
  const { agentrun } = await fake(t, async (method, path, body) => (method === "POST" && path === "/agents" && body.definition.id.endsWith("-2-1") ? { status: 422, body: { error: { code: "input_invalid", message: "no such harness" } } } : start(method, path, body)));
  const out = await agentrun(["race", "start", "--lane", "pi/a", "--lane", "nope/b", "--task", "x", "--label", "w", "--wait"]);
  assert.equal(out.code, 1, out.err);
  assert.match(out.out, /^1 +pi\/a +completed /m);
  assert.match(out.out, /^2 +nope\/b +not started +- +- +input_invalid: no such harness$/m);
  assert.match(out.err, /^Lane 2 \(nope\/b\) did not start: input_invalid: no such harness$/m);
});

test("race show LABEL --wait reads the race's runs once, follows each to its end and prints the table", { timeout: 60_000 }, async (t) => {
  const runs = { "run-1": runOf("run-1", 1, "pi", "a", "completed", { result: { final_answer: "one" } }), "run-2": runOf("run-2", 2, "codex", "b", "completed", { result: { final_answer: "two" } }) };
  const wait = waited(runs);
  const { seen, agentrun } = await fake(t, async (method, path) => (path.startsWith("/runs?") ? { status: 200, body: { runs: [runs["run-2"], runs["run-1"]] } } : (wait(method, path) ?? { status: 404, body: {} })));
  const out = await agentrun(["race", "show", "w", "--wait"]);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /^1 +pi\/a +completed .* one$/m);
  assert.match(out.out, /^2 +codex\/b +completed .* two$/m);
  assert.equal(seen.filter((r) => r.path.startsWith("/runs?")).length, 1);
});
