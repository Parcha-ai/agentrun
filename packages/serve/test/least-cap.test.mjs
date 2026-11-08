// A run paused at its cap serves the least cap that would send its refused request (`pending.least_cap_usd`): the very
// figure its words name ("Raise the cap to at least $X"), carried from the refusal that wrote them, so the
// number and the words never drift. The same on a paid call's refusal, which carries it for its pause (paid-pause).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capBefore, paidCall, useSpend } from "../dist/cap.js";
import { startServe } from "../dist/index.js";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, client, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
/** The cap a refusal's words name: "Raise the cap to at least $X", whatever words end the sentence. */
const named = (text) => Number(/Raise the cap to at least \$(\d+\.\d\d)\b/.exec(text ?? "")?.[1]);

// Under the faux harness claude-agent and codex run one path (harness-app.ts's guard, capBefore), so codex stands for both.
for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run paused at its cap serves least_cap_usd, the cap its words name as the least that sends the refused request`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { faux: OUTPUT_PRICED, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    const id = `least-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? {} : { harness }))).status, 201);
    const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${run_id}`)).body;
    assert.equal(pending?.kind, "budget", JSON.stringify(pending));
    assert.ok(named(pending.said) > 0.05, pending.said);
    assert.equal(pending.least_cap_usd, named(pending.said), JSON.stringify(pending));
  });
}

// #1695's case: a total a hair (5e-12) past a whole cent. Whatever cent the words round it to, the figure is that cent.
const model = { id: "gpt-6-luna", name: "gpt-6-luna", api: "openai-responses", provider: "p", maxTokens: 64000, contextWindow: 400000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } };

test("a model request's refusal for room carries least_cap_usd's figure, the cap its words name, a total a hair past a cent included", async () => {
  const answer = (await capBefore(0.3, model)).beforeRequest({ spentUsd: 0.0028 + 5e-12, inFlight: [], inputTokensMax: 0, outputTokensLeast: 3072 });
  assert.ok(named(answer?.refuse) > 0.3, JSON.stringify(answer));
  assert.equal(answer.leastCapUsd, named(answer.refuse), JSON.stringify(answer));
});

test("a paid call's refusal for room carries the same figure, the cap its words name, a total a hair past a cent included", async (t) => {
  t.after(() => useSpend(undefined));
  useSpend({ cap: 0.3, spent: () => 0.21 + 5e-12, add: () => {} });
  const paid = await paidCall("monid_run", async () => 0, () => 0, { usd: 0.1, basis: "the price quoted" });
  assert.ok(named(paid.refused) > 0.3, JSON.stringify(paid));
  assert.equal(paid.leastCapUsd, named(paid.refused), JSON.stringify(paid));
});

// A paid call's refusal for room pauses the run at its next request (paid-pause.test.mjs): that pause serves the figure
// too, the cap its words name. pi through capModels; claude-agent through harness-app.ts's guard.
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
for (const harness of ["pi", "claude-agent"]) {
  test(`${harness}: a run paused at a paid call's refusal serves least_cap_usd, the cap its words name`, { timeout: 90_000 }, async (t) => {
    withEnv(t, { MONID_API_KEY: KEY });
    const { api } = await serve(t, { fauxMonid: FAUX_MONID, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    const ask = "Run monid's /person/enrich, called again after a raise.";
    const id = `least-paid-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { ...(harness === "pi" ? {} : { harness, instructions: ask }), tools: ["monid.run"], tool_settings: { "monid.run": { permission: "allow" } } }))).status, 201);
    const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: ask }, max_cost_usd: 0.5 })).body;
    await follow(api, run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${run_id}`)).body;
    assert.deepEqual([pending?.kind, pending?.needs_usd], ["budget", 1], JSON.stringify(pending));
    assert.ok(named(pending.said) > 0.5, pending.said);
    assert.equal(pending.least_cap_usd, named(pending.said), JSON.stringify(pending));
  });
}

test("a refusal's mark without its least cap is no figures: the pause serves its words alone, never spent and needs apart from the cap they name", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  let server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  let api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("partial"))).status, 201);
  const { run_id } = (await api("POST", "/agents/partial/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  await server.close();
  // The refusal's mark with spentUsd and needsUsd and no leastCapUsd: no server writes one (every refusal for room keeps
  // all three), and the figures are read whole or not at all.
  const db = new DatabaseSync(join(runDir(data, run_id), "store", "run.sqlite"), { timeout: 5_000 });
  try {
    const marks = db.prepare("SELECT rowid AS at, record FROM entries ORDER BY rowid").all().filter((row) => { const e = JSON.parse(row.record); return e.kind === REQUEST_STARTED && e.data?.capRefused === true; });
    assert.equal(marks.length, 1, "one refusal mark");
    const record = JSON.parse(marks[0].record);
    const { leastCapUsd, ...partial } = record.data;
    assert.equal(typeof leastCapUsd, "number", "the server's mark keeps it");
    db.prepare("UPDATE entries SET record = ? WHERE rowid = ?").run(JSON.stringify({ ...record, data: partial }), marks[0].at);
  } finally {
    db.close();
  }
  server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  api = client(server.baseUrl, server.token);
  const { pending } = (await api("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([pending?.kind, ...["spent_usd", "needs_usd", "least_cap_usd", "suggested_cap_usd"].map((field) => field in (pending ?? {}))], ["budget", false, false, false, false], JSON.stringify(pending));
  assert.equal(named(pending.said), 0.11, pending.said);
});
