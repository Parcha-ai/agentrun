// A learning batch's reads (GET .../learning/batches, GET .../batches/{id}, POST .../batches/{id}/cancel) show its saved text
// through the learning routes' cut as it is now: the server's secrets and the agent's sign-in pointers, a value saved as
// one after its row finished included, and 403 in words when a pointer can't be read here. A batch is its agent's: another
// agent's routes answer 404, and no route answers without the bearer.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { saveSignIn } from "../dist/sign-ins-store.js";
import { WITHHELD_LEARNING } from "../dist/handed-values.js";
import { agent, client, serve, withEnv } from "./support.mjs";

/** Test values, never real ones: a Browserbase context the agent signs in with, and a token the server holds. */
const LIVE = `ctx/${randomBytes(16).toString("hex")}`;
const SECRET = `batchcut-${randomBytes(16).toString("hex")}`;
const ID = "lb_00112233445566ff";
const ROUTES = [["GET", `/agents/alpha/learning/batches/${ID}`], ["GET", "/agents/alpha/learning/batches"], ["POST", `/agents/alpha/learning/batches/${ID}/cancel`]];

/** A server whose agent `alpha` has a finished batch, as the store keeps it, whose rows' answer, reference, error and
 *  lessons hold its sign-in pointer and a value that is no secret yet; then the pointer is saved (under `other`'s key when
 *  given: one this server can't open) and the value becomes a server secret. */
async function world(t, { other } = {}) {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY", "BATCH_CUT_TOKEN"]);
  const server = await serve(t, { runner: false });
  for (const id of ["alpha", "beta"]) assert.equal((await server.api("POST", "/agents", agent(id, { learning: true }))).status, 201);
  const now = new Date().toISOString();
  const learned = { notes: [`Sign in on ${LIVE}`], skills: [`skill-${SECRET}`], workflows: [`flow-${SECRET}`] };
  const put = (key, value) => server.store.settings.put(key, value);
  await put("learning_batches/alpha", [ID]);
  await put(`learning_batch/${ID}/row/1`, { n: 1, state: "done", input: { q: "q1" }, reference: `A ${SECRET}`, run_id: "run_one", answer: `A ${SECRET} via ${LIVE}`, right: true, review_after: now, review: "Review", reviewed: true, path: "agent", cost_usd: 0.1, learning_usd: 0, total_usd: 0.1, learned, merged: "c1", revisions: [{ commit: "c1", workflows: learned.workflows }] });
  await put(`learning_batch/${ID}/row/2`, { n: 2, state: "failed", input: { q: "q2" }, reference: "B", run_id: "run_two", error: `the review was not sent: ${SECRET}`, total_usd: 0.1 });
  await put(`learning_batch/${ID}`, { id: ID, agent_id: "alpha", created_at: now, ended_at: now, status: "stopped", stopped: null, inputs: ["q"], answer: "a", answer_field: null, effort: null, max_cost_usd: 5, total: 2, finished: 2, right: 1, wrong: 0, failed: 1, spent_usd: 0.2, unknown_cost_rows: 0, paths: { agent: 1, handed_back: 0, workflow: 0 }, lessons: learned, revisions: [{ row: 1, commit: "c1", workflows: learned.workflows }], error: `the loop failed on ${SECRET}` });
  await saveSignIn(server.store, other ?? seal, { agentId: "alpha", provider: "browserbase", pointer: LIVE });
  process.env.BATCH_CUT_TOKEN = SECRET;
  return server;
}

const textOf = (got) => (typeof got.body === "string" ? got.body : JSON.stringify(got.body));
const holds = (text) => [LIVE, SECRET].filter((value) => text.includes(value));

test("a batch's reads show none of the server's secrets or the agent's sign-in pointers, a value saved as one after its row finished included", async (t) => {
  const { api } = await world(t);
  for (const [method, path] of ROUTES) {
    const got = await api(method, path, method === "POST" ? {} : undefined);
    assert.equal(got.status, 200, `${method} ${path}: ${textOf(got)}`);
    assert.deepEqual(holds(textOf(got)), [], `${method} ${path} shows a value: ${textOf(got).slice(0, 600)}`);
    assert.ok(textOf(got).includes("[redacted]"), `${method} ${path}: ${textOf(got).slice(0, 600)}`);
  }
  const read = (await api("GET", `/agents/alpha/learning/batches/${ID}`)).body;
  assert.deepEqual([read.status, read.rows.length, read.rows[0].right, read.rows[1].state], ["stopped", 2, true, "failed"], "the batch as saved, its text cut");
});

test("a batch is its agent's: another agent's routes answer 404 and list none of it, and no route answers without the bearer", async (t) => {
  const server = await world(t);
  const { api } = server;
  assert.equal((await api("GET", `/agents/beta/learning/batches/${ID}`)).status, 404);
  assert.equal((await api("POST", `/agents/beta/learning/batches/${ID}/cancel`, {})).status, 404);
  assert.deepEqual((await api("GET", "/agents/beta/learning/batches")).body, { batches: [] });
  assert.equal((await api("GET", `/agents/nobody/learning/batches/${ID}`)).status, 404);
  const anyone = client(server.baseUrl, undefined);
  for (const [method, path] of ROUTES) assert.equal((await anyone(method, path, method === "POST" ? {} : undefined)).status, 401, `${method} ${path}`);
});

test("an agent whose sign-in does not open here (another seal key) has its batches withheld, in words, as its learning is", async (t) => {
  const { api } = await world(t, { other: randomBytes(32) });
  for (const [method, path] of ROUTES) {
    const got = await api(method, path, method === "POST" ? {} : undefined);
    assert.equal(got.status, 403, `${method} ${path}: ${textOf(got)}`);
    assert.ok(textOf(got).includes(WITHHELD_LEARNING), textOf(got));
    assert.deepEqual(holds(textOf(got)), [], textOf(got));
  }
  assert.equal((await api("GET", "/agents/alpha/learning")).status, 403, "the same withholding as the agent's learning");
});
