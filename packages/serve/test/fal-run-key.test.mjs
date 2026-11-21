// fal's hosted MCP server keeps one submission_key journal per fal account: a key it has seen is bound to its first
// request, and the same key with another request is refused. A run's gateway (mcp-gateway.ts, fal-price.ts falKeys)
// scopes each key an agent sends fal to the run before it leaves, so two runs that make the same key (the same task twice
// a day) never collide, while one run's retry of a key still reaches fal with the same key and is deduped. Every reply
// reads back with the agent's own key. A fake stands in for fal's server at fal's address, with its journal's rules.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { bookedIn } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const TOKEN = "mcp-token";
const T0 = Date.parse("2026-11-20T12:00:00Z");
const FAL = "https://mcp.fal.ai/mcp";
const RUN_A = "0193a1b2-0000-7000-8000-00000000000a";
const RUN_B = "0193a1b2-0000-7000-8000-00000000000b";
/** fal's submission_key, as its tools declare it. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEOGRAM = "fal-ai/ideogram/v3";
const textOf = (result) => result.content.map((block) => block.text).join("");

/** fal's journal, shared by every run on one fal account: `keys`, each tool call's submission keys as fal received them. */
function falAccount() {
  const journal = new Map();
  const keys = [];
  let jobs = 0;
  /** One job: replayed for its key's own request, refused for another request, else a new job. */
  const submit = (key, request) => {
    if (key === undefined) return { status: "completed", request_id: `r${(jobs += 1)}`, submission_replayed: false };
    const said = JSON.stringify(request);
    const bound = journal.get(key);
    if (bound && bound.request !== said) return { status: "error", submission_key: key, error: { type: "submission_conflict", message: `This submission key ${key} is bound to another request or payer.` } };
    if (bound) return { status: "completed", submission_key: key, request_id: bound.id, submission_replayed: true };
    const id = `r${(jobs += 1)}`;
    journal.set(key, { request: said, id });
    return { status: "completed", submission_key: key, request_id: id, submission_replayed: false };
  };
  const result = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }], ...(body.status === "error" ? { isError: true } : {}) });
  const tools = {
    get_pricing: { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => result({ prices: [{ endpoint_id, unit_price: 0.03, unit: "images", currency: "USD" }] }) },
    run_model: { description: "run_model", input: { type: "object", properties: {} }, run: (args) => (keys.push({ tool: "run_model", key: args.submission_key }), result({ ...submit(args.submission_key, [args.endpoint_id, args.input]), endpoint_id: args.endpoint_id, result: { images: [{ url: "https://v3.fal.media/1.png" }] } })) },
    submit_job: { description: "submit_job", input: { type: "object", properties: {} }, run: (args) => (keys.push({ tool: "submit_job", key: args.submission_key }), result({ ...submit(args.submission_key, [args.endpoint_id, args.input]), endpoint_id: args.endpoint_id })) },
    submit_jobs: {
      description: "submit_jobs", input: { type: "object", properties: {} },
      run: (args) => {
        keys.push({ tool: "submit_jobs", key: args.requests.map((one) => one.submission_key) });
        return result({ jobs: args.requests.map((one) => ({ index: one.index, endpoint_id: one.endpoint_id, ...submit(one.submission_key, [one.endpoint_id, one.input, one.index]) })) });
      },
    },
    get_submission: {
      description: "get_submission", input: { type: "object", properties: {} },
      run: (args) => {
        keys.push({ tool: "get_submission", key: args.submission_key });
        const bound = journal.get(args.submission_key);
        return result(bound ? { status: "found", submission_key: args.submission_key, request_id: bound.id } : { status: "not_found", submission_key: args.submission_key, message: `No submission ${args.submission_key} on this account.` });
      },
    },
  };
  return { tools, keys, sent: (tool) => keys.filter((one) => one.tool === tool).map((one) => one.key) };
}

/** A fake server serving `account`'s tools, and one run's gateway pinned to it at `url` (fal's own address by default,
 *  each request sent to the fake) with `entry` beside its URL and tools. */
async function runOn(t, account, { run, url = FAL, entry = { meter: "fal" }, server = "fal" } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  Object.assign(fake.tools, account.tools);
  const work = await mkdtemp(join(tmpdir(), "fal-run-key-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = memorySessionStore();
  const tools = await cap.runCap({ sessions: store, capUsd: () => 5, now: () => T0, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
  const paid = { admit: (request) => tools.admit(request), settle: (id, usd, options) => tools.settle(id, usd, options) };
  const pinned = url ?? fake.url;
  const gateway = mcpGateway({
    pin: { [server]: { url: pinned, tools: Object.keys(account.tools).map((name) => ({ name, inputSchema: { type: "object" } })), ...entry } },
    credentials: { [server]: { url: pinned, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => async (change) => change({ appendEntry: async () => undefined }),
    capped: () => true,
    now: () => T0,
    ...(run ? { run } : {}),
    ...(url && url !== fake.url ? { fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(url, fake.url), init) } : {}),
  });
  let calls = 0;
  return {
    fakeUrl: fake.url,
    call: (tool, args) => {
      const callId = `c${(calls += 1)}`;
      return bookedIn({ call: callId, paid }, () => gateway.call(server, tool, args, { signal: new AbortController().signal, callId }));
    },
  };
}

const job = (prompt, key) => ({ endpoint_id: IDEOGRAM, input: { prompt, num_images: 1 }, submission_key: key });

test("two runs that make the same key both reach fal, each under its own key; one run's retry reaches it with the same key", async (t) => {
  const account = falAccount();
  const a = await runOn(t, account, { run: RUN_A });
  const b = await runOn(t, account, { run: RUN_B });
  const first = await a.call("run_model", job("a lighthouse at dusk", "quick-image-lighthouse-20261120-a7f3"));
  assert.equal(first.isError, undefined, textOf(first));
  // The same task again in another run, which made the same key: a different request, never refused for it.
  const other = await b.call("run_model", job("a lighthouse at dawn", "quick-image-lighthouse-20261120-a7f3"));
  assert.equal(other.isError, undefined, `the second run's job is not refused: ${textOf(other)}`);
  assert.equal(JSON.parse(textOf(other)).submission_replayed, false, "the second run's job is its own, not the first's");
  // The first run sends its job again (its reply was lost): fal dedupes it.
  const retry = await a.call("run_model", job("a lighthouse at dusk", "quick-image-lighthouse-20261120-a7f3"));
  assert.equal(JSON.parse(textOf(retry)).submission_replayed, true, "a retry within the run is the same submission");
  const [ka, kb, kretry] = account.sent("run_model");
  assert.equal(kretry, ka, "one run sends one key the same way every time");
  assert.notEqual(ka, kb, "two runs never send fal the same key");
  for (const key of [ka, kb]) assert.match(key, KEY_SHAPE, "a key fal accepts");
});

test("a resumed run (a new claim's gateway) sends its keys as before: its retry is still the same submission", async (t) => {
  const account = falAccount();
  const first = await runOn(t, account, { run: RUN_A });
  await first.call("run_model", job("a share card", "card-1"));
  const resumed = await runOn(t, account, { run: RUN_A });
  const retry = JSON.parse(textOf(await resumed.call("run_model", job("a share card", "card-1"))));
  assert.deepEqual([retry.submission_replayed, retry.submission_key], [true, "card-1"], "deduped, read back as the agent's key");
  const [sent, again] = account.sent("run_model");
  assert.equal(again, sent);
});

test("the agent reads its own key in every reply: a result, and an error that names it", async (t) => {
  const account = falAccount();
  const a = await runOn(t, account, { run: RUN_A });
  const result = await a.call("run_model", job("a share card", "card-1"));
  const body = JSON.parse(textOf(result));
  assert.equal(body.submission_key, "card-1", "the reply's submission_key is the agent's");
  assert.doesNotMatch(textOf(result), new RegExp(account.sent("run_model")[0].replace(/[.:]/g, "\\$&")), "the scoped key never shows");
  // The same key with another request in the same run: fal refuses it, and its error names the agent's key.
  const conflict = await a.call("submit_job", job("another card", "card-1"));
  assert.equal(conflict.isError, true);
  const error = JSON.parse(textOf(conflict));
  assert.equal(error.submission_key, "card-1");
  assert.equal(error.error.message, "This submission key card-1 is bound to another request or payer.");
});

test("get_submission in the run reads the key the run's job was sent under", async (t) => {
  const account = falAccount();
  const a = await runOn(t, account, { run: RUN_A });
  await a.call("submit_job", job("a poster", "poster-7"));
  const found = await a.call("get_submission", { submission_key: "poster-7" });
  assert.equal(account.sent("get_submission")[0], account.sent("submit_job")[0], "get_submission asks fal for the scoped key");
  assert.deepEqual(JSON.parse(textOf(found)), { status: "found", submission_key: "poster-7", request_id: "r1" });
  // Another run looking the same key up finds nothing of the first run's.
  const b = await runOn(t, account, { run: RUN_B });
  const missing = JSON.parse(textOf(await b.call("get_submission", { submission_key: "poster-7" })));
  assert.equal(missing.status, "not_found");
  assert.equal(missing.message, "No submission poster-7 on this account.");
});

test("submit_jobs scopes each request's key, and its entries read back with the agent's", async (t) => {
  const account = falAccount();
  const a = await runOn(t, account, { run: RUN_A });
  const b = await runOn(t, account, { run: RUN_B });
  const batch = (prompt) => ({ requests: [{ index: 0, ...job(`${prompt} one`, "batch-1") }, { index: 1, ...job(`${prompt} two`, "batch-2") }] });
  const ra = JSON.parse(textOf(await a.call("submit_jobs", batch("a"))));
  const rb = JSON.parse(textOf(await b.call("submit_jobs", batch("b"))));
  const [sa, sb] = account.sent("submit_jobs");
  assert.notEqual(sa[0], sa[1], "each request keeps its own key");
  assert.ok(sa.every((key, i) => key !== sb[i] && KEY_SHAPE.test(key)), `each request is scoped to its run: ${sa} / ${sb}`);
  for (const reply of [ra, rb]) {
    assert.deepEqual(reply.jobs.map((one) => [one.index, one.submission_key, one.status]), [[0, "batch-1", "completed"], [1, "batch-2", "completed"]], "each entry with the agent's key, none refused");
  }
});

test("a key at fal's length limit is scoped within it, without two keys colliding", async (t) => {
  const account = falAccount();
  const a = await runOn(t, account, { run: RUN_A });
  const long = (end) => `k${"x".repeat(126)}${end}`;
  for (const key of [long("1"), long("2"), long("1")]) {
    const reply = JSON.parse(textOf(await a.call("submit_job", { endpoint_id: IDEOGRAM, input: { prompt: key.at(-1), num_images: 1 }, submission_key: key })));
    assert.equal(reply.submission_key, key, "the agent reads its own key back");
  }
  const [one, two, again] = account.sent("submit_job");
  assert.ok([one, two].every((key) => KEY_SHAPE.test(key)), `within fal's limit: ${one.length}, ${two.length}`);
  assert.notEqual(one, two, "keys that differ only past the limit stay apart");
  assert.equal(again, one, "and stay the same each time");
});

test("a server that is not fal's, and an eval's fake fal on loopback, receive the agent's own key", async (t) => {
  const account = falAccount();
  // Another server with a tool that happens to take a submission_key.
  const other = await runOn(t, account, { run: RUN_A, url: "https://mcp.example.com/mcp", entry: {}, server: "other" });
  await other.call("submit_job", job("x", "card-1"));
  // A fake saved with the toolkit fal at its own loopback address, as a template eval saves one: its log is what the
  // eval's graders read, so the key in it is the agent's.
  const fake = await runOn(t, account, { run: RUN_A, url: null });
  await fake.call("run_model", job("y", "card-2"));
  await fake.call("get_submission", { submission_key: "card-2" });
  assert.deepEqual(account.keys, [{ tool: "submit_job", key: "card-1" }, { tool: "run_model", key: "card-2" }, { tool: "get_submission", key: "card-2" }]);
});
