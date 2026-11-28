// `agentrun race start` and `agentrun race show`: one task on 2 to 4 harness and model lanes, each a new agent of its own
// and one run of it carrying the race's labels, as the console's New race form starts a race; and the race read back by
// its label, in lane order. Against a server in this process with no runner: the runs are taken, and nothing runs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
