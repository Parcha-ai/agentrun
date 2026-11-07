// The client against a server started with a priced faux model on loopback: it creates an agent, starts a capped run
// and waits for it, lists runs, answers a run that asks, raises the cap of a run stopped at it, follows a timeline and
// reads a file the run wrote. No error message holds the token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { AgentRun, AgentRunRefused } from "../dist/index.js";
import { serve } from "./helpers.mjs";

const AGENT = { definition: { id: "notes", version: 1, name: "Notes", instructions: "Do what you are asked, and write what you make to a file.", skills: [], tools: ["write", "ask_person"] } };
const text = (bytes) => new TextDecoder().decode(bytes);

test("demo: create an agent, start a capped run and wait, list runs, answer a question, raise a cap, follow a timeline, read a file", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const client = new AgentRun({ baseUrl: server.baseUrl, apiKey: server.token });
  assert.ok(!inspect(client, { depth: 4 }).includes(server.token) && !JSON.stringify(client).includes(server.token), "a printed client holds no key");

  const agent = await client.agents.create(AGENT);
  assert.equal(agent.agent_id, "notes");
  const again = await client.agents.create(AGENT).catch((error) => error);
  assert.ok(again instanceof AgentRunRefused);
  assert.deepEqual([again.status, again.code, again.error.code], [409, "agent_exists", "agent_exists"]);
  assert.ok(!again.message.includes(server.token));

  // A capped run, waited for. Capped at $5: under three held requests' worth, the server's wrap-up note comes before the
  // first request, which this faux model would read as its person's message.
  const started = await client.runs.start("notes", { input: { content: "Write notes.md with three facts about the Moon." }, max_cost_usd: 5 });
  assert.equal(started.agent_id, "notes");
  const done = await client.runs.wait(started.run_id, { timeoutMs: 60_000 });
  assert.deepEqual([done.run_id, done.status, done.cost.cap_usd], [started.run_id, "completed", 5]);
  const listed = await client.runs.list({ limit: 10 });
  assert.ok(listed.runs.some((run) => run.run_id === started.run_id), "the run is listed");
  assert.ok((await client.agents.runs("notes")).runs.some((run) => run.run_id === started.run_id), "and in the agent's runs");

  // A run that asks: it waits on its person, is answered, and completes with what they said.
  const asking = await client.runs.start("notes", { input: { content: "Ask me which region to cover, then write region.md about it." }, max_cost_usd: 5 });
  const asked = await client.runs.wait(asking.run_id);
  assert.deepEqual([asked.status, asked.pending?.kind], ["input_required", "question"]);
  await client.runs.message(asking.run_id, { content: "Europe" });
  assert.equal((await client.runs.wait(asking.run_id)).status, "completed");
  const files = await client.runs.files(asking.run_id);
  assert.ok(files.files.some((file) => file.path === "region.md"), JSON.stringify(files));
  const region = await client.runs.readFile(asking.run_id, "region.md");
  assert.ok(region instanceof Uint8Array);
  assert.equal(text(region), "# Europe\n");
  const streamed = await client.runs.readFile(asking.run_id, "region.md", undefined, { stream: true });
  assert.ok(streamed instanceof Response);
  assert.equal(await streamed.text(), "# Europe\n");

  // A run under a cap it cannot pay for stops at it; raised, the same run goes on and completes.
  const capped = await client.runs.start("notes", { input: { content: "Write moon.md with everything known about the Moon." }, max_cost_usd: 0.05 });
  const stopped = await client.runs.wait(capped.run_id);
  assert.deepEqual([stopped.status, stopped.pending?.kind, stopped.cost.cap_usd], ["input_required", "budget", 0.05]);
  assert.ok(stopped.pending.suggested_cap_usd > 0.05);
  const raise = await client.runs.raiseCap(capped.run_id, { max_cost_usd: 1 });
  assert.deepEqual([raise.resumed, raise.max_cost_usd], [true, 1]);
  // Once the raise is kept the run reads as one that goes on, at once: never input_required with no pending.
  assert.ok(["queued", "working"].includes(raise.status), `right after the raise: ${JSON.stringify(raise)}`);
  const after = await client.runs.get(capped.run_id);
  assert.ok(!(after.status === "input_required" && after.pending === null), `read again: ${after.status}`);
  const raised = await client.runs.wait(capped.run_id);
  assert.deepEqual([raised.run_id, raised.status, raised.pending, raised.cost.cap_usd], [capped.run_id, "completed", null, 1]);
  assert.match(text(await client.runs.readFile(capped.run_id, "moon.md")), /^# .+\n$/, "it wrote moon.md once it went on");

  // Following a run live gives every row the timeline holds once it ended, each once.
  const followed = await client.runs.start("notes", { input: { content: "Write sun.md with three facts about the Sun." }, max_cost_usd: 5 });
  const rows = new Map();
  const pages = [];
  for await (const page of client.runs.follow(followed.run_id)) {
    pages.push(page);
    if (page.reset) rows.clear();
    for (const id of page.drop) rows.delete(id);
    for (const row of page.rows) rows.set(row.id, row);
  }
  assert.ok(pages.length >= 1 && pages.at(-1).final, "it ended with the final page");
  assert.equal(pages.at(-1).status, "completed");
  const whole = await client.runs.timeline(followed.run_id);
  // By id: a row upserted later (the run's usage) keeps the place it first came in here.
  assert.deepEqual(Object.fromEntries(rows), Object.fromEntries(whole.rows.map((row) => [row.id, row])), "the followed rows are the timeline's");
});
