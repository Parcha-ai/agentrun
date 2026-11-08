// A claude-agent run whose tool call is set to ask parks the call, and the request that asked for it is booked at its
// price: the Claude CLI runs a tool as soon as its tool_use block has streamed, before the request's end (message_delta,
// which carries its usage, then message_stop), so the park's interrupt waits for that request to end (within the
// booking wait, harness-app.ts BOOKING_WAIT_MS) before it cuts the turn. A request whose end does not come within the wait
// is still booked as today: stopped, its cost unknown. On the real pinned Agent SDK and Claude CLI, against a fake
// Anthropic endpoint on loopback, through a proxy that holds the asking request's end.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { BOOKING_WAIT_MS } from "../dist/harness-app.js";
import { agent, call, cookieOf, follow, runDir, serve } from "./support.mjs";

const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
const PAGE = "http://public.example/";
const json = { "content-type": "application/json" };
/** The owner's sign-in phrase for this test's server. */
const SIGN_IN_PHRASE = "the owner signs in with this phrase";

/** The run's store entries, once its process has let it go. */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT id, record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  } finally {
    db.close();
  }
}

/** A proxy to `target` that holds the first /v1/messages stream's end (its message_delta and after) for `holdMs`
 *  (Infinity: until the client cuts it or the test ends), so its tool_use block reaches the CLI first. */
async function holdingEnd(t, target, holdMs, seen) {
  let n = 0;
  const holds = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const index = req.url.startsWith("/v1/messages") ? ++n : 0;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k)));
    const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
    res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k))));
    if (index !== 1 || !(upstream.headers.get("content-type") ?? "").includes("event-stream") || !upstream.body) return void res.end(Buffer.from(await upstream.arrayBuffer()));
    const decoder = new TextDecoder();
    let buffer = "";
    let held = false;
    for await (const value of upstream.body) {
      buffer += decoder.decode(value, { stream: true });
      for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
        const event = buffer.slice(0, i + 2);
        buffer = buffer.slice(i + 2);
        if (!held && event.startsWith("event: message_delta")) {
          held = true;
          seen.heldAt = Date.now();
          await new Promise((resolve) => {
            holds.push(resolve);
            if (Number.isFinite(holdMs)) setTimeout(resolve, holdMs);
          });
          if (res.destroyed) return;
        }
        res.write(event);
      }
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const release of holds) release(); server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

/** A claude-agent run on `proxy` whose one web_fetch call asks: parked, denied, completed. Its view and entries. */
async function parkedRun(t, holdMs) {
  let calls = 0;
  const fake = await fakeAnthropic({
    reply: (request) => {
      const fetchTool = request.tools.find((name) => /web_fetch/.test(name));
      if (fetchTool && calls === 0) {
        calls += 1;
        return { tool: { name: fetchTool, input: { url: PAGE } } };
      }
      return { text: "Understood." };
    },
  });
  t.after(() => fake.close());
  const seen = {};
  const proxy = await holdingEnd(t, fake.url, holdMs, seen);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: proxy, AGENT_MODEL: `anthropic/${MODEL}` });
  const { api, data, port } = await serve(t, { faux: undefined, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  assert.equal((await api("POST", "/agents", agent("fetcher", { harness: "claude-agent", model: `anthropic/${MODEL}`, instructions: `Fetch ${PAGE} once.`, tools: ["web_fetch"] }))).status, 201);
  const started = await api("POST", "/agents/fetcher/runs", { input: { content: `Fetch ${PAGE} once.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["input_required"], { deadlineMs: 120_000 });
  // From the hold of the asking request's end to the park seen here (the poll's own wait included).
  const parkedAfterMs = seen.heldAt === undefined ? undefined : Date.now() - seen.heldAt;
  const parked = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(parked.pending?.tool, "web_fetch");
  const answer = await call(port, { method: "POST", path: `/v2/runs/${runId}/approvals/${parked.pending.id}`, headers: { ...json, cookie: cookieOf(setup), origin }, body: { decision: "deny", note: "Not now." } });
  assert.equal(answer.status, 204, answer.text);
  await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  const turns = entriesOf(data, runId).filter((e) => e.kind === "runner.turn").map((e) => e.data);
  return { parked, view, turns, parkedAfterMs };
}

test("a claude-agent call parked for approval while its request's end is still on its way: the park waits for that end, so the request is booked at its price", { timeout: 300_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // The request's end comes 700 ms after its tool_use block: well inside the booking wait (2 s).
  assert.ok(700 * 2 < BOOKING_WAIT_MS, "the hold is well inside the wait");
  const { parked, view, turns } = await parkedRun(t, 700);
  assert.deepEqual([turns[0]?.rule, typeof turns[0]?.usd], ["answered", "number"], `the asking request is booked at its price: ${JSON.stringify(turns[0])}`);
  assert.equal(typeof parked.cost?.usd, "number", `the parked run's cost is known: ${JSON.stringify(parked.cost)}`);
  assert.deepEqual([view.status, typeof view.cost?.usd, view.cost?.unpriced ?? 0], ["completed", "number", 0], JSON.stringify(view.cost));
});

test("a claude-agent call parked for approval whose request's end never comes still parks once the booking wait has passed, with no hang, and is booked as before: stopped, its cost unknown", { timeout: 300_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { parked, view, turns, parkedAfterMs } = await parkedRun(t, Infinity);
  // A hang (no park, or one at the test's timeout) fails this; a slow runner's second or two does not: the wait plus 10 s.
  assert.ok(parkedAfterMs !== undefined && parkedAfterMs <= BOOKING_WAIT_MS + 10_000, `parked ${parkedAfterMs} ms after the request's end was held`);
  assert.deepEqual([turns[0]?.rule, turns[0]?.usd], ["stopped", null], JSON.stringify(turns[0]));
  assert.equal(parked.cost?.unpriced, 1, JSON.stringify(parked.cost));
  assert.deepEqual([view.status, view.cost?.usd, view.cost?.unpriced], ["completed", null, 1], JSON.stringify(view.cost));
});
