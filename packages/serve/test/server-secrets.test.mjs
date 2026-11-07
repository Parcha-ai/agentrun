// The server's own secrets are one list (server-secrets.ts), fed by every sealed store: what a run shows (its answer, its
// Timeline) is cut of each of them, a webhook trigger's signing secret and the outbound webhook's among them. And a
// sealed secret that will not open is said, never dropped in silence.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const sealKey = () => randomBytes(32).toString("base64");
/** Whether `text` holds any 8 characters of `secret` in a row. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("a run that quotes a webhook trigger's signing secret, or the outbound webhook's, shows neither: its answer and its Timeline are cut of both", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("quotes", { tools: ["read"] }))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "quotes", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const outbound = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
  for (const [what, secret] of [["the trigger's", trigger.body.secret], ["the outbound webhook's", outbound.body.secret]]) {
    const file = join(await scratch(t), "key.txt");
    await writeFile(file, secret);
    const started = await api("POST", "/agents/quotes/runs", { input: { content: `Quote the key in ${file}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"]);
    const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
    const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
    assert.ok(rows.some((r) => r.kind === "final_answer"), `${what}: a final answer`);
    for (const form of [secret, Buffer.from(secret).toString("base64")]) {
      assert.ok(!holdsRun(JSON.stringify(run), form), `${what} secret is not in the run: ${JSON.stringify(run.result)}`);
      assert.ok(!holdsRun(JSON.stringify(rows), form), `${what} secret is not on the Timeline`);
    }
  }
});

test("a webhook trigger's secret that does not open under the server's seal key is said at the start, naming its trigger, and the trigger stays refused", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("hooked"))).status, 201);
  const made = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await first.close();
  // Another seal key: the secret is still in the file, sealed, but does not open here.
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const lines = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", log: (line) => lines.push(line) });
  t.after(() => next.close());
  const said = lines.filter((line) => line.includes(made.body.id) && /does not open|not_open|unopened|unreadable/.test(line));
  assert.equal(said.length, 1, `said once, naming the trigger: ${JSON.stringify(lines)}`);
  api = client(next.baseUrl, next.token);
  const hook = await fetch(`${next.baseUrl}/hooks/${made.body.id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_1", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }, body: "{}" });
  assert.equal(hook.status, 401, "still refused");
});
