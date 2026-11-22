// A deploy to a real API-only server (AGENTRUN_API_ONLY=1, the CLI on the faux model), through its HTTP API alone: a
// bundled template applied (its webhook trigger skipped and said), the agent read and run, redeployed as a second
// revision, rolled back, archived and deleted; making a trigger and the settings stay refused.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, follow, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"d".repeat(40)}`;

test("an API-only server takes a deploy through its API: apply, read, run, redeploy, roll back, archive and delete", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { env: { ...process.env, AGENTRUN_API_ONLY: "1", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^API only /m);
  assert.match(out, /^API only \(AGENTRUN_API_ONLY=1\): the run and deploy routes are served; /m, out);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);

  const applied = await api("POST", "/templates/inbound-lead/apply", { parameters: { icp: "B2B fintech, 50-2000 people" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.deepEqual(applied.body.triggers, [], "its webhook trigger is not made");
  assert.ok(applied.body.warnings.some((one) => one.field === "triggers.0" && one.message.includes("AGENTRUN_API_ONLY=1")), JSON.stringify(applied.body.warnings));

  const read = await api("GET", `/agents/${agent}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const first = read.body.revision;

  const run = await api("POST", `/agents/${agent}/runs`, { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${run.body.run_id}`)).body));

  const redeployed = await api("POST", "/templates/inbound-lead/apply", { parameters: { icp: "B2B insurers, any size" }, agent_id: agent });
  assert.equal(redeployed.status, 200, JSON.stringify(redeployed.body));
  assert.deepEqual([redeployed.body.agent_change, redeployed.body.revision_version], ["updated", 2]);
  const revisions = await api("GET", `/agents/${agent}/revisions`);
  assert.deepEqual(revisions.body.revisions.map((one) => one.version), [2, 1], JSON.stringify(revisions.body));
  const moved = await api("POST", `/agents/${agent}/current`, { revision: first });
  assert.deepEqual([moved.status, moved.body.revision], [200, first], JSON.stringify(moved.body));

  for (const [method, path, body] of [["POST", "/triggers", { name: "x", agent_id: agent, source: { kind: "schedule", every_s: 3600 }, target: { kind: "start_run" } }], ["GET", "/settings/tools"], ["GET", "/agents"]]) {
    // The token, never an owner's session (the client's for a secret write): this server has no owner.
    const refused = await api(method, path, body, { authorization: `Bearer ${TOKEN}` });
    assert.deepEqual([refused.status, refused.body.error?.message], [404, `this server serves the run API only (AGENTRUN_API_ONLY=1): /v2${path} is not served here`], `${method} ${path}`);
  }

  assert.equal((await api("POST", `/agents/${agent}/archive`)).status, 200);
  assert.equal((await api("DELETE", `/agents/${agent}`)).status, 204);
  assert.equal((await api("GET", `/agents/${agent}`)).status, 410, "purged");
});
