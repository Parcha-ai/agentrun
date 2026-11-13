// The server's record (.server.json) is read by other processes as soon as it is there (the npx command, the tests that
// wait for a server): it must never be seen half-written. A preload (fixtures/slow-record.mjs) makes the record's write
// slow in the one way a reader can catch it, the file there but empty, so the check does not depend on timing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SLOW = new URL("./fixtures/slow-record.mjs", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "NODE_OPTIONS"];

test("the server's record is whole the moment it is there: a reader that finds the file reads the server's pid and URL, never an empty or half-written file", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "server-record-write-"));
  const data = join(dir, "data");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), AGENTRUN_BOXES: "none", HOME: dir, AGENTRUN_ACCOUNTS: "0", NODE_OPTIONS: `--import=${pathToFileURL(SLOW).href}` };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"], env });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  // After the stop: a test's after-hooks run in the order they were added.
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const record = join(data, ".server.json");
  for (let i = 0; !existsSync(record); i++) {
    assert.ok(i < 6000 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const text = readFileSync(record, "utf8");
  assert.notEqual(text, "", "the record is never there empty");
  const said = JSON.parse(text);
  assert.equal(said.pid, child.pid);
  assert.match(said.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v2$/);
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(existsSync(record), false, "a clean stop removes it");
});
