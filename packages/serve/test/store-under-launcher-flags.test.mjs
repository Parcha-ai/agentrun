// The SQLite store opened by a Node started as the server's launcher starts it (`node --input-type=module -e '…'`, the
// code given on the command line): its worker thread must run. A worker from a file refuses the flags that apply only to
// command-line code ("--input-type can only be used with string input via --eval"), so the store's worker takes this
// process's flags less those (connection.ts workerExecArgv), and a store opens under the launcher as anywhere else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const STORE = fileURLToPath(new URL("../dist/store/index.js", import.meta.url));

test("a store opens, writes and reads under Node started with --input-type=module -e, as the launcher starts it", (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "store-launcher-flags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const code = `
    const { openSqliteStore } = await import(${JSON.stringify(STORE)});
    const store = await openSqliteStore({ dataDir: ${JSON.stringify(dir)}, role: "server" });
    await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
    console.log(JSON.stringify((await store.agents.get("agent-1"))?.name));
    await store.close();
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(ran.status, 0, `the store opened under the launcher's flags: ${ran.stderr.slice(0, 400)}`);
  assert.equal(ran.stdout.trim(), '"Agent"', "and wrote and read through its worker");
});

test("the store's worker flags: this process's, less those for command-line code and their code", async () => {
  const { workerExecArgv } = await import("../dist/store/sqlite/connection.js");
  assert.equal(typeof workerExecArgv, "function", "workerExecArgv is there");
  assert.deepEqual(workerExecArgv(["--input-type=module", "-e", "code", "--max-old-space-size=512"]), ["--max-old-space-size=512"]);
  assert.deepEqual(workerExecArgv(["--conditions=dev", "--eval", "x", "-p", "1", "--print=2", "--eval=3"]), ["--conditions=dev"]);
  // With no command-line code, nothing is given: the worker inherits this process's flags as Node gives them.
  assert.equal(workerExecArgv(["--max-old-space-size=512", "--stack-trace-limit=10"]), undefined);
});
