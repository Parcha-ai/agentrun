// DIR/.server.json, the record that tells the CLI where this machine's server is: a clean stop removes it only while it
// still names this server, and before the data directory's lock goes, so a server started next keeps its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

/** A server on a fresh data directory; resolves once it wrote its record. */
async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), "server-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "data");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir, AGENTRUN_ACCOUNTS: "0" };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"], env });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const record = join(data, ".server.json");
  for (let i = 0; !existsSync(record); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, exited, record };
}

test("a clean stop removes the server's own record", { timeout: 120_000 }, async (t) => {
  const a = await serve(t);
  assert.equal(JSON.parse(readFileSync(a.record, "utf8")).pid, a.child.pid);
  a.child.kill("SIGTERM");
  assert.equal(await a.exited, 0);
  assert.equal(existsSync(a.record), false);
});

test("a stop leaves a record that names another server, as one started next writes it", { timeout: 120_000 }, async (t) => {
  const a = await serve(t);
  // The next server's record, there before this one's stop reaches it.
  const next = `${JSON.stringify({ base_url: "http://127.0.0.1:9/v2", pid: process.pid, token_file: join(a.record, "..", ".token") })}\n`;
  writeFileSync(a.record, next, { mode: 0o600 });
  a.child.kill("SIGTERM");
  assert.equal(await a.exited, 0);
  assert.equal(readFileSync(a.record, "utf8"), next, "the next server's record stays");
});

test("removeOwnRecord removes the record only while it names this process, and never throws", async (t) => {
  const { removeOwnRecord } = await import("../dist/files.js");
  const dir = mkdtempSync(join(tmpdir(), "server-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = join(dir, ".server.json");
  writeFileSync(record, JSON.stringify({ base_url: "http://127.0.0.1:9/v2", pid: process.pid }));
  removeOwnRecord(record, process.pid + 1);
  assert.equal(existsSync(record), true, "another process's record stays");
  removeOwnRecord(record, process.pid);
  assert.equal(existsSync(record), false, "its own goes");
  removeOwnRecord(record, process.pid);
  writeFileSync(record, "not json");
  removeOwnRecord(record, process.pid);
  assert.equal(readFileSync(record, "utf8"), "not json", "a record it cannot read is not its own");
});
