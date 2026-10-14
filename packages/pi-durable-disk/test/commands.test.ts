// The command records of a run that nothing else cleans up after (a local run): CommandRecorder walks this process's
// tree and records each command group; reapCommands ends, at the next open, only what is still the recorded process.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRecorder, reapCommands, type CommandRecord } from "../src/commands.ts";
import { alive, scratchRoot, waitGone } from "./_run-support.ts";

const COMMANDS = fileURLToPath(new URL("../src/commands.ts", import.meta.url));
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const startOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]);

/** A command the way pi starts one: the leader of its own group, here with a member that is its own child. */
function command(): ChildProcess {
  return spawn("/bin/sh", ["-c", "sleep 600 & exec sleep 600"], { detached: true, stdio: "ignore" });
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
    const child = command();
    const leader = child.pid ?? 0;
    try {
      const recorder = new CommandRecorder(records, { everyMs: 20 });
      recorder.started();
      const read = () => (existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")) : []);
      await until(() => read().length === 1 && (JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord).members.length > 0);
      const record = JSON.parse(readFileSync(join(records, read()[0]!), "utf8")) as CommandRecord;
      assert.deepEqual([record.boot, record.leader], [boot, { pid: leader, start: startOf(leader) }]);
      const member = record.members[0]!;
      recorder.close();
      assert.equal(await reapCommands(records), 2, "the leader's group and the member");
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
      assert.equal(await reapCommands(records), 0);
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
const signalled = await reapCommands(dir, { timeoutMs: 200 });
process.stdout.write("still here, signalled " + signalled);`;
    const dir = scratchRoot("commands-self");
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(dir.root, "commands")], { encoding: "utf8", timeout: 20_000, detached: true } as never);
      assert.equal(child.signal, null, `the reap killed its own process or group (${child.signal})`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, "still here, signalled 0");
    } finally {
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
