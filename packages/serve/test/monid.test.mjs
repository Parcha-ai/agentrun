// monid's catalog on one key: the client against the tests' fake monid (fixtures/faux-monid.mjs), what a run charged and
// the cap's check before one, the three table tools in capabilities and at a save, on every harness, and a pi run whose
// model calls them by their wire names and whose cost books the charge (another harness's run: harness-run.test.mjs and
// monid-saved-key.test.mjs). No network, no real key.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { wireName } from "../dist/catalog.js";
import { capBefore, capToolSpend, holdsInFlight, paidCall, spentIn, useSpend } from "../dist/cap.js";
import { chargeOf, CLIP, monidClient, monidText } from "../dist/monid.js";
import { localWorkspace, WORKSPACE_ERRORS } from "../dist/workspace/index.js";
import fakeMonid, { calls, KEY } from "./fixtures/faux-monid.mjs";
import { agent, client, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** The faux model priced on output only: a request's worst case is about $1.64 whatever its input. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const NAMES = ["monid.discover", "monid.inspect", "monid.run"];
/** monid's tools allowed: a catalog tool asks by default (tool-gate.ts), and these runs are about monid, not the gate. */
const ALLOWED = Object.fromEntries(NAMES.map((name) => [name, { permission: "allow" }]));
const sleeps = [];
/** The client on the fake, its waits recorded and skipped. */
const monid = (extra = {}) => monidClient({ key: KEY, fetch: fakeMonid, sleep: async (ms) => void sleeps.push(ms), ...extra });
const sent = (from) => calls.slice(from).map((call) => `${call.method} ${call.path}`);

test("discover and inspect pass monid's answer through; one over 60,000 characters is cut, the whole filed under evidence/monid/", async (t) => {
  const work = await scratch(t);
  const found = await monid().discover({ query: "enrich a person", limit: 2 });
  assert.deepEqual([found.count, found.results[0].endpoint, found.results[0].price.amount.value], [2, "/person/enrich", 0.003]);
  const shown = await monid().inspect({ provider: "faux", endpoint: "/person/enrich" });
  assert.deepEqual(shown.input.body.required, ["name"]);
  assert.equal(await monidText(shown, localWorkspace(work), "inspect"), JSON.stringify(shown), "a short answer is its JSON, whole");
  const wide = await monid().discover({ query: "everything at once" });
  const text = await monidText(wide, localWorkspace(work), "discover");
  const where = /the whole answer is in the run's files at (evidence\/monid\/discover-[^\]\s]+\.json)\]$/.exec(text)?.[1];
  assert.ok(where, text.slice(-200));
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  assert.deepEqual(JSON.parse(await readFile(join(work, where), "utf8")), wide);
});

test("a run: a sync provider's output with its cost in dollars; an async one read until COMPLETED; each sent once", async () => {
  const now = await monid().run({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } });
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
  const charged = async (endpoint, extra = {}, signal) => chargeOf(await monid(extra).run({ provider: "faux", endpoint, input: { name: "Ada" } }, signal));
  assert.deepEqual(await Promise.all(["/person/enrich", "/tweets", "/missing"].map((endpoint) => charged(endpoint))), [0.003, 0.012, 0], "reported: a micro-dollar charge in dollars, a provider's error at $0");
  assert.deepEqual(await Promise.all(["/wallet", "/budget"].map((endpoint) => charged(endpoint))), [undefined, undefined], "refused as sent, or blocked: never ran");
  assert.equal(await charged("/person/enrich", { key: "not-a-secret" }), undefined, "a wrong key runs nothing");
  assert.deepEqual(await Promise.all(["/broken", "/late"].map((endpoint) => charged(endpoint))), [null, null], "FAILED and TIMED_OUT say no cost");
  assert.equal(await charged("/slow", {}, AbortSignal.abort()), null, "stopped by its caller: it may have used some");
  assert.equal(await charged("/person/enrich", { fetch: async () => { throw new Error("offline"); } }), null, "it may have gone ahead");
});

test("under a cap, a paid call is refused before it is sent unless the spend plus what it is held at fits, as a model request is; paid calls go one at a time; with no cap it runs", async (t) => {
  let spent = 1.5;
  const added = [];
  let sent = 0;
  const call = async () => (sent++, { status: "COMPLETED", cost: { value: 0.2, currency: "USD" } });
  const quoted = (usd) => ({ usd, basis: "the price monid_inspect quoted" });
  useSpend({ cap: 2, spent: () => spent, add: (usd) => void (added.push(usd), (spent += usd)) });
  t.after(() => useSpend(undefined));
  const refused = await paidCall("monid_run", call, chargeOf, quoted(0.7));
  assert.match(refused.refused, /^spend_cap_reached: Not sent: this run has spent \$1\.50 of its \$2 cap, and the next step, monid_run, could cost up to \$0\.70 \(the price monid_inspect quoted\)\. Raise the cap to at least \$2\.20 to continue\.$/);
  assert.equal(sent, 0, "refused, not sent");
  assert.deepEqual([(await paidCall("monid_run", call, chargeOf, quoted(0.4))).result?.status, sent, added], ["COMPLETED", 1, [0.2]], "0.4 fits: it runs");
  // Two at once: the first is checked (1.5 + 0.4), sent and charged (1.7) before the second is checked (1.7 + 0.4 > 2).
  spent = 1.5;
  const [first, second] = await Promise.all([paidCall("monid_run", call, chargeOf, quoted(0.4)), paidCall("monid_run", call, chargeOf, quoted(0.4))]);
  assert.deepEqual([first.result?.status, sent, typeof second.refused], ["COMPLETED", 2, "string"]);
  const allowance = await paidCall("monid_run", call, chargeOf, { usd: 1, basis: "no price was quoted for it in this run, so it counts at the $1 allowance; monid_inspect gives its price" });
  assert.match(allowance.refused, /counts at the \$1 allowance; monid_inspect gives its price/);
  spent = null;
  assert.match((await paidCall("monid_run", call, chargeOf, quoted(0))).refused, /What the run has spent is unknown, so its cap of \$2 cannot be kept/);
  assert.equal(sent, 2, "no refusal was sent");
  useSpend(undefined);
  assert.equal((await paidCall("monid_run", call, chargeOf, quoted(100))).result?.status, "COMPLETED", "with no cap, it runs");
});

test("another harness's paid-call check holds each model request still in flight at its worst case until its cost is booked", () => {
  const holds = holdsInFlight();
  holds.admitted(0.4);
  holds.started(1);
  holds.admitted(0.25);
  holds.started(2);
  assert.equal(holds.total(), 0.65);
  holds.ended(1);
  assert.equal(holds.total(), 0.25);
  holds.admitted(undefined);
  holds.started(3);
  holds.ended(2);
  assert.equal(holds.total(), 0, "one admitted with no figure (no cap) holds nothing");
});

/** The run's store entries of `kind`. */
const entriesOf = (data, runId, kind) => {
  // The run's process writes the store meanwhile: a read that finds it locked tries again.
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(String(row.record))).filter((entry) => kind === undefined || entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
};

test("a run whose monid call times out (TIMED_OUT, no cost said) books its charge unknown, and the cap counts the call at its hold: its next model request goes while the cap allows, the run's cost reads unknown, and a restarted process reads the hold too", { timeout: 90_000 }, async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("late", { harness: "claude-agent", instructions: "Run monid's /late on Ada.", tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  // No inspect quoted the endpoint: the call is held at the $1 allowance, which a $5 cap holds beside the requests.
  const run = await api("POST", "/agents/late/runs", { input: { content: "hi" }, max_cost_usd: 5 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const id = run.body.run_id;
  await follow(api, id, ["completed", "failed", "cancelled"], { deadlineMs: 55_000 });
  const ended = (await api("GET", `/runs/${id}`)).body;
  assert.deepEqual([ended.status, ended.error?.code ?? null, ended.result?.final_answer], ["completed", null, "Ran."], `the timed-out call counts at its $1 hold, never unknown: its next model request goes (${JSON.stringify(ended.error)})`);
  assert.deepEqual(entriesOf(data, id, "agentrun.tool_cost").map((entry) => entry.data.usd), [null], "TIMED_OUT says no cost: booked unknown, never $0");
  assert.equal(ended.cost.usd, null, "the run's cost reads unknown: the hold is the cap's bound, never a charge");
  // A restarted process starts from what the store says: the hold, so what fits goes and what does not is refused for room.
  const root = entriesOf(data, id);
  assert.equal(capToolSpend(root), 1, "another harness's reading, at its open: the $1 hold");
  const spent = spentIn(join(runDir(data, id), "store", "run.sqlite"));
  assert.ok(spent >= 1 && spent < 1.01, `pi's reading: the $1 hold and the requests, $${spent}`);
  t.after(() => useSpend(undefined));
  useSpend({ cap: 5, spent: () => capToolSpend(root), add: () => {} });
  assert.ok("result" in (await paidCall("monid_run", async () => ({}), chargeOf, { usd: 0.003, basis: "quoted" })), "a paid call that fits goes");
  useSpend({ cap: 1.002, spent: () => capToolSpend(root), add: () => {} });
  assert.match((await paidCall("monid_run", async () => ({}), chargeOf, { usd: 0.003, basis: "quoted" })).refused ?? "", /^spend_cap_reached: Not sent: this run has spent \$1 of its \$1\.002 cap, and the next step, monid_run, could cost up to \$0\.003 \(quoted\)\. Raise the cap to at least \$1\.01 to continue\.$/, "one that does not is refused for room");
  const guard = await capBefore(5, { id: "faux", api: "faux", provider: "faux", maxTokens: 10, contextWindow: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(guard.beforeRequest({ spentUsd: capToolSpend(root), inFlight: [], inputTokensMax: 1 }).outputTokensMax, 10, "and a model request that fits goes, at its whole output (#1539's clamp leaves it whole)");
});

test("a capped pi run stopped while its monid call is under way: monid is asked to stop it, the call counts at its hold, never unknown, and the next message's request goes while the cap allows; the run's cost reads unknown", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED, fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("halted", { tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  // No inspect quoted /slow: the call is held at the $1 allowance, which a $5 cap holds beside the next request's $1.64.
  const run = await api("POST", "/agents/halted/runs", { input: { content: "Run monid's /slow." }, max_cost_usd: 5 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const id = run.body.run_id;
  const logged = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line).path);
  const until = async (what, done) => {
    for (let i = 0; !done(await logged()); i++) {
      assert.ok(i < 400, what);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until("the monid call is sent", (paths) => paths.includes("/v1/run"));
  assert.equal((await api("POST", `/runs/${id}/stop`)).body.stopped, true);
  await until("monid is asked to stop the run", (paths) => paths.some((path) => /^\/v1\/runs\/[^/]+\/stop$/.test(path)));
  await follow(api, id, ["input_required"]);
  assert.equal((await api("POST", `/runs/${id}/messages`, { content: "go on" })).body.mode, "follow_up");
  await follow(api, id, ["completed", "failed", "cancelled"], { deadlineMs: 55_000 });
  const ended = (await api("GET", `/runs/${id}`)).body;
  assert.deepEqual([ended.status, ended.error?.code ?? null, ended.result?.final_answer], ["completed", null, "Ran."], `the stopped call counts at its $1 hold, never unknown: the next request goes (${JSON.stringify(ended.error)})`);
  assert.equal(ended.cost.usd, null, "what the stopped call charged no one knows: the run's cost reads unknown");
  // Its process gone, the store says the same: the hold, never unknown.
  const spent = spentIn(join(runDir(data, id), "store", "run.sqlite"));
  assert.ok(spent >= 1 && spent < 1.1, `a later process reads the $1 hold and the requests: $${spent}`);
});

test("/usage by meter during a monid run in flight: tokens are the run's model cost, and no tool charge is reported until the call settles", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname, fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("slow", { tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
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
  assert.deepEqual(meters, [["tokens", cost, 0]], "the model cost alone: never the held $1, never a negative token meter");
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

test("capabilities list the three, on every harness: missing MONID_API_KEY on a keyless server, available with it", async (t) => {
  assert.deepEqual(NAMES.map(wireName), ["monid_discover", "monid_inspect", "monid_run"], "the names pi registers");
  withEnv(t, {}, ["MONID_API_KEY"]);
  const listed = async () => (await client((await serve(t)).baseUrl)("GET", "/capabilities")).body.tools.filter((tool) => NAMES.includes(tool.name));
  assert.deepEqual((await listed()).map((tool) => [tool.name, tool.available, tool.missing, tool.nodes, tool.calls, tool.harnesses]), NAMES.map((name) => [name, false, ["MONID_API_KEY"], false, false, ["pi", "claude-agent", "codex", "opencode"]]));
  process.env.MONID_API_KEY = KEY;
  assert.deepEqual((await listed()).map((tool) => [tool.name, tool.available, tool.missing]), NAMES.map((name) => [name, true, undefined]));
});

test("a revision naming the three saves with a warning on a keyless server and its run is 409, on pi and claude-agent alike; with the key the claude-agent one runs", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("finder", { tools: NAMES }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), NAMES.map((_, i) => [`definition.tools[${i}]`, "not_set_up_here"]));
  const run = await api("POST", "/agents/finder/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code, run.body.error.details.missing], [409, "agent_not_runnable", Object.fromEntries(NAMES.map((name) => [name, ["MONID_API_KEY"]]))]);
  const claude = agent("finder-claude", { harness: "claude-agent", instructions: "Run monid's /person/enrich on Ada.", tools: ["read", "monid.run"], tool_settings: ALLOWED });
  const keyless = await api("POST", "/agents", claude);
  assert.equal(keyless.status, 201, JSON.stringify(keyless.body));
  assert.deepEqual(keyless.body.warnings.map((w) => [w.field, w.message]), [["definition.tools[1]", "The tool monid.run needs a Monid key: save one in Settings → Tool keys (or set MONID_API_KEY where the server starts)."]], "the key, never that it runs on pi only");
  const refused = await api("POST", "/agents/finder-claude/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.details.unbound, refused.body.error.details.missing], [409, [], { "monid.run": ["MONID_API_KEY"] }]);
  // A server reads its environment as it starts: the next one has the key.
  process.env.MONID_API_KEY = KEY;
  const keyed = (await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID })).api;
  assert.deepEqual([(await keyed("POST", "/agents", claude)).body.warnings], [[]]);
  const ran = await keyed("POST", "/agents/finder-claude/runs", { input: { content: "hi" } });
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  const { rows } = await follow(keyed, ran.body.run_id, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_status), ["success"], "monid_run ran on claude-agent");
});

test("a pi run's model finds, reads and runs a monid endpoint through monid_discover, monid_inspect and monid_run, on the key from its pipe", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, data } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("enricher", { tools: NAMES, tool_settings: ALLOWED }));
  assert.deepEqual([saved.status, saved.body.warnings], [201, []]);
  const started = await api("POST", "/agents/enricher/runs", { input: { content: "Enrich with monid: Ada at Example." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /^Ran: \{.*"full_name":"Ada".*"cost":\{"value":0\.003,"currency":"USD"\}/);
  const seen = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(seen.map((call) => [call.method, call.path, call.authorized]), [["POST", "/v1/discover", true], ["POST", "/v1/inspect", true], ["POST", "/v1/run", true]]);
  assert.ok(seen.every((call) => call.pid !== process.pid), "each from the run's process");
  // The timeline names each call by the name pi registered, the wire name: mapping it back to the catalog name is later work.
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  assert.deepEqual(rows.filter((row) => row.kind === "tool_use").map((row) => row.tool_name), ["monid_discover", "monid_inspect", "monid_run"]);
  assert.deepEqual(rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_status), ["success", "success", "success"]);
  // The run's charge is booked once, on a line of its own, and is the run's cost: the faux model is $0.
  assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.tool_name === "monid.run").map((row) => [row.summary, typeof row.tool_use_id]), [["Tool cost: monid charged $0.0030 for monid.run", "string"]]);
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.cost.usd, 0.003);
  // Marked before it was sent at the price its inspect quoted, then settled by its charge.
  const db = new DatabaseSync(join(runDir(data, started.body.run_id), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  const paid = db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind.startsWith("agentrun.tool_"));
  db.close();
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.data.heldUsd ?? entry.data.usd]), [["agentrun.tool_started", 0.003], ["agentrun.tool_cost", 0.003]]);
});

test("a pi run cancelled while its monid.run is under way still settles the call, at monid's unknown charge for a stopped run", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, data } = await serve(t, { fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("stopped-monid", { tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  const run = await api("POST", "/agents/stopped-monid/runs", { input: { content: "Run monid's /slow." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const id = run.body.run_id;
  for (const end = Date.now() + 30_000; !(await readFile(log, "utf8").catch(() => "")).includes('"path":"/v1/run"'); ) {
    assert.ok(Date.now() < end, "the monid call was sent");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok((await api("POST", `/runs/${id}/cancel`, {})).status < 300);
  await follow(api, id, ["cancelled", "failed", "completed"], { deadlineMs: 60_000 });
  let settled = [];
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
    settled = entriesOf(data, id, "agentrun.tool_cost");
    if (settled.length) break;
  }
  assert.equal(entriesOf(data, id, "agentrun.tool_started").length, 1, "marked before it was sent");
  // Settled at monid's rule for a run its caller stopped: it may have used some, so its charge is unknown (null), never $0.
  // The run's cost then reads unknown by that rule (#1377), not for a mark left open.
  assert.deepEqual(settled.map((entry) => [entry.data.tool, entry.data.usd]), [["monid.run", null]], "settled though its turn was stopped");
});
