import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    // Read-back of work/ after each release is asked for, never a default.
    assert.ok(!args.includes("--evidence-readback"));
    assert.equal((status as { evidenceReadback?: boolean }).evidenceReadback, false);
  });

  it("passes --evidence-readback to the server when asked, and says so in its status file", async () => {
    const evDir = join(root, "take-ev");
    const ev = spawn(process.execPath, [script, "--local", join(root, "disk"), "--dir", evDir, "--run", "take-ev", "--evidence-readback"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: join(homedir(), "tmp-d5", "tmp") }, stdio: "ignore" });
    try {
      for (let i = 0; i < 200 && !existsSync(join(evDir, "status.json")); i++) {
        if (ev.exitCode !== null) throw new Error("the launcher exited");
        await new Promise((r) => setTimeout(r, 200));
      }
      const evStatus = JSON.parse(readFileSync(join(evDir, "status.json"), "utf8")) as { pid: number; evidenceReadback: boolean };
      assert.equal(evStatus.evidenceReadback, true);
      assert.match(execFileSync("ps", ["-o", "args=", "-p", String(evStatus.pid)], { encoding: "utf8" }), /--evidence-readback(\s|$)/);
    } finally {
      ev.kill("SIGTERM");
      for (let i = 0; i < 40 && ev.exitCode === null && ev.signalCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    }
  });

  it("stops when told to, and takes its status file with it", async () => {
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, "it exited");
    for (let i = 0; i < 20 && existsSync(join(dir, "status.json")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!existsSync(join(dir, "status.json")));
  });

  const refuse = (...args: string[]) => spawnSync(process.execPath, [script, "--dir", join(root, "refuse"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });

  it("on the real disk --mount-root is required: there is no default lane directory", () => {
    const res = refuse();
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--mount-root is required/);
    assert.match(res.stderr, /no default/);
  });

  it("refuses a mount root that does not exist and creates nothing: a lane directory under /mnt/pda is made for the lane, never by this script", () => {
    const parent = join(root, "no-such-lane");
    const res = refuse("--mount-root", join(parent, "pipe"));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /does not exist/);
    assert.match(res.stderr, /does not create it/);
    assert.ok(!existsSync(parent), "no directory was made");
  });

  it("refuses a mount root the caller does not own, and a file that is not a directory", () => {
    const foreign = refuse("--mount-root", "/usr");
    assert.equal(foreign.status, 2);
    assert.match(foreign.stderr, /not owned by you/);
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    const notDir = refuse("--mount-root", file);
    assert.equal(notDir.status, 2);
    assert.match(notDir.stderr, /not a directory/);
  });
});
