// The command records of a run that nothing else cleans up after (a local run): CommandRecorder walks this process's
// tree and records each command group; reapCommands ends, at the next open, only what is still the recorded process.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS_MARK, CommandRecorder, reapCommands, reapOrRefuse, type CommandRecord } from "../src/commands.ts";
import { HeldError } from "../src/errors.ts";
import { alive, scratchRoot, waitGone } from "./_run-support.ts";

const COMMANDS = fileURLToPath(new URL("../src/commands.ts", import.meta.url));
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const startOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]);

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

describe("command records", () => {
  it("records a command group's leader and its members, and the next open kills both and clears the records", async () => {
    const dir = scratchRoot("commands-record");
    const records = join(dir.root, "commands");
    const recorder = new CommandRecorder(records, { everyMs: 20 });
    const child = command(recorder.token);
    const leader = child.pid ?? 0;
    try {
      recorder.started();
      const read = () => (existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")) : []);
      await until(() => read().length === 1 && (JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord).members.length > 0);
      const record = JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord;
      assert.deepEqual([record.boot, record.leader], [boot, { pid: leader, start: startOf(leader) }]);
      const member = record.members[0]!;
      recorder.close();
      assert.deepEqual(await reapCommands(records), { signalled: 2, survivors: [] }, "the leader's group and the member");
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
      assert.deepEqual(await reapCommands(records), { signalled: 0, survivors: [] });
      assert.ok(alive(pid), "a process no record names exactly is left alone");
      assert.equal(existsSync(records), false, "and the records are cleared all the same");
    } finally {
      killGroup(pid);
      dir.remove();
    }
  });

  it("never signals the reaping process or its group, whatever a record names", () => {
    // In a child that leads its own group, so a regression kills only it.
    const script = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { reapCommands } from ${JSON.stringify(COMMANDS)};
const dir = process.argv[1];
mkdirSync(dir, { recursive: true });
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const start = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]);
const self = { pid: process.pid, start };
writeFileSync(dir + "/" + process.pid + "-" + start + ".json", JSON.stringify({ boot, leader: self, members: [self, { pid: 0, start: 0 }, { pid: -1, start: 0 }] }));
const reaped = await reapCommands(dir, { timeoutMs: 200 });
process.stdout.write("still here, " + JSON.stringify(reaped));`;
    const dir = scratchRoot("commands-self");
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(dir.root, "commands")], { encoding: "utf8", timeout: 20_000, detached: true } as never);
      assert.equal(child.signal, null, `the reap killed its own process or group (${child.signal})`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'still here, {"signalled":0,"survivors":[]}');
    } finally {
      dir.remove();
    }
  });

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

  it("two environments in one process record only their own commands, and reaping one leaves the other's alive", async () => {
    const dir = scratchRoot("commands-two");
    const [a, b] = [join(dir.root, "a"), join(dir.root, "b")];
    const [recorderA, recorderB] = [new CommandRecorder(a, { everyMs: 20 }), new CommandRecorder(b, { everyMs: 20 })];
    const [childA, childB, foreign] = [command(recorderA.token), command(recorderB.token), command()];
    const pids = [childA, childB, foreign].map((c) => c.pid ?? 0);
    try {
      recorderA.started();
      recorderB.started();
      const leaders = (records: string) => (existsSync(records) ? readdirSync(records).map((name) => Number(name.split("-")[0])) : []);
      await until(() => leaders(a).length === 1 && leaders(b).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100)); // more walks: none records another's command
      recorderA.close();
      recorderB.close();
      assert.deepEqual([leaders(a), leaders(b)], [[pids[0]], [pids[1]]], "each records its own command, and neither the other's nor the unmarked one");
      assert.deepEqual(await reapCommands(b), { signalled: 2, survivors: [] });
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
    const recorder = new CommandRecorder(records, { everyMs: 20, onError: (error) => void errors.push(error) });
    const child = command(recorder.token);
    try {
      recorder.started();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(errors.length, 1, "reported once over many failing walks");
      rmSync(records);
      await until(() => existsSync(records) && readdirSync(records).some((name) => name.startsWith(`${child.pid}-`)));
      recorder.close();
    } finally {
      killGroup(child.pid ?? 0);
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
      mkdirSync(records);
      writeFileSync(join(records, "4242-77.json"), JSON.stringify({ boot: "fake-boot", leader: { pid: 4242, start: 77 }, members: [] }));
      await assert.rejects(reapOrRefuse(records, { proc, kill: () => {}, timeoutMs: 50 }), (error: unknown) =>
        error instanceof HeldError && error.holder === "commands" && error.code === "COMMANDS_ALIVE" && error.exitCode === 76 && /pids 4242/.test(error.message));
      assert.ok(existsSync(join(records, "4242-77.json")), "its record stays for the next open");
      rmSync(join(proc, "4242"), { recursive: true });
      assert.deepEqual(await reapOrRefuse(records, { proc, kill: () => {} }), { signalled: 0, survivors: [] });
    } finally {
      dir.remove();
    }
  });

  it("follows a background worker after its leader exits: a child it starts later is recorded, and reaped", async () => {
    const dir = scratchRoot("commands-worker");
    const records = join(dir.root, "commands");
    const late = join(dir.root, "late.pid");
    const recorder = new CommandRecorder(records, { everyMs: 20 });
    // The leader exits at 0.2 s; its background worker (same group) starts `sleep 600` at 0.6 s and waits on it.
    const script = `sh -c 'sleep 0.6; sleep 600 & echo $! > ${late}; wait' & sleep 0.2`;
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, [COMMANDS_MARK]: recorder.token } });
    const group = child.pid ?? 0;
    let latePid = 0;
    try {
      recorder.started();
      await until(() => existsSync(late) && readFileSync(late, "utf8").trim() !== "");
      latePid = Number(readFileSync(late, "utf8"));
      assert.equal(alive(group), false, "the leader has exited");
      await new Promise((resolve) => setTimeout(resolve, 150)); // walks after the late child started
      recorder.close();
      const [name] = readdirSync(records);
      const record = JSON.parse(readFileSync(join(records, name!), "utf8")) as CommandRecord;
      assert.ok(record.members.some((m) => m.pid === latePid), `the late child is recorded: ${JSON.stringify(record)}`);
      const reaped = await reapCommands(records);
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
      const recorder = new CommandRecorder(records, { everyMs: 20 });
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
