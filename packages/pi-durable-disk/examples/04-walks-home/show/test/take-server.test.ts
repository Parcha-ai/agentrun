import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The take's 03 server in --local mode (a local directory for a disk: nothing of Archil is touched). What matters here is what
// the launcher promises about secrets and flags, which are the same in the real mode.
const script = fileURLToPath(new URL("../scripts/take-server.mjs", import.meta.url));

describe("the take server launcher", () => {
  const root = join(homedir(), "tmp-d5", `take-test-${Date.now().toString(36)}`);
  const dir = join(root, "take");
  let child: ChildProcess;
  let out = "";
  let status: { pid: number; origin: string; tokenFile: string; logFile: string; mode: string };

  before(async () => {
    mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
    child = spawn(process.execPath, [script, "--local", join(root, "disk"), "--dir", dir], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: join(homedir(), "tmp-d5", "tmp") }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    for (let i = 0; i < 200 && !existsSync(join(dir, "status.json")); i++) {
      if (child.exitCode !== null) throw new Error(`the launcher exited: ${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  });
  after(() => child?.kill("SIGTERM"));

  it("starts a server that answers on a free loopback port", async () => {
    assert.match(status.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(await fetch(status.origin).then(() => true, () => false));
    assert.equal(status.mode, "local");
  });

  it("writes the admin token to a 0600 file in a 0700 directory, and never prints or records the token", () => {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(status.tokenFile).mode & 0o777, 0o600);
    const token = readFileSync(status.tokenFile, "utf8").trim();
    assert.ok(token.length >= 20);
    assert.ok(!out.includes(token), "not in the launcher's output");
    assert.ok(!readFileSync(join(dir, "status.json"), "utf8").includes(token), "not in the status file");
    assert.equal(statSync(status.logFile).mode & 0o777, 0o600, "the server's own log, which holds the run's link, is private");
  });

  it("gives a fresh token on every start", () => {
    // The file is removed before each start, so a token from an earlier run is never reused: its content changes with the pid.
    assert.ok(statSync(status.tokenFile).mtimeMs >= statSync(join(dir, "status.json")).mtimeMs - 60_000);
  });

  it("runs the server with exactly the tab-writable creature paths, the broker, and nothing of the agent's memory", () => {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(status.pid)], { encoding: "utf8" });
    assert.match(args, /--tab-writable creature\/creature\.xml,creature\/body\.json,creature\/designs\.sqlite(\s|$)/);
    assert.ok(!args.includes("memory.sqlite"));
    assert.match(args, /--model-url http:\/\/127\.0\.0\.1:9421\/v1/);
    assert.match(args, /--host 127\.0\.0\.1/);
  });

  it("stops when told to, and takes its status file with it", async () => {
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, "it exited");
    for (let i = 0; i < 20 && existsSync(join(dir, "status.json")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!existsSync(join(dir, "status.json")));
  });
});
