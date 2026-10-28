// The page's dev kit (dev/): the seed makes runs in every state on the faux model, and the dev loop serves the page's
// files from src while /v2 and the page's cookie work through it. No key, no network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { seed } from "../dev/seed.mjs";
import { scratch } from "./support.mjs";

const START = fileURLToPath(new URL("../dev/start.mjs", import.meta.url));
const SERVE_JS = fileURLToPath(new URL("../src/page/serve.js", import.meta.url));

/** Starts dev/start.mjs on free ports and resolves with its page address and token once it prints them. */
function startDev(t, data) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", START, "--data", data, "--port", "0", "--api-port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => new Promise((done) => (child.exitCode !== null ? done() : (child.once("exit", done), child.kill("SIGTERM")))));
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const open = /^Open (http:\/\/127\.0\.0\.1:\d+)\/\?token=(\S+)$/m.exec(out);
      if (open) resolve({ base: open[1], token: open[2] });
    });
    child.once("exit", (code) => reject(new Error(`dev/start.mjs exited ${code}: ${out}`)));
  });
}

test("the seed makes sample runs in every state, and the dev loop serves the page from src over them", { timeout: 240_000 }, async (t) => {
  const data = join(await scratch(t), "data");
  const { counts, runs } = await seed({ data, log: () => {} });
  assert.ok(runs >= 30, `${runs} runs`);
  assert.deepEqual(Object.keys(counts).sort(), ["cancelled", "completed", "failed", "input_required", "working"]);
  assert.deepEqual([counts.cancelled, counts.working, counts.failed, counts.input_required], [2, 2, 5, 2]);
  await assert.rejects(seed({ data, log: () => {} }), /is not empty; pass --reset/);
  const other = join(await scratch(t), "other");
  await mkdir(other);
  await writeFile(join(other, "keep.txt"), "not the seed's\n");
  await assert.rejects(seed({ data: other, reset: true, log: () => {} }), /was not made by this script/);

  const { base, token } = await startDev(t, data);
  const link = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  assert.equal(link.status, 303);
  const cookie = link.headers.get("set-cookie").split(";")[0];
  assert.equal(await (await fetch(`${base}/serve.js`)).text(), await readFile(SERVE_JS, "utf8"), "the page's files come from src");
  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const store = await (await fetch(`${base}/api/store`, { headers: { cookie } })).json();
  assert.ok(store.agents.some((agent) => agent.id === "invoice-checker"));
  const { runs: listed } = await (await fetch(`${base}/v2/runs?status=completed`, { headers: { cookie } })).json();
  const archive = (headers) => fetch(`${base}/v2/runs/${listed[0].run_id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: "{}" });
  assert.equal((await archive({})).status, 401, "a write without the page's origin needs the token");
  assert.equal((await archive({ origin: base })).status, 200, "the page's own origin, through the proxy, may write");
});
