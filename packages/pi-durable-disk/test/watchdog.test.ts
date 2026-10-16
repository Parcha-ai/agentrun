// The lease watchdog's parts: the lapse rule on a fake clock, the sweep over a fake /proc, a scripted ps (macOS) and real
// processes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { lapsed, SLOT_BEAT, SLOT_LAPSED, SLOT_LIMIT, sweep } from "../src/watchdog.ts";
import { linuxPs, onPlatform } from "./_macos.ts";
import { alive, killQuietly, scratchRoot, waitGone } from "./_run-support.ts";

const MS = 1_000_000n;

describe("the lapse rule", () => {
  it("lapses once the last successful heartbeat is older than the limit, measured from its start, and stays lapsed", () => {
    const shared = new BigInt64Array(4);
    Atomics.store(shared, SLOT_LIMIT, 800n * MS);
    Atomics.store(shared, SLOT_BEAT, 1_000n * MS);
    assert.equal(lapsed(shared, 1_800n * MS), false, "exactly the limit: not yet");
    Atomics.store(shared, SLOT_BEAT, 1_500n * MS);
    assert.equal(lapsed(shared, 2_250n * MS), false, "a newer heartbeat moves the deadline");
    assert.equal(lapsed(shared, 2_301n * MS), true);
    assert.equal(Atomics.load(shared, SLOT_LAPSED), 801n * MS, "records how old the heartbeat was when it lapsed");
    Atomics.store(shared, SLOT_BEAT, 9_000n * MS);
    assert.equal(lapsed(shared, 9_001n * MS), true, "a heartbeat after the lapse does not revive the lease");
    assert.equal(Atomics.load(shared, SLOT_LAPSED), 801n * MS);
  });
});

/** A fake /proc: `stat` files for the given processes and a cgroup file for the instance. */
function fakeProc(root: string, procs: Array<{ pid: number; comm: string; ppid: number; pgrp: number }>, cgroup?: { path: string; procs: number[] }) {
  const proc = join(root, "proc");
  const sys = join(root, "sys");
  for (const p of procs) {
    mkdirSync(join(proc, String(p.pid)), { recursive: true });
    writeFileSync(join(proc, String(p.pid), "stat"), `${p.pid} (${p.comm}) S ${p.ppid} ${p.pgrp} ${p.pgrp} 0 -1 4194560\n`);
  }
  mkdirSync(join(proc, "self"), { recursive: true });
  if (cgroup) {
    writeFileSync(join(proc, String(procs[0]!.pid), "cgroup"), `0::${cgroup.path}\n`);
    mkdirSync(join(sys, cgroup.path), { recursive: true });
    writeFileSync(join(sys, cgroup.path, "cgroup.procs"), `${cgroup.procs.join("\n")}\n`);
  }
  return { proc, sys };
}

describe("the sweep", () => {
  const procs = [
    { pid: 100, comm: "node", ppid: 1, pgrp: 100 }, // the instance
    { pid: 200, comm: "bash) (x y", ppid: 100, pgrp: 200 }, // a command, leader of its own group
    { pid: 201, comm: "sleep", ppid: 200, pgrp: 200 }, // that command's child: reached through the group
    { pid: 300, comm: "helper", ppid: 100, pgrp: 100 }, // a child in the instance's own group: the pid alone
    { pid: 400, comm: "other", ppid: 1, pgrp: 400 }, // not the instance's
  ];

  it("never signals group 1: a direct child in it is killed alone (kill(-1) would reach every process the user may signal)", () => {
    const dir = scratchRoot("sweep-group-1");
    try {
      // In a container whose init's group is in the instance's session, a child can join group 1.
      const { proc, sys } = fakeProc(dir.root, [{ pid: 100, comm: "node", ppid: 1, pgrp: 100 }, { pid: 600, comm: "joined", ppid: 100, pgrp: 1 }]);
      const sent: number[] = [];
      assert.equal(sweep(100, { proc, sys, kill: (pid) => void sent.push(pid) }), 1);
      assert.deepEqual(sent, [600]);
    } finally {
      dir.remove();
    }
  });

  it("kills each direct child's process group, a child in the instance's group alone, never the instance or its group", () => {
    const dir = scratchRoot("sweep");
    try {
      const { proc, sys } = fakeProc(dir.root, procs, { path: "/user.slice/session.scope", procs: [100, 200, 201, 300, 400, 500] });
      const sent: number[] = [];
      assert.equal(sweep(100, { proc, sys, kill: (pid) => void sent.push(pid) }), 2);
      assert.deepEqual(sent.sort((a, b) => a - b), [-200, 300]);
    } finally {
      dir.remove();
    }
  });

  it("with ownCgroup also kills every other process of the instance's cgroup", () => {
    const dir = scratchRoot("sweep-cgroup");
    try {
      const { proc, sys } = fakeProc(dir.root, procs, { path: "/system.slice/pda-r1.service", procs: [100, 200, 201, 300, 500] });
      const sent: number[] = [];
      sweep(100, { proc, sys, ownCgroup: true, kill: (pid) => void sent.push(pid) });
      assert.deepEqual(sent.sort((a, b) => a - b), [-200, 200, 201, 300, 500]);
      assert.ok(!sent.includes(100) && !sent.includes(-100), "never the instance");
    } finally {
      dir.remove();
    }
  });

  it("skips what it may not signal and counts what it did", () => {
    const dir = scratchRoot("sweep-eperm");
    try {
      const { proc, sys } = fakeProc(dir.root, procs);
      const refused = (pid: number) => {
        if (pid === 300) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      };
      assert.equal(sweep(100, { proc, sys, kill: refused }), 1);
      assert.equal(sweep(999, { proc, sys, kill: refused }), 0, "an instance it cannot see has nothing to sweep");
    } finally {
      dir.remove();
    }
  });

  it("where there is no /proc (macOS), sweeps from one ps listing the same way, never group 1, and has no cgroup", () => {
    const dir = scratchRoot("sweep-ps");
    try {
      const empty = join(dir.root, "no-proc");
      mkdirSync(empty);
      const rows = [...procs, { pid: 600, comm: "joined", ppid: 100, pgrp: 1 }];
      const calls: string[] = [];
      const ps = (file: string, args: readonly string[]) => {
        calls.push([file, ...args].join(" "));
        return `${rows.map((p) => `  ${p.pid}   ${p.ppid}   ${p.pgrp}`).join("\n")}\n`;
      };
      const sent: number[] = [];
      assert.equal(sweep(100, { proc: empty, ps, ownCgroup: true, kill: (pid) => void sent.push(pid) }), 3);
      assert.deepEqual(sent.sort((a, b) => a - b), [-200, 300, 600]);
      assert.deepEqual(calls, ["/bin/ps -A -o pid=,ppid=,pgid="]);
      assert.equal(sweep(999, { ps, kill: (pid) => void sent.push(pid) }), 0, "an instance it cannot see has nothing to sweep");
      assert.equal(sweep(100, { ps: () => assert.fail("ps failed"), kill: (pid) => void sent.push(pid) }), 0, "nor does a ps that fails");
      assert.equal(sent.length, 3);
    } finally {
      dir.remove();
    }
  });

  const real = (name: string, via: (instance: number) => number | Promise<number>, skip: string | false = false) =>
    it(`kills real commands${name}: a detached group with its grandchild, and a child in the parent's group; the parent lives`, { timeout: 20_000, skip }, async () => {
      const parent = spawn(process.execPath, ["test/fixtures/command-parent.ts"], { stdio: ["ignore", "pipe", "inherit"] });
      let pids: { detached: number; grandchild: number; sameGroup: number } | undefined;
      try {
        pids = JSON.parse((await createInterface({ input: parent.stdout! })[Symbol.asyncIterator]().next()).value as string);
        for (const pid of Object.values(pids!)) assert.ok(alive(pid));
        assert.equal(await via(parent.pid!), 2);
        for (const pid of Object.values(pids!)) assert.ok(await waitGone(pid), `pid ${pid} died`);
        assert.ok(alive(parent.pid!), "the instance itself is never signalled");
      } finally {
        parent.kill("SIGKILL");
        for (const pid of Object.values(pids ?? {})) killQuietly(pid);
      }
    });
  real("", (instance) => sweep(instance));
  const linuxOnly = process.platform !== "linux" && "Linux only";
  real(" through ps, as on macOS (procps)", (instance) => sweep(instance, { ps: linuxPs }), linuxOnly);
  real(" through /bin/ps, as macOS does by default", (instance) => onPlatform("darwin", () => sweep(instance)), linuxOnly);
});

describe("the watchdog in a host started with --input-type=module", () => {
  it("still starts its worker (the worker's source is CommonJS, and the host's flags are not its), and kills the commands when the lease lapses", { timeout: 20_000 }, async () => {
    // a host that runs inline ESM: `node --input-type=module -e ...`, as a script launched through stdin or -e does
    const watchdog = new URL("../src/watchdog.ts", import.meta.url).href;
    const code = `
      import { spawn } from "node:child_process";
      import { LeaseWatchdog } from ${JSON.stringify(watchdog)};
      const command = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
      process.stdout.write(JSON.stringify({ command: command.pid }) + "\\n");
      new LeaseWatchdog({ limitMs: 200, checkMs: 20, beatNs: process.hrtime.bigint() }); // never beats: the lease lapses
      setInterval(() => {}, 60_000);
    `;
    const host = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    host.stderr!.on("data", (chunk: Buffer) => void (stderr += String(chunk)));
    let command: number | undefined;
    try {
      command = (JSON.parse((await createInterface({ input: host.stdout! })[Symbol.asyncIterator]().next()).value as string) as { command: number }).command;
      assert.ok(await waitGone(command), `the command ${command} was killed when the lease lapsed; host stderr: ${stderr.slice(0, 300)}`);
      assert.ok(alive(host.pid!), `the host itself lives; stderr: ${stderr.slice(0, 300)}`);
      assert.doesNotMatch(stderr, /require is not defined/);
    } finally {
      host.kill("SIGKILL");
      if (command !== undefined) killQuietly(command);
    }
  });
});
