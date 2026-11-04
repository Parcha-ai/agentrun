// A run's error reads the same on its Timeline row as in its error box: a provider's refusal of the run's key in plain
// words (key-refusal.ts), and never serve's own loopback proxy address, which Codex names at the end of its errors
// ("…, url: http://127.0.0.1:<port>/v1/responses"). Round-2 QA (2026-11-04) found the box in plain words and the row
// still the harness's raw text. claude-agent and codex run on the faux harness, failing with what the pinned CLI and
// Codex binary said for OpenRouter's 401; pi runs for real against a loopback gateway that answers 401.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";

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
