// A person saves a monid key and an agent uses monid's catalog, end to end on faux monid and the faux harness: the key
// saved through the settings API (checked first, with one discover) reaches a claude-agent run that names monid with no
// restart, and monid's charge is in that run's cost on a line of its own; a run naming only `read` holds no monid key
// (what its process was handed over its pipe, as secret-custody.test.mjs reads it); a capped run whose spend plus the
// call's held figure would pass its cap is refused before monid is called; and once the key is deleted, a run naming
// monid is refused for it. No network, no real key.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { reported } from "./fixtures/custody-report.mjs";
// A run's served answer has no held secret in it, so what a custody run's process reported is read as it wrote it
// (fixtures/custody-report.mjs), never from the answer.
process.env.CUSTODY_REPORT_DIR ??= mkdtempSync(join(tmpdir(), "custody-reports-"));

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const CUSTODY = new URL("./fixtures/faux-custody.mjs", import.meta.url).pathname;
const MONID = ["monid.discover", "monid.inspect", "monid.run"];
const MISSING = Object.fromEntries(MONID.map((name) => [name, ["MONID_API_KEY"]]));
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The run's store entries of `kind`, read while its process may still hold the store. */
function entries(data, runId, kind) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

test("a saved monid key reaches only the runs that name monid, with no restart; monid's charge is in the run's cost and counts against its cap; deleted, a run naming monid is refused", { timeout: 180_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  // Built here, so no scanner reads it as a credential.
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_MONID_CALLS: log, AGENTRUN_TEST_FAUX_MONID_ACCEPTS: createHash("sha256").update(saved).digest("hex") }, ["MONID_API_KEY"]);
  // pi answers with the custody model (what its process was handed); claude-agent runs the faux harness.
  const { api, data } = await serve(t, { faux: CUSTODY, fauxHarness: FAUX_HARNESS, fauxMonid: FAUX_MONID });
  const sent = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const refusal = async (id) => {
    const res = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
    return [res.status, res.body.error?.code, res.body.error?.details?.missing];
  };

  assert.equal((await api("POST", "/agents", agent("enrich", { harness: "claude-agent", instructions: "Run monid's /person/enrich on Ada.", tools: MONID, tool_settings: Object.fromEntries(MONID.map((name) => [name, { permission: "allow" }])) }))).status, 201);
  assert.deepEqual(await refusal("enrich"), [409, "agent_not_runnable", MISSING], "no key yet");
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);

  // The same server, no restart: the run's process gets the saved key over its pipe, and monid_run reaches monid on it.
  const run = await api("POST", "/agents/enrich/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(sent().map((call) => [call.method, call.path, call.authorized, call.key]), [["POST", "/v1/discover", true, digest(saved)], ["POST", "/v1/run", true, digest(saved)]], "checked once as it was saved (a discover, which costs nothing), then the run sent once, on the saved key");
  assert.deepEqual(sent().map((call) => call.pid === process.pid), [true, false], "the check from the server's own process, the run from the run's");
  // Booked once in the run's own records, as a tool cost, and summed with its two requests ($0.001 each).
  assert.deepEqual(entries(data, run.body.run_id, "agentrun.tool_cost").map(({ data: { tool, charged_by, usd } }) => ({ tool, charged_by, usd })), [{ tool: "monid.run", charged_by: "monid", usd: 0.003 }]);
  assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.tool_name === "monid.run").map((row) => row.summary), ["Tool cost: monid charged $0.0030 for monid.run"]);
  assert.equal(rows.findLast((row) => row.kind === "usage")?.usage.usd, 0.005);
  assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.cost.usd, 0.005, "the run's cost has monid's charge");
  // Marked before it was sent, at the allowance (no inspect quoted its price), and settled by its charge.
  assert.deepEqual(entries(data, run.body.run_id, "agentrun.tool_started").map(({ data: { tool, heldUsd } }) => [tool, heldUsd]), [["monid.run", 1]]);
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters, [["tokens", 0.002, 0], ["tools", 0.003, 0]], "monid's charge is its own meter");

  // A run naming only `read` is handed no monid key; one naming monid is handed the saved one.
  const handed = async (id, tools) => {
    assert.equal((await api("POST", "/agents", agent(id, { instructions: "Answer.", tools }))).status, 201);
    const { body } = await api("POST", `/agents/${id}/runs`, { input: { content: "Report." } });
    await follow(api, body.run_id, ["completed"]);
    return reported(body.run_id);
  };
  const reader = await handed("reader", ["read"]);
  assert.deepEqual([reader.handed.MONID_API_KEY, reader.inEnv, reader.pipe], ["none", [], { fd: 3, closed: true }]);
  assert.equal((await handed("holder", ["monid.run"])).handed.MONID_API_KEY, digest(saved));

  // A capped run whose first request ($0.001) leaves no room for the $1 allowance: monid_run is refused, monid not called.
  const before = sent().length;
  const capped = await api("POST", "/agents/enrich/runs", { input: { content: "hi" }, max_cost_usd: 0.001 });
  assert.equal(capped.status, 202, JSON.stringify(capped.body));
  const ended = await follow(api, capped.body.run_id, ["completed", "failed"], { deadlineMs: 55_000 });
  const result = ended.rows.find((row) => row.kind === "tool_result" && row.tool_name === "monid_run");
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(result.tool_result_preview, /spend_cap_reached: monid_run was not sent\. It could cost up to \$1 \(no monid_inspect in this run quoted its price, so it is held at the \$1 allowance; monid_inspect gives its quote\), and with \$0\.001000 spent the run would pass its cap of \$0\.001/);
  assert.equal(sent().length, before, "monid saw no request");
  assert.deepEqual([...entries(data, capped.body.run_id, "agentrun.tool_started"), ...entries(data, capped.body.run_id, "agentrun.tool_cost")], [], "nothing marked or charged");

  // Deleted: the next run naming monid is refused for it.
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  assert.deepEqual(await refusal("enrich"), [409, "agent_not_runnable", MISSING]);
});

test("two servers in one process each hand their own runs their own saved key, never the other's", { timeout: 120_000 }, async (t) => {
  // Built here, so no scanner reads them as credentials.
  const [first, second] = ["a", "b"].map((tag) => ["not-a-secret", "monid", tag, randomBytes(4).toString("hex")].join("-"));
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["MONID_API_KEY"]);
  // Both on the custody model: a run reports, by digest, what its process was handed over its pipe.
  const one = await serve(t, { faux: CUSTODY });
  const two = await serve(t, { faux: CUSTODY });
  assert.equal((await one.api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: first } })).status, 204);
  // Saved on the second server after the first started: a reader shared through the process would now be the second's.
  assert.equal((await two.api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: second } })).status, 204);
  const handed = async (api) => {
    assert.equal((await api("POST", "/agents", agent("holder", { instructions: "Answer.", tools: ["monid.run"] }))).status, 201);
    const { body } = await api("POST", "/agents/holder/runs", { input: { content: "Report." } });
    await follow(api, body.run_id, ["completed"]);
    return reported(body.run_id).handed.MONID_API_KEY;
  };
  assert.equal(await handed(one.api), digest(first), "the first server's run: the first server's key");
  assert.equal(await handed(two.api), digest(second), "the second server's run: its own");
});
