// serve's web tools with Jev: where the run's process holds TypeSafe's key as it was handed (the claim's own environment
// here, as the runner hands it), web_search's results are ranked by Jev on jev-1.14.0 under rerank+label, each request
// booked on the run's ledger at the cost Jev reported, never above its hold. No TypeSafe key (an OpenRouter one alone,
// or one only in this process's environment), or AGENTRUN_WEB_JEV_OFF=1, and there is no decider. A failing Jev leaves
// the results unsifted; a fetch (no objective) is never judged and its page is whole. The runner hands the key only to
// a run whose web tools run, on TypeSafe's route, with Jev not off; capabilities' why says which. Jev is the fake
// (fixtures/faux-jev-web.mjs over faux-jev.mjs), Parallel too; nothing leaves the machine. The key is the fake's canary,
// and the test checks it is in no log line, answer, filed call or argv.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY as JEV_KEY } from "./fixtures/faux-jev-web.mjs";
import { CANARY as PARALLEL_KEY } from "./fixtures/faux-parallel.mjs";
import { paidBookings, toolLedger } from "./support.mjs";

const { searchFor, webSearchTool } = await import("../dist/web-search.js");
const { webFetchTool } = await import("../dist/web-fetch.js");
const { webOf } = await import("../dist/web-run.js");
const { handsJevWeb, explainsView, planeFor, recheckPlane, TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { decisionKeysFor } = await import("../dist/decisions.js");
const { bookedIn } = await import("../dist/paid-calls.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { putSealedKey } = await import("../dist/server-keys.js");

const FAUX_JEV = new URL("./fixtures/faux-jev-web.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const ON = "Jev (jev-1.14.0) ranks results against the objective, or the query when none is given; each search sends that and each result's URL, title, snippet and published date to TypeSafe, billed per request on the server's TypeSafe key";
/** What capabilities' why adds for a web_fetch the run's own Web serves, where Jev runs on TypeSafe's key. */
const FETCH_ON = "a fetch given an objective sends the page's text and the objective to TypeSafe for Jev (jev-1.14.0) to pick its chunks, billed per request on the server's TypeSafe key; a fetch with none sends TypeSafe nothing";

/** A claim's tool environment as the runner hands it: Parallel's key and a plane resolving both web tools to Parallel,
 *  under --faux, with `more` laid over (TypeSafe's key, the off switch). */
const claimEnv = (more = {}) => ({
  AGENTRUN_SERVE_FAUX: "1",
  AGENTRUN_SERVE_FAUX_PARALLEL: FAUX_PARALLEL,
  AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV,
  AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB,
  PARALLEL_API_KEY: PARALLEL_KEY,
  [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "parallel" }),
  ...more,
});

/** `name` set to `value` in this process's environment for the test (deleted when undefined), as it was after. */
function processEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => (before === undefined ? delete process.env[name] : (process.env[name] = before)));
}

/** The Jev requests the fake was sent in this test, as faux-jev-web.mjs files them, and the file's raw text. */
function jevCalls(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-jev-"));
  const file = join(dir, "calls.ndjson");
  writeFileSync(file, "");
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_WEB_CALLS", file);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = () => readFileSync(file, "utf8");
  return Object.assign(() => raw().split("\n").filter(Boolean).map((line) => JSON.parse(line)), { raw });
}

/** What the server writes to stderr while `fn` runs, and what `fn` gave. */
async function withStderr(t, fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  t.after(() => (process.stderr.write = write));
  try {
    return { got: await fn(), lines: lines.join("").split("\n").filter(Boolean) };
  } finally {
    process.stderr.write = write;
  }
}

/** `fn` inside a call on a fresh run ledger (paid-calls.ts), the ledger's paid rows after, and each hold it admitted. */
async function onLedger(fn) {
  const ledger = await toolLedger();
  const holds = [];
  const paid = { admit: (request) => (holds.push(request), ledger.admit(request)), settle: (id, usd, options) => ledger.settle(id, usd, options) };
  const got = await bookedIn({ call: "test-call", paid }, fn);
  return { got, rows: paidBookings(await ledger.records()), holds };
}

const search = (env) => searchFor(env, { query: "widgets delaware", n: 4 });

test("with TypeSafe's key handed, web_search's results are ranked by Jev on jev-1.14.0 under rerank+label, and the key is in no log, answer, filed call or argv", async (t) => {
  const calls = jevCalls(t);
  const env = claimEnv({ TYPESAFE_API_KEY: JEV_KEY });
  const { got, lines } = await withStderr(t, () => onLedger(() => search(env)));
  const found = got.got;
  assert.equal(found.error, undefined, `the search ran: ${JSON.stringify(found)}`);
  assert.match(found.sift ?? "", /^jev ordered \d+ results by relevance/, `Jev reranked the results (rerank+label): sift ${JSON.stringify(found.sift)}`);
  assert.ok(found.results.length > 0 && found.results.every((r) => typeof r.relevance === "number"), "every result is kept, each with its relevance");
  const sent = calls();
  assert.ok(sent.length >= 1, "Jev was asked");
  assert.deepEqual([...new Set(sent.map((c) => c.model))], ["jev-1.14.0"], "every Jev request's wire body names jev-1.14.0");
  assert.ok(sent.every((c) => c.authorized), "each carried the handed key");
  const start = lines.filter((line) => line.includes("event=web_destinations"));
  assert.equal(start.length, 1, lines.join("\n"));
  assert.match(start[0], / classifier="jev jev-1\.14\.0 rerank\+label"$/, "the start line names the classifier");
  for (const [where, text] of [["the server's log", lines.join("\n")], ["the answer", JSON.stringify(found)], ["the filed calls", calls.raw()], ["the ledger", JSON.stringify(got.rows)], ["argv", process.argv.join(" ")]]) {
    assert.ok(!text.includes(JEV_KEY), `the key is in ${where}`);
  }
});

test("web_search's objective is what Jev ranks against: the call's objective in, each sift request's query out, its keyword queries not", async (t) => {
  const calls = jevCalls(t);
  const objective = "Which state is Widgets, Inc. incorporated in, and in what year?";
  const queries = ["widgets inc delaware", "widgets incorporation year"];
  const { got: found } = await onLedger(() => searchFor(claimEnv({ TYPESAFE_API_KEY: JEV_KEY }), { objective, queries, n: 4 }));
  assert.equal(found.error, undefined, `the search ran on its objective and queries: ${JSON.stringify(found).slice(0, 300)}`);
  assert.match(found.sift ?? "", /^jev ordered \d+ results by relevance/, `Jev reranked the results: sift ${JSON.stringify(found.sift)}`);
  const sent = calls();
  assert.ok(sent.length >= 1, "Jev was asked");
  assert.deepEqual([...new Set(sent.map((c) => c.query))], [objective], "Jev ranked the results against the objective, not a keyword query");
  assert.deepEqual([...new Set(sent.map((c) => c.task))], [null], "no task given: the objective is the whole need");
});

test("Jev's requests are booked on the run's ledger at the cost Jev reported, under their hold; at the hold when it reports none", async (t) => {
  jevCalls(t);
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_COST", "0.000001");
  const reported = await onLedger(() => search(claimEnv({ TYPESAFE_API_KEY: JEV_KEY })));
  const jev = ({ rows, holds }) => ({ charges: rows.filter((row) => row.charged_by === "jev" && row.kind === "agentrun.tool_cost"), holds: holds.filter((hold) => hold.chargedBy === "jev") });
  const got = jev(reported);
  assert.equal(got.holds.length, 1, `one Jev request was held on the ledger: ${JSON.stringify(reported.holds)}`);
  assert.equal(got.charges.length, 1, `and charged: ${JSON.stringify(reported.rows)}`);
  assert.ok(got.holds[0].holdUsd > 0.000001, `the hold (${got.holds[0].holdUsd}) is above the reported cost`);
  assert.equal(got.charges[0].usd, 0.000001, "the ledger row is the cost Jev reported, not the hold");

  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_COST", undefined);
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_NO_USAGE", "1");
  const none = jev(await onLedger(() => search(claimEnv({ TYPESAFE_API_KEY: JEV_KEY }))));
  assert.equal(none.charges.length, 1, "the request with no cost is charged");
  assert.equal(none.charges[0].usd, none.holds[0].holdUsd, "no cost reported: the row is the hold");
});

test("a Jev request's receipt line is its ledger row: the cost Jev reported below the hold, one figure in both", async (t) => {
  jevCalls(t);
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_COST", "0.000002");
  const { got, rows, holds } = await onLedger(() => webOf(claimEnv({ TYPESAFE_API_KEY: JEV_KEY })).search("widgets delaware", { n: 4 }));
  const lines = got.receipt.cost.lines.filter((line) => line.by === "jev");
  const charges = rows.filter((row) => row.charged_by === "jev" && row.kind === "agentrun.tool_cost");
  const held = holds.filter((hold) => hold.chargedBy === "jev");
  assert.equal(lines.length, 1, `one Jev line on the receipt: ${JSON.stringify(got.receipt.cost.lines)}`);
  assert.equal(charges.length, 1, `one Jev row on the ledger: ${JSON.stringify(rows)}`);
  assert.ok(held[0].holdUsd > 0.000002, `the hold (${held[0].holdUsd}) is above the reported cost`);
  assert.equal(charges[0].usd, 0.000002, "the ledger row is the cost Jev reported");
  assert.equal(lines[0].usd, charges[0].usd, `the receipt says what the ledger booked, not the hold: ${JSON.stringify(lines[0])}`);
  assert.equal(lines[0].basis, "the cost jev reported");
});

test("a Jev request whose settle fails: the ledger keeps its hold, and so does its receipt line, its basis quoting the cost Jev reported", async (t) => {
  jevCalls(t);
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_COST", "0.000002");
  const ledger = await toolLedger(1);
  const jev = [];
  const paid = {
    admit: (request) => (request.chargedBy === "jev" && jev.push(request), ledger.admit(request)),
    settle: (id, usd, options) => (jev.some((hold) => hold.id === id) ? Promise.reject(new Error("the ledger is down")) : ledger.settle(id, usd, options)),
  };
  const got = await bookedIn({ call: "test-call", paid }, () => webOf(claimEnv({ TYPESAFE_API_KEY: JEV_KEY })).search("widgets delaware", { n: 4 }));
  const rows = paidBookings(await ledger.records());
  const lines = got.receipt.cost.lines.filter((line) => line.by === "jev");
  assert.equal(lines.length, 1, `one Jev line on the receipt: ${JSON.stringify(got.receipt.cost.lines)}`);
  assert.equal(jev.length, 1, "one Jev request held");
  assert.ok(jev[0].holdUsd > 0.000002, `the hold (${jev[0].holdUsd}) is above the reported cost`);
  assert.deepEqual(rows.filter((row) => row.charged_by === "jev" && row.kind === "agentrun.tool_cost"), [], "no settle landed: no Jev charge row");
  assert.equal(ledger.heldUsd(), jev[0].holdUsd, "the ledger keeps the Jev hold, and only it");
  assert.deepEqual(rows.filter((row) => row.charged_by === "jev").map((row) => row.heldUsd), [jev[0].holdUsd], "its one ledger row is the hold");
  assert.equal(lines[0].usd, ledger.heldUsd(), `the receipt says what the ledger booked, the hold: ${JSON.stringify(lines[0])}`);
  assert.match(lines[0].basis, /settle failed/, "the basis says the settle failed");
  assert.match(lines[0].basis, /\$0\.000002 \(the cost jev reported\)/, "and quotes the cost Jev reported");
});

test("no decider without TypeSafe's key: an OpenRouter key alone, a key only in this process's environment, or AGENTRUN_WEB_JEV_OFF=1", async (t) => {
  const calls = jevCalls(t);
  const plain = (await onLedger(() => search(claimEnv()))).got;
  assert.equal(plain.sift, undefined, "no key: no sift line");
  const routed = (await onLedger(() => search(claimEnv({ OPENROUTER_API_KEY: JEV_KEY })))).got;
  assert.equal(routed.sift, undefined, "an OpenRouter key gives no web decider");
  const off = (await onLedger(() => search(claimEnv({ TYPESAFE_API_KEY: JEV_KEY, AGENTRUN_WEB_JEV_OFF: "1" })))).got;
  assert.equal(off.sift, undefined, "AGENTRUN_WEB_JEV_OFF=1: no decider, whatever key is handed");
  processEnv(t, "TYPESAFE_API_KEY", JEV_KEY);
  const ambient = (await onLedger(() => search(claimEnv()))).got;
  assert.equal(ambient.sift, undefined, "a key in this process's environment, not the one the run was handed, gives no decider");
  assert.deepEqual(plain.results.map((r) => r.url), ambient.results.map((r) => r.url));
  assert.deepEqual(calls(), [], "Jev was never asked");
});

test("a failing Jev leaves the results unsifted, as without it; a fetch with no objective is never judged, its page whole and with no sift field", async (t) => {
  const calls = jevCalls(t);
  const without = (await onLedger(() => search(claimEnv()))).got;
  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_STATUS", "503");
  const failing = (await onLedger(() => search(claimEnv({ TYPESAFE_API_KEY: JEV_KEY })))).got;
  assert.match(failing.sift ?? "", /^not run \(.+\); these results are unsifted$/, `the sift says why not: ${JSON.stringify(failing.sift)}`);
  assert.deepEqual(failing.results, without.results, "the results are the provider's, whole and in its order");
  assert.ok(calls().length >= 1, "Jev was asked, and failed");

  processEnv(t, "AGENTRUN_TEST_FAUX_JEV_STATUS", undefined);
  const before = calls().length;
  const read = async (env) => (await onLedger(async () => (await webFetchTool(env).execute({ url: "http://public.example/notes.txt" }, {}, {})).details)).got;
  const plain = await read(claimEnv());
  const judged = await read(claimEnv({ TYPESAFE_API_KEY: JEV_KEY }));
  assert.equal(plain.ok, true, `the page was read: ${JSON.stringify(plain)}`);
  assert.equal(judged.text, plain.text, "the page is whole");
  assert.equal(Object.hasOwn(judged, "sift"), false, `no sift field on a fetch Jev never judged: ${JSON.stringify(judged.sift)}`);
  assert.equal(calls().length, before, "a fetch with no objective asks Jev nothing");
});

test("the runner hands TypeSafe's key for web tools that run, on TypeSafe's route, unless Jev is off", () => {
  const server = { TYPESAFE_API_KEY: JEV_KEY };
  const keys = (env, plane) => Object.keys(decisionKeysFor(env, { providers: [], parallelWeb: false, jevWeb: handsJevWeb(plane, env) }));
  assert.deepEqual(keys(server, { web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" }), ["TYPESAFE_API_KEY"], "a run whose web tools run gets TypeSafe's key");
  assert.deepEqual(keys(server, { web_fetch: "kernel" }), ["TYPESAFE_API_KEY"], "a web_fetch that runs is enough");
  assert.deepEqual(keys(server, {}), [], "a run with no web tool gets none");
  assert.deepEqual(keys(server, { web_search: "unavailable: turned off" }), [], "web_search off: none");
  assert.deepEqual(keys({ ...server, AGENTRUN_WEB_JEV_OFF: "1" }, { web_search: "parallel" }), [], "AGENTRUN_WEB_JEV_OFF=1: none");
  assert.deepEqual(keys({ OPENROUTER_API_KEY: JEV_KEY }, { web_search: "parallel" }), [], "an OpenRouter key is never handed for the web tools");
});

test("a claim whose web tools run is handed the runner's TypeSafe key in its own environment; none with AGENTRUN_WEB_JEV_OFF=1 or no web tool", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-jev-claim-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const seal = randomBytes(32);
  await putSealedKey(store, seal, "TYPESAFE_API_KEY", JEV_KEY);
  const claim = (env, tools, plane) => claimSecrets({ store, sealKey: seal, env, redact: { carry() {} } }, { kind: "agentic", body: { tools } }, { plane });
  const web = { web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" };
  // Compared, never printed: a failing assert shows only whether the key was handed, not the key.
  const handed = (env) => (env.TYPESAFE_API_KEY === undefined ? "none" : env.TYPESAFE_API_KEY === JEV_KEY ? "the key" : "another value");
  assert.equal(handed(await claim({}, ["web_search", "web_fetch"], web)), "the key", "a run whose web tools run gets the key, as Parallel's is handed");
  assert.equal(handed(await claim({ AGENTRUN_WEB_JEV_OFF: "1" }, ["web_search", "web_fetch"], web)), "none", "Jev off: no key");
  assert.equal(handed(await claim({}, ["read"], {})), "none", "no web tool: no key");
});

/** A claim store holding TypeSafe's key sealed, and a claim of a revision on `harness` with `tools` on `plane`: whether
 *  its environment was handed the key ("the key"), compared and never printed. */
async function nativeClaims(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-jev-native-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const seal = randomBytes(32);
  await putSealedKey(store, seal, "TYPESAFE_API_KEY", JEV_KEY);
  return async (harness, tools, plane) => {
    const env = await claimSecrets({ store, sealKey: seal, env: {}, redact: { carry() {} } }, { kind: "agentic", body: { harness, tools } }, { plane });
    return env.TYPESAFE_API_KEY === undefined ? "none" : env.TYPESAFE_API_KEY === JEV_KEY ? "the key" : "another value";
  };
}

test("a codex run on its own (native) search with web_fetch is handed TypeSafe's key, for the fetch", async (t) => {
  const claim = await nativeClaims(t);
  assert.equal(await claim("codex", ["web_search", "web_fetch"], { web_search: "native", web_fetch: "firecrawl-keyless" }), "the key", "web_fetch is always the run's own, so Jev may run on it");
});

test("a codex run on its own (native) search with no web_fetch is not handed TypeSafe's key: no Jev call can happen", async (t) => {
  const claim = await nativeClaims(t);
  assert.equal(await claim("codex", ["web_search"], { web_search: "native" }), "none", "codex native search runs inside the CLI, so no key for it");
});

test("a pi run on native search is handed TypeSafe's key: its hosted search goes through the run's own web_search", async (t) => {
  const claim = await nativeClaims(t);
  assert.equal(await claim("pi", ["web_search"], { web_search: "native" }), "the key", "pi native search is ours, ranked by Jev");
});

test("a codex run on auto with web_search alone is handed TypeSafe's key: auto is the run's own search on every harness", async (t) => {
  const claim = await nativeClaims(t);
  // The plane the server resolves for the run at launch, on a server whose codex has its own search (OpenAI's key).
  const plane = planeFor({ OPENAI_API_KEY: "not-a-secret" }, { harness: "codex", tools: ["web_search"] }, {});
  assert.notEqual(plane.web_search, "native", `auto resolves to the run's own search on codex, not Codex's: ${JSON.stringify(plane)}`);
  assert.equal(await claim("codex", ["web_search"], plane), "the key", "the run's own web_search is ranked by Jev, so its key is handed");
});

test("Jev off on the server holds on a runner host without the switch: the run's plane carries it, so no key is handed and its Web has no decider", async (t) => {
  const calls = jevCalls(t);
  const claim = await nativeClaims(t);
  const tooling = { harness: "pi", tools: ["web_search", "web_fetch"] };
  // The plane the server resolves at launch under its own switch; the runner host that claims the run has none.
  const server = { AGENTRUN_WEB_JEV_OFF: "1", PARALLEL_API_KEY: PARALLEL_KEY };
  const plane = planeFor(server, tooling, {});
  assert.equal(plane.jev, "off", `the server's plane says Jev is off: ${JSON.stringify(plane)}`);
  assert.equal(await claim("pi", tooling.tools, plane), "none", "a runner host with no switch of its own hands no TypeSafe key on a plane that says Jev is off");
  const toolEnv = claimEnv({ TYPESAFE_API_KEY: JEV_KEY, [TOOL_PLANE_ENV]: JSON.stringify({ ...plane, web_search: "parallel", web_fetch: "parallel" }) });
  const found = (await onLedger(() => search(toolEnv))).got;
  assert.equal(found.sift, undefined, "a run handed the key anyway still has no decider: its plane says Jev is off");
  assert.deepEqual(calls(), [], "Jev was never asked");
});

test("a run's kept Jev off holds when its runner checks the plane again: a runner without the switch keeps it, one with it adds it", () => {
  const kept = { web_search: "parallel", web_fetch: "parallel", jev: "off" };
  const runner = { PARALLEL_API_KEY: PARALLEL_KEY };
  assert.equal(recheckPlane(kept, runner).jev, "off", `a runner host with no switch of its own keeps the server's Jev off: ${JSON.stringify(recheckPlane(kept, runner))}`);
  assert.equal(recheckPlane({ web_search: "parallel" }, { ...runner, AGENTRUN_WEB_JEV_OFF: "1" }).jev, "off", "a runner's own switch adds Jev off");
  assert.equal(recheckPlane({ web_search: "parallel" }, runner).jev, undefined, "neither the plane nor the runner turns it off: Jev stays on");
});

test("capabilities' why says what Jev does with web_search: on with TypeSafe's key, off with an OpenRouter key alone or AGENTRUN_WEB_JEV_OFF; nothing with no key", () => {
  const why = (env) => explainsView(env, {}).web_search.why;
  const resolves = explainsView({}, {}).web_search.resolves;
  const ours = Object.keys(resolves).find((harness) => resolves[harness] === "firecrawl-keyless");
  assert.ok(ours, `a harness whose web_search is the run's own: ${JSON.stringify(resolves)}`);
  assert.ok(why({ TYPESAFE_API_KEY: JEV_KEY })[ours].endsWith(`; ${ON}`), why({ TYPESAFE_API_KEY: JEV_KEY })[ours]);
  assert.ok(why({ OPENROUTER_API_KEY: JEV_KEY })[ours].endsWith("; Jev off: no TypeSafe key"), why({ OPENROUTER_API_KEY: JEV_KEY })[ours]);
  assert.ok(why({ TYPESAFE_API_KEY: JEV_KEY, AGENTRUN_WEB_JEV_OFF: "1" })[ours].endsWith("; Jev off (AGENTRUN_WEB_JEV_OFF)"));
  assert.doesNotMatch(why({})[ours], /Jev/, "no key: the why is as it was");
  assert.ok(!JSON.stringify(explainsView({ TYPESAFE_API_KEY: JEV_KEY }, {})).includes(JEV_KEY), "the key is in no why");
});

test("capabilities' why for web_fetch says what goes to TypeSafe where Jev picks its chunks: the page's text and the objective; off, or with no TypeSafe key, it claims none", () => {
  const why = (env, settings = {}) => explainsView(env, settings).web_fetch.why;
  const harnesses = Object.keys(why({}));
  assert.ok(harnesses.length > 0, "capabilities lists harnesses");
  for (const harness of harnesses) {
    const on = why({ TYPESAFE_API_KEY: JEV_KEY })[harness];
    assert.ok(on.endsWith(`; ${FETCH_ON}`), `${harness}: a server holding TypeSafe's key says web_fetch sends the page's text and the objective to TypeSafe: ${on}`);
    const keyed = why({ TYPESAFE_API_KEY: JEV_KEY, PARALLEL_API_KEY: PARALLEL_KEY })[harness];
    assert.ok(keyed.startsWith("Parallel's extract") && keyed.endsWith(`; ${FETCH_ON}`), `${harness}: Parallel first, and the same TypeSafe clause: ${keyed}`);
    const off = why({ TYPESAFE_API_KEY: JEV_KEY, AGENTRUN_WEB_JEV_OFF: "1" })[harness];
    assert.ok(off.endsWith("; Jev off (AGENTRUN_WEB_JEV_OFF)") && !/TypeSafe for Jev|sends the page/.test(off), `${harness}: Jev off claims nothing goes to TypeSafe: ${off}`);
    const openRouter = why({ OPENROUTER_API_KEY: JEV_KEY })[harness];
    assert.ok(openRouter.endsWith("; Jev off: no TypeSafe key") && !/sends the page/.test(openRouter), `${harness}: an OpenRouter key alone: no web Jev: ${openRouter}`);
    assert.doesNotMatch(why({})[harness], /Jev|TypeSafe/, `${harness}: no key: the why is as it was`);
    assert.doesNotMatch(why({ TYPESAFE_API_KEY: JEV_KEY }, { web_fetch: { permission: "deny" } })[harness], /TypeSafe/, `${harness}: a denied web_fetch sends nothing, and says nothing of Jev`);
  }
});

test("web_search's description says a result may carry relevance and a sift line says how the results were ranked, naming no provider", () => {
  const { description } = webSearchTool(claimEnv());
  assert.match(description, /Each result may carry relevance \(0 to 1\), how likely it holds what the search asks for, and a sift line says how the results were ranked, or why not\./);
  assert.doesNotMatch(description, /Jev|TypeSafe/);
});

// A Jev that refuses the run's key (401) or its account (402) books nothing and is held for the rest of the run: the
// run's later searches and fetches send it nothing, their sift saying it is held. An outage (5xx) is booked at the hold
// and asked again (the failing-Jev test above).
for (const [status, code] of [["401", "auth"], ["402", "payment_required"]]) {
  test(`a Jev that answers ${status} books $0 (${code}) and is held for the rest of the run: a later search or fetch sends it nothing`, async (t) => {
    const calls = jevCalls(t);
    processEnv(t, "AGENTRUN_TEST_FAUX_JEV_STATUS", status);
    const env = claimEnv({ TYPESAFE_API_KEY: JEV_KEY });
    const first = await onLedger(() => webOf(env).search("widgets delaware", { n: 4 }));
    const asked = calls().length;
    assert.ok(asked >= 1, "Jev was asked, and refused");
    assert.equal(first.got.answer.sift, `not run (${code}); these results are unsifted`);
    const lines = first.got.receipt.cost.lines.filter((line) => line.by === "jev");
    const charges = first.rows.filter((row) => row.charged_by === "jev" && row.kind === "agentrun.tool_cost");
    assert.equal(lines.length, asked, `a line for each Jev request: ${JSON.stringify(first.got.receipt.cost.lines)}`);
    assert.deepEqual(lines.map(({ usd, basis }) => ({ usd, basis })), lines.map(() => ({ usd: 0, basis: `not billed (${code})` })), "each refused request is $0 on the receipt");
    assert.deepEqual(charges.map((row) => row.usd), lines.map(() => 0), `and $0 on the ledger: ${JSON.stringify(first.rows)}`);

    const second = await onLedger(() => webOf(env).search("widgets delaware", { n: 4 }));
    assert.equal(calls().length, asked, "the run's next search sends Jev nothing");
    assert.equal(second.got.answer.sift, "not run (held); these results are unsifted");
    assert.deepEqual(second.got.receipt.cost.lines.filter((line) => line.by === "jev"), [], "no Jev line");
    assert.deepEqual(second.rows.filter((row) => row.charged_by === "jev"), [], "nothing held or booked for Jev");
    assert.equal(second.got.receipt.classifier.requests, 0, "the record says no request was sent");

    const read = await onLedger(async () => (await webFetchTool(env).execute({ url: "http://public.example/notes.txt", objective: "where widgets are incorporated" }, {}, {})).details);
    assert.equal(calls().length, asked, "nor does its next fetch with an objective");
    assert.equal(read.got.sift, "objective not applied (held); this part is in page order", "the fetch's sift says Jev is held, in a fetch's words");
    assert.deepEqual(read.rows.filter((row) => row.charged_by === "jev"), [], "nothing held or booked for Jev");
  });
}
