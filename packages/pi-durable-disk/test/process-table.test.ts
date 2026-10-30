// The process table: /proc on Linux, ps and sysctl on macOS. The ps table is read here from a scripted ps, and on Linux
// also from procps against real processes; only the macOS CI job runs it against a Mac's own ps.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procTable, processTable, psTable, type CommandRunner } from "../src/process-table.ts";
import { linuxPs, onPlatform } from "./_macos.ts";
import { killQuietly } from "./_run-support.ts";

const linux = process.platform === "linux";

/** A ps and a sysctl that answer from `listing`, `environments` (pid to `ps -E` output: arguments, then environment) and
 *  `boot`, and log each call. Without -E, ps prints a process's arguments alone: the words before its first NAME=value. */
function scripted(listing: string, environments: Record<number, string> = {}, boot = "8C1F3E0A-0B6D-4C47-9A3E-6F0E2D9B7C11\n") {
  const calls: string[] = [];
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "/usr/sbin/sysctl") return boot;
    if (args.includes("-A")) return listing;
    const pid = Number(args[args.indexOf("-p") + 1]);
    if (environments[pid] === undefined) throw new Error(`no process ${pid}`);
    if (args.includes("-E")) return environments[pid]!;
    const words = environments[pid]!.trim().split(/\s+/);
    const env = words.findIndex((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    return `${(env < 0 ? words : words.slice(0, env)).join(" ")}\n`;
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

// A mark read from /proc (procTable), when a process's environment reads empty or cannot be read: the kernel shows no
// environment while a process is inside an exec. The rule: a zombie or a gone process carries nothing (its state is read
// first); another user's unreadable process is none of this server's; one of this uid is read again over about 50 ms
// (MARK_WINDOW_MS) and decided by its first environment that reads, and counts as unmarked after the window.
describe("a mark through /proc, when an environment reads empty or unreadable", () => {
  const MARK = "PI_DURABLE_DISK_COMMANDS";
  const uid = process.getuid?.() ?? 0;
  /** A fake /proc of one process: its status (state, real uid) and an environ answered by `environ()`; counts reads. */
  /** Each fixture's directory, removed after its test whether it passed or not. */
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function oneProcess(pid: number, state: string, ruid: number, environ: () => string, euid = ruid) {
    const root = mkdtempSync(join(tmpdir(), "proc-env-"));
    roots.push(root);
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "status"), `Name:\tcmd\nState:\t${state} (x)\nUid:\t${ruid}\t${euid}\t${euid}\t${euid}\n`);
    writeFileSync(join(root, String(pid), "stat"), `${pid} (cmd) ${state} 1 ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0 0\n`);
    const reads = { environ: 0 };
    const read = (path: string) => {
      if (path.endsWith("/environ")) {
        reads.environ++;
        return environ();
      }
      return readFileSync(path, "utf8");
    };
    return { table: procTable(root, read), reads };
  }

  it("(1) an environment that reads empty for 30 ms (an exec) and then fills in is read again in the window, and marked", () => {
    // The 30 ms run from the first read, so a slow setup (a loaded machine) cannot use them up before the exec is seen.
    let start = 0;
    const { table, reads } = oneProcess(4800, "S", uid, () => ((start ||= Date.now()), Date.now() - start < 30 ? "" : `PATH=/usr/bin\0${MARK}=tok\0`));
    assert.deepEqual(table.snapshot().withMark(MARK, "tok"), [4800]);
    assert.ok(reads.environ > 1, "read again");
  });

  it("(2) an environment of this uid that stays empty is unmarked after the window, decided in well under 500 ms", () => {
    const { table, reads } = oneProcess(4801, "S", uid, () => "");
    const start = Date.now();
    assert.deepEqual(table.snapshot().withMark(MARK, "tok"), []);
    const took = Date.now() - start;
    assert.ok(took < 500, `took ${took} ms`);
    assert.equal(reads.environ, 6, "the first read and the five of the window");
    assert.equal(oneProcess(4802, "S", uid, () => "").table.snapshot().marked(4802, MARK, "tok"), false, "the recorder's read too");
  });

  it("the recorder's read (marked) of an environment of this uid that stays empty is one read, never the window: its next walk reads it again", () => {
    const { table, reads } = oneProcess(4805, "S", uid, () => "");
    assert.equal(table.snapshot().marked(4805, MARK, "tok"), false);
    assert.equal(reads.environ, 1);
  });

  it("(3) a real zombie of a marked command carries nothing: its state is read first and its environment never", { skip: !linux && "Linux only" }, async () => {
    // The command execs sleep, which never waits for the child it was left with: that child, once it exits, is a zombie.
    const child = spawn("/bin/sh", ["-c", "sleep 0 & exec sleep 30"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", [MARK]: "tok" } });
    try {
      let zombie = 0;
      for (let i = 0; i < 500 && !zombie; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const kids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
        zombie = kids.find((k) => /^State:\s*Z/m.test(readFileSync(`/proc/${k}/status`, "utf8"))) ?? 0;
      }
      assert.ok(zombie > 0, "a zombie to read");
      const environReads = new Map<string, number>();
      const table = procTable("/proc", (path) => {
        if (path.endsWith("/environ")) environReads.set(path, (environReads.get(path) ?? 0) + 1);
        return readFileSync(path, "utf8");
      });
      const marked = table.snapshot().withMark(MARK, "tok");
      assert.ok(marked.includes(child.pid!), "the live command is marked");
      assert.ok(!marked.includes(zombie), "the zombie is not");
      assert.equal(environReads.get(`/proc/${zombie}/environ`) ?? 0, 0, "the zombie's environment is never read");
    } finally {
      killQuietly(child.pid!);
    }
  });

  it("(4) another user's process whose environment cannot be read is unmarked, read once", () => {
    const { table, reads } = oneProcess(4803, "S", uid + 1, () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    assert.deepEqual(table.snapshot().withMark(MARK, "tok"), []);
    assert.equal(reads.environ, 1);
  });

  it("a setuid exec of this uid's command (its REAL uid ours, its effective uid another) is judged by the real uid: read in the window", () => {
    // The 20 ms run from the first read, as in (1).
    let start = 0;
    const { table, reads } = oneProcess(4804, "S", uid, () => {
      start ||= Date.now();
      if (Date.now() - start < 20) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return `${MARK}=tok\0`;
    }, uid + 1);
    assert.deepEqual(table.snapshot().withMark(MARK, "tok"), [4804]);
    assert.ok(reads.environ > 1);
  });
});
