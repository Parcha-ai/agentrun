// A real server started with AGENTRUN_API_ONLY=1 (the CLI on the faux model): the setting reaches the server from the
// environment (cli.ts), its start says so, and a route the profile does not serve answers its 404 to the token. What
// the profile serves and refuses, from an apply to a delete, is api-only-deploy.test, in process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"d".repeat(40)}`;

test("AGENTRUN_API_ONLY=1 reaches the started server: its start says so, and making a trigger answers the profile's 404", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { env: { ...process.env, AGENTRUN_API_ONLY: "1", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^API only /m);
  assert.match(out, /^API only \(AGENTRUN_API_ONLY=1\): the run and deploy routes, the MCP server names, a Composio server's save and a server's delete are served; /m, out);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);

  // The token, never an owner's session (the client's for a secret write): this server has no owner.
  const refused = await api("POST", "/triggers", { name: "x", agent_id: "any", source: { kind: "schedule", every_s: 3600 }, target: { kind: "start_run" } }, { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual([refused.status, refused.body.error?.message], [404, "this server serves the run API only (AGENTRUN_API_ONLY=1): /v2/triggers is not served here"], JSON.stringify(refused.body));
});
