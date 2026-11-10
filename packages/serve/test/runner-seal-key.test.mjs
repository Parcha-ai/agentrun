// A runner started on its own takes the server's seal key: the one handed over (AGENTRUN_SEAL_KEY), else the one the
// server keeps under the config home (runner/main.ts runnerLoop). A handed key that is no key is refused in words, as the
// server refuses it (seal-key.ts ensureSealKey), never passed over for the kept one: a runner on another key than its
// server's would seal what the server cannot open.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { runnerLoop, RunnerRefused } = await import("../dist/runner/main.js");
const { ensureSealKey } = await import("../dist/seal-key.js");
const { openSqliteStore } = await import("../dist/store/index.js");

test("a handed AGENTRUN_SEAL_KEY that is no key is refused in words, even with a kept key beside it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-seal-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config");
  ensureSealKey(undefined, { configHome: config });
  const data = join(dir, "agents");
  await (await openSqliteStore({ dataDir: data, role: "server" })).close();
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(() => store.close());
  assert.throws(() => runnerLoop(store, data, { AGENTRUN_SEAL_KEY: "not a key", XDG_CONFIG_HOME: config, HOME: dir }), (error) => error instanceof RunnerRefused && /AGENTRUN_SEAL_KEY/.test(error.message), "refused, naming the handed key");
});
