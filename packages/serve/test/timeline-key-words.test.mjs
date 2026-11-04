// A run's error reads the same on its Timeline row as in its error box: a provider's refusal of the run's key in plain
// words (key-refusal.ts), and never serve's own loopback proxy address, which Codex names at the end of its errors
// ("…, url: http://127.0.0.1:<port>/v1/responses"). Round-2 QA (2026-11-04) found the box in plain words and the row
// still the harness's raw text. claude-agent and codex run on the faux harness, failing with what the pinned CLI and
// Codex binary said for OpenRouter's 401; pi runs for real against a loopback gateway that answers 401.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, answerFlow, flowAgent, follow, serve, withEnv } from "./support.mjs";
import { withoutLoopback } from "../dist/key-refusal.js";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const KEY = `not-a-secret-${"openrouter-key"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const OPENROUTER = "OpenRouter refused OPENROUTER_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys.";
const LOOPBACK = "http://127.0.0.1:39543/v1/responses";
/** What each harness passed on for OpenRouter's 401, as the QA run saw it once its adapter named it ("claude-agent: …",
 *  "codex: …"; the adapter adds that name, so the faux turn fails with the rest). Codex's ends on serve's proxy. */
const SAID = {
  "claude-agent": "Failed to authenticate. API Error: 401 User not found.",
  codex: `unexpected status 401 Unauthorized: User not found., url: ${LOOPBACK}`,
};

const errorRows = (rows) => rows.filter((r) => r.kind === "error");

async function failedRun(t, api, harness, said) {
  assert.equal((await api("POST", "/agents", agent(`fails-${harness}`, { harness, instructions: `Fail with: ${said}` }))).status, 201);
  const started = await api("POST", `/agents/fails-${harness}/runs`, { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  return { run, timeline };
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness} on OpenRouter's key alone: a refused key's Timeline row says what the run's error says, in plain words`, { timeout: 60_000 }, async (t) => {
    withEnv(t, { OPENROUTER_API_KEY: KEY }, NAMES);
    const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
    const { run, timeline } = await failedRun(t, api, harness, SAID[harness]);
    assert.equal(run.error?.message, OPENROUTER, JSON.stringify(run.error));
    const rows = errorRows(timeline.rows);
    assert.ok(rows.length > 0, JSON.stringify(timeline.rows.map((r) => r.kind)));
    for (const row of rows) assert.deepEqual([row.summary, row.text], [OPENROUTER, OPENROUTER], JSON.stringify(row));
    assert.ok(!JSON.stringify(timeline).includes("127.0.0.1") && !JSON.stringify(run).includes("127.0.0.1"), "no loopback address anywhere");
  });
}

test("codex: an error that is no refused key keeps its words, without serve's loopback proxy address, on the Timeline and in the run's error", { timeout: 60_000 }, async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: KEY }, NAMES);
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const { run, timeline } = await failedRun(t, api, "codex", `unexpected status 500 Internal Server Error: upstream broke, url: ${LOOPBACK}`);
  const said = "codex: unexpected status 500 Internal Server Error: upstream broke";
  assert.equal(run.error?.message, said, JSON.stringify(run.error));
  const rows = errorRows(timeline.rows);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(row.text === said && row.summary.endsWith(said), JSON.stringify(row));
  assert.ok(!JSON.stringify(timeline).includes("127.0.0.1"), "no loopback address on the Timeline");
});

test("pi: a gateway that refuses its key (401): the Timeline row says what the run's error says", { timeout: 60_000 }, async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "User not found", code: 401 } })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  withEnv(t, { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/api`, AGENT_MODEL: "openai/gpt-6-sol", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,2,0.5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("refused"))).status, 201);
  const started = await api("POST", "/agents/refused/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  const words = "The gateway at AGENT_MODEL_BASE_URL refused AGENT_MODEL_API_KEY (401: User not found): set it where AgentRun starts.";
  assert.equal(run.error?.message, words, JSON.stringify(run.error));
  const rows = errorRows(timeline.rows);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.deepEqual([row.summary, row.text], [words, words], JSON.stringify(row));
  assert.ok(!JSON.stringify(timeline).includes(KEY), "the key is nowhere on the Timeline");
});

// A workflow's nodes run on their own tiers' models, and an error row does not say which one failed. With the default
// tier on OpenAI and the strong tier on Anthropic, a strong node's 401 must not read as OpenAI refusing OPENAI_API_KEY:
// the row keeps the provider's own words (no loopback address) rather than name a key that may be the wrong one.
test("a workflow whose tiers send different keys: a node's 401 keeps its own words on the Timeline, never another tier's key", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: `not-a-secret-${"openai-key"}`, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic-key"}` }, [...NAMES, "AGENT_MODEL_STRONG", "AGENT_MODEL_FAST"]);
  const { api } = await serve(t);
  const flow = answerFlow("Fail with a refused key.");
  flow.root.steps[0].tier = "strong";
  assert.equal((await api("POST", "/agents", flowAgent("tiers", flow))).status, 201);
  const started = await api("POST", "/agents/tiers/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  const rows = errorRows(timeline.rows);
  assert.ok(rows.length > 0, JSON.stringify(timeline.rows.map((r) => [r.kind, r.summary])));
  assert.ok(!JSON.stringify(timeline).includes("OPENAI_API_KEY"), JSON.stringify(rows));
  assert.ok(rows.some((row) => row.text === '401: {"message":"User not found","code":401}'), JSON.stringify(rows));
});

test("only a loopback host is taken out: a public host whose name starts like one keeps its address", () => {
  for (const kept of ["see https://localhost.run/x", "see http://127.0.0.1.nip.io/y", "see https://localhost-proxy.example.com/z", "see http://localhostx/w"]) assert.equal(withoutLoopback(kept), kept);
  assert.equal(withoutLoopback("failed at http://localhost:8000/v1/responses: no"), "failed at a local address: no");
  assert.equal(withoutLoopback("failed at http://localhost/v1 now"), "failed at a local address now");
  assert.equal(withoutLoopback("failed at http://127.0.0.1"), "failed at a local address");
  assert.equal(withoutLoopback("unexpected status 500, url: http://127.0.0.1:39543/v1/responses"), "unexpected status 500");
});

test("a refused key's plain words carry no loopback address either: a gateway that names one in its 401", { timeout: 60_000 }, async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Authentication rejected by http://localhost:8000/v1/responses", code: 401 } })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  withEnv(t, { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/api`, AGENT_MODEL: "openai/gpt-6-sol", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,2,0.5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("rejected"))).status, 201);
  const started = await api("POST", "/agents/rejected/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  const words = "The gateway at AGENT_MODEL_BASE_URL refused AGENT_MODEL_API_KEY (401: Authentication rejected by a local address): set it where AgentRun starts.";
  assert.equal(run.error?.message, words, JSON.stringify(run.error));
  for (const row of errorRows(timeline.rows)) assert.deepEqual([row.summary, row.text], [words, words], JSON.stringify(row));
  assert.ok(!JSON.stringify(timeline).includes("localhost:8000") && !JSON.stringify(run).includes("localhost:8000"), "no loopback address anywhere");
});

// A held key's value never reaches a person through a run's error, whatever the run's kind and whatever the error: its
// served text replaces every held secret's value with [redacted] (key-refusal.ts' one redaction rule), as a refused
// key's plain words always did. The faux model's provider echoes the value the test holds as OPENAI_API_KEY.
const ECHOED = `not-a-secret-${"echoed-key-0123"}`;

test("a workflow node's 401 that echoes a held key: the Timeline and the run say [redacted], never the key", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: ECHOED }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("echoes", answerFlow("Fail echoing a held key.")))).status, 201);
  const started = await api("POST", "/agents/echoes/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  assert.ok(!JSON.stringify(timeline).includes(ECHOED), JSON.stringify(errorRows(timeline.rows)));
  assert.ok(!JSON.stringify(run).includes(ECHOED), JSON.stringify(run.error));
  assert.ok(errorRows(timeline.rows).some((row) => row.text?.includes("Key [redacted] is not valid")), JSON.stringify(errorRows(timeline.rows)));
});

test("an agentic run's error that is no 401 but echoes a held key: the Timeline and the run's error say [redacted]", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: ECHOED }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("echoes-too"))).status, 201);
  const started = await api("POST", "/agents/echoes-too/runs", { input: { content: "Fail echoing a held key." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const timeline = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  assert.ok(!JSON.stringify(timeline).includes(ECHOED), JSON.stringify(errorRows(timeline.rows)));
  assert.equal(run.error?.message, '500 {"message":"Key [redacted] is not valid"}', JSON.stringify(run.error));
});
