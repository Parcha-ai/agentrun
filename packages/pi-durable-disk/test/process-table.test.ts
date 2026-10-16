// The process table: /proc on Linux, ps and sysctl on macOS. The ps table is read here from a scripted ps, and on Linux
// also from procps against real processes; only the macOS CI job runs it against a Mac's own ps.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { procTable, processTable, psTable, type CommandRunner } from "../src/process-table.ts";
import { linuxPs, onPlatform } from "./_macos.ts";
import { killQuietly } from "./_run-support.ts";

const linux = process.platform === "linux";

/** A ps and a sysctl that answer from `listing`, `environments` (pid to `ps -E` output) and `boot`, and log each call. */
function scripted(listing: string, environments: Record<number, string> = {}, boot = "8C1F3E0A-0B6D-4C47-9A3E-6F0E2D9B7C11\n") {
  const calls: string[] = [];
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "/usr/sbin/sysctl") return boot;
    if (args.includes("-A")) return listing;
    const pid = Number(args[args.indexOf("-p") + 1]);
    if (environments[pid] === undefined) throw new Error(`no process ${pid}`);
    return environments[pid]!;
  };
  return { run, calls };
}

// `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` in UTC, as macOS prints it: 1 is launchd, 500 the instance, 600 a command
// leading its own group with 601 in it, 700 a zombie.
const LISTING = [
  "    1     0     1 Ss   Thu Oct  1 08:00:00 2026",
  "  500     1   500 S    Thu Oct 15 06:00:00 2026",
  "  600   500   600 Ss   Thu Oct 15 06:00:05 2026",
  "  601   600   600 S    Thu Oct 15 06:00:06 2026",
  "  700   500   500 Z    Thu Oct 15 06:00:07 2026",
  "",
].join("\n");

describe("the process table through ps (macOS)", () => {
  it("reads each live process's parent, group and start (the second it started, UTC) from one listing; a zombie is gone", () => {
    const { run, calls } = scripted(LISTING);
    const look = psTable(run).snapshot();
    assert.deepEqual(look.info(600), { ppid: 500, pgrp: 600, start: Date.UTC(2026, 9, 15, 6, 0, 5) / 1000 });
    assert.deepEqual(look.info(1), { ppid: 0, pgrp: 1, start: Date.UTC(2026, 9, 1, 8, 0, 0) / 1000 });
    assert.equal(look.info(700), undefined, "a zombie");
    assert.equal(look.info(9999), undefined, "no such process");
    assert.deepEqual(look.children(500), [600], "the zombie is no child");
    assert.deepEqual(look.children(600), [601]);
    assert.deepEqual(calls, ["/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart="], "one listing for every read of the snapshot");
  });

  it("asks ps for the environment a process started with, and its command line", () => {
    const { run } = scripted(LISTING, { 600: "/bin/sh -c sleep 600 HOME=/Users/a PI_DURABLE_DISK_COMMANDS=tok-1 PATH=/usr/bin\n" });
    const look = psTable(run).snapshot();
    assert.equal(look.marked(600, "PI_DURABLE_DISK_COMMANDS", "tok-1"), true);
    assert.equal(look.marked(600, "PI_DURABLE_DISK_COMMANDS", "tok-2"), false, "another environment's mark");
    assert.equal(look.marked(601, "PI_DURABLE_DISK_COMMANDS", "tok-1"), false, "ps cannot read it: not marked");
    assert.equal(look.commandLine(601), "?");
  });

  it("takes the boot's id from sysctl once it has it, and asks again after a failure", () => {
    let fail = true;
    const { run, calls } = scripted(LISTING);
    const table = psTable((file, args) => {
      if (file === "/usr/sbin/sysctl" && fail) throw new Error("sysctl failed");
      return run(file, args);
    });
    assert.equal(table.bootId(), undefined);
    fail = false;
    assert.equal(table.bootId(), "8C1F3E0A-0B6D-4C47-9A3E-6F0E2D9B7C11");
    assert.equal(table.bootId(), "8C1F3E0A-0B6D-4C47-9A3E-6F0E2D9B7C11");
    assert.deepEqual(calls, ["/usr/sbin/sysctl -n kern.bootsessionuuid"], "read once it succeeded");
  });

  it("throws when the listing cannot be had or read, so no process is ever taken for gone", () => {
    assert.throws(() => psTable(() => assert.fail("ps failed")).snapshot(), /ps failed/);
    assert.throws(() => psTable(scripted(`${LISTING}  800   500   800 Ss   yesterday\n`).run).snapshot(), /ps printed a line this does not read/);
  });

  it("is this machine's table on macOS, and /proc elsewhere", async () => {
    assert.equal((await onPlatform("darwin", () => processTable())).walkMs, psTable().walkMs);
    assert.equal((await onPlatform("linux", () => processTable())).walkMs, procTable().walkMs);
  });

  it("on Linux, reads real processes as /proc does: parent, group, children, mark; start to the second", { skip: !linux && "Linux only" }, async () => {
    const child = spawn("/bin/sh", ["-c", "exec sleep 600"], { detached: true, stdio: "ignore", env: { ...process.env, MARK_TEST: "m-1" } });
    const pid = child.pid ?? 0;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200)); // past the exec, whose environment is the one marked
      const [byPs, byProc] = [psTable(linuxPs).snapshot(), procTable().snapshot()];
      const [ps, proc] = [byPs.info(pid), byProc.info(pid)];
      assert.deepEqual([ps?.ppid, ps?.pgrp], [process.pid, pid]);
      assert.deepEqual([ps?.ppid, ps?.pgrp], [proc?.ppid, proc?.pgrp]);
      assert.ok(Math.abs(ps!.start - Date.now() / 1000) < 30, `started just now: ${ps!.start}`);
      assert.ok(byPs.children(process.pid).includes(pid));
      assert.equal(byPs.marked(pid, "MARK_TEST", "m-1"), true);
      assert.equal(psTable(linuxPs).bootId(), procTable().bootId());
    } finally {
      killQuietly(pid);
    }
  });
});
