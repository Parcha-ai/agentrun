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

test("durations: ms, s, m, h, plain milliseconds; anything else is a usage error", () => {
  assert.deepEqual(["500ms", "30s", "1.5s", "2m", "1h", "250"].map(parseDuration), [500, 30_000, 1_500, 120_000, 3_600_000, 250]);
  for (const bad of ["", "30 s", "-1s", "1d", "s"]) assert.throws(() => parseDuration(bad), /not a duration/);
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

test("the executable runs through its bin path and prints usage", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:\n {2}pi-durable-archil run/);
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
