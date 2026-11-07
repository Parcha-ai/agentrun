// CLI unit tests: durations and usage errors (exit 2). No disk, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseDuration, watchdogOwnsCgroup } from "../src/cli.ts";

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

// A run up to its duration flags; its directory cannot be made, so a run that got past its flags stops there, before it
// opens anything.
const RUN = ["run", "--dir", "/dev/null/r1", "--app", "a.ts"];
const UNIT_FLAGS: [string[], string][] = ["park-threshold", "park-idle", "drain-timeout"].map((f) => [RUN, f] as [string[], string]);

test("every duration flag whose name carries no unit refuses a bare number, with the hint, before the command does anything", async () => {
  for (const [command, flag] of UNIT_FLAGS) {
    const r = await said([...command, `--${flag}`, "90"]);
    assert.equal(r.code, 2, `${command[0]} --${flag} 90`);
    assert.match(r.err, /^not a duration: "90": give a unit, e\.g\. 90s or 90ms\n/, `${command[0]} --${flag} 90`);
    const ok = await said([...command, `--${flag}`, "90s"]);
    assert.doesNotMatch(ok.err, /not a duration/, `${command[0]} --${flag} 90s is a duration`);
  }
});

test("a bare 0 is accepted only where 0 turns a feature off (--park-threshold); -ms flags keep bare milliseconds", async () => {
  assert.doesNotMatch((await said([...RUN, "--park-threshold", "0"])).err, /not a duration/, "--park-threshold 0 turns it off");
  for (const [command, flag] of [[RUN, "drain-timeout"], [RUN, "park-idle"]] as [string[], string][]) {
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
    assert.equal(await main(["nope"]), 2);
    assert.equal(await main(["run", "--bogus"]), 2);
    assert.equal(await main(["run", "--dir", "d"]), 2, "run needs --app");
    assert.equal(await main([...RUN, "--on-sigterm", "wait"]), 2, "--on-sigterm is resume or pause");
    assert.equal(await main([...RUN, "--serve", "http"]), 2, "--serve takes a port");
    assert.equal(await main([...RUN, "--park-threshold", "soon"]), 2);
    assert.equal(await main([...RUN, "--serve", "0", "--serve-host", "0.0.0.0"]), 2, "off loopback, serve needs a token file");
    assert.equal(await main([...RUN, "--serve", "0", "--serve-host", "0.0.0.0", "--serve-token-file", "/nonexistent"]), 2, "an unusable token file");
    assert.equal(await main(["status"]), 2, "status needs --dir");
  } finally {
    process.stderr.write = quiet;
  }
});

test("the executable runs through its bin path and prints usage", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:\n {2}pi-durable-disk run/);
});

test("--help (alone, or after a command) prints the usage on stdout and exits 0", () => {
  for (const args of [["--help"], ["status", "--help"], ["help"]]) {
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
