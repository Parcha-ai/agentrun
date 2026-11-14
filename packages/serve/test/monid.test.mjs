// monid's catalog on one key: the client against the tests' fake monid (fixtures/faux-monid.mjs), what a call is held
// at and what it charged, the cap's check before one, and a pinned endpoint's run on claude-agent on the saved key (the
// save's pin: monid-save.test.mjs; a pinned endpoint through the loop: runner-monid-endpoint.test.mjs). No network, no
// real key.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FAUX_ENV } from "../dist/model.js";
import { chargeOf, CLIP, FAUX_MONID_ENV, heldOf, MONID_KEY_ENV, MONID_USAGE_CEILING_USD, monidClient, monidText } from "../dist/monid.js";
import { bookedIn } from "../dist/paid-calls.js";
import { monidForClaim } from "../dist/runner/monid-run.js";
import { localWorkspace, WORKSPACE_ERRORS } from "../dist/workspace/index.js";
import fakeMonid, { calls, KEY, LISTING } from "./fixtures/faux-monid.mjs";
import { agent, client, follow, scratch, serve, toolLedger, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const ENRICH = "monid:faux/person/enrich";
const SLOW = "monid:faux/slow";
/** A catalog tool asks by default (tool-gate.ts); these runs are about monid, not the gate. */
const allowed = (...names) => Object.fromEntries(names.map((name) => [name, { permission: "allow" }]));
const sleeps = [];
/** The client on the fake, its waits recorded and skipped. */
const monid = (extra = {}) => monidClient({ key: KEY, fetch: fakeMonid, sleep: async (ms) => void sleeps.push(ms), ...extra });
const sent = (from) => calls.slice(from).map((call) => `${call.method} ${call.path}`);

test("the listing is read page by page and an endpoint inspected as monid answers; a short answer is its JSON, whole", async (t) => {
  const work = await scratch(t);
  const first = await monid().endpoints(undefined);
  const second = await monid().endpoints(first.cursor);
  assert.deepEqual([...first.items, ...second.items].map((item) => item.endpoint), LISTING.slice(0, 4).map((item) => item.endpoint));
  const shown = await monid().inspect({ provider: "faux", endpoint: "/person/enrich" });
  assert.deepEqual(shown.input.body.required, ["name"]);
  assert.equal(await monidText(shown, localWorkspace(work), "inspect"), JSON.stringify(shown));
  assert.match((await monid().inspect({ provider: "faux", endpoint: "/nowhere" })).error, /not found for provider 'faux'/);
});

test("a run: a sync provider's output with its cost in dollars; an async one read until COMPLETED; each sent once", async () => {
  const now = await monid().run({ provider: "faux", endpoint: "/person/enrich", input: { body: { name: "Ada" } } });
  assert.deepEqual([now.status, now.output, now.cost], ["COMPLETED", { full_name: "Ada" }, { value: 0.003, currency: "USD" }]);
  sleeps.length = 0;
  const from = calls.length;
  const later = await monid({ pollMs: 1500 }).run({ provider: "faux", endpoint: "/tweets" });
  assert.deepEqual([later.status, later.output, later.cost], ["COMPLETED", [{ text: "a tweet" }], { value: 0.012, currency: "USD" }]);
  assert.deepEqual(sent(from), ["POST /v1/run", `GET /v1/runs/${later.runId}`, `GET /v1/runs/${later.runId}`]);
  assert.deepEqual(sleeps, [1500, 1500]);
});

test("a refusal is an error in words: the wallet (402), the workspace's budget (BLOCKED), FAILED, TIMED_OUT, the provider's 404, a wrong key", async () => {
  const run = (endpoint, key = KEY) => monid({ key }).run({ provider: "faux", endpoint });
  const wallet = await run("/wallet");
  assert.deepEqual([wallet.status, /wallet's balance is too low/.test(wallet.error)], [402, true], wallet.error);
  const budget = await run("/budget");
  assert.match(budget.error, /\(BLOCKED\): The workspace's monthly budget is spent\./);
  assert.deepEqual(budget.controls, [{ type: "BUDGET" }]);
  assert.match((await run("/broken")).error, /failed inside monid \(FAILED\)/);
  const late = await run("/late");
  assert.deepEqual([late.status, /TIMED_OUT/.test(late.error)], [408, true]);
  const missing = await run("/missing");
  assert.deepEqual([missing.status, missing.cost], [404, { value: 0, currency: "USD" }]);
  assert.match(missing.error, /No match found for the given query \(monid charges nothing/);
  assert.match((await run("/person/enrich", "not-a-secret")).error, /refused the key \(401\)/);
});

test("what a run charged: its cost; nothing when monid charged nothing; unknown, never $0, when it may have charged", async () => {
  const charged = async (endpoint, extra = {}, signal) => chargeOf(await monid(extra).run({ provider: "faux", endpoint, input: { body: { name: "Ada" } } }, signal));
  assert.deepEqual(await Promise.all(["/person/enrich", "/tweets", "/missing"].map((endpoint) => charged(endpoint))), [0.003, 0.012, 0], "reported: a micro-dollar charge in dollars, a provider's error at $0");
  assert.deepEqual(await Promise.all(["/wallet", "/budget"].map((endpoint) => charged(endpoint))), [undefined, undefined], "refused as sent, or blocked: never ran");
  assert.equal(await charged("/person/enrich", { key: "not-a-secret" }), undefined, "a wrong key runs nothing");
  assert.deepEqual(await Promise.all(["/broken", "/late"].map((endpoint) => charged(endpoint))), [null, null], "FAILED and TIMED_OUT say no cost");
  assert.equal(await charged("/slow", {}, AbortSignal.abort()), null, "stopped by its caller: it may have used some");
  assert.equal(await charged("/person/enrich", { fetch: async () => { throw new Error("offline"); } }), null, "it may have gone ahead");
});

test("what one call is held at: a per-call price; a matrix's dearest variant; a tiered price's default and every tier; anything by usage at the ceiling", () => {
  const usd = (value) => ({ value, currency: "USD" });
  assert.deepEqual(heldOf({ type: "PER_CALL", amount: usd(0.026) }), { usd: 0.026 });
  assert.deepEqual(heldOf({ type: "PER_UNIT_MATRIX", variants: [{ price: { type: "PER_CALL", amount: usd(0.01) } }, { price: { type: "PER_CALL", amount: usd(0.04) } }] }), { usd: 0.04 });
  assert.deepEqual(heldOf({ type: "TIERED", default: { type: "PER_CALL", amount: usd(0.01) }, tiers: [{ price: { type: "PER_CALL", amount: usd(0.02) } }] }), { usd: 0.03 });
  for (const price of [{ type: "PER_RESULT", amount: usd(0.001) }, { type: "PER_UNIT", amount: usd(0.5) }, { type: "PER_CALL", amount: { value: 1, currency: "EUR" } }, { type: "TIERED", default: { type: "PER_RESULT", amount: usd(0.1) }, tiers: [] }, undefined]) {
    assert.deepEqual(heldOf(price), { usd: MONID_USAGE_CEILING_USD, usage: true }, JSON.stringify(price));
  }
});

test("under a cap, a pinned endpoint is refused before it is sent unless the run's spend plus what it holds and what the call is held at fits, as a model request is; one held counts against the next; with no cap it runs", async (t) => {
  const work = await scratch(t);
  const env = { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: FAUX_MONID, [MONID_KEY_ENV]: KEY };
  // Priced by usage: held at the $1 ceiling.
  const pin = { [ENRICH]: { description: "Enrich a person.", input: { type: "object" }, usd: MONID_USAGE_CEILING_USD, usage: true } };
  const { tools: [tool] } = monidForClaim(pin, env, () => localWorkspace(work));
  const from = calls.length;
  let ids = 0;
  const run = (paid) => {
    const callId = `c${(ids += 1)}`;
    return bookedIn({ call: callId, paid }, () => tool.call({ body: { name: "Ada" } }, { callId, signal: new AbortController().signal, attempt: 0 }));
  };
  const said = (result) => JSON.parse(result.text);
  const full = await toolLedger(2);
  await full.spend(1.5);
  const refused = await run(full);
  assert.equal(refused.isError, true);
  assert.match(said(refused).error, /^spend_cap_reached: Not sent: this run has spent \$1\.50 of its \$2 cap, and the next step, monid:faux\/person\/enrich, could cost up to \$1 \(monid prices monid:faux\/person\/enrich by usage, so a call counts at the \$1 ceiling until monid says what it charged\)\. Raise the cap to at least \$2\.50 to continue\.$/);
  assert.deepEqual(sent(from), [], "refused, not sent");
  // $0.50 spent: the ceiling fits, it runs, and is booked at what monid charged ($0.003 for the faux /person/enrich).
  const room = await toolLedger(2);
  await room.spend(0.5);
  assert.equal(said(await run(room)).status, "COMPLETED", "0.5 + 1 fits: it runs");
  assert.deepEqual([sent(from), Math.round((room.spentUsd() - 0.5) * 1e6) / 1e6, room.heldUsd()], [["POST /v1/run"], 0.003, 0]);
  // Two at once: the first is held ($1), so the second is checked against it (0.5 + 1 + 1 > 2) and refused unsent.
  const both = await toolLedger(2);
  await both.spend(0.5);
  const [first, second] = await Promise.all([run(both), run(both)]);
  assert.deepEqual([[first, second].filter((r) => !r.isError).length, [first, second].filter((r) => r.isError && /spend_cap_reached/.test(said(r).error)).length, sent(from).length], [1, 1, 2]);
  assert.equal(said(await run(await toolLedger(undefined))).status, "COMPLETED", "with no cap, it runs");
});

test("/usage by meter during a monid run in flight: tokens are the run's model cost, and no tool charge is reported until the call settles", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname, fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("slow", { tools: [SLOW], tool_settings: allowed(SLOW) }))).status, 201);
  const run = await api("POST", "/agents/slow/runs", { input: { content: "Run monid's /slow." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const id = run.body.run_id;
  // Sent (its mark is written before), and the request that called it priced on the run's timeline.
  const sent = async () => (await readFile(log, "utf8").catch(() => "")).includes('"path":"/v1/run"');
  for (let i = 0; !(await sent()) || !((await api("GET", `/runs/${id}`)).body.cost.usd > 0); i++) {
    assert.ok(i < 400, "the monid call is in flight after a priced request");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cost = (await api("GET", `/runs/${id}`)).body.cost.usd;
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters, [["tokens", cost, 0]], "the model cost alone: never what the call is held at, never a negative token meter");
  assert.ok((await api("POST", `/runs/${id}/cancel`, {})).status < 300);
});

test("a run its caller stops is asked to stop at monid and answers so; one that outlasts the wait is stopped too", async () => {
  const controller = new AbortController();
  const from = calls.length;
  const stopped = await monid({ sleep: async () => controller.abort() }).run({ provider: "faux", endpoint: "/slow" }, controller.signal);
  assert.match(stopped.error, /was stopped by the caller; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${stopped.runId}/stop`], "never read again, never sent again");
  const outlasted = await monid({ waitMs: 50, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }).run({ provider: "faux", endpoint: "/slow" });
  assert.match(outlasted.error, /did not end in 0\.05 s; monid was asked to stop it/);
  assert.equal(calls.at(-1).path, `/v1/runs/${outlasted.runId}/stop`);
});

test("at the deadline the stop goes at once: after a sleep that spent the whole wait nothing is read, and a slow read is cut at the deadline", async () => {
  const waitMs = 300;
  let from = calls.length;
  let start = Date.now();
  const spent = await monid({ waitMs, sleep: () => new Promise((resolve) => setTimeout(resolve, waitMs + 20)) }).run({ provider: "faux", endpoint: "/slow" });
  assert.match(spent.error, /did not end in 0\.3 s; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${spent.runId}/stop`], "no read past the deadline");
  assert.ok(Date.now() - start < waitMs + 200, `stopped ${Date.now() - start} ms after the start`);
  // Each read hangs until its limit: the one the deadline leaves, never the 30 s a read gets on its own.
  const reads = [];
  const slowReads = (url, init = {}) => {
    if ((init.method ?? "GET") !== "GET") return fakeMonid(url, init);
    const read = { at: Date.now() };
    reads.push(read);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject((read.cut = Date.now(), init.signal.reason)), { once: true }));
  };
  from = calls.length;
  start = Date.now();
  // A read's limit is an unref'd timer, as a socket would hold the loop: this holds it in the socket's place.
  const held = setInterval(() => {}, 1_000);
  const slow = await monid({ waitMs, fetch: slowReads }).run({ provider: "faux", endpoint: "/slow" }).finally(() => clearInterval(held));
  assert.match(slow.error, /did not end in 0\.3 s; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${slow.runId}/stop`]);
  assert.ok(reads.length >= 1 && reads.every((read) => read.cut !== undefined && read.cut - start <= waitMs + 150), JSON.stringify(reads.map((read) => [read.at - start, read.cut - start])));
  assert.ok(Date.now() - start < waitMs + 250, `stopped ${Date.now() - start} ms after the start`);
});

test("a cut answer whose whole copy cannot be filed still answers, cut and saying so", async (t) => {
  const work = await scratch(t);
  await mkdir(join(work, "evidence"), { recursive: true });
  await writeFile(join(work, "evidence", "monid"), "a file where the directory would go");
  const huge = await monid().run({ provider: "faux", endpoint: "/huge" });
  const text = await monidText(huge, localWorkspace(work), "run");
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  // The Workspace's code and the port's own line for it, never the error's message (which names paths).
  const said = /the whole answer could not be saved \(([A-Z_]+): ([^)]+)\)\]$/.exec(text);
  assert.ok(said, text.slice(-200));
  assert.equal(said[2], WORKSPACE_ERRORS[said[1]], "the port's line for its code");
  assert.ok(!said[2].includes(work), "no path of the server's");
});

test("a run's answer over 60,000 characters is cut, the whole of it filed as evidence/monid/<run id>.json", async (t) => {
  const work = await scratch(t);
  const huge = await monid().run({ provider: "faux", endpoint: "/huge" });
  const text = await monidText(huge, localWorkspace(work), "run");
  assert.ok(text.endsWith(`the whole answer is in the run's files at evidence/monid/${huge.runId}.json]`), text.slice(-200));
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  assert.deepEqual(JSON.parse(await readFile(join(work, "evidence", "monid", `${huge.runId}.json`), "utf8")), huge);
});

test("capabilities list no monid tool: an endpoint is granted by name, monid:<provider>/<endpoint>, and pinned at the save", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const tools = (await client((await serve(t)).baseUrl)("GET", "/capabilities")).body.tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => /monid/.test(name)), []);
});

test("a pinned endpoint's run is 409 on claude-agent while the saved monid key is gone, and runs on it once the key is back", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID });
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: KEY } })).status, 204);
  const saved = await api("POST", "/agents", agent("finder-claude", { harness: "claude-agent", instructions: "Run monid's /person/enrich on Ada.", tools: ["read", ENRICH], tool_settings: allowed(ENRICH) }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings, [], "the key, read at the save, pinned it");
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  const refused = await api("POST", "/agents/finder-claude/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.details.unbound, refused.body.error.details.missing], [409, [], { [ENRICH]: ["MONID_API_KEY"] }]);
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: KEY } })).status, 204);
  const ran = await api("POST", "/agents/finder-claude/runs", { input: { content: "hi" } });
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  const { rows } = await follow(api, ran.body.run_id, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_status), ["success"], "monid:faux/person/enrich ran on claude-agent");
});
