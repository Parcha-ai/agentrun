// The runner's write-time cut (runner/redact.ts runnerSecrets, the secrets decision's rule three: no journal entry or row a
// run writes carries a secret value) covers the server's own secrets kept in the store, a webhook trigger's signing secret
// among them, not only those in the runner's environment. A run its provider fails with an error quoting the trigger's
// secret leaves it nowhere in the store in the clear: not in the run's row, not in its journal. The server's read-side cut
// (server-secrets.test.mjs) is the second line, never the only one.
// The run's input holds each spelling reversed, so the secret reaches the run only through the provider's error: a person's
// own words are kept as given (the run's launch and its first message), and are no write of the run's to cut.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, follow, serve, storeBytes, withEnv } from "./support.mjs";

test("a run its provider fails quoting a webhook trigger's secret writes it nowhere in the store in the clear: its row and its journal are cut when written", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t);
  assert.equal((await server.api("POST", "/agents", agent("target"))).status, 201);
  const trigger = await server.api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const secret = trigger.body.signing_secret;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const forms = { whole: secret, bare: secret.slice("whsec_".length), hex: key.toString("hex") };
  const runId = (await server.api("POST", "/agents/target/runs", { input: { content: `Fail quoting reversed: ${Object.values(forms).map((one) => [...one].reverse().join("")).join(" ")}` } })).body.run_id;
  await follow(server.api, runId, ["failed"], { deadlineMs: 90_000 });
  await server.close();
  const bytes = storeBytes(server.data);
  for (const [form, value] of Object.entries(forms)) assert.ok(!bytes.includes(value), `the trigger's secret as ${form} is nowhere in the store's bytes (the run's row and its journal)`);
});
