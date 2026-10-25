// CLI unit tests: durations, usage errors (exit 2) and the API key rule. No Archil, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { instanceRunArgs, main, parseDuration, watchdogOwnsCgroup } from "../src/cli.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("durations: a number and its unit (ms, s, m, h); a bare number is refused with a hint, unless the flag carries its unit or 0 turns it off", () => {
  assert.deepEqual(["500ms", "30s", "1.5s", "2m", "1h", "0s", "0ms"].map((d) => parseDuration(d)), [500, 30_000, 1_500, 120_000, 3_600_000, 0, 0]);
  for (const bad of ["", "30 s", "-1s", "1d", "s", "1.5"]) assert.throws(() => parseDuration(bad), /not a duration/);
  assert.throws(() => parseDuration("90"), /: not a duration: "90": give a unit, e\.g\. 90s or 90ms$/);
  assert.throws(() => parseDuration("0"), /not a duration: "0": give a unit/, "a bare 0 is a bare number too");
  // A flag whose name carries its unit (-ms) takes a bare number as milliseconds, and units as before.
  assert.deepEqual(["250", "2s"].map((d) => parseDuration(d, { bareMs: true })), [250, 2_000]);
  // A flag whose 0 turns its feature off takes a bare 0, and nothing else bare.
  assert.equal(parseDuration("0", { zeroOff: true }), 0);
  assert.throws(() => parseDuration("90", { zeroOff: true }), /give a unit/);
});

/** What `main` says for `argv`: its exit code and what it wrote to stderr. */
async function said(argv: string[]): Promise<{ code: number; err: string }> {
  const write = process.stderr.write;
  let err = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((err += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), err };
  } finally {
    process.stderr.write = write;
  }
}

// Each command up to its duration flags; the run id is not a safe segment, so a run that got past its flags stops there,
// before it opens anything.
const RUN = ["run", "--disk", "d", "--region", "r", "--id", "../not-safe", "--app", "a.ts"];
const SUPERVISE = ["supervise", "--disk", "d", "--region", "r", "--id", "x", "--api-key-env", "PDA_TEST_NO_SUCH_KEY"];
const UNIT_FLAGS: [string[], string][] = [
  ...["park-threshold", "park-idle", "drain-timeout"].map((f) => [RUN, f] as [string[], string]),
  ...["stop-timeout", "control-timeout", "lease-expiry", "stonith-timeout", "start-grace", "start-backoff-max", "token-grace", "every", "park-threshold"].map((f) => [SUPERVISE, f] as [string[], string]),
];

test("every duration flag whose name carries no unit refuses a bare number, with the hint, before the command does anything", async () => {
  for (const [command, flag] of UNIT_FLAGS) {
    const r = await said([...command, `--${flag}`, "90"]);
    assert.equal(r.code, 2, `${command[0]} --${flag} 90`);
    assert.match(r.err, /^not a duration: "90": give a unit, e\.g\. 90s or 90ms\n/, `${command[0]} --${flag} 90`);
    const ok = await said([...command, `--${flag}`, "90s"]);
    assert.doesNotMatch(ok.err, /not a duration/, `${command[0]} --${flag} 90s is a duration`);
  }
});

test("a bare 0 is accepted only where 0 turns a feature off (--park-threshold, --start-grace, --start-backoff-max); -ms flags keep bare milliseconds", async () => {
  for (const [command, flag] of [[RUN, "park-threshold"], [SUPERVISE, "park-threshold"], [SUPERVISE, "start-grace"], [SUPERVISE, "start-backoff-max"]] as [string[], string][]) {
    assert.doesNotMatch((await said([...command, `--${flag}`, "0"])).err, /not a duration/, `${command[0]} --${flag} 0 turns it off`);
  }
  for (const [command, flag] of [[RUN, "drain-timeout"], [SUPERVISE, "every"], [SUPERVISE, "lease-expiry"]] as [string[], string][]) {
    assert.match((await said([...command, `--${flag}`, "0"])).err, /not a duration: "0": give a unit/, `${command[0]} --${flag} 0 is a bare number`);
    assert.doesNotMatch((await said([...command, `--${flag}`, "0s"])).err, /not a duration/, `${command[0]} --${flag} 0s behaves as before`);
  }
  for (const flag of ["heartbeat-ms", "lease-expiry-ms", "lease-margin-ms"]) {
    assert.doesNotMatch((await said([...RUN, `--${flag}`, "2000"])).err, /not a duration/, `--${flag} 2000 is milliseconds`);
    assert.match((await said([...RUN, `--${flag}`, "soon"])).err, /not a duration/, `--${flag} soon`);
  }
});

test("usage errors exit 2: no command, unknown command, unknown flag, missing required flags", async () => {
  const quiet = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main([]), 2);
    assert.equal(await main(["fork"]), 2);
    assert.equal(await main(["run", "--bogus"]), 2);
    assert.equal(await main(["run", "--disk", "d"]), 2);
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x"]), 2, "run needs --app");
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "a.ts", "--on-sigterm", "wait"]), 2, "--on-sigterm is resume or pause");
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "a.ts", "--serve", "http"]), 2, "--serve takes a port");
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "a.ts", "--park-threshold", "soon"]), 2);
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "a.ts", "--serve", "0", "--serve-host", "0.0.0.0"]), 2, "off loopback, serve needs a token file");
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "a.ts", "--serve", "0", "--serve-host", "0.0.0.0", "--serve-token-file", "/nonexistent"]), 2, "an unusable token file");
    assert.equal(await main(["fork", "--disk", "d", "--region", "r", "--id", "x"]), 2, "fork needs --new-id");
    assert.equal(await main(["supervise", "--disk", "d", "--region", "r", "--id", "x", "--api-key-env", "PDA_TEST_NO_SUCH_KEY"]), 2);
  } finally {
    process.stderr.write = quiet;
  }
});

test("run refuses a run id that is not one safe path segment before it serves or opens anything", async () => {
  const quiet = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk: string | Uint8Array) => ((stderr += String(chunk)), true);
  try {
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "../escape", "--app", "a.ts", "--serve", "0"]), 1);
  } finally {
    process.stderr.write = quiet;
  }
  const lines = stderr.trim().split("\n");
  assert.equal(lines.length, 1, stderr);
  assert.equal(JSON.parse(lines[0]!).error, "INVALID_ARGUMENT");
});

test("the executable runs through its bin path and prints usage", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:\n {2}pi-durable-disk run/);
});

test("--help (alone, or after a command) prints the usage on stdout and exits 0", () => {
  for (const args of [["--help"], ["supervise", "--help"], ["help"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /usage:\n {2}pi-durable-disk run/);
  }
});

test("the watchdog owns the cgroup only when /proc confirms the unit the holder names, and its parent is elsewhere", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-cgroup-"));
  try {
    const proc = (self: string | undefined, parent: string | undefined, ppid = 4242) => {
      const root = mkdtempSync(join(dir, "proc-"));
      for (const [pid, path] of [["self", self], [String(ppid), parent]] as const) {
        mkdirSync(join(root, pid), { recursive: true });
        if (path !== undefined) writeFileSync(join(root, pid, "cgroup"), `0::${path}\n`);
      }
      return { proc: root, ppid };
    };
    const unit = { driver: "local", mode: "systemd", unit: "pda-r1-mux1" };
    const inUnit = "/system.slice/pda-r1-mux1.service";
    assert.deepEqual(watchdogOwnsCgroup(unit, proc(inUnit, "/init.scope")), { owns: true }, "its own unit, started by the manager");
    const refused = (holder: Record<string, unknown>, at: { proc: string; ppid: number }, why: RegExp) => {
      const decision = watchdogOwnsCgroup(holder, at);
      assert.equal(decision.owns, false);
      assert.match(decision.warning ?? "", why);
    };
    refused(unit, proc("/system.slice/pda-r2-mux9.service", "/init.scope"), /is not pda-r1-mux1\.service/);
    refused({ driver: "local", mode: "systemd" }, proc(inUnit, "/init.scope"), /names no unit/);
    refused(unit, proc("/user.slice/user-1000.slice/session-3.scope", "/user.slice/user-1000.slice/session-3.scope"), /is not pda-r1-mux1\.service/);
    refused(unit, proc(inUnit, inUnit), /parent shares cgroup/);
    refused(unit, proc(undefined, "/init.scope"), /no cgroup v2 path/);
    refused(unit, proc(inUnit, undefined), /parent's cgroup cannot be read/);
    assert.deepEqual(watchdogOwnsCgroup({ driver: "local", mode: "child" }, proc(inUnit, "/init.scope")), { owns: false }, "child mode claims nothing");
    assert.deepEqual(watchdogOwnsCgroup({}, proc(inUnit, "/init.scope")), { owns: false }, "no holder handle (a run started by hand) never owns the cgroup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervise --app is --run-arg=--app with an absolute path, ahead of the other run args", () => {
  assert.deepEqual(instanceRunArgs({}), []);
  assert.deepEqual(instanceRunArgs({ "run-arg": ["--heartbeat-ms=2000"] }), ["--heartbeat-ms=2000"]);
  assert.deepEqual(instanceRunArgs({ app: "examples/app.ts", "run-arg": ["--heartbeat-ms=2000"] }), ["--app", resolve("examples/app.ts"), "--heartbeat-ms=2000"]);
  assert.deepEqual(instanceRunArgs({ app: "/srv/app.js" }), ["--app", "/srv/app.js"]);
});
