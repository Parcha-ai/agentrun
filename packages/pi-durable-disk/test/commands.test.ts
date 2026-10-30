// The command records of a run that nothing else cleans up after (a local run): CommandRecorder walks this process's
// tree and records each command group; reapCommands ends, at the next open, only what is still the recorded process.
// The tests on real processes run through this machine's process table and, on Linux, through the one macOS uses (ps),
// played by procps; the macOS CI job runs them against a Mac's own ps.
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS_MARK, CommandRecorder, reapCommands, reapOrRefuse, type CommandRecord } from "../src/commands.ts";
import { HeldError } from "../src/errors.ts";
import { processTable, procTable, psTable, type CommandRunner, type ProcessTable } from "../src/process-table.ts";
import { linuxPs } from "./_macos.ts";
import { alive, scratchRoot, waitGone } from "./_run-support.ts";

const COMMANDS = fileURLToPath(new URL("../src/commands.ts", import.meta.url));
const PROCESS_TABLE = fileURLToPath(new URL("../src/process-table.ts", import.meta.url));
const MACOS = fileURLToPath(new URL("./_macos.ts", import.meta.url));
/** A command record's file (`<pid>-<start>.json`), not the recorder's mark (`mark-<token>.json`). */
const isRecord = (name: string) => /^\d+-\d+\.json$/.test(name);

/** A command the way a recorded environment starts one: the leader of its own group, carrying `token` as its mark, here with a member that is its own child. */
function command(token?: string): ChildProcess {
  const env = token === undefined ? process.env : { ...process.env, [COMMANDS_MARK]: token };
  return spawn("/bin/sh", ["-c", "sleep 600 & exec sleep 600"], { detached: true, stdio: "ignore", env });
}

/** SIGKILL the group a test's command leads; only a real pid (`kill(-0)` would be this process's own group). */
function killGroup(pid: number): void {
  if (!(pid > 0)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // gone already
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "in time");
}

const tables: { name: string; kind: "machine" | "ps"; table: ProcessTable }[] = [{ name: "this machine's process table", kind: "machine", table: processTable() }];
if (process.platform === "linux") tables.push({ name: "ps, as on macOS (procps over /proc)", kind: "ps", table: psTable(linuxPs) });

for (const { name: tableName, kind, table } of tables) describe(`command records, through ${tableName}`, () => {
  const boot = table.bootId()!;
  const startOf = (pid: number) => table.snapshot().info(pid)!.start;
  // A walk through ps costs a listing: fewer of them.
  const everyMs = table.walkMs <= 100 ? 20 : 100;
  const via = { table };

  it("records a command group's leader and its members, and the next open kills both and clears the records", async () => {
    const dir = scratchRoot("commands-record");
    const records = join(dir.root, "commands");
    const recorder = new CommandRecorder(records, { ...via, everyMs });
    const child = command(recorder.token);
    const leader = child.pid ?? 0;
    try {
      recorder.started();
      const read = () => (existsSync(records) ? readdirSync(records).filter(isRecord) : []);
      await until(() => read().length === 1 && (JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord).members.length > 0);
      const record = JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord;
      assert.deepEqual([record.boot, record.leader], [boot, { pid: leader, start: startOf(leader) }]);
      const member = record.members[0]!;
      recorder.close();
      // The leader's group, and the member unless the group's kill already took it (then it is no longer the same process).
      const reaped = await reapCommands(records, via);
      assert.deepEqual(reaped.survivors, []);
      assert.ok(reaped.signalled === 1 || reaped.signalled === 2, `signalled ${reaped.signalled}`);
      assert.ok((await waitGone(leader)) && (await waitGone(member.pid)), "both are gone when the reap returns");
      assert.equal(existsSync(records), false, "the records are cleared");
    } finally {
      killGroup(leader);
      dir.remove();
    }
  });

  it("kills nothing a record names on another boot, with other start ticks, or in a torn file", async () => {
    const dir = scratchRoot("commands-strangers");
    const records = join(dir.root, "commands");
    const child = command();
    const pid = child.pid ?? 0;
    try {
      mkdirSync(records);
      const start = startOf(pid);
      const write = (name: string, record: CommandRecord | string) => writeFileSync(join(records, name), typeof record === "string" ? record : JSON.stringify(record));
      write(`${pid}-1.json`, { boot: "another-boot", leader: { pid, start }, members: [{ pid, start }] });
      write(`${pid}-2.json`, { boot, leader: { pid, start: start + 1 }, members: [{ pid, start: start + 1 }] });
      write(`${pid}-3.json`, '{"boot":"');
      assert.deepEqual(await reapCommands(records, via), { signalled: 0, survivors: [] });
      assert.ok(alive(pid), "a process no record names exactly is left alone");
      assert.equal(existsSync(records), false, "and the records are cleared all the same");
    } finally {
      killGroup(pid);
      dir.remove();
    }
  });

  it("never signals pid 1, whatever a record names (kill(-1) would reach every process the user may signal)", async () => {
    const dir = scratchRoot("commands-pid1");
    const records = join(dir.root, "commands");
    try {
      mkdirSync(records);
      const init = { pid: 1, start: startOf(1) };
      writeFileSync(join(records, `1-${init.start}.json`), JSON.stringify({ boot, leader: init, members: [init] }));
      const signals: number[] = [];
      assert.deepEqual(await reapCommands(records, { ...via, kill: (target) => void signals.push(target), timeoutMs: 50 }), { signalled: 0, survivors: [] });
      assert.deepEqual(signals, [], "no signal at all");
    } finally {
      dir.remove();
    }
  });

  it("never signals the reaping process or its group, whatever a record names", () => {
    // In a child that leads its own group, so a regression kills only it.
    const script = `import { mkdirSync, writeFileSync } from "node:fs";
import { reapCommands } from ${JSON.stringify(COMMANDS)};
import { processTable, psTable } from ${JSON.stringify(PROCESS_TABLE)};
import { linuxPs } from ${JSON.stringify(MACOS)};
const dir = process.argv[1];
const table = process.argv[2] === "ps" ? psTable(linuxPs) : processTable();
mkdirSync(dir, { recursive: true });
const boot = table.bootId();
const start = table.snapshot().info(process.pid).start;
const self = { pid: process.pid, start };
writeFileSync(dir + "/" + process.pid + "-" + start + ".json", JSON.stringify({ boot, leader: self, members: [self, { pid: 0, start: 0 }, { pid: -1, start: 0 }] }));
const reaped = await reapCommands(dir, { table, timeoutMs: 200 });
process.stdout.write("still here, " + JSON.stringify(reaped));`;
    const dir = scratchRoot("commands-self");
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(dir.root, "commands"), kind], { encoding: "utf8", timeout: 20_000, detached: true } as never);
      assert.equal(child.signal, null, `the reap killed its own process or group (${child.signal})`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'still here, {"signalled":0,"survivors":[]}');
    } finally {
      dir.remove();
    }
  });

  it("two environments in one process record only their own commands, and reaping one leaves the other's alive", async () => {
    const dir = scratchRoot("commands-two");
    const [a, b] = [join(dir.root, "a"), join(dir.root, "b")];
    const [recorderA, recorderB] = [new CommandRecorder(a, { ...via, everyMs }), new CommandRecorder(b, { ...via, everyMs })];
    const [childA, childB, foreign] = [command(recorderA.token), command(recorderB.token), command()];
    const pids = [childA, childB, foreign].map((c) => c.pid ?? 0);
    try {
      recorderA.started();
      recorderB.started();
      const leaders = (records: string) => (existsSync(records) ? readdirSync(records).filter(isRecord).map((name) => Number(name.split("-")[0])) : []);
      await until(() => leaders(a).length === 1 && leaders(b).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100)); // more walks: none records another's command
      recorderA.close();
      recorderB.close();
      assert.deepEqual([leaders(a), leaders(b)], [[pids[0]], [pids[1]]], "each records its own command, and neither the other's nor the unmarked one");
      assert.deepEqual((await reapCommands(b, via)).survivors, []);
      assert.deepEqual(pids.map((pid) => alive(pid)), [true, false, true], "reaping b's records killed only b's command");
    } finally {
      for (const pid of pids) killGroup(pid);
      dir.remove();
    }
  });

  it("a walk that cannot write its record says so once, never out of a timer, and keeps trying", async () => {
    const dir = scratchRoot("commands-unwritable");
    const records = join(dir.root, "commands");
    writeFileSync(records, "a file where the directory goes: every record write fails");
    const errors: unknown[] = [];
    const recorder = new CommandRecorder(records, { ...via, everyMs, onError: (error) => void errors.push(error) });
    const child = command(recorder.token);
    try {
      recorder.started();
      await until(() => errors.length > 0);
      await new Promise((resolve) => setTimeout(resolve, everyMs * 5)); // more failing walks
      assert.equal(errors.length, 1, "reported once over many failing walks");
      rmSync(records);
      await until(() => existsSync(records) && readdirSync(records).some((name) => name.startsWith(`${child.pid}-`)));
      recorder.close();
    } finally {
      killGroup(child.pid ?? 0);
      dir.remove();
    }
  });

  it("follows a background worker after its leader exits: a child it starts later is recorded, and reaped", async () => {
    const dir = scratchRoot("commands-worker");
    const records = join(dir.root, "commands");
    const late = join(dir.root, "late.pid");
    const recorder = new CommandRecorder(records, { ...via, everyMs });
    // The leader exits at 0.2 s (later where a walk is a ps listing, so one sees it first); its background worker (same
    // group) starts `sleep 600` 0.4 s after and waits on it.
    const life = table.walkMs > 100 ? 1.5 : 0.2;
    const script = `sh -c 'sleep ${life + 0.4}; sleep 600 & echo $! > ${late}; wait' & sleep ${life}`;
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, [COMMANDS_MARK]: recorder.token } });
    const group = child.pid ?? 0;
    let latePid = 0;
    try {
      recorder.started();
      await until(() => existsSync(late) && readFileSync(late, "utf8").trim() !== "");
      latePid = Number(readFileSync(late, "utf8"));
      assert.equal(alive(group), false, "the leader has exited");
      const recorded = () =>
        (existsSync(records) ? readdirSync(records).filter(isRecord) : []).map((name) => JSON.parse(readFileSync(join(records, name), "utf8")) as CommandRecord);
      await until(() => recorded()[0]?.members.some((m) => m.pid === latePid) === true); // a walk after the late child started
      recorder.close();
      const [record] = recorded();
      assert.ok(record!.members.some((m) => m.pid === latePid), `the late child is recorded: ${JSON.stringify(record)}`);
      const reaped = await reapCommands(records, via);
      assert.deepEqual(reaped.survivors, []);
      assert.ok(await waitGone(latePid), "and killed by the reap, with no live leader to kill its group through");
    } finally {
      killGroup(group); // the worker and its child are still in the leader's group
      dir.remove();
    }
  });

  it("records only children that lead their own group", async () => {
    const dir = scratchRoot("commands-not-commands");
    const records = join(dir.root, "commands");
    const inGroup = spawn("sleep", ["600"], { stdio: "ignore" }); // this process's group: not a command
    try {
      const recorder = new CommandRecorder(records, { ...via, everyMs });
      recorder.started();
      await new Promise((resolve) => setTimeout(resolve, 150));
      recorder.close();
      const names = existsSync(records) ? readdirSync(records) : [];
      assert.ok(!names.some((name) => name.startsWith(`${inGroup.pid}-`)), `recorded a child of this group: ${names.join(", ")}`);
    } finally {
      inGroup.kill("SIGKILL");
      dir.remove();
    }
  });
});

describe("command records, from a scripted /proc", () => {
  it("keeps the record of a process still alive at the deadline, returns it, and the next open tries again", async () => {
    // A process in an uninterruptible wait outlives SIGKILL for a while: here a /proc where it stays, and a kill that only counts.
    const dir = scratchRoot("commands-survivor");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const fields = (state: string, pgrp: number, start: number) => [state, "1", String(pgrp), ...Array(16).fill("0"), String(start)].join(" ");
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), `4242 (stuck (in D)) ${fields("D", 4242, 77)}\n`);
      mkdirSync(records);
      const leader = { pid: 4242, start: 77 };
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader, members: [leader, { pid: 4243, start: 78 }] }));
      const signals: [number, string][] = [];
      const kill = (target: number, signal: NodeJS.Signals) => void signals.push([target, signal]);
      assert.deepEqual(await reapCommands(records, { proc, kill, timeoutMs: 100 }), { signalled: 1, survivors: [leader] });
      assert.deepEqual(signals, [[-4242, "SIGKILL"]], "the leader's group once (the leader listed as a member too goes with it); 4243 is gone already");
      assert.deepEqual(JSON.parse(readFileSync(join(records, "4242-77.json"), "utf8")), { boot: "fake-boot", leader, members: [] }, "rewritten with what is alive");
      rmSync(join(proc, "4242"), { recursive: true }); // it died after the deadline
      assert.deepEqual(await reapCommands(records, { proc, kill, timeoutMs: 100 }), { signalled: 0, survivors: [] });
      assert.equal(existsSync(records), false, "the next open clears it once nothing in it is alive");
    } finally {
      dir.remove();
    }
  });

  it("waits for every process of a killed group, one never recorded included, before it says the group is gone", async () => {
    // A command's child that the instance had not seen when it was killed: in the leader's group, in no record. SIGKILL to
    // the group reaches it, but it can die after the leader: here its /proc entry stays 100 ms after the kill.
    const dir = scratchRoot("commands-group");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const stat = (pid: number, comm: string, pgrp: number, start: number) => `${pid} (${comm}) ${["S", "1", String(pgrp), ...Array(16).fill("0"), String(start)].join(" ")}\n`;
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), stat(4242, "sh", 4242, 77));
      mkdirSync(join(proc, "4250"));
      writeFileSync(join(proc, "4250", "stat"), stat(4250, "sleep", 4242, 80));
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      const kill = (target: number) => {
        if (target !== -4242) return;
        rmSync(join(proc, "4242"), { recursive: true }); // the leader dies at once
        setTimeout(() => rmSync(join(proc, "4250"), { recursive: true }), 100); // its child a little later
      };
      const reaped = await reapCommands(records, { proc, kill });
      assert.equal(existsSync(join(proc, "4250")), false, "it said the group was gone while a process of it was still alive");
      assert.deepEqual(reaped, { signalled: 1, survivors: [] });
      assert.equal(existsSync(records), false, "and cleared the record once nothing in the group was alive");
    } finally {
      dir.remove();
    }
  });

  it("a process of a killed group still alive at the deadline, one never recorded included, is a survivor and is recorded for the next open", async () => {
    const dir = scratchRoot("commands-group-survivor");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const stat = (pid: number, comm: string, state: string, pgrp: number, start: number) => `${pid} (${comm}) ${[state, "1", String(pgrp), ...Array(16).fill("0"), String(start)].join(" ")}\n`;
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), stat(4242, "sh", "S", 4242, 77));
      mkdirSync(join(proc, "4250"));
      writeFileSync(join(proc, "4250", "stat"), stat(4250, "tar", "D", 4242, 80)); // in an uninterruptible wait
      mkdirSync(join(proc, "4260"));
      writeFileSync(join(proc, "4260", "stat"), stat(4260, "other", "S", 4260, 90)); // another group: never a target
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      const kill = (target: number) => { if (target === -4242) rmSync(join(proc, "4242"), { recursive: true }); };
      assert.deepEqual(await reapCommands(records, { proc, kill, timeoutMs: 100 }), { signalled: 1, survivors: [{ pid: 4250, start: 80 }] });
      assert.deepEqual(JSON.parse(readFileSync(join(records, "4242-77.json"), "utf8")), { boot: "fake-boot", leader: null, members: [{ pid: 4250, start: 80 }] }, "recorded, so the next open tries again");
      rmSync(join(proc, "4250"), { recursive: true }); // it died after the deadline
      assert.deepEqual(await reapCommands(records, { proc, kill, timeoutMs: 100 }), { signalled: 0, survivors: [] });
      assert.equal(existsSync(records), false);
    } finally {
      dir.remove();
    }
  });

  it("a group id handed to an unrelated group after the kill is never taken for the killed group: its processes are no targets", async () => {
    // The killed leader 4242 is gone at once, and its pid now leads an unrelated group with a child of its own, 4270. That
    // group's processes are not the record's: neither waited for, nor kept as targets for the next open's SIGKILL.
    const dir = scratchRoot("commands-group-reused");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const stat = (pid: number, comm: string, pgrp: number, start: number) => `${pid} (${comm}) ${["S", "1", String(pgrp), ...Array(16).fill("0"), String(start)].join(" ")}\n`;
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), stat(4242, "sh", 4242, 77));
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      const kill = (target: number) => {
        if (target !== -4242) return;
        writeFileSync(join(proc, "4242", "stat"), stat(4242, "other", 4242, 300)); // the pid, handed out again
        mkdirSync(join(proc, "4270"));
        writeFileSync(join(proc, "4270", "stat"), stat(4270, "child", 4242, 301));
      };
      assert.deepEqual(await reapCommands(records, { proc, kill, timeoutMs: 100 }), { signalled: 1, survivors: [] }, "the unrelated group's child is no survivor");
      assert.equal(existsSync(records), false, "and nothing of it is kept for the next open");
    } finally {
      dir.remove();
    }
  });

  it("a leader that stops being the recorded process while its group is read is not killed, and nothing listed is kept", async () => {
    // Between the first look at 4242 and the look before its kill, its pid is handed to another process (its start
    // changes): the group read in between may hold that process's group, so the group is neither killed nor kept.
    let leaderLooks = 0;
    const table: ProcessTable = {
      walkMs: 100,
      bootId: () => "fake-boot",
      snapshot: () => ({
        info: (pid) => (pid === 4242 ? { ppid: 1, pgrp: 4242, start: ++leaderLooks === 1 ? 77 : 300 } : pid === 4270 ? { ppid: 4242, pgrp: 4242, start: 301 } : undefined),
        children: () => [],
        group: (pgrp) => (pgrp === 4242 ? [4242, 4270] : []),
        marked: () => false,
        withMark: () => [],
        commandLine: () => "?",
      }),
    };
    const dir = scratchRoot("commands-leader-changed");
    const records = join(dir.root, "commands");
    try {
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      const signals: number[] = [];
      assert.deepEqual(await reapCommands(records, { table, kill: (target) => void signals.push(target), timeoutMs: 100 }), { signalled: 0, survivors: [] });
      assert.deepEqual(signals, [], "no SIGKILL to a group its leader no longer holds");
    } finally {
      dir.remove();
    }
  });

  it("a recorded command is never dropped on an empty read of its environment (inside an exec); it leaves its record once it is a zombie", () => {
    // Through /proc: 4200 is the instance, 4300 its command leading its own group. The first walk reads the mark and
    // records 4300; the next reads an empty environment (an exec) and must keep the record; once 4300 is a zombie (its
    // state read first), the record goes.
    const dir = scratchRoot("commands-recorded-empty-read");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const uid = process.getuid!();
    const stat = (pid: number, state: string, ppid: number, pgrp: number, start: number) => `${pid} (cmd) ${[state, String(ppid), String(pgrp), ...Array(16).fill("0"), String(start)].join(" ")}\n`;
    const status = (state: string) => `Name:\tcmd\nState:\t${state} (x)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4200/task/4200"), { recursive: true });
      writeFileSync(join(proc, "4200/stat"), stat(4200, "S", 1, 4200, 10));
      writeFileSync(join(proc, "4200/task/4200/children"), "4300 ");
      mkdirSync(join(proc, "4300"));
      const recorder = new CommandRecorder(records, { proc, instance: 4200 });
      const at = (state: string, environ: string) => {
        writeFileSync(join(proc, "4300/stat"), stat(4300, state, 4200, 4300, 77));
        writeFileSync(join(proc, "4300/status"), status(state));
        writeFileSync(join(proc, "4300/environ"), environ);
      };
      at("S", `PATH=/usr/bin\0${COMMANDS_MARK}=${recorder.token}\0`);
      recorder.scan();
      assert.deepEqual(readdirSync(records).filter(isRecord), ["4300-77.json"], "recorded from its mark");
      at("S", "");
      recorder.scan();
      recorder.scan();
      assert.deepEqual(readdirSync(records).filter(isRecord), ["4300-77.json"], "an empty read keeps a recorded command");
      at("Z", "");
      recorder.scan();
      recorder.close();
      assert.deepEqual(readdirSync(records).filter(isRecord), [], "a zombie leaves its record");
    } finally {
      dir.remove();
    }
  });

  it("a recorded pid the kernel gave to another process (its start time differs) is gone: the walk drops its record, and a reap never signals the stranger", async () => {
    // 4300 is recorded with start 77, exits, and its number goes to a new process (start 99) whose environment reads
    // non-empty and lacks the word. Only the start time tells the two apart.
    const dir = scratchRoot("commands-recorded-pid-reused");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    const uid = process.getuid!();
    const stat = (pid: number, ppid: number, pgrp: number, start: number) => `${pid} (cmd) ${["S", String(ppid), String(pgrp), ...Array(16).fill("0"), String(start)].join(" ")}\n`;
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4200/task/4200"), { recursive: true });
      writeFileSync(join(proc, "4200/stat"), stat(4200, 1, 4200, 10));
      writeFileSync(join(proc, "4200/task/4200/children"), "4300 ");
      mkdirSync(join(proc, "4300"));
      writeFileSync(join(proc, "4300/status"), `Name:\tcmd\nState:\tS (x)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      const recorder = new CommandRecorder(records, { proc, instance: 4200 });
      writeFileSync(join(proc, "4300/stat"), stat(4300, 4200, 4300, 77));
      writeFileSync(join(proc, "4300/environ"), `PATH=/usr/bin\0${COMMANDS_MARK}=${recorder.token}\0`);
      recorder.scan();
      assert.deepEqual(readdirSync(records).filter(isRecord), ["4300-77.json"]);
      const recorded = readFileSync(join(records, "4300-77.json"), "utf8");
      // The stranger: the same pid, leading its own group, started later, its environment without the word.
      writeFileSync(join(proc, "4300/stat"), stat(4300, 4200, 4300, 99));
      writeFileSync(join(proc, "4300/environ"), "PATH=/usr/bin\0HOME=/tmp\0");
      recorder.scan();
      recorder.close();
      assert.deepEqual(readdirSync(records).filter(isRecord), [], "the walk drops a record whose pid now has another start time");
      // An instance killed before that walk leaves the record behind: the reap at the next open must not signal 4300.
      writeFileSync(join(records, "4300-77.json"), recorded);
      const signals: number[] = [];
      assert.deepEqual(await reapCommands(records, { proc, kill: (target) => void signals.push(target), timeoutMs: 50 }), { signalled: 0, survivors: [] });
      assert.deepEqual(signals, [], "no SIGKILL to the process that took the recorded pid");
    } finally {
      dir.remove();
    }
  });

  it("an open refuses the run while a process a killed incarnation left is still alive, and keeps its record", async () => {
    const dir = scratchRoot("commands-refuse");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "commands");
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), `4242 (stuck) ${["D", "1", "4242", ...Array(16).fill("0"), "77"].join(" ")}\n`);
      writeFileSync(join(proc, "4242", "cmdline"), "tar\0-xf\0/mnt/slow/archive.tar\0");
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      await assert.rejects(reapOrRefuse(records, { proc, kill: () => {}, timeoutMs: 50 }), (error: unknown) => {
        assert.ok(error instanceof HeldError && error.holder === "commands" && error.code === "COMMANDS_ALIVE" && error.exitCode === 76);
        assert.match(error.message, /pid 4242 \(tar -xf \/mnt\/slow\/archive\.tar\)/, "names each survivor and its command line");
        assert.match(error.message, /End them \(kill -9 4242, as their owner, or wait for them\) and open the run again/, "says what to do");
        return true;
      });
      assert.ok(existsSync(join(records, "4242-77.json")), "its record stays for the next open");
      rmSync(join(proc, "4242"), { recursive: true });
      assert.deepEqual(await reapOrRefuse(records, { proc, kill: () => {} }), { signalled: 0, survivors: [] });
    } finally {
      dir.remove();
    }
  });

  it("the README quotes the refusal exactly as an open writes it", async () => {
    const dir = scratchRoot("commands-readme");
    const proc = join(dir.root, "proc");
    const records = join(dir.root, "run", "commands");
    try {
      mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(proc, "sys/kernel/random/boot_id"), "fake-boot\n");
      mkdirSync(join(proc, "4242"));
      writeFileSync(join(proc, "4242", "stat"), `4242 (tar) ${["D", "1", "4242", ...Array(16).fill("0"), "77"].join(" ")}\n`);
      writeFileSync(join(proc, "4242", "cmdline"), "tar\0-xf\0/mnt/slow/archive.tar\0");
      mkdirSync(records, { recursive: true });
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      const refusal = await reapOrRefuse(records, { proc, kill: () => {}, timeoutMs: 50 }).then(
        () => assert.fail("the open was not refused"),
        (error: unknown) => (error as Error).message,
      );
      const readme = readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8");
      const quoted = refusal.replaceAll(records, "<root>/commands");
      assert.ok(readme.includes(`\n${quoted}\n`), `the reference's refusal is not the one the open writes:\n${quoted}`);
    } finally {
      dir.remove();
    }
  });
});

describe("command records, from a scripted ps (macOS)", () => {
  /** A ps and sysctl that answer from `rows()` (`pid ppid pgid second`: the second it started at) and `environments`; a
   *  row's state is `S` unless `options.states` names another (`Z`: a zombie). */
  /** `environments`: a process's `ps -E -o command=` line (arguments, then environment). Its arguments alone (`ps -o
   *  command=`) are `argv[pid]` when given, else the words before the first NAME=value word. */
  function scriptedPs(rows: () => number[][], environments: Record<number, string> = {}, options: { failListing?: boolean; failMarks?: boolean; states?: Record<number, string>; argv?: Record<number, string | string[]>; envReads?: Record<number, string[]>; ruids?: Record<number, number> } = {}): CommandRunner {
    const lstart = (second: number) => `Thu Oct 15 06:00:${String(second).padStart(2, "0")} 2026`;
    // A list of arguments answers the process's reads without -E in turn, its last answer from then on: a process that
    // exec'd between two reads.
    const reads = new Map<number, number>();
    const argvOf = (pid: number, text: string) => {
      const given = options.argv?.[pid];
      if (Array.isArray(given)) {
        const n = reads.get(pid) ?? 0;
        reads.set(pid, n + 1);
        return given[Math.min(n, given.length - 1)]!;
      }
      if (given !== undefined) return given;
      const words = text.trim().split(/\s+/);
      const env = words.findIndex((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      return (env < 0 ? words : words.slice(0, env)).join(" ");
    };
    // A list of -E lines answers the process's -E reads in turn, its last answer from then on: an environment that reads
    // empty (inside an exec) and then fills in.
    const envReads = new Map<number, number>();
    const eOf = (pid: number) => {
      const given = options.envReads?.[pid];
      if (given === undefined) return environments[pid];
      const n = envReads.get(pid) ?? 0;
      envReads.set(pid, n + 1);
      return given[Math.min(n, given.length - 1)]!;
    };
    const ruidOf = (pid: number) => options.ruids?.[pid] ?? process.getuid!();
    return (file, args) => {
      if (file === "/usr/sbin/sysctl") return "boot-1\n";
      if (args.includes("-E") && args.includes("-A") && options.failMarks) throw new Error("ps: cannot list environments");
      const columns = args.find((a) => /^pid=,(ruid=,)?command=$/.test(a));
      if (args.includes("-A") && columns !== undefined) {
        return rows().flatMap(([pid]) => {
          const text = environments[pid!];
          if (text === undefined) return [];
          const shown = args.includes("-E") ? eOf(pid!)!.trim() : argvOf(pid!, text);
          return [columns.includes("ruid") ? `${pid} ${ruidOf(pid!)} ${shown}` : `${pid} ${shown}`];
        }).join("\n");
      }
      if (args.includes("-A")) {
        if (options.failListing) throw new Error("ps: cannot list processes");
        return rows().map(([pid, ppid, pgrp, second]) => `${pid} ${ppid} ${pgrp} ${options.states?.[pid!] ?? "S"} ${lstart(second!)}`).join("\n");
      }
      const pid = Number(args[args.indexOf("-p") + 1]);
      const text = environments[pid];
      if (text === undefined) throw new Error("no such process");
      return args.includes("-E") ? eOf(pid)! : `${argvOf(pid, text)}\n`;
    };
  }
  const startAt = (second: number) => Date.UTC(2026, 9, 15, 6, 0, second) / 1000;

  it("a mark is read from a process's environment only: a token in its arguments is none, and a process that exec'd between the two reads proves nothing, so a listing of marks will not pass it as unmarked", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    const rows = [[4400, 1, 4400, 5], [4401, 1, 4401, 6], [4402, 1, 4402, 7]];
    const environments: Record<number, string> = {
      // Its arguments name the token; its environment does not.
      4400: `/bin/echo ${word} LANG=C\n`,
      // It exec'd between the two reads: its arguments were `sh -c held`, the -E line is the new program's.
      4401: `sleep 600 ${word} LANG=C\n`,
      // Its environment holds the mark.
      4402: `sleep 600 LANG=C ${word}\n`,
    };
    const table = psTable(scriptedPs(() => rows, environments, { argv: { 4400: `/bin/echo ${word}`, 4401: "sh -c held" } }));
    const look = table.snapshot();
    assert.deepEqual([4400, 4401, 4402].map((pid) => look.marked(pid, COMMANDS_MARK, token)), [false, false, true]);
    // 4401's arguments never open its -E line, which holds the mark's word: whether it carries the mark is unknown, and
    // unknown is never unmarked.
    assert.throws(() => look.withMark(COMMANDS_MARK, token), /cannot tell whether pid 4401 carries the mark/);
    const settled = psTable(scriptedPs(() => rows.filter(([pid]) => pid !== 4401), environments, { argv: { 4400: `/bin/echo ${word}` } }));
    assert.deepEqual(settled.snapshot().withMark(COMMANDS_MARK, token), [4402]);
  });

  it("a process that exec'd between the reads into arguments that extend its old ones is not marked by the words it added", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    const rows = [[4500, 1, 4500, 5]];
    // Its arguments were `sh -c held`; it exec'd into `sh -c held <mark>`, which the old arguments open, and the -E line is
    // the new program's. Only the arguments read after the -E line show the exec.
    const environments: Record<number, string> = { 4500: `sh -c held ${word} LANG=C\n` };
    const argv = { 4500: ["sh -c held", `sh -c held ${word}`] };
    assert.equal(psTable(scriptedPs(() => rows, environments, { argv })).snapshot().marked(4500, COMMANDS_MARK, token), false);
    assert.deepEqual(psTable(scriptedPs(() => rows, environments, { argv })).snapshot().withMark(COMMANDS_MARK, token), []);
  });

  /** `run`, counting its listings of every process's environment. */
  const countingEnvironments = (run: CommandRunner) => {
    const counted = { reads: 0 };
    const counting: CommandRunner = (file, args) => {
      if (args.includes("-E") && args.includes("-A")) counted.reads++;
      return run(file, args);
    };
    return { run: counting, counted };
  };

  it("a marked process whose arguments change in every read keeps the mark and the records, signals nothing, and the open is refused", async () => {
    const dir = scratchRoot("commands-ps-mark-unread");
    const records = join(dir.root, "commands");
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    // 4600 carries the mark in its environment, but exec's between every two reads of its arguments: the -E line
    // cannot be split into its arguments and its environment. 4700 is a record whose process is gone.
    const argv = { 4600: Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? "sh -c a" : "sh -c b")) };
    const { run, counted } = countingEnvironments(scriptedPs(() => [[4600, 1, 4600, 5]], { 4600: `sh -c a LANG=C ${word}\n` }, { argv }));
    try {
      mkdirSync(records);
      writeFileSync(join(records, `mark-${token}.json`), JSON.stringify({ boot: "boot-1", token }));
      writeFileSync(join(records, "4700-9.json"), JSON.stringify({ boot: "boot-1", leader: { pid: 4700, start: startAt(9) }, members: [] }));
      let signals = 0;
      await assert.rejects(reapOrRefuse(records, { table: psTable(run), kill: () => void signals++ }), /cannot tell whether pid 4600 carries the mark: its arguments changed in each of 3 reads/);
      assert.equal(signals, 0, "nothing signalled: a process that cannot be read is never taken for one of ours");
      assert.equal(counted.reads, 3, "read three times, then given up");
      assert.ok(existsSync(join(records, `mark-${token}.json`)), "the mark stays for the next open");
      assert.ok(existsSync(join(records, "4700-9.json")), "and so do the records");
    } finally {
      dir.remove();
    }
  });

  it("a marked process whose arguments changed once is read again, and its mark counts", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    // Its first two reads straddle an exec; from then on it reads the same.
    const argv = { 4610: ["sh -c a", "sleep 600"] };
    const { run, counted } = countingEnvironments(scriptedPs(() => [[4610, 1, 4610, 5]], { 4610: `sleep 600 LANG=C ${word}\n` }, { argv }));
    assert.deepEqual(psTable(run).snapshot().withMark(COMMANDS_MARK, token), [4610]);
    assert.equal(counted.reads, 2);
  });

  it("a process that keeps changing its arguments but whose environment listing holds no mark holds nothing up", () => {
    const token = randomUUID();
    const argv = { 4620: Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? "worker: idle" : "worker: busy")) };
    const { run, counted } = countingEnvironments(scriptedPs(() => [[4620, 1, 4620, 5]], { 4620: "worker: idle LANG=C\n" }, { argv }));
    assert.deepEqual(psTable(run).snapshot().withMark(COMMANDS_MARK, token), []);
    assert.equal(counted.reads, 1);
  });

  it("(5) a -E line with no environment after its arguments (inside an exec) is read again in the window, and the mark it then shows counts", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    // Its first -E line holds its arguments alone; its second, its environment too.
    const envReads = { 4900: ["sleep 600", `sleep 600 LANG=C ${word}`] };
    const { run, counted } = countingEnvironments(scriptedPs(() => [[4900, 1, 4900, 5]], { 4900: `sleep 600 LANG=C ${word}\n` }, { argv: { 4900: "sleep 600" }, envReads }));
    assert.deepEqual(psTable(run).snapshot().withMark(COMMANDS_MARK, token), [4900]);
    assert.equal(counted.reads, 2);
  });

  it("a -E line of this uid whose arguments changed across the read (an exec) and that shows no environment yet is read again in the window, and the mark it then shows counts; another uid's is read once", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    // Its arguments read `sh -c held` before the -E listing and `sleep 600` after it; its first -E line holds the new
    // arguments alone, its second its environment too.
    const options = { argv: { 4910: ["sh -c held", "sleep 600"] }, envReads: { 4910: ["sleep 600", `sleep 600 LANG=C ${word}`] } };
    const own = countingEnvironments(scriptedPs(() => [[4910, 1, 4910, 5]], { 4910: `sleep 600 LANG=C ${word}\n` }, options));
    assert.deepEqual(psTable(own.run).snapshot().withMark(COMMANDS_MARK, token), [4910]);
    assert.equal(own.counted.reads, 2);
    const other = countingEnvironments(scriptedPs(() => [[4910, 1, 4910, 5]], { 4910: `sleep 600 LANG=C ${word}\n` }, { ...options, ruids: { 4910: process.getuid!() + 1 } }));
    assert.deepEqual(psTable(other.run).snapshot().withMark(COMMANDS_MARK, token), []);
    assert.equal(other.counted.reads, 1);
  });

  it("a -E line of this uid that starts with neither reading of its arguments (a second exec between the reads) cannot be told: it is read again in the window, never taken for unmarked at once, even when it shows an environment", () => {
    const token = randomUUID();
    const word = `${COMMANDS_MARK}=${token}`;
    // Its arguments read `sh -c a` before the -E listing and `sh -c b` after it, while the -E line already shows a third
    // program with an environment; from the second read on it reads `sleep 600` throughout, with the mark.
    const options = { argv: { 4930: ["sh -c a", "sh -c b", "sleep 600"] }, envReads: { 4930: ["sleep 600 LANG=C", `sleep 600 LANG=C ${word}`] } };
    const { run, counted } = countingEnvironments(scriptedPs(() => [[4930, 1, 4930, 5]], { 4930: `sleep 600 LANG=C ${word}\n` }, options));
    assert.deepEqual(psTable(run).snapshot().withMark(COMMANDS_MARK, token), [4930]);
    assert.equal(counted.reads, 2);
  });

  it("a -E line of this uid that stays without an environment is unmarked after the window; another uid's is read once", () => {
    const token = randomUUID();
    const rows = () => [[4910, 1, 4910, 5], [4911, 1, 4911, 6]];
    const lines = { 4910: "worker\n", 4911: "daemon\n" };
    const own = countingEnvironments(scriptedPs(rows, lines, { ruids: { 4911: process.getuid!() + 1 } }));
    const start = Date.now();
    assert.deepEqual(psTable(own.run).snapshot().withMark(COMMANDS_MARK, token), []);
    assert.ok(Date.now() - start < 500);
    assert.equal(own.counted.reads, 6, "the first listing and the five of the window, for 4910 alone");
    const other = countingEnvironments(scriptedPs(() => [[4911, 1, 4911, 6]], { 4911: "daemon\n" }, { ruids: { 4911: process.getuid!() + 1 } }));
    assert.deepEqual(psTable(other.run).snapshot().withMark(COMMANDS_MARK, token), []);
    assert.equal(other.counted.reads, 1, "another uid's no-environment line is not read again");
  });

  it("the recorder's read (marked) of a -E line of this uid with no environment is one read, never the window: its next walk reads it again", () => {
    const counted = { reads: 0 };
    const ps = scriptedPs(() => [[4920, 1, 4920, 5]], { 4920: "worker\n" });
    const run: CommandRunner = (file, args) => {
      if (args.includes("-E") && args.includes("-p")) counted.reads++;
      return ps(file, args);
    };
    assert.equal(psTable(run).snapshot().marked(4920, COMMANDS_MARK, randomUUID()), false);
    assert.equal(counted.reads, 1);
  });

  it("a listing of marks that fails stops the reap and keeps the mark: no command is taken for gone on a failed read", async () => {
    const dir = scratchRoot("commands-ps-mark-fails");
    const records = join(dir.root, "commands");
    const table = psTable(scriptedPs(() => [[4300, 1, 4300, 5]], {}, { failMarks: true }));
    const token = randomUUID();
    try {
      mkdirSync(records);
      writeFileSync(join(records, `mark-${token}.json`), JSON.stringify({ boot: "boot-1", token }));
      let signals = 0;
      await assert.rejects(reapCommands(records, { table, kill: () => void signals++ }), /cannot list environments/);
      assert.equal(signals, 0, "nothing signalled");
      assert.ok(existsSync(join(records, `mark-${token}.json`)), "the mark stays for the next open");
    } finally {
      dir.remove();
    }
  });

  it("a live child left in a killed group, never recorded, is waited for, and kept as a survivor at the deadline", async () => {
    const dir = scratchRoot("commands-ps-live-member");
    const records = join(dir.root, "commands");
    // 4300 leads the killed group; 4301, its child in it and never recorded, outlives it.
    let rows = [
      [4300, 1, 4300, 5],
      [4301, 4300, 4300, 6],
    ];
    const table = psTable(scriptedPs(() => rows));
    try {
      mkdirSync(records);
      writeFileSync(join(records, `4300-${startAt(5)}.json`), JSON.stringify({ boot: "boot-1", leader: { pid: 4300, start: startAt(5) }, members: [] }));
      const kill = (target: number) => { if (target === -4300) rows = rows.filter(([pid]) => pid !== 4300); };
      assert.deepEqual(await reapCommands(records, { table, kill, timeoutMs: 100 }), { signalled: 1, survivors: [{ pid: 4301, start: startAt(6) }] });
      assert.deepEqual(JSON.parse(readFileSync(join(records, `4300-${startAt(5)}.json`), "utf8")), { boot: "boot-1", leader: null, members: [{ pid: 4301, start: startAt(6) }] }, "kept for the next open");
      rows = []; // it died after the deadline
      assert.deepEqual(await reapCommands(records, { table, kill, timeoutMs: 100 }), { signalled: 0, survivors: [] });
      assert.equal(existsSync(records), false);
    } finally {
      dir.remove();
    }
  });

  it("a zombie left in a killed group is not waited for: the listing marks it Z, and it is not running", async () => {
    const dir = scratchRoot("commands-ps-zombie");
    const records = join(dir.root, "commands");
    // 4300 leads the killed group; 4301, in it and never recorded, is already a zombie its parent has not reaped.
    let rows = [
      [4300, 1, 4300, 5],
      [4301, 1, 4300, 6],
    ];
    const table = psTable(scriptedPs(() => rows, {}, { states: { 4301: "Z" } }));
    try {
      mkdirSync(records);
      writeFileSync(join(records, `4300-${startAt(5)}.json`), JSON.stringify({ boot: "boot-1", leader: { pid: 4300, start: startAt(5) }, members: [] }));
      const kill = (target: number) => { if (target === -4300) rows = rows.filter(([pid]) => pid !== 4300); };
      assert.deepEqual(await reapCommands(records, { table, kill, timeoutMs: 100 }), { signalled: 1, survivors: [] }, "the zombie is not a survivor");
      assert.equal(existsSync(records), false, "and the record is cleared");
    } finally {
      dir.remove();
    }
  });

  it("records a marked command's group from the listing, and the next open kills the group and clears the records", async () => {
    const dir = scratchRoot("commands-ps");
    const records = join(dir.root, "commands");
    // 4200 is the instance; 4300 its command, leading a group with 4301 in it; 4350 another group's leader, unmarked.
    let rows = [
      [4200, 1, 4200, 0],
      [4300, 4200, 4300, 5],
      [4301, 4300, 4300, 6],
      [4350, 4200, 4350, 7],
    ];
    const environments: Record<number, string> = { 4350: "/bin/sh HOME=/Users/a\n" };
    const table = psTable(scriptedPs(() => rows, environments));
    try {
      const recorder = new CommandRecorder(records, { table, instance: 4200 });
      environments[4300] = `/bin/sh -c work HOME=/Users/a ${COMMANDS_MARK}=${recorder.token}\n`;
      recorder.scan();
      recorder.close();
      assert.deepEqual(readdirSync(records), [`4300-${startAt(5)}.json`], "only the marked command's group");
      assert.deepEqual(JSON.parse(readFileSync(join(records, `4300-${startAt(5)}.json`), "utf8")), {
        boot: "boot-1",
        leader: { pid: 4300, start: startAt(5) },
        members: [{ pid: 4301, start: startAt(6) }],
      });
      const signals: number[] = [];
      const kill = (target: number) => {
        signals.push(target);
        rows = rows.filter(([pid, , pgrp]) => (target < 0 ? pgrp !== -target : pid !== target));
      };
      assert.deepEqual(await reapCommands(records, { table, kill, timeoutMs: 1_000 }), { signalled: 2, survivors: [] });
      assert.deepEqual(signals, [-4300, 4301], "the group, and the member the listing before the kill showed alive");
      assert.equal(existsSync(records), false, "the records are cleared");
    } finally {
      dir.remove();
    }
  });

  it("an open that cannot list the processes fails and keeps the records; a walk that cannot says so once", async () => {
    const dir = scratchRoot("commands-ps-fails");
    const records = join(dir.root, "commands");
    const rows = [[4200, 1, 4200, 0], [4300, 4200, 4300, 5]];
    try {
      mkdirSync(records);
      const file = join(records, `4300-${startAt(5)}.json`);
      writeFileSync(file, JSON.stringify({ boot: "boot-1", leader: { pid: 4300, start: startAt(5) }, members: [] }));
      const failing = psTable(scriptedPs(() => rows, {}, { failListing: true }));
      const signals: number[] = [];
      await assert.rejects(reapOrRefuse(records, { table: failing, kill: (target) => void signals.push(target) }), /cannot list processes/);
      assert.deepEqual(signals, []);
      assert.ok(existsSync(file), "nothing is taken for gone: the record stays for the next open");
      const errors: unknown[] = [];
      const recorder = new CommandRecorder(join(dir.root, "other"), { table: failing, instance: 4200, onError: (error) => void errors.push(error) });
      recorder.scan();
      recorder.scan();
      assert.equal(errors.length, 1);
    } finally {
      dir.remove();
    }
  });

  it("never signals the reaping process's group or pid 1, whatever a record names", async () => {
    const dir = scratchRoot("commands-ps-guard");
    const records = join(dir.root, "commands");
    // This process leads no group of its own here: it is in 4400's, which a record names as its leader.
    const rows = [[1, 0, 1, 0], [4400, 1, 4400, 1], [process.pid, 4400, 4400, 2]];
    try {
      mkdirSync(records);
      const leader = { pid: 4400, start: startAt(1) };
      writeFileSync(join(records, `4400-${leader.start}.json`), JSON.stringify({ boot: "boot-1", leader, members: [{ pid: 1, start: startAt(0) }] }));
      const signals: number[] = [];
      const reaped = await reapCommands(records, { table: psTable(scriptedPs(() => rows)), kill: (target) => void signals.push(target), timeoutMs: 50 });
      assert.deepEqual(signals, [], "no signal at all");
      assert.equal(reaped.signalled, 0);
    } finally {
      dir.remove();
    }
  });
});

describe("a recorder's mark", () => {
  it("a mark cannot be looked for in a /proc that cannot be read: the listing throws, never reads as no process", () => {
    const dir = scratchRoot("commands-no-proc");
    try {
      assert.throws(() => procTable(join(dir.root, "no-proc")).snapshot().withMark(COMMANDS_MARK, randomUUID()), /ENOENT/);
    } finally {
      dir.remove();
    }
  });

  it("a record and a mark that name the same file are both kept: every survivor of both is named on disk after a refused open, and the next reap ends them all", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const dir = scratchRoot("commands-mark-collision");
    const records = join(dir.root, "commands");
    const token = randomUUID();
    const env = { ...process.env, [COMMANDS_MARK]: token };
    const sleep = '"$(command -v sleep)"';
    // L: a marked leader whose child S left its group (setsid) and cleared its environment: only L's record names S.
    // M: a second marked leader whose member E cleared its environment: only M's group, then the survivors' record, names E.
    const L = spawn("/bin/sh", ["-c", `setsid env -i ${sleep} 600 & echo $! > '${dir.root}/S'; exec sleep 600`], { detached: true, stdio: "ignore", env });
    const M = spawn("/bin/sh", ["-c", `env -i ${sleep} 600 & echo $! > '${dir.root}/E'; exec sleep 600`], { detached: true, stdio: "ignore", env });
    const pids = { L: L.pid ?? 0, M: M.pid ?? 0, S: 0, E: 0 };
    const unmarked = (pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "sleep" && !readFileSync(`/proc/${pid}/environ`, "utf8").includes(`${COMMANDS_MARK}=`);
      } catch {
        return false;
      }
    };
    try {
      for (const name of ["S", "E"] as const) {
        await until(() => existsSync(join(dir.root, name)) && readFileSync(join(dir.root, name), "utf8").trim() !== "");
        pids[name] = Number(readFileSync(join(dir.root, name), "utf8"));
        await until(() => unmarked(pids[name]));
        assert.ok(unmarked(pids[name]), `${name} has exec'd sleep and carries no mark`);
      }
      const look = processTable().snapshot();
      assert.notEqual(look.info(pids.S)?.pgrp, pids.L, "S left L's group");
      assert.equal(look.info(pids.E)?.pgrp, pids.M, "E is in M's group");
      const startOf = (pid: number) => look.info(pid)!.start;
      mkdirSync(records);
      const boot = processTable().bootId();
      writeFileSync(join(records, `${pids.L}-${startOf(pids.L)}.json`), JSON.stringify({ boot, leader: { pid: pids.L, start: startOf(pids.L) }, members: [{ pid: pids.S, start: startOf(pids.S) }] }));
      writeFileSync(join(records, `mark-${token}.json`), JSON.stringify({ boot, token }));
      // A kill that does nothing: all four outlive the deadline, and the open refuses.
      await assert.rejects(reapOrRefuse(records, { kill: () => {}, timeoutMs: 100 }), (error: unknown) => error instanceof HeldError);
      const named = new Set<number>();
      for (const name of readdirSync(records).filter(isRecord)) {
        const record = JSON.parse(readFileSync(join(records, name), "utf8")) as CommandRecord;
        if (record.leader) named.add(record.leader.pid);
        for (const m of record.members) named.add(m.pid);
      }
      for (const [name, pid] of Object.entries(pids)) assert.ok(named.has(pid), `${name} (pid ${pid}) is named by a record on disk: ${JSON.stringify([...named])}`);
      // L and M end; S and E, which no mark names, are left to the records alone.
      process.kill(pids.L, "SIGKILL");
      process.kill(pids.M, "SIGKILL");
      assert.ok((await waitGone(pids.L)) && (await waitGone(pids.M)), "the marked leaders are gone");
      assert.deepEqual((await reapOrRefuse(records)).survivors, []);
      for (const [name, pid] of Object.entries(pids)) assert.ok(await waitGone(pid), `${name} is gone`);
      assert.equal(existsSync(records), false, "and the records and the mark are cleared");
    } finally {
      for (const pid of Object.values(pids)) {
        if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
      }
      dir.remove();
    }
  });

  it("whose group outlives the reap's deadline has its survivors recorded too: a member that cleared its environment is ended at the next open once its marked leader is gone", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const dir = scratchRoot("commands-mark-survivors");
    const records = join(dir.root, "commands");
    const token = randomUUID();
    const memberFile = join(dir.root, "member.pid");
    // A marked leader with a member that carries no mark, in its group.
    const leader = spawn("/bin/sh", ["-c", `env -i "$(command -v sleep)" 600 & echo $! > '${memberFile}'; exec sleep 600`], { detached: true, stdio: "ignore", env: { ...process.env, [COMMANDS_MARK]: token } });
    const pid = leader.pid ?? 0;
    let member = 0;
    try {
      mkdirSync(records);
      writeFileSync(join(records, `mark-${token}.json`), JSON.stringify({ boot: processTable().bootId(), token }));
      await until(() => existsSync(memberFile) && readFileSync(memberFile, "utf8").trim() !== "");
      member = Number(readFileSync(memberFile, "utf8"));
      // $! is the forked shell child: it carries the mark until it execs env, and env execs sleep. Wait for that exec.
      const unmarked = (pid: number) => {
        try {
          return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "sleep" && !readFileSync(`/proc/${pid}/environ`, "utf8").includes("PI_DURABLE_DISK_COMMANDS=");
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 500 && !unmarked(member); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(readFileSync(`/proc/${member}/comm`, "utf8").trim(), "sleep", "the member has exec'd sleep");
      assert.ok(!readFileSync(`/proc/${member}/environ`, "utf8").includes(`${COMMANDS_MARK}=`), "the member carries no mark");
      assert.equal(processTable().snapshot().info(member)?.pgrp, pid, "the member is in the leader's group");
      // A kill that does nothing: both outlive the first reap's deadline, and the open refuses.
      await assert.rejects(reapOrRefuse(records, { kill: () => {}, timeoutMs: 100 }), (error: unknown) => error instanceof HeldError);
      // The marked leader ends; the member, which no mark names, is left.
      process.kill(pid, "SIGKILL");
      assert.ok(await waitGone(pid), "the leader is gone");
      assert.ok(alive(member), "the member is still alive");
      assert.deepEqual((await reapOrRefuse(records)).survivors, []);
      assert.ok(await waitGone(member), "the next reap ends the member from its record");
      assert.equal(existsSync(records), false, "and clears the mark and the record");
    } finally {
      killGroup(pid);
      if (member > 0) try { process.kill(member, "SIGKILL"); } catch {}
      dir.remove();
    }
  });

  it("a process both a record and a mark name is signalled once: the reap sends the group's SIGKILL and the member's, never either twice", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const dir = scratchRoot("commands-mark-once");
    const records = join(dir.root, "commands");
    const token = randomUUID();
    const child = command(token);
    const pid = child.pid ?? 0;
    try {
      // The leader carries the mark (it has exec'd) and its member is in its group.
      await until(() => processTable().snapshot().marked(pid, COMMANDS_MARK, token) && processTable().snapshot().group(pid).length >= 2);
      const look = processTable().snapshot();
      const member = look.group(pid).find((p) => p !== pid)!;
      const boot = processTable().bootId();
      mkdirSync(records);
      writeFileSync(join(records, `${pid}-${look.info(pid)!.start}.json`), JSON.stringify({ boot, leader: { pid, start: look.info(pid)!.start }, members: [{ pid: member, start: look.info(member)!.start }] }));
      writeFileSync(join(records, `mark-${token}.json`), JSON.stringify({ boot, token }));
      // A kill that records its target and sends nothing: every process is still there for the whole reap, record and mark alike.
      const targets: number[] = [];
      const reaped = await reapCommands(records, { kill: (target) => void targets.push(target), timeoutMs: 100 });
      assert.deepEqual(targets, [-pid, member], "one SIGKILL to the group and one to its member, whatever names them");
      assert.equal(reaped.signalled, 2);
    } finally {
      killGroup(pid);
      dir.remove();
    }
  });

  it("that still names a live process after the reap's deadline is kept as it was, so the next open looks for its token again and ends it", async () => {
    const dir = scratchRoot("commands-mark-kept");
    const records = join(dir.root, "commands");
    const token = randomUUID();
    const mark = join(records, `mark-${token}.json`);
    // The command carries its mark only once it has exec'd: before, a spawned child still has this process's environment.
    // It starts unmarked, held on a fifo in front of the exec that gives it the mark, so the test sees that window. The
    // token comes under another name and is exported only after the hold, so neither the held process's environment nor
    // its arguments hold `PI_DURABLE_DISK_COMMANDS=<token>` (macOS reads a mark from ps -E, arguments and environment).
    const fifo = join(dir.root, "go");
    spawnSync("mkfifo", [fifo]);
    const held = `read _ < '${fifo}'; export ${COMMANDS_MARK}="$HELD_TOKEN"; unset HELD_TOKEN; exec /bin/sh -c 'sleep 600 & exec sleep 600'`;
    const child = spawn("/bin/sh", ["-c", held], { detached: true, stdio: "ignore", env: { ...process.env, HELD_TOKEN: token } });
    const pid = child.pid ?? 0;
    const marked = () => processTable().snapshot().marked(pid, COMMANDS_MARK, token);
    try {
      mkdirSync(records);
      writeFileSync(mark, JSON.stringify({ boot: processTable().bootId(), token }));
      await until(() => alive(pid));
      assert.equal(marked(), false, "held before its exec, the command does not carry the mark yet");
      writeFileSync(fifo, "go\n");
      // The reap looks for the mark, so it runs only once the command carries it.
      await until(marked);
      assert.ok(marked(), "the command carries the mark");
      // A kill that does nothing: the marked command outlives the first reap's deadline.
      await assert.rejects(reapOrRefuse(records, { kill: () => {}, timeoutMs: 100 }), (error: unknown) => error instanceof HeldError && error.holder === "commands");
      assert.ok(alive(pid), "the command survived the first reap");
      assert.deepEqual(JSON.parse(readFileSync(mark, "utf8")), { boot: processTable().bootId(), token }, "the mark still holds its token");
      assert.deepEqual((await reapOrRefuse(records)).survivors, []);
      assert.ok(await waitGone(pid), "the next reap ends it");
      assert.equal(existsSync(records), false, "and clears the mark");
    } finally {
      killGroup(pid);
      dir.remove();
    }
  });
});
