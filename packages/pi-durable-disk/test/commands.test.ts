// The command records of a run that nothing else cleans up after (a local run): CommandRecorder walks this process's
// tree and records each command group; reapCommands ends, at the next open, only what is still the recorded process.
// The tests on real processes run through this machine's process table and, on Linux, through the one macOS uses (ps),
// played by procps; the macOS CI job runs them against a Mac's own ps.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS_MARK, CommandRecorder, reapCommands, reapOrRefuse, type CommandRecord } from "../src/commands.ts";
import { HeldError } from "../src/errors.ts";
import { processTable, psTable, type CommandRunner, type ProcessTable } from "../src/process-table.ts";
import { linuxPs } from "./_macos.ts";
import { alive, scratchRoot, waitGone } from "./_run-support.ts";

const COMMANDS = fileURLToPath(new URL("../src/commands.ts", import.meta.url));
const PROCESS_TABLE = fileURLToPath(new URL("../src/process-table.ts", import.meta.url));
const MACOS = fileURLToPath(new URL("./_macos.ts", import.meta.url));

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
      const read = () => (existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")) : []);
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
      const leaders = (records: string) => (existsSync(records) ? readdirSync(records).map((name) => Number(name.split("-")[0])) : []);
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
        (existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")) : []).map((name) => JSON.parse(readFileSync(join(records, name), "utf8")) as CommandRecord);
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
      const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
      const quoted = refusal.replaceAll(records, "<root>/commands");
      assert.ok(readme.includes(`\n${quoted}\n`), `the README's refusal is not the one the open writes:\n${quoted}`);
    } finally {
      dir.remove();
    }
  });
});

describe("command records, from a scripted ps (macOS)", () => {
  /** A ps and sysctl that answer from `rows()` (`pid ppid pgid second`: the second it started at) and `environments`. */
  function scriptedPs(rows: () => number[][], environments: Record<number, string> = {}, options: { failListing?: boolean } = {}): CommandRunner {
    const lstart = (second: number) => `Thu Oct 15 06:00:${String(second).padStart(2, "0")} 2026`;
    return (file, args) => {
      if (file === "/usr/sbin/sysctl") return "boot-1\n";
      if (args.includes("-A")) {
        if (options.failListing) throw new Error("ps: cannot list processes");
        return rows().map(([pid, ppid, pgrp, second]) => `${pid} ${ppid} ${pgrp} S ${lstart(second!)}`).join("\n");
      }
      const text = environments[Number(args[args.indexOf("-p") + 1])];
      if (text === undefined) throw new Error("no such process");
      return text;
    };
  }
  const startAt = (second: number) => Date.UTC(2026, 9, 15, 6, 0, second) / 1000;

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
