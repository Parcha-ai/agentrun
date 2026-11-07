// Every harness's system prompt starts with one line that says today's date, in UTC, and where the run works: pi's, and
// claude-agent's and codex's (on the faux harness), the same line. It is made as each turn starts, so a run resumed on a
// later day is told that day. The faux model and the faux harness answer with the system prompt they were given
// (faux-system.mjs); a run's process started with faux-clock.mjs preloaded lives on a later day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const CLOCK = new URL("./fixtures/faux-clock.mjs", import.meta.url).href;
const HARNESSES = ["pi", "claude-agent", "codex"];
/** The later day a resumed run's process lives on. */
const LATER = "2031-02-14T12:00:00.000Z";

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
/** The line, on `day`. */
const lineOf = (day) => `Today is ${day} (UTC). You are running on AgentRun; your workspace is your working directory, and file paths are relative to it.`;
/** The days a prompt's date lines say, in order: the last is the one the model was told last. */
const daysIn = (prompt) => [...prompt.matchAll(/^Today is (\d{4}-\d{2}-\d{2}) \(UTC\)\./gm)].map((m) => m[1]);
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

/** Starts a run of a new agent `id` on `harness` and waits for it to complete: its id, and the system prompt it was given. */
async function ran(api, id, harness) {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: "Answer the question." }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "What is the newest Python?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  return { runId: run.body.run_id, prompt: await answer(api, run.body.run_id) };
}

test("pi, claude-agent and codex all get the same first line in their system prompt: today's date in UTC and where the workspace is, before the instructions", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
  const firsts = {};
  const wanted = {};
  for (const harness of HARNESSES) {
    // Each run's day, read before and after that run alone: one that crosses midnight (UTC) may say either day.
    const before = dayOf(Date.now());
    const { prompt } = await ran(api, `dated-${harness}`, harness);
    const after = dayOf(Date.now());
    assert.ok(prompt.includes("Answer the question."), `${harness}: the instructions are still there: ${prompt}`);
    firsts[harness] = prompt.split("\n")[0];
    wanted[harness] = lineOf(firsts[harness] === lineOf(after) ? after : before);
  }
  assert.deepEqual(firsts, wanted);
});

for (const harness of HARNESSES) {
  test(`a ${harness} run resumed on a later day is told that day: the line is made for each turn, never kept from the first`, { timeout: 150_000 }, async (t) => {
    const first = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const { api, data } = first;
    const before = dayOf(Date.now());
    const { runId, prompt } = await ran(api, `resumed-${harness}`, harness);
    const after = dayOf(Date.now());
    // The server and the run's process end; the next server's process for the run lives on a later day.
    await first.close();
    withEnv(t, { NODE_OPTIONS: `--import=${CLOCK}`, DATE_LINE_NOW: LATER });
    const next = await serve(t, { data, faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    assert.equal((await next.api("POST", `/runs/${runId}/messages`, { content: "And today?" })).status, 202);
    await follow(next.api, runId, ["completed"], { deadlineMs: 55_000 });
    const resumed = await answer(next.api, runId);
    assert.ok(resumed.includes("Answer the question."), `the instructions are still there: ${resumed}`);
    const firstDay = daysIn(prompt)[0];
    assert.deepEqual({ first: [before, after].includes(firstDay) ? "today" : firstDay ?? null, resumed: daysIn(resumed).at(-1) ?? null }, { first: "today", resumed: dayOf(LATER) }, `first turn:\n${prompt}\n\nresumed turn:\n${resumed}`);
    assert.ok(resumed.split("\n").includes(lineOf(dayOf(LATER))), `the whole line, on the later day: ${resumed}`);
  });
}
