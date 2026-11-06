// DIR/.server.json, the record that tells the CLI where this machine's server is: a clean stop removes it only while it
// still names this server, and before the data directory's lock goes, so a server started next keeps its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

/** A server started on a fresh data directory, with no box: these tests are about its record, and a Docker box's image,
 *  which a start on a machine with Docker begins to build, has Docker's own processes writing under HOME (here the
 *  scratch directory) after the server is gone. `ended` resolves with how it exited. Once the test is over, the server
 *  is killed if it still runs and awaited, then its directory removed. */
function start(t, stdio = "ignore") {
  const dir = mkdtempSync(join(tmpdir(), "server-record-"));
  const data = join(dir, "data");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir, AGENTRUN_ACCOUNTS: "0", AGENTRUN_BOXES: "none" };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0"], { stdio: ["ignore", "ignore", stdio], env });
  const ended = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { child, ended, data };
}

/** A server on a fresh data directory; resolves once it wrote its record. */
async function serve(t) {
  const { child, ended, data } = start(t, "pipe");
  const exited = ended.then(({ code }) => code);
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

test("a SIGTERM the moment the record appears is a clean stop: exit 0, the record gone", { timeout: 180_000 }, async (t) => {
  // The record is written once the server listens; a stop sent as soon as it is there must find the stop handler in place.
  for (let i = 0; i < 8; i++) {
    const { child, ended: exited, data } = start(t);
    for (let j = 0; !existsSync(data); j++) {
      assert.ok(j < 6000 && child.exitCode === null, "the server made its data directory");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const record = join(data, ".server.json");
    await new Promise((resolve) => {
      const kill = () => existsSync(record) && (watcher.close(), child.kill("SIGTERM"), resolve());
      const watcher = watch(data, kill);
      kill();
    });
    assert.deepEqual(await exited, { code: 0, signal: null }, `try ${i + 1}`);
    assert.equal(existsSync(record), false, `try ${i + 1}: the record is gone`);
  }
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
