// A place waited for is taken only for what may still run: a follow-up to a run archived while it waited, or a start of
// an agent archived while it waited, is refused, and nothing opens.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a follow-up that waits for a place does not open a run archived while it waited", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-hold.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("a"))).status, 201);
  const done = await api("POST", "/agents/a/runs", { input: { content: "hi" } });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, ["completed"]);
  const failing = await api("POST", "/agents/a/runs", { input: { content: "fail" } });
  assert.equal(failing.status, 202, JSON.stringify(failing.body));
  for (let i = 0; (await api("GET", `/runs/${failing.body.run_id}`)).body.status !== "failed"; i++) {
    assert.ok(i < 400, "the failing run reads failed");
    await sleep(50);
  }
  const message = api("POST", `/runs/${done.body.run_id}/messages`, { content: "one more" });
  await sleep(300);
  const archived = await api("POST", `/runs/${done.body.run_id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  await writeFile(gate, "");
  const answer = await message;
  await sleep(500);
  const after = await api("GET", `/runs/${done.body.run_id}`);
  assert.notEqual(answer.status, 202, `an archived run took a follow-up: ${JSON.stringify(answer.body)}; now ${JSON.stringify(after.body)}`);
  assert.equal(after.body.status, "completed", JSON.stringify(after.body));
});

test("a start that waits for a place does not start a run of an agent archived while it waited", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-hold.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("a"))).status, 201);
  const failing = await api("POST", "/agents/a/runs", { input: { content: "fail" } });
  assert.equal(failing.status, 202, JSON.stringify(failing.body));
  for (let i = 0; (await api("GET", `/runs/${failing.body.run_id}`)).body.status !== "failed"; i++) {
    assert.ok(i < 400, "the failing run reads failed");
    await sleep(50);
  }
  const start = api("POST", "/agents/a/runs", { input: { content: "hi" } });
  await sleep(300);
  assert.equal((await api("POST", "/agents/a/archive", {})).status, 200);
  await writeFile(gate, "");
  const answer = await start;
  assert.equal(answer.status, 409, `a run of an archived agent started: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.error?.code, "agent_not_runnable");
  const runs = (await api("GET", "/runs?agent=a&archived=true")).body.runs ?? [];
  assert.equal(runs.length, 1, `only the failed run: ${JSON.stringify(runs.map((r) => r.run_id))}`);
});
