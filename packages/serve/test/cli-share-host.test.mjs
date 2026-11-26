// A real share host started by the CLI (`--share-host`, and AGENTRUN_SHARE_HOST=1): the flag reaches the server, its start
// says so and starts no runner beside it, and it answers under /r/ alone. What a share host serves and refuses is
// share-host.test, in process. Each token is made at random; nothing here counts requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../dist/store/index.js";
import { printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

for (const [how, args, env] of [["--share-host", ["--share-host"], {}], ["AGENTRUN_SHARE_HOST=1", [], { AGENTRUN_SHARE_HOST: "1" }]]) {
  test(`${how} starts a share host: its banner says so, no runner starts, and only /r/ answers`, { timeout: 60_000 }, async (t) => {
    const data = join(await scratch(t), "shares-data");
    const tokens = `alice:share-cli-${randomBytes(20).toString("hex")}`;
    const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", ...args], { env: { ...process.env, AGENTRUN_TOKENS: tokens, AGENTRUN_PUBLIC_URL: "", AGENTRUN_TOKEN: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await exited;
    });
    const out = await printed(child, /^Share host /m);
    assert.match(out, /^Share host \(--share-host\): shares at http:\/\/127\.0\.0\.1:\d+\/r\/<id>; /m, out);
    assert.doesNotMatch(out, /^Open /m, "no console to open");
    const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
    assert.match(out, new RegExp(`^AGENTRUN_BASE_URL=http://127\\.0\\.0\\.1:${port}/r/v2$`, "m"));
    const health = await fetch(`http://127.0.0.1:${port}/r/v2/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).share_host, true);
    for (const path of ["/", "/v2/health", "/v2/runs", "/v2/capacity"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.arrayBuffer();
      assert.equal(res.status, 404, path);
    }
    // No runner beside it: a runner that started has its row in the store before the banner prints, and keeps it while
    // it runs (a normal start's row is there at this point; a stop takes it away, so this reads it before the stop).
    const store = await openStore({ dataDir: data, role: "runner" });
    try {
      assert.deepEqual(await store.runners.list(), []);
    } finally {
      await store.close();
    }
  });
}
