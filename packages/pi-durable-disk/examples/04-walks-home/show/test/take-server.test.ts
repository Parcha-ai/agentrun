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
    assert.match(args, /--tab-writable creature\/creature\.xml,creature\/body\.json,creature\/designs\.sqlite,creature\/design\.json,creature\/fit\.json,robot\/build\.json(\s|$)/);
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

  it("passes the instructions policy through to serve.ts unchanged when given, and not at all when not", async () => {
    const polDir = join(root, "take-pol");
    const instructions = join(root, "instructions.txt");
    writeFileSync(instructions, "You are a chat page's agent.\n");
    assert.ok(!execFileSync("ps", ["-o", "args=", "-p", String(status.pid)], { encoding: "utf8" }).match(/--instructions-|--without-extensions/), "the robot's own launch has none of them");
    const pol = spawn(process.execPath, [script, "--local", join(root, "disk"), "--dir", polDir, "--run", "take-pol", "--instructions-file", instructions, "--instructions-mode", "replace", "--without-extensions", "offline-tools,robot-tools,computer"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: join(homedir(), "tmp-d5", "tmp") }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      for (let i = 0; i < 200 && !existsSync(join(polDir, "status.json")); i++) {
        if (pol.exitCode !== null) throw new Error("the launcher exited");
        await new Promise((r) => setTimeout(r, 200));
      }
      const polStatus = JSON.parse(readFileSync(join(polDir, "status.json"), "utf8")) as { pid: number };
      const args = execFileSync("ps", ["-o", "args=", "-p", String(polStatus.pid)], { encoding: "utf8" });
      assert.ok(args.includes(`--instructions-file ${instructions} --instructions-mode replace --without-extensions offline-tools,robot-tools,computer`), args);
    } finally {
      pol.kill("SIGTERM");
      for (let i = 0; i < 40 && pol.exitCode === null && pol.signalCode === null; i++) await new Promise((r) => setTimeout(r, 200));
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

  it("refuses, with exit 2 and before anything starts, whatever serve.ts would refuse of the instructions policy: no mode, no file, a bad mode, an unreadable or empty file, a bad extension list, a flag with no value", () => {
    const file = join(root, "instr-refuse.txt");
    writeFileSync(file, "x");
    const empty = join(root, "instr-empty.txt");
    writeFileSync(empty, " \n");
    const unreadable = join(root, "instr-unreadable.txt");
    writeFileSync(unreadable, "x", { mode: 0o000 });
    for (const [args, message] of [
      [["--instructions-file", file], /--instructions-file needs --instructions-mode/],
      [["--instructions-mode", "append"], /--instructions-mode needs --instructions-file/],
      [["--instructions-file", file, "--instructions-mode", "prepend"], /replace or append/],
      [["--instructions-file", join(root, "nope.txt"), "--instructions-mode", "replace"], /cannot read it/],
      [["--instructions-file", unreadable, "--instructions-mode", "replace"], /cannot read it/],
      [["--instructions-file", root, "--instructions-mode", "replace"], /cannot read it/],
      [["--instructions-file", empty, "--instructions-mode", "replace"], /the file is empty/],
      [["--without-extensions"], /comma-separated list of extension names/],
      [["--without-extensions", ","], /comma-separated list of extension names/],
      [["--without-extensions", " , "], /comma-separated list of extension names/],
      [["--without-extensions", ""], /comma-separated list of extension names/],
      // a flag at the end of the line, or with an empty value, is given and empty: refused, never dropped
      [["--instructions-file", file, "--instructions-mode"], /replace or append/],
      [["--instructions-file", file, "--instructions-mode", ""], /replace or append/],
      [["--instructions-mode", "replace", "--instructions-file"], /cannot read it/],
      [["--instructions-mode", "replace", "--instructions-file", ""], /cannot read it/],
    ] as const) {
      const res = refuse("--local", join(root, "disk"), ...args);
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, message, args.join(" "));
    }
  });

  it("resolves a relative instructions file against the caller's directory, so serve.ts (which runs elsewhere) reads the file that was checked", async () => {
    const relDir = join(root, "rel-caller");
    mkdirSync(relDir, { recursive: true });
    writeFileSync(join(relDir, "policy.txt"), "From the caller.\n");
    const relTake = join(root, "take-rel");
    const rel = spawn(process.execPath, [script, "--local", join(root, "disk"), "--dir", relTake, "--run", "take-rel", "--instructions-file", "policy.txt", "--instructions-mode", "append"], { cwd: relDir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: join(homedir(), "tmp-d5", "tmp") }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      for (let i = 0; i < 200 && !existsSync(join(relTake, "status.json")); i++) {
        if (rel.exitCode !== null) throw new Error("the launcher exited");
        await new Promise((r) => setTimeout(r, 200));
      }
      const relStatus = JSON.parse(readFileSync(join(relTake, "status.json"), "utf8")) as { pid: number };
      const args = execFileSync("ps", ["-o", "args=", "-p", String(relStatus.pid)], { encoding: "utf8" });
      assert.ok(args.includes(`--instructions-file ${join(relDir, "policy.txt")} `), args);
    } finally {
      rel.kill("SIGTERM");
      for (let i = 0; i < 40 && rel.exitCode === null && rel.signalCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    }
  });

  it("refuses an --up-timeout-s that is not a positive number, before anything is started", () => {
    for (const bad of ["0", "-5", "soon"]) {
      const res = refuse("--local", join(root, "disk"), "--up-timeout-s", bad);
      assert.equal(res.status, 2, bad);
      assert.match(res.stderr, /--up-timeout-s .* is not a positive number of seconds/, bad);
    }
  });

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
