// The CLI reads AGENTRUN_RUN_KEYS=1 at its boot: a real server, through its HTTP API alone, takes a template whose tool
// key it does not hold, and a run of its agent that does not carry the key is 409 at keys.PARALLEL_API_KEY.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"k".repeat(40)}`;
const AGENT_MD = ["---", "name: searcher", "version: 1.0.0", "description: Searches the web.", "tools: [web_search, read]", "secrets: [PARALLEL_API_KEY]", "---", "Search.", ""].join("\n");

test("AGENTRUN_RUN_KEYS=1 at the CLI's boot: a run of a template's agent that does not carry the tool key the server lacks is 409 at keys.PARALLEL_API_KEY", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const env = { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_RUN_KEYS: "1", AGENTRUN_TOKEN: TOKEN };
  delete env.PARALLEL_API_KEY;
  const child = spawn(process.execPath, [CLI, "--data", join(dir, "agents"), "--port", "0", "--faux", FAUX], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^Open /m);
  const api = client(`http://127.0.0.1:${/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]}/v2`, TOKEN);

  const stored = await api("POST", "/templates/import", { files: [{ path: "agent.md", encoding: "utf8", content: AGENT_MD }] });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const applied = await api("POST", `/templates/${encodeURIComponent(stored.body.template.id)}/apply`, { sha: stored.body.template.sha });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const refused = await api("POST", `/agents/${applied.body.agent_id}/runs`, { input: { content: "Search the web for widgets." } });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [["keys.PARALLEL_API_KEY", "not_set_up_here"]]);
});
